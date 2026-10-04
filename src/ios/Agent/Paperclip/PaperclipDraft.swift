import Foundation

/// 先落本机草稿再提交；未知结果沿用原请求编号，创建重试受服务器 7 天去重窗口限制。
struct PaperclipDraft: Codable {
    var requestID = UUID()
    var title = ""
    var body = ""
    var agentID = ""
    var submitted = false
    var submittedAt: Date?

    mutating func markSubmitted(now: Date = Date()) {
        // 重试不能刷新计时，否则会把官方仅保留 7 天的去重键误当作永久有效。
        if !submitted { submittedAt = now }
        submitted = true
    }

    func canRetryCreation(now: Date = Date()) -> Bool {
        guard submitted else { return true }
        guard let submittedAt else { return false }
        let age = now.timeIntervalSince(submittedAt)
        return age >= 0 && age < 7 * 24 * 60 * 60
    }

    mutating func recordFailure(_ error: Error, wasPreviouslySubmitted: Bool) {
        // 本次重试被拒绝不能证明原提交未成功，也不能重置它的去重期限；仅首次明确拒绝恢复编辑。
        guard !wasPreviouslySubmitted, let error = error as? PaperclipError else { return }
        switch error {
        case .invalidAddress, .signedOut, .forbidden, .identityChanged, .http(400), .http(422):
            submitted = false
            submittedAt = nil
        default: break
        }
    }

    static func key(profile: PaperclipProfile, companyID: String, userID: String, issueID: String? = nil) -> String {
        "leo.paperclip.draft.v1.\(profile.id.uuidString).\(companyID).\(userID).\(issueID ?? "create")"
    }
    static func load(key: String, defaults: UserDefaults = .standard) -> PaperclipDraft {
        guard let data = defaults.data(forKey: key), let draft = try? JSONDecoder().decode(Self.self, from: data) else { return Self() }
        return draft
    }
    func save(key: String, defaults: UserDefaults = .standard) {
        if let data = try? JSONEncoder().encode(self) { defaults.set(data, forKey: key) }
    }
    static func clear(key: String, defaults: UserDefaults = .standard) { defaults.removeObject(forKey: key) }
}
