// TEST TARGET ONLY: deterministic local persistence, never user data.
import SwiftUI

@MainActor final class ProviderConfigStore: ObservableObject {
    static let shared = ProviderConfigStore()
    @Published var instances: [ProviderInstance] = [] { didSet { persist() } }
    @Published var modelEntries: [ModelEntry] = [] { didSet { persist() } }
    @Published var modelGroups: [ModelGroup] = [] { didSet { persist() } }
    @Published var defaultPrimaryGroupId: String? { didSet { persist() } }
    @Published var defaultSubGroupId: String? { didSet { persist() } }
    @Published var voiceInputGroupId: String? { didSet { persist() } }
    @Published var voiceOutputGroupId: String? { didSet { persist() } }
    @Published var agentLoopModelEntryIds: [String] = [] { didSet { persist() } }
    @Published var agentLoopGroupIds: [String] = [] { didSet { persist() } }
    @Published var sessionBindings: [String: SessionModelBinding] = [:] { didSet { persist() } }
    var deletedInstanceIds: Set<String> = []
    private var ready = false
    private var failNextGroupSave = false
    private var failNextEntrySave = false
    private let storageKey = "native-model-audit.fixture.v1"

    struct Snapshot: Codable {
        var instances: [ProviderInstance]
        var modelEntries: [ModelEntry]
        var modelGroups: [ModelGroup]
        var defaultPrimaryGroupId: String?
        var defaultSubGroupId: String?
        var voiceInputGroupId: String?
        var voiceOutputGroupId: String?
        var agentLoopModelEntryIds: [String]
        var agentLoopGroupIds: [String]
        var sessionBindings: [String: SessionModelBinding]
    }

    init() {
        let environment = ProcessInfo.processInfo.environment
        failNextGroupSave = environment["AUDIT_FAIL_NEXT_GROUP_SAVE"] == "1"
        failNextEntrySave = environment["AUDIT_FAIL_NEXT_ENTRY_SAVE"] == "1"
        if environment["AUDIT_RESET"] == "1" {
            UserDefaults.standard.removeObject(forKey: storageKey)
            UserDefaults.standard.removeObject(forKey: "leo.model.pinned.v1")
            UserDefaults.standard.removeObject(forKey: "leo.model.recents.v1")
        }
        if let data = UserDefaults.standard.data(forKey: storageKey),
           let saved = try? JSONDecoder().decode(Snapshot.self, from: data) {
            instances = saved.instances
            modelEntries = saved.modelEntries
            modelGroups = saved.modelGroups
            defaultPrimaryGroupId = saved.defaultPrimaryGroupId
            defaultSubGroupId = saved.defaultSubGroupId
            voiceInputGroupId = saved.voiceInputGroupId
            voiceOutputGroupId = saved.voiceOutputGroupId
            agentLoopModelEntryIds = saved.agentLoopModelEntryIds
            agentLoopGroupIds = saved.agentLoopGroupIds
            sessionBindings = saved.sessionBindings
        } else {
            seed(large: environment["AUDIT_LARGE"] == "1", empty: environment["AUDIT_EMPTY"] == "1")
        }
        ready = true
        persist()
        // Exercise the actual Codable models on the first launch too: the
        // fixture transport is serialized JSON, not an alternate model type.
        if let data = UserDefaults.standard.data(forKey: storageKey),
           let decoded = try? JSONDecoder().decode(Snapshot.self, from: data) {
            instances = decoded.instances
            modelEntries = decoded.modelEntries
            modelGroups = decoded.modelGroups
        }
    }

