import Foundation

// 「关思考」在 Anthropic 线格式上的几种写法,以及怎么选、怎么记。
//
// 为什么要有:同样是「关」,不同模型要的 `thinking` 写法不一样。2026-10-14 用真实 API 逐模型实测(max_tokens=16):
//   haiku-4-5/5-5、opus-4-5…5、sonnet-4-6/5 → {"type":"disabled"} 可用;
//   sonnet-5-5 → disabled 被拒("send between_tools instead of disabled"),between_tools 可用;
//   opus-5-5、fable-5、fable-5-1 → disabled 与 between_tools 都被拒("Use thinking.type.adaptive and
//     output_config.effort"),没有真正的「关」:不传 thinking 字段能过,但自适应模型默认会思考,不算关,
//     所以「关」只能落到 adaptive + 最低档 effort。
// 现象:自动标题对 sonnet-5-5 7/7 失败(退回首条消息当标题);用户把思考调到「关」,对话本身也被拒。
//
// 做法:
//   1. 静态种子表只收「已实测被拒」的模型,按归一化后的模型 id 精确匹配(兼容中转站前缀、日期后缀)。
//   2. 种子之外的新模型不靠硬编码:按服务端报错里的建议学习,按 (provider 实例 + 模型) 记住,
//      用学到的写法**只重试一次**。
//
// 本文件只依赖 Foundation:App 和 MinisTests 都编译它,所以这些逻辑不用网络就能测。

enum ThinkingOffStyle: String, Sendable {
    /// `{"type":"disabled"}`。默认,绝大多数模型。
    case disabled
    /// `{"type":"between_tools"}`。
    case betweenTools
    /// `{"type":"adaptive"}` + `output_config.effort` = 最低档。不是真正的关,是这类模型能做到的最低。
    case adaptiveLow
}

/// 这次请求「关思考」该用哪种写法。纯函数:学到的(`learned`)优先,其次种子表,最后 disabled。
func resolveThinkingOffStyle(modelId: String, learned: ThinkingOffStyle?) -> ThinkingOffStyle {
    learned ?? ThinkingOffStyle.seed(forModelId: modelId) ?? .disabled
}

extension ThinkingOffStyle {

    /// 种子表:只收 2026-10-14 实测被拒的模型。key 是 `canonicalClaudeId` 的结果。
    /// 别按「看起来像」去扩:`claude-sonnet-5` / `claude-opus-5` 实测 disabled 就是可用的,
    /// 新的坏模型由报错学习覆盖,不在这里补。
    private static let seeds: [String: ThinkingOffStyle] = [
        "claude-sonnet-5-5": .betweenTools,
        "claude-opus-5-5": .adaptiveLow,
        "claude-fable-5": .adaptiveLow,
        "claude-fable-5-1": .adaptiveLow,
    ]

    static func seed(forModelId modelId: String) -> ThinkingOffStyle? {
        canonicalClaudeId(modelId).flatMap { seeds[$0] }
    }

    /// 把各种拼写归一成 `claude-<系列>-<主版本>[-<次版本>]`,认不出来返回 nil。
    ///
    /// 兼容:大小写;中转站前缀(`vendor/…`、`openrouter/anthropic/…`,只看最后一段);
    /// Bedrock/Vertex 风格(`anthropic.claude-…-v1:0`、`…@20261001`);`5.5` 写法;日期后缀。
    /// 次版本只认 1~2 位数字:`claude-opus-5-20261001` 的 20261001 是日期,不是次版本 ——
    /// 否则 opus-5 会被误当成别的版本,而 fable-5 与 fable-5-1 也会混在一起。
    static func canonicalClaudeId(_ modelId: String) -> String? {
        let last = modelId.lowercased().split(separator: "/").last.map(String.init) ?? ""
        let tokens = last.split(whereSeparator: { !$0.isLetter && !$0.isNumber }).map(String.init)
        guard let at = tokens.firstIndex(of: "claude"), tokens.indices.contains(at + 2) else { return nil }
        let family = tokens[at + 1]
        let majorText = tokens[at + 2]
        // `claude-3-5-sonnet` 这种旧写法:系列位置是数字,不是我们要认的格式。
        guard family.allSatisfy(\.isLetter), majorText.count <= 2, let major = Int(majorText) else { return nil }
        var id = "claude-\(family)-\(major)"
        if tokens.indices.contains(at + 3), tokens[at + 3].count <= 2, let minor = Int(tokens[at + 3]), minor > 0 {
            id += "-\(minor)"
        }
        return id
    }

    /// `adaptiveLow` 里 output_config.effort 的默认值:Claude 档位 low < medium < high < xhigh < max 里最低的一档,
    /// opus-5-5 / fable-5-1 实测接受。调用方有模型声明的档位时用 `ThinkingRuleResolver.clampEffort` 取该模型的最低档。
    static let adaptiveLowEffort = "low"

