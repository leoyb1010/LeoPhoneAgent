import Foundation

private let logger = AppLogger(category: "ModelsDevAPI")

/// Fetches and caches the models.dev provider registry.
/// Used as a fallback when a provider's /v1/models endpoint is unavailable,
/// and as the source of truth for model capabilities (modality, context window, output limit).
enum ModelsDevAPI {

    private static let sourceURL = "https://models.dev/api.json"
    private static let cacheTTL: TimeInterval = 48 * 3600 // 48 hours

    // MARK: - Provider-key mapping for enrichment lookups

    /// Maps the `provider` string stored in LLMModel to one or more models.dev provider keys.
    /// Order matters — first match wins.
    private static let providerKeyMap: [String: [String]] = [
        "Anthropic": ["anthropic"],
        "Google": ["google", "google-vertex"],
        "OpenAI": ["openai"],
        "OpenRouter": ["openrouter"],
        "OpenCode Go": ["opencode-go", "opencode"],
    ]

    // MARK: - Public: Fetch models by base URL

    /// Look up models for a provider by matching its API base URL against models.dev entries.
    /// Tries both with and without `/v1` suffix, normalizing trailing slashes.
    /// Returns immediately from bundled/cached data; network refresh happens in the background.
    static func fetchModels(forBaseURL baseURL: String) -> [LLMModel] {
        guard let registry = loadRegistry() else {
            logger.info("models.dev registry not loaded")
            return []
        }

        logger.info("models.dev lookup: baseURL=\(baseURL), registry has \(registry.count) providers")

        // Phase 1: Exact API base match (with/without /v1)
        let candidates = normalizedCandidates(for: baseURL)
        logger.info("models.dev phase1: candidates=\(candidates)")
        for (_, provider) in registry {
            guard let api = provider.api, !api.isEmpty else { continue }
            let normalizedAPI = stripTrailingSlash(api)
            for candidate in candidates {
                if candidate == normalizedAPI {
                    let models = buildModels(from: provider)
                    logger.info("Exact match \(provider.id) (api=\(api)) — \(models.count) models")
                    return models
                }
            }
        }

        // Phase 2: Hostname fallback — match by full hostname when exact path doesn't match
        let inputHost = extractHost(from: baseURL)
        logger.info("models.dev phase2: inputHost=\(inputHost ?? "nil")")
        if let inputHost {
            for (_, provider) in registry {
                guard let api = provider.api, !api.isEmpty,
                      let providerHost = extractHost(from: api) else { continue }
                if inputHost == providerHost {
                    let models = buildModels(from: provider)
                    logger.info("Host match \(provider.id) (host=\(providerHost), api=\(api)) — \(models.count) models")
                    return models
                }
            }
        }

        logger.info("No models.dev match for base URL: \(baseURL)")
        return []
    }

    private static func buildModels(from provider: ModelsDevProvider) -> [LLMModel] {
        provider.models.compactMap { (_, model) -> LLMModel? in
            let family = model.family?.lowercased() ?? ""
            if family.contains("embedding") || family.contains("moderation") { return nil }
            var built = LLMModel(
                id: model.id,
                displayName: model.name ?? model.id,
                provider: provider.name ?? provider.id,
                modalityOverride: model.resolvedModality,
                contextWindow: model.limit?.context,
                maxOutputTokens: model.limit?.output,
                supportsReasoning: model.reasoning,
                interleavedReasoningField: model.interleaved?.field,
                reasoningEffortValues: model.effortValues,
                declaresNoEffortTiers: model.declaresNoEffortTiers ? true : nil
            )
            // [T-thinking-off-custom-provider] These models ARE the catalog entry for the
            // endpoint (matched by base URL), so their effort declaration describes the
            // endpoint being called.
            built.effortDeclarationIsAuthoritative = (model.effortValues != nil) ? true : nil
            return built
        }
    }

    /// Extract the full hostname from a URL string.
    /// e.g. "https://coding.dashscope.aliyuncs.com/v1" → "coding.dashscope.aliyuncs.com"
    private static func extractHost(from urlString: String) -> String? {
        URL(string: stripTrailingSlash(urlString))?.host?.lowercased()
    }

    // MARK: - Public: Enrich a single model with models.dev data

