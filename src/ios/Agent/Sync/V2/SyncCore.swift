import Foundation
import os.log
import Network

private let logger = AppLogger(category: "SyncCore")

/// Why a record was marked dirty. Used in logs.
enum SyncDirtyReason: String {
    case localUpsert
    case localDelete
    case migrationInitialPush
    case resurrectCascade
    case retryAfterTransientFailure
    case other
}

/// Central dispatcher between application writes and the configured
/// transports. SyncCore owns:
///
///   - the dirty queue (delegates persistence to `ChatStore.markDirty`)
///   - send debouncing (3s default, mirrors v1 behavior)
///   - in-flight protection (no overlapping send to the same transport)
///   - broadcast to multiple transports (each transport sees the same
///     PortableRecord stream)
///   - inbound merging from any transport into local SQLite
///
/// SyncCore does NOT know about CloudKit, CKSyncEngine, zones, etag,
/// silent push, or anything transport-specific. All that lives behind
/// the `SyncTransport` protocol.
@MainActor
final class SyncCore {
    static let shared = SyncCore()
    private init() {
        if let data = UserDefaults.standard.data(forKey: Self.sendRetryKey),
           let saved = try? JSONDecoder().decode([String: SyncRetryPolicy].self, from: data) {
            sendRetryPolicies = saved
        }
    }

    private static let sendRetryKey = "cloudSync.v2.sendRetryPolicies.v1"
    private var sendRetryPolicies: [String: SyncRetryPolicy] = [:] {
        didSet {
            if let data = try? JSONEncoder().encode(sendRetryPolicies) {
                UserDefaults.standard.set(data, forKey: Self.sendRetryKey)
            }
        }
    }

    // MARK: - Configuration

    /// Each registered transport is an independent durable destination.
    /// A success on one destination never acknowledges another.
    private(set) var transports: [SyncTransport] = []

    var cloudHealth: SyncTransportHealth {
        transports.first { $0.name == "iCloud" }?.health ?? SyncTransportHealth()
    }

    func checkCloudConnection() async throws {
        guard let cloud = transports.first(where: { $0.name == "iCloud" }) else {
            throw SyncTransportError.notStarted
        }
        try await cloud.checkConnection()
    }

    /// [T-ios-log-noise-reduction] First-seen dedup for the
    /// `[SyncSchema] unknownFields` log. The server sends new fields
    /// (asset_size/asset_mime on SessionFileV2 etc.) on EVERY record of a
    /// batch — ~18.7k identical INFO lines per full fetch. We only care that
    /// the (type, sorted-keys) combination appeared at all, so log it once
    /// per combination per process and skip the rest.
    private var loggedUnknownFieldKeys: Set<String> = []

    /// True after `start()` finishes successfully. Reset by `stop()`.
    private(set) var isRunning: Bool = false

    /// When startIfEnabled defers the network boot, this is the absolute
    /// time at which the deferred SyncCore.start is expected to fire.
    /// Cleared once start() actually runs.
    var bootDelayUntil: Date?

    /// Timestamps for the Sync status UI. Updated on every successful
    /// send/fetch round; nil = none yet this session.
    private(set) var lastSendAt: Date?
    private(set) var lastFetchAt: Date?
    /// Cumulative counters for the current session. Reset on app relaunch.
    private(set) var totalSent: Int = 0
    private(set) var totalReceived: Int = 0

    // MARK: - Dynamic rate throttling

    /// True while the iCloud Sync sheet is the visible context — caller
    /// (SyncMigrationDetailView) flips this in .task / on dismiss. When
    /// true the chained-send cadence runs at full speed; when false we
    /// throttle so the foreground UI stays responsive.
    var userOnSyncSheet: Bool = false
    /// True while the app is in background. Switched by ContentView's
    /// scenePhase observer. Background applies a uniform 1/4× multiplier
    /// regardless of which page the user was on when they backgrounded.
    var isAppInBackground: Bool = false
    /// Current network type. Updated by an NWPathMonitor in start().
    /// .cellular adds a 0.5× multiplier on top of the foreground throttle.
    enum NetworkClass { case wifi, cellular, other }
    private(set) var networkClass: NetworkClass = .wifi
    private var pathMonitor: NWPathMonitor?

    /// Effective chained-send delay seconds for the current context.
    /// Base 5s when the user is staring at the sync sheet. Foreground
    /// (default) ×3. Background ×4 (overrides foreground). Cellular ×2
    /// stacks on top.
    var currentSendDelay: TimeInterval {
        let base: TimeInterval = 5
        let foregroundMultiplier: TimeInterval
        if isAppInBackground { foregroundMultiplier = 4.0 }
        else if userOnSyncSheet { foregroundMultiplier = 1.0 }
        else { foregroundMultiplier = 3.0 }
        let networkMultiplier: TimeInterval = networkClass == .cellular ? 2.0 : 1.0
        return base * foregroundMultiplier * networkMultiplier
    }
    /// Human-readable label for the current throttle multiplier.
    var throttleLabel: String {
        let f: String
        if isAppInBackground { f = "1/4× (bg)" }
        else if userOnSyncSheet { f = "1×" }
        else { f = "1/3×" }
        let n = networkClass == .cellular ? " · cellular ½" : ""
        return f + n
    }

