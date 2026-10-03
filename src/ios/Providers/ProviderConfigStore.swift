import Foundation
import Security
import os.log

private let logger = AppLogger(category: "ProviderConfigStore")

// MARK: - Persisted Config

/// One soft-delete record. Persisted in `ProviderConfig` so the deletion
/// can travel through iCloud sync as positive data, and so `mergeProviderConfig`'s
/// set-union semantics can be told "this id is intentionally gone, don't
/// resurrect it from the other side's snapshot".
struct ProviderConfigTombstone: Codable, Hashable {
    let id: String
    let deletedAt: Date
}

/// Top-level JSON structure for provider-config.json.
struct ProviderConfig: Codable, Equatable {
    var instances: [ProviderInstance]
    var modelEntries: [ModelEntry]
    var modelGroups: [ModelGroup]
    var defaultPrimaryGroupId: String?
    var defaultSubGroupId: String?
    /// Stores per-session model bindings keyed by sessionId.
    var sessionBindings: [String: SessionModelBinding]
    /// ModelEntry IDs for individual models available in agent loop (minis-model-use).
    var agentLoopModelEntryIds: [String]
    /// ModelGroup IDs whose members are available in agent loop (minis-model-use).
    var agentLoopGroupIds: [String]
    /// Model group used for voice INPUT (speech-to-text), parallel to the
    /// Default Primary/Sub group selectors. Per-device (local-only, not synced).
    /// nil = offline System voice. The resolver picks the first audio-capable
    /// member of this group, else falls back to System.
    var voiceInputGroupId: String?
    /// Model group used for voice OUTPUT (text-to-speech). Same semantics.
    var voiceOutputGroupId: String?
    /// Per-session inference settings (thinking toggle, etc.).
    var sessionInferenceConfigs: [String: SessionInferenceConfig]
    /// Soft-delete tombstones. Required to make deletes survive
    /// `mergeProviderConfig`'s union-by-id merge — without them a peer's
    /// older snapshot of the same id resurrects an instance/group/entry
    /// the user already deleted on this device.
    var deletedInstances: [ProviderConfigTombstone]
    var deletedModelEntries: [ProviderConfigTombstone]
    var deletedModelGroups: [ProviderConfigTombstone]

    init(instances: [ProviderInstance], modelEntries: [ModelEntry], modelGroups: [ModelGroup],
         defaultPrimaryGroupId: String?, defaultSubGroupId: String?,
         sessionBindings: [String: SessionModelBinding],
         agentLoopModelEntryIds: [String] = [], agentLoopGroupIds: [String] = [],
         voiceInputGroupId: String? = nil, voiceOutputGroupId: String? = nil,
         sessionInferenceConfigs: [String: SessionInferenceConfig] = [:],
         deletedInstances: [ProviderConfigTombstone] = [],
         deletedModelEntries: [ProviderConfigTombstone] = [],
         deletedModelGroups: [ProviderConfigTombstone] = []) {
        self.instances = instances
        self.modelEntries = modelEntries
        self.modelGroups = modelGroups
        self.defaultPrimaryGroupId = defaultPrimaryGroupId
        self.defaultSubGroupId = defaultSubGroupId
        self.sessionBindings = sessionBindings
        self.agentLoopModelEntryIds = agentLoopModelEntryIds
        self.agentLoopGroupIds = agentLoopGroupIds
        self.voiceInputGroupId = voiceInputGroupId
        self.voiceOutputGroupId = voiceOutputGroupId
        self.sessionInferenceConfigs = sessionInferenceConfigs
        self.deletedInstances = deletedInstances
        self.deletedModelEntries = deletedModelEntries
        self.deletedModelGroups = deletedModelGroups
    }

    // Backwards-compatible decode: newer fields may be absent in old data.
    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        instances = try container.decode([ProviderInstance].self, forKey: .instances)
        modelEntries = try container.decode([ModelEntry].self, forKey: .modelEntries)
        if let groups = try? container.decode([ModelGroup].self, forKey: .modelGroups) {
            modelGroups = groups
        } else {
            modelGroups = Self.decodeModelGroupsLeniently(container: container, key: .modelGroups)
        }
        defaultPrimaryGroupId = try container.decodeIfPresent(String.self, forKey: .defaultPrimaryGroupId)
        defaultSubGroupId = try container.decodeIfPresent(String.self, forKey: .defaultSubGroupId)
        sessionBindings = try container.decode([String: SessionModelBinding].self, forKey: .sessionBindings)
        agentLoopModelEntryIds = try container.decodeIfPresent([String].self, forKey: .agentLoopModelEntryIds) ?? []
        agentLoopGroupIds = try container.decodeIfPresent([String].self, forKey: .agentLoopGroupIds) ?? []
        voiceInputGroupId = try container.decodeIfPresent(String.self, forKey: .voiceInputGroupId)
        voiceOutputGroupId = try container.decodeIfPresent(String.self, forKey: .voiceOutputGroupId)
        sessionInferenceConfigs = try container.decodeIfPresent([String: SessionInferenceConfig].self, forKey: .sessionInferenceConfigs) ?? [:]
        deletedInstances = try container.decodeIfPresent([ProviderConfigTombstone].self, forKey: .deletedInstances) ?? []
        deletedModelEntries = try container.decodeIfPresent([ProviderConfigTombstone].self, forKey: .deletedModelEntries) ?? []
        deletedModelGroups = try container.decodeIfPresent([ProviderConfigTombstone].self, forKey: .deletedModelGroups) ?? []
    }

    private enum CodingKeys: String, CodingKey {
        case instances, modelEntries, modelGroups, defaultPrimaryGroupId, defaultSubGroupId
        case sessionBindings, agentLoopModelEntryIds, agentLoopGroupIds, sessionInferenceConfigs
        case voiceInputGroupId, voiceOutputGroupId
        case deletedInstances, deletedModelEntries, deletedModelGroups
    }

    private static func decodeModelGroupsLeniently(
        container: KeyedDecodingContainer<CodingKeys>, key: CodingKeys
    ) -> [ModelGroup] {
        struct Failable<T: Decodable>: Decodable {
            let value: T?
            init(from decoder: Decoder) throws {
                value = try? T(from: decoder)
            }
        }
        guard let wrappers = try? container.decode([Failable<ModelGroup>].self, forKey: key) else {
            return []
        }
        return wrappers.compactMap(\.value)
    }

    static let empty = ProviderConfig(
        instances: [],
        modelEntries: [],
        modelGroups: [],
        defaultPrimaryGroupId: nil,
        defaultSubGroupId: nil,
        sessionBindings: [:],
        agentLoopModelEntryIds: [],
        agentLoopGroupIds: []
    )
}

// MARK: - ProviderConfigStore

/// Single source of truth for provider instances, model entries, groups, and bindings.
/// Replaces scattered APIKeyStore, ActiveProviderStore, LastModelStore, AgentModelSettingsStore.
@MainActor
final class ProviderConfigStore: ObservableObject {
    static let shared = ProviderConfigStore()

    @Published private(set) var config: ProviderConfig

    /// Bumped whenever an OAuth token or string is saved/deleted in the Keychain,
    /// so views observing the store re-evaluate auth state. Also an L1 cache key
    /// component (T-new-session-hang-credential-cache): any credential change
    /// invalidates cached resolveCurrentEntry results.
    @Published var authRevision: UInt = 0

    /// Bumped in `save()` — i.e. on ANY provider/group/member add/update/remove.
    /// An L1 cache key component: any config mutation invalidates cached
    /// resolveCurrentEntry results. [T-new-session-hang-credential-cache]
    private(set) var configRevision: UInt = 0

    private let fileURL: URL

    /// v3 SQLite store. Populated on first launch from `provider-config.json`
    /// (migration); then becomes the source of truth for sync record
    /// emission and inbound merge. The JSON file is kept as a downgrade
    /// safety mirror — every mutate rewrites both.
    /// Held as Optional so init can short-circuit if DB open fails (rare,
    /// but we'd rather degrade to JSON-only than crash).
    private(set) var db: ProviderConfigDB?

    /// Snapshot of the config the last time `save()` ran, used to diff
    /// against the current `config` for per-record v3 markDirty emission.
    /// `nil` until the first save() runs after init.
    private var lastSavedSnapshot: ProviderConfig?

    /// [T-provider-entry-composite-key] legacyUuid → compositeKey map.
    /// Populated by migration (every old entry's uuid → its composite key) and
    /// by inbound sync (a peer's entry record's uuid / legacyUuid → composite
    /// key, computed from the record's instanceId+modelId). `entry(for:)` uses
    /// it to resolve a still-uuid reference; `normalizeReferences(using:)`
    /// rewrites group/binding/agent-loop references that match a known
    /// legacyUuid to the composite key. Persisted in provider_local_kv so it
    /// survives restarts and deferred (out-of-order) record arrival.
    private(set) var legacyUuidToCompositeKey: [String: String] = [:]

    /// True while the one-shot composite-key migration is running. Resolve /
    /// save use the pre-migration snapshot during this window; the migrated
    /// config is swapped in atomically when it flips back to false. Prevents a
    /// half-migrated state from being read or pushed.
    private(set) var compositeKeyMigrationInFlight = false

    /// File existed but JSON decode failed. `save()` must not overwrite the
    /// on-disk file with an empty config.
    private var jsonLoadFailed = false
    /// The first-frame JSON may be older than the authoritative SQLite store.
    /// Reject edits until bootstrap has selected the durable source of truth.
    private var persistenceReady = false
    private let databaseWrites = ModelCatalogWriteQueue()

    private var modelArchiveURL: URL { fileURL.appendingPathExtension("model-archive") }

    private func loadModelArchiveAliases() {
        do {
            let entries = try ModelCatalogArchive.load(at: modelArchiveURL)
            for (alias, id) in ModelCatalog.aliases(entries: entries) where alias != id {
                legacyUuidToCompositeKey[alias] = id
            }
        } catch {
            logger.error("Model metadata archive unreadable; preserved without modification: \(error)")
        }
    }

    private func recoverPendingDatabaseSnapshot(_ db: ProviderConfigDB) async -> Bool {
        guard let token = ProviderSnapshotJournal.pendingToken(for: fileURL), !jsonLoadFailed else { return true }
        let snapshot = config
        var aliases = legacyUuidToCompositeKey
        if let json = await db.localKV("legacyUuidMap"), let data = json.data(using: .utf8),
           let stored = try? JSONDecoder().decode([String: String].self, from: data) {
            aliases = stored.merging(aliases) { _, local in local }
        }
        guard await db.bulkReplace(from: snapshot) else {
            logger.error("Provider DB recovery failed; keeping durable JSON and retry journal")
            return false
        }
        let aliasJSON = (try? JSONEncoder().encode(aliases)).flatMap { String(data: $0, encoding: .utf8) } ?? "{}"
        guard await db.setLegacyUuidMapKV(aliasJSON) else { return false }
        legacyUuidToCompositeKey.merge(aliases) { local, _ in local }
        // Recovery has no trustworthy dispatched baseline. Replay current rows
        // AND explicit tombstones; never infer deletions from missing rows.
        await Self.emitV3MarkDirty(prior: nil, current: snapshot)
        ProviderSnapshotJournal.complete(token, for: fileURL)
        return true
    }

    init() {
        let libraryURL = FileManager.default.urls(for: .libraryDirectory, in: .userDomainMask).first!
        let baseURL = libraryURL.appendingPathComponent("MinisChat", isDirectory: true)
        try? FileManager.default.createDirectory(at: baseURL, withIntermediateDirectories: true)
        self.fileURL = baseURL.appendingPathComponent("provider-config.json")
        // First-frame value comes from the V2 JSON so the UI has something to
        // render before the SQLite DB finishes opening. Once the DB is ready
        // and V3 is the authoritative store (migration done), we overwrite
        // `config` from `dumpProviderConfig()` — the V3 path that preserves
        // group members verbatim — so the JSON's (potentially member-truncated
        // from an older build) snapshot never becomes the persisted/pushed
        // source of truth. [T-icloud-modelgroup-member-loss]
        let loaded = Self.load(from: fileURL)
        self.config = loaded.config
        self.jsonLoadFailed = loaded.failed
        self.lastSavedSnapshot = self.config
        loadModelArchiveAliases()
        Self.setupDBAndMigrate(jsonURL: fileURL) { [weak self] db in
            Task { @MainActor in
                guard let self else { return }
                self.db = db
                guard let db else {
                    self.persistenceReady = true
                    self.ensureVoiceTemplateModels()
                    return
                }
                let bootstrapRevision = self.configRevision
                guard await self.recoverPendingDatabaseSnapshot(db) else { return }
                // [T-provider-entry-composite-key] Load the persisted
                // legacyUuid→compositeKey map (normalization runs AFTER the
                // authoritative config is loaded below, so it operates on the
                // real config, not the JSON seed).
                await self.loadLegacyUuidMap()
                // V3 authoritative-load: replace the JSON-seeded config with
                // the DB dump when V3 is enabled. dumpProviderConfig() never
                // truncates group memberEntryIds.
                //
                // [T-icloud-fresh-restore-provider-groups] Previously this also
                // required the `migrationCompleted` flag — but that flag is ONLY
                // set when a local `provider-config.json` was migrated at first
                // launch. A fresh device restored from iCloud has no JSON, so the
                // flag stayed false forever, and providers/model-groups that
                // arrived via inbound sync (written into the V3 DB) were never
                // loaded authoritatively — they vanished on every relaunch even
                // though the rows were in the DB. Treat the DB as authoritative
                // whenever V3 is on AND the DB is non-empty (or migration ran),
                // and stamp the flag so the rest of the store stays consistent.
                let migratedFlag = UserDefaults.standard.bool(forKey: "cloudSync.providerV3.migrationCompleted")
                let dbNonEmpty = !(await db.isEmpty())
                guard ProviderV3Bootstrap.isEnabled, (migratedFlag || dbNonEmpty) else {
                    self.persistenceReady = true
                    self.ensureVoiceTemplateModels()
                    logger.info("[GroupLoad] init: staying on V2 JSON config (v3Enabled=\(ProviderV3Bootstrap.isEnabled) migrated=\(migratedFlag) dbNonEmpty=\(dbNonEmpty))")
                    return
                }
                if !migratedFlag && dbNonEmpty {
                    UserDefaults.standard.set(true, forKey: "cloudSync.providerV3.migrationCompleted")
                    logger.info("[GroupLoad] init: V3 DB is authoritative via inbound sync (no local JSON migration) — stamping migrationCompleted")
                }
                await self.databaseWrites.drain()
                let fresh = await db.dumpProviderConfig()
                guard self.configRevision == bootstrapRevision else {
                    logger.info("Provider config edited during database bootstrap; keeping newer accepted snapshot")
                    return
                }
                let jsonGroupMembers = self.config.modelGroups.reduce(0) { $0 + $1.memberEntryIds.count }
                let dbGroupMembers = fresh.modelGroups.reduce(0) { $0 + $1.memberEntryIds.count }
                // [T-icloud-provider-sync-consistency] Heal any cross-device
                // duplicate entries already on disk at load time (e.g. a DB
                // that accumulated dup rows before this fix shipped). The fold
                // is deterministic so it converges with peers; pruned rows are
                // deleted + tombstoned so they don't resurrect.
                let (deduped, prunedAtLoad) = Self.dedupeEntriesByModel(fresh)
                self.config = deduped
                self.lastSavedSnapshot = deduped
                // JSON may have been corrupt; the DB is now authoritative, so
                // later edits must be allowed to persist (and rewrite JSON).
                self.jsonLoadFailed = false
                self.persistenceReady = true
                // [T-provider-entry-composite-key] Build the legacyUuid map from
                // the local entries (each entry's random uuid → its composite
                // key), then normalize any group/binding/agent-loop reference
                // still pointing at a uuid to the composite key. This is what
                // heals group memberEntryIds that were written as uuids before
                // the entry id became a composite key. Detailed logging so the
                // migration/normalization is auditable in the field.
                var localPairs: [String: String] = [:]
                for e in fresh.modelEntries where e.uuid != e.compositeKey {
                    localPairs[e.uuid] = e.compositeKey
                }
                let danglingBefore = deduped.modelGroups.reduce(0) { acc, g in
                    acc + g.memberEntryIds.filter { ref in !deduped.modelEntries.contains { $0.id == ref || $0.uuid == ref } }.count
                }
                logger.info("[CompositeKeyMigrate] init: entries=\(deduped.modelEntries.count) localUuid→ckPairs=\(localPairs.count) danglingGroupRefs(before)=\(danglingBefore) lmapSize(persisted)=\(self.legacyUuidToCompositeKey.count)")
                let learnedAliases = localPairs.contains { self.legacyUuidToCompositeKey[$0.key] != $0.value }
                for (u, ck) in localPairs where self.legacyUuidToCompositeKey[u] != ck {
                    self.legacyUuidToCompositeKey[u] = ck
                }
                if self.normalizeReferences() || learnedAliases {
                    self.lastSavedSnapshot = self.config
                    self.save()
                    let danglingAfter = self.config.modelGroups.reduce(0) { acc, g in
                        acc + g.memberEntryIds.filter { ref in !self.config.modelEntries.contains { $0.id == ref || $0.uuid == ref } }.count
                    }
                    logger.info("[CompositeKeyMigrate] init: normalizeReferences rewrote refs → danglingGroupRefs(after)=\(danglingAfter); persisted+saved")
                } else {
                    logger.info("[CompositeKeyMigrate] init: normalizeReferences no-op (no uuid refs matched lmap; \(danglingBefore) dangling refs need a cloud entry record to normalize)")
                }
                logger.info("[GroupLoad] init: loaded authoritative config from V3 DB — groups=\(deduped.modelGroups.count) entries=\(deduped.modelEntries.count) groupMembers(json=\(jsonGroupMembers)→db=\(dbGroupMembers)) prunedDuplicates=\(prunedAtLoad.count)")
                self.ensureVoiceTemplateModels()
                self.objectWillChange.send()
                if !prunedAtLoad.isEmpty {
                    let snapshot = self.config
                    let toDelete = prunedAtLoad
                    self.databaseWrites.enqueue {
                        guard await db.bulkReplace(from: snapshot) else { return }
                        for eid in toDelete {
                            guard await db.deleteEntryRow(id: eid) else { continue }
                            await ChatStore.shared.markDirty(recordType: "ProviderModelEntryV3", recordId: eid, operation: "delete")
                        }
                    }
                }
            }
        }

        // [T-new-session-hang-credential-cache] L2 invalidation hook #3: iCloud
        // Keychain sync. A `-25300` (item-not-synced) miss cached as `false` on
        // THIS device must be dropped once the sibling device's credential syncs
        // in, or routing would keep skipping a now-credentialed provider until
        // the 15s TTL. The sync event carries no instanceId, so clear all.
        CFNotificationCenterAddObserver(
            CFNotificationCenterGetDarwinNotifyCenter(),
            Unmanaged.passUnretained(self).toOpaque(),
            { _, _, _, _, _ in
                ProviderCredentialCache.shared.invalidateAll()
            },
            "com.apple.security.view-change" as CFString,
            nil,
            .deliverImmediately
        )
    }