    /// Enrich an LLMModel with capabilities from models.dev (modality, context window, output limit).
    /// Looks up by provider name + model ID. Returns the original model if no match found.
    /// Only fills in fields that are currently nil/unset on the model.
    static func enrichModel(_ model: LLMModel) -> LLMModel {
        guard let registry = loadRegistry() else { return model }
        guard let match = resolveDevModel(for: model, in: registry) else { return model }
        return applyDevData(to: model, from: match.model, authoritative: match.authoritative)
    }

    /// [T-modelsdev-id-normalization] Normalized catalog key; see `ModelsDevKey`.
    static func normalizedModelKey(_ id: String) -> String {
        ModelsDevKey.normalized(id)
    }

    /// Where a catalog match came from. `authoritative` is true only for a hit under the
    /// model's OWN provider key; the cross-provider vote describes other endpoints.
    private struct DevModelMatch {
        let model: ModelsDevModel
        let authoritative: Bool
    }

    /// [T-modelsdev-id-normalization] Deterministic catalog resolution shared by
    /// `enrichModel` and `enrichModels`:
    ///   1. the model's own provider key — exact id, then normalized id (authoritative);
    ///   2. every provider by normalized id; among candidates declaring effort tiers the
    ///      most common set wins (ties: first in sorted provider/id order);
    ///   3. [T-modelsdev-suffix-alias] longest segment-boundary prefix of the id
    ///      (`glm-5.3-flash-cpa` → `glm-5-3-flash`), never down to a bare family (`glm-5`).
    /// Stages 2–3 are non-authoritative.
    private static func resolveDevModel(
        for model: LLMModel, in registry: [String: ModelsDevProvider]
    ) -> DevModelMatch? {
        let wanted = normalizedModelKey(model.id)
        for key in providerKeyMap[model.provider] ?? [] {
            guard let prov = registry[key] else { continue }
            if let devModel = prov.models[model.id] {
                return DevModelMatch(model: devModel, authoritative: true)
            }
            for id in prov.models.keys.sorted() where normalizedModelKey(id) == wanted {
                if let devModel = prov.models[id] {
                    return DevModelMatch(model: devModel, authoritative: true)
                }
            }
        }
        guard let index = stage2Index(for: registry) else { return nil }
        if let hit = index[wanted] { return hit }
        return prefixMatch(wanted, in: index)
    }

    private static func prefixMatch(_ wanted: String, in index: [String: DevModelMatch]) -> DevModelMatch? {
        for candidate in ModelsDevKey.prefixCandidates(of: wanted) {
            if let hit = index[candidate] {
                return DevModelMatch(model: hit.model, authoritative: false)
            }
        }
        return nil
    }

    /// Stage-2 winners keyed by normalized id, rebuilt when the registry timestamp moves.
    /// Precomputed once rather than rescanning ~6k catalog ids per enriched model.
    private static var cachedStage2Index: [String: DevModelMatch]?
    private static var stage2IndexBuiltFrom: Date?
    /// Enrichment runs from several tasks at once (refreshes, onboarding); the index is
    /// built and swapped under this lock so two builders never write the static at once.
    private static let stage2Lock = NSLock()

    private static func stage2Index(for registry: [String: ModelsDevProvider]) -> [String: DevModelMatch]? {
        stage2Lock.lock()
        defer { stage2Lock.unlock() }
        if let cached = cachedStage2Index, stage2IndexBuiltFrom == cacheTimestamp {
            return cached
        }
        var grouped: [String: [ModelsDevModel]] = [:]
        for key in registry.keys.sorted() {
            guard let prov = registry[key] else { continue }
            for id in prov.models.keys.sorted() {
                guard let devModel = prov.models[id] else { continue }
                grouped[normalizedModelKey(id), default: []].append(devModel)
            }
        }
        var index: [String: DevModelMatch] = [:]
        index.reserveCapacity(grouped.count)
        for (normalized, candidates) in grouped {
            if let winner = ModelsDevKey.majorityIndex(candidates.map(\.effortValues)) {
                index[normalized] = DevModelMatch(model: candidates[winner], authoritative: false)
            }
        }
        cachedStage2Index = index
        stage2IndexBuiltFrom = cacheTimestamp
        logger.info("[ModelsDev] stage-2 index built: \(index.count) normalized keys")
        return index
    }

    /// The AI SDK package a provider's catalog names for one model (its own
    /// `provider.npm`, e.g. `@ai-sdk/anthropic`), or nil when the model has none.
    static func modelProviderNpm(providerKey: String, modelId: String) -> String? {
        loadRegistry()?[providerKey]?.models[modelId]?.provider?.npm
    }

