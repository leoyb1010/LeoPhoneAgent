import CryptoKit
import Foundation

/// `prompt_cache_key`:同一会话每轮相同、不同会话互不相同,服务端据此命中前缀缓存。
///
/// Codex CLI 用 conversation_id。有会话 id 时用它;以前只按第一条用户消息的哈希,开头都是「继续」「hi」
/// 的不同会话会共用一个键互相挤占,压缩后第一条用户消息变了键也跟着变,整段缓存失效。
/// 没有会话 id(标题生成等子任务)时退回第一条用户文本;再没有就退回第一条消息的结构形状
/// (每轮原样重发,所以跨轮稳定)。[T-prompt-cache-no-random] 以前这里给随机 UUID,
/// 等于这类会话每一轮都必然不命中——正是这个键要避免的情况。
enum PromptCacheKey {
    static func derive(sessionId: String?, firstUserText: String?, firstMessageShape: String? = nil) -> String {
        if let sessionId, !sessionId.isEmpty {
            return "minis-" + digest("session:" + sessionId)
        }
        if let firstUserText, !firstUserText.isEmpty {
            return "minis-" + digest(firstUserText)
        }
        if let firstMessageShape, !firstMessageShape.isEmpty {
            return "minis-" + digest("shape:" + firstMessageShape)
        }
        // Nothing to key on at all (empty message list): a constant, so consecutive such
        // requests can at least share an entry instead of guaranteeing a miss.
        return "minis-" + digest("minis-empty-conversation")
    }

    /// [T-ios-prompt-cache-key-400] Whether this endpoint may receive `prompt_cache_key`.
    ///
    /// ALLOWLIST: the field is a pure cache hint, so omitting it costs a weaker hit rate,
    /// while sending it to a strict-schema gateway is a hard
    /// `400 UNKNOWN_FIELD: prompt_cache_key` that fails the whole request. Allowed:
    ///   • the official OpenAI base (no custom base, not Azure) — including Codex OAuth;
    ///   • `forceResponsesAPI` relays — an explicit "this base speaks the Responses API"
    ///     opt-in; sub2api and friends need the key (no server-side fallback).
    /// Applies to both Chat Completions and Responses.
    static func shouldSend(customBaseURL: String?, isAzure: Bool, forceResponsesAPI: Bool) -> Bool {
        if customBaseURL == nil && !isAzure { return true }
        return forceResponsesAPI
    }

    private static func digest(_ text: String) -> String {
        SHA256.hash(data: Data(text.utf8)).map { String(format: "%02x", $0) }.joined().prefix(32).description
    }
}
