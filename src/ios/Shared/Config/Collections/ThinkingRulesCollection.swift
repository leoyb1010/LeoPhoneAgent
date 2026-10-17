import Foundation

/// [WP-40] 用户思考规则暴露给 `minis-config`:`thinkingrules.<ruleId>.…`。
///
/// 对照 OpenMinis v1.14 `ThinkingRulesCollection` 改写:上游每个服务商实例一张规则表
/// (子 id 是 `<instanceId>:<ruleId>`);我们是 `ThinkingRuleStore` 里的一张全局表,
/// 规则可选钉到某个实例(`provider` 字段),所以子 id 就是规则 id(UUID,不含点)。
///
/// 只有用户规则可写。内置厂商规则是代码里按请求现算的,不落盘、不同步,这里不列出,
/// 也就没有可写路径 —— 「改不了内置规则」是结构保证,不是运行时检查。
/// 顺序即优先级(先匹配先用):`thinkingrules.order` 一次写整个排列。
@MainActor
struct ThinkingRulesCollection: ConfigCollection {
    let basePath = "thinkingrules"
    let displayName = "Thinking rules"
    let description = "User thinking rules: per model-id pattern, the highest reasoning level offered and/or how the request carries the thinking control. First match wins."
    let addable = true
    let removable = true
    /// 敏感:错的规则会悄悄改掉对应模型每个请求的写法,症状是答得变差而不是报错。
    let risk: ConfigRisk = .sensitive

    /// Add payload:
    /// {
    ///   "pattern": "gpt-5.7",                    // required; no "*" = prefix match
    ///   "max_level": "high",                     // optional ceiling (low…ultra)
    ///   "wire_format": {"kind": "reasoningEffort"}, // optional; at least one of the two
    ///   "label": "my rule",                      // optional, defaults to the pattern
    ///   "provider": "<instanceId>",              // optional; omit = every provider
    ///   "position": 0                            // optional insert index; default = top
    /// }
    let addPayloadSchema: ConfigValueSchema = .json

    static let wireFormatKinds = [
        "anthropicThinking", "booleanToggle", "customPath", "deepSeekSibling",
        "extraBodyToggle", "geminiBudget", "geminiThinkingLevel", "omitEverything",
        "qwenDual", "qwenRootOnly", "reasoningEffort", "reasoningEffortNested",
    ]

    // MARK: - Children

    func childIds() -> [String] { ThinkingRuleStore.load().map(\.id) }

    func fields(for id: String) -> [ConfigField] {
        guard rule(id) != nil else { return [] }
        return [labelField(id), patternField(id), maxLevelField(id), wireFormatField(id), providerField(id)]
    }

    func add(_ payload: ConfigValue) throws -> String {
        guard case .object(let dict) = payload else { throw ConfigError.invalidValue("Expected a JSON object") }
        guard case .string(let pattern)? = dict["pattern"] else {
            throw ConfigError.invalidValue("`pattern` (model id prefix or * glob) is required")
        }
        var maxLevel: ThinkingLevel?
        if case .string(let raw)? = dict["max_level"], !raw.isEmpty { maxLevel = try Self.level(raw) }
        var wire: ThinkingWireFormat?
        if let value = dict["wire_format"], value != .null { wire = try Self.decodeWireFormat(value) }
        var label: String?
        if case .string(let l)? = dict["label"] { label = l }
        var provider: String?
        if case .string(let p)? = dict["provider"], !p.isEmpty { provider = try Self.validProvider(p) }
        var position: Int?
        if case .int(let i)? = dict["position"], i >= 0 { position = i }
        let rule = try edit { try ThinkingRuleEdits.makeRule(pattern: pattern, maxLevel: maxLevel, wireFormat: wire,
                                                             label: label, providerInstanceId: provider) }
        ThinkingRuleStore.save(ThinkingRuleEdits.inserting(rule, into: ThinkingRuleStore.load(), at: position))
        return rule.id
    }

