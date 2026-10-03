import Foundation

/// Read-only projection shared by model pickers. It never renames a provider,
/// rewrites a model identifier, or changes persisted selection/routing state.
enum ModelCatalog {
    /// A deterministic representative for duplicate rows of the SAME provider
    /// and model. Different provider instances must remain separate choices.
    static func representative(_ entries: [ModelEntry]) -> ModelEntry? {
        if entries.count == 1 { return entries[0] }
        guard var result = entries.sorted(by: {
            if $0.isCustom != $1.isCustom { return !$0.isCustom }
            return $0.uuid < $1.uuid
        }).first else { return nil }
        if entries.allSatisfy({ $0.userModifiedAt == nil }) {
            // Legacy duplicates have no reliable "latest edit". Preserve each
            // known override and any hidden intent instead of letting a blank
            // custom row silently erase another device's settings.
            for entry in entries.sorted(by: { $0.uuid < $1.uuid }) {
                result.overrides.displayName = result.overrides.displayName ?? entry.overrides.displayName
                result.overrides.maxOutputTokens = result.overrides.maxOutputTokens ?? entry.overrides.maxOutputTokens
                result.overrides.modalityOverride = result.overrides.modalityOverride ?? entry.overrides.modalityOverride
                result.overrides.contextWindow = result.overrides.contextWindow ?? entry.overrides.contextWindow
                result.overrides.supportsReasoning = result.overrides.supportsReasoning ?? entry.overrides.supportsReasoning
                result.overrides.maxThinkingLevel = result.overrides.maxThinkingLevel ?? entry.overrides.maxThinkingLevel
                result.isHidden = result.isHidden || entry.isHidden
            }
            return result
        }
        let overlay = entries.sorted {
            let a = $0.userModifiedAt ?? .distantPast
            let b = $1.userModifiedAt ?? .distantPast
            if a != b { return a > b }
            if $0.isUserModified != $1.isUserModified { return $0.isUserModified }
            return $0.uuid < $1.uuid
        }.first!
        result.overrides = overlay.overrides
        result.isHidden = overlay.isHidden
        result.userModifiedAt = overlay.userModifiedAt
        return result
    }

    /// Provider order is the user's persisted order. API response order and
    /// asynchronous refresh completion must not rearrange the list.
    static func entries(_ entries: [ModelEntry], providerOrder: [String]) -> [ModelEntry] {
        let ranks = Dictionary(providerOrder.enumerated().map { ($0.element, $0.offset) },
                               uniquingKeysWith: { first, _ in first })
        return Dictionary(grouping: entries, by: \.id).values
            .compactMap { representative($0) }
            .sorted {
                let a = ranks[$0.providerInstanceId] ?? Int.max
                let b = ranks[$1.providerInstanceId] ?? Int.max
                if a != b { return a < b }
                if $0.providerInstanceId != $1.providerInstanceId {
                    return $0.providerInstanceId < $1.providerInstanceId
                }
                return $0.baseModel.id < $1.baseModel.id
            }
    }

    /// Resolve all historical reference forms without parsing model ids: model
    /// identifiers themselves may contain '/' and ':'. Unknown keys survive
    /// temporary sync gaps and unavailable provider catalogs unchanged.
    static func aliases(entries: [ModelEntry]) -> [String: String] {
        var result: [String: String] = [:]
        for entry in entries.sorted(by: { $0.id < $1.id }) {
            result[entry.uuid] = entry.id
            result[entry.legacyColonCompositeKey] = entry.id
            result[entry.id] = entry.id
        }
        return result
    }

    static func normalizedKeys(_ keys: [String], entries: [ModelEntry]) -> [String] {
        normalizedKeys(keys, aliases: aliases(entries: entries))
    }

    static func normalizedKeys(_ keys: [String], aliases: [String: String]) -> [String] {
        var seen = Set<String>()
        return keys.compactMap {
            let key = aliases[$0] ?? $0
            return seen.insert(key).inserted ? key : nil
        }
    }

    static func orderedEntries(keys: [String], entries: [ModelEntry]) -> [ModelEntry] {
        let byID = Dictionary(grouping: entries, by: \.id).compactMapValues { representative($0) }
        return normalizedKeys(keys, entries: entries).compactMap { byID[$0] }
    }