    /// Sliding window of (timestamp, recordCount) successful save events
    /// for the recent-rate readout.
    private var sendEvents: [(Date, Int)] = []
    private static let rateWindow: TimeInterval = 60
    /// Average records/sec across the last `rateWindow` seconds.
    var recentRatePerSecond: Double {
        let cutoff = Date().addingTimeInterval(-Self.rateWindow)
        let recent = sendEvents.filter { $0.0 >= cutoff }
        guard !recent.isEmpty else { return 0 }
        let total = recent.reduce(0) { $0 + $1.1 }
        return Double(total) / Self.rateWindow
    }

    /// When CloudKit replies with `requestRateLimited` (CKError code 7,
    /// HTTP 429), this absolute time gates the next send attempt. Prevents
    /// the chained sendNow / scheduleSend retry loop from hammering iCloud
    /// inside the throttle window.
    /// 只有所有通道都在等待时才暂停整个发送器。后续新增直连通道不会被云端拖住。
    var nextEarliestSendAt: Date? {
        let now = Date()
        let deadlines = transports.compactMap { transport -> Date? in
            let gate = [transport.retryAfter, sendRetryPolicies[transport.name]?.deadline(for: .send)]
                .compactMap { $0 }.max()
            return gate.flatMap { $0 > now ? $0 : nil }
        }
        guard !transports.isEmpty, deadlines.count == transports.count else { return nil }
        return deadlines.min()
    }

    /// User-initiated pause deadline. When set and in the future, sendNow
    /// is a no-op (markDirty still records, so nothing is lost — the queue
    /// drains once the deadline passes). Persisted to UserDefaults so the
    /// pause survives app restart.
    private static let pauseUntilKey = "cloudSync.v2.pausedUntil"
    var pausedUntil: Date? {
        get {
            let t = UserDefaults.standard.double(forKey: Self.pauseUntilKey)
            guard t > 0 else { return nil }
            let date = Date(timeIntervalSince1970: t)
            return date > Date() ? date : nil
        }
        set {
            if let d = newValue {
                UserDefaults.standard.set(d.timeIntervalSince1970, forKey: Self.pauseUntilKey)
            } else {
                UserDefaults.standard.removeObject(forKey: Self.pauseUntilKey)
            }
        }
    }
    func pause(for duration: TimeInterval) {
        pausedUntil = Date().addingTimeInterval(duration)
        logger.info("[SyncCore] paused until \(pausedUntil!) (\(Int(duration))s)")
    }
    func resume() {
        pausedUntil = nil
        logger.info("[SyncCore] resumed")
        scheduleSend(delay: 1)
    }

    /// Debounce for `scheduleSend`. Mirrors v1's 3s default.
    private let defaultSendDelay: TimeInterval = 3.0

    /// Set to true while an agent loop is streaming — markDirty still
    /// records into the dirty table (crash-safe) but does NOT trigger
    /// a debounced send. Mirrors v1's `syncSendDeferred`.
    private var sendDeferred: Bool = false

    // MARK: - State

    private var pendingSendTask: Task<Void, Never>?
    private var isSending = false

    /// recordIds we just successfully pushed to a transport. When the
    /// next fetchRecentV2 round-trips them back to us as "inbound", the
    /// merger would re-apply them (LWW skip → no real write, but still
    /// counted as `applied` which fires `cloudSyncDidFetchChanges` and
    /// makes every open AIChatViewModel reload its session for nothing).
    /// Entries older than `echoTTL` are pruned on access; effectively
    /// each push is shielded from echo for ~30s, plenty of time for the
    /// 60s fetch cycle to fire once and recognize itself.
    private var recentlyPushedIds: [String: Date] = [:]
    private let echoTTL: TimeInterval = 30
    /// Records applied by a batch whose sibling record threw (e.g. a session
    /// running locally). Transports re-issue the same page until it fully
    /// applies; skip re-merging (and re-notifying) what already landed.
    private var appliedInDeferredBatch: Set<String> = []

    // MARK: - Lifecycle

    /// Register a transport. Must be called before `start()`. LANTransport
    /// (and any other unimplemented transport) is rejected.
    func register(_ transport: SyncTransport) {
        if let lan = transport as? LANTransport, !LANTransport.isImplemented {
            logger.warning("[SyncCore] refusing to register LANTransport (skeleton only)")
            _ = lan
            return
        }
        // T-v2-hot-enable: register may be invoked twice when the user
        // hot-enables iCloud V2 (UI toggle off → on after launch). De-dup
        // by transport name so we don't accidentally drive every send/
        // fetch through two parallel ICloudSharedZoneTransport instances.
        if transports.contains(where: { $0.name == transport.name }) {
            logger.info("[SyncCore] transport \(transport.name) already registered — skipping")
            return
        }
        transports.append(transport)
        logger.info("[SyncCore] transport registered: \(transport.name) caps=\(String(transport.capabilities.rawValue, radix: 16))")
    }

    /// Serial reconfiguration preserves durable tickets while removing disabled routes.
    func replaceTransports(_ replacements: [SyncTransport]) async {
        // Same instances already running: restarting would redo CloudKit zone
        // setup and initial sends for nothing.
        if isRunning, replacements.map({ ObjectIdentifier($0 as AnyObject) }) == transports.map({ ObjectIdentifier($0 as AnyObject) }) {
            return
        }
        await stop()
        while isSending {
            do { try await Task.sleep(nanoseconds: 50_000_000) } catch { return }
        }
        transports = replacements
        do { try await ChatStore.shared.configureSyncDestinations(Set(replacements.map(\.name))) }
        catch { logger.error("[SyncCore] destination configuration failed: \(error)"); return }
        if !replacements.isEmpty { await start() }
    }

