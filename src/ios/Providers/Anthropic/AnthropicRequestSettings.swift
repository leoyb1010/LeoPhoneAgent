//
//  AnthropicRequestSettings.swift
//  MinisApp
//
//  Anthropic 请求里 SDK 不支持的字段(工具结果图片、思考档位、兼容代理的推理回放),
//  由 URLProtocol 里的 RequestBodyPatcher 补进请求体。
//
//  以前这些放在进程级「一次性」全局槽里:第一次网络尝试就被取走,-1005/-1009 自动重试时请求里就没了
//  (「思考关」在自适应模型上变成服务器默认的「开」、工具图片丢失);两个会话同时请求、
//  或缓存预热请求还会互相拿走对方的设置。
//  现在每个请求单独登记一份,用一个唯一的 stop sequence 标记带进请求体;
//  改写请求体时认出标记、取出这份设置并把标记去掉。同一请求的重试复用同一份。
//

import Foundation

struct AnthropicRequestSettings {
    var toolResultImages: [String: (data: Data, mimeType: String)] = [:]
    /// 旧版模型(<= 4.5)的 budget_tokens;0 = 不开。
    var thinkingBudget = 0
    /// 自适应模型(4.6+)的 output_config.effort。
    var thinkingEffort: String?
    /// 自适应模型默认会思考,「关」要明确发出去。
    var thinkingDisabled = false
    /// 兼容代理的推理回放:每个助手回合一项。
    var reasoningHistory: [String?]?
    var reasoningInjectPlaceholder = false
}

enum AnthropicRequestSettingsRegistry {
    /// 标记前缀:控制字符开头,不会出现在正常的停止序列里。
    static let markerPrefix = "\u{1E}leo-req:"
    /// 正常路径会 release;异常路径留下的旧登记过了这么久丢掉。
    static let lifetime: TimeInterval = 600

    private static let lock = NSLock()
    nonisolated(unsafe) private static var entries: [String: (settings: AnthropicRequestSettings, at: Date)] = [:]

    /// 登记一次请求的设置,返回要放进 `stopSequences` 的标记。
    static func register(_ settings: AnthropicRequestSettings, now: Date = Date()) -> String {
        let marker = markerPrefix + UUID().uuidString
        lock.lock()
        entries = entries.filter { now.timeIntervalSince($0.value.at) < lifetime }
        entries[marker] = (settings, now)
        lock.unlock()
        return marker
    }

    /// 这次请求(含重试)结束后释放。
    static func release(_ marker: String) {
        lock.lock()
        entries.removeValue(forKey: marker)
        lock.unlock()
    }

    /// 从请求体的 stop_sequences 里认出并去掉标记,返回登记的设置与改写后的请求体。
    /// 没有标记返回 nil。只读不删:同一请求的网络重试会再次经过这里。
    static func extract(fromBody body: Data) -> (AnthropicRequestSettings, Data)? {
        guard var json = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any],
              let stops = json["stop_sequences"] as? [String],
              let marker = stops.first(where: { $0.hasPrefix(markerPrefix) }) else { return nil }
        let rest = stops.filter { !$0.hasPrefix(markerPrefix) }
        if rest.isEmpty { json.removeValue(forKey: "stop_sequences") } else { json["stop_sequences"] = rest }
        guard let newBody = try? JSONSerialization.data(withJSONObject: json, options: [.sortedKeys]) else { return nil }
        lock.lock()
        defer { lock.unlock() }
        return (entries[marker]?.settings ?? AnthropicRequestSettings(), newBody)
    }
}