    /// Test-only initializer.
    init(fileURL: URL) {
        self.fileURL = fileURL
        let loaded = Self.load(from: fileURL)
        self.config = loaded.config
        self.jsonLoadFailed = loaded.failed
        self.lastSavedSnapshot = self.config
        self.persistenceReady = true
        loadModelArchiveAliases()
        // Tests don't open the DB by default.
    }

    /// Async DB open + one-shot migration from provider-config.json.
    /// Runs off the main thread so a slow open doesn't block UI launch.
    private static func setupDBAndMigrate(jsonURL: URL, completion: @escaping (ProviderConfigDB?) -> Void) {
        Task.detached {
            do {
                let db = try ProviderConfigDB()
                // Migration: if DB is empty (fresh install or first v3
                // launch) and JSON exists, ingest the JSON. The
                // UserDefaults flag prevents re-running migration even
                // if the DB is later emptied (rare; usually a sync
                // bulk-replace would re-populate it).
                let migratedKey = "cloudSync.providerV3.migrationCompleted"
                let alreadyMigrated = UserDefaults.standard.bool(forKey: migratedKey)
                if await db.isEmpty(), !alreadyMigrated,
                   FileManager.default.fileExists(atPath: jsonURL.path) {
                    let ok = await db.migrateFromLegacyJSON(at: jsonURL)
                    if ok {
                        UserDefaults.standard.set(true, forKey: migratedKey)
                        logger.info("[v3] ProviderConfig migration to SQLite complete")
                    }
                }
                completion(db)
            } catch {
                logger.error("[v3] ProviderConfigDB open failed: \(error) — staying on JSON-only mode")
                completion(nil)
            }
        }
    }

    // MARK: - Persistence

    private static func load(from url: URL) -> (config: ProviderConfig, failed: Bool) {
        if !FileManager.default.fileExists(atPath: url.path) {
            return (.empty, false)
        }
        guard let data = try? Data(contentsOf: url),
              var config = try? JSONDecoder().decode(ProviderConfig.self, from: data) else {
            logger.error("[B6] provider-config.json exists but decode failed — refusing to treat as empty")
            return (.empty, true)
        }
        // Catalog absence is not deletion. Preserve empty custom groups, unresolved
        // members and explicit defaults through cold starts and partial sync. Only
        // normalize aliases whose entry is actually known; routing validates later.
        let aliases = ModelCatalog.aliases(entries: config.modelEntries)
        config.modelGroups = config.modelGroups.map {
            ModelCatalog.normalizedGroup($0, aliases: aliases)
        }
        // Infer output modalities from model names for entries that don't have modalityOverride yet.
        for i in config.modelEntries.indices {
            let entry = config.modelEntries[i]
            let base = entry.baseModel
            if base.modalityOverride == nil {
                let inferred = base.withInferredModality()
                if inferred.modalityOverride != nil {
                    config.modelEntries[i] = entry.replacingBaseModel(inferred)
                }
            }
        }
        return (config, false)
    }

    @discardableResult
    private func save() -> Bool {
        guard persistenceReady else {
            if let prior = lastSavedSnapshot { config = prior }
            logger.warning("Provider config is still loading; edit rejected without changing durable data")
            return false
        }
        guard !jsonLoadFailed else {
            if let prior = lastSavedSnapshot { config = prior }
            logger.error("[B6] skip save — last JSON load failed; preserving original config file")
            return false
        }
        let token: String
        do {
            token = try ProviderSnapshotJournal.write(JSONEncoder().encode(config), to: fileURL)
        } catch {
            if let prior = lastSavedSnapshot { config = prior }
            logger.error("Failed to save provider config; in-memory edit rolled back: \(error)")
            return false
        }
        configRevision &+= 1
        let snapshot = config
        lastSavedSnapshot = snapshot
        let aliases = legacyUuidToCompositeKey
        let url = fileURL
        if let db {
            databaseWrites.enqueue {
                let prior = await db.dumpProviderConfig()
                guard await db.bulkReplace(from: snapshot) else {
                    logger.error("Provider DB snapshot rejected; durable JSON and recovery journal retained")
                    return
                }
                let aliasJSON = (try? JSONEncoder().encode(aliases)).flatMap { String(data: $0, encoding: .utf8) } ?? "{}"
                guard await db.setLegacyUuidMapKV(aliasJSON) else { return }
                // Dispatch completes before clearing crash-replay intent. The
                // existing ChatStore API has no durable outbox acknowledgement.
                await Self.emitV3MarkDirty(prior: prior, current: snapshot)
                ProviderSnapshotJournal.complete(token, for: url)
            }
        }
        // The V2 mirror is already durable; V3 dirty work is queued only after
        // its database transaction commits successfully.
        Task { await ChatStore.shared.markDirty(recordType: "ProviderConfig", recordId: "provider-config") }
        return true
    }

    /// Diff `prior` vs `current` and emit per-record V3 markDirty calls
    /// for what changed. Insertions and updates both go as op="upsert";
    /// removals go as op="delete" so CloudKit propagates a real
    /// deletion tombstone (the v3 fix for "deleted provider resurrects").
    private static func emitV3MarkDirty(
        prior: ProviderConfig?,
        current: ProviderConfig
    ) async {
        // Explicit deletion intent must survive a failed mirror followed by a
        // successful later save, and a crash before dirty dispatch. Replay is
        // idempotent in ChatStore; active re-added identities take precedence.
        let currentInstanceIds = Set(current.instances.map(\.id))
        let currentEntryIds = Set(current.modelEntries.flatMap { [$0.id, $0.uuid] })
        let currentGroupIds = Set(current.modelGroups.map(\.id))
        for deleted in current.deletedInstances where !currentInstanceIds.contains(deleted.id) {
            await ChatStore.shared.markDirty(recordType: "ProviderInstanceV3", recordId: deleted.id, operation: "delete")
        }
        for deleted in current.deletedModelEntries where !currentEntryIds.contains(deleted.id) {
            await ChatStore.shared.markDirty(recordType: "ProviderModelEntryV3", recordId: deleted.id, operation: "delete")
        }
        for deleted in current.deletedModelGroups where !currentGroupIds.contains(deleted.id) {
            await ChatStore.shared.markDirty(recordType: "ProviderModelGroupV3", recordId: deleted.id, operation: "delete")
        }
        // Without a prior snapshot, treat everything as an upsert. This
        // happens on first save() after a fresh launch when the
        // lastSavedSnapshot is the initial JSON-loaded state — we
        // still want all of it in the dirty queue so the v3 sync
        // engine's first batch carries the full picture to cloud.
        guard let prior else {
            for inst in current.instances {
                await ChatStore.shared.markDirty(recordType: "ProviderInstanceV3", recordId: inst.id, operation: "upsert")
            }
            for entry in current.modelEntries {
                // Plan-X: V3 entry record is keyed by uuid (= DB primary key).
                await ChatStore.shared.markDirty(recordType: "ProviderModelEntryV3", recordId: entry.uuid, operation: "upsert")
            }
            for group in current.modelGroups {
                await ChatStore.shared.markDirty(recordType: "ProviderModelGroupV3", recordId: group.id, operation: "upsert")
            }
            return
        }

        // Instances
        let priorInst = Self.dictByIdLastWins(prior.instances.map { ($0.id, $0) })
        let curInst = Self.dictByIdLastWins(current.instances.map { ($0.id, $0) })
        for (id, inst) in curInst {
            if priorInst[id] != inst {
                await ChatStore.shared.markDirty(recordType: "ProviderInstanceV3", recordId: id, operation: "upsert")
            }
        }
        // [T-ios-provider-reorder] A pure reorder changes no instance STRUCT
        // (order is positional in config.instances), so the per-record diff
        // above emits nothing — the new sort_order values written by
        // bulkReplace never uploaded and peers pulled devices back to the old
        // order. Detect an order change explicitly and mark every instance
        // dirty so records carry the fresh sortOrder (+ updated_at bumped by
        // bulkReplace, so LWW protects the new order against stale echoes).
        if prior.instances.map(\.id) != current.instances.map(\.id) {
            for inst in current.instances {
                await ChatStore.shared.markDirty(recordType: "ProviderInstanceV3", recordId: inst.id, operation: "upsert")
            }
        }
        // [T-icloud-provider-sync-consistency] Do NOT diff-infer instance
        // deletions — same reasoning as entries/groups below. A "prior had it,
        // current doesn't" gap is also produced when dumpProviderConfig drops
        // an instance it couldn't parse (e.g. a providerType from a newer build)
        // or when the in-memory config is transiently incomplete; inferring a
        // delete from that wipes the instance on every device. removeInstance
        // emits its own explicit ProviderInstanceV3 delete record.
        for id in priorInst.keys where curInst[id] == nil {
            logger.info("[v3] emitV3MarkDirty: instance \(id.prefix(8)) absent in current snapshot — NOT auto-deleting (explicit removal emits its own tombstone)")
        }

        // Model entries — Plan-X: key the diff + V3 record by uuid (DB primary
        // key), not the composite key, so markDirty targets the right record.
        let priorEntries = Self.dictByIdLastWins(prior.modelEntries.map { ($0.uuid, $0) })
        let curEntries = Self.dictByIdLastWins(current.modelEntries.map { ($0.uuid, $0) })
        for (uuid, entry) in curEntries {
            if priorEntries[uuid] != entry {
                await ChatStore.shared.markDirty(recordType: "ProviderModelEntryV3", recordId: uuid, operation: "upsert")
            }
        }
        // [T-icloud-provider-sync-consistency] Do NOT diff-infer entry/group
        // deletions here. A "prior had it, current doesn't" gap is NOT proof of
        // a user deletion — it also happens when the in-memory config is
        // transiently incomplete (a peer's entry record hasn't merged in yet, a
        // refresh is mid-flight, a reload raced). Diff-inferred deletes were the
        // amplifier that propagated member/entry loss to every device. Real
        // deletions are emitted explicitly by removeEntry/removeGroup/
        // removeInstance via markDirtyDelete(...) at the moment the user acts.
        for id in priorEntries.keys where curEntries[id] == nil {
            logger.info("[v3] emitV3MarkDirty: entry \(id.prefix(8)) absent in current snapshot — NOT auto-deleting (explicit removal emits its own tombstone)")
        }

        // Groups
        let priorGroups = Self.dictByIdLastWins(prior.modelGroups.map { ($0.id, $0) })
        let curGroups = Self.dictByIdLastWins(current.modelGroups.map { ($0.id, $0) })
        for (id, group) in curGroups {
            if priorGroups[id] != group {
                await ChatStore.shared.markDirty(recordType: "ProviderModelGroupV3", recordId: id, operation: "upsert")
            }
        }
        for id in priorGroups.keys where curGroups[id] == nil {
            logger.info("[v3] emitV3MarkDirty: group \(id.prefix(8)) absent in current snapshot — NOT auto-deleting (explicit removal emits its own tombstone)")
        }
    }

    /// Build `[String: T]` from a sequence of `(id, value)` pairs where
    /// later occurrences win on duplicates. Safe replacement for
    /// `Dictionary(uniqueKeysWithValues:)` — that initializer traps on
    /// duplicate keys (Swift stdlib precondition), which has crashed
    /// the app when sync-merge paths or external Share Extension flows
    /// produce arrays containing the same provider/entry/group id more
    /// than once.
    private static func dictByIdLastWins<T>(_ pairs: [(String, T)]) -> [String: T] {
        var out: [String: T] = [:]
        out.reserveCapacity(pairs.count)
        for (k, v) in pairs { out[k] = v }
        return out
    }

    /// Reload config from disk (e.g. after iCloud sync overwrites the file).
    ///
    /// [T-icloud-modelgroup-member-loss] When V3 is the authoritative store,
    /// reload from the SQLite DB (dumpProviderConfig — preserves group members
    /// verbatim) instead of the V2 JSON. The legacy whole-file V2 sync path
    /// (CloudSyncEngine) calls this after merging; routing it through the
    /// member-truncating `load(from:)` is exactly what propagated group-member
    /// deletions. The JSON branch remains for pre-migration / kill-switched
    /// devices.
    func reloadFromDisk() async {
        await databaseWrites.drain()
        if db != nil, ProviderSnapshotJournal.pendingToken(for: fileURL) != nil {
            logger.warning("Keeping durable JSON while a provider DB mirror remains pending")
            return
        }
        // [T-icloud-fresh-restore-provider-groups] Mirror the init gate: the V3
        // DB is authoritative when V3 is on AND (migration ran OR the DB is
        // non-empty). On a fresh iCloud-restore device the migrationCompleted
        // flag is never set (no local JSON to migrate), so without the
        // dbNonEmpty clause a reload here would fall back to the truncating
        // V2 JSON path and drop inbound-synced group members.
        let migratedFlag = UserDefaults.standard.bool(forKey: "cloudSync.providerV3.migrationCompleted")
        var dbAuthoritative = false
        if let db, ProviderV3Bootstrap.isEnabled {
            if migratedFlag {
                dbAuthoritative = true
            } else {
                dbAuthoritative = !(await db.isEmpty())
            }
        }
        if let db, dbAuthoritative {
            let revision = configRevision
            let priorMembers = config.modelGroups.reduce(0) { $0 + $1.memberEntryIds.count }
            let fresh = await db.dumpProviderConfig()
            guard configRevision == revision else { return }
            let freshMembers = fresh.modelGroups.reduce(0) { $0 + $1.memberEntryIds.count }
            config = fresh
            lastSavedSnapshot = fresh
            jsonLoadFailed = false
            logger.info("[GroupLoad] reloadFromDisk: V3 DB dump — groups=\(fresh.modelGroups.count) groupMembers(\(priorMembers)→\(freshMembers))")
            objectWillChange.send()
            return
        }
        logger.info("[GroupLoad] reloadFromDisk: V2 JSON path (no DB / v3 disabled / not migrated)")
        let loaded = Self.load(from: fileURL)
        config = loaded.config
        jsonLoadFailed = loaded.failed
        objectWillChange.send()
    }

    // MARK: - Tombstones

    /// Append (or refresh `deletedAt` on) tombstones for the given ids.
    /// `mergeProviderConfig` reads these to suppress resurrection from a
    /// peer's older snapshot.
    static func recordTombstone(in list: inout [ProviderConfigTombstone], ids: [String]) {
        guard !ids.isEmpty else { return }
        let now = Date()
        var byId = Self.dictByIdLastWins(list.map { ($0.id, $0) })
        for id in ids {
            byId[id] = ProviderConfigTombstone(id: id, deletedAt: now)
        }
        list = Array(byId.values)
    }

    // MARK: - Provider Instances

    var instances: [ProviderInstance] { config.instances }

    func addInstance(_ instance: ProviderInstance) {
        config.instances.append(instance)
        if instance.credentialType == .oauth {
            // OAuth instances: pre-populate with static built-in list, enriched with models.dev data.
            let builtIn: [LLMModel]
            let hasManualToken = ProviderKeychainHelper.loadOAuthString(instanceId: instance.id, account: "manual-oauth-token") != nil
            if instance.providerType == .openAI {
                builtIn = ModelsDevAPI.enrichModels(LLMModel.allOpenAICodexOAuth)
            } else if instance.providerType == .openRouter {
                builtIn = ModelsDevAPI.enrichModels(instance.providerType.builtInModels)
            } else {
                builtIn = ModelsDevAPI.enrichModels(instance.providerType.builtInModels)
            }
            let entries = builtIn.map { model in
                ModelEntry(providerInstanceId: instance.id, model: model)
            }
            config.modelEntries.append(contentsOf: entries)
            logger.info("[ModelList] addInstance (OAuth): instance=\(instance.label) seeded \(entries.count) built-in entries: [\(entries.map { $0.baseModel.id }.prefix(10).joined(separator: ","))]")
            // Manual OAuth tokens and OpenRouter OAuth can fetch models from the API
            if hasManualToken || instance.providerType == .openRouter {
                Task { await refreshModels(for: instance) }
            }
        } else if !VoiceProviderTemplate.mockEntries(for: instance).isEmpty {
            let mock = VoiceProviderTemplate.mockEntries(for: instance)
            config.modelEntries.append(contentsOf: mock)
            logger.info("[ModelList] addInstance (voice): instance=\(instance.label) seeded \(mock.count) mock voice entries: [\(mock.map { $0.baseModel.id }.joined(separator: ","))]")
            // Dual-purpose providers (MiMo, DashScope) also serve text models
            // via /v1/models. Fetch them now; replaceEntries preserves the
            // voice seeds above (T-mimo-shadow-voice guard).
            if instance.credentialType == .apiKey {
                Task { await refreshModels(for: instance) }
            }
        } else {
            Task { await refreshModels(for: instance) }
        }
        save()
    }