    /// Boot all registered transports. Idempotent.
    func start() async {
        guard !isRunning else { return }
        logger.info("[SyncCore] start STEP=enter transports=\(self.transports.count)")
        // Hook each transport's observe(handler:) so inbound batches
        // funnel through SyncCore's merge path. Doing this BEFORE start()
        // means any messages the transport delivers during its own
        // boot sequence are not dropped.
        for t in transports {
            t.observe { [weak self] batch in
                Task { @MainActor [weak self] in
                    if await self?.processInbound(batch, from: t.name) == true {
                        do { try await t.acknowledgeInbound(batch) }
                        catch {
                            await t.deferInbound(batch)
                            logger.error("[SyncCore] inbound checkpoint failed: \(error)")
                        }
                    } else { await t.deferInbound(batch) }
                }
            }
        }
        logger.info("[SyncCore] start STEP=observersHooked")
        for t in transports {
            logger.info("[SyncCore] start STEP=startTransport begin name=\(t.name)")
            do {
                try await t.start()
                logger.info("[SyncCore] start STEP=startTransport done name=\(t.name)")
            } catch {
                logger.error("[SyncCore] transport \(t.name) start failed: \(error.localizedDescription)")
            }
        }
        isRunning = true
        logger.info("[SyncCore] start STEP=exit isRunning=true")
        Task { @MainActor [weak self] in await self?.replayQuarantine() }
        startPathMonitor()
        // Drain any dirty rows left over from a previous session (e.g. a
        // markDirty that happened before the last shutdown). Without this
        // kick, leftover priority=0 rows just sit forever until the user
        // happens to write something new.
        scheduleSend(delay: 2)
    }

    private func startPathMonitor() {
        guard pathMonitor == nil else { return }
        let m = NWPathMonitor()
        m.pathUpdateHandler = { [weak self] path in
            // Mac Catalyst / macOS often don't report .wifi for the
            // active interface (path returns ethernet or no usable type).
            // Treat anything that isn't explicitly cellular as wifi-class
            // so the throttle multiplier is sane on those platforms.
            let cls: NetworkClass = path.usesInterfaceType(.cellular) ? .cellular : .wifi
            Task { @MainActor [weak self] in
                guard let self else { return }
                if self.networkClass != cls {
                    self.networkClass = cls
                    logger.info("[SyncCore] network class changed → \(cls)")
                }
            }
        }
        m.start(queue: DispatchQueue(label: "com.leoyuan.leophoneagent.sync.pathMonitor"))
        pathMonitor = m
    }

    func stop() async {
        isRunning = false
        pendingSendTask?.cancel()
        pendingSendTask = nil
        for t in transports {
            await t.stop()
        }
        isRunning = false
        logger.info("[SyncCore] stopped")
    }

    // MARK: - Deferred mode

    func setSendDeferred(_ deferred: Bool) {
        let was = sendDeferred
        sendDeferred = deferred
        if was != deferred {
            logger.info("[SyncCore] sendDeferred: \(deferred)")
        }
    }

    // MARK: - markDirty

    /// Mark a single record as needing to be pushed. `model` becomes the
    /// authoritative source for the build step (we extract via the
    /// type's metadata). The record is persisted to the dirty queue
    /// immediately (crash-safe) and a debounced send is scheduled
    /// unless `sendDeferred` is on.
    func markDirty<T: Syncable>(_ model: T, reason: SyncDirtyReason = .localUpsert) async {
        let m = T.syncMetadata
        let id = m.id(of: model)
        await ChatStore.shared.markDirty(recordType: m.recordType, recordId: id)
        logger.debug("[SyncCore] markDirty: type=\(m.recordType) id=\(id.prefix(8)) reason=\(reason.rawValue)")
        if !sendDeferred {
            scheduleSend()
        }
    }

    /// Mark for delete. The record will be pushed as a deletion (transport
    /// translates this into the appropriate API — CKDatabase.delete for
    /// iCloud, broadcast tombstone for LAN).
    func markDeleted<T: Syncable>(_ recordType: T.Type, id: String, reason: SyncDirtyReason = .localDelete) async {
        let m = T.syncMetadata
        await ChatStore.shared.markDirty(recordType: m.recordType, recordId: id, operation: "delete")
        logger.debug("[SyncCore] markDeleted: type=\(m.recordType) id=\(id.prefix(8)) reason=\(reason.rawValue)")
        if !sendDeferred {
            scheduleSend()
        }
    }

    // MARK: - scheduleSend / sendNow

    /// Coalesce-then-send with `defaultSendDelay`. Cancels any prior
    /// pending send so a burst of markDirty calls produces one push.
    func scheduleSend(delay: TimeInterval? = nil) {
        let actualDelay = delay ?? defaultSendDelay
        pendingSendTask?.cancel()
        pendingSendTask = Task { [weak self] in
            do {
                try await Task.sleep(nanoseconds: UInt64(actualDelay * 1_000_000_000))
            } catch {
                return // cancelled — a newer scheduleSend will run
            }
            await self?.sendNow(trigger: .scheduledDebounce)
        }
    }

