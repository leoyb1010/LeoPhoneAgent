import Foundation

private let logger = AppLogger(category: "AIChatVM")

// MARK: - Provider Factory

extension AIChatViewModel {

    // MARK: - Provider Factory

    /// Construct an AgentProvider from a ModelEntry by looking up its ProviderInstance and credential.
    func makeAgentProvider(for entry: ModelEntry) async -> AgentProvider {
        return await Self.makeAgentProvider(for: entry, sessionId: sessionId)
    }

    /// Static variant — used by sub-task call sites (title generation, etc.)
    /// that don't have a viewmodel context. Same lookup logic as the instance
    /// method, since the resolution depends only on global state
    /// (ProviderConfigStore + LLMProviderFactory).
    /// `sessionId` is the conversation the provider serves, when there is one.
    static func makeAgentProvider(for entry: ModelEntry, sessionId: String? = nil) async -> AgentProvider {
        let store = ProviderConfigStore.shared
        guard let instance = store.instance(for: entry.providerInstanceId) else {
            logger.error("No ProviderInstance found for entry \(entry.id)")
            return AnthropicAgentProvider(provider: AnthropicProvider(apiKey: "", model: entry.model))
        }
        if let notice = instance.retiredSignInNotice {
            return RetiredAgentProvider(name: instance.label, model: entry.model, notice: notice)
        }
        switch instance.providerType {
        case .anthropic:
            return AnthropicAgentProvider(provider: LLMProviderFactory.makeAnthropicProvider(instance: instance, model: entry.model))
        case .gemini:
            return GeminiAgentProvider(provider: LLMProviderFactory.makeGeminiProvider(instance: instance, model: entry.model))
        case .openAI:
            return OpenAIAgentProvider(provider: LLMProviderFactory.makeOpenAIProvider(instance: instance, model: entry.model), sessionId: sessionId)
        case .openCodeGo:
            switch LLMProviderFactory.makeOpenCodeGoProvider(instance: instance, model: entry.model, sessionId: sessionId) {
            case let anthropic as AnthropicProvider:
                return AnthropicAgentProvider(provider: anthropic)
            case let openAI as OpenAIProvider:
                return OpenAIAgentProvider(provider: openAI, sessionId: sessionId)
            default:
                logger.error("Unexpected OpenCode Go provider type; returning placeholder")
                return AnthropicAgentProvider(provider: AnthropicProvider(apiKey: "", model: entry.model))
            }
        case .openRouter:
            return OpenAIAgentProvider(provider: LLMProviderFactory.makeOpenRouterProvider(instance: instance, model: entry.model), sessionId: sessionId)
        case .openAIResponses:
            return OpenAIAgentProvider(provider: LLMProviderFactory.makeOpenAIResponsesProvider(instance: instance, model: entry.model), sessionId: sessionId)
        case .xAI:
            return OpenAIAgentProvider(provider: LLMProviderFactory.makeXAIProvider(instance: instance, model: entry.model), sessionId: sessionId)
        case .kimiCode:
            return OpenAIAgentProvider(provider: LLMProviderFactory.makeKimiProvider(instance: instance, model: entry.model), sessionId: sessionId)
        case .unsupported:
            logger.error("\(instance.providerType) has no agent provider; returning placeholder")
            return AnthropicAgentProvider(provider: AnthropicProvider(apiKey: "", model: entry.model))
        }
    }

    /// Build an AnthropicAgentProvider for cache keep-alive warmup, reusing the
    /// same entry that was used in the last agent loop.
    func makeAnthropicProviderForWarmup() -> AnthropicAgentProvider? {
        guard let entry = keepAliveEntry else { return nil }
        let store = ProviderConfigStore.shared
        guard let instance = store.instance(for: entry.providerInstanceId),
              instance.providerType == .anthropic else { return nil }
        RequestBodyPatcher.setExtendedCacheTTL(self.enhancedCacheEnabled)
        return AnthropicAgentProvider(provider: LLMProviderFactory.makeAnthropicProvider(instance: instance, model: entry.model))
    }


