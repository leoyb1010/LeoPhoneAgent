import Foundation

/// User thinking rules (`ThinkingRule`, kind `.custom`), stored in UserDefaults.
///
/// ONE store for both rule jobs: ceiling rules (`maxLevel`, read by
/// `ThinkingLevelCatalog.declaredMaxLevel`) and wire-shape rules (`wireFormat`, read by
/// `ThinkingRuleResolver` through `wireRules(for:)`). The key and the legacy row shape
/// `{prefix, maxLevel, defaultLevel}` are unchanged, so rules saved by older builds load
/// as-is — no migration step to fail or run twice.
enum ThinkingRuleStore {
    static let defaultsKey = "leo.thinkingRules.v1"
    static let lastCarriedKey = "leo.lastCarriedThinking"

    /// [T-thinking-rules-hot-path] 解码结果按「原始 Data」缓存。
    ///
    /// `declaredMaxLevel(for:)` 在 AIChatView 的 body 里被读(流式期间每帧都命中),
    /// 请求组装时 `wireRules(for:)` 也会读。缓存判据是「上次读到的 Data」而不是靠
    /// save() 主动失效:UserDefaults 可能被别处直接改写,基于 Data 比较不会读到陈旧值。
    private static let cacheLock = NSLock()
    nonisolated(unsafe) private static var cachedRaw: Data?
    nonisolated(unsafe) private static var cachedRules: [ThinkingRule] = []

    static func load() -> [ThinkingRule] {
        guard let data = UserDefaults.standard.data(forKey: defaultsKey) else {
            cacheLock.lock()
            cachedRaw = nil
            cachedRules = []
            cacheLock.unlock()
            return []
        }
        cacheLock.lock()
        defer { cacheLock.unlock() }
        if cachedRaw == data { return cachedRules }
        let rows = (try? JSONSerialization.jsonObject(with: data)) as? [[String: Any]] ?? []
        // Unknown/malformed rows are dropped individually, never the whole list.
        let rules = rows.compactMap(ThinkingRule.fromPersistedJSON)
        cachedRaw = data
        cachedRules = rules
        return rules
    }

    static func save(_ rules: [ThinkingRule]) {
        let cleaned: [[String: Any]] = rules.compactMap { rule in
            var r = rule
            r.kind = .custom
            if case .modelPattern(let p) = r.scope {
                let trimmed = p.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !trimmed.isEmpty else { return nil }
                r.scope = .modelPattern(trimmed)
                if r.label.isEmpty || r.label == p { r.label = trimmed }
            }
            guard r.wireFormat != nil || r.maxLevel != nil else { return nil }
            return r.persistedJSON
        }
        if let data = try? JSONSerialization.data(withJSONObject: cleaned, options: [.sortedKeys]) {
            UserDefaults.standard.set(data, forKey: defaultsKey)
        }
    }

    /// The first user ceiling for `modelId` (global rules only — the ceiling API has no
    /// provider context).
    static func ceiling(for modelId: String) -> ThinkingLevel? {
        load().first { $0.maxLevel != nil && $0.providerInstanceId == nil && $0.matches(modelId) }?.maxLevel
    }

    /// User wire-shape rules that apply to a provider instance, in list order: global
    /// rules plus the ones pinned to this instance. Empty = built-in behaviour only.
    static func wireRules(for instanceId: String?) -> [ThinkingRule] {
        load().filter { rule in
            rule.wireFormat != nil
                && (rule.providerInstanceId == nil || rule.providerInstanceId == instanceId)
        }
    }

    static func rememberCarried(_ level: ThinkingLevel) {
        UserDefaults.standard.set(level.rawValue, forKey: lastCarriedKey)
    }

    static func lastCarriedRaw() -> String? {
        UserDefaults.standard.string(forKey: lastCarriedKey)
    }
}

enum AgentModelSlots {
    static let compactKey = "leo.compactTitleEntryId"

    static var compactEntryId: String? {
        get { UserDefaults.standard.string(forKey: compactKey)?.nilIfEmpty }
        set { UserDefaults.standard.set(newValue, forKey: compactKey) }
    }

    /// 槽里的模型被删掉时清空,设置页不再显示一个不存在的选项(用的时候本来
    /// 就会回落到当前会话模型)。
    static func forget(entryIds: Set<String>) {
        if let id = compactEntryId, entryIds.contains(id) { compactEntryId = nil }
    }
}

