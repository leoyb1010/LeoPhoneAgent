import Foundation

/// [OpenMinis Android 1.15] OpenAI 兼容端点（中转站、vLLM、自建网关）在 `/v1/models` 里自己报的上下文长度
/// 和最大输出长度。以前只认 models.dev，查不到就按 128K 猜。各家字段名不同，按常见写法依次取。
enum OpenAIModelLimits {
    static func contextWindow(in item: [String: Any]) -> Int? {
        firstPositive(item, ["context_length", "context_window", "max_context_length", "max_model_len", "max_input_tokens"])
            ?? firstPositive(item["top_provider"] as? [String: Any] ?? [:], ["context_length"])
    }

    static func maxOutputTokens(in item: [String: Any]) -> Int? {
        firstPositive(item, ["max_output_tokens", "max_completion_tokens", "max_tokens"])
            ?? firstPositive(item["top_provider"] as? [String: Any] ?? [:], ["max_completion_tokens"])
    }

    /// 数字可能是 Int、Double 或字符串（有的网关把数字写成 "131072"）。
    private static func firstPositive(_ dict: [String: Any], _ keys: [String]) -> Int? {
        for key in keys {
            let value: Int?
            switch dict[key] {
            case let n as Int: value = n
            case let d as Double: value = d.isFinite ? Int(d) : nil
            case let s as String: value = Int(s.trimmingCharacters(in: .whitespaces))
            default: value = nil
            }
            if let value, value > 0 { return value }
        }
        return nil
    }
}