    /// Immediately push everything in the dirty table, fanning out to
    /// every transport. Returns when all transports have completed (or
    /// errored).
    func sendNow(trigger: SyncSendTrigger) async {
        guard isRunning, !transports.isEmpty else {
            logger.warning("[SyncCore] sendNow skipped — not running (isRunning=\(self.isRunning) transports=\(self.transports.count)) trigger=\(trigger.rawValue)")
            return
        }
        // User-initiated pause. markDirty keeps recording so nothing is
        // lost — we just don't push until the deadline passes.
        if let until = pausedUntil {
            let wait = until.timeIntervalSinceNow
            logger.info("[SyncCore] sendNow paused — until \(until) (\(String(format: "%.0f", wait))s remaining) trigger=\(trigger.rawValue)")
            scheduleSend(delay: max(wait + 1, 60))
            return
        }
        // Honor server-issued throttle window. CloudKit returns CKError
        // requestRateLimited (HTTP 429) with a retryAfterSeconds value;
        // hammering iCloud inside that window just extends it.
        if let gate = nextEarliestSendAt, gate > Date() {
            let wait = gate.timeIntervalSinceNow
            logger.info("[SyncCore] sendNow deferred — throttled until \(gate) (\(String(format: "%.1f", wait))s remaining) trigger=\(trigger.rawValue)")
            scheduleSend(delay: wait + 0.5)
            return
        }
        guard !isSending else {
            logger.debug("[SyncCore] sendNow skipped — already sending")
            return
        }
        isSending = true; defer { isSending = false }

        // Drain any pending file changes recorded by the iSH fakefs
        // change tracker (shell tools writing under /var/minis/<subdir>)
        // and translate them into SessionFile dirty rows. This must run
        // BEFORE loadDirtyRecords so the freshly-marked rows are picked
        // up in this push cycle. Cheap when nothing pending.
        await drainSessionFileChangesIntoDirty()

        do {
            try await ChatStore.shared.configureSyncDestinations(Set(transports.map(\.name)))
            if trigger == .manual { try await ChatStore.shared.retrySyncDeliveryFailures() }
        } catch {
            logger.error("[SyncCore] delivery ledger unavailable: \(error)")
            return
        }

        var retryNeeded = false
        var sentAnyBatch = false
        var recordRetryAt: Date?
        for t in transports {
            guard isRunning else { break }
            do {
                let tickets = try await ChatStore.shared.loadSyncDeliveryTickets(destination: t.name)
                guard !tickets.isEmpty else { continue }
                let policy = sendRetryPolicies[t.name] ?? SyncRetryPolicy()
                let selection = policy.select(recordIDs: tickets.map(\.recordName), at: Date(), serviceDeadline: t.retryAfter)
                if let next = selection.nextRetryAt {
                    recordRetryAt = min(recordRetryAt ?? .distantFuture, next)
                    retryNeeded = true
                }
                var records: [PortableRecord] = []
                var deletes: [SyncRecordID] = []
                var snapshots: [String: SyncDeliveryTicket] = [:]
                for ticket in tickets where selection.eligible.contains(ticket.recordName) {
                    // Recheck at the last common send boundary, including frozen
                    // payloads and tombstones queued before the user opted out.
                    guard UploadPolicy.allowsRecordType(ticket.recordType) else { continue }
                    guard SyncableTypeRegistry.shared.metadata(for: ticket.recordType) != nil else {
                        try await ChatStore.shared.failSyncDelivery(ticket, reason: "unregistered record type")
                        continue
                    }
                    if ticket.operation == "delete" {
                        deletes.append(SyncRecordID(type: ticket.recordType, id: ticket.recordId))
                    } else {
                        guard let record = try await frozenRecord(for: ticket) else {
                            if try await ChatStore.shared.isSyncDeliveryCurrent(ticket) {
                                // Nil is not proof of deletion: missing builder, unavailable file,
                                // disabled category and corrupt data must retain visible work.
                                try await ChatStore.shared.failSyncDelivery(ticket, reason: "record payload unavailable; retry after restoring source")
                            }
                            continue
                        }
                        records.append(record)
                    }
                    snapshots[ticket.recordName] = ticket
                }
                // Hydration and asset freezing suspend. A preference may have
                // changed during those awaits; drop newly-disabled types from
                // this send without deleting their durable tickets.
                snapshots = snapshots.filter { UploadPolicy.allowsRecordType($0.value.recordType) }
                records = records.filter { snapshots[$0.id.description] != nil }
                deletes = deletes.filter { snapshots[$0.description] != nil }
                guard !snapshots.isEmpty else { continue }
                let selectedBatch = SyncOutboundBatch(records: records, deletes: deletes, deliveryTickets: snapshots)
                for name in snapshots.keys { recentlyPushedIds[name] = Date() }
                sentAnyBatch = true
                let outcomes = try await t.send(selectedBatch, trigger: trigger)
                try await applyOutcomes(outcomes, transport: t.name, tickets: snapshots)
                if outcomes.contains(where: {
                    if case .transientFailure = $0 { return true }
                    if case .conflict = $0 { return true }
                    return false
                }) { retryNeeded = true }
            } catch {
                let nse = error as NSError
                let ck = error as? CKError
                logger.error("[SyncCore] \(t.name) send threw: domain=\(nse.domain) code=\(nse.code)")
                var policy = sendRetryPolicies[t.name] ?? SyncRetryPolicy()
                policy.failed(.send, at: Date(), jitter: Double.random(in: 0...1))
                if let after = ck?.retryAfterSeconds { policy.observeServiceRetry(after: after, at: Date()) }
                sendRetryPolicies[t.name] = policy
                retryNeeded = true
            }
        }
        await cleanupDeliverySnapshots()
        if retryNeeded {
            // If a throttle gate was set, schedule respecting it; otherwise
            // a generic 10s backoff (network blip, transient partial).
            let delay: TimeInterval
            if let gate = nextEarliestSendAt, gate > Date() {
                delay = max(gate.timeIntervalSinceNow + 0.5, 10)
            } else if !sentAnyBatch, let next = recordRetryAt {
                delay = max(next.timeIntervalSinceNow + 0.5, 1)
            } else {
                delay = 10
            }
            scheduleSend(delay: delay)
        } else {
            // Even on full success, the dirty queue may still have rows
            // we couldn't fit in this batch (loadDirtyRecords LIMIT 395
            // when 100k+ rows pending — the migration initial-push case).
            // Schedule another debounced send so the queue actually
            // drains. Skip when queue is empty.
            var pending = 0
            for transport in transports {
                pending += (try? await ChatStore.shared.loadSyncDeliveryTickets(destination: transport.name, limit: 1).count) ?? 0
            }
            if pending > 0 {
                logger.info("[SyncCore] \(pending) enabled delivery tickets remain; chaining send")
                scheduleSend(delay: currentSendDelay)
            }
        }
    }

