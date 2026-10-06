import Foundation

/// [G3] 对话 → Paperclip 工单的最小桥:只接收字符串。
///
/// 标题 = 这一轮的用户提示,描述 = Agent 回复摘要。调用方(对话的「下一步」菜单)把两段文本
/// 交到这里;这里切到 Paperclip 工作区,由创建表单预填后等你确认(可选执行者)再创建。
/// 边界:只依赖 Foundation 与 Paperclip 自己的类型,不引用本机对话、网关或模型,
/// 由 scripts/IOSPaperclipContractAudit.py 强制。
@MainActor
enum PaperclipHandoff {
    struct Request: Equatable, Sendable {
        let title: String
        let description: String
    }

    nonisolated static let titleLimit = 120
    nonisolated static let descriptionLimit = 4_000
    /// 创建表单已挂在界面上时立即取走;没挂上(未登录、未选公司)就等它出现时再取。
    nonisolated static let requested = Notification.Name("leo.paperclip.handoffRequested")

    private static var pending: Request?

    /// 纯函数:整理成表单能直接用的标题与描述。标题取提示第一行,两者都去首尾空白并截断。
    nonisolated static func make(title: String, description: String) -> Request? {
        let line = title.split(whereSeparator: \.isNewline)
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .first { !$0.isEmpty } ?? ""
        let body = description.trimmingCharacters(in: .whitespacesAndNewlines)
        let fullAsk = title.trimmingCharacters(in: .whitespacesAndNewlines)
        // 提示不止一行时,完整提示放进描述开头,标题只留第一行。
        var details = fullAsk.contains(where: \.isNewline) ? "要求:\n" + fullAsk : ""
        if !body.isEmpty { details += (details.isEmpty ? "" : "\n\n") + "对话里的结果(摘要):\n" + body }
        let finalTitle = String((line.isEmpty ? String(body.prefix(40)) : line).prefix(titleLimit))
        guard !finalTitle.isEmpty else { return nil }
        return Request(title: finalTitle, description: String(details.prefix(descriptionLimit)))
    }

    /// 打开 Paperclip 创建表单并预填。返回 false = 两段文本都是空的,没有可升级的内容。
    @discardableResult
    static func open(title: String, description: String, defaults: UserDefaults = .standard) -> Bool {
        guard let request = make(title: title, description: description) else { return false }
        pending = request
        defaults.set(IOSExecutionBackend.paperclip.rawValue, forKey: IOSExecutionBackend.storageKey)
        NotificationCenter.default.post(name: requested, object: nil)
        return true
    }

    /// 创建表单取走预填内容,取走即清空:只预填一次。
    static func take() -> Request? {
        defer { pending = nil }
        return pending
    }
}
