import Foundation

/// 未知结果沿用原请求编号；官方创建去重保留 7 天，客户端保守允许 6 天内重试。
struct PaperclipDraft: Codable {
    var requestID = UUID()
    var title = ""
    var body = ""
    var agentID = ""
    var submitted = false
    var firstSubmittedAt: Date?

    init() {}
    private enum CodingKeys: String, CodingKey {
        case requestID, title, body, agentID, submitted, firstSubmittedAt
        case submittedAt // 仅兼容旧草稿读取，不是第二份时间状态，也不重新编码。
    }
    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        requestID = try values.decode(UUID.self, forKey: .requestID)
        title = try values.decode(String.self, forKey: .title)
        body = try values.decode(String.self, forKey: .body)
        agentID = try values.decode(String.self, forKey: .agentID)
        submitted = try values.decode(Bool.self, forKey: .submitted)
        let canonical = try values.decodeIfPresent(Date.self, forKey: .firstSubmittedAt)
        let legacy = try values.decodeIfPresent(Date.self, forKey: .submittedAt)
        // 若旧/新键同时存在，取更早时间，不能因迁移扩大安全重试窗口。
        firstSubmittedAt = [canonical, legacy].compactMap { $0 }.min()
    }
    func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        try values.encode(requestID, forKey: .requestID)
        try values.encode(title, forKey: .title)
        try values.encode(body, forKey: .body)
        try values.encode(agentID, forKey: .agentID)
        try values.encode(submitted, forKey: .submitted)
        try values.encodeIfPresent(firstSubmittedAt, forKey: .firstSubmittedAt)
    }
    /// 小于服务端创建幂等键保留期（7 天），过期前停止复用同一请求编号。
    static let createRetryWindow: TimeInterval = 6 * 24 * 60 * 60
    mutating func markSubmitted(now: Date = Date()) {
        if !submitted { firstSubmittedAt = now }
        submitted = true
    }
    func canRetryCreate(now: Date = Date()) -> Bool {
        guard submitted else { return true }
        guard let firstSubmittedAt else { return false }
        let age = now.timeIntervalSince(firstSubmittedAt)
        // 服务端 ISSUE_CREATE_IDEMPOTENCY_KEY_RETENTION_DAYS = 7；客户端取 6 天，留出时钟偏差与排队余量。
        return age >= 0 && age < Self.createRetryWindow
    }
    mutating func recordFailure(_ error: Error, wasPreviouslySubmitted: Bool) {
        // 重试被拒绝不能证明原提交未生效；仅首次明确拒绝恢复编辑，保留未知提交和首次时间。
        guard !wasPreviouslySubmitted, let error = error as? PaperclipError else { return }
        switch error {
        // .preflightFailed：预检读取失败（离线、5xx、超时）时写请求根本没发出，必须解锁；
        // 写请求发出后的超时/断网/5xx 一律是 .uncertain，不在此集合，保持锁定。
        case .invalidAddress, .signedOut, .forbidden, .identityChanged, .http(400), .http(422), .preflightFailed:
            submitted = false
            firstSubmittedAt = nil
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
    /// 人工核对后的诊断记录不发送到服务器；解除待提交状态不会撤销远端操作。
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