    /// Sync voice-template instances' model entries with the current template.
    /// Adds new entries introduced in template updates and removes stale ones
    /// that no longer exist in the template (e.g. the old generic "seed-tts-2.0"
    /// Doubao entry replaced by per-speaker entries in 502a0854).
    func ensureVoiceTemplateModels() {
        var changed = false
        for instance in config.instances {
            guard let tpl = VoiceProviderTemplate.template(forBaseURL: instance.effectiveCustomBaseURL) else { continue }
            let templateById = Dictionary(tpl.mockModels.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
            let templateIds = Set(templateById.keys)
            let existingIds = Set(config.modelEntries
                .filter { $0.providerInstanceId == instance.id }
                .map { $0.baseModel.id })

            // Only remove stale VOICE-TEMPLATE SEEDS not in the current template
            // (seeds a previous template version added, e.g. Doubao's retired
            // seed-tts-2.0). Never remove API-fetched models — dual-purpose
            // vendors serve both template voice seeds and API models (from
            // /v1/models) on one host, and the API models must survive launch.
            //
            // This guard distinguishes "template seed" from "API model" by
            // modality SHAPE. Two prior attempts widened the shape too far:
            //   - 9485394c scoped removal to "has .audioInput OR .audioOutput",
            //     assuming API models never carry an audio modality. False for
            //     MiMo, whose /v1/models returns audio-capable models.
            //   - [T-mimo-launch-model-count-shrink] tightened to "audio AND NOT
            //     .textInput", which spared API TTS ([.textInput,.audioOutput])
            //     and chat-with-audio (has .textInput) — but NOT a future
            //     API-fetched dedicated ASR model, which is [.audioInput,
            //     .textOutput] (no .textInput) and would still be wrongly wiped
            //     every launch once a vendor exposes one via /v1/models.
            //
            // Robust discriminator [T-voice-seed-shape-exact]: every template
            // mockModel seed is authored as EXACTLY ONE modality flag —
            // .audioOutput alone (TTS voices) or .audioInput alone (ASR). No
            // API-derived model is ever a single audio flag: OpenAIModelsAPI /
            // inferDedicatedVoiceModality always attach the paired text side
            // (TTS → [.textInput,.audioOutput], ASR → [.audioInput,.textOutput],
            // chat → text ∪ …), i.e. ≥2 flags. So only remove entries whose
            // modality is EXACTLY .audioOutput or EXACTLY .audioInput — this
            // still cleans up any retired single-flag template seed while
            // sparing every API model regardless of its ASR/TTS/omni shape.
            let seedShapes: [ModelModality] = [.audioOutput, .audioInput]
            let voiceExistingIds = Set(config.modelEntries
                .filter { $0.providerInstanceId == instance.id }
                .filter { seedShapes.contains($0.baseModel.modalityOverride ?? []) }
                .map { $0.baseModel.id })
            let toRemove = voiceExistingIds.subtracting(templateIds)
            let toAdd = templateIds.subtracting(existingIds)
            if !toRemove.isEmpty {
                config.modelEntries.removeAll { $0.providerInstanceId == instance.id && toRemove.contains($0.baseModel.id) }
                changed = true
                logger.info("[VoiceTemplateMigrate] \(instance.label): removed stale voice entries: \(toRemove.sorted())")
            }
            if !toAdd.isEmpty {
                let newEntries = tpl.mockModels
                    .filter { toAdd.contains($0.id) }
                    .map { ModelEntry(providerInstanceId: instance.id, model: $0) }
                config.modelEntries.append(contentsOf: newEntries)
                changed = true
                logger.info("[VoiceTemplateMigrate] \(instance.label): added \(newEntries.count) new entries: \(toAdd.sorted())")
            }
            // Heal corrupted modality: auto-refresh can overwrite template
            // entries with text-only modality from /v1/models. Restore the
            // template's authoritative modalityOverride for any entry whose
            // baseModel modality diverged.
            for i in config.modelEntries.indices {
                let e = config.modelEntries[i]
                guard e.providerInstanceId == instance.id,
                      let tplModel = templateById[e.baseModel.id],
                      e.baseModel.modalityOverride != tplModel.modalityOverride else { continue }
                logger.info("[VoiceTemplateMigrate] \(instance.label): healing modality for \(e.baseModel.id): \(e.baseModel.modalityOverride?.rawValue ?? -1) → \(tplModel.modalityOverride?.rawValue ?? -1)")
                config.modelEntries[i] = ModelEntry(
                    uuid: e.uuid,
                    providerInstanceId: e.providerInstanceId,
                    model: tplModel,
                    overrides: e.overrides,
                    isCustom: e.isCustom,
                    isHidden: e.isHidden,
                    userModifiedAt: e.userModifiedAt
                )
                changed = true
            }
        }
        if changed { save() }
    }

    func updateInstance(_ instance: ProviderInstance) {
        guard let idx = config.instances.firstIndex(where: { $0.id == instance.id }) else { return }
        // If the user changed the base URL or v1 suffix, the previously probed image
        // endpoint may no longer be valid (different upstream). Drop the cached
        // resolution so the next image-gen request re-probes.
        var updated = instance
        let old = config.instances[idx]
        if old.customBaseURL != updated.customBaseURL || old.appendV1Suffix != updated.appendV1Suffix {
            updated.imageEndpointResolved = nil
        }
        config.instances[idx] = updated
        save()
    }

    /// Persist the probed image-generation endpoint for an instance under `.auto` mode.
    /// Called by `ModelUseOffloadBridge` after a successful image-gen call so subsequent
    /// requests skip the probe and go straight to the working endpoint.
    func setImageEndpointResolved(instanceId: String, endpoint: ImageEndpointMode) {
        guard let idx = config.instances.firstIndex(where: { $0.id == instanceId }) else { return }
        guard config.instances[idx].imageEndpointResolved != endpoint else { return }
        config.instances[idx].imageEndpointResolved = endpoint
        save()
    }

    /// Reorder provider instances. This order drives the display order in
    /// SessionModelPicker and ProviderInstancesView. Unknown ids are dropped,
    /// and any instances missing from newOrder are appended in their existing
    /// relative order to keep state consistent.
    func reorderInstances(_ newOrder: [String]) {
        let existingById = Self.dictByIdLastWins(config.instances.map { ($0.id, $0) })
        var seen = Set<String>()
        var reordered: [ProviderInstance] = []
        for id in newOrder {
            guard !seen.contains(id), let inst = existingById[id] else { continue }
            seen.insert(id)
            reordered.append(inst)
        }
        for inst in config.instances where !seen.contains(inst.id) {
            reordered.append(inst)
        }
        config.instances = reordered
        save()
    }

    @discardableResult
    func removeInstance(_ instanceId: String) -> Bool {
        let dormant: [ModelEntry]
        do { dormant = try ModelCatalogArchive.load(at: modelArchiveURL).filter { $0.providerInstanceId == instanceId } }
        catch {
            logger.error("Cannot remove provider while its metadata archive cannot be updated: \(error)")
            return false
        }
        let removedEntries = config.modelEntries.filter { $0.providerInstanceId == instanceId } + dormant
        let removedEntryIds = Set(removedEntries.map(\.id))
        let removedAliases = Set(removedEntries.flatMap { [$0.id, $0.uuid, $0.legacyColonCompositeKey] })
        // Capture groups that go empty as a side effect of this removal so we
        // can tombstone them too — otherwise the other device's snapshot of
        // those groups would resurrect them post-merge with no members.
        let removedGroupIds = Set(config.modelGroups.filter { g in
            // group will be empty after removing the entries we're about to drop
            !g.memberEntryIds.isEmpty &&
            g.memberEntryIds.allSatisfy { removedEntryIds.contains($0) }
        }.map(\.id))
        config.instances.removeAll { $0.id == instanceId }
        // Remove associated model entries
        config.modelEntries.removeAll { $0.providerInstanceId == instanceId }
        // Remove from groups — stamp member-removal tombstones so the removal
        // survives the inbound union-merge on peers.
        let nowTs = Date()
        for i in config.modelGroups.indices {
            let hit = config.modelGroups[i].memberEntryIds.filter { removedEntryIds.contains($0) }
            guard !hit.isEmpty else { continue }
            config.modelGroups[i].memberEntryIds.removeAll { removedEntryIds.contains($0) }
            for e in hit {
                config.modelGroups[i].removedMembers[e] = nowTs
                config.modelGroups[i].addedMembers[e] = nil
            }
        }
        // [T-icloud-provider-sync-consistency] Remove ONLY the groups that
        // became empty as a direct result of THIS instance removal (computed
        // above as removedGroupIds). The old code removed EVERY empty group —
        // which also deleted a user's intentionally-empty group (newly created,
        // or temporarily cleared) and propagated that deletion via tombstone.
        config.modelGroups.removeAll { removedGroupIds.contains($0.id) }
        // A group deleted as a side effect must not stay the default: nothing
        // else repairs a dangling pointer until the next launch, and the model
        // capsule / voice correction read it meanwhile. Same rule as load-time
        // normalisation — fall back to the first remaining group.
        Self.repointDefaults(in: &config, removedGroupIds: removedGroupIds)
        // Remove from agent loop list
        config.agentLoopModelEntryIds.removeAll { removedEntryIds.contains($0) }
        // Stamp tombstones so iCloud sync can propagate the delete instead
        // of resurrecting these ids from the peer's snapshot.
        Self.recordTombstone(in: &config.deletedInstances, ids: [instanceId])
        Self.recordTombstone(in: &config.deletedModelEntries, ids: Array(removedEntryIds))
        if !removedGroupIds.isEmpty {
            Self.recordTombstone(in: &config.deletedModelGroups, ids: Array(removedGroupIds))
        }
        guard save() else { return false }
        do { try ModelCatalogArchive.remove(instanceIds: [instanceId], at: modelArchiveURL) }
        catch { logger.error("Provider deleted; dormant metadata cleanup will retry on refresh: \(error)") }
        // Clean up credentials from Keychain
        ProviderKeychainHelper.deleteAPIKey(instanceId: instanceId)
        ProviderKeychainHelper.deleteOAuthToken(instanceId: instanceId)
        ProviderKeychainHelper.forgetOAuthTokenMigration(instanceId: instanceId)
        ProviderKeychainHelper.deleteOAuthString(instanceId: instanceId, account: "oauth-email")
        ProviderKeychainHelper.deleteOAuthString(instanceId: instanceId, account: "oauth-gcp-project")
        ProviderKeychainHelper.deleteOAuthString(instanceId: instanceId, account: "manual-oauth-token")
        // Pins / recents / the compact slot live outside the config. They used
        // to outlive the provider: its pinned models kept counting toward the
        // six-pin cap while showing nowhere.
        ModelSwitcher.forget(instanceIds: [instanceId], entryIds: removedAliases, groupIds: removedGroupIds)
        AgentModelSlots.forget(entryIds: removedEntryIds)
        // [T-icloud-provider-sync-consistency] Explicit V3 delete tombstones —
        // emitV3MarkDirty no longer diff-infers deletions, so the instance, its
        // cascaded entries, and any groups emptied by the removal must each
        // emit their own delete record here.
        let entryIds = removedEntryIds
        let groupIds = removedGroupIds
        Task {
            await ChatStore.shared.markDirty(recordType: "ProviderInstanceV3", recordId: instanceId, operation: "delete")
            for eid in entryIds {
                await ChatStore.shared.markDirty(recordType: "ProviderModelEntryV3", recordId: eid, operation: "delete")
            }
            for gid in groupIds {
                await ChatStore.shared.markDirty(recordType: "ProviderModelGroupV3", recordId: gid, operation: "delete")
            }
        }
        return true
    }

    func instance(for id: String) -> ProviderInstance? {
        // The built-in System engine is a synthetic, local-only instance (never in
        // config.instances → never synced). Return it for the sentinel id and for
        // any System composite id ("<sentinel>/<voice|asr>") so the factory /
        // resolver / picker can treat it like a real provider instance.
        if id == SystemVoiceProvider.builtinProviderId
            || id.hasPrefix(SystemVoiceProvider.builtinProviderId + "/") {
            return SystemVoiceProvider.providerInstance
        }
        return config.instances.first { $0.id == id }
    }

    func enabledInstances(for providerType: ProviderType) -> [ProviderInstance] {
        config.instances.filter { $0.providerType == providerType && $0.isEnabled }
    }

    /// Export an instance as shareable JSON. Safe by default: no API keys or OAuth blobs.
    func exportInstanceJSON(_ instanceId: String, includeSecrets: Bool = false) -> String? {
        guard let instance = instance(for: instanceId) else { return nil }
        let entries = entries(for: instanceId)
        var dict: [String: Any] = [
            "providerType": instance.providerType.rawValue,
            "label": instance.label,
            "credentialType": instance.credentialType.rawValue,
            "models": entries.map { entry -> [String: Any] in
                // Export baseModel (API-reported values) for all metadata fields,
                // and user overrides in a separate "overrides" object so the importing
                // device preserves both layers and survives future API refreshes correctly.
                let base = entry.baseModel
                var m: [String: Any] = [
                    "modelId": base.id,
                    "displayName": base.displayName,
                    "isHidden": entry.isHidden,
                ]
                if entry.isCustom { m["isCustom"] = true }
                if let modality = base.modalityOverride {
                    m["modalityOverride"] = modality.rawValue
                }
                if let ctx = base.contextWindow {
                    m["contextWindow"] = ctx
                }
                if let maxOut = base.maxOutputTokens {
                    m["maxOutputTokens"] = maxOut
                }
                if let reasoning = base.supportsReasoning {
                    m["supportsReasoning"] = reasoning
                }
                if let field = base.interleavedReasoningField {
                    m["interleavedReasoningField"] = field
                }
                if !entry.overrides.isEmpty {
                    // [T-provider-export-model-overrides] Serialize the FULL
                    // ModelOverrides layer (the user's manual edits), not just
                    // displayName/maxOutputTokens. modalityOverride, contextWindow
                    // and supportsReasoning were previously dropped on export, so a
                    // hand-corrected proxied model lost those edits on round-trip.
                    // Each key is additive + optional: older builds ignore unknown
                    // keys, and import below reads each independently so a partial
                    // override object restores exactly the fields present.
                    var o: [String: Any] = [:]
                    if let dn = entry.overrides.displayName { o["displayName"] = dn }
                    if let mt = entry.overrides.maxOutputTokens { o["maxOutputTokens"] = mt }
                    if let mod = entry.overrides.modalityOverride { o["modalityOverride"] = mod.rawValue }
                    if let ctx = entry.overrides.contextWindow { o["contextWindow"] = ctx }
                    if let sr = entry.overrides.supportsReasoning { o["supportsReasoning"] = sr }
                    if let level = entry.overrides.maxThinkingLevel { o["maxThinkingLevel"] = level.rawValue }
                    m["overrides"] = o
                }
                return m
            },
        ]
        if let key = ProviderKeychainHelper.loadAPIKey(instanceId: instanceId) {
            dict["apiKey"] = Data(key.utf8).base64EncodedString()
        }
        if let manualToken = ProviderKeychainHelper.loadOAuthString(instanceId: instanceId, account: "manual-oauth-token") {
            dict["manualOAuthToken"] = Data(manualToken.utf8).base64EncodedString()
        }
        // Signed-in tokens (ChatGPT / xAI / Kimi) are never exported: they carry
        // a rotating refresh token, and a copy used on a second device would
        // race this one's refresh. The importing device signs in itself.
        // (Import still reads `oauthToken` from older exports.)
        dict["isEnabled"] = instance.isEnabled
        dict["azureMode"] = instance.azureMode
        dict["imageEndpointMode"] = instance.imageEndpointMode.rawValue
        if let resolved = instance.imageEndpointResolved { dict["imageEndpointResolved"] = resolved.rawValue }
        if let url = instance.customBaseURL {
            dict["customBaseURL"] = url
        }
        if !instance.appendV1Suffix {
            dict["appendV1Suffix"] = false
        }
        // [T-provider-custom-user-agent] Additive + optional: only emitted when set.
        // Old builds ignore the key; a new build reading an old export leaves it nil
        // (default UA). No credential exposure — UA is not secret.
        if let ua = instance.effectiveCustomUserAgent {
            dict["customUserAgent"] = ua
        }
        if !includeSecrets {
            dict = ProviderExportSecrets.stripped(dict)
            dict["secretsOmitted"] = true
        }
        guard let data = try? JSONSerialization.data(withJSONObject: dict, options: [.prettyPrinted, .sortedKeys]),
              let json = String(data: data, encoding: .utf8) else { return nil }
        return json
    }

    /// Import a provider from exported JSON. Returns the new instance label on success.
    /// - Auto-renames on label conflict (appends " (2)", " (3)", etc.)
    /// - Decodes base64-encoded API key and saves to Keychain
    /// - Also supports plain-text API key for backward compatibility
    @discardableResult
    func importInstanceJSON(_ json: String) -> String? {
        guard persistenceReady else { return nil }
        guard let data = json.data(using: .utf8),
              let dict = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let providerTypeRaw = dict["providerType"] as? String,
              let providerType = ProviderType(rawValue: providerTypeRaw),
              let label = dict["label"] as? String else {
            return nil
        }

        let credentialType: ProviderCredential
        if let raw = dict["credentialType"] as? String, let ct = ProviderCredential(rawValue: raw) {
            credentialType = ct
        } else {
            credentialType = .apiKey
        }

        // Resolve label conflict
        let existingLabels = Set(config.instances.map(\.label))
        var resolvedLabel = label
        if existingLabels.contains(resolvedLabel) {
            var suffix = 2
            while existingLabels.contains("\(label) (\(suffix))") { suffix += 1 }
            resolvedLabel = "\(label) (\(suffix))"
        }

        // Create instance
        let customBaseURL = dict["customBaseURL"] as? String
        let appendV1 = dict["appendV1Suffix"] as? Bool ?? true
        // [T-provider-custom-user-agent] Optional; absent in old exports → nil (default UA).
        let customUserAgent = dict["customUserAgent"] as? String
        let instance = ProviderInstance(
            label: resolvedLabel,
            providerType: providerType,
            credentialType: credentialType,
            isEnabled: dict["isEnabled"] as? Bool ?? true,
            customBaseURL: customBaseURL,
            appendV1Suffix: appendV1,
            imageEndpointMode: (dict["imageEndpointMode"] as? String).flatMap(ImageEndpointMode.init(rawValue:)) ?? .auto,
            imageEndpointResolved: (dict["imageEndpointResolved"] as? String).flatMap(ImageEndpointMode.init(rawValue:)),
            customUserAgent: customUserAgent,
            azureMode: dict["azureMode"] as? Bool ?? false
        )

        // Stage all metadata before one durable admission. Skip addInstance
        // and addEntry here: those would publish partial per-model snapshots.
        var importedEntries: [ModelEntry] = []

        // Import models
        if let models = dict["models"] as? [[String: Any]] {
            for m in models {
                guard let modelId = m["modelId"] as? String else { continue }
                let displayName = m["displayName"] as? String ?? modelDisplayName(from: modelId)
                let isCustom = m["isCustom"] as? Bool ?? false
                let isHidden = m["isHidden"] as? Bool ?? false
                let modalityOverride = (m["modalityOverride"] as? Int).map { ModelModality(rawValue: $0) }
                let contextWindow = m["contextWindow"] as? Int
                let maxOutputTokens = m["maxOutputTokens"] as? Int
                let supportsReasoning = m["supportsReasoning"] as? Bool
                let interleavedReasoningField = m["interleavedReasoningField"] as? String
                var model = LLMModel(
                    id: modelId, displayName: displayName, provider: providerType.displayName,
                    modalityOverride: modalityOverride,
                    contextWindow: contextWindow,
                    maxOutputTokens: maxOutputTokens,
                    supportsReasoning: supportsReasoning,
                    interleavedReasoningField: interleavedReasoningField
                )
                // Only run inference if no attributes were provided in the export
                if modalityOverride == nil && contextWindow == nil && maxOutputTokens == nil && supportsReasoning == nil {
                    model = model.withInferredModality()
                }
                // Ensure modalityOverride is never nil after import — a nil
                // falls through to knownCapabilities["OpenAI"] = .vision,
                // which includes .imageInput even for text-only models.
                // Mirrors OpenAIModelsAPI.swift line 139 (always-write).
                if model.modalityOverride == nil {
                    model = LLMModel(id: model.id, displayName: model.displayName,
                                     provider: model.provider,
                                     modalityOverride: [.textInput, .textOutput],
                                     contextWindow: model.contextWindow,
                                     maxOutputTokens: model.maxOutputTokens,
                                     supportsReasoning: model.supportsReasoning,
                                     interleavedReasoningField: model.interleavedReasoningField)
                }
                var overrides = ModelOverrides()
                if let o = m["overrides"] as? [String: Any] {
                    // [T-provider-export-model-overrides] Restore the full
                    // overrides layer. Each key is read independently with `as?`
                    // so a missing key (old export, or a partial override object)
                    // simply stays nil → the field falls back to the baseModel /
                    // inferred default. modalityOverride is an OptionSet stored as
                    // its Int rawValue (same encoding as the baseModel modality).
                    overrides.displayName = o["displayName"] as? String
                    overrides.maxOutputTokens = o["maxOutputTokens"] as? Int
                    overrides.modalityOverride = (o["modalityOverride"] as? Int).map { ModelModality(rawValue: $0) }
                    overrides.contextWindow = o["contextWindow"] as? Int
                    overrides.supportsReasoning = o["supportsReasoning"] as? Bool
                    overrides.maxThinkingLevel = (o["maxThinkingLevel"] as? String).map(ThinkingLevel.decoded)
                }
                let entry = ModelEntry(
                    providerInstanceId: instance.id,
                    model: model,
                    overrides: overrides,
                    isCustom: isCustom,
                    isHidden: isHidden
                )
                importedEntries.append(entry)
            }
        }

        guard commitImportedMetadata(instance, entries: importedEntries) else { return nil }

        // Existing credential import runs only after metadata admission.
        // Keychain writes are not part of the JSON/SQLite transaction.

        // Decode API key (base64 or plain text for backward compat)
        if let keyValue = dict["apiKey"] as? String, !keyValue.isEmpty {
            let apiKey: String
            if let decoded = Data(base64Encoded: keyValue), let str = String(data: decoded, encoding: .utf8) {
                apiKey = str
            } else {
                apiKey = keyValue // plain text fallback
            }
            ProviderKeychainHelper.saveAPIKey(apiKey, instanceId: instance.id)
        }

        // Decode manual OAuth token (base64 or plain text for backward compat)
        if let tokenValue = dict["manualOAuthToken"] as? String, !tokenValue.isEmpty {
            let token: String
            if let decoded = Data(base64Encoded: tokenValue), let str = String(data: decoded, encoding: .utf8) {
                token = str
            } else {
                token = tokenValue
            }
            ProviderKeychainHelper.saveOAuthString(token, instanceId: instance.id, account: "manual-oauth-token")
        }

        // [T-ios-provider-export-oauth-token] Restore the structured OAuth-login
        // credential. Decode base64 → JSON → the provider-specific Codable token,
        // then saveOAuthToken back to the keychain so the imported instance is
        // authenticated. saveOAuthToken already calls notifyAuthChanged()
        // (bumps authRevision), so the auth UI refreshes without extra work.
        if let oauthB64 = dict["oauthToken"] as? String, !oauthB64.isEmpty,
           let blob = Data(base64Encoded: oauthB64) {
            switch providerType {
            case .openAI:
                if let t = (try? JSONDecoder().decode(CodexTokenStorage.self, from: blob))
                    ?? Self.decodeCodexTokenFromRawOAuth(blob) {
                    ProviderKeychainHelper.saveOAuthToken(t, instanceId: instance.id)
                }
            case .xAI:
                if let t = (try? JSONDecoder().decode(XAITokenStorage.self, from: blob))
                    ?? Self.decodeXAITokenFromRawOAuth(blob) {
                    ProviderKeychainHelper.saveOAuthToken(t, instanceId: instance.id)
                }
            case .kimiCode:
                if let t = try? JSONDecoder().decode(KimiTokenStorage.self, from: blob) {
                    ProviderKeychainHelper.saveOAuthToken(t, instanceId: instance.id)
                }
            default:
                break
            }
        }

        let importedModelCount = config.modelEntries.filter { $0.providerInstanceId == instance.id }.count
        logger.info("Imported provider '\(resolvedLabel)' (\(providerType.rawValue)) with \(importedModelCount) models")
        // If the imported JSON had no `models` array (older exports / a
        // bare-bones template), the new instance would be left with an
        // empty model list — exactly the "empty list" symptom the user
        // reported. Kick off the same refreshModels path addInstance()
        // uses so the new provider ends up with a populated picker.
        if importedModelCount == 0 {
            Task { await refreshModels(for: instance) }
        }
        return resolvedLabel
    }

    /// Import metadata is admitted as one snapshot. Credential persistence is
    /// deliberately left to the existing caller after this succeeds.
    private func commitImportedMetadata(_ instance: ProviderInstance, entries: [ModelEntry]) -> Bool {
        guard persistenceReady else { return false }
        config.instances.append(instance)
        var seen = Set(config.modelEntries.map(\.id))
        let now = Date()
        for entry in entries where entry.providerInstanceId == instance.id && seen.insert(entry.id).inserted {
            var imported = entry.replacingBaseModel(entry.baseModel.withInferredModality())
            imported.userModifiedAt = now
            config.modelEntries.append(imported)
        }
        return save()
    }

    // MARK: - Model Entries

    // MARK: - Entry access (stable sort)
    //
    // The storage order of `config.modelEntries` is an implementation detail —
    // it drifts as a side-effect of `replaceEntries` (which removes all entries
    // for an instance and re-appends them at the end), concurrent auto-refresh
    // finishing in non-deterministic order, and iCloud merge insertions. None
    // of that should leak into the UI.
    //
    // All UI-facing reads go through these three getters, which apply a stable
    // sort: by the persisted provider order, then by `baseModel.id`
    // (alphabetic within each provider). This gives the user a predictable
    // layout that survives refreshes and syncs unchanged.
    var modelEntries: [ModelEntry] {
        sortedEntries(config.modelEntries)
    }

    func entries(for instanceId: String) -> [ModelEntry] {
        ModelCatalog.entries(config.modelEntries.filter { $0.providerInstanceId == instanceId },
                             providerOrder: [instanceId])
    }

    func visibleEntries(for instanceId: String) -> [ModelEntry] {
        entries(for: instanceId).filter { !$0.isHidden }
    }

    /// Shared sort used by the flat-list getter. Clusters entries by provider
    /// instance (in user-selected order), then alphabetizes by `baseModel.id`
    /// within each cluster. Instances not found in the current config fall to
    /// the end in a stable tail (handles the brief window where an entry exists
    /// but its owning instance was just removed).
    private func sortedEntries(_ entries: [ModelEntry]) -> [ModelEntry] {
        ModelCatalog.entries(entries, providerOrder: config.instances.map(\.id))
    }

    func entry(for entryId: String) -> ModelEntry? {
        // Built-in System engine members are virtual (synthetic, never stored). They
        // must resolve here so a group with System members (e.g. a [Doubao, System]
        // fallback list) doesn't silently drop System at the entry-lookup guard.
        // Mirrors instance(for:)'s System branch.
        if entryId == SystemVoiceProvider.builtinProviderId
            || entryId.hasPrefix(SystemVoiceProvider.builtinProviderId + "/") {
            return SystemVoiceCatalog.entry(forCompositeId: entryId)
        }
        // [T-provider-entry-composite-key] `id` is now the compositeKey
        // ("{instanceId}/{modelId}"). Resolve by composite key first; then fall
        // back to the legacy random uuid and the old ":" composite key so a
        // reference written by an older build (or synced from a not-yet-migrated
        // peer) still resolves. The legacyUuid normalization map rewrites these
        // to composite keys over time, but this lookup keeps them working in the
        // meantime — never returns nil just because a reference is still in an
        // old form.
        // Match the same representative/overlay shown by the catalog even
        // while legacy JSON still contains duplicate rows before DB hydration.
        func effective(_ hit: ModelEntry) -> ModelEntry {
            ModelCatalog.representative(config.modelEntries.filter { $0.id == hit.id }) ?? hit
        }
        if let hit = config.modelEntries.first(where: { $0.id == entryId }) { return effective(hit) }
        if let hit = config.modelEntries.first(where: { $0.uuid == entryId }) { return effective(hit) }
        if let mapped = legacyUuidToCompositeKey[entryId],
           let hit = config.modelEntries.first(where: { $0.id == mapped }) { return effective(hit) }
        if let hit = config.modelEntries.first(where: { $0.legacyColonCompositeKey == entryId }) { return effective(hit) }
        return nil
    }

    /// [T-ios-minis-config-entry-id-composite] Normalize an entry reference in
    /// any historical form (composite key, legacy random uuid, legacy ":"
    /// composite) to the entry's CURRENT id (the composite key). Returns the
    /// input unchanged when nothing resolves — callers validate afterwards, so
    /// a truly-unknown reference still fails their existence check.
    func normalizeEntryRef(_ ref: String) -> String {
        entry(for: ref)?.id ?? legacyUuidToCompositeKey[ref] ?? ref
    }

    /// Add a model entry, deduplicating by providerInstanceId + baseModel.id across all entries.
    /// Returns `false` if a duplicate already exists.
    @discardableResult
    func addEntry(_ entry: ModelEntry) -> Bool {
        guard !config.modelEntries.contains(where: {
            $0.providerInstanceId == entry.providerInstanceId && $0.baseModel.id == entry.baseModel.id
        }) else { return false }
        let inferredModel = entry.baseModel.withInferredModality()
        // Stamp userModifiedAt — addEntry is only called when the user explicitly
        // creates a custom entry (UI "Add Model" flow), so the entry carries user intent.
        // [T-provider-entry-composite-key] uuid param wants the random uuid,
        // not entry.id (which is now the composite key).
        let e = ModelEntry(uuid: entry.uuid, providerInstanceId: entry.providerInstanceId,
                           model: inferredModel, overrides: entry.overrides,
                           isCustom: entry.isCustom, isHidden: entry.isHidden,
                           userModifiedAt: Date())
        config.modelEntries.append(e)
        return save()
    }

    func updateEntry(_ entry: ModelEntry) {
        guard let idx = config.modelEntries.firstIndex(where: { $0.id == entry.id }) else { return }
        // Stamp userModifiedAt on every UI-driven edit so iCloud merge can resolve
        // same-field conflicts by last-write-wins. This is the single funnel for
        // override edits from ProviderInstanceDetailView.
        var stamped = entry
        stamped.userModifiedAt = Date()
        config.modelEntries[idx] = stamped
        save()
    }

    /// One user action, one save/sync snapshot even for a large selection.
    /// Hiding affects routing eligibility, but never deletes saved references.
    @discardableResult
    func setEntriesHidden(ids: Set<String>, hidden: Bool) -> Bool {
        let canonicalIds = Set(ids.map { normalizeEntryRef($0) })
        let now = Date()
        var changed = false
        for index in config.modelEntries.indices {
            guard canonicalIds.contains(config.modelEntries[index].id),
                  config.modelEntries[index].isHidden != hidden else { continue }
            config.modelEntries[index].isHidden = hidden
            config.modelEntries[index].userModifiedAt = now
            changed = true
        }
        return changed ? save() : true
    }

    @discardableResult
    func removeEntry(_ entryId: String) -> Bool {
        let entryId = normalizeEntryRef(entryId)
        let dormant: [ModelEntry]
        do { dormant = try ModelCatalogArchive.load(at: modelArchiveURL).filter { $0.id == entryId } }
        catch {
            logger.error("Cannot remove model while its metadata archive cannot be updated: \(error)")
            return false
        }
        let removed = config.modelEntries.filter { $0.id == entryId } + dormant
        let removedAliases = Set(removed.flatMap { [$0.id, $0.uuid, $0.legacyColonCompositeKey] } + [entryId])
        config.modelEntries.removeAll { $0.id == entryId }
        // Also remove from groups — stamp a member-removal tombstone on each
        // group so the removal survives the inbound union-merge on peers.
        let now = Date()
        for i in config.modelGroups.indices where config.modelGroups[i].memberEntryIds.contains(entryId) {
            config.modelGroups[i].memberEntryIds.removeAll { $0 == entryId }
            config.modelGroups[i].removedMembers[entryId] = now
            config.modelGroups[i].addedMembers[entryId] = nil
        }
        // Remove from agent loop list
        config.agentLoopModelEntryIds.removeAll { $0 == entryId }
        Self.recordTombstone(in: &config.deletedModelEntries, ids: [entryId])
        guard save() else { return false }
        do { try ModelCatalogArchive.remove(entryIds: [entryId], at: modelArchiveURL) }
        catch { logger.error("Model deleted; dormant metadata cleanup will retry on refresh: \(error)") }
        ModelSwitcher.forget(entryIds: removedAliases)
        AgentModelSlots.forget(entryIds: [entryId])
        // [T-icloud-provider-sync-consistency] emitV3MarkDirty no longer
        // infers deletes from the snapshot diff, so an explicit removal must
        // emit its own V3 delete tombstone here.
        Task { await ChatStore.shared.markDirty(recordType: "ProviderModelEntryV3", recordId: entryId, operation: "delete") }
        return true
    }

    /// Replace model entries for an instance with fresh ones (e.g. after API fetch).
    /// Reuses existing entry UUIDs by model ID so that group memberEntryIds remain valid.
    /// Preserves user state across refreshes:
    ///   - `overrides` (user edits like displayName / maxOutputTokens) carries forward
    ///   - `isHidden` carries forward
    /// When a built-in model matches a previously custom entry, the custom entry's UUID and
    /// overrides are preserved and the entry is converted to non-custom (so the user's
    /// selected model keeps working after refresh).
    @discardableResult
    func replaceEntries(for instanceId: String, models rawModels: [LLMModel], caller: String = #function) -> Bool {
        guard config.instances.contains(where: { $0.id == instanceId }) else { return false }
        let existing = config.modelEntries.filter { $0.providerInstanceId == instanceId }
        let template = VoiceProviderTemplate.template(
            forBaseURL: config.instances.first(where: { $0.id == instanceId })?.effectiveCustomBaseURL)
        do {
            let refresh = try ModelCatalogArchive.refresh(
                instanceId: instanceId, activeEntries: config.modelEntries, models: rawModels,
                templateModels: template?.mockModels ?? [],
                forgottenEntryIds: Set(config.deletedModelEntries.map(\.id)),
                forgottenInstanceIds: Set(config.deletedInstances.map(\.id)), at: modelArchiveURL)
            // The archive is durable before active rows disappear. Never route
            // using archive-only entries, and never prune user group/favorite refs.
            config.modelEntries.removeAll { $0.providerInstanceId == instanceId }
            config.modelEntries.append(contentsOf: refresh.entries)
            for (alias, id) in refresh.aliases where alias != id { legacyUuidToCompositeKey[alias] = id }
            persistLegacyUuidMap()
            logger.info("[ModelList] replaceEntries caller=\(caller) instance=\(instanceId.prefix(8)) before=\(existing.count) after=\(refresh.entries.count); omitted metadata archived locally")
            return save()
        } catch {
            // Keep the previous catalog rather than lose user edits. In
            // particular, never overwrite an unreadable or newer archive.
            logger.error("[ModelList] refresh aborted: cannot preserve model metadata: \(error)")
            return false
        }
    }

    // MARK: - Model Groups

    var modelGroups: [ModelGroup] { config.modelGroups }

    @discardableResult
    func addGroup(_ group: ModelGroup) -> Bool {
        config.modelGroups.append(group)
        return save()
    }

    @discardableResult
    func updateGroup(_ group: ModelGroup) -> Bool {
        guard let idx = config.modelGroups.firstIndex(where: { $0.id == group.id }) else { return false }
        // [T-icloud-provider-sync-consistency] Stamp per-member add/remove
        // timestamps by diffing the prior member list against the new one, so
        // the inbound union-merge on other devices can arbitrate concurrent
        // edits. A member newly present → addedMembers[m]=now (and clear any
        // stale removed tombstone). A member newly absent → removedMembers[m]=now
        // (and clear its added entry). Carries forward existing timestamps for
        // unchanged members.
        let prior = config.modelGroups[idx]
        var stamped = group
        let now = Date()
        let priorSet = Set(prior.memberEntryIds)
        let newSet = Set(group.memberEntryIds)
        var added = prior.addedMembers
        var removed = prior.removedMembers
        // Carry forward caller-supplied maps if it set any (UI usually doesn't).
        for (k, v) in group.addedMembers { added[k] = v }
        for (k, v) in group.removedMembers { removed[k] = v }
        for m in newSet where !priorSet.contains(m) {   // newly added
            added[m] = now
            removed[m] = nil
        }
        for m in priorSet where !newSet.contains(m) {   // newly removed
            removed[m] = now
            added[m] = nil
        }
        // Prune maps to relevant ids (present → added only; absent → removed only).
        stamped.addedMembers = added.filter { newSet.contains($0.key) }
        stamped.removedMembers = removed.filter { !newSet.contains($0.key) }
        config.modelGroups[idx] = stamped
        return save()
    }

    /// Reorder model groups. This order drives the display order in the
    /// Model Groups list and SessionModelPicker. Unknown ids are dropped,
    /// and any groups missing from newOrder are appended in their existing
    /// relative order to keep state consistent.
    @discardableResult
    func reorderGroups(_ newOrder: [String]) -> Bool {
        let existingById = Self.dictByIdLastWins(config.modelGroups.map { ($0.id, $0) })
        var seen = Set<String>()
        var reordered: [ModelGroup] = []
        for id in newOrder {
            guard !seen.contains(id), let group = existingById[id] else { continue }
            seen.insert(id)
            reordered.append(group)
        }
        for group in config.modelGroups where !seen.contains(group.id) {
            reordered.append(group)
        }
        config.modelGroups = reordered
        return save()
    }

    @discardableResult
    func removeGroup(_ groupId: String) -> Bool {
        config.modelGroups.removeAll { $0.id == groupId }
        Self.repointDefaults(in: &config, removedGroupIds: [groupId])
        Self.recordTombstone(in: &config.deletedModelGroups, ids: [groupId])
        guard save() else { return false }
        ModelSwitcher.forget(groupIds: [groupId])
        // [T-icloud-provider-sync-consistency] Explicit V3 delete tombstone —
        // emitV3MarkDirty no longer diff-infers group deletions.
        Task { await ChatStore.shared.markDirty(recordType: "ProviderModelGroupV3", recordId: groupId, operation: "delete") }
        return true
    }

    func group(for id: String) -> ModelGroup? {
        config.modelGroups.first { $0.id == id }
    }

    /// Provider instances the user deleted. Instance ids are never reused, so
    /// anything still pointing at one of these is garbage.
    var deletedInstanceIds: Set<String> {
        Set(config.deletedInstances.map(\.id))
    }

    /// Point defaults and the agent-loop list away from groups that were just
    /// removed. Clearing the choice avoids implicitly routing future requests
    /// to an arbitrary remaining group, which may be empty or voice-only.
    private static func repointDefaults(in config: inout ProviderConfig, removedGroupIds: Set<String>) {
        guard !removedGroupIds.isEmpty else { return }
        if let def = config.defaultPrimaryGroupId, removedGroupIds.contains(def) {
            config.defaultPrimaryGroupId = nil
        }
        if let def = config.defaultSubGroupId, removedGroupIds.contains(def) {
            config.defaultSubGroupId = nil
        }
        if let def = config.voiceInputGroupId, removedGroupIds.contains(def) {
            config.voiceInputGroupId = nil
        }
        if let def = config.voiceOutputGroupId, removedGroupIds.contains(def) {
            config.voiceOutputGroupId = nil
        }
        config.agentLoopGroupIds.removeAll { removedGroupIds.contains($0) }
    }

    // MARK: - Agent Loop Models

    var agentLoopModelEntryIds: [String] {
        get { config.agentLoopModelEntryIds }
        set {
            config.agentLoopModelEntryIds = newValue
            save()
        }
    }

    var agentLoopGroupIds: [String] {
        get { config.agentLoopGroupIds }
        set {
            config.agentLoopGroupIds = newValue
            save()
        }
    }

    func addAgentLoopEntry(_ entryId: String) {
        guard !config.agentLoopModelEntryIds.contains(entryId) else { return }
        config.agentLoopModelEntryIds.append(entryId)
        save()
    }

    func removeAgentLoopEntry(_ entryId: String) {
        config.agentLoopModelEntryIds.removeAll { $0 == entryId }
        save()
    }

    func addAgentLoopGroup(_ groupId: String) {
        guard !config.agentLoopGroupIds.contains(groupId) else { return }
        config.agentLoopGroupIds.append(groupId)
        save()
    }

    func removeAgentLoopGroup(_ groupId: String) {
        config.agentLoopGroupIds.removeAll { $0 == groupId }
        save()
    }

    // MARK: - Voice group selectors (ASR / TTS)
    //
    // Parallel to Default Primary/Sub: each points at a ModelGroup whose
    // audio-capable members serve voice. Local-only (per-device), not synced.

    var voiceInputGroupId: String? {
        get { config.voiceInputGroupId }
        set { config.voiceInputGroupId = newValue; save() }
    }

    var voiceOutputGroupId: String? {
        get { config.voiceOutputGroupId }
        set { config.voiceOutputGroupId = newValue; save() }
    }

    /// Ensure a default Voice INPUT group exists and is bound when the user hasn't
    /// configured one. Called on first entry into voice-input mode. Creates a
    /// "Voice Input" group with the automatic System model, whose network fallback
    /// is disabled unless the user enables it in System Speech resources, and
    /// binds it. No-op if a group is already set. Members are the System sentinel
    /// composite ids, which resolve via SystemVoiceCatalog (never stored/synced).
    @discardableResult
    func ensureDefaultVoiceInputGroup() -> String? {
        if let gid = config.voiceInputGroupId, group(for: gid) != nil { return gid }
        let sentinel = SystemVoiceProvider.builtinProviderId
        let group = ModelGroup(
            name: String(localized: "Voice Input", comment: "Default voice input group name"),
            memberEntryIds: ["\(sentinel)/system-asr"])
        config.modelGroups.append(group)
        config.voiceInputGroupId = group.id
        save()
        logger.info("[Voice] auto-created default Voice Input group \(group.id.prefix(8)) [System ASR auto]")
        return group.id
    }

    /// Ensure a default Voice OUTPUT group exists and is bound when the user hasn't
    /// configured one. Creates a "Voice Output" group with "System Voice (Auto)" —
    /// which picks the best installed voice for each reply's language automatically
    /// (a Chinese sentence reads in a Chinese voice, English in an English one). The
    /// user can add/replace with specific voices later. No-op if already set.
    @discardableResult
    func ensureDefaultVoiceOutputGroup() -> String? {
        if let gid = config.voiceOutputGroupId, group(for: gid) != nil { return gid }
        let sentinel = SystemVoiceProvider.builtinProviderId
        let group = ModelGroup(
            name: String(localized: "Voice Output", comment: "Default voice output group name"),
            memberEntryIds: ["\(sentinel)/system-tts"])
        config.modelGroups.append(group)
        config.voiceOutputGroupId = group.id
        save()
        logger.info("[Voice] auto-created default Voice Output group \(group.id.prefix(8)) [System Voice (Auto)]")
        return group.id
    }

    /// All unique model entries available in agent loop: individual entries + entries from groups.
    var resolvedAgentLoopEntries: [ModelEntry] {
        var seen = Set<String>()
        var result: [ModelEntry] = []
        // Individual entries first
        for id in config.agentLoopModelEntryIds {
            guard !seen.contains(id), let entry = entry(for: id) else { continue }
            seen.insert(id)
            result.append(entry)
        }
        // Then entries from groups
        for groupId in config.agentLoopGroupIds {
            guard let group = group(for: groupId) else { continue }
            for entryId in group.memberEntryIds {
                guard !seen.contains(entryId), let entry = entry(for: entryId) else { continue }
                seen.insert(entryId)
                result.append(entry)
            }
        }
        return result
    }

    // MARK: - Defaults

    var defaultPrimaryGroupId: String? {
        get { config.defaultPrimaryGroupId }
        set {
            config.defaultPrimaryGroupId = newValue
            save()
        }
    }

    var defaultSubGroupId: String? {
        get { config.defaultSubGroupId }
        set {
            config.defaultSubGroupId = newValue
            save()
        }
    }

    // MARK: - Session Bindings

    func binding(for sessionId: String) -> SessionModelBinding? {
        config.sessionBindings[sessionId]
    }

    @discardableResult
    func setBinding(_ binding: SessionModelBinding, for sessionId: String) -> Bool {
        config.sessionBindings[sessionId] = binding
        return save()
    }

    func removeBinding(for sessionId: String) {
        config.sessionBindings.removeValue(forKey: sessionId)
        save()
    }

    /// A deleted session's model binding and inference settings go with it.
    /// They used to stay forever, and every config save rewrites all of them.
    func forgetSession(_ sessionId: String) {
        let hadBinding = config.sessionBindings.removeValue(forKey: sessionId) != nil
        let hadInference = config.sessionInferenceConfigs.removeValue(forKey: sessionId) != nil
        if hadBinding || hadInference { save() }
    }

    // MARK: - Session Inference Config

    func inferenceConfig(for sessionId: String) -> SessionInferenceConfig? {
        config.sessionInferenceConfigs[sessionId]
    }

    func setInferenceConfig(_ cfg: SessionInferenceConfig, for sessionId: String) {
        config.sessionInferenceConfigs[sessionId] = cfg
        save()
    }

    func removeInferenceConfig(for sessionId: String) {
        config.sessionInferenceConfigs.removeValue(forKey: sessionId)
        save()
    }

    // MARK: - Bulk Update (for migration)

    func applyConfig(_ newConfig: ProviderConfig) {
        config = newConfig
        save()
    }

    /// Apply a merged config from iCloud sync without triggering a markDirty upload.
    /// Used by `CloudSyncEngine.mergeProviderConfig` — it replaces the in-memory config,
    /// writes it to disk, and publishes the change, but does NOT schedule a re-upload.
    /// The caller decides separately whether the merge produced data that needs to be
    /// pushed back to iCloud (via the existing "localHasUnique" re-upload path).
    @discardableResult
    func applyMergedConfigFromSync(_ newConfig: ProviderConfig) -> Bool {
        guard persistenceReady else {
            logger.warning("Provider config is still loading; sync merge deferred without acknowledgement")
            return false
        }
        // Compute the set of instances that ended up with zero model
        // entries after the merge. The remote ProviderConfig snapshot
        // can be missing model rows when the peer hadn't refreshed yet
        // (or pushed before its own model fetch completed). Without a
        // follow-up refresh the model picker would be empty for those
        // instances on this device.
        let priorInstanceIds = Set(config.instances.map(\.id))
        let instancesNeedingRefresh: [ProviderInstance] = newConfig.instances.filter { inst in
            // Only instances that are either brand-new on this device
            // (never seen before) OR have no model entries after the
            // merge are worth refreshing — an existing instance with a
            // populated picker should be left alone.
            let entriesAfter = newConfig.modelEntries.filter { $0.providerInstanceId == inst.id }
            return entriesAfter.isEmpty && (!priorInstanceIds.contains(inst.id) ||
                                            !config.modelEntries.contains { $0.providerInstanceId == inst.id })
        }

        // [T-icloud-provider-sync-consistency] Collapse cross-device duplicate
        // entries. Each device assigns a RANDOM uuid to a freshly-refreshed
        // model, so two devices refreshing the same instance produce two
        // ProviderModelEntryV3 records for the same (instanceId, modelId) —
        // surfacing as the same model appearing 2-3× in the picker. Fold them
        // to one deterministic representative (lexicographically smallest uuid,
        // non-custom preferred) AND rewrite every group member reference from
        // the pruned uuids to the representative, so a group that pointed at a
        // now-removed duplicate doesn't become a dangling reference. Because
        // the representative is chosen deterministically, every device
        // converges to the SAME survivor and the SAME group references.
        let (deduped, prunedEntryIds) = Self.dedupeEntriesByModel(newConfig)

        // [T-ios-config-noop-publish-storm] No-op compensation short-circuit.
        // The periodic fetchRecent poll is purely a safety net — the common
        // case is "nothing changed since the last push", so `deduped` comes
        // back byte-identical to the in-memory `config`. Assigning it anyway
        // fired `@Published config`'s objectWillChange unconditionally, which
        // invalidated EVERY SwiftUI view observing ProviderConfigStore.shared —
        // including ContentView (whose body re-eval re-creates AIChatView, each
        // re-init wastefully constructing a throwaway CachedViewModel) and
        // AIChatView itself. During a scroll glide that landed on the main
        // thread as a deceleration-phase frame drop (see the MLTRACE decel
        // trace: AIChatView.init + updateUIViewController + applySubViewport-
        // Compensation firing mid-decel right before a ~100ms dropped frame).
        // When the merged result is identical AND there's nothing to prune /
        // refresh, skip the publish + disk + DB write entirely — the poll was
        // genuinely a no-op. Any real change (diff, prune, empty-picker
        // instance) still falls through to the full apply below.
        if deduped == config, prunedEntryIds.isEmpty, instancesNeedingRefresh.isEmpty {
            return true
        }

        // The canonical JSON must be committed before this merge can be ACKed.
        // Publishing in memory first would make a retry look like a durable no-op.
        let token: String
        do {
            token = try ProviderSnapshotJournal.write(JSONEncoder().encode(deduped), to: fileURL)
        } catch {
            logger.error("Failed to persist merged provider config: \(error)")
            return false
        }
        config = deduped
        configRevision &+= 1
        for entry in newConfig.modelEntries where entry.uuid != entry.id { legacyUuidToCompositeKey[entry.uuid] = entry.id }
        // [T-icloud-fresh-restore-provider-groups] Summary of what this device
        // holds after an inbound merge — the single most useful triage line for
        // "fresh restore is missing providers/groups": shows instance / entry /
        // group counts plus total group members actually present.
        let groupMembers = deduped.modelGroups.reduce(0) { $0 + $1.memberEntryIds.count }
        logger.info("[v3sync] applyMergedConfigFromSync: instances=\(deduped.instances.count) entries=\(deduped.modelEntries.count) groups=\(deduped.modelGroups.count) groupMembers=\(groupMembers) prunedDup=\(prunedEntryIds.count)")
        // Mirror the merged config into SQLite too — but suppress v3
        // markDirty emission since this update originated INBOUND from
        // sync (re-emitting it would round-trip the same payload back
        // to cloud, exactly the v2 ping-pong we're trying to escape).
        // The lastSavedSnapshot is also updated so the next mutate's
        // diff is correctly anchored against the freshly-merged state.
        lastSavedSnapshot = config
        if let db {
            let snapshot = config
            let toDelete = prunedEntryIds
            let url = fileURL
            let aliases = legacyUuidToCompositeKey
            databaseWrites.enqueue {
                guard await db.bulkReplace(from: snapshot) else { return }
                let aliasJSON = (try? JSONEncoder().encode(aliases)).flatMap { String(data: $0, encoding: .utf8) } ?? "{}"
                guard await db.setLegacyUuidMapKV(aliasJSON) else { return }
                ProviderSnapshotJournal.complete(token, for: url)
                for eid in toDelete {
                    guard await db.deleteEntryRow(id: eid) else { continue }
                    await ChatStore.shared.markDirty(recordType: "ProviderModelEntryV3", recordId: eid, operation: "delete")
                }
            }
        }

        // Fire-and-forget model refreshes for instances left empty.
        // refreshModels handles errors internally and writes back via
        // replaceEntries — which will markDirty for the next sync round
        // (idempotent if the picker is genuinely empty).
        if !instancesNeedingRefresh.isEmpty {
            logger.info("[ModelList] applyMergedConfigFromSync: \(instancesNeedingRefresh.count) instance(s) have empty model lists, scheduling refresh")
            for inst in instancesNeedingRefresh {
                Task { await refreshModels(for: inst) }
            }
        }
        return true
    }

    /// [T-icloud-provider-sync-consistency] Collapse duplicate model entries
    /// that share the same (providerInstanceId, baseModel.id) — the cross-device
    /// duplication caused by random per-device entry uuids — and rewrite all
    /// group member references onto the surviving representative.
    ///
    /// Determinism (so every device converges identically):
    ///   representative = among entries with the same composite key, prefer
    ///   isCustom==false; tie-break by lexicographically smallest uuid.
    ///
    /// Returns the deduped config and the list of pruned (non-representative)
    /// entry uuids so the caller can delete + tombstone them.
    static func dedupeEntriesByModel(_ input: ProviderConfig) -> (config: ProviderConfig, prunedEntryIds: [String]) {
        var config = input
        // Group entries by composite key.
        var byKey: [String: [ModelEntry]] = [:]
        for e in config.modelEntries {
            byKey[e.compositeKey, default: []].append(e)
        }
        guard byKey.values.contains(where: { $0.count > 1 }) else {
            return (config, [])  // no duplicates — fast path
        }
        // For each duplicated key pick a deterministic representative and map
        // every other uuid → representative uuid.
        var uuidRewrite: [String: String] = [:]  // prunedUuid → representativeUuid
        var pruned: [String] = []
        var survivors: [ModelEntry] = []
        for (_, entries) in byKey {
            if entries.count == 1 { survivors.append(entries[0]); continue }
            guard let rep = ModelCatalog.representative(entries) else { continue }
            survivors.append(rep)
            for e in entries where e.uuid != rep.uuid {
                uuidRewrite[e.uuid] = rep.uuid
                pruned.append(e.uuid)
            }
        }
        config.modelEntries = ModelCatalog.entries(survivors, providerOrder: config.instances.map(\.id))
        if !uuidRewrite.isEmpty {
            // Rewrite group member references from pruned uuids → representative.
            for i in config.modelGroups.indices {
                var seen = Set<String>()
                config.modelGroups[i].memberEntryIds = config.modelGroups[i].memberEntryIds.compactMap { mid in
                    let mapped = uuidRewrite[mid] ?? mid
                    return seen.insert(mapped).inserted ? mapped : nil  // de-dup after rewrite
                }
                // Carry add/remove tombstones across the rewrite too.
                for (pruned, rep) in uuidRewrite {
                    if let t = config.modelGroups[i].addedMembers.removeValue(forKey: pruned) {
                        config.modelGroups[i].addedMembers[rep] = max(config.modelGroups[i].addedMembers[rep] ?? .distantPast, t)
                    }
                    if let t = config.modelGroups[i].removedMembers.removeValue(forKey: pruned) {
                        config.modelGroups[i].removedMembers[rep] = max(config.modelGroups[i].removedMembers[rep] ?? .distantPast, t)
                    }
                }
            }
            // Rewrite agent-loop entry references too.
            var seenAL = Set<String>()
            config.agentLoopModelEntryIds = config.agentLoopModelEntryIds.compactMap { id in
                let mapped = uuidRewrite[id] ?? id
                return seenAL.insert(mapped).inserted ? mapped : nil
            }
        }
        return (config, pruned)
    }

    // MARK: - [T-provider-entry-composite-key] legacyUuid normalization

    /// Rewrite every group / binding / agent-loop reference that matches a known
    /// legacyUuid to its composite key, using `legacyUuidToCompositeKey`.
    /// Idempotent. Returns true if anything changed (so caller can persist).
    /// References that don't match any known legacyUuid are LEFT AS-IS — never
    /// dropped — so an out-of-order arrival just normalizes later when the entry
    /// record (and thus its legacyUuid mapping) shows up.
    @discardableResult
    func normalizeReferences() -> Bool {
        guard !legacyUuidToCompositeKey.isEmpty else { return false }
        let map = legacyUuidToCompositeKey
        var changed = false

        func remap(_ ref: String) -> String { map[ref] ?? ref }

        // Groups: memberEntryIds + added/removed member keys.
        for i in config.modelGroups.indices {
            let before = config.modelGroups[i].memberEntryIds
            var seen = Set<String>()
            let after = before.compactMap { mid -> String? in
                let m = remap(mid)
                return seen.insert(m).inserted ? m : nil
            }
            if after != before { config.modelGroups[i].memberEntryIds = after; changed = true }

            for (oldKey, t) in config.modelGroups[i].addedMembers where map[oldKey] != nil {
                let nk = map[oldKey]!
                config.modelGroups[i].addedMembers.removeValue(forKey: oldKey)
                config.modelGroups[i].addedMembers[nk] = Swift.max(config.modelGroups[i].addedMembers[nk] ?? .distantPast, t)
                changed = true
            }
            for (oldKey, t) in config.modelGroups[i].removedMembers where map[oldKey] != nil {
                let nk = map[oldKey]!
                config.modelGroups[i].removedMembers.removeValue(forKey: oldKey)
                config.modelGroups[i].removedMembers[nk] = Swift.max(config.modelGroups[i].removedMembers[nk] ?? .distantPast, t)
                changed = true
            }
        }

        // Agent-loop entry ids.
        let alBefore = config.agentLoopModelEntryIds
        var seenAL = Set<String>()
        let alAfter = alBefore.compactMap { id -> String? in
            let m = remap(id); return seenAL.insert(m).inserted ? m : nil
        }
        if alAfter != alBefore { config.agentLoopModelEntryIds = alAfter; changed = true }

        // Session bindings: directEntry.compositeKey + group.resolvedEntryId.
        for (sid, var binding) in config.sessionBindings {
            var bChanged = false
            func fixSource(_ src: SessionModelSource) -> SessionModelSource {
                switch src {
                case .directEntry(let mid, let ck):
                    // Prefer composite key; if absent but mid is a known legacy
                    // uuid, fill composite key (keep mid for downgrade).
                    if ck == nil, let mapped = map[mid] {
                        bChanged = true
                        return .directEntry(modelEntryId: mid, compositeKey: mapped)
                    }
                    return src
                case .group(let gid, let rid):
                    let nr = remap(rid)
                    if nr != rid { bChanged = true; return .group(groupId: gid, resolvedEntryId: nr) }
                    return src
                }
            }
            binding.primarySource = fixSource(binding.primarySource)
            if let sub = binding.subModelSource { binding.subModelSource = fixSource(sub) }
            if bChanged { config.sessionBindings[sid] = binding; changed = true }
        }

        if changed {
            logger.info("[CompositeKeyMigrate] normalizeReferences: rewrote uuid→compositeKey references (lmap=\(map.count))")
        }
        return changed
    }

    /// Merge new legacyUuid→compositeKey entries into the map and persist.
    /// Triggers normalizeReferences when anything new was learned.
    func learnLegacyUuids(_ pairs: [String: String]) {
        var learnedNew = false
        var learnedKeys: [String] = []
        for (uuid, ck) in pairs where legacyUuidToCompositeKey[uuid] != ck {
            legacyUuidToCompositeKey[uuid] = ck
            learnedNew = true
            learnedKeys.append("\(uuid.prefix(8))→\(ck)")
        }
        guard learnedNew else {
            logger.info("[CompositeKeyMigrate] learnLegacyUuids: \(pairs.count) inbound pair(s), none new (lmap=\(self.legacyUuidToCompositeKey.count))")
            return
        }
        logger.info("[CompositeKeyMigrate] learnLegacyUuids: learned \(learnedKeys.count) new mapping(s) [\(learnedKeys.prefix(6).joined(separator: ","))] lmap=\(self.legacyUuidToCompositeKey.count)")
        persistLegacyUuidMap()
        if normalizeReferences() {
            save()
            logger.info("[CompositeKeyMigrate] learnLegacyUuids: normalizeReferences rewrote references after learning + saved")
        }
    }

    /// [T-provider-entry-id-canonicalize] Resolve a (possibly legacy random-uuid)
    /// entry id to its canonical composite key, if a mapping is known. Returns
    /// nil when the id is already composite (contains "/") or unknown — callers
    /// then fall back to the id as-is. Used by the inbound delete path so a
    /// raw-uuid `op=delete` from the cloud removes the locally composite-keyed
    /// row instead of silently no-op'ing.
    func canonicalEntryId(forLegacy id: String) -> String? {
        if id.contains("/") { return nil }
        return legacyUuidToCompositeKey[id]
    }

    private func persistLegacyUuidMap() {
        guard let db else { return }
        let snapshot = legacyUuidToCompositeKey
        let json = (try? JSONEncoder().encode(snapshot)).flatMap { String(data: $0, encoding: .utf8) } ?? "{}"
        databaseWrites.enqueue { await db.setLegacyUuidMapKV(json) }
    }

    func loadLegacyUuidMap() async {
        guard let db else { return }
        if let s = await db.localKV("legacyUuidMap"),
           let data = s.data(using: .utf8),
           let map = try? JSONDecoder().decode([String: String].self, from: data) {
            self.legacyUuidToCompositeKey.merge(map) { local, _ in local }
        }
    }

    // MARK: - Shadow Voice Providers [T-mimo-shadow-voice]

    /// True if `instance` has ANY model entry with an audio input/output modality.
    /// This replaces the old base-URL `isVoiceOnlyProvider` whitelist: voice
    /// ability is a per-MODEL concern, computed dynamically from the instance's
    /// entries rather than hardcoded per vendor host.
    func hasVoiceModels(for instanceId: String) -> Bool {
        config.modelEntries.contains { e in
            guard e.providerInstanceId == instanceId else { return false }
            let m = e.baseModel.capabilities.supportedModalities
            return m.contains(.audioInput) || m.contains(.audioOutput)
        }
    }

    /// Per-instance UserDefaults flag: user hid this instance's shadow voice
    /// entry ("I only want the text models, not the Voice Services row"). Nil
    /// key = enabled (shadow shown) by default.
    private static func voiceShadowDisabledKey(_ instanceId: String) -> String {
        "voiceShadowDisabled.\(instanceId)"
    }
    func isVoiceShadowDisabled(_ instanceId: String) -> Bool {
        UserDefaults.standard.bool(forKey: Self.voiceShadowDisabledKey(instanceId))
    }
    func setVoiceShadowDisabled(_ disabled: Bool, for instanceId: String) {
        UserDefaults.standard.set(disabled, forKey: Self.voiceShadowDisabledKey(instanceId))
        objectWillChange.send()
    }

    /// A read-only MIRROR of a Chat/OpenAI instance's voice capability, surfaced
    /// in Voice Services. NOT a stored entity: it shares the underlying instance's
    /// credential + endpoint and reads its audio-modality model entries. Pure
    /// runtime view — building it writes nothing.
    struct ShadowVoiceProvider: Identifiable {
        let instanceId: String
        var id: String { instanceId }
        let displayName: String
        let inputModels: [ModelEntry]   // audioInput entries (ASR)
        let outputModels: [ModelEntry]  // audioOutput entries (TTS)
    }

    /// Normalize a base URL for cross-instance de-dup: lowercased, trailing
    /// "/v1"/"/" stripped. Two instances pointing at the same MiMo host fold to
    /// one shadow row.
    static func normalizedShadowKey(_ baseURL: String?) -> String {
        guard var s = baseURL?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(), !s.isEmpty else { return "" }
        while s.hasSuffix("/") { s.removeLast() }
        if s.hasSuffix("/v1") { s = String(s.dropLast(3)) }
        while s.hasSuffix("/") { s.removeLast() }
        return s
    }

    /// All shadow voice providers to show in Voice Services: one per enabled
    /// instance that has audio models and isn't shadow-disabled, then FOLDED by
    /// normalized base URL so two instances on the same host show a single row
    /// (representative = enabled first, then most-recently-modified, then oldest
    /// createdAt, then id — deterministic across devices).
    func shadowVoiceProviders() -> [ShadowVoiceProvider] {
        // Candidate instances.
        let candidates = config.instances.filter { inst in
            inst.isEnabled
            && hasVoiceModels(for: inst.id)
            && !isVoiceShadowDisabled(inst.id)
            && VoiceProviderFactory.make(for: inst) != nil
        }
        // Fold by normalized base URL (empty key = no custom base → keep separate by id).
        var byKey: [String: [ProviderInstance]] = [:]
        for inst in candidates {
            let key = Self.normalizedShadowKey(inst.effectiveCustomBaseURL)
            let bucket = key.isEmpty ? "id:\(inst.id)" : key
            byKey[bucket, default: []].append(inst)
        }
        func mostRecentModified(_ instanceId: String) -> Date {
            config.modelEntries
                .filter { $0.providerInstanceId == instanceId }
                .compactMap { $0.userModifiedAt }
                .max() ?? .distantPast
        }
        var result: [ShadowVoiceProvider] = []
        for (_, insts) in byKey {
            // Representative selection — deterministic.
            let rep = insts.sorted { a, b in
                if a.isEnabled != b.isEnabled { return a.isEnabled }
                let ma = mostRecentModified(a.id), mb = mostRecentModified(b.id)
                if ma != mb { return ma > mb }
                if a.createdAt != b.createdAt { return a.createdAt < b.createdAt }
                return a.id < b.id
            }.first!
            let entries = config.modelEntries.filter { $0.providerInstanceId == rep.id }
            let inputs = entries.filter { $0.baseModel.capabilities.supportedModalities.contains(.audioInput) }
            let outputs = entries.filter { $0.baseModel.capabilities.supportedModalities.contains(.audioOutput) }
            result.append(ShadowVoiceProvider(
                instanceId: rep.id,
                displayName: rep.label,
                inputModels: inputs,
                outputModels: outputs
            ))
        }
        // Stable display order: by displayName then id.
        return result.sorted { ($0.displayName, $0.id) < ($1.displayName, $1.id) }
    }

    /// True when ≥2 enabled instances share a normalized base URL AND have voice
    /// models — the migration/dup case (场景 B). UI shows a non-destructive hint.
    func hasFoldedShadowDuplicates() -> Bool {
        var seen = Set<String>()
        for inst in config.instances where inst.isEnabled && hasVoiceModels(for: inst.id) {
            let key = Self.normalizedShadowKey(inst.effectiveCustomBaseURL)
            guard !key.isEmpty else { continue }
            if !seen.insert(key).inserted { return true }
        }
        return false
    }

    // MARK: - Model Refresh

    /// Manual refresh: fetch models from the API (with models.dev fallback) and merge into entries.
    /// Appends new models without removing user-added custom entries.
    /// Errors are logged but not thrown (fire-and-forget friendly).
    @discardableResult
    func refreshModels(for instance: ProviderInstance) async -> Bool {
        // [T-mimo-shadow-voice] No longer skipped for "voice-only" providers.
        // Refresh ALWAYS runs the real /models fetch so a mixed vendor (e.g.
        // MiMo: text chat + voice on one host) gets its text models; audio-modality
        // template seed entries are preserved by replaceEntries (see below), so
        // the voice models are never wiped by the text list.
        do {
            logger.info("[ModelList] refreshModels (MANUAL): instance=\(instance.label) starting fetch")
            let result = try await Self.fetchModelsWithFallback(instance, forceRefresh: true)
            guard replaceEntries(for: instance.id, models: result.models, caller: "refreshModels(manual)") else { return false }
            logger.info("[ModelList] refreshModels (MANUAL): instance=\(instance.label) source=\(result.source) count=\(result.models.count)")
            for w in result.warnings { logger.warning("⚠️ \(w)") }
            return true
        } catch {
            logger.error("[ModelList] refreshModels (MANUAL) FAILED type=\(String(describing: type(of: error)))")
            return false
        }
    }

    /// Auto-refresh: fetch models for a single instance, skipping if user has custom models.
    private func autoRefreshModels(for instance: ProviderInstance) async {
        // [T-mimo-shadow-voice] No longer skipped for "voice-only" providers —
        // audio-modality template seed entries survive replaceEntries.
        let hasCustomModels = config.modelEntries.contains { $0.providerInstanceId == instance.id && $0.isCustom }
        if hasCustomModels {
            logger.info("[ModelList] autoRefreshModels (DAILY): instance=\(instance.label) SKIP — user has custom models")
            return
        }
        do {
            logger.info("[ModelList] autoRefreshModels (DAILY): instance=\(instance.label) starting fetch")
            let result = try await Self.fetchModelsWithFallback(instance, forceRefresh: true)
            guard replaceEntries(for: instance.id, models: result.models, caller: "autoRefreshModels(daily)") else { return }
            logger.info("[ModelList] autoRefreshModels (DAILY): instance=\(instance.label) source=\(result.source) count=\(result.models.count)")
        } catch {
            logger.error("[ModelList] autoRefreshModels (DAILY) FAILED type=\(String(describing: type(of: error)))")
        }
    }

    /// [T-mimo-shadow-voice] One-time upgrade migration: existing users whose
    /// mixed-modality provider (MiMo, DashScope/百炼, …) was mis-classified as
    /// voice-only by the old base-URL whitelist have polluted model lists (text
    /// models dropped, only voice mock left). Waiting for the next natural
    /// refresh is a poor experience. On first launch after this fix ships, force
    /// ONE real `refreshModels` for every third-party OpenAI-compatible instance
    /// so the corrected logic (never-skip fetch + replaceEntries voice-seed
    /// preservation) restores the correct model list. Runs once (guarded by a
    /// UserDefaults flag), silently, in the background, per-instance failure
    /// isolated. Once entries land, `shadowVoiceProviders()` recomputes off the
    /// updated `modelEntries` and the store's `objectWillChange` (fired by
    /// `save()` inside replaceEntries) refreshes the UI — no app restart needed.
    private static let voiceModalityMigrationKey = "voiceModalityMigration.v1.done"
    func migrateVoiceModalityIfNeeded() {
        guard !UserDefaults.standard.bool(forKey: Self.voiceModalityMigrationKey) else { return }
        UserDefaults.standard.set(true, forKey: Self.voiceModalityMigrationKey)

        // Third-party OpenAI-compat instances are the affected population (covers
        // MiMo/DashScope and any similar mixed vendor); official OpenAI/OpenRouter
        // hosts were never mis-classified, so skip them.
        let affected = config.instances.filter { inst in
            inst.isEnabled
            && (inst.providerType == .openAI || inst.providerType == .openAIResponses)
            && Self.isThirdPartyOpenAICompat(inst)
        }
        guard !affected.isEmpty else {
            logger.info("[VoiceMigrate] one-time refresh: no affected third-party OpenAI-compat instances")
            return
        }
        logger.info("[VoiceMigrate] one-time refresh: FIRE for \(affected.count) instance(s): [\(affected.map { $0.label }.joined(separator: ","))]")
        // Force the manual-refresh path (does NOT skip instances with custom
        // models — the affected users often re-added custom text models). Each
        // instance in its own Task so one failure never blocks the others.
        for instance in affected {
            Task { [weak self] in
                await self?.refreshModels(for: instance)
                logger.info("[VoiceMigrate] one-time refresh done: instance=\(instance.label) hasVoiceModels=\(self?.hasVoiceModels(for: instance.id) ?? false)")
            }
        }
    }

    /// [T-codex-live-models] 升级到读实时目录的这一版后,把已登录的 ChatGPT(OAuth)实例立即刷新一次:
    /// 不等每日刷新,GPT-6 这类新模型装完就出现在列表里。只跑一次。
    private static let codexLiveCatalogMigrationKey = "codexLiveCatalogMigration.v1.done"
    func refreshCodexCatalogOnceIfNeeded() {
        guard !UserDefaults.standard.bool(forKey: Self.codexLiveCatalogMigrationKey) else { return }
        let targets = config.instances.filter {
            $0.isEnabled && $0.providerType == .openAI && $0.credentialType == .oauth && $0.effectiveCustomBaseURL == nil
        }
        Task { [weak self] in
            guard let self else { return }
            var allOK = true
            for instance in targets where !(await self.refreshModels(for: instance)) { allOK = false }
            // 只有都成功了才记"做过":开机刚好离线,下次启动再试。
            if allOK { UserDefaults.standard.set(true, forKey: Self.codexLiveCatalogMigrationKey) }
        }
    }

    /// Refresh models for all enabled provider instances.
    /// Called on first daily launch to keep model lists up-to-date.
    /// Skips instances where the user has manually added custom models.
    func refreshAllModelsIfNeeded() {
        let key = "lastModelsRefreshDate"
        let lastRefresh = UserDefaults.standard.object(forKey: key) as? Date
        let calendar = Calendar.current
        let lastStr = lastRefresh.map { ISO8601DateFormatter().string(from: $0) } ?? "nil"

        if let lastRefresh, calendar.isDateInToday(lastRefresh) {
            logger.info("[ModelList] refreshAllModelsIfNeeded: SKIP — already refreshed today (lastRefresh=\(lastStr))")
            return
        }

        let enabledInstances = config.instances.filter(\.isEnabled)
        guard !enabledInstances.isEmpty else {
            logger.info("[ModelList] refreshAllModelsIfNeeded: SKIP — no enabled instances")
            return
        }

        logger.info("[ModelList] refreshAllModelsIfNeeded: FIRE — lastRefresh=\(lastStr) instanceCount=\(enabledInstances.count) instances=[\(enabledInstances.map { $0.label }.joined(separator: ","))]")
        UserDefaults.standard.set(Date(), forKey: key)

        for instance in enabledInstances {
            Task {
                await autoRefreshModels(for: instance)
            }
        }
    }

    /// For existing users who have providers but no model groups, silently create a "Default Models"
    /// group using the past week's most-used model (or the first visible entry as fallback).
    func createDefaultGroupIfNeeded() async {
        guard !config.instances.isEmpty, config.modelGroups.isEmpty else { return }

        let cutoff = Date().addingTimeInterval(-7 * 24 * 3600)
        let topModelId = await ChatStore.shared.fetchMostUsedModelId(since: cutoff)

        let entry: ModelEntry?
        if let modelId = topModelId {
            entry = config.modelEntries.first { !$0.isHidden && $0.model.id == modelId }
        } else {
            entry = config.modelEntries.first { !$0.isHidden }
        }

        guard let entry else { return }

        let group = ModelGroup(
            name: "Default Models",
            memberEntryIds: [entry.id],
            strategy: .fallback
        )
        config.modelGroups.append(group)
        config.defaultPrimaryGroupId = group.id
        save()
        logger.info("Created default model group with \(entry.model.displayName)")
    }

    /// Fetch the model list from a provider's API for the given instance.
    static func fetchModelsForInstance(_ instance: ProviderInstance, forceRefresh: Bool = false) async throws -> [LLMModel] {
        // One Keychain read decides both the credential and the base URL.
        let manualToken = instance.storedManualToken()
        let customBase = instance.effectiveCustomBaseURL(manualToken: manualToken)
        let appendV1 = instance.appendV1Suffix
        // Custom UA only for custom-base OpenAI/Anthropic-compat instances (proxy/relay);
        // OAuth-login paths keep their required client UA, so we never pass it there.
        let ua = instance.supportsCustomUserAgent(manualToken: manualToken) ? instance.effectiveCustomUserAgent : nil
        switch (instance.providerType, instance.credentialType) {
        case (.anthropic, .apiKey):
            guard let key = ProviderKeychainHelper.loadAPIKey(instanceId: instance.id) else {
                throw ModelRefreshError.noCredential
            }
            // Same auth as chat: a custom base also gets `Authorization: Bearer`.
            return try await AnthropicModelsAPI.fetchModels(apiKey: key, baseURL: customBase, appendV1Suffix: appendV1, forceRefresh: forceRefresh, userAgent: ua, alsoSendBearer: customBase != nil)
        case (.anthropic, .oauth):
            if let manualToken {
                // Manual token — try Bearer auth first, fall back to x-api-key for compatibility
                return try await AnthropicModelsAPI.fetchModels(bearerToken: manualToken, baseURL: customBase, appendV1Suffix: appendV1, forceRefresh: forceRefresh, userAgent: ua)
            }
            throw ModelRefreshError.noCredential
        case (.gemini, .apiKey):
            guard let key = ProviderKeychainHelper.loadAPIKey(instanceId: instance.id) else {
                throw ModelRefreshError.noCredential
            }
            return try await GeminiModelsAPI.fetchModels(apiKey: key, customBaseURL: customBase, forceRefresh: forceRefresh)
        case (.gemini, .oauth):
            if let manualToken {
                return try await GeminiModelsAPI.fetchModels(apiKey: manualToken, customBaseURL: customBase, forceRefresh: forceRefresh)
            }
            throw ModelRefreshError.noCredential
        case (.openAI, .apiKey):
            guard let key = ProviderKeychainHelper.loadAPIKey(instanceId: instance.id) else {
                throw ModelRefreshError.noCredential
            }
            return try await OpenAIModelsAPI.fetchModels(apiKey: key, baseURL: customBase, appendV1Suffix: appendV1, forceRefresh: forceRefresh, userAgent: ua)
        case (.openAI, .oauth):
            if let manualToken {
                return try await OpenAIModelsAPI.fetchModels(apiKey: manualToken, baseURL: customBase, appendV1Suffix: appendV1, forceRefresh: forceRefresh, userAgent: ua)
            }
            let hasModels = await MainActor.run { !ProviderConfigStore.shared.visibleEntries(for: instance.id).isEmpty }
            return try await OpenAIModelsAPI.fetchModelsCodexOAuth(
                instanceId: instance.id, forceRefresh: forceRefresh, instanceHasModels: hasModels)
        case (.openCodeGo, _):
            guard let key = ProviderKeychainHelper.loadAPIKey(instanceId: instance.id) else {
                throw ModelRefreshError.noCredential
            }
            return try await OpenCodeGo.fetchModels(apiKey: key, forceRefresh: forceRefresh)
        case (.openRouter, .apiKey):
            guard let key = ProviderKeychainHelper.loadAPIKey(instanceId: instance.id) else {
                throw ModelRefreshError.noCredential
            }
            return try await OpenRouterModelsAPI.fetchModels(apiKey: key, forceRefresh: forceRefresh)
        case (.openRouter, .oauth):
            if let manualToken {
                return try await OpenRouterModelsAPI.fetchModels(apiKey: manualToken, forceRefresh: forceRefresh)
            }
            // OpenRouter OAuth produces a permanent API key stored via ProviderKeychainHelper.saveAPIKey
            guard let key = ProviderKeychainHelper.loadAPIKey(instanceId: instance.id) else {
                throw ModelRefreshError.noCredential
            }
            return try await OpenRouterModelsAPI.fetchModels(apiKey: key, forceRefresh: forceRefresh)
        case (.openAIResponses, .apiKey):
            guard let key = ProviderKeychainHelper.loadAPIKey(instanceId: instance.id) else {
                throw ModelRefreshError.noCredential
            }
            return try await OpenAIModelsAPI.fetchModels(apiKey: key, baseURL: customBase, appendV1Suffix: appendV1, forceRefresh: forceRefresh, userAgent: ua)
        case (.openAIResponses, .oauth):
            // Responses API provider type only supports API key auth
            return ModelsDevAPI.enrichModels(ProviderType.openAIResponses.builtInModels)
        case (.xAI, .apiKey):
            guard let key = ProviderKeychainHelper.loadAPIKey(instanceId: instance.id) else {
                throw ModelRefreshError.noCredential
            }
            let xaiBase = customBase ?? "https://api.x.ai/v1"
            let xaiAppendV1 = customBase == nil ? false : appendV1
            return try await OpenAIModelsAPI.fetchModels(apiKey: key, baseURL: xaiBase, appendV1Suffix: xaiAppendV1, forceRefresh: forceRefresh, userAgent: ua)
        case (.xAI, .oauth):
            let token: String
            // Custom UA and custom base apply only to the manual-token (relay)
            // sub-case; signed-in tokens go to the official endpoint only.
            var xaiUA: String? = nil
            var xaiBase = "https://api.x.ai/v1"
            var xaiAppendV1 = false
            switch XAICredentialSource.resolve(instanceId: instance.id, manualToken: manualToken) {
            case .viaMac:
                token = try await GrokViaMacBroker.shared.token(instanceId: instance.id)
            case .oauthLogin:
                token = try await XAIOAuthManager.shared.validAccessToken(instanceId: instance.id)
            case .manualToken(let manualToken):
                token = manualToken
                xaiUA = ua
                if let customBase {
                    xaiBase = customBase
                    xaiAppendV1 = appendV1
                }
            case .none:
                throw ModelRefreshError.noCredential
            }
            let fetched = (try? await OpenAIModelsAPI.fetchModels(apiKey: token, baseURL: xaiBase, appendV1Suffix: xaiAppendV1, forceRefresh: forceRefresh, userAgent: xaiUA)) ?? []
            // OpenMinis keeps the complete built-in OAuth catalog available;
            // live /models entries enrich it but never shrink the picker.
            var liveById: [String: LLMModel] = [:]
            for model in fetched where liveById[model.id] == nil { liveById[model.id] = model }
            return ModelsDevAPI.enrichModels(XAIModelsAPI.allModels.map { liveById[$0.id] ?? $0 } + fetched.filter { live in
                !XAIModelsAPI.allModels.contains(where: { $0.id == live.id })
            })
        case (.kimiCode, .apiKey):
            guard let key = ProviderKeychainHelper.loadAPIKey(instanceId: instance.id) else {
                throw ModelRefreshError.noCredential
            }
            let kimiBase = customBase ?? "https://api.kimi.com/coding"
            let kimiAppendV1 = customBase == nil ? true : appendV1  // default base …/coding needs /v1 appended
            return try await OpenAIModelsAPI.fetchModels(apiKey: key, baseURL: kimiBase, appendV1Suffix: kimiAppendV1, forceRefresh: forceRefresh, userAgent: ua)
        case (.kimiCode, .oauth):
            // Signed-in tokens go to the official endpoint only.
            let token = try await KimiOAuthManager.shared.validAccessToken(instanceId: instance.id)
            return try await OpenAIModelsAPI.fetchModels(apiKey: token, baseURL: "https://api.kimi.com/coding", appendV1Suffix: true, forceRefresh: forceRefresh, userAgent: nil)
        case (.unsupported, _):
            // Synced from a newer build — can't fetch; keep whatever's stored.
            return []
        }
    }

    /// Result of a model fetch with fallback — includes diagnostic warnings for each step.
    struct ModelFetchResult {
        let models: [LLMModel]
        let source: String            // "api", "models.dev", or "none"
        let warnings: [String]        // Diagnostic messages from each failed step
    }

    /// Whether the instance uses a third-party (non-official) OpenAI-compatible base URL
    /// (e.g. vLLM, Ollama, LiteLLM). For these endpoints, we must never fall back to
    /// built-in GPT model lists when the API is unreachable — keep existing models instead.
    /// Decode a raw OpenAI OAuth token response (snake_case keys, `expire_at`
    /// as epoch-ms) into a `CodexTokenStorage`. Used when importing a provider
    /// exported from Android, which stores the raw OAuth JSON rather than the
    /// iOS-native camelCase `CodexTokenStorage` encoding.
    private static func decodeCodexTokenFromRawOAuth(_ blob: Data) -> CodexTokenStorage? {
        guard let json = try? JSONSerialization.jsonObject(with: blob) as? [String: Any],
              let accessToken = json["access_token"] as? String else { return nil }
        let refreshToken = json["refresh_token"] as? String
        let idToken = json["id_token"] as? String
        let expireDate = expireDateFromRawOAuth(json)
        var accountId: String?
        var planType: String?
        if let idToken, let payload = CodexOAuthManager.decodeJWTPayload(idToken) {
            let auth = payload["https://api.openai.com/auth"] as? [String: Any]
            accountId = auth?["chatgpt_account_id"] as? String
            planType = auth?["chatgpt_plan_type"] as? String
        }
        return CodexTokenStorage(
            accessToken: accessToken,
            refreshToken: refreshToken,
            idToken: idToken,
            expireDate: expireDate,
            lastRefresh: Date(),
            accountId: accountId,
            planType: planType
        )
    }

    /// Parse an Android-exported raw OAuth JSON into `XAITokenStorage`.
    private static func decodeXAITokenFromRawOAuth(_ blob: Data) -> XAITokenStorage? {
        guard let json = try? JSONSerialization.jsonObject(with: blob) as? [String: Any],
              let accessToken = json["access_token"] as? String else { return nil }
        return XAITokenStorage(
            accessToken: accessToken,
            refreshToken: json["refresh_token"] as? String,
            idToken: json["id_token"] as? String,
            expireDate: expireDateFromRawOAuth(json),
            lastRefresh: Date(),
            tokenEndpoint: json["token_endpoint"] as? String,
            email: json["email"] as? String,
            displayName: json["display_name"] as? String ?? json["displayName"] as? String,
            accountId: json["account_id"] as? String
        )
    }

    private static func expireDateFromRawOAuth(_ json: [String: Any]) -> Date? {
        if let ms = json["expire_at"] as? Double { return Date(timeIntervalSince1970: ms / 1000) }
        if let secs = json["expires_in"] as? Double { return Date(timeIntervalSinceNow: secs) }
        return nil
    }

    private static func isThirdPartyOpenAICompat(_ instance: ProviderInstance) -> Bool {
        guard let custom = instance.effectiveCustomBaseURL?.lowercased() else { return false }
        let officialHosts = ["api.openai.com", "chatgpt.com", "openrouter.ai"]
        return !officialHosts.contains(where: { custom.contains($0) })
    }

    /// Fetch models from the provider API, falling back to models.dev when the API
    /// returns an empty list or fails (e.g. custom base URL without /v1/models support).
    static func fetchModelsWithFallback(_ instance: ProviderInstance, forceRefresh: Bool = false) async throws -> ModelFetchResult {
        var warnings: [String] = []
        let isThirdParty = isThirdPartyOpenAICompat(instance)

        // Step 1: Try /v1/models API
        do {
            let models = try await fetchModelsForInstance(instance, forceRefresh: forceRefresh)
            if !models.isEmpty {
                return ModelFetchResult(models: models, source: "api", warnings: [])
            }
            let msg = "API returned empty model list"
            warnings.append(msg)
            logger.info("\(msg) for \(instance.label)")
        } catch let error as ModelRefreshError {
            throw error  // No credential — don't attempt fallback
        } catch {
            let msg = "API fetch failed: \(error.localizedDescription)"
            warnings.append(msg)
            logger.info("\(msg) for \(instance.label)")
            // Third-party endpoints (vLLM, Ollama, etc.): do not fall back to
            // built-in GPT models — keep the previously fetched list intact.
            if isThirdParty {
                logger.info("Third-party endpoint unreachable, preserving existing models for \(instance.label)")
                throw ModelRefreshError.modelsDevNoMatch(warnings: warnings)
            }
        }

        // Step 2: Try models.dev fallback (skip for third-party endpoints)
        let baseURL = modelsDevBaseURL(for: instance)
        guard let baseURL else {
            let msg = "No base URL resolved, cannot try models.dev"
            warnings.append(msg)
            logger.info("\(msg) for \(instance.label)")
            if isThirdParty {
                throw ModelRefreshError.modelsDevNoMatch(warnings: warnings)
            }
            // Fall back to built-in models
            let builtIn = ModelsDevAPI.enrichModels(instance.providerType.builtInModels)
            if !builtIn.isEmpty {
                logger.info("Using \(builtIn.count) built-in models for \(instance.label)")
                return ModelFetchResult(models: builtIn, source: "built-in", warnings: warnings)
            }
            throw ModelRefreshError.modelsDevNoMatch(warnings: warnings)
        }

        logger.info("models.dev fallback: matching baseURL=\(baseURL) for \(instance.label)")
        let fallbackModels = ModelsDevAPI.fetchModels(forBaseURL: baseURL)
        if !fallbackModels.isEmpty {
            logger.info("models.dev fallback returned \(fallbackModels.count) models for \(instance.label)")
            return ModelFetchResult(models: fallbackModels, source: "models.dev", warnings: warnings)
        }
        let msg = "models.dev: no match for baseURL \(baseURL)"
        warnings.append(msg)
        logger.info("\(msg)")

        // Step 3: Fall back to provider's built-in models (skip for third-party endpoints)
        if isThirdParty {
            logger.info("Third-party endpoint, skipping built-in fallback for \(instance.label)")
            throw ModelRefreshError.modelsDevNoMatch(warnings: warnings)
        }
        let builtIn = ModelsDevAPI.enrichModels(instance.providerType.builtInModels)
        if !builtIn.isEmpty {
            logger.info("Using \(builtIn.count) built-in models for \(instance.label)")
            return ModelFetchResult(models: builtIn, source: "built-in", warnings: warnings)
        }

        throw ModelRefreshError.modelsDevNoMatch(warnings: warnings)
    }

    /// Resolve the effective API base URL for an instance (for models.dev matching).
    private static func modelsDevBaseURL(for instance: ProviderInstance) -> String? {
        if let custom = instance.effectiveCustomBaseURL {
            return custom
        }
        // Use the provider's well-known default base URL
        switch instance.providerType {
        case .anthropic: return "https://api.anthropic.com"
        case .openAI, .openAIResponses: return "https://api.openai.com"
        case .xAI: return "https://api.x.ai"
        case .kimiCode: return "https://api.kimi.com/coding"
        case .gemini: return "https://generativelanguage.googleapis.com"
        case .openRouter: return "https://openrouter.ai/api"
        case .openCodeGo: return OpenCodeGo.apiRoot
        case .unsupported: return nil // synced from newer build
        }
    }
}

// MARK: - Model Refresh Error

enum ModelRefreshError: LocalizedError {
    case noCredential
    case modelsDevNoMatch(warnings: [String])
    /// [T-codex-live-models] ChatGPT 登录的模型目录这次拉不到:保留现有模型,不拿内置清单覆盖。
    case catalogUnavailable(reason: String)

