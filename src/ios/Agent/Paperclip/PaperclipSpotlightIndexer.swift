import CoreSpotlight
import Foundation
import UniformTypeIdentifiers

/// [G8] Paperclip 工单进系统搜索。参照 SessionSpotlightIndexer：索引只在设备本地，
/// 只放工单标题与编号（不放描述、评论或运行内容）；条目编号就是 G7 深链，点击走同一入口。
/// 每个服务器配置一个域，退出登录或删除配置时整域清空。跟随「在 Spotlight 中显示对话」开关。
enum PaperclipSpotlightIndexer {
    static let enabledDefaultsKey = "leo.spotlightSessionsEnabled"
    static let identifierPrefix = "leophoneagent://paperclip/"

    static func domain(profileID: UUID) -> String {
        "com.leoyuan.leophoneagent.paperclip." + profileID.uuidString
    }

    static var isEnabled: Bool {
        (UserDefaults.standard.object(forKey: enabledDefaultsKey) as? Bool) ?? true
    }

    /// 只含标题与编号；无法生成深链的工单不索引。
    static func item(for issue: PaperclipIssue, profileID: UUID) -> CSSearchableItem? {
        guard let link = PaperclipDeepLink.url(issueID: issue.id, companyID: issue.companyId) else { return nil }
        let identifier = issue.identifier?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let attributes = CSSearchableItemAttributeSet(contentType: .content)
        attributes.title = identifier.isEmpty ? issue.title : "\(identifier) \(issue.title)"
        attributes.keywords = identifier.isEmpty ? ["Paperclip"] : [identifier, "Paperclip"]
        return CSSearchableItem(uniqueIdentifier: link.absoluteString, domainIdentifier: domain(profileID: profileID),
                                attributeSet: attributes)
    }

    static func signature(_ issues: [PaperclipIssue]) -> Int {
        var hasher = Hasher()
        for issue in issues {
            hasher.combine(issue.id); hasher.combine(issue.title); hasher.combine(issue.identifier)
            hasher.combine(issue.status); hasher.combine(issue.companyId)   // 关单、切公司都要重建索引
        }
        return hasher.finalize()
    }

    /// 只索引还没结束的工单(已完成 / 已取消的不进系统搜索)。
    static func indexable(_ issues: [PaperclipIssue]) -> [PaperclipIssue] {
        issues.filter { $0.status != PaperclipIssueStatus.done.rawValue && $0.status != PaperclipIssueStatus.cancelled.rawValue }
    }

    /// 用当前列表整体替换该配置的索引:以前只追加,删除 / 关闭的工单和切换前公司的工单
    /// 一直留在系统搜索里,直到退出登录。调用方传的是当前公司已加载的完整列表。
    static func index(_ issues: [PaperclipIssue], profileID: UUID) {
        guard isEnabled else { clear(profileID: profileID); return }
        let items = indexable(issues).compactMap { item(for: $0, profileID: profileID) }
        let index = CSSearchableIndex.default()
        index.deleteSearchableItems(withDomainIdentifiers: [domain(profileID: profileID)]) { _ in
            guard !items.isEmpty else { return }
            index.indexSearchableItems(items) { _ in }
        }
    }

    static func clear(profileID: UUID) {
        CSSearchableIndex.default().deleteSearchableItems(withDomainIdentifiers: [domain(profileID: profileID)]) { _ in }
    }

    /// 所有服务器配置的工单(域按点号分层,删父域连同各配置子域一起删)。
    static let rootDomain = "com.leoyuan.leophoneagent.paperclip"
    static func clearAll() {
        CSSearchableIndex.default().deleteSearchableItems(withDomainIdentifiers: [rootDomain]) { _ in }
    }
}