    /// Enrich an array of models in bulk. Same resolver as `enrichModel`, so a single
    /// model and a bulk refresh never disagree about the same id.
    static func enrichModels(_ models: [LLMModel]) -> [LLMModel] {
        guard let registry = loadRegistry() else { return models }
        return models.map { model in
            guard let match = resolveDevModel(for: model, in: registry) else { return model }
            return applyDevData(to: model, from: match.model, authoritative: match.authoritative)
        }
    }

    // MARK: - Apply models.dev data to LLMModel

    private static func applyDevData(
        to model: LLMModel, from devModel: ModelsDevModel, authoritative: Bool = false
    ) -> LLMModel {
        var result = model

        // Modality: models.dev is the source of truth — always apply when available.
        // This overrides both provider-level defaults and API-parsed modalities,
        // since models.dev has accurate per-model data (e.g. pdf support distinctions).
        if let devModality = devModel.resolvedModality {
            result.modalityOverride = devModality
        }

        // Context window: models.dev is the source of truth
        if let ctx = devModel.limit?.context {
            result.contextWindow = ctx
        }

        // Max output tokens: models.dev is the source of truth
        if let out = devModel.limit?.output {
            result.maxOutputTokens = out
        }

        // Reasoning capability
        if let reasoning = devModel.reasoning {
            result.supportsReasoning = reasoning
        }

        // Interleaved reasoning field (e.g. "reasoning_content" for DeepSeek/Kimi)
        if let field = devModel.interleaved?.field {
            result.interleavedReasoningField = field
        }

        // [T-reasoning-effort-data-driven] Declared effort tiers, plus whether they came
        // from this model's own provider (only that may clamp or suppress on the wire).
        if let efforts = devModel.effortValues {
            result.reasoningEffortValues = efforts
            result.effortDeclarationIsAuthoritative = authoritative
        }
        // [OpenMinis#163] Only set when the catalog says so, never overwrite with false.
        if devModel.declaresNoEffortTiers {
            result.declaresNoEffortTiers = true
        }

        return result
    }

    // MARK: - URL Matching Helpers

    private static func normalizedCandidates(for url: String) -> [String] {
        let stripped = stripTrailingSlash(url)
        var results = [stripped]
        if stripped.hasSuffix("/v1") {
            results.append(String(stripped.dropLast(3)))
        } else {
            results.append(stripped + "/v1")
        }
        return results
    }

    private static func stripTrailingSlash(_ s: String) -> String {
        var r = s
        while r.hasSuffix("/") { r = String(r.dropLast()) }
        return r
    }

    // MARK: - Registry Cache

    private static var cachedRegistry: [String: ModelsDevProvider]?
    private static var cacheTimestamp: Date?
    /// True while a background network fetch is in flight (prevents concurrent fetches).
    private static var isRefreshing = false

    /// Returns the registry immediately from memory/disk/bundle (never blocks on network).
    /// Triggers a background refresh when the cache is stale (>24h), at most one at a time.
    private static func loadRegistry() -> [String: ModelsDevProvider]? {
        // 1. In-memory cache (fresh)
        if let cached = cachedRegistry, let ts = cacheTimestamp,
           Date().timeIntervalSince(ts) < cacheTTL {
            return cached
        }

        // 2. In-memory cache exists but stale — return it, schedule refresh
        if let cached = cachedRegistry {
            scheduleBackgroundRefresh()
            return cached
        }

        // 3. Disk cache (downloaded data) — fallback to bundled on parse failure
        if let (diskData, diskDate) = loadDiskCache() {
            if let parsed = parseRegistry(diskData) {
                cachedRegistry = parsed
                cacheTimestamp = diskDate
                if Date().timeIntervalSince(diskDate) >= cacheTTL {
                    scheduleBackgroundRefresh()
                }
                return parsed
            } else {
                logger.error("Downloaded models.dev cache failed to parse, falling back to bundled")
            }
        }

        // 4. Bundled fallback — must always succeed
        if let bundled = loadBundledRegistry() {
            cachedRegistry = bundled
            cacheTimestamp = Date() // Treat as fresh to avoid repeated bundled loads within same session
            scheduleBackgroundRefresh()
            return bundled
        }

        return nil
    }