    private func seed(large: Bool, empty: Bool) {
        guard !empty else { return }
        instances = [
            ProviderInstance(id: "openai-direct", label: "OpenAI · Official", providerType: .openAI, credentialType: .apiKey),
            ProviderInstance(id: "anthropic-direct", label: "Anthropic · Official", providerType: .anthropic, credentialType: .apiKey),
            ProviderInstance(id: "relay-proxy", label: "Work Relay · Multi-provider", providerType: .openAI, credentialType: .apiKey, customBaseURL: "https://fixture.invalid"),
            ProviderInstance(id: "missing-auth", label: "Needs sign-in", providerType: .openAI, credentialType: .apiKey),
            ProviderInstance(id: "disabled-provider", label: "Disabled Provider", providerType: .openAI, credentialType: .apiKey, isEnabled: false),
        ]
        func entry(_ provider: String, _ id: String, _ name: String, _ brand: String, hidden: Bool = false) -> ModelEntry {
            ModelEntry(uuid: "fixture-\(provider)-\(id)", providerInstanceId: provider,
                       model: LLMModel(id: id, displayName: name, provider: brand, modalityOverride: .vision, contextWindow: 200_000), isHidden: hidden)
        }
        modelEntries = [
            entry("openai-direct", "gpt-5", "GPT-5", "OpenAI"),
            entry("openai-direct", "gpt-5-mini", "GPT-5 Mini", "OpenAI"),
            entry("openai-direct", "hidden-fixture", "Hidden fixture", "OpenAI", hidden: true),
            entry("anthropic-direct", "claude-sonnet-4", "Claude Sonnet 4", "Anthropic"),
            entry("anthropic-direct", "claude-opus-4", "Claude Opus 4", "Anthropic"),
            entry("relay-proxy", "gpt-5", "GPT-5", "OpenAI"),
            entry("relay-proxy", "deepseek-reasoner", "DeepSeek Reasoner", "DeepSeek"),
            entry("relay-proxy", "long-context-model", "Research Model With a Very Long Descriptive Name", "Fixture"),
            entry("missing-auth", "unavailable", "Unavailable fixture", "OpenAI"),
            entry("disabled-provider", "disabled", "Disabled fixture", "OpenAI"),
        ]
        if failNextEntrySave, let index = modelEntries.firstIndex(where: { $0.id == "relay-proxy/deepseek-reasoner" }) {
            modelEntries[index].overrides.maxThinkingLevel = .high
        }
        if large {
            let count = Int(ProcessInfo.processInfo.environment["AUDIT_CATALOG_COUNT"] ?? "180") ?? 180
            for index in 1...max(1, count) {
                modelEntries.append(entry("relay-proxy", String(format: "catalog-%03d", index), String(format: "Catalog Model %03d", index), index % 2 == 0 ? "OpenAI" : "Anthropic"))
            }
        }
        modelGroups = [
            ModelGroup(id: "daily", name: "Daily Work", memberEntryIds: ["openai-direct/gpt-5", "anthropic-direct/claude-sonnet-4"]),
            ModelGroup(id: "research", name: "Research Team", memberEntryIds: ["relay-proxy/deepseek-reasoner", "anthropic-direct/claude-opus-4"], strategy: .loadBalance),
            ModelGroup(id: "unavailable-group", name: "Unavailable Group", memberEntryIds: ["missing-auth/unavailable"]),
            ModelGroup(id: "empty-group", name: "Empty Group", memberEntryIds: []),
        ]
        defaultPrimaryGroupId = "daily"
        defaultSubGroupId = "research"
        sessionBindings["audit-session"] = SessionModelBinding(sessionId: "audit-session", primarySource: .directEntry(modelEntryId: "anthropic-direct/claude-sonnet-4"))
        let initialPins = ProcessInfo.processInfo.environment["AUDIT_LEGACY_PINS"] == "1"
            ? ["pruned-legacy-sonnet-uuid", "openai-direct/gpt-5"]
            : ["anthropic-direct/claude-sonnet-4", "openai-direct/gpt-5"]
        UserDefaults.standard.set(initialPins, forKey: "leo.model.pinned.v1")
    }