    func remove(id: String) throws {
        if id.hasPrefix("builtin:") {
            throw ConfigError.permissionDenied(
                reason: "Built-in rules are part of the app and cannot be deleted. Add a rule for the same models to override one.")
        }
        ThinkingRuleStore.save(try edit { try ThinkingRuleEdits.removing(id: id, from: ThinkingRuleStore.load()) })
    }

    // MARK: - Order / summary (flat fields, registered alongside the collection)

    static func orderField() -> ConfigField {
        ClosureField(
            path: "thinkingrules.order",
            displayName: "Thinking rule order",
            description: "Ordered ids of the user thinking rules. First match wins, so index 0 has the highest priority.",
            valueSchema: .array(.string()),
            risk: .sensitive, revertable: true,
            reader: { .array(ThinkingRuleStore.load().map { .string($0.id) }) },
            writer: { v in
                guard case .array(let arr) = v else { throw ConfigError.typeMismatch(expected: "array") }
                let ids: [String] = arr.compactMap { if case .string(let s) = $0 { return s } else { return nil } }
                ThinkingRuleStore.save(try edit { try ThinkingRuleEdits.reordered(ThinkingRuleStore.load(), ids: ids) })
            }
        )
    }

    // MARK: - Helpers

    private func rule(_ id: String) -> ThinkingRule? { ThinkingRuleStore.load().first { $0.id == id } }

    /// Translate the shared validation errors into config errors.
    private static func edit<T>(_ body: () throws -> T) throws -> T {
        do { return try body() } catch let e as ThinkingRuleEdits.EditError {
            if case .unknownRule(let id) = e { throw ConfigError.unknownPath("thinkingrules.\(id)") }
            throw ConfigError.invalidValue(e.description)
        }
    }
    private func edit<T>(_ body: () throws -> T) throws -> T { try Self.edit(body) }

    private func mutate(_ id: String, _ apply: (ThinkingRule) throws -> ThinkingRule) throws {
        guard let old = rule(id) else { throw ConfigError.unknownPath("thinkingrules.\(id)") }
        let updated = try apply(old)
        ThinkingRuleStore.save(try edit { try ThinkingRuleEdits.replacing(updated, in: ThinkingRuleStore.load()) })
    }

    /// Rebuild through the shared validator so a field write can never produce a rule
    /// the editor would refuse (e.g. clearing both ceiling and wire format).
    private func rebuilt(_ r: ThinkingRule, pattern: String? = nil, maxLevel: ThinkingLevel?? = nil,
                         wire: ThinkingWireFormat?? = nil, label: String? = nil, provider: String?? = nil) throws -> ThinkingRule {
        try edit {
            try ThinkingRuleEdits.makeRule(pattern: pattern ?? r.patternText,
                                           maxLevel: maxLevel ?? r.maxLevel,
                                           wireFormat: wire ?? r.wireFormat,
                                           label: label ?? r.label,
                                           providerInstanceId: provider ?? r.providerInstanceId,
                                           reasoningEcho: r.reasoningEcho, id: r.id)
        }
    }

    private static func level(_ raw: String) throws -> ThinkingLevel {
        guard let level = ThinkingLevel(rawValue: raw.lowercased()), level != .off else {
            let valid = ThinkingLevel.allCases.filter { $0 != .off }.map(\.rawValue).joined(separator: ", ")
            throw ConfigError.invalidValue("`max_level` must be one of: \(valid)")
        }
        return level
    }

    private static func validProvider(_ raw: String) throws -> String {
        let id = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard ProviderConfigStore.shared.instance(for: id) != nil else {
            throw ConfigError.invalidValue("Unknown provider instance: \(id)")
        }
        return id
    }

    /// ConfigValue ↔ the `{"kind": …}` object the rule store persists. JSON is the bridge
    /// so the CLI accepts exactly what the store can hold, with no second mapping to drift.
    static func decodeWireFormat(_ value: ConfigValue) throws -> ThinkingWireFormat {
        guard case .object = value,
              let data = value.jsonString().data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let parsed = ThinkingWireFormat.fromPersistedJSON(obj) else {
            throw ConfigError.invalidValue("Unrecognised wire_format. Valid `kind` values: \(wireFormatKinds.joined(separator: ", "))")
        }
        return parsed
    }

