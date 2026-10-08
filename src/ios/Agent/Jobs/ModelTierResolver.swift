import Foundation

private let logger = AppLogger(category: "SubAgentModelResolver")

// [T-subagent] Ported from upstream iOS 1.14 `ModelTierResolver.swift`.
//
// Where a sub agent's model comes from: the definition pins a Model Group, or
// it is Auto and the delegating model's `model_choice` picks between the
// parent conversation's binding (default), the user's default group and the
// user's light (sub) group. Every Auto branch degrades to the parent's model.

// HelperModelOrigin / SubAgentModelChoice live in SubAgentPolicy.swift (pure, unit-tested).

struct HelperModelResolution {
    let source: SessionModelSource
    let entry: ModelEntry
    let origin: HelperModelOrigin
    /// The definition pinned a group that could not be routed, so this fell
    /// back to inheriting (surfaced as `model_group_unavailable`).
    var modelGroupUnavailable: Bool = false
    var modelLabel: String { entry.model.displayName }
}

@MainActor
enum SubAgentModelResolver {

    static func resolve(subAgent: SubAgentDefinition?,
                        parent: AIChatViewModel,
                        choice: SubAgentModelChoice = .sameAsParent) -> HelperModelResolution? {
        let store = ProviderConfigStore.shared

        func inherited() -> HelperModelResolution? {
            guard let entry = parent.resolveCurrentEntry() else {
                logger.warning("resolve(inherited): parent has no resolvable model")
                return nil
            }
            // The parent's binding passes through VERBATIM: a parent bound to a
            // group keeps the child on the group (routing + fallback intact).
            if let sid = parent.sessionId, let binding = store.binding(for: sid) {
                return HelperModelResolution(source: binding.primarySource, entry: entry, origin: .inherited)
            }
            return HelperModelResolution(source: .directEntry(modelEntryId: entry.id), entry: entry, origin: .inherited)
        }

        func routed(_ gid: String?, origin: HelperModelOrigin) -> HelperModelResolution? {
            guard let gid, let group = store.group(for: gid) else { return nil }
            let routeSid = parent.sessionId ?? UUID().uuidString
            guard let entryId = ModelGroupRouter.resolve(group: group, sessionId: routeSid, store: store),
                  let entry = store.entry(for: entryId) else { return nil }
            return HelperModelResolution(source: .group(groupId: gid, resolvedEntryId: entryId),
                                         entry: entry, origin: origin)
        }

        guard let gid = subAgent?.modelGroupId else {
            switch choice {
            case .sameAsParent: return inherited()
            case .defaultModel: return routed(store.defaultPrimaryGroupId, origin: .defaultGroup) ?? inherited()
            case .subModel: return routed(store.defaultSubGroupId, origin: .subGroup) ?? inherited()
            }
        }
        if let pinned = routed(gid, origin: .pinned) { return pinned }
        logger.info("resolve(pinned): group \(gid.prefix(8)) unavailable — inheriting the parent's model")
        guard var fallback = inherited() else { return nil }
        fallback.modelGroupUnavailable = true
        return fallback
    }

    /// Thinking level for the child: the definition's override → the pinned
    /// group's default → the parent conversation's level → the resolved
    /// group's default; clamped to what the resolved entry supports. Returns
    /// the level applied, or nil when reasoning stays off (nothing written).
    @discardableResult
    static func seedChildThinkingLevel(childId: String, parentSessionId: String?,
                                       resolution: HelperModelResolution,
                                       subAgent: SubAgentDefinition?) -> ThinkingLevel? {
        let store = ProviderConfigStore.shared
        let resolvedGroup: ModelGroup? = {
            if case .group(let gid, _) = resolution.source { return store.group(for: gid) }
            return nil
        }()
        var level: ThinkingLevel = {
            if let override = subAgent?.thinkingLevelOverride { return override }
            if resolution.origin == .pinned, let lvl = resolvedGroup?.defaultThinkingLevel { return lvl }
            if let parentSessionId, let cfg = store.inferenceConfig(for: parentSessionId) { return cfg.thinkingLevel }
            return resolvedGroup?.defaultThinkingLevel ?? .off
        }()
        level = min(level, resolution.entry.effectiveMaxThinkingLevel)
        guard level.isEnabled else { return nil }
        var cfg = store.inferenceConfig(for: childId) ?? SessionInferenceConfig()
        cfg.thinkingLevel = level
        store.setInferenceConfig(cfg, for: childId)
        return level
    }
}

// MARK: - Identity construction from live config

extension HelperModelIdentity {
    @MainActor
    static func make(resolution: HelperModelResolution) -> HelperModelIdentity {
        let store = ProviderConfigStore.shared
        var id = HelperModelIdentity(modelOrigin: resolution.origin.rawValue)
        id.modelGroupUnavailable = resolution.modelGroupUnavailable
        if case .group(let gid, _) = resolution.source {
            id.modelGroupName = store.group(for: gid)?.name
        }
        let entry = resolution.entry
        id.resolvedEntryId = entry.id
        id.resolvedModelId = entry.model.id
        id.resolvedModelName = entry.model.displayName
        if let inst = store.instance(for: entry.providerInstanceId) {
            id.resolvedProviderLabel = inst.label
            id.resolvedProviderType = inst.providerType.rawValue
        }
        return id
    }
}

extension EffectiveModelRecord {
    /// Request-side facts for the entry a child turn was served on.
    @MainActor
    static func make(entryId: String) -> EffectiveModelRecord? {
        let store = ProviderConfigStore.shared
        guard !entryId.isEmpty, let entry = store.entry(for: entryId) else { return nil }
        var rec = EffectiveModelRecord()
        rec.entryId = entry.id
        rec.modelId = entry.model.id
        rec.modelName = entry.model.displayName
        if let inst = store.instance(for: entry.providerInstanceId) {
            rec.providerLabel = inst.label
            rec.providerType = inst.providerType.rawValue
        }
        return rec
    }
}
