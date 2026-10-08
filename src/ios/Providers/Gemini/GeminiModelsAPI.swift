import Foundation
import CryptoKit
import os.log

private let logger = AppLogger(category: "GeminiModelsAPI")

enum GeminiModelsAPI {

    private static let defaultBaseURL = "https://generativelanguage.googleapis.com/v1beta/models"

    static func fetchModels(apiKey: String, customBaseURL: String? = nil, forceRefresh: Bool = false) async throws -> [LLMModel] {
        if !forceRefresh, let cached = GeminiModelsCache.load(credential: apiKey) {
            logger.info("Returning \(cached.count) cached models (API key)")
            return cached
        }

        let modelsURL = customBaseURL.map { base -> String in
            // Trim trailing slashes to detect a /models suffix reliably.
            var trimmed = base
            while trimmed.hasSuffix("/") { trimmed.removeLast() }
            return trimmed.hasSuffix("/models") ? trimmed : URLBuilding.join(trimmed, "/models")
        } ?? defaultBaseURL
        // [T-ios-gemini-baseurl-force-unwrap] `modelsURL` comes from the user's editable
        // Base URL (a pasted space, full-width punctuation or a bidi mark makes it nil).
        // Force-unwrapping crashed the app at LAUNCH (auto-refresh runs on startup) — a
        // boot loop. Throw instead; the refresh fails softly and keeps the model list.
        // Never put the key in the message: `modelsURL` carries no query yet.
        guard var components = URLComponents(string: modelsURL) else {
            throw LLMError.providerError(message: "Invalid Gemini base URL: \(modelsURL)")
        }
        components.queryItems = [URLQueryItem(name: "key", value: apiKey)]

        guard let url = components.url else {
            throw LLMError.providerError(message: "Invalid Gemini base URL: \(modelsURL)")
        }
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        logger.info("Fetching Gemini models (API key auth)")
        let models = try await performFetch(request)
        GeminiModelsCache.save(models, credential: apiKey)
        return models
    }

    private static func performFetch(_ request: URLRequest) async throws -> [LLMModel] {
        // Redact API key from logged URL
        let logURL: String
        if let url = request.url, var comps = URLComponents(url: url, resolvingAgainstBaseURL: false) {
            let redacted = comps.queryItems?.map { item in
                item.name == "key" ? URLQueryItem(name: "key", value: "***") : item
            }
            comps.queryItems = redacted
            logURL = comps.string ?? url.absoluteString
        } else {
            logURL = "<nil>"
        }
        logger.info("GET \(logURL)")

        let (data, response) = try await URLSession.shared.data(for: request)
        let http = response as? HTTPURLResponse
        let statusCode = http?.statusCode ?? -1
        let responseBody = String(data: data, encoding: .utf8) ?? "<binary>"

        logger.info("Response status: \(statusCode)")

        guard (200..<300).contains(statusCode) else {
            logger.error("Gemini models API error — status \(statusCode)")
            #if DEBUG
            logger.error("Models API failure status=\(statusCode) responseBytes=\(data.count)")
            #endif
            if statusCode == 401 || statusCode == 403 {
                throw LLMError.invalidAPIKey(detail: "Gemini HTTP \(statusCode): \(String(responseBody.prefix(200)))")
            }
            throw LLMError.providerError(message: "Failed to fetch Gemini models (HTTP \(statusCode)): \(responseBody.prefix(500))")
        }

        let json = try JSONSerialization.jsonObject(with: data) as? [String: Any] ?? [:]
        guard let modelsArray = json["models"] as? [[String: Any]] else {
            logger.error("Missing 'models' array in response. Keys: \(Array(json.keys).joined(separator: ", "))")
            #if DEBUG
            logger.error("Models API response missing models array responseBytes=\(data.count)")
            #endif
            throw LLMError.decodingError(underlying: NSError(domain: "GeminiModelsAPI", code: -1,
                userInfo: [NSLocalizedDescriptionKey: "Missing models array in response"]))
        }

        let models = modelsArray.compactMap { item -> LLMModel? in
            // name format: "models/gemini-2.5-flash"
            guard let fullName = item["name"] as? String else { return nil }
            let id = fullName.replacingOccurrences(of: "models/", with: "")
            let displayName = item["displayName"] as? String ?? id

            // Filter to chat-capable models only
            guard let methods = item["supportedGenerationMethods"] as? [String],
                  methods.contains("generateContent") else { return nil }

            return LLMModel(id: id, displayName: displayName, provider: "Google")
        }

        let enriched = ModelsDevAPI.enrichModels(models)
        logger.info("Fetched \(modelsArray.count) total models, \(enriched.count) chat-capable")
        if let first = modelsArray.first,
           let debugData = try? JSONSerialization.data(withJSONObject: first, options: [.prettyPrinted, .sortedKeys]),
           let debugStr = String(data: debugData, encoding: .utf8) {
            logger.info("First model raw JSON:\n\(debugStr)")
        }
        return enriched
    }
}

// MARK: - Cache

private enum GeminiModelsCache {

    private struct Entry: Codable {
        let models: [LLMModel]
        let date: Date
    }

    private static let ttl: TimeInterval = 7 * 24 * 3600

    private static var cacheDir: URL {
        FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("com.leoyuan.leophoneagent.gemini-models-cache", isDirectory: true)
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

    static func save(_ models: [LLMModel], credential: String) {
        let entry = Entry(models: models, date: Date())
        guard let data = try? JSONEncoder().encode(entry) else { return }
        try? FileManager.default.createDirectory(at: cacheDir, withIntermediateDirectories: true)
        try? data.write(to: cacheFile(for: credential), options: .atomic)
    }
}
