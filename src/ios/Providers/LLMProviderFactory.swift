import Foundation

/// Shared factory for creating LLMProvider instances from a ModelEntry.
/// Used by both the agent loop (AIChatViewModel) and minis-model-use offload bridge.
@MainActor
enum LLMProviderFactory {

    enum FactoryError: Error {
        case noInstance
        case noCredentials
        case voiceOnlyProvider
    }

    /// Create an LLMProvider for the given entry, looking up its ProviderInstance and credentials.
    static func makeProvider(for entry: ModelEntry) async throws -> any LLMProvider {
        let store = ProviderConfigStore.shared
        guard let instance = store.instance(for: entry.providerInstanceId) else {
            throw FactoryError.noInstance
        }
        return try await makeProvider(instance: instance, model: entry.model)
    }

    /// Build a provider from an onboarding candidate that has credentials in
    /// Keychain but has not been persisted to ProviderConfigStore yet. This
    /// lets Add Provider make a real request before committing the instance.
    static func makeProvider(instance: ProviderInstance, model: LLMModel) async throws -> any LLMProvider {
        if let notice = instance.retiredSignInNotice {
            throw LLMError.invalidAPIKey(detail: notice)
        }
        switch instance.providerType {
        case .anthropic:
            return makeAnthropicProvider(instance: instance, model: model)
        case .gemini:
            return makeGeminiProvider(instance: instance, model: model)
        case .openAI:
            return makeOpenAIProvider(instance: instance, model: model)
        case .openCodeGo:
            return makeOpenCodeGoProvider(instance: instance, model: model)
        case .openRouter:
            return makeOpenRouterProvider(instance: instance, model: model)
        case .openAIResponses:
            return makeOpenAIResponsesProvider(instance: instance, model: model)
        case .xAI:
            return makeXAIProvider(instance: instance, model: model)
        case .kimiCode:
            return makeKimiProvider(instance: instance, model: model)
        case .unsupported:
            throw FactoryError.voiceOnlyProvider
        }
    }

    /// Inject the instance's custom `User-Agent` into an OpenAI-family provider's
    /// `extraHeaders` (which every request builder applies — chat/responses/models/
    /// image). Only for custom-base OpenAI/Anthropic-compat instances that are NOT
    /// OAuth: Codex OAuth requires its own `codex_cli_rs/...` UA to be accepted, so
    /// we never clobber it. Merges into any existing extraHeaders (e.g. OpenRouter
    /// attribution). No-op when no custom UA is set → default UA unchanged.
    /// Called from inside each OpenAI-family builder so BOTH makeProvider() and
    /// AIChatViewModel.makeAgentProvider() (which calls the builders directly) apply it.
    /// [T-ios-azure-openai] Flip the provider into Azure mode (api-key header +
    /// Azure URL) for instances that opted in. No-op (and zero behavior change)
    /// when azureMode is off, so non-Azure OpenAI/Responses instances are unaffected.
    @discardableResult
    static func applyAzure(_ provider: OpenAIProvider, instance: ProviderInstance) -> OpenAIProvider {
        if instance.azureMode { provider.isAzure = true }
        return provider
    }

    /// `manualToken` is the builder's single read of the instance's pasted token.
    @discardableResult
    static func applyCustomUserAgent(_ provider: OpenAIProvider, instance: ProviderInstance, manualToken: String?) -> OpenAIProvider {
        // Every OpenAI-family builder passes through here: tag the instance so the thinking
        // resolver can apply user rules pinned to it.
        if provider.providerInstanceId == nil { provider.providerInstanceId = instance.id }
        // OAuth (Codex) requires its own `codex_cli_rs/...` UA — never touch it.
        guard !provider.isOAuth else { return provider }
        // A user-set per-provider custom UA wins (only honored for
        // custom-base proxy/relay instances, per supportsCustomUserAgent).
        if instance.supportsCustomUserAgent(manualToken: manualToken), let ua = instance.effectiveCustomUserAgent {
            provider.extraHeaders["User-Agent"] = ua
            return provider
        }
        // Otherwise inject the app default UA so outbound requests carry the
        // marketing version (LeoPhoneAgent/1.10 …) instead of URLSession's build-number
        // default (LeoPhoneAgent/1 CFNetwork/… Darwin/…). Don't clobber a UA another
        // builder already set (e.g. some future provider-specific UA).
        if provider.extraHeaders["User-Agent"] == nil {
            provider.extraHeaders["User-Agent"] = MinisUserAgent.default
        }
        return provider
    }

