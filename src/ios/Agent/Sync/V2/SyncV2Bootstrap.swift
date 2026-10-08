import Foundation

private let logger = AppLogger(category: "SyncCore")

/// Top-level entry point for the v2 sync stack. Called once at app launch
/// from MinisApp.swift. Wires Syncable types into the registry, registers
/// ChatStore-backed hydrators, hooks ICloudSharedZoneTransport into
/// SyncCore, and (optionally) runs the v1→v2 migration engine.
///
/// Gated by `UserDefaults.cloudSync.v2.enabled` (default false). When
/// disabled, this function is a no-op and v1 CloudSyncEngine continues
/// to drive sync. Once the flag flips on, v1 is paused and v2 takes over
/// (at app start; an in-place hot-swap mid-session is not supported).
enum SyncV2Bootstrap {

    /// User-facing toggle. On a first read with no v2 key set we default
    /// to OFF (clean install starts opted-out so the user gets to make
    /// an informed decision instead of background iCloud traffic on
    /// first launch). For users upgrading from a build that only had
    /// the v1 engine we inherit their v1 toggle (`cloudSync.enabled`)
    /// so a user who had iCloud Sync ON in v1 keeps it on after the
    /// upgrade, and one who had it OFF keeps it off. Reading this value must
    /// stay side-effect free because SwiftUI consults it while building views;
    /// persistence happens only when the user changes the setting.
    /// Override via the `cloudSync.v2.enabled` UserDefaults key directly
    /// during development.
    static var isEnabled: Bool {
        let key = "cloudSync.v2.enabled"
        if UserDefaults.standard.object(forKey: key) == nil {
            // Inherit from v1 if the user ever interacted with that
            // toggle (object(forKey:) returns non-nil once any write
            // occurred — including the v1 engine's own write-back at
            // init). If neither key exists this is a clean install:
            // default OFF.
            let v1Key = "cloudSync.enabled"
            let inherited: Bool
            if let v1 = UserDefaults.standard.object(forKey: v1Key) as? Bool {
                inherited = v1
                logger.info("[SyncCore] v2 isEnabled bootstrap — inheriting v1 cloudSync.enabled=\(v1)")
            } else {
                inherited = false
                logger.info("[SyncCore] v2 isEnabled bootstrap — fresh install, defaulting OFF")
            }
            return inherited
        }
        return UserDefaults.standard.bool(forKey: key)
    }

    static var isTailnetEnabled: Bool { UserDefaults.standard.bool(forKey: "tailnet.sync.enabled") }
    static var selectedReplicaHostID: String { UserDefaults.standard.string(forKey: "tailnet.sync.hostId") ?? "" }
    static var isAnyEnabled: Bool { isEnabled || isTailnetEnabled }
    @MainActor private(set) static var tailnetStatus = ""
    @MainActor private static var reconcileTask: Task<Void, Never>?
    @MainActor private static var seedTask: Task<Void, Never>?
    @MainActor private static var periodicTask: Task<Void, Never>?
    @MainActor private static var seedGeneration = 0
    @MainActor private static var didDeferBoot = false
    @MainActor private static var provisionalRetryTask: Task<Void, Never>?
    /// Backoff for re-trying an unreachable replica; iCloud is not restarted meanwhile.
    @MainActor private static var replicaRetrySeconds: UInt64 = 30

    static func setEnabled(_ enabled: Bool) {
        UserDefaults.standard.set(enabled, forKey: "cloudSync.v2.enabled")
        Task { @MainActor in requestReconcile() }
    }

    static func setTailnetEnabled(_ enabled: Bool, hostID: String? = nil) {
        if let hostID { UserDefaults.standard.set(hostID, forKey: "tailnet.sync.hostId") }
        UserDefaults.standard.set(enabled, forKey: "tailnet.sync.enabled")
        Task { @MainActor in requestReconcile() }
    }

    /// [T-replica-seed] Give a new (or rebuilt) Mac replica this device's history.
    /// Tickets go to that destination only: the shared dirty table is untouched,
    /// so enabling the replica never re-pushes history to iCloud. Resumable.
    @MainActor static func startReplicaSeed(_ destination: String, restart: Bool = false) {
        let doneKey = "tailnet.sync.seeded.\(destination)"
        if restart {
            seedTask?.cancel()
            seedTask = nil
            UserDefaults.standard.removeObject(forKey: doneKey)
            UserDefaults.standard.removeObject(forKey: ChatStore.replicaSeedCursorKey(destination))
        }
        guard seedTask == nil, !UserDefaults.standard.bool(forKey: doneKey) else { return }
        seedGeneration += 1
        let generation = seedGeneration
        seedTask = Task { @MainActor in
            defer { if seedGeneration == generation { seedTask = nil } }
            guard await ChatStore.shared.seedReplicaHistory(destination: destination), !Task.isCancelled else { return }
            await ChatStoreSyncHydrators.stageAllArtifacts(destination: destination)
            _ = await ForceSyncHelper.markMemoryDirty(destination: destination)
            _ = await ForceSyncHelper.markSoulDirty(destination: destination)
            guard !Task.isCancelled else { return }
            UserDefaults.standard.set(true, forKey: doneKey)
            await SyncCore.shared.sendNow(trigger: .scheduledDebounce)
        }
    }