    var errorDescription: String? {
        switch self {
        case .catalogUnavailable(let reason):
            return "ChatGPT 模型目录暂时拉不到(\(reason)),已保留现有模型。"
        case .noCredential:
            return "No API key configured for this provider instance."
        case .modelsDevNoMatch(let warnings):
            let detail = warnings.isEmpty ? "" : "\n" + warnings.joined(separator: "\n")
            return "Could not fetch models from API or models.dev fallback.\(detail)"
        }
    }
}

// MARK: - Keychain Helper

enum ProviderKeychainHelper {
    private static let account = "api-key"

    /// UserDefaults key for the local "last saved at" timestamp of an API key.
    /// Used for iCloud sync LWW: when a newer device uploads a rotated key, receiving
    /// devices compare `remote.updatedAt` against this stamp to decide whether to
    /// overwrite the local Keychain entry.
    private static func apiKeySavedAtUDKey(instanceId: String) -> String {
        "providerKey.savedAt.\(instanceId)"
    }

    /// Timestamp of the last local save for this instance's API key, or
    /// `.distantPast` if never stamped (legacy entries written before this field existed).
    static func apiKeySavedAt(instanceId: String) -> Date {
        let ud = UserDefaults.standard
        if let ts = ud.object(forKey: apiKeySavedAtUDKey(instanceId: instanceId)) as? Date {
            return ts
        }
        return .distantPast
    }

