import CryptoKit
import Foundation

/// Responses API 的 `prompt_cache_key`:同一会话每轮相同、不同会话互不相同,服务端据此命中前缀缓存。
///
/// Codex CLI 用 conversation_id。有会话 id 时用它;以前只按第一条用户消息的哈希,开头都是「继续」「hi」
/// 的不同会话会共用一个键互相挤占,压缩后第一条用户消息变了键也跟着变,整段缓存失效。
/// 没有会话 id(标题生成等子任务)时退回第一条用户文本,再没有就随机 —— 那一轮不命中缓存无妨。
enum PromptCacheKey {
    static func derive(sessionId: String?, firstUserText: String?) -> String {
        if let sessionId, !sessionId.isEmpty {
            return "minis-" + digest("session:" + sessionId)
        }
        if let firstUserText, !firstUserText.isEmpty {
            return "minis-" + digest(firstUserText)
        }
        return "minis-\(UUID().uuidString.lowercased())"
    }

    private static func digest(_ text: String) -> String {
        SHA256.hash(data: Data(text.utf8)).map { String(format: "%02x", $0) }.joined().prefix(32).description
    }
}
