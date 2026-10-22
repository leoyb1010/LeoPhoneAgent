import Foundation

@main enum SyncInboundHydratorsSmoke {
    @MainActor static func main() async {
        // Process-only preference overlay; never changes real app/user settings.
        UserDefaults.standard.setVolatileDomain(Dictionary(uniqueKeysWithValues:
            UploadPolicy.Category.allCases.map { ($0.defaultsKey, false) }), forName: UserDefaults.argumentDomain)
        for type in ["EnvVar", "EnvVarV2", "EnvVarItem", "ProviderConfig", "ProviderConfigV2", "ProviderInstanceV3", "ProviderModelEntryV3", "ProviderModelGroupV3", "SoulV2"] {
            precondition(!UploadPolicy.allowsRecordType(type), "privacy category must cover current and legacy type aliases")
        }
        precondition(UploadPolicy.allowsRecordType("SyncDeviceV2"))
        precondition(!UploadPolicy.allowsRecordType("SessionV2"))
        let hydrators = SyncCoreHydrators.shared
        var received = false
        var deleted = false
        hydrators.register(recordType: "SessionV2", builder: nil, merger: { _ in
            try? await Task.sleep(nanoseconds: 1_000_000)
            received = true
        }, deletionApplier: { _ in deleted = true })
        let record = PortableRecord(id: SyncRecordID(type: "SessionV2", id: "isolated"), updatedAt: Date())
        let dispatched = await hydrators.mergeRemote(record)
        precondition(dispatched == .applied && received, "upload disabled must not discard incoming record; callback must be awaited")
        let deletionDispatched = await hydrators.applyRemoteDeletion(record.id)
        precondition(deletionDispatched == .applied && deleted, "upload disabled must not drop incoming tombstone")
        let missing = await hydrators.mergeRemote(PortableRecord(id: SyncRecordID(type: "Future", id: "x"), updatedAt: Date()))
        // A missing handler is never success: it quarantines (.unsupported) for replay after an upgrade.
        precondition(missing == .unsupported, "missing merger must not report success")
        let missingDelete = await hydrators.applyRemoteDeletion(SyncRecordID(type: "Future", id: "x"))
        precondition(missingDelete == .unsupported, "missing deleter must not report success")
        var attempts = 0
        hydrators.register(recordType: "Retryable", builder: nil, merger: { _ in
            attempts += 1
            if attempts == 1 { throw CocoaError(.fileWriteOutOfSpace) }
        }, deletionApplier: { _ in throw CocoaError(.fileWriteNoPermission) })
        let retryable = PortableRecord(id: .init(type: "Retryable", id: "r"), updatedAt: Date())
        let failed = await hydrators.mergeRemote(retryable)
        precondition(failed == .retry, "failed durable write must retain inbox")
        let retried = await hydrators.mergeRemote(retryable)
        precondition(retried == .applied && attempts == 2, "same inbound record must be replayable after recovery")
        let failedDeletion = await hydrators.applyRemoteDeletion(retryable.id)
        precondition(failedDeletion == .retry, "failed deletion must retain inbox")
        var deletionDate: Date?
        hydrators.register(recordType: "Dated", builder: nil, merger: nil, datedDeletionApplier: { _, date in deletionDate = date })
        let stamp = Date(timeIntervalSince1970: 100)
        let dated = await hydrators.applyRemoteDeletion(.init(type: "Dated", id: "file"), updatedAt: stamp)
        precondition(dated == .applied && deletionDate == stamp, "peer tombstone clock must survive dispatch")
        // Mergers report non-retry dispositions by throwing SyncInboundDisposition; it must map
        // through unchanged, never collapse into .applied or .retry.
        let parent = SyncRecordID(type: "SessionV2", id: "parent")
        hydrators.register(recordType: "Parked", builder: nil, merger: { _ in
            throw SyncInboundDisposition.parked(dependency: parent)
        }, deletionApplier: { _ in throw SyncInboundDisposition.rejected("bad id") })
        let parkedRecord = PortableRecord(id: .init(type: "Parked", id: "p"), updatedAt: Date())
        let parked = await hydrators.mergeRemote(parkedRecord)
        precondition(parked == .parked(dependency: parent), "parked disposition must survive dispatch")
        let rejected = await hydrators.applyRemoteDeletion(parkedRecord.id)
        precondition(rejected == .rejected("bad id"), "rejected disposition must survive dispatch")
        print("SyncInboundHydratorsSmoke: upload-independent receive/delete, awaited callback, missing merger/deleter disposition passed")
    }
}