private extension String {
    var nilIfEmpty: String? {
        let t = trimmingCharacters(in: .whitespacesAndNewlines)
        return t.isEmpty ? nil : t
    }
}

/// [T-codex-live-models] 每个 Codex 模型最高支持的推理强度,取自服务端目录的
/// `supported_reasoning_levels`。线上最高只发到 "max"(见 reasoningEffort(for:level:)),
/// 所以目录里的 "ultra" 也记作 .max。
enum CodexReasoningCeiling {
    private static let key = "codex.reasoningCeiling.v1"
    private static let order: [String: ThinkingLevel] = [
        "low": .low, "medium": .medium, "high": .high, "xhigh": .xhigh, "max": .max, "ultra": .max,
    ]

    static func highest(of efforts: [String]) -> ThinkingLevel? {
        efforts.compactMap { order[$0.lowercased()] }.max()
    }

    static func save(_ ceilings: [String: String]) {
        var merged = UserDefaults.standard.dictionary(forKey: key) as? [String: String] ?? [:]
        for (slug, level) in ceilings { merged[slug.lowercased()] = level }
        UserDefaults.standard.set(merged, forKey: key)
    }

    static func level(for modelId: String) -> ThinkingLevel? {
        guard let raw = (UserDefaults.standard.dictionary(forKey: key) as? [String: String])?[modelId.lowercased()] else { return nil }
        return ThinkingLevel(rawValue: raw)
    }

    // Lowest effort each model accepts. Models with mandatory reasoning don't
    // list "none", and sending it when the user turns thinking off is a 400.
    private static let floorKey = "codex.reasoningFloor.v1"
    private static let wireOrder = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]

    static func lowest(of efforts: [String]) -> String? {
        efforts.map { $0.lowercased() }
            .compactMap { e in wireOrder.firstIndex(of: e).map { (e, $0) } }
            .min { $0.1 < $1.1 }?.0
    }

    static func saveFloors(_ floors: [String: String]) {
        var merged = UserDefaults.standard.dictionary(forKey: floorKey) as? [String: String] ?? [:]
        for (slug, effort) in floors { merged[slug.lowercased()] = effort }
        UserDefaults.standard.set(merged, forKey: floorKey)
    }

    static func floorEffort(for modelId: String) -> String? {
        (UserDefaults.standard.dictionary(forKey: floorKey) as? [String: String])?[modelId.lowercased()]
    }

    /// The effort to send when the user turned thinking off: `preferred`, or
    /// the model's lowest accepted tier when `preferred` is below it.
    static func clampOffEffort(_ preferred: String, floor: String?) -> String {
        guard let floor,
              let f = wireOrder.firstIndex(of: floor),
              let p = wireOrder.firstIndex(of: preferred.lowercased()),
              p < f else { return preferred }
        return floor
    }
}

enum ThinkingLevelCatalog {
    private static let rules: [(match: @Sendable (String) -> Bool, max: ThinkingLevel)] = [
        // GPT-5.6 sol/terra/luna all reach .max. (.ultra is a client-side
        // "Max + orchestration" concept — the wire effort tops out at "max",
        // reasoningEffort(for:level:) maps both .max and .ultra to "max".)
        // GPT-6 astra/sol/luna 都到 max(目录里 astra/sol 写的 ultra 同样按 max 发)。
        ({ $0.hasPrefix("gpt-6") }, .max),
        ({ $0.hasPrefix("gpt-5.6-sol") || $0.hasPrefix("gpt-5.6-terra") }, .max),
        ({ $0.hasPrefix("gpt-5.6-luna") }, .max),
        ({ $0.hasPrefix("gpt-5.5") }, .xhigh),
        // MiMo ships BOTH id spellings in the wild: catalog docs say
        // "MiMo-2.5" but the live API (api.xiaomimimo.com /v1/models) returns
        // "mimo-v2.5" / "mimo-v2.5-pro" — the old "mimo-2.5" substring missed
        // those, so the wrapper clamp passed xhigh straight through to a
        // backend that 400s on it (verified on-device 2026-07-21). Match the
        // family, not one spelling.
        ({ $0.contains("mimo") || $0.contains("agnes") }, .high),
        // ByteDance seed (Volcano Ark "seed-1.6…"/"seed-2.0…", OpenRouter
        // "bytedance-seed/…"): rejects xhigh with "Invalid reasoning_effort:
        // xhigh" — the field report behind T-fallback-thinking-preclamp. Ark's
        // ladder tops out at high.
        ({ $0.contains("seed-") || $0.contains("bytedance-seed") }, .high),
        // Claude Opus 4.x — model IDs use hyphens (claude-opus-4-8) in the
        // built-in catalog but third-party proxies may return dots
        // (claude-opus-4.8). Normalize to match both.
        ({ Self.normalizedHasPrefix($0, "claude-opus-4") }, .max),
        // [T-anthropic-opus55-ceiling] Claude Opus 5.x — same ceiling (claude-opus-5-5
        // is not in the bundled catalog, so without a rule Max never appeared).
        ({ Self.normalizedHasPrefix($0, "claude-opus-5") }, .max),
        // [T-deepseek-flash-scope] DeepSeek V4 / bare deepseek-flash accept "max";
        // the wire path snaps xhigh down to "high" (DeepSeek's ladder is [high,max]).
        ({ $0.contains("deepseek-flash") || $0.contains("deepseek-v4") }, .max),
    ]