    /// Freeze bytes once per revision before any destination sees them. Retrying
    /// the same changeId must never send a different PortableRecord or file body.
    private func frozenRecord(for ticket: SyncDeliveryTicket) async throws -> PortableRecord? {
        if let data = try await ChatStore.shared.syncDeliveryPayload(ticket) {
            return try JSONDecoder().decode(PortableRecord.self, from: data)
        }
        guard let record = await SyncCoreHydrators.shared.buildPortable(recordType: ticket.recordType, id: ticket.recordId) else { return nil }
        let copy = try await Task.detached(priority: .utility) {
            let manager = FileManager.default
            let root = try manager.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
                .appendingPathComponent("SyncDeliverySnapshots", isDirectory: true)
                .appendingPathComponent(ticket.changeId, isDirectory: true)
            var assets: [String: PortableAsset] = [:]
            // No persisted payload points here yet; remove abandoned pre-commit
            // copies left by a crash before retrying this same revision.
            if manager.fileExists(atPath: root.path) { try manager.removeItem(at: root) }
            if !record.assets.isEmpty { try manager.createDirectory(at: root, withIntermediateDirectories: true) }
            for (key, asset) in record.assets {
                let target = root.appendingPathComponent(UUID().uuidString)
                try manager.copyItem(at: asset.fileURL, to: target)
                let copiedSize = (try manager.attributesOfItem(atPath: target.path)[.size] as? NSNumber)?.intValue
                guard copiedSize == asset.size else { throw CocoaError(.fileReadCorruptFile) }
                let handle = try FileHandle(forWritingTo: target)
                try handle.synchronize()
                try handle.close()
                assets[key] = PortableAsset(key: key, fileURL: target, size: asset.size, mimeType: asset.mimeType)
            }
            return PortableRecord(id: record.id, fields: record.fields, assets: assets,
                schemaVersion: record.schemaVersion, minimumCompatibleVersion: record.minimumCompatibleVersion,
                unknownFields: record.unknownFields, updatedAt: record.updatedAt)
        }.value
        let data = try JSONEncoder().encode(copy)
        guard try await ChatStore.shared.freezeSyncDelivery(ticket, payload: data) else { return nil }
        // Another destination may have frozen it while hydration suspended.
        guard let frozen = try await ChatStore.shared.syncDeliveryPayload(ticket) else { return nil }
        return try JSONDecoder().decode(PortableRecord.self, from: frozen)
    }

    private func cleanupDeliverySnapshots() async {
        guard let active = try? await ChatStore.shared.activeSyncDeliveryChangeIDs() else { return }
        await Task.detached(priority: .utility) {
            let manager = FileManager.default
            guard let root = manager.urls(for: .applicationSupportDirectory, in: .userDomainMask).first?.appendingPathComponent("SyncDeliverySnapshots"),
                  let children = try? manager.contentsOfDirectory(at: root, includingPropertiesForKeys: nil) else { return }
            for child in children where !active.contains(child.lastPathComponent) {
                try? manager.removeItem(at: child)
            }
        }.value
    }