    /// Forget every replica queue except `keeping`; a later re-enable reseeds.
    @MainActor private static func purgeReplicaDestinations(keeping: String?) async {
        let purged = (try? await ChatStore.shared.purgeSyncDestinations(
            prefix: "tailnet:", keeping: Set([keeping].compactMap { $0 }))) ?? []
        for name in purged {
            UserDefaults.standard.removeObject(forKey: "tailnet.sync.seeded.\(name)")
            UserDefaults.standard.removeObject(forKey: ChatStore.replicaSeedCursorKey(name))
        }
    }

    @MainActor private static func requestReconcile() {
        let previous = reconcileTask
        previous?.cancel()
        reconcileTask = Task { @MainActor in
            await previous?.value
            guard !Task.isCancelled else { return }
            await reconcile()
        }
    }

    /// Has the user explicitly requested migration of their pre-v2 history?
    /// Default OFF: only newly-created sessions/messages sync to v2 by
    /// default. The user must tap "Request Migration" in the Sync sheet
    /// to backfill historical data — and can also tap "Force Delete V1
    /// Zone" to discard the legacy copy entirely. Earlier builds defaulted
    /// to ON which kicked off a multi-hour throttled push on every
    /// upgrading device, often without the user's knowledge.
    private static let migrationRequestedKey = "cloudSync.v2.migrationRequested"
    static var isMigrationRequested: Bool {
        UserDefaults.standard.bool(forKey: migrationRequestedKey)
    }
    static func setMigrationRequested(_ requested: Bool) {
        UserDefaults.standard.set(requested, forKey: migrationRequestedKey)
        logger.info("[SyncCore] migration requested=\(requested)")
    }

    /// Should v1 CloudSyncEngine be allowed to run? It is paused as soon
    /// as v2 is enabled AND migration is in progress / completed. While
    /// migration is `inProgress`, v2 fetches v1 data via a minimal shim
    /// — full v1 engine MUST stay quiet to avoid double-sends.
    @MainActor
    static func shouldPauseV1() -> Bool {
        // Once V2 settings own the switch, disabling CloudKit must not silently
        // reactivate the legacy engine. A tailnet-only configuration also owns it.
        isAnyEnabled || UserDefaults.standard.object(forKey: "cloudSync.v2.enabled") != nil
    }

    /// CloudKit and a paired Mac replica are independently enabled destinations.
    /// Reconfiguration is serialized so rapid toggle changes cannot revive old routes.
    @MainActor
    static func startIfEnabled() async {
        requestReconcile()
        await reconcileTask?.value
    }

