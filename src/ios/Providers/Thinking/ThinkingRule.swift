import Foundation

/// One thinking rule — the SINGLE model for both jobs a rule can do:
///
///   • wire shape (`wireFormat`): how the OpenAI-compatible request carries the
///     thinking control for matching models (resolved by `ThinkingRuleResolver`);
///   • ceiling (`maxLevel`): the highest thinking level the picker offers for matching
///     model ids (read by `ThinkingLevelCatalog.declaredMaxLevel`).
///
/// Built-in rules (`.officialVendor` / `.providerTypeDefault`) carry only a wire shape and
/// are never persisted. User rules (`.custom`) are stored in UserDefaults
/// (`ThinkingRuleStore`, key `leo.thinkingRules.v1`); rows written by older builds —
/// `{prefix, maxLevel, defaultLevel}` ceiling rows — decode into this same type.
struct ThinkingRule: Equatable, Identifiable {

    enum Kind: String, Equatable {
        /// User-authored. Always sorts ABOVE built-ins.
        case custom
        /// A specific vendor's documented shape (DeepSeek official, Venice, Ark…).
        case officialVendor
        /// The fallback for a provider type when no vendor rule matched. Its scope is
        /// always `.allModels`, which guarantees resolution never falls through.
        case providerTypeDefault
    }

    /// Which models this rule applies to.
    enum Scope: Equatable {
        case allModels
        /// Glob against the model id, `*` being the only wildcard.
        case modelPattern(String)

        /// Case-insensitive, and normalises `.` to `-` before matching: catalogs spell
        /// `claude-opus-4-8` while relays return `claude-opus-4.8`, and MiMo docs say
        /// `mimo-2.5` while the live API serves `mimo-v2.5`.
        func matches(_ modelId: String) -> Bool {
            switch self {
            case .allModels:
                return true
            case .modelPattern(let pattern):
                return Self.glob(pattern.lowercased().replacingOccurrences(of: ".", with: "-"),
                                 matches: modelId.lowercased().replacingOccurrences(of: ".", with: "-"))
            }
        }

        /// Minimal glob: `*` matches any run of characters, everything else is literal.
        static func glob(_ pattern: String, matches input: String) -> Bool {
            let parts = pattern.components(separatedBy: "*")
            if parts.count == 1 { return input == pattern }

            var cursor = input.startIndex
            for (i, part) in parts.enumerated() {
                if part.isEmpty { continue }
                if i == 0 {
                    guard input.hasPrefix(part) else { return false }
                    cursor = input.index(cursor, offsetBy: part.count)
                    continue
                }
                if i == parts.count - 1 && !pattern.hasSuffix("*") {
                    // Trailing literal must land exactly at the end.
                    guard input.hasSuffix(part),
                          input.distance(from: cursor, to: input.endIndex) >= part.count else { return false }
                    continue
                }
                guard let found = input.range(of: part, range: cursor..<input.endIndex) else { return false }
                cursor = found.upperBound
            }
            return true
        }
    }

    var kind: Kind
    var scope: Scope
    /// nil = this rule expresses no opinion on the wire shape. Such a rule never takes
    /// part in wire resolution (it would otherwise shadow the built-in vendor rules
    /// below it); it may still carry a `maxLevel` ceiling.
    var wireFormat: ThinkingWireFormat?
    /// Declared for completeness of the vendor contract; the echo path still lives in
    /// `flattenChatCompletionsMessages`.
    var reasoningEcho: ReasoningEchoPolicy?
    /// Human-readable identifier, surfaced in the resolution trace.
    var label: String
    /// Stable identity. Custom rules get a UUID at creation; built-ins derive theirs from
    /// label + scope so five `openai-native` rows never collapse into one SwiftUI row.
    var id: String
    /// [Leo] Highest thinking level offered for matching ids (custom rules only).
    var maxLevel: ThinkingLevel?
    /// [Leo] Restrict a custom rule to one provider instance. nil = every provider.
    var providerInstanceId: String?

    /// Built-ins are read-only: they can be overridden by a custom rule above them,
    /// never removed, so stage A always has a matching rule.
    var isEditable: Bool { kind == .custom }

    init(
        kind: Kind,
        scope: Scope,
        wireFormat: ThinkingWireFormat?,
        reasoningEcho: ReasoningEchoPolicy? = nil,
        label: String,
        id: String? = nil,
        maxLevel: ThinkingLevel? = nil,
        providerInstanceId: String? = nil
    ) {
        self.kind = kind
        self.scope = scope
        self.wireFormat = wireFormat
        self.reasoningEcho = reasoningEcho
        self.label = label
        self.maxLevel = maxLevel
        self.providerInstanceId = providerInstanceId
        self.id = id ?? (kind == .custom
            ? UUID().uuidString
            : "builtin:\(label):\(scope.persistedKind):\(scope.persistedPattern ?? "*")")
    }

    /// A user ceiling rule for a model-id prefix (the shape the settings screen edits).
    static func ceiling(prefix: String, maxLevel: ThinkingLevel, id: String? = nil) -> ThinkingRule {
        ThinkingRule(kind: .custom, scope: .modelPattern(prefix), wireFormat: nil,
                     label: prefix, id: id, maxLevel: maxLevel)
    }

    /// Does this rule apply to `modelId`?
    ///
    /// A CUSTOM pattern without any `*` is a PREFIX ("gpt-5.7" matches "gpt-5.7-mini"),
    /// which is what the settings screen always meant and what every row saved by older
    /// builds (`lid.hasPrefix(prefix)`) relies on. Built-in patterns are exact globs.
    func matches(_ modelId: String) -> Bool {
        if kind == .custom, case .modelPattern(let p) = scope, !p.contains("*") {
            return Scope.modelPattern(p + "*").matches(modelId)
        }
        return scope.matches(modelId)
    }

    /// Settings-screen text for the scope. Empty for `.allModels`.
    var patternText: String {
        get {
            if case .modelPattern(let p) = scope { return p }
            return ""
        }
        set { scope = .modelPattern(newValue) }
    }

    /// Settings-screen binding for the ceiling picker.
    var ceilingLevel: ThinkingLevel {
        get { maxLevel ?? .high }
        set { maxLevel = newValue }
    }
}

/// How captured reasoning is echoed back on assistant history turns. Declared only;
/// the live behaviour is in `flattenChatCompletionsMessages`.
struct ReasoningEchoPolicy: Equatable {
    /// `reasoning_content` / `reasoning` / `reasoning_text`.
    var fieldName: String
    var timing: Timing

    enum Timing: Equatable {
        /// Some gateways validate unconditionally once thinking is active.
        case everyTurn
        /// DeepSeek's documented requirement: only tool-call turns must echo.
        case afterToolUseOnly
        /// Mistral / Cerebras: never.
        case never
    }
}
