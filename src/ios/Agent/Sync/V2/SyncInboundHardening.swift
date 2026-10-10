import Foundation

private let hardeningLog = AppLogger(category: "SyncInbound")

// MARK: - Merge outcome

/// What a domain merger did with one inbound record. Anything except
/// `.retry` lets the transport acknowledge the batch / advance its cursor.
enum SyncMergeOutcome: Equatable, Sendable {
    /// Durably applied, or an explicit conflict-resolution no-op.
    case applied
    /// Held locally for a parent that has not arrived yet (messages wait in
    /// `remote_messages` and are backfilled when their session merges).
    case parked(dependency: SyncRecordID?)
    /// Needs a parent that is not here yet and cannot be parked: quarantined
    /// and replayed when the parent arrives.
    case awaitingParent(SyncRecordID)
    /// The record can never apply (invalid identity, malformed payload).
    case rejected(String)
    /// This build registers no handler for the type: quarantined, replayed
    /// after an upgrade that adds one.
    case unsupported
    /// Transient (DB busy, session running locally): keep it on the wire.
    case retry
}

/// Mergers throw this to report a non-retry disposition without changing
/// every merger's signature. Any other error means `.retry`.
enum SyncInboundDisposition: Error, Equatable {
    case parked(dependency: SyncRecordID?)
    case awaitingParent(SyncRecordID)
    case rejected(String)

    var outcome: SyncMergeOutcome {
        switch self {
        case .parked(let dependency): return .parked(dependency: dependency)
        case .awaitingParent(let parent): return .awaitingParent(parent)
        case .rejected(let reason): return .rejected(reason)
        }
    }
}

// MARK: - Sanitizer

/// Peer data is untrusted input. Every inbound record passes through here
/// before any merger sees it: timestamps cannot be in the far future (a year-3000
/// `updatedAt` would win last-writer-wins forever and pin local edits), integers
/// that land in 32-bit SQLite columns are clamped, record ids must be a single
/// safe path component, and nothing may target a hidden local sub-agent session.
enum SyncRecordSanitizer {
    static let maxFutureSkew: TimeInterval = 24 * 3600
    static let maxIdBytes = 255

    enum Verdict: Equatable {
        case accept(PortableRecord)
        /// Never applies and is not worth keeping (e.g. targets a local child session).
        case drop(String)
        /// Malformed: kept in quarantine for diagnosis, never replayed.
        case quarantine(String)
    }

    /// Chat record types that write `sessions` / `messages` / `compact_markers`.
    static let chatTypes: Set<String> = ["SessionV2", "MessageV2", "CompactMarkerV2"]
    private static let parentKeys = ["parent_session_id", "parentSessionId", "parent_tool_use_id", "parentToolUseId"]

    static func isValidRecordId(_ id: String) -> Bool {
        guard id.utf8.count <= maxIdBytes, (try? SyncFileSafety.component(id)) != nil else { return false }
        return !id.unicodeScalars.contains { CharacterSet.controlCharacters.contains($0) }
    }

    static func clamp(_ date: Date, now: Date) -> Date {
        let interval = date.timeIntervalSince1970
        guard interval.isFinite else { return now }
        return min(date, now.addingTimeInterval(maxFutureSkew))
    }

    static func sanitize(_ record: PortableRecord, now: Date = Date(),
                         isLocalChildSession: (String) -> Bool) -> Verdict {
        let type = record.id.type
        var fields = record.fields
        // Dates: every type, every date field. LWW clocks are the target, but a
        // far-future createdAt/pinnedAt is never meaningful either.
        for (key, value) in fields {
            if case .date(let d) = value { fields[key] = .date(clamp(d, now: now)) }
        }
        let updatedAt = clamp(record.updatedAt, now: now)

        if chatTypes.contains(type) {
            guard isValidRecordId(record.id.id) else { return .quarantine("invalidRecordId") }
            let identityKey: String
            switch type {
            case "SessionV2": identityKey = "sessionId"
            case "MessageV2": identityKey = "messageId"
            default: identityKey = "markerId"
            }
            guard case .string(let identity) = fields[identityKey] ?? .null, identity == record.id.id else {
                return .quarantine("identityMismatch")
            }
            guard case .string(let sessionId) = fields["sessionId"] ?? .null, isValidRecordId(sessionId) else {
                return .quarantine("invalidSessionId")
            }
            if type == "MessageV2" {
                guard case .string = fields["role"] ?? .null, case .date = fields["createdAt"] ?? .null else {
                    return .quarantine("malformedMessage")
                }
            }
            // Child (sub-agent) sessions are device-local; a peer must never
            // create, edit or append to one.
            if type == "SessionV2" {
                for key in parentKeys {
                    for source in [record.fields[key], record.unknownFields[key]] {
                        if case .string(let parent) = source ?? .null, !parent.isEmpty {
                            return .drop("childSessionRecord")
                        }
                    }
                }
            }
            if isLocalChildSession(sessionId) { return .drop("targetsLocalChildSession") }
            // Integers here land in 32-bit SQLite binds (`Int32(...)` traps).
            for (key, value) in fields {
                if case .int(let i) = value { fields[key] = .int(Int(Int32(clamping: i))) }
            }
            if type == "SessionV2", case .string(let title) = fields["title"] ?? .null {
                fields["title"] = .string(SessionTitleSanitizer.stored(title))
            }
        }
        return .accept(PortableRecord(id: record.id, fields: fields, assets: record.assets,
                                      schemaVersion: record.schemaVersion,
                                      minimumCompatibleVersion: record.minimumCompatibleVersion,
                                      unknownFields: record.unknownFields, updatedAt: updatedAt))
    }