    /// Schedule a background refresh if one isn't already in flight.
    private static func scheduleBackgroundRefresh() {
        guard !isRefreshing else { return }
        isRefreshing = true
        Task.detached(priority: .utility) {
            await refreshFromNetwork()
        }
    }

    private static func refreshFromNetwork() async {
        defer { isRefreshing = false }
        do {
            guard let url = URL(string: sourceURL) else { return }
            var request = URLRequest(url: url)
            request.timeoutInterval = 15
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
                logger.error("models.dev HTTP error: \((response as? HTTPURLResponse)?.statusCode ?? -1)")
                return
            }
            if let parsed = parseRegistry(data) {
                cachedRegistry = parsed
                cacheTimestamp = Date()
                saveDiskCache(data)
                logger.info("Background-refreshed models.dev registry: \(parsed.count) providers")
            }
        } catch {
            logger.error("Failed to fetch models.dev: \(error.localizedDescription)")
        }
    }

    private static func parseRegistry(_ data: Data) -> [String: ModelsDevProvider]? {
        do {
            return try JSONDecoder().decode([String: ModelsDevProvider].self, from: data)
        } catch {
            logger.error("Failed to parse models.dev JSON (\(data.count) bytes): \(error)")
            return nil
        }
    }

    // MARK: - Bundled Fallback

    private static func loadBundledRegistry() -> [String: ModelsDevProvider]? {
        guard let url = Bundle.main.url(forResource: "models-dev-api", withExtension: "json") else {
            logger.error("Bundled models-dev-api.json not found in bundle")
            assertionFailure("Bundled models-dev-api.json missing from app bundle")
            return nil
        }
        guard let data = try? Data(contentsOf: url) else {
            logger.error("Bundled models-dev-api.json failed to read: \(url.path)")
            assertionFailure("Bundled models-dev-api.json unreadable")
            return nil
        }
        guard let parsed = parseRegistry(data) else {
            logger.error("Bundled models-dev-api.json failed to parse (\(data.count) bytes)")
            assertionFailure("Bundled models-dev-api.json failed to parse — update the bundled file or fix ModelsDevModel decoding")
            return nil
        }
        logger.info("Loaded bundled models.dev registry: \(parsed.count) providers")
        return parsed
    }

    // MARK: - Disk Cache

    private static var cacheFileURL: URL {
        let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first!
        return caches.appendingPathComponent("com.leoyuan.leophoneagent.models-dev-cache").appendingPathComponent("api.json")
    }

    private static func loadDiskCache() -> (Data, Date)? {
        let url = cacheFileURL
        guard FileManager.default.fileExists(atPath: url.path),
              let data = try? Data(contentsOf: url),
              let attrs = try? FileManager.default.attributesOfItem(atPath: url.path),
              let modified = attrs[.modificationDate] as? Date else { return nil }
        return (data, modified)
    }

    private static func saveDiskCache(_ data: Data) {
        let url = cacheFileURL
        try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? data.write(to: url, options: .atomic)
    }
}

// MARK: - models.dev JSON Models

private struct ModelsDevProvider: Decodable {
    let id: String
    let name: String?
    let api: String?
    let models: [String: ModelsDevModel]

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        name = try container.decodeIfPresent(String.self, forKey: .name)
        api = try container.decodeIfPresent(String.self, forKey: .api)
        models = try container.decodeIfPresent([String: ModelsDevModel].self, forKey: .models) ?? [:]
    }

    enum CodingKeys: String, CodingKey {
        case id, name, api, models
    }
}

private struct ModelsDevModel: Decodable {
    let id: String
    let name: String?
    let family: String?
    let modalities: ModelsDevModalities?
    let limit: ModelsDevLimit?
    let reasoning: Bool?
    let interleaved: ModelsDevInterleaved?
    /// Per-model provider override (e.g. `{"npm": "@ai-sdk/anthropic"}`).
    let provider: ModelsDevModelProvider?
    /// [T-reasoning-effort-data-driven] models.dev `reasoning_options`. Lenient: a
    /// non-array value reads as "no opinion" instead of failing the whole registry.
    private let reasoningOptionsField: ModelsDevReasoningOptionList?
    var reasoningOptions: [ModelsDevReasoningOption]? { reasoningOptionsField?.items }

    enum CodingKeys: String, CodingKey {
        case id, name, family, modalities, limit, reasoning, interleaved, provider
        case reasoningOptionsField = "reasoning_options"
    }