    /// Success acknowledges only the exact selected destination/revision.
    /// Permanent failures retain a visible blocked ticket; manual retry or a
    /// newer local edit reactivates it. Transient failures remain queued. Conflicts are
    /// handled by re-merging the server record locally; the transport
    /// is expected to also re-queue the record if it wants a retry.
    private func applyOutcomes(_ outcomes: [SyncOutcome], transport: String, tickets: [String: SyncDeliveryTicket]) async throws {
        var ok = 0, transient = 0, permanent = 0, conflict = 0
        var policy = sendRetryPolicies[transport] ?? SyncRetryPolicy()
        policy.succeeded(.send)
        for outcome in outcomes {
            switch outcome {
            case .success(let id):
                policy.succeeded(.record(id.description))
                ok += 1
                // Remember this id so a fetchRecentV2 echoing it back in
                // the next 30s is recognized as our own write and skipped
                // — avoids re-triggering reloadMessagesFromDB for every
                // freshly-typed message.
                recentlyPushedIds[id.description] = Date()
                if let ticket = tickets[id.description] {
                    try await ChatStore.shared.acknowledgeSyncDelivery(ticket)
                }
            case .conflict(let id, let serverRecord):
                conflict += 1
                _ = await processInbound(SyncInboundBatch(records: [serverRecord], deletes: [], sourceDeviceId: nil), from: transport, countAsReceived: false)
                // 后写者胜(SyncConflictPolicy):服务器那版更新时,本地合并器已吸收它,
                // 这一版冻结的本地快照作废 —— 确认掉,别再拿旧内容盖住服务器上更新的改动。
                // 本地更新时保留票据,下一轮在服务器最新的系统字段上重发(retryNeeded 会排程)。
                if let ticket = tickets[id.description],
                   let data = try await ChatStore.shared.syncDeliveryPayload(ticket),
                   let local = try? JSONDecoder().decode(PortableRecord.self, from: data),
                   SyncConflictPolicy.resolve(localUpdatedAt: local.updatedAt,
                                              serverUpdatedAt: serverRecord.updatedAt) == .acceptServer {
                    try await ChatStore.shared.acknowledgeSyncDelivery(ticket)
                }
            case .transientFailure(let id, let after):
                transient += 1
                policy.failed(.record(id.description), at: Date(), minimumDelay: after ?? 0,
                              jitter: Double.random(in: 0...1))
                // 保留 dirty，下一轮只重发已经到期的记录。
            case .permanentFailure(let id, let reason):
                policy.succeeded(.record(id.description))
                permanent += 1
                logger.error("[SyncCore] permanent failure \(id) via \(transport): \(reason)")
                if let ticket = tickets[id.description] {
                    try await ChatStore.shared.failSyncDelivery(ticket, reason: reason)
                }
            }
        }
        sendRetryPolicies[transport] = policy
        logger.info("[SyncCore] \(transport) outcomes: ok=\(ok) conflict=\(conflict) transient=\(transient) permanent=\(permanent)")
        if ok > 0 || conflict > 0 {
            lastSendAt = Date()
            totalSent += ok
            // Track for the recent-rate readout. Drop events older than
            // the window so the array can't grow unbounded.
            let now = Date()
            if ok > 0 { sendEvents.append((now, ok)) }
            let cutoff = now.addingTimeInterval(-Self.rateWindow)
            while let first = sendEvents.first, first.0 < cutoff {
                sendEvents.removeFirst()
            }
        }
    }

    // MARK: - Inbound

    /// Apply a remote batch to local SQLite via per-type appliers
    /// registered through `SyncCoreHydrators`. Records are sanitized first
    /// (`SyncRecordSanitizer`); unknown types, newer schemas and malformed or
    /// hostile records go to `SyncInboundQuarantine` and count as handled, so
    /// only a genuinely transient failure withholds the transport's ACK.
    @discardableResult
    func processInbound(_ batch: SyncInboundBatch, from transport: String, countAsReceived: Bool = true) async -> Bool {
        guard !batch.records.isEmpty || !batch.deletes.isEmpty else { return true }
        // Don't inflate Sync Activity counters when this batch is just the
        // server-side echo from a conflict (our own send racing another
        // device). Real remote fetches and observe-driven inbound do
        // count.
        if countAsReceived {
            lastFetchAt = Date()
            totalReceived += batch.records.count + batch.deletes.count
        }
        // Prune stale echo-suppress entries once per batch so the map
        // doesn't grow unbounded over an idle session.
        let now = Date()
        recentlyPushedIds = recentlyPushedIds.filter { now.timeIntervalSince($0.value) < echoTTL }
        for record in batch.records where !record.unknownFields.isEmpty {
            // [T-ios-log-noise-reduction] Dedup by (type + sorted keys).
            let dedupKey = "\(record.id.type)|\(record.unknownFields.keys.sorted().joined(separator: ","))"
            if loggedUnknownFieldKeys.insert(dedupKey).inserted {
                logger.debug("[SyncSchema] unknownFields (first-seen, further occurrences suppressed): type=\(record.id.type) keys=\(record.unknownFields.keys.sorted())")
            }
        }
        let deferred = appliedInDeferredBatch
        // Hydrate inbound in 25-record chunks with a 50ms yield between
        // chunks so a large fetch doesn't hold the main actor (and every
        // intermediate Codable struct) for tens of seconds.
        let summary = await inboundApplier(alreadyApplied: { deferred.contains($0) }).apply(batch)
        // Records we pushed moments ago still run their LWW merger (a peer may
        // have edited them too) but don't count as a visible change, so our own
        // echo doesn't make every open chat reload.
        let visible = summary.appliedIds.filter { recentlyPushedIds[$0.description] == nil }.count
        logger.info("[SyncCore] inbound from \(transport): applied=\(summary.applied) quarantined=\(summary.quarantined) dropped=\(summary.dropped) blocked=\(summary.blocked)")
        SyncInboundQuarantine.shared.flush()
        if visible > 0 { notifyFetchedChanges() }
        if summary.complete { appliedInDeferredBatch.removeAll() }
        else if appliedInDeferredBatch.count < 10_000 { appliedInDeferredBatch.formUnion(summary.appliedKeys) }
        // Parents that arrived may unblock quarantined children; parked
        // children ask the transport for their parent.
        let arrivedSessions = Set(summary.appliedIds.filter { $0.type == "SessionV2" })
        if !arrivedSessions.isEmpty, transport != Self.quarantineReplaySource {
            await replayQuarantine(parents: arrivedSessions)
        }
        if !summary.dependencies.isEmpty, let t = transports.first(where: { $0.name == transport }) {
            // After the caller has ACKed this batch (the parent goes through
            // the transport's own inbox like any other record).
            let dependencies = Array(Set(summary.dependencies).prefix(20))
            Task { @MainActor in
                for dependency in dependencies { await t.requestInboundDependency(dependency) }
            }
        }
        return summary.complete
    }

