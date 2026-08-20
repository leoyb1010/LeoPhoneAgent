import Foundation

/// User-editable thinking ceiling for a model-id prefix. Built-in catalog
/// stays as fallback; a matching custom rule wins so a new model does not
/// require a Swift change.
struct ThinkingRule: Codable, Equatable, Identifiable {
    var prefix: String
    var maxLevel: ThinkingLevel
    var defaultLevel: ThinkingLevel
    var id: String { prefix.lowercased() }
}

enum ThinkingRuleStore {
    static let defaultsKey = "leo.thinkingRules.v1"
    static let lastCarriedKey = "leo.lastCarriedThinking"

    /// [T-thinking-rules-hot-path] 解码结果按「原始 Data」缓存。
    ///
    /// `ThinkingLevelCatalog.declaredMaxLevel(for:)` 会调这里,而它被
    /// AIChatView 在 body 里读(模型标签、思考档位菜单等好几处),流式期间
    /// 每帧都命中。原来每次都新建一个 JSONDecoder 再 decode 一遍——纯浪费,
    /// 而且发生在主线程上。
    /// 缓存刻意用「上次读到的 Data」做判据,而不是靠 save() 主动失效:
    /// UserDefaults 可能被别处(测试、配置下发、另一个进程)直接改写,
    /// 基于 Data 比较不会读到陈旧值;读 UserDefaults 本身是进程内缓存,
    /// 省掉的是 decode。没配过自定义规则时 data 为 nil,直接返回空数组,
    /// 连比较都不用做。
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
        let rows = (try? JSONDecoder().decode([ThinkingRule].self, from: data)) ?? []
        cachedRaw = data
        cachedRules = rows
        return rows
    }

    static func save(_ rules: [ThinkingRule]) {
        let cleaned = rules
            .map { ThinkingRule(prefix: $0.prefix.trimmingCharacters(in: .whitespacesAndNewlines),
                                maxLevel: $0.maxLevel,
                                defaultLevel: min($0.defaultLevel, $0.maxLevel)) }
            .filter { !$0.prefix.isEmpty }
        UserDefaults.standard.set(try? JSONEncoder().encode(cleaned), forKey: defaultsKey)
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
}

private extension String {
    var nilIfEmpty: String? {
        let t = trimmingCharacters(in: .whitespacesAndNewlines)
        return t.isEmpty ? nil : t
    }
}

enum ThinkingLevelCatalog {
    private static let rules: [(match: @Sendable (String) -> Bool, max: ThinkingLevel)] = [
        // GPT-5.6 sol/terra/luna all reach .max. (.ultra is a client-side
        // "Max + orchestration" concept — the wire effort tops out at "max",
        // reasoningEffort(for:level:) maps both .max and .ultra to "max".)
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
    ]

    static func declaredMaxLevel(for modelId: String) -> ThinkingLevel? {
        let lid = modelId.lowercased()
        if let custom = ThinkingRuleStore.load().first(where: { lid.hasPrefix($0.prefix.lowercased()) }) {
            return custom.maxLevel
        }
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
