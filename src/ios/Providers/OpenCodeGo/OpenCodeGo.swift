import Foundation
import os.log

private let logger = AppLogger(category: "OpenCodeGo")

/// OpenCode Go — the official opencode.ai subscription API, authenticated
/// with an API key from https://opencode.ai/auth.
///
/// All models live under one base URL, but each model family is served over
/// the wire protocol its upstream speaks, so the provider is picked per model.
enum OpenCodeGo {
    /// Root without `/v1`; OpenAIProvider / AnthropicProvider append it.
    static let apiRoot = "https://opencode.ai/zen/go"
    static let keyPageURL = URL(string: "https://opencode.ai/auth")!
    static let providerName = "OpenCode Go"

    enum WireProtocol: Equatable {
        case chatCompletions
        case responses
        case anthropicMessages
    }

    static func wireProtocol(for modelId: String) -> WireProtocol {
        var id = modelId.lowercased()
        if let slash = id.lastIndex(of: "/") { id = String(id[id.index(after: slash)...]) }
        if id.hasPrefix("gpt-") || id.hasPrefix("grok-") || id.hasPrefix("muse-spark-") {
            return .responses
        }
        // Only these two are served over Anthropic Messages; minimax-m2.7 and
        // the other qwen models are chat/completions.
        if anthropicMessagesModels.contains(id) {
            return .anthropicMessages
        }
        return .chatCompletions
    }

    private static let anthropicMessagesModels: Set<String> = ["minimax-m3", "qwen3.8-flash"]

    static let fallbackModels: [LLMModel] = [
        LLMModel(id: "kimi-k3", displayName: "Kimi K3", provider: providerName),
        LLMModel(id: "glm-5.3", displayName: "GLM-5.3", provider: providerName),
        LLMModel(id: "deepseek-v4-pro", displayName: "DeepSeek V4 Pro", provider: providerName),
        LLMModel(id: "deepseek-v4-flash", displayName: "DeepSeek V4 Flash", provider: providerName),
        LLMModel(id: "qwen3.8-max", displayName: "Qwen3.8 Max", provider: providerName),
        LLMModel(id: "kimi-k2.7-code", displayName: "Kimi K2.7 Code", provider: providerName),
        LLMModel(id: "mimo-v2.5-pro", displayName: "MiMo V2.5 Pro", provider: providerName),
        LLMModel(id: "minimax-m2.7", displayName: "MiniMax M2.7", provider: providerName),
        LLMModel(id: "minimax-m3", displayName: "MiniMax M3", provider: providerName),
        LLMModel(id: "gpt-5.6-luna", displayName: "GPT-5.6 Luna", provider: providerName),
        LLMModel(id: "grok-4.6", displayName: "Grok 4.6", provider: providerName),
    ]

    /// `GET /zen/go/v1/models` with the Bearer key. Throws on auth / network
    /// failure so "Test & Save" can report a bad key; an empty catalog falls
    /// back to the built-in list.
    static func fetchModels(apiKey: String, forceRefresh: Bool = false) async throws -> [LLMModel] {
        let fetched = try await OpenAIModelsAPI.fetchModels(
            apiKey: apiKey,
            baseURL: apiRoot,
            appendV1Suffix: true,
            forceRefresh: forceRefresh,
            userAgent: MinisUserAgent.default
        )
        guard !fetched.isEmpty else {
            logger.info("Empty /models catalog; using \(fallbackModels.count) built-in models")
            return ModelsDevAPI.enrichModels(fallbackModels)
        }
        return fetched.map {
            LLMModel(
                id: $0.id,
                displayName: $0.displayName,
                provider: providerName,
                modalityOverride: $0.modalityOverride,
                contextWindow: $0.contextWindow,
                maxOutputTokens: $0.maxOutputTokens,
                supportsReasoning: $0.supportsReasoning,
                interleavedReasoningField: $0.interleavedReasoningField
            )
        }
    }
}