    private static let quarantineReplaySource = "quarantine"

    private func inboundApplier(alreadyApplied: @escaping (String) -> Bool) -> SyncInboundApplier {
        let registry = SyncableTypeRegistry.shared
        let hydrators = SyncCoreHydrators.shared
        return SyncInboundApplier(
            metadata: { type in
                guard let meta = registry.metadata(for: type) else { return nil }
                return .init(version: meta.version, knownKeys: meta.knownCloudKeys)
            },
            merge: { await hydrators.mergeRemote($0) },
            delete: { await hydrators.applyRemoteDeletion($0, updatedAt: $1) },
            quarantine: SyncInboundQuarantine.shared,
            alreadyApplied: alreadyApplied,
            yieldBetweenChunks: { try? await Task.sleep(nanoseconds: 50_000_000) })
    }

    /// Retry quarantined records this build can now apply: on launch (after
    /// an upgrade registered a new type) and when a waited-for parent lands.
    func replayQuarantine(parents: Set<SyncRecordID>? = nil) async {
        let registry = SyncableTypeRegistry.shared
        let candidates = SyncInboundApplier.replayableEntries(
            SyncInboundQuarantine.shared.all(),
            metadata: { type in
                registry.metadata(for: type).map { .init(version: $0.version, knownKeys: $0.knownCloudKeys) }
            },
            parents: parents)
        guard !candidates.isEmpty else { return }
        var dates: [SyncRecordID: Date] = [:]
        for entry in candidates where entry.isDeletion { dates[entry.recordId] = entry.deletionUpdatedAt }
        let batch = SyncInboundBatch(records: candidates.compactMap { $0.isDeletion ? nil : $0.record },
                                     deletes: candidates.filter(\.isDeletion).map(\.recordId),
                                     sourceDeviceId: nil, deletionUpdatedAt: dates)
        // Handled entries leave quarantine (a re-quarantine re-adds them);
        // ones that asked to retry stay for the next pass.
        SyncInboundQuarantine.shared.remove(keys: Set(candidates.map(\.key)))
        let summary = await inboundApplier(alreadyApplied: { _ in false }).apply(batch)
        for entry in candidates where summary.retryIds.contains(entry.recordId) {
            SyncInboundQuarantine.shared.add(recordId: entry.recordId, record: entry.record,
                                             isDeletion: entry.isDeletion,
                                             deletionUpdatedAt: entry.deletionUpdatedAt,
                                             reason: entry.reason, replayable: true,
                                             dependency: entry.dependency)
        }
        SyncInboundQuarantine.shared.flush()
        logger.info("[SyncCore] quarantine replay: candidates=\(candidates.count) applied=\(summary.applied) retry=\(summary.retryIds.count)")
        if !summary.appliedIds.isEmpty { notifyFetchedChanges() }
    }

