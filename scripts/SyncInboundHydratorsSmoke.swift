import Foundation

@main enum SyncInboundHydratorsSmoke {
    @MainActor static func main() async {
        // Process-only preference overlay; never changes real app/user settings.
        UserDefaults.standard.setVolatileDomain([UploadPolicy.Category.chatSessions.defaultsKey: false], forName: UserDefaults.argumentDomain)
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
        precondition(dispatched && received, "upload disabled must not discard incoming record; callback must be awaited")
        let deletionDispatched = await hydrators.applyRemoteDeletion(record.id)
        precondition(deletionDispatched && deleted, "upload disabled must not drop incoming tombstone")
        let missing = await hydrators.mergeRemote(PortableRecord(id: SyncRecordID(type: "Future", id: "x"), updatedAt: Date()))
        precondition(!missing, "missing merger must not report success")
        let missingDelete = await hydrators.applyRemoteDeletion(SyncRecordID(type: "Future", id: "x"))
        precondition(!missingDelete, "missing deleter must not report success")
        print("SyncInboundHydratorsSmoke: upload-independent receive/delete, awaited callback, missing merger/deleter disposition passed")
    }
}
