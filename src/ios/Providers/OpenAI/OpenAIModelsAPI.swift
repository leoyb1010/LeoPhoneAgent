import Foundation
import CryptoKit
import os.log

private let logger = AppLogger(category: "OpenAIModelsAPI")

private func stripV1Suffix(_ base: String) -> String {
    var s = base
    while s.hasSuffix("/") { s = String(s.dropLast()) }
    if s.hasSuffix("/v1") { s = String(s.dropLast(3)) }
    return s
}

enum OpenAIModelsAPI {

    private static let defaultBaseURL = "https://api.openai.com"

    static func fetchModels(apiKey: String, baseURL: String? = nil, appendV1Suffix: Bool = true, forceRefresh: Bool = false, userAgent: String? = nil) async throws -> [LLMModel] {
        if !forceRefresh, let cached = OpenAIModelsCache.load(credential: apiKey) {
            logger.info("Returning \(cached.count) cached models (API key)")
            return cached
        }

        let isCustomBase = baseURL != nil
        let base = appendV1Suffix ? stripV1Suffix(baseURL ?? defaultBaseURL) : (baseURL ?? defaultBaseURL)
        let v1Path = appendV1Suffix ? "/v1" : ""
        guard let url = URL(string: URLBuilding.join(base, v1Path, "/models")) else {
            throw LLMError.providerError(message: "Invalid base URL: \(base)")
        }
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
        if let ua = userAgent { request.setValue(ua, forHTTPHeaderField: "User-Agent") }
        logger.info("Fetching OpenAI models (API key auth, custom base: \(isCustomBase), appendV1: \(appendV1Suffix))")
        let models = try await performFetch(request, filterOpenAIOnly: !isCustomBase)
        OpenAIModelsCache.save(models, credential: apiKey)
        return models
    }

    /// OAuth mode, offline fallback: the built-in Codex model list enriched with models.dev data.
    static func fetchModelsOAuth() -> [LLMModel] {
        let enriched = ModelsDevAPI.enrichModels(LLMModel.allOpenAICodexOAuth)
        logger.info("Using built-in Codex OAuth model list (\(enriched.count) models, enriched)")
        return enriched
    }

    /// [T-codex-live-models] OAuth mode: the live Codex catalog, the same list Codex CLI shows.
    ///
    /// OAuth tokens cannot call /v1/models, but the Codex backend has its own catalog at
    /// `GET https://chatgpt.com/backend-api/codex/models?client_version=…` → `{models:[ModelInfo]}`
    /// (codex-rs/codex-api/src/endpoint/models.rs). The old built-in list never learned about new
    /// models (GPT-6 was missing for everyone). Models the server hides (`visibility != "list"`) stay
    /// hidden; image generation is not a catalog model, so gpt-image-2 is kept from the built-in list.
    ///
    /// Failure never shrinks what you have: the last good catalog is reused; with no cache it throws
    /// `ModelRefreshError.catalogUnavailable`, and the refresh keeps the existing entries (and the model
    /// groups built on them). Only an instance with no models at all gets the built-in list (fresh login
    /// while offline). Returning the built-in list on every failure used to let an offline launch delete
    /// catalog-only models and prune them from groups.
    static func fetchModelsCodexOAuth(instanceId: String, forceRefresh: Bool = false,
                                      instanceHasModels: Bool = true) async throws -> [LLMModel] {
        let cacheKey = "codex-oauth-\(instanceId)"
        if !forceRefresh, let cached = OpenAIModelsCache.load(credential: cacheKey) {
            logger.info("Returning \(cached.count) cached Codex catalog models")
            return cached
        }
        let reason: String
        do {
            let token = try await CodexOAuthManager.shared.validAccessToken(instanceId: instanceId)
            var components = URLComponents(string: "https://chatgpt.com/backend-api/codex/models")!
            components.queryItems = [URLQueryItem(name: "client_version", value: OpenAIProvider.codexClientVersion)]
            var request = URLRequest(url: components.url!)
            request.httpMethod = "GET"
            request.timeoutInterval = 20
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            request.setValue(OpenAIProvider.codexClientVersion, forHTTPHeaderField: "Version")
            request.setValue("codex_cli_rs/\(OpenAIProvider.codexClientVersion) (iOS; arm64)", forHTTPHeaderField: "User-Agent")
            request.setValue("codex_cli_rs", forHTTPHeaderField: "Originator")
            request.setValue("application/json", forHTTPHeaderField: "Accept")
            if let accountId = await CodexOAuthManager.shared.accountId(instanceId: instanceId) {
                request.setValue(accountId, forHTTPHeaderField: "Chatgpt-Account-Id")
            }
            let (data, response) = try await URLSession.shared.data(for: request)
            let status = (response as? HTTPURLResponse)?.statusCode ?? -1
            if (200..<300).contains(status) {
                let models = parseCodexCatalog(data)
                if !models.isEmpty {
                    let result = ModelsDevAPI.enrichModels(models) + [LLMModel.gptImage2]
                    OpenAIModelsCache.save(result, credential: cacheKey)
                    logger.info("Codex catalog: \(models.count) models")
                    return result
                }
                reason = "目录为空或无法解析"
            } else {
                reason = "HTTP \(status)"
            }
        } catch {
            reason = error.localizedDescription
        }
        logger.error("Codex catalog unavailable: \(reason)")
        if let cached = OpenAIModelsCache.loadAnyAge(credential: cacheKey) {
            return cached
        }
        if !instanceHasModels {
            return fetchModelsOAuth()
        }
        throw ModelRefreshError.catalogUnavailable(reason: reason)
    }

