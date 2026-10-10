import Foundation

/// Per-type "how do I rebuild this from local SQLite?" + "how do I merge
/// a remote into local SQLite?" hooks. Decouples SyncCore from concrete
/// stores (ChatStore / SkillStore / ProviderConfigStore / ...).
///
/// Each store registers its hooks at app launch. SyncCore looks them up
/// by recordType when building the outbound batch and when applying
/// inbound records.
///
/// Why two separate hook surfaces (build vs merge) rather than one
/// "Syncable model"-style protocol: the build path needs to load from
/// SQLite (recordType + id → SyncedX), while the merge path takes a
/// PortableRecord and integrates it with conflict resolution. Stores
/// already have those code paths in different places (mergeRemoteX
/// methods etc.) — letting them register two separate closures is the
/// least-invasive way to plug v2 in.
@MainActor
final class SyncCoreHydrators {
    static let shared = SyncCoreHydrators()
    private init() {}

    /// "Given recordType + id, return a PortableRecord ready to push (or
    /// nil if the local row no longer exists)." Called on the SyncCore
    /// actor; implementations are free to await actor hops internally.
    typealias Builder = (_ id: String) async -> PortableRecord?

    /// "Given a remote PortableRecord, merge it into local SQLite using
    /// this type's conflict resolution." Should be a no-op when the
    /// record loses a durable conflict-resolution comparison. Throw if the
    /// write failed, input is invalid, or application must be retried.
    typealias Merger = (_ record: PortableRecord) async throws -> Void

    /// "Given a record id, propagate its remote deletion locally — but
    /// honour soft-delete / tombstone rules per §3.3." Optional; if not
    /// registered, the deletion remains pending rather than reporting success.
    typealias DeletionApplier = (_ id: String) async throws -> Void

    private var builders: [String: Builder] = [:]
    private var mergers: [String: Merger] = [:]
    private var deleters: [String: DeletionApplier] = [:]
    typealias DatedDeletionApplier = (_ id: String, _ updatedAt: Date?) async throws -> Void
    private var datedDeleters: [String: DatedDeletionApplier] = [:]

    func register(
        recordType: String,
        builder: Builder?,
        merger: Merger?,
        deletionApplier: DeletionApplier? = nil,
        datedDeletionApplier: DatedDeletionApplier? = nil
    ) {
        if let b = builder { builders[recordType] = b }
        if let m = merger { mergers[recordType] = m }
        if let d = deletionApplier { deleters[recordType] = d }
        if let d = datedDeletionApplier { datedDeleters[recordType] = d }
    }

    func buildPortable(recordType: String, id: String) async -> PortableRecord? {
        guard let b = builders[recordType] else {
            // No builder yet — type is registered for read-only consumption.
            return nil
        }
        return await b(id)
    }

    /// True when this recordType has a builder closure registered. Used by
    /// SyncCore to differentiate "local row gone (clear dirty safe)" from
    /// "no builder registered yet (must NOT clear dirty)" — see audit C3.
    func hasBuilder(recordType: String) -> Bool {
        builders[recordType] != nil
    }

    /// Success means durable apply or an explicit conflict-resolution no-op.
    /// Upload preferences never discard inbound records. Missing handlers and
    /// deferred/failed storage operations retain the transport's durable inbox.
    func mergeRemote(_ record: PortableRecord) async -> SyncMergeOutcome {
        guard let merger = mergers[record.id.type] else { return .unsupported }
        do {
            try await merger(record)
            return Task.isCancelled ? .retry : .applied
        } catch let disposition as SyncInboundDisposition {
            return disposition.outcome
        } catch {
            return .retry
        }
    }

    func applyRemoteDeletion(_ id: SyncRecordID, updatedAt: Date? = nil) async -> SyncMergeOutcome {
        do {
            if let deleter = datedDeleters[id.type] {
                try await deleter(id.id, updatedAt)
            } else if let deleter = deleters[id.type] {
                try await deleter(id.id)
            } else {
                return .unsupported
            }
            return Task.isCancelled ? .retry : .applied
        } catch let disposition as SyncInboundDisposition {
            return disposition.outcome
        } catch {
            return .retry
        }
    }

    func hasMerger(recordType: String) -> Bool { mergers[recordType] != nil }

    var registeredRecordTypes: [String] {
        Array(Set(builders.keys).union(mergers.keys).union(deleters.keys).union(datedDeleters.keys)).sorted()
    }
}