    func persist() {
        guard ready else { return }
        let snapshot = Snapshot(instances: instances, modelEntries: modelEntries, modelGroups: modelGroups,
                                defaultPrimaryGroupId: defaultPrimaryGroupId, defaultSubGroupId: defaultSubGroupId,
                                voiceInputGroupId: voiceInputGroupId, voiceOutputGroupId: voiceOutputGroupId,
                                agentLoopModelEntryIds: agentLoopModelEntryIds, agentLoopGroupIds: agentLoopGroupIds,
                                sessionBindings: sessionBindings)
        if let data = try? JSONEncoder().encode(snapshot) { UserDefaults.standard.set(data, forKey: storageKey) }
    }
    @discardableResult
    func setEntriesHidden(ids: Set<String>, hidden: Bool) -> Bool {
        for index in modelEntries.indices where ids.contains(modelEntries[index].id) {
            modelEntries[index].isHidden = hidden
            modelEntries[index].userModifiedAt = Date()
        }
        return true
    }
    func normalizeEntryRef(_ id: String) -> String {
        // Models an imported legacy alias retained after duplicate UUID pruning.
        if id == "pruned-legacy-sonnet-uuid" { return "anthropic-direct/claude-sonnet-4" }
        return entry(for: id)?.id ?? id
    }
    @discardableResult
    func removeEntry(_ id: String) -> Bool {
        modelEntries.removeAll { $0.id == id }
        ModelSwitcher.forget(entryIds: [id])
        return true
    }
    @discardableResult
    func removeInstance(_ id: String) -> Bool {
        instances.removeAll { $0.id == id }
        modelEntries.removeAll { $0.providerInstanceId == id }
        deletedInstanceIds.insert(id)
        ModelSwitcher.forget(instanceIds: [id])
        return true
    }
    func instance(for id: String) -> ProviderInstance? { instances.first { $0.id == id } }
    func entry(for id: String) -> ModelEntry? { modelEntries.first { $0.id == id || $0.uuid == id || $0.legacyColonCompositeKey == id } }
    func entries(for id: String) -> [ModelEntry] { modelEntries.filter { $0.providerInstanceId == id } }
    func visibleEntries(for id: String) -> [ModelEntry] { entries(for: id).filter { !$0.isHidden } }
    func group(for id: String) -> ModelGroup? { modelGroups.first { $0.id == id } }
    func binding(for id: String) -> SessionModelBinding? { sessionBindings[id] }
    @discardableResult
    func setBinding(_ value: SessionModelBinding, for id: String) -> Bool { sessionBindings[id] = value; return true }
    @discardableResult
    func addGroup(_ group: ModelGroup) -> Bool {
        guard admitGroupSave() else { return false }
        modelGroups.append(group)
        return true
    }
    @discardableResult
    func updateGroup(_ group: ModelGroup) -> Bool {
        guard let index = modelGroups.firstIndex(where: { $0.id == group.id }) else { return false }
        guard admitGroupSave() else { return false }
        modelGroups[index] = group
        return true
    }
    @discardableResult
    func removeGroup(_ id: String) -> Bool {
        guard admitGroupSave() else { return false }
        modelGroups.removeAll { $0.id == id }
        if defaultPrimaryGroupId == id { defaultPrimaryGroupId = nil }
        if defaultSubGroupId == id { defaultSubGroupId = nil }
        if voiceInputGroupId == id { voiceInputGroupId = nil }
        if voiceOutputGroupId == id { voiceOutputGroupId = nil }
        agentLoopGroupIds.removeAll { $0 == id }
        ModelSwitcher.forget(groupIds: [id])
        return true
    }
    @discardableResult
    func reorderGroups(_ ids: [String]) -> Bool {
        guard admitGroupSave() else { return false }
        modelGroups = ids.compactMap { group(for: $0) }
        return true
    }
    // UI rejection injection only. Disk/DB failure behavior is exercised by
    // ProductionProviderPersistenceTests against exact production method bodies.
    private func admitGroupSave() -> Bool {
        guard failNextGroupSave else { return true }
        failNextGroupSave = false
        return false
    }
    @discardableResult
    func updateEntry(_ entry: ModelEntry) -> Bool {
        guard let index = modelEntries.firstIndex(where: { $0.id == entry.id }) else { return false }
        if failNextEntrySave { failNextEntrySave = false; return false }
        modelEntries[index] = entry
        return true
    }
    func addAgentLoopEntry(_ id: String) { if !agentLoopModelEntryIds.contains(id) { agentLoopModelEntryIds.append(id) } }
    func addAgentLoopGroup(_ id: String) { if !agentLoopGroupIds.contains(id) { agentLoopGroupIds.append(id) } }
}