    /// Deletions name only an id. Same identity rules as upserts.
    static func screenDeletion(_ id: SyncRecordID, isLocalChildSession: (String) -> Bool) -> Verdict? {
        guard chatTypes.contains(id.type) else { return nil }
        guard isValidRecordId(id.id) else { return .drop("invalidRecordId") }
        if id.type == "SessionV2", isLocalChildSession(id.id) { return .drop("targetsLocalChildSession") }
        return nil
    }
}

// MARK: - Session deletion gate

/// Inbound SessionV2 deletion policy, kept pure so it can be tested without
/// the store. A delete for a session that is running here waits (the live
/// view model would otherwise keep writing into deleted rows); a stale or
/// replayed delete never removes a session edited after it.
enum SyncSessionDeleteGate {
    enum Decision: Equatable { case apply, deferUntilIdle, keepLocalNewer }

    static func decide(isRunning: Bool, localUpdatedAt: Date?, deletionUpdatedAt: Date?) -> Decision {
        if isRunning { return .deferUntilIdle }
        if let local = localUpdatedAt, let deleted = deletionUpdatedAt, local > deleted { return .keepLocalNewer }
        return .apply
    }
}

/// Media directories of one session, validated so a hostile id can never
/// resolve outside the media root.
enum SessionMediaPaths {
    static let subdirectories = ["browser", "attachments", "images", "generated"]

    static func directories(root: URL, sessionId: String) throws -> [URL] {
        _ = try SyncFileSafety.component(sessionId)
        return try subdirectories.map {
            try SyncFileSafety.destination(root: root, relativePath: "\(sessionId)/\($0)")
        }
    }
}

// MARK: - Quarantine

/// Inbound records that could not be applied but must not hold a batch or a
/// cursor hostage. Replayable entries (record types or schema versions this
/// build does not understand yet, children waiting for a parent) are retried
/// on launch and when their parent arrives; the rest are kept briefly for
/// diagnosis. Bounded in count and bytes; one JSON file.
final class SyncInboundQuarantine: @unchecked Sendable {
    struct Entry: Codable, Equatable {
        let key: String
        let recordId: SyncRecordID
        let isDeletion: Bool
        let reason: String
        let replayable: Bool
        let dependency: SyncRecordID?
        let record: PortableRecord?
        let deletionUpdatedAt: Date?
        let quarantinedAt: Date
        /// Encoded payload size, computed once (trimming must stay O(n)).
        let approxBytes: Int
    }

    static let maxEntries = 500
    static let maxRecordBytes = 64 * 1024
    static let maxTotalBytes = 2 * 1024 * 1024
    static let retention: TimeInterval = 30 * 24 * 3600

    static let shared = SyncInboundQuarantine(fileURL: FileManager.default
        .urls(for: .libraryDirectory, in: .userDomainMask)[0]
        .appendingPathComponent("MinisChat/sync-quarantine.json"))

    private let fileURL: URL
    private let lock = NSLock()
    private var loaded = false
    private var entries: [Entry] = []
    private var dirty = false

    init(fileURL: URL) { self.fileURL = fileURL }

    static func key(_ id: SyncRecordID, deletion: Bool) -> String {
        (deletion ? "delete:" : "record:") + id.description
    }

    func add(recordId: SyncRecordID, record: PortableRecord?, isDeletion: Bool = false,
             deletionUpdatedAt: Date? = nil, reason: String, replayable: Bool,
             dependency: SyncRecordID? = nil, now: Date = Date()) {
        var stored = record
        var canReplay = replayable
        var size = 0
        if let record {
            size = (try? JSONEncoder().encode(record).count) ?? Int.max
            if size > Self.maxRecordBytes {
                stored = nil
                canReplay = false
                size = 0
            }
        }
        let entry = Entry(key: Self.key(recordId, deletion: isDeletion), recordId: recordId,
                          isDeletion: isDeletion, reason: reason, replayable: canReplay,
                          dependency: dependency, record: stored,
                          deletionUpdatedAt: deletionUpdatedAt, quarantinedAt: now,
                          approxBytes: size + 256)
        lock.lock(); defer { lock.unlock() }
        loadLocked()
        entries.removeAll { $0.key == entry.key }
        entries.append(entry)
        trimLocked(now: now)
        dirty = true
    }