    // MARK: - Per-Provider Builders

    static func makeAnthropicProvider(instance: ProviderInstance, model: LLMModel) -> AnthropicProvider {
        // One Keychain read decides both the credential and the base URL.
        let manualToken = instance.storedManualToken()
        let customBase = instance.effectiveCustomBaseURL(manualToken: manualToken)
        let appendV1 = instance.appendV1Suffix
        // Only custom-base Anthropic-compat (proxy/relay) instances get a custom UA;
        // otherwise send the app default (LeoPhoneAgent/<marketing>) so the SDK
        // (which sets no UA itself) doesn't fall back to URLSession's build-number default.
        let ua = (instance.supportsCustomUserAgent(manualToken: manualToken) ? instance.effectiveCustomUserAgent : nil) ?? MinisUserAgent.default
        // A retired subscription-login instance has no manual token and falls
        // through to an empty key; entry points reject it via `retiredSignInNotice`.
        if let manualToken {
            return AnthropicProvider(manualToken: manualToken, model: model, basePath: customBase, appendV1Suffix: appendV1, customUserAgent: ua)
        }
        let key = ProviderKeychainHelper.loadAPIKey(instanceId: instance.id) ?? ""
        // Relays and coding plans behind a custom base often want the key as
        // `Authorization: Bearer`; send it that way too (x-api-key stays).
        if customBase != nil {
            return AnthropicProvider(manualToken: key, model: model, basePath: customBase, appendV1Suffix: appendV1, customUserAgent: ua)
        }
        return AnthropicProvider(apiKey: key, model: model, basePath: customBase, appendV1Suffix: appendV1, customUserAgent: ua)
    }

    static func makeGeminiProvider(instance: ProviderInstance, model: LLMModel) -> GeminiProvider {
        let manualToken = instance.storedManualToken()
        let customBase = instance.effectiveCustomBaseURL(manualToken: manualToken)
        if let manualToken {
            return GeminiProvider(apiKey: manualToken, model: model, customBasePath: customBase)
        }
        let key = ProviderKeychainHelper.loadAPIKey(instanceId: instance.id) ?? ""
        return GeminiProvider(apiKey: key, model: model, customBasePath: customBase)
    }

    /// OpenCode Go: one key, three wire protocols chosen by model family.
    ///
    /// [T-opencode-dedicated-channel] Go rejects requests without `x-opencode-session`
    /// and keys its prompt cache on it, so it must be the SAME id on every request of a
    /// conversation. The id is read PER REQUEST from `sessionBox` (the chat view model
    /// updates it on draft→session promotion) rather than captured at construction;
    /// calls outside a conversation (connection test, title generation) fall back to one
    /// fixed id for this provider's lifetime.
    static func makeOpenCodeGoProvider(instance: ProviderInstance, model: LLMModel, sessionId: String? = nil,
                                       sessionBox: ConversationSessionBox? = nil) -> any LLMProvider {
        let key = ProviderKeychainHelper.loadAPIKey(instanceId: instance.id) ?? ""
        let fallback = OpenCodeSessionHeader.normalizedSessionId(sessionId) ?? UUID().uuidString
        let header = OpenCodeGo.sessionHeader
        let resolve: @Sendable () -> [String: String] = {
            [header: OpenCodeSessionHeader.resolve(live: sessionBox?.value, fallback: fallback)]
        }
        switch OpenCodeGo.wireProtocol(for: model.id) {
        case .anthropicMessages:
            return AnthropicProvider(manualToken: key, model: model, basePath: OpenCodeGo.apiRoot, appendV1Suffix: true, customUserAgent: MinisUserAgent.default, perRequestHeaders: resolve)
        case .responses:
            let provider = OpenAIProvider(apiKey: key, model: model, customBaseURL: OpenCodeGo.apiRoot, appendV1Suffix: true)
            provider.forceResponsesAPI = true
            provider.perRequestHeaders = { _ in resolve() }
            provider.providerInstanceId = instance.id
            return applyCustomUserAgent(provider, instance: instance, manualToken: nil)
        case .chatCompletions:
            let provider = OpenAIProvider(apiKey: key, model: model, customBaseURL: OpenCodeGo.apiRoot, appendV1Suffix: true)
            provider.perRequestHeaders = { _ in resolve() }
            provider.providerInstanceId = instance.id
            return applyCustomUserAgent(provider, instance: instance, manualToken: nil)
        }
    }