    /// Stamp the "saved at" time for this instance's API key. Called automatically by
    /// `saveAPIKey`; exposed for the iCloud import path to record when a remote update
    /// won and was applied locally.
    static func stampAPIKeySavedAt(_ date: Date, instanceId: String) {
        UserDefaults.standard.set(date, forKey: apiKeySavedAtUDKey(instanceId: instanceId))
    }

    @discardableResult
    static func saveAPIKey(_ key: String, instanceId: String, caller: String = #function) -> Bool {
        let service = "com.leoyuan.leophoneagent.provider.\(instanceId)"
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service, kSecAttrAccount as String: account,
            kSecAttrSynchronizable as String: true]
        let attributes: [String: Any] = [kSecValueData as String: Data(key.utf8),
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlock]
        var status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            var addition = query
            addition.merge(attributes) { _, new in new }
            status = SecItemAdd(addition as CFDictionary, nil)
            if status == errSecDuplicateItem { status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary) }
        }
        guard status == errSecSuccess else { return false }
        var legacy = query
        legacy[kSecAttrSynchronizable as String] = false
        SecItemDelete(legacy as CFDictionary)
        stampAPIKeySavedAt(Date(), instanceId: instanceId)
        notifyAuthChanged(instanceId: instanceId)
        return true
    }

    static func loadAPIKey(instanceId: String, caller: String = #function) -> String? {
        let service = "com.leoyuan.leophoneagent.provider.\(instanceId)"
        // Try synchronizable first, then fallback to legacy
        let syncQuery: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecAttrSynchronizable as String: true,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var result: AnyObject?
        let syncStatus = SecItemCopyMatching(syncQuery as CFDictionary, &result)
        if syncStatus == errSecSuccess, let data = result as? Data {
            let s = String(data: data, encoding: .utf8)
            AppLogger(category: "Keychain").info("read apiKey instanceId=\(instanceId.prefix(8)) src=sync hit=\(s != nil) keyLen=\(s?.count ?? 0) caller=\(caller)")
            return s
        }
        // Fallback to legacy non-sync entry
        let legacyQuery: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        result = nil
        let legacyStatus = SecItemCopyMatching(legacyQuery as CFDictionary, &result)
        guard legacyStatus == errSecSuccess, let data = result as? Data else {
            AppLogger(category: "Keychain").info("read apiKey instanceId=\(instanceId.prefix(8)) hit=false syncStatus=\(syncStatus) legacyStatus=\(legacyStatus) caller=\(caller)")
            return nil
        }
        let s = String(data: data, encoding: .utf8)
        AppLogger(category: "Keychain").info("read apiKey instanceId=\(instanceId.prefix(8)) src=legacy hit=\(s != nil) keyLen=\(s?.count ?? 0) syncStatus=\(syncStatus) caller=\(caller)")
        return s
    }

    static func deleteAPIKey(instanceId: String, caller: String = #function) {
        let service = "com.leoyuan.leophoneagent.provider.\(instanceId)"
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        let s1 = SecItemDelete(query as CFDictionary)
        var syncQuery = query
        syncQuery[kSecAttrSynchronizable as String] = true
        let s2 = SecItemDelete(syncQuery as CFDictionary)
        // Clear the LWW stamp so any subsequent import (e.g. rebinding from another
        // device) isn't blocked by a stale "local is newer" comparison.
        UserDefaults.standard.removeObject(forKey: apiKeySavedAtUDKey(instanceId: instanceId))
        AppLogger(category: "Keychain").info("delete apiKey instanceId=\(instanceId.prefix(8)) legacyStatus=\(s1) syncStatus=\(s2) caller=\(caller)")
        notifyAuthChanged(instanceId: instanceId)
    }

    // MARK: - OAuth Token (per-instance)

    /// Called at the end of every credential write/delete. Bumps `authRevision`
    /// (invalidates the L1 resolveCurrentEntry cache) and drops this instance's
    /// L2 credential cache entry so the next `hasAnyCredential` re-reads Keychain.
    /// [T-new-session-hang-credential-cache]
    private static func notifyAuthChanged(instanceId: String) {
        ProviderCredentialCache.shared.invalidate(instanceId)
        Task { @MainActor in ProviderConfigStore.shared.authRevision &+= 1 }
    }

    /// Signed-in OAuth tokens stay on this device: they are refresh-rotated, so
    /// an iCloud-synced copy on a second device goes stale and its refresh would
    /// race this one. (Pasted manual tokens and API keys still sync.)
    ///
    /// Older builds (≤ 1.46.x) kept the token in iCloud Keychain. Each instance
    /// adopts that copy once (`migrateOAuthTokenToDeviceOnly`); after that only
    /// the device-only item is read, written or deleted, and an iCloud copy is
    /// left to the devices still on an older build — so a refresh here doesn't
    /// sign them out, and their fresh sign-in isn't pulled over to this device.
    static func saveOAuthToken<T: Codable>(_ token: T, instanceId: String, caller: String = #function) {
        guard let data = try? JSONEncoder().encode(token) else {
            AppLogger(category: "Keychain").warning("write oauthToken instanceId=\(instanceId.prefix(8)) ENCODE FAILED caller=\(caller)")
            return
        }
        migrationLock.lock()
        let addStatus = writeDeviceOnlyOAuthToken(data, instanceId: instanceId)
        // This device now has its own token; never adopt an iCloud copy over it.
        if addStatus == errSecSuccess { markOAuthTokenDeviceOnly(instanceId: instanceId) }
        migrationLock.unlock()
        AppLogger(category: "Keychain").info("write oauthToken instanceId=\(instanceId.prefix(8)) blobLen=\(data.count) addStatus=\(addStatus) caller=\(caller)")
        notifyAuthChanged(instanceId: instanceId)
    }

    private static func oauthTokenBaseQuery(instanceId: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: "com.leoyuan.leophoneagent.provider.\(instanceId)",
            kSecAttrAccount as String: "oauth-token",
        ]
    }

    /// Set once this device has adopted (or found no) iCloud copy of the
    /// instance's sign-in token. Removed with the instance.
    private static func deviceOnlyMigratedKey(instanceId: String) -> String {
        "oauthToken.deviceOnlyMigrated.\(instanceId)"
    }

    static func isOAuthTokenDeviceOnly(instanceId: String) -> Bool {
        UserDefaults.standard.bool(forKey: deviceOnlyMigratedKey(instanceId: instanceId))
    }

    private static func markOAuthTokenDeviceOnly(instanceId: String) {
        UserDefaults.standard.set(true, forKey: deviceOnlyMigratedKey(instanceId: instanceId))
    }

    static func forgetOAuthTokenMigration(instanceId: String) {
        UserDefaults.standard.removeObject(forKey: deviceOnlyMigratedKey(instanceId: instanceId))
    }

    /// Serializes the one-time adoption against token saves, so a migration
    /// can't write an older iCloud token over one a refresh just saved.
    private static let migrationLock = NSLock()

    /// Whether a sign-in token item exists on this device or in iCloud Keychain.
    static func hasAnyOAuthTokenCopy(instanceId: String) -> Bool {
        readOAuthTokenData(instanceId: instanceId, synchronizable: false).0 != nil
            || readOAuthTokenData(instanceId: instanceId, synchronizable: true).0 != nil
    }

    /// Updates the device-only item in place (atomic: no window where a kill
    /// loses the token), adding it when absent. Never touches iCloud copies.
    private static func writeDeviceOnlyOAuthToken(_ data: Data, instanceId: String) -> OSStatus {
        var match = oauthTokenBaseQuery(instanceId: instanceId)
        match[kSecAttrSynchronizable as String] = false
        let attributes: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        let updateStatus = SecItemUpdate(match as CFDictionary, attributes as CFDictionary)
        switch updateStatus {
        case errSecSuccess, errSecInteractionNotAllowed:
            // Locked (before first unlock): keep what is stored.
            return updateStatus
        case errSecItemNotFound:
            break
        default:
            // Could not update in place (an item an older build wrote with
            // other attributes); replace it.
            SecItemDelete(match as CFDictionary)
        }
        var addQuery = match
        addQuery.merge(attributes) { _, new in new }
        return SecItemAdd(addQuery as CFDictionary, nil)
    }

    private static func readOAuthTokenData(instanceId: String, synchronizable: Bool) -> (Data?, OSStatus) {
        var query = oauthTokenBaseQuery(instanceId: instanceId)
        query[kSecAttrSynchronizable as String] = synchronizable
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        return (status == errSecSuccess ? result as? Data : nil, status)
    }

    /// One-time per instance: moves a token an older build kept in iCloud
    /// Keychain to device-only storage. The device-only copy is written before
    /// the iCloud one is deleted, so a kill in between loses nothing. Returns
    /// the token data now in device-only storage; nil once migrated with no
    /// device-only token (an iCloud copy is then never adopted).
    @discardableResult
    static func migrateOAuthTokenToDeviceOnly(instanceId: String) -> Data? {
        migrationLock.lock()
        defer { migrationLock.unlock() }
        let (local, _) = readOAuthTokenData(instanceId: instanceId, synchronizable: false)
        guard !isOAuthTokenDeviceOnly(instanceId: instanceId) else { return local }
        if let local {
            // This device already has its own token; an iCloud copy belongs to
            // a device still on an older build and is left alone.
            markOAuthTokenDeviceOnly(instanceId: instanceId)
            return local
        }
        let (synced, syncedStatus) = readOAuthTokenData(instanceId: instanceId, synchronizable: true)
        guard let synced else {
            // Only a definite "none" counts; a locked Keychain retries later.
            if syncedStatus == errSecItemNotFound { markOAuthTokenDeviceOnly(instanceId: instanceId) }
            return nil
        }
        let addStatus = writeDeviceOnlyOAuthToken(synced, instanceId: instanceId)
        guard addStatus == errSecSuccess else {
            AppLogger(category: "Keychain").warning("migrate oauthToken instanceId=\(instanceId.prefix(8)) toDeviceOnly addStatus=\(addStatus); iCloud copy kept")
            return synced
        }
        var syncDelete = oauthTokenBaseQuery(instanceId: instanceId)
        syncDelete[kSecAttrSynchronizable as String] = true
        let deleteStatus = SecItemDelete(syncDelete as CFDictionary)
        markOAuthTokenDeviceOnly(instanceId: instanceId)
        AppLogger(category: "Keychain").info("migrate oauthToken instanceId=\(instanceId.prefix(8)) toDeviceOnly addStatus=\(addStatus) syncDeleteStatus=\(deleteStatus)")
        return synced
    }

    static func loadOAuthToken<T: Codable>(instanceId: String, as type: T.Type, caller: String = #function) -> T? {
        let (local, localStatus) = readOAuthTokenData(instanceId: instanceId, synchronizable: false)
        let data = local ?? migrateOAuthTokenToDeviceOnly(instanceId: instanceId)
        guard let data else {
            AppLogger(category: "Keychain").info("read oauthToken instanceId=\(instanceId.prefix(8)) hit=false localStatus=\(localStatus) caller=\(caller)")
            return nil
        }
        let decoded = try? JSONDecoder().decode(type, from: data)
        AppLogger(category: "Keychain").info("read oauthToken instanceId=\(instanceId.prefix(8)) src=\(local != nil ? "local" : "migrated") hit=true decoded=\(decoded != nil) caller=\(caller)")
        return decoded
    }

    /// Deletes this device's sign-in token. The iCloud copy an older build
    /// wrote is deleted too only while the instance hasn't migrated yet.
    static func deleteOAuthToken(instanceId: String, caller: String = #function) {
        deleteOAuthToken(instanceId: instanceId, includingICloudCopy: !isOAuthTokenDeviceOnly(instanceId: instanceId), caller: caller)
    }

    /// `includingICloudCopy: true` also deletes the iCloud copy: only for
    /// credentials of retired sign-in methods, which no build uses any more.
    static func deleteOAuthToken(instanceId: String, includingICloudCopy: Bool, caller: String = #function) {
        let service = "com.leoyuan.leophoneagent.provider.\(instanceId)"
        let acct = "oauth-token"
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: acct,
        ]
        let s1 = SecItemDelete(query as CFDictionary)
        var s2: OSStatus = errSecItemNotFound
        if includingICloudCopy {
            var syncQuery = query
            syncQuery[kSecAttrSynchronizable as String] = true
            s2 = SecItemDelete(syncQuery as CFDictionary)
        }
        AppLogger(category: "Keychain").info("delete oauthToken instanceId=\(instanceId.prefix(8)) legacyStatus=\(s1) syncStatus=\(s2) includeICloud=\(includingICloudCopy) caller=\(caller)")
        notifyAuthChanged(instanceId: instanceId)
    }

    // MARK: - OAuth Strings (per-instance, e.g. email, project ID)

    static func saveOAuthString(_ value: String, instanceId: String, account: String, caller: String = #function) {
        let service = "com.leoyuan.leophoneagent.provider.\(instanceId)"
        let deleteQuery: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        SecItemDelete(deleteQuery as CFDictionary)
        var syncDelete = deleteQuery
        syncDelete[kSecAttrSynchronizable as String] = true
        SecItemDelete(syncDelete as CFDictionary)
        var addQuery = deleteQuery
        addQuery[kSecValueData as String] = Data(value.utf8)
        addQuery[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        addQuery[kSecAttrSynchronizable as String] = true
        let addStatus = SecItemAdd(addQuery as CFDictionary, nil)
        AppLogger(category: "Keychain").info("write oauthString instanceId=\(instanceId.prefix(8)) acct=\(account) valLen=\(value.count) addStatus=\(addStatus) caller=\(caller)")
        notifyAuthChanged(instanceId: instanceId)
    }

    static func loadOAuthString(instanceId: String, account: String, caller: String = #function) -> String? {
        let service = "com.leoyuan.leophoneagent.provider.\(instanceId)"
        // Try synchronizable first
        let syncQuery: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecAttrSynchronizable as String: true,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var result: AnyObject?
        let syncStatus = SecItemCopyMatching(syncQuery as CFDictionary, &result)
        if syncStatus == errSecSuccess, let data = result as? Data {
            let s = String(data: data, encoding: .utf8)
            AppLogger(category: "Keychain").info("read oauthString instanceId=\(instanceId.prefix(8)) acct=\(account) src=sync hit=\(s != nil) valLen=\(s?.count ?? 0) caller=\(caller)")
            return s
        }
        // Fallback to legacy
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        let legacyStatus = SecItemCopyMatching(query as CFDictionary, &result)
        guard legacyStatus == errSecSuccess, let data = result as? Data else {
            AppLogger(category: "Keychain").info("read oauthString instanceId=\(instanceId.prefix(8)) acct=\(account) hit=false syncStatus=\(syncStatus) legacyStatus=\(legacyStatus) caller=\(caller)")
            return nil
        }
        let s = String(data: data, encoding: .utf8)
        AppLogger(category: "Keychain").info("read oauthString instanceId=\(instanceId.prefix(8)) acct=\(account) src=legacy hit=\(s != nil) valLen=\(s?.count ?? 0) syncStatus=\(syncStatus) caller=\(caller)")
        return s
    }

    static func deleteOAuthString(instanceId: String, account: String, caller: String = #function) {
        let service = "com.leoyuan.leophoneagent.provider.\(instanceId)"
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        let s1 = SecItemDelete(query as CFDictionary)
        var syncQuery = query
        syncQuery[kSecAttrSynchronizable as String] = true
        let s2 = SecItemDelete(syncQuery as CFDictionary)
        AppLogger(category: "Keychain").info("delete oauthString instanceId=\(instanceId.prefix(8)) acct=\(account) legacyStatus=\(s1) syncStatus=\(s2) caller=\(caller)")
        notifyAuthChanged(instanceId: instanceId)
    }
}