    /// Construct a lightweight LLMProvider from a ModelEntry (for sub-tasks like title generation).
    static func makeLLMProvider(for entry: ModelEntry) async throws -> any LLMProvider {
        let store = ProviderConfigStore.shared
        guard let instance = store.instance(for: entry.providerInstanceId) else {
            throw LLMProviderError.noCredentials
        }
        guard !instance.providerType.isUnsupported else { throw LLMProviderError.noCredentials }
        if instance.retiredSignInNotice == nil, !instance.hasAnyCredential {
            throw LLMProviderError.noCredentials
        }
        return try await LLMProviderFactory.makeProvider(instance: instance, model: entry.model)
    }

    /// Resolve the current session's primary model entry from its binding, or fall back to defaults.
    /// L1 cache (T-new-session-hang-credential-cache): SwiftUI body re-eval
    /// drives this ~84-178×/new-session (nav-bar thinking badge etc.), each call
    /// re-walking the group + per-member `hasAnyCredential`. The result is a pure
    /// function of session identity, draft choice, persisted/default model and
    /// config/auth revisions; unchanged inputs can reuse the same resolution, so we
    /// memoize. configRevision/authRevision are the epoch counters bumped on any
    /// config or credential mutation, so a stale entry cannot survive a change.
    private struct ResolveCacheKey: Hashable {
        let sessionId: String
        let cachedModelId: String
        let defaultGroupId: String
        let draftChoice: String
        let draftRoutingId: String
        let configRevision: UInt
        let authRevision: UInt
    }
    private static var resolveCache: [ResolveCacheKey: String] = [:]  // key → entryId
    /// Negatives (no resolvable entry) are cached too, as the sentinel below —
    /// the no-config/no-credential path is itself moderately expensive to re-walk.
    private static let resolveNilSentinel = "\u{0}nil"

    /// Keep `selectedModel` aligned with the binding that send/loop actually use.
    /// Inspector, intents, and new-session modelId all read this field.
    func syncSelectedModelFromBinding() {
        guard let model = resolveCurrentEntry()?.model else { return }
        guard selectedModel.id != model.id else { return }
        logger.info("🔀 selectedModel sync \(self.selectedModel.id) → \(model.id)")
        selectedModel = model
    }

    func resolveCurrentEntry() -> ModelEntry? {
        let store = ProviderConfigStore.shared
        let key = ResolveCacheKey(
            sessionId: sessionId ?? "",
            cachedModelId: cachedSessionModelId,
            defaultGroupId: store.defaultPrimaryGroupId ?? "",
            draftChoice: initialEntryKey.map { "entry:" + $0 } ?? initialGroupId.map { "group:" + $0 } ?? "",
            draftRoutingId: draftId ?? "",
            configRevision: store.configRevision,
            authRevision: store.authRevision
        )
        if let cachedId = Self.resolveCache[key] {
            if cachedId == Self.resolveNilSentinel { return nil }
            // The entry could have been deleted out from under a still-valid
            // epoch only via a save() (which bumps configRevision → new key),
            // so a present cache value always still resolves; but guard anyway.
            if let entry = store.entry(for: cachedId) { return entry }
        }
        let resolved = resolveCurrentEntryUncached()
        Self.resolveCache[key] = resolved?.id ?? Self.resolveNilSentinel
        return resolved
    }

    /// The Home choice is already active before a draft acquires a database id.
    /// Return nil for an unavailable explicit choice; never borrow the default.
    func resolveInitialEntry(store: ProviderConfigStore) -> ModelEntry? {
        if let key = initialEntryKey {
            guard let entry = store.entry(for: key), ModelSwitcher.isAvailable(entry, store: store) else { return nil }
            return entry
        }
        if let groupId = initialGroupId,
           let group = store.group(for: groupId),
           let entryId = ModelGroupRouter.resolve(group: group, sessionId: draftId ?? sessionId ?? "__draft__", store: store, verbose: false),
           let entry = store.entry(for: entryId), ModelSwitcher.isAvailable(entry, store: store) {
            return entry
        }
        return nil
    }