    /// Whitespace-separated terms may match different fields. Searching an
    /// overridden name still finds the original API model id and provider.
    static func matches(_ query: String, entry: ModelEntry, providerLabel: String) -> Bool {
        matches(query, text: [entry.model.displayName, entry.baseModel.displayName,
                              entry.baseModel.id, providerLabel].joined(separator: " "))
    }

    static func matches(_ query: String, text: String) -> Bool {
        func normalized(_ value: String) -> String {
            value.folding(options: [.caseInsensitive, .diacriticInsensitive, .widthInsensitive],
                          locale: Locale(identifier: "en_US_POSIX"))
        }
        let target = normalized(text)
        return normalized(query).split(whereSeparator: \.isWhitespace)
            .allSatisfy { target.contains($0) }
    }

    /// Normalize known references only; an empty or temporarily unresolved
    /// custom group is user intent, never evidence that it should be deleted.
    static func normalizedGroup(_ group: ModelGroup, aliases: [String: String]) -> ModelGroup {
        var result = group
        result.memberEntryIds = normalizedKeys(group.memberEntryIds, aliases: aliases)
        func dates(_ input: [String: Date]) -> [String: Date] {
            var result: [String: Date] = [:]
            for (key, date) in input {
                let id = aliases[key] ?? key
                result[id] = max(result[id] ?? .distantPast, date)
            }
            return result
        }
        result.addedMembers = dates(group.addedMembers)
        result.removedMembers = dates(group.removedMembers)
        return result
    }

    /// Reorder a visible subset while keeping hidden/unavailable slots in
    /// place. Invalid or stale drag indices are harmless, never a crash.
    static func reorderedKeys(_ keys: [String], visibleKeys: [String],
                              from source: IndexSet, to destination: Int) -> [String] {
        guard !source.isEmpty, source.allSatisfy({ visibleKeys.indices.contains($0) }),
              (0...visibleKeys.count).contains(destination),
              Set(visibleKeys).count == visibleKeys.count,
              Set(visibleKeys).isSubset(of: Set(keys)) else { return keys }
        let moving = source.sorted().map { visibleKeys[$0] }
        var visible = visibleKeys.enumerated().filter { !source.contains($0.offset) }.map(\.element)
        visible.insert(contentsOf: moving, at: destination - source.filter { $0 < destination }.count)
        let visibleSet = Set(visibleKeys)
        var cursor = visible.makeIterator()
        return keys.map { visibleSet.contains($0) ? (cursor.next() ?? $0) : $0 }
    }
}

/// Local-only metadata backup for models omitted by a provider catalog. Archived
/// entries are never offered to a picker or router. No credentials are stored.
/// This is deliberately separate from provider-config.json and its sync schema.
enum ModelCatalogArchive {
    private struct Envelope: Codable {
        let version: Int
        let entries: [ModelEntry]
    }

    enum ArchiveError: Error { case unsupportedVersion(Int) }

    static func load(at url: URL) throws -> [ModelEntry] {
        guard FileManager.default.fileExists(atPath: url.path) else { return [] }
        let envelope = try JSONDecoder().decode(Envelope.self, from: Data(contentsOf: url))
        guard envelope.version == 1 else { throw ArchiveError.unsupportedVersion(envelope.version) }
        return envelope.entries
    }

    private static func save(_ entries: [ModelEntry], at url: URL) throws {
        let data = try JSONEncoder().encode(Envelope(version: 1, entries: entries))
        try data.write(to: url, options: .atomic)
    }

    struct Refresh {
        let entries: [ModelEntry]
        let aliases: [String: String]
    }