    static func makeOpenAIProvider(instance: ProviderInstance, model: LLMModel) -> OpenAIProvider {
        let manualToken = instance.storedManualToken()
        let customBase = instance.effectiveCustomBaseURL(manualToken: manualToken)
        let appendV1 = instance.appendV1Suffix
        // Mistral's chat-completions endpoint rejects `max_completion_tokens`
        // (newer OpenAI parameter name) and `stream_options` with HTTP 422,
        // and ALSO rejects the `reasoning: {effort: …}` body. Reuse the
        // OpenRouter `max_tokens` body builder via `useOpenRouterCompat`
        // (it switches max_tokens + drops stream_options at once) but mark
        // `isMistral` so the agent loop skips the OpenRouter thinking-param
        // auto-inject.
        let isMistral = (customBase ?? "").lowercased().contains("mistral.ai")
        func configure(_ p: OpenAIProvider) -> OpenAIProvider {
            if isMistral {
                p.useOpenRouterCompat = true
                p.isMistral = true
            }
            return p
        }
        switch instance.credentialType {
        case .apiKey:
            let key = ProviderKeychainHelper.loadAPIKey(instanceId: instance.id) ?? ""
            return applyAzure(applyCustomUserAgent(configure(OpenAIProvider(apiKey: key, model: model, customBaseURL: customBase, appendV1Suffix: appendV1)), instance: instance, manualToken: manualToken), instance: instance)
        case .oauth:
            if let manualToken {
                return applyCustomUserAgent(configure(OpenAIProvider(apiKey: manualToken, model: model, customBaseURL: customBase, appendV1Suffix: appendV1)), instance: instance, manualToken: manualToken)
            }
            let iid = instance.id
            let provider = OpenAIProvider(
                oauthTokenProvider: { try await CodexOAuthManager.shared.validAccessToken(instanceId: iid) },
                model: model
            )
            provider.codexAccountId = CodexOAuthManager.shared.accountId(instanceId: iid)
            return provider
        }
    }

    static func makeOpenRouterProvider(instance: ProviderInstance, model: LLMModel) -> OpenAIProvider {
        let manualToken = instance.storedManualToken()
        let key = manualToken ?? ProviderKeychainHelper.loadAPIKey(instanceId: instance.id) ?? ""
        let customBase = instance.effectiveCustomBaseURL(manualToken: manualToken)
        let provider = OpenAIProvider(apiKey: key, model: model, customBaseURL: customBase ?? "https://openrouter.ai/api", appendV1Suffix: customBase == nil)
        provider.extraHeaders = [
            "HTTP-Referer": "https://github.com/leoyb1010/LeoPhoneAgent",
            "X-Title": "LeoBot App",
        ]
        provider.useOpenRouterCompat = true
        return applyCustomUserAgent(provider, instance: instance, manualToken: manualToken)
    }

    static func makeOpenAIResponsesProvider(instance: ProviderInstance, model: LLMModel) -> OpenAIProvider {
        let manualToken = instance.storedManualToken()
        let customBase = instance.effectiveCustomBaseURL(manualToken: manualToken)
        let appendV1 = instance.appendV1Suffix
        // Both credential types are valid for Responses API instances
        // (e.g. an OpenAI2 instance configured with the user's Codex
        // OAuth login). Previously this branch only loaded an API key
        // and silently produced an empty-auth request when the user had
        // OAuth-only credentials — that's the model-use "Codex model
        // call fails" case (T-model-use-codex-responses-api-34889).
        switch instance.credentialType {
        case .apiKey:
            let key = ProviderKeychainHelper.loadAPIKey(instanceId: instance.id) ?? ""
            let provider = OpenAIProvider(apiKey: key, model: model, customBaseURL: customBase, appendV1Suffix: appendV1)
            provider.forceResponsesAPI = true
            return applyAzure(applyCustomUserAgent(provider, instance: instance, manualToken: manualToken), instance: instance)
        case .oauth:
            if let manualToken {
                let provider = OpenAIProvider(apiKey: manualToken, model: model, customBaseURL: customBase, appendV1Suffix: appendV1)
                provider.forceResponsesAPI = true
                return applyCustomUserAgent(provider, instance: instance, manualToken: manualToken)
            }
            // Signed-in tokens only go to the official endpoint; a persisted
            // custom base from before this rule is ignored.
            let iid = instance.id
            let provider = OpenAIProvider(
                oauthTokenProvider: { try await CodexOAuthManager.shared.validAccessToken(instanceId: iid) },
                model: model
            )
            provider.forceResponsesAPI = true
            provider.codexAccountId = CodexOAuthManager.shared.accountId(instanceId: iid)
            return provider
        }
    }