    private func resolveCurrentEntryUncached() -> ModelEntry? {
        let store = ProviderConfigStore.shared

        // 1. Try session binding
        if let sid = sessionId, let binding = store.binding(for: sid) {
            switch binding.primarySource {
            case .directEntry(let entryId, _):
                if let entry = store.entry(for: entryId) {
                    logger.info("🔀RESOLVE directEntry=\(entryId) model=\(entry.model.id)")
                    return entry
                }
                // Entry was deleted (e.g. provider removed) — fall through to default group
                logger.warning("🔀RESOLVE directEntry=\(entryId) missing, falling back to default group")
            case .group(let groupId, let resolvedEntryId):
                // [T-ios-disabled-provider-still-selectable-via-group #34] Only
                // honor the cached resolvedEntryId when its provider instance is
                // still usable (enabled + credentialed) AND the entry isn't
                // hidden. The group binding caches whichever member was resolved
                // when the session was created / last re-picked; if the user
                // later DISABLES that member's provider (e.g. a Coding Plan whose
                // quota ran out, disabled to force fallback to the next provider),
                // the stale resolvedEntryId would otherwise keep routing to the
                // disabled provider's pay-as-you-go model and bill the user. Treat
                // a disabled/credential-less/hidden resolved entry the same as a
                // deleted one: re-resolve through ModelGroupRouter, which already
                // filters by ModelGroupRouter.availableEntryIds (enabled +
                // credential + not hidden).
                if let entry = store.entry(for: resolvedEntryId),
                   let inst = store.instance(for: entry.providerInstanceId),
                   inst.isEnabled, inst.hasAnyCredential, !entry.isHidden {
                    logger.info("🔀RESOLVE group=\(groupId) resolvedEntry=\(resolvedEntryId) model=\(entry.model.id)")
                    return entry
                }
                // Resolved entry was deleted OR its provider is now disabled /
                // credential-less / hidden — re-resolve the group to the next
                // available member, then fall through to the default group.
                if let group = store.group(for: groupId),
                   let freshEntryId = ModelGroupRouter.resolve(group: group, sessionId: sid, store: store),
                   let entry = store.entry(for: freshEntryId) {
                    logger.warning("🔀RESOLVE group=\(groupId) resolvedEntry=\(resolvedEntryId) unavailable (deleted/disabled/hidden), re-resolved to \(freshEntryId) model=\(entry.model.id)")
                    return entry
                }
                logger.warning("🔀RESOLVE group=\(groupId) resolvedEntry=\(resolvedEntryId) unavailable and group has no available member, falling back to default group")
            }
        } else {
            logger.info("🔀RESOLVE no binding for session=\(self.sessionId ?? "nil")")
        }

        if (initialEntryKey != nil || initialGroupId != nil),
           sessionId.flatMap({ store.binding(for: $0) }) == nil {
            return resolveInitialEntry(store: store)
        }

        // 2. Try the session's persisted modelId (cached at loadSession time)
        //    BEFORE falling back to the default group. The session row stores
        //    `modelId` (set when the user first picked a model on this
        //    session) which survives iCloud sync even when the in-memory
        //    SessionModelBinding doesn't. Without this step, compact / title
        //    generation would silently pick the global default group and run
        //    on a different model than what the chat header is showing.
        //
        //    When MULTIPLE entries match the same model id (common when iCloud
        //    sync brings over a second provider instance for the same model,
        //    e.g. "claude-sonnet-4-6" served by both a working API-key
        //    instance and an OAuth instance whose token never landed on this
        //    device), prefer one whose instance has a usable credential.
        //    Without that preference the first-match-wins pick would silently
        //    route to the credential-less instance, producing a 403 OAuth
        //    error every time the user opens an iCloud-synced session.
        if !cachedSessionModelId.isEmpty {
            let matching = store.modelEntries.filter { $0.model.id == cachedSessionModelId && !$0.isHidden }

            // 2a. **Prefer entries that live inside the default primary group.**
            //     This is what the chat header subtitle has been showing all
            //     along ("Default Model · Anthropic(X) · Claude Sonnet 4.6"),
            //     so honoring it is the principle of least surprise. It also
            //     fixes an iCloud-sync footgun: when a session arrives with
            //     `modelId=claude-sonnet-4-6` but no SessionModelBinding (the
            //     binding row didn't sync), the older "first credentialed
            //     match across ALL instances" logic would land on whatever
            //     Anthropic instance came first in `store.modelEntries`. On a
            //     device with multiple Anthropic OAuth logins (e.g. wsvn63 +
            //     53), it could route to wsvn63 whose OAuth token is rejected
            //     by Anthropic at the org level — even though the UI showed
            //     "Anthropic(53)" and the default group would have picked 53.
            //     User experiences this as "open synced session → 403; switch
            //     model and pick the SAME model again → 200" because the
            //     re-pick creates a group binding that routes via
            //     ModelGroupRouter (= the default-group path).
            if let groupId = store.defaultPrimaryGroupId,
               let group = store.group(for: groupId) {
                let groupMemberSet = Set(group.memberEntryIds)
                let inGroup = matching.filter { groupMemberSet.contains($0.id) }
                if let entry = inGroup.first(where: { e in
                    guard let inst = store.instance(for: e.providerInstanceId) else { return false }
                    return inst.isEnabled && inst.hasAnyCredential
                }) {
                    logger.info("🔀RESOLVE via cachedSessionModelId=\(self.cachedSessionModelId) → entry=\(entry.id) (defaultGroup member, credentialed)")
                    return entry
                }
                if let entry = inGroup.first {
                    logger.info("🔀RESOLVE via cachedSessionModelId=\(self.cachedSessionModelId) → entry=\(entry.id) (defaultGroup member, no-credential fallback)")
                    return entry
                }
            }

            // 2b. No default-group match — fall back to first credentialed
            //     enabled match anywhere. (Rare: the model the session uses
            //     is no longer in the default group.)
            if let entry = matching.first(where: { e in
                guard let inst = store.instance(for: e.providerInstanceId) else { return false }
                return inst.isEnabled && inst.hasAnyCredential
            }) {
                logger.info("🔀RESOLVE via cachedSessionModelId=\(self.cachedSessionModelId) → entry=\(entry.id) (credentialed, outside default group)")
                return entry
            }
            // 2c. Last-ditch: first enabled (no credential) → first match.
            if let entry = matching.first(where: { e in
                store.instance(for: e.providerInstanceId)?.isEnabled == true
            }) {
                logger.warning("🔀RESOLVE via cachedSessionModelId=\(self.cachedSessionModelId) → entry=\(entry.id) (NO CREDENTIAL — request will likely fail)")
                return entry
            }
            if let entry = matching.first {
                logger.warning("🔀RESOLVE via cachedSessionModelId=\(self.cachedSessionModelId) → entry=\(entry.id) (instance disabled/missing)")
                return entry
            }
        }

        // 3. Try default group
        let resolveId = sessionId ?? "__resolve__"
        if let groupId = store.defaultPrimaryGroupId,
           let group = store.group(for: groupId),
           let entryId = ModelGroupRouter.resolve(group: group, sessionId: resolveId, store: store) {
            logger.info("🔀RESOLVE via default group=\(groupId) → entry=\(entryId)")
            return store.entry(for: entryId)
        }

        // 4. No config — return nil
        logger.warning("🔀RESOLVE no config store data, returning nil")
        return nil
    }

