import Foundation

/// 先落本机草稿再提交；超时、取消、进程重启后沿用原请求编号，避免重复创建或回复。
struct PaperclipDraft: Codable {
    var requestID = UUID()
    var title = ""
    var body = ""
    var agentID = ""
    var submitted = false
    var firstSubmittedAt: Date?

    /// 固定上游创建幂等键保留7天；客户端保守使用6天，避免过期重试生成新任务。
    func canRetryCreate(now: Date = Date()) -> Bool {
        guard submitted else { return true }
        guard let firstSubmittedAt else { return false }
        let age = now.timeIntervalSince(firstSubmittedAt)
        return age >= 0 && age < 6 * 24 * 60 * 60
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
    /// 人工核对后解除待提交状态，保留上一份内容和请求编号供用户诊断；此方法不发送请求。
    func archive(key: String, defaults: UserDefaults = .standard) {
        save(key: key + ".lastCheckedDraft", defaults: defaults)
        Self.clear(key: key, defaults: defaults)
    }
    static func lastChecked(key: String, defaults: UserDefaults = .standard) -> PaperclipDraft? {
        guard let data = defaults.data(forKey: key + ".lastCheckedDraft") else { return nil }
        return try? JSONDecoder().decode(Self.self, from: data)
    }
    static func clear(key: String, defaults: UserDefaults = .standard) { defaults.removeObject(forKey: key) }
}