    /// Effort tiers declared by the catalog, or nil when the model exposes no
    /// `effort`-type option (`toggle` / `budget_tokens` are different mechanisms).
    var effortValues: [String]? {
        guard let opts = reasoningOptions else { return nil }
        let values = opts.first { $0.type == "effort" }?.values?.map { $0.lowercased() }
        guard let values, !values.isEmpty else { return nil }
        return values
    }

    /// [OpenMinis#163] `reasoning_options` PRESENT but without a usable effort entry:
    /// the catalog states the model reasons without an effort parameter (xAI
    /// grok-build-0.1 400s on `reasoning_effort`). Absent options = no opinion.
    var declaresNoEffortTiers: Bool {
        guard reasoningOptions != nil else { return false }
        return effortValues == nil
    }

    /// Convert models.dev modalities to app ModelModality.
    var resolvedModality: ModelModality? {
        guard let mod = modalities else { return nil }
        var result: ModelModality = []
        let inp = mod.input ?? []
        let out = mod.output ?? []
        if inp.contains("text")  { result.insert(.textInput) }
        if inp.contains("image") { result.insert(.imageInput) }
        if inp.contains("pdf")   { result.insert(.pdfInput) }
        if inp.contains("audio") { result.insert(.audioInput) }
        if inp.contains("video") { result.insert(.videoInput) }
        if out.contains("text")  { result.insert(.textOutput) }
        if out.contains("image") { result.insert(.imageOutput) }
        if out.contains("audio") { result.insert(.audioOutput) }
        if out.contains("video") { result.insert(.videoOutput) }
        return result.isEmpty ? nil : result
    }
}

private struct ModelsDevModalities: Decodable {
    let input: [String]?
    let output: [String]?
}

/// Lenient: an unexpected shape decodes to nil instead of failing the whole registry.
private struct ModelsDevModelProvider: Decodable {
    let npm: String?

    init(from decoder: Decoder) throws {
        let container = try? decoder.container(keyedBy: CodingKeys.self)
        npm = try? container?.decodeIfPresent(String.self, forKey: .npm)
    }

    enum CodingKeys: String, CodingKey {
        case npm
    }
}

private struct ModelsDevLimit: Decodable {
    let context: Int?
    let output: Int?
}

/// [T-reasoning-effort-data-driven] One entry of models.dev `reasoning_options`:
/// `{"type":"toggle"}`, `{"type":"effort","values":[…]}`, `{"type":"budget_tokens",…}`.
///
/// `values` is decoded element-wise: models.dev ships null elements
/// (`[null,"low","medium","high"]`), and one bad element must not fail the whole
/// registry decode. An entry with an unexpected shape decodes to nil fields.
private struct ModelsDevReasoningOption: Decodable {
    let type: String?
    let values: [String]?

    enum CodingKeys: String, CodingKey { case type, values }

    init(from decoder: Decoder) throws {
        let container = try? decoder.container(keyedBy: CodingKeys.self)
        type = try? container?.decodeIfPresent(String.self, forKey: .type)
        guard var list = try? container?.nestedUnkeyedContainer(forKey: .values) else {
            values = nil
            return
        }
        var parsed: [String] = []
        while !list.isAtEnd {
            if let s = try? list.decode(String.self) {
                parsed.append(s)
            } else if (try? list.decode(AnyDecodableSkip.self)) == nil {
                break
            }
        }
        values = parsed.isEmpty ? nil : parsed
    }
}

/// `reasoning_options` as an array, or nil for any other shape.
private struct ModelsDevReasoningOptionList: Decodable {
    let items: [ModelsDevReasoningOption]?

    init(from decoder: Decoder) throws {
        items = try? decoder.singleValueContainer().decode([ModelsDevReasoningOption].self)
    }
}

/// Consumes exactly one value of unknown type so an unkeyed container can skip it.
private struct AnyDecodableSkip: Decodable {
    init(from decoder: Decoder) throws {}
}

/// `interleaved` can be either a bool (`true`) or an object (`{"field": "reasoning_content"}`).
private struct ModelsDevInterleaved: Decodable {
    let field: String?

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        // Try object first
        if let dict = try? container.decode([String: String].self) {
            field = dict["field"]
        } else if let flag = try? container.decode(Bool.self) {
            // bool true → default field name "reasoning_content"
            field = flag ? "reasoning_content" : nil
        } else {
            field = nil
        }
    }
}
