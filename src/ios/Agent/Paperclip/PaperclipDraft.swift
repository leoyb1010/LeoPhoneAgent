import Foundation

/// 先落本机草稿再提交；超时、取消、进程重启后沿用原请求编号，避免重复创建或回复。
struct PaperclipDraft: Codable {
    var requestID = UUID()
    var title = ""
    var body = ""
    var agentID = ""
    var submitted = false

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
