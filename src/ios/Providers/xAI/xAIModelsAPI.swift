import Foundation

/// Built-in xAI Grok model catalog. Mirrors OpenMinis: the picker remains
/// available after OAuth without depending on a CLI-only catalog endpoint.
enum XAIModelsAPI {
    static let allModels: [LLMModel] = [
        LLMModel(id: "grok-4.6", displayName: "Grok 4.6", provider: "xAI", modalityOverride: [.textInput, .imageInput, .textOutput], contextWindow: 500_000, supportsReasoning: true),
        LLMModel(id: "grok-4.5", displayName: "Grok 4.5", provider: "xAI"),
        LLMModel(id: "grok-4.3", displayName: "Grok 4.3", provider: "xAI"),
        LLMModel(id: "grok-4.20-0309-reasoning", displayName: "Grok 4.20 Reasoning", provider: "xAI"),
        LLMModel(id: "grok-4.20-0309-non-reasoning", displayName: "Grok 4.20", provider: "xAI"),
        LLMModel(id: "grok-4.20-multi-agent-0309", displayName: "Grok 4.20 Multi-Agent", provider: "xAI"),
        LLMModel(id: "grok-build-0.1", displayName: "Grok Build 0.1", provider: "xAI"),
        LLMModel(id: "grok-3-mini", displayName: "Grok 3 Mini", provider: "xAI"),
        LLMModel(id: "grok-3-mini-fast", displayName: "Grok 3 Mini Fast", provider: "xAI"),
        LLMModel(id: "grok-composer-2.5-fast", displayName: "Grok Composer 2.5 Fast", provider: "xAI"),
        // High-frequency fast / code variants surfaced by OpenClaw's catalog.
        LLMModel(id: "grok-4-fast", displayName: "Grok 4 Fast", provider: "xAI"),
        LLMModel(id: "grok-4-fast-non-reasoning", displayName: "Grok 4 Fast (Non-Reasoning)", provider: "xAI"),
        LLMModel(id: "grok-code-fast-1", displayName: "Grok Code Fast 1", provider: "xAI"),
    ]

}
