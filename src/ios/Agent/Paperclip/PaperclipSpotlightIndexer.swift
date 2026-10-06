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
        for issue in issues { hasher.combine(issue.id); hasher.combine(issue.title); hasher.combine(issue.identifier) }
        return hasher.finalize()
    }

    static func index(_ issues: [PaperclipIssue], profileID: UUID) {
        guard isEnabled else { clear(profileID: profileID); return }
        let items = issues.compactMap { item(for: $0, profileID: profileID) }
        guard !items.isEmpty else { return }
        CSSearchableIndex.default().indexSearchableItems(items) { _ in }
    }

    static func clear(profileID: UUID) {
        CSSearchableIndex.default().deleteSearchableItems(withDomainIdentifiers: [domain(profileID: profileID)]) { _ in }
    }
}
