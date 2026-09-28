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
    /// record cannot be applied (e.g. unknown schema version was already
    /// filtered upstream by SyncCore).
    typealias Merger = (_ record: PortableRecord) async -> Void

    /// "Given a record id, propagate its remote deletion locally — but
    /// honour soft-delete / tombstone rules per §3.3." Optional; if not
    /// registered, SyncCore falls back to a hard delete via direct SQL.
    typealias DeletionApplier = (_ id: String) async -> Void

    private var builders: [String: Builder] = [:]
    private var mergers: [String: Merger] = [:]
    private var deleters: [String: DeletionApplier] = [:]

    func register(
        recordType: String,
        builder: Builder?,
        merger: Merger?,
        deletionApplier: DeletionApplier? = nil
    ) {
        if let b = builder { builders[recordType] = b }
        if let m = merger { mergers[recordType] = m }
        if let d = deletionApplier { deleters[recordType] = d }
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

    /// True means the record was handled: merged, or intentionally ignored because
    /// the user turned the category off or this build has no applier for it.
    /// Ignoring must not withhold a transport cursor, or one unsupported record
    /// would replay the same page forever and block every later change.
    @discardableResult
    func mergeRemote(_ record: PortableRecord) async -> Bool {
        // Same per-category toggle as uploads: a category the user turned off
        // neither pushes local writes nor accepts peer ones.
        guard UploadPolicy.allowsRecordType(record.id.type) else { return true }
        guard let merger = mergers[record.id.type] else { return true }
        await merger(record)
        return true
    }

    @discardableResult
    func applyRemoteDeletion(_ id: SyncRecordID) async -> Bool {
        guard UploadPolicy.allowsRecordType(id.type) else { return true }
        // Types without a deletion applier keep the local copy (safe default).
        guard let deleter = deleters[id.type] else { return true }
        await deleter(id.id)
        return true
    }

    var registeredRecordTypes: [String] {
        Array(Set(builders.keys).union(mergers.keys).union(deleters.keys)).sorted()
    }
}