    /// Resolve a sub-model entry for lightweight tasks (compaction, title gen).
    ///
    /// [T-compact-slot] 设置里那个「压缩 / 标题」便宜模型槽
    /// (`AgentModelSlots.compactEntryId`)现在两处都作用:标题生成走
    /// `+TitleGeneration`,压缩摘要走 `+Compaction.generateCompactSummary`。
    /// 之前它只被标题生成调用,压缩自己走 `resolveCurrentEntry()` —— 设置文案
    /// 和 release notes 都写着"压缩",实际压缩根本没用上,属于"看起来做了但
    /// 没生效"。修的方向选"让它真的作用于压缩"而不是改文案:用户配这个槽的
    /// 动机就是省钱,而压缩才是这两件事里烧 token 的那一件。
    func resolveSubEntry() -> ModelEntry? {
        let store = ProviderConfigStore.shared

        // 1. Session-specific sub model binding takes precedence — user
        //    explicitly picked a sub model for this conversation.
        //    [T-compact-slot] 全局的便宜模型槽必须排在它**后面**:槽是全局默认,
        //    会话级绑定是用户对这一个会话的明确指定,后者更具体。原来槽写在
        //    最前面,和紧跟着的注释「Session-specific sub model binding takes
        //    precedence」直接矛盾,会话级绑定永远轮不到。
        if let sid = sessionId, let binding = store.binding(for: sid),
           let sub = binding.subModelSource {
            switch sub {
            case .directEntry(let entryId, _):
                if let entry = store.entry(for: entryId) { return entry }
                // Entry was deleted — fall through.
            case .group(let groupId, let resolvedEntryId):
                // [T-ios-disabled-provider-still-selectable-via-group #34] Mirror
                // resolveCurrentEntry: only honor the cached resolvedEntryId when
                // its provider is still usable; otherwise re-resolve through the
                // router so a disabled-provider sub-model isn't silently used.
                if let entry = store.entry(for: resolvedEntryId),
                   let inst = store.instance(for: entry.providerInstanceId),
                   inst.isEnabled, inst.hasAnyCredential, !entry.isHidden { return entry }
                if let group = store.group(for: groupId),
                   let freshEntryId = ModelGroupRouter.resolve(group: group, sessionId: sid, store: store),
                   let entry = store.entry(for: freshEntryId) { return entry }
            }
        }

        // 2. 全局「压缩 / 标题」便宜模型槽。
        //    [T-compact-slot] 和下面 group 分支同样校验 provider 是否 enabled /
        //    有凭据:槽里存的只是一个 entryId,用户事后把那个供应商停用或删掉
        //    凭据后,原来的写法会照样返回它,压缩/标题必然 401。校验不过就当
        //    没配,落到第 3 步的当前会话模型——宁可贵一点,也不能直接失败。
        if let compactId = AgentModelSlots.compactEntryId,
           let cheap = store.entry(for: compactId),
           !cheap.isHidden,
           let inst = store.instance(for: cheap.providerInstanceId),
           inst.isEnabled, inst.hasAnyCredential {
            return cheap
        }

        // 3. No session-level sub binding — use the current session's primary
        //    model (NOT the global defaultSubGroup). This keeps title gen +
        //    other lightweight LLM calls on the same provider/model the user
        //    is actively chatting with, instead of silently jumping to a
        //    different default. Users who DO want a separate cheap sub model
        //    can configure it explicitly per-session.
        return resolveCurrentEntry()
    }

}

/// Stand-in for a provider whose sign-in method was retired: every request
/// fails with the migration notice instead of a confusing 401.
struct RetiredAgentProvider: AgentProvider {
    let name: String
    let model: LLMModel
    let notice: String
    var defaultMaxTokens: Int { 4096 }

    func streamAgentMessageClamped(
        messages: [AgentMessage],
        systemPrompt: String?,
        tools: [AgentToolDefinition],
        maxTokens: Int,
        thinkingLevel: ThinkingLevel
    ) async throws -> AsyncThrowingStream<AgentStreamEvent, Error> {
        throw LLMError.invalidAPIKey(detail: notice)
    }
}