    /// 把这种「关」写进请求体 JSON。返回 true 表示用到了 `output_config.effort`,
    /// 调用方要像「开」一样补 effort 的 beta 头。
    ///
    /// adaptiveLow 刻意不带 `display`:这是「关」,不向服务端要思考摘要(「开」的路径才带 `summarized`);
    /// 否则摘要文本会被当成推理内容存进历史,和用户选的「关」相悖。
    @discardableResult
    func apply(to json: inout [String: Any], effort: String? = nil) -> Bool {
        switch self {
        case .disabled:
            json["thinking"] = ["type": "disabled"]
            return false
        case .betweenTools:
            json["thinking"] = ["type": "between_tools"]
            return false
        case .adaptiveLow:
            json["thinking"] = ["type": "adaptive"]
            var outputConfig = (json["output_config"] as? [String: Any]) ?? [:]
            outputConfig["effort"] = effort ?? Self.adaptiveLowEffort
            json["output_config"] = outputConfig
            return true
        }
    }
}

// MARK: - 服务端的拒绝与建议

/// 服务端拒绝了「关思考」写法时,报错文本里建议的写法。两段真实原文(2026-10-14):
///   sonnet-5-5:  To turn thinking off on this model, send "thinking": {"type": "between_tools"} instead of {"type": "disabled"}…
///   opus-5-5 等: "thinking.type.disabled" is not supported for this model. Use "thinking.type.adaptive" and "output_config.effort" to control thinking behavior.
enum ThinkingOffRejection {

    /// - Parameters:
    ///   - status: HTTP 状态码,拿不到传 nil。
    ///   - text: 响应体或报错描述(JSON、纯文本都行)。
    ///   - sent: 这次已经发出去的写法 —— 服务端建议的和它一样就没有重试的意义,不算建议。
    /// 只认 400,且文本里有明确的建议。5xx、限流、别的 400 一律 nil。
    /// 不强制 error.type == invalid_request_error:中转站常改写 type,可靠的是 400 + 这两段特征文本。
    static func suggestedStyle(status: Int?, text: String, excluding sent: ThinkingOffStyle? = nil) -> ThinkingOffStyle? {
        guard status == 400 || (status == nil && text.contains("invalid_request_error")) else { return nil }
        let lower = text.lowercased()
        let candidates: [(ThinkingOffStyle, Bool)] = [
            (.betweenTools, lower.contains("between_tools")),
            (.adaptiveLow, lower.contains("thinking.type.adaptive") && lower.contains("output_config.effort")),
        ]
        return candidates.first { $0.0 != sent && $0.1 }?.0
    }
}

// MARK: - 按 (provider 实例 + 模型) 记住学到的写法

/// 学到的写法,存 UserDefaults(带版本号的 key,不进钥匙串 —— 里面没有任何密钥)。
/// scope 是 provider 实例 id(拿不到时调用方退回接入点地址),同一个模型在不同中转站上可能表现不同,所以要分开记。
enum ThinkingOffStyleMemory {
    static let defaultsKey = "leo.thinkingOffStyle.v1"
    private static let lock = NSLock()

    static func learned(scope: String, modelId: String, defaults: UserDefaults = .standard) -> ThinkingOffStyle? {
        let all = defaults.dictionary(forKey: defaultsKey) as? [String: String]
        return all?[entryKey(scope: scope, modelId: modelId)].flatMap(ThinkingOffStyle.init(rawValue:))
    }

    static func remember(_ style: ThinkingOffStyle, scope: String, modelId: String, defaults: UserDefaults = .standard) {
        // 读-改-写要成一个整体:标题生成和主对话可能同时学到。
        lock.lock()
        defer { lock.unlock() }
        var all = defaults.dictionary(forKey: defaultsKey) as? [String: String] ?? [:]
        all[entryKey(scope: scope, modelId: modelId)] = style.rawValue
        defaults.set(all, forKey: defaultsKey)
    }

    private static func entryKey(scope: String, modelId: String) -> String {
        scope + "|" + modelId.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }
}

// MARK: - 被拒 → 换写法 → 只重试一次

enum ThinkingOffRetry {

    /// 先用 `style` 试一次。失败时问 `learn`(带上这次发出的写法):给出了另一种写法就换它**再试一次**,
    /// 第二次无论成败都原样返回 / 抛出 —— 不循环,所以服务端再给建议也不会无限重试。
    /// 返回值带上最终成功用的写法,方便调用方在写法变了时记住它。
    static func run<T>(
        style: ThinkingOffStyle,
        attempt: (ThinkingOffStyle) async throws -> T,
        learn: (Error, ThinkingOffStyle) async -> ThinkingOffStyle?
    ) async throws -> (value: T, style: ThinkingOffStyle) {
        do {
            return (try await attempt(style), style)
        } catch {
            guard let next = await learn(error, style), next != style else { throw error }
            try Task.checkCancellation()
            return (try await attempt(next), next)
        }
    }
}
