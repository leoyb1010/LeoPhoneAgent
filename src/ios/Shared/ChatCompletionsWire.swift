import Foundation

/// [WP-45] OpenAI Chat Completions 的最小线格式(纯 Foundation,App 与逻辑测试共用)。
/// `ChatCompletionsLanguageModel`(Foundation Models 27 的 `LanguageModel` 适配器)用它把
/// 系统的 `LanguageModelSession` 接到任意 OpenAI 兼容端点 —— 典型用法是 Leo Link 那台 Mac 的
/// 订阅代理:iPhone 的「本机脑」在本机模型不可用时也能用 Mac 上的订阅模型。
/// `apple/foundation-models-utilities` 的同名类型没有引入(SPM 远端依赖),这里是最小自写版:
/// 只做文本,不做工具调用、不做结构化输出(那两种请求会按「不支持」失败,调用方原本就会回落)。
enum ChatCompletionsWire {
    struct Message: Equatable {
        let role: String   // system | user | assistant
        let content: String
    }

    struct Reply: Equatable {
        let text: String
        let promptTokens: Int
        let completionTokens: Int
    }

    enum WireError: Error, Equatable {
        case http(Int, String)
        case malformed
    }

    /// 端点:API 根(已含 `/v1` 等版本段,与 ProviderInstance.resolvedBaseURL 的约定一致)后补
    /// `/chat/completions`;已经是完整端点时原样用。
    static func endpoint(base: URL) -> URL {
        let s = base.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        if s.hasSuffix("/chat/completions") { return URL(string: s)! }
        return URL(string: s + "/chat/completions")!
    }

    static func request(base: URL, apiKey: String, model: String, messages: [Message],
                        maxTokens: Int? = nil, temperature: Double? = nil) -> URLRequest {
        var body: [String: Any] = [
            "model": model,
            "stream": false,
            "messages": merged(messages).map { ["role": $0.role, "content": $0.content] },
        ]
        if let maxTokens { body["max_tokens"] = maxTokens }
        if let temperature { body["temperature"] = temperature }
        var req = URLRequest(url: endpoint(base: base))
        req.httpMethod = "POST"
        req.timeoutInterval = 60
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if !apiKey.isEmpty { req.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization") }
        req.httpBody = try? JSONSerialization.data(withJSONObject: body)
        return req
    }

    /// 相邻同角色的消息合并成一条(Transcript 里一轮可能拆成多段;有的网关拒绝连续两条 user)。
    static func merged(_ messages: [Message]) -> [Message] {
        var out: [Message] = []
        for m in messages where !m.content.isEmpty {
            if let last = out.last, last.role == m.role {
                out[out.count - 1] = Message(role: m.role, content: last.content + "\n\n" + m.content)
            } else {
                out.append(m)
            }
        }
        return out
    }

    static func parse(status: Int, data: Data) throws -> Reply {
        guard (200..<300).contains(status) else {
            throw WireError.http(status, String(decoding: data.prefix(300), as: UTF8.self))
        }
        guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let choices = obj["choices"] as? [[String: Any]],
              let message = choices.first?["message"] as? [String: Any] else { throw WireError.malformed }
        let text: String
        if let s = message["content"] as? String {
            text = s
        } else if let parts = message["content"] as? [[String: Any]] {
            text = parts.compactMap { $0["text"] as? String }.joined()
        } else {
            text = ""
        }
        let usage = obj["usage"] as? [String: Any]
        return Reply(text: text,
                     promptTokens: usage?["prompt_tokens"] as? Int ?? 0,
                     completionTokens: usage?["completion_tokens"] as? Int ?? max(1, text.count / 3))
    }
}

/// [WP-45] 「本机模型不可用时,用这个已配置的模型代替」—— 用户在「本机模型」设置页里显式选择。
/// 存的是 ModelEntry 的 id;nil = 只用 Apple 本机模型(默认,内容不离本机)。
enum ExternalBrainPreference {
    static let entryKey = "leo.localBrain.externalEntryId"

    static var entryId: String? {
        get {
            let v = UserDefaults.standard.string(forKey: entryKey)
            return (v?.isEmpty ?? true) ? nil : v
        }
        set { UserDefaults.standard.set(newValue ?? "", forKey: entryKey) }
    }
}
