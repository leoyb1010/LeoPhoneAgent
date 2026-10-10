//
//  LocalIntelligencePolicies.swift
//  MinisApp
//
//  端侧模型(LocalBrain)做会话标题/分类与追问建议时的纯逻辑:输入裁剪、输出校验、
//  何时该生成。不碰 FoundationModels,逻辑测试直接跑。
//

import Foundation

/// 端侧模型的上下文窗口是 4,096 token,指令和输出也算在里面。中文最坏约 1 token/字,
/// 所以输入按字符硬上限裁剪:标题只喂首轮提问 + 回复开头,追问只喂最后一问 + 回复开头。
enum OnDeviceTextBudget {
    static let contextTokens = 4_096
    static let titleUserChars = 600
    static let titleReplyChars = 400
    static let followUpUserChars = 500
    static let followUpReplyChars = 1_200

    /// 去掉附件元数据块,折叠所有空白,截到 `limit` 个字符。
    static func clip(_ raw: String, limit: Int) -> String {
        var t = raw
        if let start = t.range(of: "<user-attached-files>") {
            let end = t.range(of: "</user-attached-files>", range: start.upperBound..<t.endIndex)
            t = String(t[t.startIndex..<start.lowerBound]) + String(t[(end?.upperBound ?? t.endIndex)...])
        }
        t = t.replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard limit > 0 else { return "" }
        return t.count > limit ? String(t.prefix(limit)) : t
    }

    /// 标题输入:首轮提问 + 回复开头。两段都裁剪后总长不超过 600 + 400 字。
    static func titleInput(firstUser: String, replyStart: String) -> (user: String, reply: String) {
        (clip(firstUser, limit: titleUserChars), clip(replyStart, limit: titleReplyChars))
    }
}

/// 会话类别的固定集合(与云端标题提示里列出的一致)。
enum SessionTitleCategory {
    static let allowed: [String] = [
        "code", "writing", "research", "analysis", "creative", "chat", "math", "translation",
        "health", "finance", "travel", "education", "design", "productivity", "support", "other",
    ]

    /// 合法类别返回小写值;不在集合里的一律 nil(不写进数据库)。
    static func normalize(_ raw: String?) -> String? {
        guard let value = raw?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(),
              !value.isEmpty, allowed.contains(value) else { return nil }
        return value
    }
}

/// 端侧模型给出的标题是否可用。不合格就返回 nil,调用方回落到原来的云端生成。
enum OnDeviceTitleValidator {
    static let maxLength = 40

    private static let refusalMarkers = [
        "抱歉", "对不起", "我无法", "我不能", "作为一个", "作为ai", "sorry", "i'm sorry", "i am sorry",
        "i cannot", "i can't", "as an ai", "unable to",
    ]
    private static let labelPrefixes = ["标题：", "标题:", "title:", "title："]
    private static let wrappers = CharacterSet(charactersIn: "\"'“”‘’「」『』《》*#`[]【】 \t")

    static func validate(_ raw: String) -> String? {
        // 只取第一条非空行。
        guard let firstLine = raw.split(whereSeparator: \.isNewline)
            .map({ String($0).trimmingCharacters(in: .whitespaces) })
            .first(where: { !$0.isEmpty }) else { return nil }
        var t = firstLine.unicodeScalars.filter { !CharacterSet.controlCharacters.contains($0) }
            .reduce(into: "") { $0.unicodeScalars.append($1) }
        for prefix in labelPrefixes where t.lowercased().hasPrefix(prefix) {
            t = String(t.dropFirst(prefix.count))
        }
        // 引号和句末标点可能交替出现(“标题”。),反复剥到不再变化。
        var previous: String
        repeat {
            previous = t
            t = t.trimmingCharacters(in: wrappers)
            while let last = t.last, "。.!！?？:：;；,，".contains(last) { t.removeLast() }
        } while t != previous
        t = t.replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
        guard !t.isEmpty, t.count <= maxLength else { return nil }
        if t.contains("{") || t.contains("}") || t.contains("```") { return nil }
        let lower = t.lowercased()
        if refusalMarkers.contains(where: { lower.contains($0) }) { return nil }
        guard t.unicodeScalars.contains(where: { CharacterSet.alphanumerics.contains($0) }) else { return nil }
        return t
    }
}

/// 回复结束后的追问建议:何时生成、输出怎么清洗。
enum FollowUpSuggestionPolicy {
    static let enabledKey = "leo.followUpSuggestions.enabled"
    static let maxCount = 3
    static let maxLength = 40

    static func isEnabled(_ defaults: UserDefaults = .standard) -> Bool {
        defaults.object(forKey: enabledKey) as? Bool ?? true
    }

    /// 只在用户自己在界面里聊的会话、本机模型可用、回复正常结束时生成。
    /// 安静任务、自动化、子代理、编排、捷径/Siri/手表/命令行发起的会话 `sessionSource` 都不为空。
    static func shouldGenerate(enabled: Bool, onDeviceReady: Bool, sessionSource: String?,
                               isSubAgent: Bool, isProgrammaticSend: Bool, userCancelled: Bool,
                               replyText: String, replyHasError: Bool) -> Bool {
        guard enabled, onDeviceReady, !isSubAgent, !isProgrammaticSend, !userCancelled, !replyHasError else { return false }
        guard (sessionSource ?? "").isEmpty else { return false }
        return replyText.trimmingCharacters(in: .whitespacesAndNewlines).count >= 2
    }

    /// 单行、去掉列表符号和引号、去重、不与用户上一问相同,最多 3 条,每条不超过 40 字。
    static func sanitize(_ raw: [String], lastUserPrompt: String) -> [String] {
        let listMarker = "^\\s*(?:[-*•·]|\\d{1,2}[.、)）]|[（(]\\d{1,2}[)）])\\s*"
        let quotes = CharacterSet(charactersIn: "\"'“”‘’「」『』《》*`")
        let previous = normalizedKey(lastUserPrompt)
        var seen = Set<String>()
        var result: [String] = []
        for item in raw {
            guard let line = item.split(whereSeparator: \.isNewline).first.map(String.init) else { continue }
            var t = line.replacingOccurrences(of: listMarker, with: "", options: .regularExpression)
            t = t.unicodeScalars.filter { !CharacterSet.controlCharacters.contains($0) }
                .reduce(into: "") { $0.unicodeScalars.append($1) }
            t = t.trimmingCharacters(in: quotes.union(.whitespaces))
                .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
            guard t.count >= 2, t.count <= maxLength else { continue }
            let key = normalizedKey(t)
            guard !key.isEmpty, key != previous, seen.insert(key).inserted else { continue }
            result.append(t)
            if result.count == maxCount { break }
        }
        return result
    }

    private static func normalizedKey(_ s: String) -> String {
        s.lowercased().filter { $0.isLetter || $0.isNumber }
    }
}
