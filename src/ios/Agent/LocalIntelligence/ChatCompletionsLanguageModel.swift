//
//  ChatCompletionsLanguageModel.swift
//  MinisApp
//
//  [WP-45] Foundation Models 27 `LanguageModel` adapter onto an OpenAI-compatible
//  Chat Completions endpoint (wire format: ChatCompletionsWire). Lets the "local brain"
//  run on a model the user configured — typically the Mac's subscription proxy behind
//  Leo Link — when Apple's on-device model is unavailable. Text only.
//

import Foundation
#if canImport(FoundationModels)
import FoundationModels

struct ChatCompletionsLanguageModel: LanguageModel {
    typealias Executor = ChatCompletionsExecutor

    let base: URL
    let apiKey: String
    let modelId: String

    var capabilities: LanguageModelCapabilities { LanguageModelCapabilities([]) }

    var executorConfiguration: ChatCompletionsExecutor.Configuration {
        .init(base: base, apiKey: apiKey, modelId: modelId)
    }

    /// The configured entry, or nil when it no longer resolves (deleted provider, no key).
    @MainActor
    static func preferred() -> ChatCompletionsLanguageModel? {
        guard let id = ExternalBrainPreference.entryId else { return nil }
        let store = ProviderConfigStore.shared
        // Only OpenAI-compatible endpoints the user pointed at a custom base (the Mac proxy,
        // a relay): first-party SDK providers speak other protocols.
        guard let entry = store.entry(for: id),
              let instance = store.instance(for: entry.providerInstanceId),
              instance.effectiveCustomBaseURL != nil else { return nil }
        let resolved = instance.resolvedBaseURL(default: "")
        guard let base = URL(string: resolved.appendV1 ? resolved.url + "/v1" : resolved.url) else { return nil }
        let key = ProviderKeychainHelper.loadAPIKey(instanceId: instance.id) ?? ""
        return ChatCompletionsLanguageModel(base: base, apiKey: key, modelId: entry.model.id)
    }
}

struct ChatCompletionsExecutor: LanguageModelExecutor {
    struct Configuration: Hashable, Sendable {
        let base: URL
        let apiKey: String
        let modelId: String
    }
    typealias Model = ChatCompletionsLanguageModel

    let configuration: Configuration

    init(configuration: Configuration) throws {
        self.configuration = configuration
    }

    func prewarm(model: ChatCompletionsLanguageModel, transcript: Transcript) {}

    nonisolated(nonsending) func respond(to request: LanguageModelExecutorGenerationRequest,
                                         model: ChatCompletionsLanguageModel,
                                         streamingInto channel: LanguageModelExecutorGenerationChannel) async throws {
        let messages = Self.messages(from: request.transcript)
        let urlRequest = ChatCompletionsWire.request(base: configuration.base, apiKey: configuration.apiKey,
                                                     model: configuration.modelId, messages: messages)
        let (data, response) = try await URLSession.shared.data(for: urlRequest)
        let reply = try ChatCompletionsWire.parse(status: (response as? HTTPURLResponse)?.statusCode ?? 0, data: data)
        await channel.send(.response(action: .appendText(reply.text, tokenCount: reply.completionTokens)))
        await channel.send(.response(action: .updateUsage(
            input: .init(totalTokenCount: reply.promptTokens, cachedTokenCount: 0),
            output: .init(totalTokenCount: reply.completionTokens, reasoningTokenCount: 0))))
    }

    /// Instructions → system, prompts → user, responses → assistant; text segments only.
    static func messages(from transcript: Transcript) -> [ChatCompletionsWire.Message] {
        func text(_ segments: [Transcript.Segment]) -> String {
            segments.compactMap { segment -> String? in
                if case .text(let t) = segment { return t.content }
                return nil
            }.joined(separator: "\n")
        }
        return transcript.compactMap { entry -> ChatCompletionsWire.Message? in
            switch entry {
            case .instructions(let i): return .init(role: "system", content: text(i.segments))
            case .prompt(let p): return .init(role: "user", content: text(p.segments))
            case .response(let r): return .init(role: "assistant", content: text(r.segments))
            default: return nil
            }
        }
    }
}
#endif