    static func declaredMaxLevel(for modelId: String) -> ThinkingLevel? {
        let lid = modelId.lowercased()
        if let custom = ThinkingRuleStore.ceiling(for: lid) {
            return custom
        }
        // [T-codex-live-models] 服务端目录里写明的上限优先于内置规则:新模型(GPT-6 等)不用等发版。
        if let live = CodexReasoningCeiling.level(for: lid) { return live }
        return rules.first { $0.match(lid) }?.max
    }

    /// Unknown family: do not silently invent a ceiling. Caller must treat
    /// nil as "未发送 / 未知".
    static func isKnownFamily(for modelId: String) -> Bool {
        declaredMaxLevel(for: modelId) != nil
    }

    private static func normalizedHasPrefix(_ id: String, _ prefix: String) -> Bool {
        let normalized = id.replacingOccurrences(of: ".", with: "-")
        return normalized.hasPrefix(prefix)
    }
}

// MARK: - OpenCode Go wire protocol

/// Which endpoint an OpenCode Go model is served on. `OpenCodeGo.wireProtocol(for:)`
/// is the entry point; the table lives here because this file is compiled into
/// MinisTests (OpenCodeGo.swift is not), so the routing has unit coverage.
///
/// A model's own `provider.npm` in the models.dev `opencode-go` catalog wins (it
/// is what the official opencode client routes by). Without one, the endpoint
/// table of https://opencode.ai/docs/go/ applies: GPT / Grok / Muse Spark on
/// `/v1/responses`, every MiniMax and Qwen model on `/v1/messages`, the rest
/// on `/v1/chat/completions`. Keep the fallback in step with
/// src/harmony/protocol/providerModels.ts and ProviderModels.ets.
enum OpenCodeGoWireProtocol: Equatable, Sendable {
    case chatCompletions
    case responses
    case anthropicMessages

    static func resolve(modelId: String, catalogNpm: String?) -> OpenCodeGoWireProtocol {
        if let catalogNpm, let fromCatalog = fromNpm(catalogNpm) { return fromCatalog }
        return fallback(modelId: modelId)
    }

    /// The AI SDK package models.dev names for a model; nil for one we can't speak.
    static func fromNpm(_ npm: String) -> OpenCodeGoWireProtocol? {
        switch npm.lowercased() {
        case "@ai-sdk/anthropic": return .anthropicMessages
        case "@ai-sdk/openai": return .responses
        case "@ai-sdk/openai-compatible": return .chatCompletions
        default: return nil
        }
    }

    static func fallback(modelId: String) -> OpenCodeGoWireProtocol {
        let id = bareId(modelId)
        if responsesPrefixes.contains(where: { id.hasPrefix($0) }) { return .responses }
        if messagesPrefixes.contains(where: { id.hasPrefix($0) }) { return .anthropicMessages }
        return .chatCompletions
    }

    /// Lowercased id without an `opencode-go/`-style provider prefix.
    static func bareId(_ modelId: String) -> String {
        let id = modelId.lowercased()
        guard let slash = id.lastIndex(of: "/") else { return id }
        return String(id[id.index(after: slash)...])
    }

    static let responsesPrefixes = ["gpt-", "grok-", "muse-spark-"]
    static let messagesPrefixes = ["minimax-", "qwen"]
}
