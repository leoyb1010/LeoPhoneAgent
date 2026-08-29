import Foundation

/// xAI API keys and Grok OAuth are distinct products. OAuth tokens use xAI's
/// first-party CLI proxy and its live entitlement catalog; the built-in list is
/// only the offline fallback.
enum XAIModelsAPI {
    static let oauthAPIBase = "https://cli-chat-proxy.grok.com/v1"
    private static let modelsURL = URL(string: "\(oauthAPIBase)/models")!

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

    static func fetchOAuthModels(
        accessToken: String,
        userID: String?,
        email: String?
    ) async throws -> [LLMModel] {
        var request = URLRequest(url: modelsURL)
        request.setValue("Bearer \(accessToken)", forHTTPHeaderField: "Authorization")
        request.setValue("xai-grok-cli", forHTTPHeaderField: "X-XAI-Token-Auth")
        request.setValue(Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "LeoPhoneAgent", forHTTPHeaderField: "x-grok-client-version")
        request.setValue("app", forHTTPHeaderField: "x-grok-client-mode")
        if let userID, !userID.isEmpty { request.setValue(userID, forHTTPHeaderField: "x-userid") }
        if let email, !email.isEmpty { request.setValue(email, forHTTPHeaderField: "x-user-email") }

        let delegate = NoRedirectDelegate()
        let session = URLSession(configuration: .ephemeral, delegate: delegate, delegateQueue: nil)
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse,
              (200..<300).contains(http.statusCode),
              http.url?.host?.lowercased() == "cli-chat-proxy.grok.com" else {
            throw LLMError.providerError(message: "xAI OAuth model catalog unavailable")
        }
        let models = try parseModels(data: data)
        return models.isEmpty ? ModelsDevAPI.enrichModels(allModels) : ModelsDevAPI.enrichModels(models)
    }

    static func parseModels(data: Data) throws -> [LLMModel] {
        guard let root = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let rawModels = (root["data"] ?? root["models"]) as? [[String: Any]] else { return [] }
        var seen = Set<String>()
        return rawModels.compactMap { item in
            if item["hidden"] as? Bool == true || item["supportedInApi"] as? Bool == false { return nil }
            let id = ["id", "model", "modelId"].compactMap { item[$0] as? String }.first { !$0.isEmpty }
            guard let id, seen.insert(id).inserted else { return nil }
            let family = item["modelFamily"] as? String ?? id
            let efforts = item["reasoningEfforts"] as? [Any] ?? []
            let reasoning = item["supportsReasoning"] as? Bool == true || !efforts.isEmpty || "\(id) \(family)".lowercased().contains("reasoning") || id.lowercased().hasPrefix("grok-4")
            let supportsImages = item["supportsImages"] as? Bool == true
            let inputs = item["inputModalities"] as? [String] ?? (supportsImages ? ["text", "image"] : ["text"])
            let outputs = item["outputModalities"] as? [String] ?? ["text"]
            var modality: ModelModality = []
            if inputs.contains("text") { modality.insert(.textInput) }
            if inputs.contains("image") { modality.insert(.imageInput) }
            if inputs.contains("audio") { modality.insert(.audioInput) }
            if outputs.contains("text") { modality.insert(.textOutput) }
            if outputs.contains("image") { modality.insert(.imageOutput) }
            return LLMModel(
                id: id,
                displayName: item["name"] as? String ?? modelDisplayName(from: id),
                provider: "xAI",
                modalityOverride: modality,
                contextWindow: positiveInt(item, keys: ["contextWindow", "contextLength", "maxContextTokens"]),
                maxOutputTokens: positiveInt(item, keys: ["maxOutputTokens", "maxTokens"]),
                supportsReasoning: reasoning
            )
        }
    }

    private static func positiveInt(_ item: [String: Any], keys: [String]) -> Int? {
        for key in keys {
            if let value = item[key] as? Int, value > 0 { return value }
            if let value = item[key] as? NSNumber, value.intValue > 0 { return value.intValue }
        }
        return nil
    }
}

private final class NoRedirectDelegate: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest,
        completionHandler: @escaping (URLRequest?) -> Void
    ) {
        completionHandler(nil)
    }
}