    func all() -> [Entry] {
        lock.lock(); defer { lock.unlock() }
        loadLocked()
        return entries
    }

    var count: Int { all().count }

    func remove(keys: Set<String>) {
        guard !keys.isEmpty else { return }
        lock.lock(); defer { lock.unlock() }
        loadLocked()
        let before = entries.count
        entries.removeAll { keys.contains($0.key) }
        if entries.count != before { dirty = true }
    }

    /// Persist pending changes. Called once per inbound batch, not per record.
    func flush() {
        lock.lock(); defer { lock.unlock() }
        guard dirty else { return }
        do {
            try FileManager.default.createDirectory(at: fileURL.deletingLastPathComponent(),
                                                    withIntermediateDirectories: true)
            try JSONEncoder().encode(entries).write(to: fileURL, options: .atomic)
            dirty = false
        } catch {
            hardeningLog.warning("[SyncInbound] quarantine flush failed: \(error.localizedDescription)")
        }
    }

    private func loadLocked() {
        guard !loaded else { return }
        loaded = true
        guard let data = try? Data(contentsOf: fileURL) else { return }
        entries = (try? JSONDecoder().decode([Entry].self, from: data)) ?? []
    }

    private func trimLocked(now: Date) {
        let cutoff = now.addingTimeInterval(-Self.retention)
        entries.removeAll { $0.quarantinedAt < cutoff }
        var bytes = entries.reduce(0) { $0 + $1.approxBytes }
        while entries.count > Self.maxEntries || bytes > Self.maxTotalBytes, !entries.isEmpty {
            // Diagnostics go first; replayable data only when nothing else is left.
            let i = entries.firstIndex(where: { !$0.replayable }) ?? 0
            bytes -= entries[i].approxBytes
            entries.remove(at: i)
        }
    }
}

// MARK: - Inbound apply loop

/// The per-record loop behind `SyncCore.processInbound`, with its store and
/// registry dependencies injected so the acknowledgement rules are testable.
///
/// Rule: a batch is complete (the transport may ACK / advance its cursor)
/// unless some record asked to be retried. Unknown record types, newer
/// schemas, malformed or hostile records are quarantined and count as handled
/// — one bad record must never stall every later change from a peer.
@MainActor
struct SyncInboundApplier {
    struct Metadata { let version: Int; let knownKeys: Set<String> }

    struct Summary {
        var applied = 0
        var quarantined = 0
        var dropped = 0
        var blocked = 0
        /// Records and deletes that changed (or were merged into) local state.
        var appliedIds: [SyncRecordID] = []
        /// `type:id@updatedAt` keys applied this pass (deferred-batch dedupe).
        var appliedKeys: Set<String> = []
        /// Parents worth fetching for parked children.
        var dependencies: [SyncRecordID] = []
        /// Ids that asked to be retried.
        var retryIds: Set<SyncRecordID> = []
        var cancelled = false
        var complete: Bool { blocked == 0 && !cancelled }
    }

    var metadata: (String) -> Metadata?
    var merge: @MainActor (PortableRecord) async -> SyncMergeOutcome
    var delete: @MainActor (SyncRecordID, Date?) async -> SyncMergeOutcome
    var quarantine: SyncInboundQuarantine
    var isLocalChildSession: (String) -> Bool = { ChildSessionIndex.contains($0) }
    var now: () -> Date = { Date() }
    var alreadyApplied: (String) -> Bool = { _ in false }
    var yieldBetweenChunks: @MainActor () async -> Void = {}
    var isCancelled: () -> Bool = { Task.isCancelled }
    var chunkSize = 25

    static func appliedKey(_ record: PortableRecord) -> String {
        "\(record.id.description)@\(record.updatedAt.timeIntervalSince1970)"
    }

    func apply(_ batch: SyncInboundBatch) async -> Summary {
        var summary = Summary()
        let records = SyncPollPlan.parentsFirst(batch.records) { $0.id.type }
        var index = 0
        while index < records.count {
            let end = min(index + chunkSize, records.count)
            for raw in records[index..<end] {
                await applyRecord(raw, into: &summary)
            }
            index = end
            if index < records.count { await yieldBetweenChunks() }
        }
        for id in batch.deletes {
            await applyDeletion(id, updatedAt: batch.deletionUpdatedAt[id], into: &summary)
        }
        summary.cancelled = isCancelled()
        if summary.quarantined > 0 || summary.dropped > 0 {
            hardeningLog.warning("[SyncInbound] isolated records quarantined=\(summary.quarantined) dropped=\(summary.dropped)")
        }
        return summary
    }