    /// `{models:[{slug, display_name, visibility, context_window, input_modalities, supported_reasoning_levels, priority}]}`.
    /// Records each model's highest reasoning effort so the thinking picker offers exactly what the server accepts.
    static func parseCodexCatalog(_ data: Data) -> [LLMModel] {
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let rows = json["models"] as? [[String: Any]] else { return [] }
        var ceilings: [String: String] = [:]
        let listed = rows.filter { ($0["visibility"] as? String ?? "list") == "list" }
            .sorted { ($0["priority"] as? Int ?? Int.max) < ($1["priority"] as? Int ?? Int.max) }
        let models: [LLMModel] = listed.compactMap { row in
            guard let slug = row["slug"] as? String, !slug.isEmpty else { return nil }
            let efforts = (row["supported_reasoning_levels"] as? [[String: Any]] ?? []).compactMap { $0["effort"] as? String }
            if let top = CodexReasoningCeiling.highest(of: efforts) { ceilings[slug] = top.rawValue }
            let inputs = row["input_modalities"] as? [String] ?? ["text"]
            var modality: ModelModality = [.textInput, .textOutput]
            if inputs.contains("image") { modality.insert(.imageInput) }
            return LLMModel(
                id: slug,
                displayName: (row["display_name"] as? String) ?? modelDisplayName(from: slug),
                provider: "OpenAI",
                modalityOverride: modality,
                contextWindow: row["context_window"] as? Int,
                supportsReasoning: !efforts.isEmpty)
        }
        if !ceilings.isEmpty { CodexReasoningCeiling.save(ceilings) }
        return models
    }

    private static func performFetch(_ request: URLRequest, filterOpenAIOnly: Bool = true) async throws -> [LLMModel] {
        let (data, response) = try await URLSession.shared.data(for: request)
        let http = response as? HTTPURLResponse
        let statusCode = http?.statusCode ?? -1

        guard (200..<300).contains(statusCode) else {
            let body = String(data: data, encoding: .utf8) ?? ""
            logger.error("OpenAI models API error — status \(statusCode)")
            if statusCode == 401 || statusCode == 403 {
                throw LLMError.invalidAPIKey(detail: "OpenAI HTTP \(statusCode): \(String(body.prefix(200)))")
            }
            throw LLMError.providerError(message: "Failed to fetch OpenAI models (HTTP \(statusCode)): \(body.prefix(500))")
        }

        let json = try JSONSerialization.jsonObject(with: data) as? [String: Any] ?? [:]
        guard let modelsArray = json["data"] as? [[String: Any]] else {
            throw LLMError.decodingError(underlying: NSError(domain: "OpenAIModelsAPI", code: -1,
                userInfo: [NSLocalizedDescriptionKey: "Missing data array in response"]))
        }

        // For official OpenAI endpoints, filter to chat-capable models only.
        // For custom/third-party endpoints, return all models as-is (their IDs won't match OpenAI prefixes).
        let chatPrefixes = ["gpt-", "o1", "o3", "o4-", "codex-", "chatgpt-"]
        let excludeSuffixes = ["-instruct", "-realtime", "-audio", "-transcribe", "-tts", "-embedding"]

        let models = modelsArray.compactMap { item -> LLMModel? in
            guard let id = item["id"] as? String else { return nil }

            if filterOpenAIOnly {
                let isChatModel = chatPrefixes.contains { id.hasPrefix($0) }
                guard isChatModel else { return nil }

                let isExcluded = excludeSuffixes.contains { id.hasSuffix($0) }
                guard !isExcluded else { return nil }

                // Skip fine-tuned models
                guard !id.contains(":ft-") else { return nil }
            }

            let displayName = (item["name"] as? String) ?? modelDisplayName(from: id)

            // Parse modalities. Two wire shapes are supported:
            //   - OpenRouter: nested under `architecture.input_modalities` /
            //     `.output_modalities`, suffixed (`image_input`).
            //   - Groq / other OpenAI-compatible: TOP-LEVEL `input_modalities` /
            //     `output_modalities`, bare. Groq additionally uses voice-specific
            //     output values `transcription` (ASR) and `speech` (TTS).
            // models.dev returns bare forms too. normalizeModality folds the
            // shapes together. When the API DOES report modalities we honour them
            // verbatim — crucially NOT seeding text — so a pure-audio ASR model
            // (Whisper: input=[audio], output=[transcription]) resolves to exactly
            // `.audioInput` and is recognised as a voice model. Only when the API
            // says nothing do we fall back to the text default (load-bearing: a
            // bare default of nil would let text-only endpoints inherit the
            // provider-level `.vision` capability and emit image blocks DeepSeek
            // rejects — see note below).
            let inputArr = (item["input_modalities"] as? [String])
                ?? ((item["architecture"] as? [String: Any])?["input_modalities"] as? [String])
            let outputArr = (item["output_modalities"] as? [String])
                ?? ((item["architecture"] as? [String: Any])?["output_modalities"] as? [String])

            var modality: ModelModality = (inputArr == nil && outputArr == nil) ? [.textInput, .textOutput] : []
            if let inputs = inputArr {
                let bare = Set(inputs.map(Self.normalizeModality))
                if bare.contains("text")  { modality.insert(.textInput) }
                if bare.contains("image") { modality.insert(.imageInput) }
                if bare.contains("pdf")   { modality.insert(.pdfInput) }
                if bare.contains("audio") { modality.insert(.audioInput) }
                if bare.contains("video") { modality.insert(.videoInput) }
            }
            if let outputs = outputArr {
                let bare = Set(outputs.map(Self.normalizeModality))
                if bare.contains("text")          { modality.insert(.textOutput) }
                if bare.contains("transcription") { modality.insert(.textOutput) }   // ASR → text out
                if bare.contains("image")         { modality.insert(.imageOutput) }
                if bare.contains("audio")         { modality.insert(.audioOutput) }
                if bare.contains("speech")        { modality.insert(.audioOutput) }  // TTS → audio out
                if bare.contains("video")         { modality.insert(.videoOutput) }
            }

            // Always record the modality we computed, even when it's plain
            // text. Leaving this nil falls through to the provider-level
            // default (`knownCapabilities["OpenAI"] = .vision`), which then
            // misclassifies text-only OpenAI-compatible endpoints (DeepSeek
            // V4, Mistral, etc.) as vision-capable. The sanitize sites in
            // OpenAIAgentProvider (lines 744 / 900 / 968) then keep emitting
            // `image_url` content blocks into history, which DeepSeek
            // rejects with `unknown variant 'image_url'`. Always-write means
            // text-only endpoints stay text-only, while real OpenAI vision
            // models still get `.imageInput` from the architecture block
            // above (or from models.dev / pattern inference downstream).
            return LLMModel(id: id, displayName: displayName, provider: "OpenAI", modalityOverride: modality)
        }

        let enriched = ModelsDevAPI.enrichModels(models)
        logger.info("Fetched \(modelsArray.count) total models, \(enriched.count) returned (filterOpenAIOnly: \(filterOpenAIOnly))")
        if let first = modelsArray.first,
           let debugData = try? JSONSerialization.data(withJSONObject: first, options: [.prettyPrinted, .sortedKeys]),
           let debugStr = String(data: debugData, encoding: .utf8) {
            logger.info("First model raw JSON:\n\(debugStr)")
        }
        return enriched
    }

