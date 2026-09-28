import Foundation

struct AppLogger: Sendable { init(category: String) {} ; func info(_ s: String) {}; func error(_ s: String) {}; func warning(_ s: String) {}; func debug(_ s: String) {} }
@MainActor protocol SyncTransport: AnyObject { var name: String { get } }
@MainActor final class ICloudSharedZoneTransport: SyncTransport { let name = "iCloud" }
@MainActor final class TailnetSyncTransport: SyncTransport { let name: String; init(client: FakeClient, targetDeviceId: String) throws { name = "tailnet:\(targetDeviceId)" } }
@MainActor final class FakeClient { var ready = true; let target = UUID().uuidString; func replicaReady() async -> Bool { ready }; func replicaDeviceId() async -> String? { target } }
struct FakeHost { let id: String; let name: String }
@MainActor final class GatewayHostStore { static let shared = GatewayHostStore(); var activeHosts = [FakeHost(id: "host", name: "Test Mac")]; let fake = FakeClient(); func client(for host: FakeHost) -> FakeClient? { fake } }
enum SyncSendTrigger { case scheduledDebounce, foregroundTimer }
enum SyncFetchTrigger { case startup, foregroundTimer }
@MainActor final class SyncCore { static let shared = SyncCore(); var transports: [SyncTransport] = []; var bootDelayUntil: Date?; func replaceTransports(_ values: [SyncTransport]) async { transports = values }; func sendNow(trigger: SyncSendTrigger) async {}; func fetchNow(trigger: SyncFetchTrigger, only: String? = nil) async {} }
@MainActor enum SyncedTypesBootstrap { static func registerAll() {} }
@MainActor final class SyncableTypeRegistry { static let shared = SyncableTypeRegistry(); let count = 19 }
enum DeviceIdentity { static let zoneName = "test"; static let deviceId = "test-phone" }
actor ChatStore { static let shared = ChatStore(); var purgeKeeping: [Set<String>] = []; func purgeSyncDestinations(prefix: String, keeping: Set<String>) throws -> [String] { purgeKeeping.append(keeping); return [] }; func setSyncZoneName(_ value: String) {}; func markDirty(recordType: String, recordId: String) {}; func seedReplicaHistory(destination: String) async -> Bool { true }; nonisolated static func replicaSeedCursorKey(_ destination: String) -> String { "tailnet.sync.seedCursor.\(destination)" } }
@MainActor enum ChatStoreSyncHydrators { static func registerAll() async {}; static func stageAllArtifacts(destination: String? = nil) async {} }
@MainActor final class MigrationEngine { static let shared = MigrationEngine(); enum Status { case pending, inProgress, completed, failed }; func currentStatus() -> Status { .pending }; func runIfNeeded() async {} }
@MainActor final class CloudSyncEngine { static let shared = CloudSyncEngine(); var isEnabled = true }
@MainActor final class SyncDirtyScanner { static let shared = SyncDirtyScanner(); func start() {}; func stop() {} }
@MainActor enum ForceSyncHelper { static func markMemoryDirty(destination: String? = nil) async -> Int { 0 }; static func markSoulDirty(destination: String? = nil) async -> Int { 0 } }

@main enum BootstrapSmoke {
    @MainActor static func main() async {
        let defaults = UserDefaults.standard
        func flags(cloud: Bool, tailnet: Bool, host: String = "host") {
            defaults.setVolatileDomain(["cloudSync.v2.enabled": cloud, "tailnet.sync.enabled": tailnet, "tailnet.sync.hostId": host], forName: UserDefaults.argumentDomain)
        }
        defer { defaults.removeObject(forKey: "tailnet.sync.seeded.tailnet:\(GatewayHostStore.shared.fake.target)") }
        flags(cloud: true, tailnet: false)
        await SyncV2Bootstrap.startIfEnabled()
        precondition(SyncCore.shared.transports.map(\.name) == ["iCloud"])
        flags(cloud: false, tailnet: true)
        await SyncV2Bootstrap.startIfEnabled()
        precondition(SyncCore.shared.transports.count == 1 && SyncCore.shared.transports[0].name.hasPrefix("tailnet:"), "tailnet must work while cloud disabled")
        precondition(SyncV2Bootstrap.shouldPauseV1())
        flags(cloud: true, tailnet: true)
        await SyncV2Bootstrap.startIfEnabled()
        precondition(SyncCore.shared.transports.count == 2, "destinations coexist")
        GatewayHostStore.shared.fake.ready = false
        await SyncV2Bootstrap.startIfEnabled()
        precondition(SyncCore.shared.transports.map(\.name) == ["iCloud"], "unapproved replica must not be registered")
        let purgesBeforeUnreachable = await ChatStore.shared.purgeKeeping.count
        precondition(purgesBeforeUnreachable >= 2, "connected replica purges stale destinations")
        let keptWhileUnreachable = await ChatStore.shared.purgeKeeping.last
        precondition(keptWhileUnreachable == ["tailnet:\(GatewayHostStore.shared.fake.target)"], "unreachable replica keeps its queue")
        flags(cloud: false, tailnet: false)
        await SyncV2Bootstrap.startIfEnabled()
        precondition(SyncCore.shared.transports.isEmpty, "hot disable removes routes")
        let keptAfterOff = await ChatStore.shared.purgeKeeping.last
        precondition(keptAfterOff == [], "turning the replica off forgets its queue")
        print("SyncBootstrapSmoke: cloud only, tailnet only, dual destinations, unauthorized target, hot disable passed")
    }
}