    private func applyRecord(_ raw: PortableRecord, into summary: inout Summary) async {
        guard let meta = metadata(raw.id.type) else {
            hardeningLog.info("[SyncSchema] unknownRecordType: type=\(raw.id.type) action=quarantined")
            quarantine.add(recordId: raw.id, record: raw, reason: "unknownRecordType", replayable: true, now: now())
            summary.quarantined += 1
            return
        }
        let record = raw.reclassifyingKnownFields(meta.knownKeys)
        if let minimum = record.minimumCompatibleVersion, minimum > meta.version {
            hardeningLog.warning("[SyncSchema] minimumCompatibleVersionBlocked: type=\(record.id.type) required=\(minimum) local=\(meta.version) action=quarantined")
            quarantine.add(recordId: record.id, record: record, reason: "minimumCompatibleVersion", replayable: true, now: now())
            summary.quarantined += 1
            return
        }
        let sanitized: PortableRecord
        switch SyncRecordSanitizer.sanitize(record, now: now(), isLocalChildSession: isLocalChildSession) {
        case .accept(let r): sanitized = r
        case .drop(let reason):
            hardeningLog.info("[SyncInbound] dropped type=\(record.id.type) reason=\(reason)")
            summary.dropped += 1
            return
        case .quarantine(let reason):
            quarantine.add(recordId: record.id, record: record, reason: reason, replayable: false, now: now())
            summary.quarantined += 1
            return
        }
        let key = Self.appliedKey(sanitized)
        if alreadyApplied(key) { summary.applied += 1; return }
        switch await merge(sanitized) {
        case .applied:
            summary.applied += 1
            summary.appliedKeys.insert(key)
            summary.appliedIds.append(sanitized.id)
        case .parked(let dependency):
            summary.applied += 1
            summary.appliedKeys.insert(key)
            if let dependency { summary.dependencies.append(dependency) }
        case .awaitingParent(let parent):
            quarantine.add(recordId: sanitized.id, record: sanitized, reason: "awaitingParent",
                           replayable: true, dependency: parent, now: now())
            summary.quarantined += 1
            summary.dependencies.append(parent)
        case .rejected(let reason):
            quarantine.add(recordId: sanitized.id, record: sanitized, reason: reason, replayable: false, now: now())
            summary.quarantined += 1
        case .unsupported:
            quarantine.add(recordId: sanitized.id, record: sanitized, reason: "noHandler", replayable: true, now: now())
            summary.quarantined += 1
        case .retry:
            summary.blocked += 1
            summary.retryIds.insert(sanitized.id)
        }
    }

    private func applyDeletion(_ id: SyncRecordID, updatedAt: Date?, into summary: inout Summary) async {
        guard metadata(id.type) != nil else {
            quarantine.add(recordId: id, record: nil, isDeletion: true, deletionUpdatedAt: updatedAt,
                           reason: "unknownRecordType", replayable: true, now: now())
            summary.quarantined += 1
            return
        }
        if let verdict = SyncRecordSanitizer.screenDeletion(id, isLocalChildSession: isLocalChildSession) {
            hardeningLog.info("[SyncInbound] dropped deletion type=\(id.type) verdict=\(String(describing: verdict))")
            summary.dropped += 1
            return
        }
        let clamped = updatedAt.map { SyncRecordSanitizer.clamp($0, now: now()) }
        switch await delete(id, clamped) {
        case .applied, .parked:
            summary.applied += 1
            summary.appliedIds.append(id)
        case .awaitingParent, .rejected:
            summary.dropped += 1
        case .unsupported:
            quarantine.add(recordId: id, record: nil, isDeletion: true, deletionUpdatedAt: clamped,
                           reason: "noHandler", replayable: true, now: now())
            summary.quarantined += 1
        case .retry:
            summary.blocked += 1
            summary.retryIds.insert(id)
        }
    }

    /// Quarantined entries that may now apply: their type is registered and
    /// compatible, and (for children) their parent arrived. `parents` limits
    /// awaiting-parent entries to the given parent ids; nil replays all.
    static func replayableEntries(_ entries: [SyncInboundQuarantine.Entry],
                                  metadata: (String) -> Metadata?,
                                  parents: Set<SyncRecordID>?) -> [SyncInboundQuarantine.Entry] {
        entries.filter { entry in
            guard entry.replayable, let meta = metadata(entry.recordId.type) else { return false }
            if let minimum = entry.record?.minimumCompatibleVersion, minimum > meta.version { return false }
            if entry.reason == "awaitingParent", let parents {
                return entry.dependency.map(parents.contains) ?? false
            }
            return entry.isDeletion || entry.record != nil
        }
    }
}