    /// Kimi Code / Coding Plan — OpenAI-compatible coding upstream reached with
    /// the device-code OAuth bearer. Mirrors makeXAIProvider (custom base +
    /// OAuth bearer through OpenAIProvider). See the Kimi Code OAuth design notes.
    static func makeKimiProvider(instance: ProviderInstance, model: LLMModel) -> OpenAIProvider {
        let officialBase = "https://api.kimi.com/coding"
        let manualToken = instance.storedManualToken()
        let effectiveBase = instance.effectiveCustomBaseURL(manualToken: manualToken)
        let customBase = effectiveBase ?? officialBase
        // The default Kimi coding base is `…/coding` WITHOUT `/v1`; the real
        // endpoints are `/coding/v1/chat/completions` and `/coding/v1/models`
        // (verified: `/coding/chat/completions` 404s, `/coding/v1/…` needs auth).
        // So append `/v1` for the default base; a user-supplied custom base keeps
        // their own appendV1 preference.
        let appendV1 = effectiveBase == nil ? true : instance.appendV1Suffix
        switch instance.credentialType {
        case .apiKey:
            let key = ProviderKeychainHelper.loadAPIKey(instanceId: instance.id) ?? ""
            return applyCustomUserAgent(OpenAIProvider(apiKey: key, model: model, customBaseURL: customBase, appendV1Suffix: appendV1), instance: instance, manualToken: manualToken)
        case .oauth:
            // [T-kimi-manual-token-ignored] "Configure manually" stores a bearer token
            // with credentialType .oauth and names Kimi as the use case; it used to be
            // stored, shown as configured, then ignored ("Kimi: no OAuth token found").
            if let manualToken {
                return applyCustomUserAgent(OpenAIProvider(apiKey: manualToken, model: model, customBaseURL: customBase, appendV1Suffix: appendV1), instance: instance, manualToken: manualToken)
            }
            // Signed-in tokens only go to the official endpoint.
            let iid = instance.id
            let provider = OpenAIProvider(
                oauthTokenProvider: { try await KimiOAuthManager.shared.validAccessToken(instanceId: iid) },
                model: model
            )
            provider.customBaseURL = officialBase
            provider.appendV1Suffix = true
            provider.providerInstanceId = iid
            return provider
        }
    }

    static func makeXAIProvider(instance: ProviderInstance, model: LLMModel) -> OpenAIProvider {
        let officialBase = "https://api.x.ai/v1"
        let manualToken = instance.storedManualToken()
        let effectiveBase = instance.effectiveCustomBaseURL(manualToken: manualToken)
        let customBase = effectiveBase ?? officialBase
        let appendV1 = effectiveBase == nil ? false : instance.appendV1Suffix
        switch instance.credentialType {
        case .apiKey:
            let key = ProviderKeychainHelper.loadAPIKey(instanceId: instance.id) ?? ""
            return applyCustomUserAgent(OpenAIProvider(apiKey: key, model: model, customBaseURL: customBase, appendV1Suffix: appendV1), instance: instance, manualToken: manualToken)
        case .oauth:
            let iid = instance.id
            let tokenProvider: @Sendable () async throws -> String
            switch XAICredentialSource.resolve(instanceId: iid, manualToken: manualToken) {
            case .manualToken(let manualToken):
                return applyCustomUserAgent(OpenAIProvider(apiKey: manualToken, model: model, customBaseURL: customBase, appendV1Suffix: appendV1), instance: instance, manualToken: manualToken)
            case .viaMac:
                tokenProvider = { try await GrokViaMacBroker.shared.token(instanceId: iid) }
            case .oauthLogin, .none:
                tokenProvider = { try await XAIOAuthManager.shared.validAccessToken(instanceId: iid) }
            }
            // Signed-in tokens only go to the official endpoint.
            let provider = OpenAIProvider(oauthTokenProvider: tokenProvider, model: model)
            provider.customBaseURL = officialBase
            provider.appendV1Suffix = false
            provider.providerInstanceId = iid
            return provider
        }
    }
}
