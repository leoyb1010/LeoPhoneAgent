import Foundation

private let logger = AppLogger(category: "SubAgentStore")

/// [T-subagent] The sub agent roster's own persistence (ported from upstream
/// iOS 1.14 `SubAgentStore`, `[T-subagent-own-store]`).
///
/// A `@MainActor` singleton over one atomic JSON file in `Library/MinisChat`.
/// Kept OUT of ProviderConfig on purpose: upstream lost every custom agent when
/// the provider config's SQLite mirror (which had no sub-agent table) overwrote
/// the JSON copy. LeoBot keeps the roster device-local for now — upstream's
/// per-record `SubAgentV3` sync is not ported (the sync lane owns CloudKit
/// record types), so nothing here marks records dirty.
@MainActor
final class SubAgentStore: ObservableObject {
    static let shared = SubAgentStore()

    /// The roster in disclosure order, built-in first, always normalized.
    @Published private(set) var subAgents: [SubAgentDefinition] = []

    private let fileURL: URL

    init(fileURL: URL? = nil) {
        if let fileURL {
            self.fileURL = fileURL
        } else {
            let libraryURL = FileManager.default.urls(for: .libraryDirectory, in: .userDomainMask).first!
            let baseURL = libraryURL.appendingPathComponent("MinisChat", isDirectory: true)
            try? FileManager.default.createDirectory(at: baseURL, withIntermediateDirectories: true)
            self.fileURL = baseURL.appendingPathComponent("sub-agents.json")
        }
        self.subAgents = Self.load(from: self.fileURL)
    }

    // MARK: - Persistence

    /// Never throws and never returns a roster without the built-in.
    private static func load(from url: URL) -> [SubAgentDefinition] {
        guard let data = try? Data(contentsOf: url) else { return SubAgentRoster.normalize([]) }
        guard let decoded = try? JSONDecoder().decode([SubAgentDefinition].self, from: data) else {
            logger.error("[SubAgents] sub-agents.json could not be decoded — falling back to the built-in only")
            return SubAgentRoster.normalize([])
        }
        return SubAgentRoster.normalize(decoded) { logger.warning("\($0)") }
    }

    private func persist() {
        do {
            let data = try JSONEncoder().encode(subAgents)
            try data.write(to: fileURL, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        } catch {
            logger.error("[SubAgents] failed to save sub-agents.json: \(error.localizedDescription)")
        }
    }

    // MARK: - Reads

    func subAgent(id: String) -> SubAgentDefinition? {
        subAgents.first { $0.id == id }
    }

    /// Whether another definition already uses this name (same fold the model
    /// resolution uses, so "taken" means "the model could not tell them apart").
    func subAgentNameIsTaken(_ name: String, excluding id: String?) -> Bool {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return false }
        return subAgents.contains {
            $0.id != id && SubAgentRoster.nameKey($0.name) == SubAgentRoster.nameKey(trimmed)
        }
    }

    var canAddSubAgent: Bool { subAgents.count < SubAgentLimits.maxCount }

    // MARK: - Mutations

    /// Insert or update one definition. Clamped on the way in. The built-in's
    /// name and description are canonical (they are what the model emits and
    /// reads), so only its model, thinking level and instructions change.
    @discardableResult
    func upsertSubAgent(_ definition: SubAgentDefinition) -> Bool {
        var list = subAgents
        var incoming = definition.clamped()
        incoming.updatedAt = Date()
        if incoming.isBuiltIn || incoming.id == SubAgentDefinition.builtInId {
            let canonical = SubAgentDefinition.makeBuiltIn()
            incoming.name = canonical.name
            incoming.description = canonical.description
        } else if subAgentNameIsTaken(incoming.name, excluding: incoming.id)
                    || incoming.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            logger.warning("[SubAgents] refusing to save a nameless or duplicate-name definition")
            return false
        }
        if let idx = list.firstIndex(where: { $0.id == incoming.id }) {
            incoming.sortOrder = list[idx].sortOrder
            list[idx] = incoming
        } else {
            guard list.count < SubAgentLimits.maxCount else {
                logger.warning("[SubAgents] refusing to add — roster already at \(SubAgentLimits.maxCount)")
                return false
            }
            incoming.sortOrder = list.count
            list.append(incoming)
        }
        subAgents = SubAgentRoster.normalize(list)
        persist()
        return true
    }

    /// Delete one definition. The built-in cannot be removed.
    func removeSubAgent(id: String) {
        guard id != SubAgentDefinition.builtInId else { return }
        var list = subAgents
        guard list.contains(where: { $0.id == id }) else { return }
        list.removeAll { $0.id == id }
        subAgents = SubAgentRoster.normalize(list)
        persist()
    }

    /// Reorder the custom entries; the built-in stays first.
    func reorderSubAgents(_ orderedIds: [String]) {
        let byId = Dictionary(uniqueKeysWithValues: subAgents.map { ($0.id, $0) })
        var list: [SubAgentDefinition] = []
        for id in orderedIds where id != SubAgentDefinition.builtInId {
            if let d = byId[id] { list.append(d) }
        }
        for d in subAgents where d.id != SubAgentDefinition.builtInId && !orderedIds.contains(d.id) {
            list.append(d)
        }
        for i in list.indices { list[i].sortOrder = i + 1 }
        subAgents = SubAgentRoster.normalize(list)
        persist()
    }

    /// A pinned group was deleted: the agent reverts to Auto.
    func clearModelGroup(_ groupId: String) {
        var list = subAgents
        var touched = false
        for i in list.indices where list[i].modelGroupId == groupId {
            list[i].modelGroupId = nil
            list[i].updatedAt = Date()
            touched = true
        }
        guard touched else { return }
        subAgents = SubAgentRoster.normalize(list)
        persist()
    }
}
