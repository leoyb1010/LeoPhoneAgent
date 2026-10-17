import Foundation

/// [WP-40] 用户思考规则的增删改排 —— 设置页的规则编辑器和 `minis-config thinkingrules`
/// 共用这一套校验,两边不会对「什么算合法规则」各说各话(移植 OpenMinis v1.14 思考规则
/// 编辑与 CLI 集合时,按我们的单表 `ThinkingRuleStore` 模型改写:规则是全局列表,
/// 可选钉到某个服务商实例,而不是上游的「每个实例一张表」)。
///
/// 列表顺序就是优先级:先匹配先用,所以新规则默认插在最上面。
enum ThinkingRuleEdits {
    enum EditError: Error, Equatable, CustomStringConvertible {
        case emptyPattern
        /// 既没有最高档也没有思考参数写法:存了也什么都不做。
        case nothingToDo
        case offIsNotACeiling
        case unknownRule(String)
        case notAPermutation(expected: Int)

        var description: String {
            switch self {
            case .emptyPattern: return "Model pattern must not be empty"
            case .nothingToDo: return "A rule needs a ceiling (max_level), a wire format, or both"
            case .offIsNotACeiling: return "max_level cannot be \"off\"; leave it empty to keep the built-in ceiling"
            case .unknownRule(let id): return "Unknown thinking rule: \(id)"
            case .notAPermutation(let n): return "Must be a permutation of the \(n) rule id(s)"
            }
        }
    }

    /// 校验并构造一条用户规则。`id` 传入时保持身份(编辑),否则新建 UUID。
    static func makeRule(pattern: String, maxLevel: ThinkingLevel?, wireFormat: ThinkingWireFormat?,
                         label: String? = nil, providerInstanceId: String? = nil,
                         reasoningEcho: ReasoningEchoPolicy? = nil, id: String? = nil) throws -> ThinkingRule {
        let trimmed = pattern.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { throw EditError.emptyPattern }
        if maxLevel == .off { throw EditError.offIsNotACeiling }
        guard maxLevel != nil || wireFormat != nil else { throw EditError.nothingToDo }
        let name = (label ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let provider = providerInstanceId?.trimmingCharacters(in: .whitespacesAndNewlines)
        return ThinkingRule(kind: .custom, scope: .modelPattern(trimmed), wireFormat: wireFormat,
                            reasoningEcho: reasoningEcho, label: name.isEmpty ? trimmed : name, id: id,
                            maxLevel: maxLevel,
                            providerInstanceId: (provider?.isEmpty ?? true) ? nil : provider)
    }

    /// 插到 `position`(默认 0 = 最高优先级)。
    static func inserting(_ rule: ThinkingRule, into rules: [ThinkingRule], at position: Int? = nil) -> [ThinkingRule] {
        var list = rules.filter { $0.id != rule.id }
        list.insert(rule, at: min(max(position ?? 0, 0), list.count))
        return list
    }

    /// 原位替换(编辑不改变优先级)。
    static func replacing(_ rule: ThinkingRule, in rules: [ThinkingRule]) throws -> [ThinkingRule] {
        guard let idx = rules.firstIndex(where: { $0.id == rule.id }) else { throw EditError.unknownRule(rule.id) }
        var list = rules
        list[idx] = rule
        return list
    }

    static func removing(id: String, from rules: [ThinkingRule]) throws -> [ThinkingRule] {
        guard rules.contains(where: { $0.id == id }) else { throw EditError.unknownRule(id) }
        return rules.filter { $0.id != id }
    }

    /// 整体重排。只接受现有 id 的一个排列:少给会悄悄把规则挪到末尾,多给的 id 什么都不做,
    /// 两种都比直接报错更糟。
    static func reordered(_ rules: [ThinkingRule], ids: [String]) throws -> [ThinkingRule] {
        guard ids.count == rules.count, Set(ids) == Set(rules.map(\.id)) else {
            throw EditError.notAPermutation(expected: rules.count)
        }
        let byId = Dictionary(uniqueKeysWithValues: rules.map { ($0.id, $0) })
        return ids.compactMap { byId[$0] }
    }

    /// 编辑器里「会命中哪些已配置的模型」预览:最常见的错是模式一个都没匹配上,而那是静默的。
    static func matchedModelIds(_ rule: ThinkingRule, among modelIds: [String], limit: Int = 6) -> [String] {
        var seen = Set<String>()
        return modelIds.filter { rule.matches($0) && seen.insert($0.lowercased()).inserted }.prefix(limit).map { $0 }
    }
}