    @MainActor
    private static func reconcile() async {
        guard #available(iOS 17.0, *) else { return }
        // Preserve inherited opt-in before pausing V1; its setter also persists
        // cloudSync.enabled, which must not alter the V2 user's choice.
        if UserDefaults.standard.object(forKey: "cloudSync.v2.enabled") == nil {
            UserDefaults.standard.set(isEnabled, forKey: "cloudSync.v2.enabled")
        }
        if CloudSyncEngine.shared.isEnabled { CloudSyncEngine.shared.isEnabled = false }
        periodicTask?.cancel()
        periodicTask = nil
        if !isTailnetEnabled { seedTask?.cancel(); seedTask = nil }
        guard isAnyEnabled else {
            await purgeReplicaDestinations(keeping: nil)
            await SyncCore.shared.replaceTransports([])
            SyncDirtyScanner.shared.stop()
            tailnetStatus = String(localized: "Off")
            return
        }
        // Before first unlock the Keychain is unreadable and the device id is
        // provisional. Zone name and SyncDeviceV2 registration would bake it
        // into every dirty row, so defer; retry on a timer as well as on the
        // next activation (a background relaunch may never get one).
        guard !DeviceIdentity.isProvisional else {
            logger.warning("[SyncCore] sync deferred — device identity is provisional (keychain locked); retrying in 30s")
            if provisionalRetryTask == nil {
                provisionalRetryTask = Task { @MainActor in
                    try? await Task.sleep(nanoseconds: 30_000_000_000)
                    provisionalRetryTask = nil
                    guard !Task.isCancelled else { return }
                    requestReconcile()
                }
            }
            return
        }
        SyncedTypesBootstrap.registerAll()
        await ChatStore.shared.setSyncZoneName(DeviceIdentity.zoneName)
        await ChatStoreSyncHydrators.registerAll()
        // Cold launch: keep CloudKit/replica traffic off the first seconds of UI
        // hydration (observed 30%+ CPU spikes when both ran together).
        if !didDeferBoot {
            didDeferBoot = true
            SyncCore.shared.bootDelayUntil = Date().addingTimeInterval(15)
            defer { SyncCore.shared.bootDelayUntil = nil }
            do { try await Task.sleep(nanoseconds: 15_000_000_000) } catch { return }
        }
        var selected: [SyncTransport] = []
        if isEnabled {
            selected.append(SyncCore.shared.transports.first { $0.name == "iCloud" } ?? ICloudSharedZoneTransport())
        }
        var replicaName: String?
        if isTailnetEnabled {
            tailnetStatus = String(localized: "正在连接同步副本…")
            if let host = GatewayHostStore.shared.activeHosts.first(where: { $0.id == selectedReplicaHostID }),
               let client = GatewayHostStore.shared.client(for: host),
               await client.replicaReady(),
               let target = await client.replicaDeviceId(), let uuid = UUID(uuidString: target) {
                do {
                    let transport = try TailnetSyncTransport(client: client, targetDeviceId: uuid.uuidString)
                    selected.append(transport)
                    replicaName = transport.name
                    tailnetStatus = host.name
                } catch { tailnetStatus = String(localized: "无法初始化同步副本") }
            } else {
                tailnetStatus = String(localized: "请选择已授权同步副本的 Mac；请先在设备页面完成配对")
            }
        } else { tailnetStatus = String(localized: "Off") }
        guard !Task.isCancelled else { return }
        // A replica the user turned off or replaced must stop pinning dirty rows.
        // An unreachable one keeps its queue until it comes back.
        if !isTailnetEnabled || replicaName != nil { await purgeReplicaDestinations(keeping: replicaName) }
        await SyncCore.shared.replaceTransports(selected)
        guard !Task.isCancelled else { return }
        SyncDirtyScanner.shared.start()
        await ChatStore.shared.markDirty(recordType: "SyncDeviceV2", recordId: DeviceIdentity.deviceId)
        // This install re-minted its id (restored to a new device / lost
        // Keychain item): retire the previous SyncDeviceV2 so peers drop the
        // ghost row, and tombstone it so a stale echo cannot resurrect it.
        if let old = DeviceIdentity.takeRetiredDeviceId(), old != DeviceIdentity.deviceId {
            _ = await ChatStore.shared.recordDeletedRecordTombstone(type: "SyncDeviceV2", id: old)
            await ChatStore.shared.markDirty(recordType: "SyncDeviceV2", recordId: old, operation: "delete")
            logger.info("[SyncCore] retiring previous device id \(old.prefix(8)) (op=delete queued)")
        }
        if isEnabled { await MigrationEngine.shared.runIfNeeded() }
        if let replicaName { startReplicaSeed(replicaName) }
        await SyncCore.shared.sendNow(trigger: .scheduledDebounce)
        await SyncCore.shared.fetchNow(trigger: .startup)
        // iCloud has its own push + timer. Only the replica needs polling here.
        guard isTailnetEnabled else { return }
        if replicaName == nil {
            let delay = replicaRetrySeconds
            replicaRetrySeconds = min(replicaRetrySeconds * 2, 600)
            periodicTask = Task { @MainActor in
                do { try await Task.sleep(nanoseconds: delay * 1_000_000_000) } catch { return }
                guard !Task.isCancelled, isTailnetEnabled else { return }
                requestReconcile()
            }
            return
        }
        replicaRetrySeconds = 30
        periodicTask = Task { @MainActor in
            while !Task.isCancelled {
                do { try await Task.sleep(nanoseconds: 30_000_000_000) } catch { return }
                guard !Task.isCancelled, isTailnetEnabled else { return }
                // Host removed from the device list: drop the replica route.
                guard GatewayHostStore.shared.activeHosts.contains(where: { $0.id == selectedReplicaHostID }) else {
                    requestReconcile()
                    return
                }
                await SyncCore.shared.fetchNow(trigger: .foregroundTimer, only: replicaName)
                await SyncCore.shared.sendNow(trigger: .foregroundTimer)
            }
        }
    }
}