    /// Persist the prior identities/overlays BEFORE returning a replacement.
    /// Any corrupt/newer archive or failed atomic write aborts the whole refresh.
    static func refresh(instanceId: String, activeEntries: [ModelEntry], models: [LLMModel],
                        templateModels: [LLMModel] = [], forgottenEntryIds: Set<String> = [],
                        forgottenInstanceIds: Set<String> = [], at url: URL) throws -> Refresh {
        let archived = try load(at: url).filter {
            !forgottenEntryIds.contains($0.id) && !forgottenInstanceIds.contains($0.providerInstanceId)
        }
        var knownByID = Dictionary(uniqueKeysWithValues: ModelCatalog.entries(archived, providerOrder: []).map { ($0.id, $0) })
        for var active in ModelCatalog.entries(activeEntries, providerOrder: []) {
            // The active row owns identity/API metadata. Only a strictly newer
            // archived user edit may override it; equal/missing timestamps keep
            // the current row rather than resurrect an old cleared preference.
            if let saved = knownByID[active.id],
               (saved.userModifiedAt ?? .distantPast) > (active.userModifiedAt ?? .distantPast) {
                active.overrides = saved.overrides
                active.isHidden = saved.isHidden
                active.userModifiedAt = saved.userModifiedAt
            }
            knownByID[active.id] = active
        }
        let known = ModelCatalog.entries(Array(knownByID.values), providerOrder: [])
        let priorEntries = known.filter { $0.providerInstanceId == instanceId }
        let priors = Dictionary(uniqueKeysWithValues: priorEntries.map { ($0.baseModel.id, $0) })
        var seen = Set<String>()
        let models = models.filter { seen.insert($0.id).inserted }
        let templateVoice = templateModels.filter {
            ($0.modalityOverride ?? []).contains(.audioInput) || ($0.modalityOverride ?? []).contains(.audioOutput)
        }
        let voiceByID = Dictionary(templateVoice.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        var result = models.map { model -> ModelEntry in
            var metadata = model.withInferredModality()
            if let modality = voiceByID[model.id]?.modalityOverride { metadata = metadata.withModalityOverride(modality) }
            if let prior = priors[model.id] { return prior.replacingBaseModel(metadata, isCustom: false) }
            return ModelEntry(providerInstanceId: instanceId, model: metadata)
        }
        // Preserve the existing custom-model and voice-template exception. All
        // other omitted rows remain archive-only and therefore unavailable.
        result += priorEntries.filter { !seen.contains($0.baseModel.id) && ($0.isCustom || voiceByID[$0.baseModel.id] != nil) }
            .map { $0.replacingBaseModel($0.baseModel.withInferredModality()) }
        for entry in result { knownByID[entry.id] = entry }
        let archive = ModelCatalog.entries(Array(knownByID.values), providerOrder: [])
        try save(archive, at: url)
        return Refresh(entries: result, aliases: ModelCatalog.aliases(entries: activeEntries + archived + result))
    }

    /// Explicit deletion also forgets dormant metadata, preventing resurrection.
    @discardableResult
    static func remove(instanceIds: Set<String> = [], entryIds: Set<String> = [], at url: URL) throws -> [ModelEntry] {
        let entries = try load(at: url)
        let removed = entries.filter { instanceIds.contains($0.providerInstanceId) || entryIds.contains($0.id) }
        guard !removed.isEmpty else { return [] }
        let gone = Set(removed.map(\.id))
        try save(entries.filter { !gone.contains($0.id) }, at: url)
        return removed
    }
}

/// Serializes complete SQLite snapshots and alias writes from a main-actor
/// store. Later edits cannot reach the DB before an earlier suspended write.
@MainActor
final class ModelCatalogWriteQueue {
    private var tail: Task<Void, Never>?

    @discardableResult
    func enqueue(_ operation: @escaping @MainActor () async -> Void) -> Task<Void, Never> {
        let previous = tail
        let task = Task { @MainActor in
            await previous?.value
            await operation()
        }
        tail = task
        return task
    }

    func drain() async { await tail?.value }
}

/// A durable pending-mirror marker. JSON is the accepted local snapshot; a
/// pending marker tells the next launch to replay it before trusting SQLite.
enum ProviderSnapshotJournal {
    static func markerURL(for url: URL) -> URL { url.appendingPathExtension("pending-db") }

    static func pendingToken(for url: URL) -> String? {
        guard let data = try? Data(contentsOf: markerURL(for: url)) else { return nil }
        return String(data: data, encoding: .utf8)
    }

    static func write(_ data: Data, to url: URL) throws -> String {
        let token = UUID().uuidString
        // A crash between these two atomic writes replays the prior valid JSON;
        // it can never make an incomplete JSON file authoritative.
        try Data(token.utf8).write(to: markerURL(for: url), options: .atomic)
        try data.write(to: url, options: .atomic)
        return token
    }

    static func complete(_ token: String, for url: URL) {
        guard pendingToken(for: url) == token else { return }
        try? FileManager.default.removeItem(at: markerURL(for: url))
    }
}