    /// CloudKit now delivers one record per batch; posting per record made every
    /// open chat reload hundreds of times during a sync. Coalesce to ~2 posts/s.
    private var fetchNotifyTask: Task<Void, Never>?
    private func notifyFetchedChanges() {
        guard fetchNotifyTask == nil else { return }
        fetchNotifyTask = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 400_000_000)
            self?.fetchNotifyTask = nil
            NotificationCenter.default.post(name: .cloudSyncDidFetchChanges, object: nil)
        }
    }

    // MARK: - Diagnostics

    /// Snapshot of dirty queue state (v2 path), surfaced via
    /// `debug.sync.dirtyByType`.
    func dirtySummary() async -> (total: Int, byType: [String: Int]) {
        await ChatStore.shared.countDirtyRecords()
    }

    // MARK: - Fetch (active)

    /// Trigger an incremental fetch on every transport that supports
    /// `.deltaFetch`. Inbound batches arrive via the observe callback so
    /// no return value is needed.
    func fetchNow(trigger: SyncFetchTrigger, only name: String? = nil) async {
        guard isRunning else { return }
        for t in transports where t.capabilities.contains(.deltaFetch) && (name == nil || t.name == name) {
            do {
                let batch = try await t.fetchChanges(trigger: trigger)
                if await processInbound(batch, from: t.name) {
                    do { try await t.acknowledgeInbound(batch) }
                    catch { await t.deferInbound(batch); throw error }
                } else { await t.deferInbound(batch) }
            } catch {
                logger.error("[SyncCore] \(t.name) fetchChanges threw: \(error.localizedDescription)")
            }
        }
    }

    /// Full-fetch every transport. Reconcile-after-fetch is currently
    /// DISABLED because the partial-batch risk (audit C2) is not yet
    /// resolved: CKSyncEngine.fetchChanges() does not guarantee the
    /// returned `SyncInboundBatch` is the complete cloud snapshot — for
    /// large libraries it may resolve before all pages are observed,
    /// and tombstoning every local-only session against that partial
    /// view would silently destroy live data. Until the transport
    /// surfaces a "fetch fully drained" signal (CKSyncEngine's
    /// `didFetchChanges` with no more events), we apply the inbound
    /// batch but skip the tombstone reconcile. The "ghost session"
    /// case described in §3.3.5 / §3.6.0 falls back to its safe state
    /// (local copy preserved, eventual user mutation triggers
    /// resurrect cascade).
    func fullFetchAndReconcile(trigger: SyncFetchTrigger) async {
        guard isRunning else { return }
        for t in transports {
            do {
                let batch = try await t.fullFetch(trigger: trigger)
                if await processInbound(batch, from: t.name) {
                    do { try await t.acknowledgeInbound(batch) }
                    catch { await t.deferInbound(batch); throw error }
                } else { await t.deferInbound(batch) }
                logger.info("[SyncCore] fullFetch via \(t.name): records=\(batch.records.count) deletes=\(batch.deletes.count) (reconcile skipped — see C2 in audit)")
            } catch {
                logger.error("[SyncCore] \(t.name) fullFetch threw: \(error.localizedDescription)")
            }
        }
    }

    /// Per-session force pull — locates the iCloud transport and asks it
    /// to CKQuery the session's Session/Message/CompactMarker records.
    /// Returns the number of inbound portables observed (so the caller can
    /// surface a "Pulled N records" toast). Records flow through the
    /// normal observer path, so they end up in SQLite via the standard
    /// hydrators just like any other inbound batch.
    /// Fetch the cloud-side portables for a given session WITHOUT applying
    /// them to local SQLite. Used by ChatStore.forcePullSession to look
    /// before it leaps: caller swaps local rows only after confirming the
    /// cloud copy is non-empty. Returns (portables, error). On a clean
    /// "cloud returned nothing" outcome both elements are nil/empty.
    @available(iOS 17.0, *)
    func fetchSessionPortables(sessionId: String) async -> ([PortableRecord], Error?) {
        logger.warning("[ForcePull] SyncCore.fetchSessionPortables sid=\(sessionId.prefix(8)) isRunning=\(self.isRunning) transports=\(self.transports.count)")
        for t in transports {
            logger.warning("[ForcePull] inspecting transport name=\(t.name)")
            if let iCloud = t as? ICloudSharedZoneTransport {
                do {
                    let portables = try await iCloud.fetchSessionPortables(sessionId: sessionId)
                    logger.warning("[ForcePull] fetchSessionPortables sid=\(sessionId.prefix(8)) records=\(portables.count)")
                    return (portables, nil)
                } catch {
                    logger.error("[ForcePull] fetchSessionPortables threw: \(error.localizedDescription)")
                    return ([], error)
                }
            }
        }
        logger.warning("[ForcePull] no ICloudSharedZoneTransport found in transports list — returning empty")
        return ([], nil)
    }

    /// Apply a pre-fetched portable batch through the standard inbound
    /// path (hydrators land them in SQLite). Used by forcePullSession
    /// after it has committed to swapping local for cloud.
    func applyPortables(_ portables: [PortableRecord], transportName: String) async {
        guard !portables.isEmpty else { return }
        let chunk = 50
        var i = 0
        while i < portables.count {
            let end = min(i + chunk, portables.count)
            let slice = Array(portables[i..<end])
            _ = await processInbound(SyncInboundBatch(records: slice, deletes: [], sourceDeviceId: nil), from: transportName)
            i = end
        }
    }

    // MARK: - SessionFile change tracker drain

    /// Drain pending file changes from `SessionFileChangeTracker` (events
    /// emitted by the iSH fakefs realfs hooks for any shell-tool write,
    /// truncate, unlink, rename inside `/var/minis/<workspace|attachments|browser|offloads>/...`)
    /// and turn them into SessionFile v2 dirty rows.
    ///
    /// Called from `sendNow` immediately before reading dirty rows so the
    /// freshly-marked SessionFile rows are picked up in this same push.
    /// Tracker is cleared atomically; events recorded between drain and
    /// next sendNow stay in the next snapshot — never lost.
    private func drainSessionFileChangesIntoDirty() async {
        // Filter on host mtime: a recorded open(W) only converts to a
        // dirty row if the file actually changed since (or just before)
        // we observed the open. Suppresses false positives where a
        // process opens write-mode but never writes. Entries whose
        // mtime hasn't caught up yet stay in the tracker for the next
        // push cycle — the actual write may still be in flight.
        let baseURL = await ChatStore.shared.minisBaseURL
        let snapshot = await SessionFileChangeTracker.shared.drainAllWithMtimeFilter(
            minisBaseURL: baseURL)
        guard !snapshot.isEmpty else { return }

        var totalUpsert = 0, totalDelete = 0
        var sampleRecordId: String? = nil
        for (sid, files) in snapshot {
            for (rel, change) in files {
                let recordId = "\(sid):\(rel)"
                if sampleRecordId == nil { sampleRecordId = recordId }
                switch change.op {
                case .upsert:
                    totalUpsert += 1
                    await ChatStore.shared.markDirty(
                        recordType: "SessionFile",
                        recordId: recordId,
                        operation: "upsert",
                        priority: 0
                    )
                case .delete:
                    totalDelete += 1
                    await ChatStore.shared.markDirty(
                        recordType: "SessionFile",
                        recordId: recordId,
                        operation: "delete",
                        priority: 0
                    )
                }
            }
        }
        let totalFiles = totalUpsert + totalDelete
        let sampleStr = sampleRecordId.map { String($0.prefix(80)) } ?? "?"
        logger.info("[SyncCore] file-tracker → markDirty: sessions=\(snapshot.count) files=\(totalFiles) (upsert=\(totalUpsert) delete=\(totalDelete)) sample=\(sampleStr) — these will be pushed in this cycle")
    }
}