    static func encodeWireFormat(_ wf: ThinkingWireFormat) -> ConfigValue {
        guard let data = try? JSONSerialization.data(withJSONObject: wf.persistedJSON),
              let str = String(data: data, encoding: .utf8),
              let value = ConfigValue.decode(json: str) else { return .null }
        return value
    }

    // MARK: - Field factories

    private func labelField(_ id: String) -> ConfigField {
        ClosureField(
            path: "thinkingrules.\(id).label", displayName: "Label",
            description: "User-visible rule name.", valueSchema: .string(maxLength: 200),
            risk: .normal, revertable: true,
            reader: { [self] in rule(id).map { .string($0.label) } ?? .null },
            writer: { [self] v in
                guard case .string(let s) = v else { throw ConfigError.typeMismatch(expected: "string") }
                try mutate(id) { try rebuilt($0, label: s) }
            })
    }

    private func patternField(_ id: String) -> ConfigField {
        ClosureField(
            path: "thinkingrules.\(id).pattern", displayName: "Model pattern",
            description: "Model-id pattern. Without \"*\" it is a prefix (gpt-5.7 matches gpt-5.7-mini); \"*\" matches any characters. Case-insensitive; \".\" and \"-\" are treated alike.",
            valueSchema: .string(maxLength: 200), risk: .sensitive, revertable: true,
            reader: { [self] in rule(id).map { .string($0.patternText) } ?? .null },
            writer: { [self] v in
                guard case .string(let s) = v else { throw ConfigError.typeMismatch(expected: "string") }
                try mutate(id) { try rebuilt($0, pattern: s) }
            })
    }

    private func maxLevelField(_ id: String) -> ConfigField {
        ClosureField(
            path: "thinkingrules.\(id).max_level", displayName: "Highest level",
            description: "Highest reasoning level the picker offers for matching models (low, medium, high, xhigh, max, ultra). Empty string = no ceiling from this rule.",
            valueSchema: .string(), risk: .sensitive, revertable: true,
            reader: { [self] in rule(id).map { .string($0.maxLevel?.rawValue ?? "") } ?? .null },
            writer: { [self] v in
                guard case .string(let s) = v else { throw ConfigError.typeMismatch(expected: "string") }
                let level: ThinkingLevel? = s.isEmpty ? nil : try Self.level(s)
                try mutate(id) { try rebuilt($0, maxLevel: .some(level)) }
            })
    }

    private func wireFormatField(_ id: String) -> ConfigField {
        ClosureField(
            path: "thinkingrules.\(id).wire_format", displayName: "Wire format",
            description: "JSON {\"kind\": …} for how OpenAI-compatible requests carry the thinking control, or null to follow the built-in vendor rules. For qwen pick by ENDPOINT: \"qwenDual\" only for DashScope itself, \"qwenRootOnly\" for relays / vLLM / SGLang.",
            valueSchema: .json, risk: .sensitive, revertable: true,
            reader: { [self] in
                guard let r = rule(id) else { return .null }
                return r.wireFormat.map(Self.encodeWireFormat) ?? .null
            },
            writer: { [self] v in
                let wire: ThinkingWireFormat? = v == .null ? nil : try Self.decodeWireFormat(v)
                try mutate(id) { try rebuilt($0, wire: .some(wire)) }
            })
    }

    private func providerField(_ id: String) -> ConfigField {
        ClosureField(
            path: "thinkingrules.\(id).provider", displayName: "Provider instance",
            description: "Restrict the wire format to one provider instance id. Empty string = every provider. Ceilings always apply to every provider.",
            valueSchema: .string(), risk: .sensitive, revertable: true,
            reader: { [self] in rule(id).map { .string($0.providerInstanceId ?? "") } ?? .null },
            writer: { [self] v in
                guard case .string(let s) = v else { throw ConfigError.typeMismatch(expected: "string") }
                let provider: String? = s.isEmpty ? nil : try Self.validProvider(s)
                try mutate(id) { try rebuilt($0, provider: .some(provider)) }
            })
    }
}