    /// Strip `_input` / `_output` suffix and lowercase. Provider APIs are inconsistent —
    /// OpenAI returns `image_input` / `text_output` while models.dev returns bare `image`
    /// / `text`. Mirrors Android's `String.normalizeModalityName`.
    static func normalizeModality(_ raw: String) -> String {
        var s = raw.lowercased()
        if s.hasSuffix("_input") { s = String(s.dropLast("_input".count)) }
        if s.hasSuffix("_output") { s = String(s.dropLast("_output".count)) }
        return s
    }
}

// MARK: - Cache

private enum OpenAIModelsCache {

    private struct Entry: Codable {
        let models: [LLMModel]
        let date: Date
    }

    private static let ttl: TimeInterval = 7 * 24 * 3600

    private static var cacheDir: URL {
        FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("com.leoyuan.leophoneagent.openai-models-cache", isDirectory: true)
    }

    private static func cacheKey(for credential: String) -> String {
        let digest = SHA256.hash(data: Data(credential.utf8))
        return digest.map { String(format: "%02x", $0) }.joined()
    }

    private static func cacheFile(for credential: String) -> URL {
        cacheDir.appendingPathComponent(cacheKey(for: credential) + ".json")
    }

    static func load(credential: String) -> [LLMModel]? {
        let file = cacheFile(for: credential)
        guard let data = try? Data(contentsOf: file),
              let entry = try? JSONDecoder().decode(Entry.self, from: data),
              Date().timeIntervalSince(entry.date) < ttl else {
            return nil
        }
        return entry.models
    }

    /// 过期的也要:目录暂时拉不到时,上次成功的目录比内置清单准。
    static func loadAnyAge(credential: String) -> [LLMModel]? {
        guard let data = try? Data(contentsOf: cacheFile(for: credential)),
              let entry = try? JSONDecoder().decode(Entry.self, from: data) else { return nil }
        return entry.models
    }

    static func save(_ models: [LLMModel], credential: String) {
        let entry = Entry(models: models, date: Date())
        guard let data = try? JSONEncoder().encode(entry) else { return }
        try? FileManager.default.createDirectory(at: cacheDir, withIntermediateDirectories: true)
        try? data.write(to: cacheFile(for: credential), options: .atomic)
    }
}
