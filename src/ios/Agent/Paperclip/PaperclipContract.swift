import Combine
import Foundation

/// Paperclip 994d6edcdd4e15d5f9cc5cf8c135ac599104b86a 的原生客户端契约。
/// 服务器任务独立于 ChatStore 和 Gateway，绝不通过本机代理执行或自动迁移。
enum IOSExecutionBackend: String, CaseIterable, Codable {
    case local
    case paperclip
    var title: String { self == .local ? "本机" : "Paperclip 服务器" }
    static let storageKey = "leo.ios.executionBackend.v1"
    /// 通知、Siri、快捷操作、深链等外部入口都要显示本机内容；统一走这一处写入，
    /// @AppStorage 观察同一键，会把隐藏的服务器任务页切回本机。
    static func selectLocal(_ defaults: UserDefaults = .standard) {
        defaults.set(IOSExecutionBackend.local.rawValue, forKey: storageKey)
    }
    /// [G7] 服务器任务深链（含其通知、灵动岛、Spotlight 入口）要落在 Paperclip 工作区。
    static func selectPaperclip(_ defaults: UserDefaults = .standard) {
        defaults.set(IOSExecutionBackend.paperclip.rawValue, forKey: storageKey)
    }
}

/// [G7] `leophoneagent://paperclip/issue/<id>[?company=<companyId>]`：切到 Paperclip 工作区并打开该工单。
/// 工单与公司编号只接受服务器编号字符集；不合法的链接返回 nil，不改变工作区。
enum PaperclipDeepLink {
    static let host = "paperclip"
    struct Target: Hashable, Sendable {
        let issueID: String
        let companyID: String?
        var id: String { "\(companyID ?? "")/\(issueID)" }
    }
    static func url(issueID: String, companyID: String?) -> URL? {
        guard let issue = try? PaperclipProfile.component(issueID) else { return nil }
        var parts = URLComponents()
        parts.scheme = "leophoneagent"
        parts.host = host
        parts.path = "/issue/" + issue
        if let company = companyID.flatMap({ try? PaperclipProfile.component($0) }) {
            parts.queryItems = [URLQueryItem(name: "company", value: company)]
        }
        return parts.url
    }
    static func parse(_ url: URL) -> Target? {
        guard url.scheme == "leophoneagent", url.host == host else { return nil }
        let segments = url.path.split(separator: "/").map(String.init)
        guard segments.count == 2, segments[0] == "issue",
              let issue = try? PaperclipProfile.component(segments[1]) else { return nil }
        let company = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?
            .first(where: { $0.name == "company" })?.value.flatMap { try? PaperclipProfile.component($0) }
        return Target(issueID: issue, companyID: company)
    }
}

/// [G7] 深链交给工作区的待打开工单；冷启动时工作区尚未挂载，先在这里缓冲，连上后再打开。
@MainActor
final class PaperclipNavigationInbox: ObservableObject {
    static let shared = PaperclipNavigationInbox()
    @Published var pending: PaperclipDeepLink.Target?
}

/// [G2/G5] 关注的工单：本机（App 或快捷指令）创建的会持久化（每个配置/公司/用户最多 50 个），
/// 正在查看的由工作区在本次运行内记住。键以 leo.paperclip. 开头并含配置编号，删除配置时一并清除。
enum PaperclipWatchList {
    static let limit = 50
    static func key(profileID: UUID, companyID: String, userID: String) -> String {
        "leo.paperclip.watched.v1.\(profileID.uuidString).\(companyID).\(userID)"
    }
    static func load(key: String, defaults: UserDefaults = .standard) -> [String] {
        defaults.stringArray(forKey: key) ?? []
    }
    static func add(_ issueID: String, key: String, defaults: UserDefaults = .standard) {
        var list = load(key: key, defaults: defaults).filter { $0 != issueID }
        list.append(issueID)
        defaults.set(Array(list.suffix(limit)), forKey: key)
    }
}

struct PaperclipProfile: Codable, Hashable, Identifiable, Sendable {
    let id: UUID
    let name: String
    let origin: URL

    init(id: UUID = UUID(), name: String, address: String) throws {
        guard let parts = URLComponents(string: address.trimmingCharacters(in: .whitespacesAndNewlines)),
              parts.scheme?.lowercased() == "https", let host = parts.host, !host.isEmpty,
              parts.user == nil, parts.password == nil, parts.query == nil, parts.fragment == nil,
              parts.path.isEmpty || parts.path == "/",
              parts.port == nil || (1...65535).contains(parts.port!) else {
            throw PaperclipError.invalidAddress
        }
        var canonical = parts
        canonical.scheme = "https"
        canonical.host = host.lowercased()
        canonical.path = ""
        if canonical.port == 443 { canonical.port = nil }
        guard let origin = canonical.url else { throw PaperclipError.invalidAddress }
        self.id = id
        self.name = name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "我的服务器" : name
        self.origin = origin
    }

    func validated() throws -> PaperclipProfile {
        try PaperclipProfile(id: id, name: name, address: origin.absoluteString)
    }

    func url(_ path: String) throws -> URL {
        let profile = try validated()
        guard path.hasPrefix("/api/"), !path.contains(".."), !path.contains("#"),
              let result = URL(string: profile.origin.absoluteString + path),
              Self.sameOrigin(result, profile.origin) else { throw PaperclipError.invalidAddress }
        return result
    }

    static func sameOrigin(_ a: URL, _ b: URL) -> Bool {
        a.scheme?.lowercased() == "https" && b.scheme?.lowercased() == "https" &&
        a.host?.lowercased() == b.host?.lowercased() && (a.port ?? 443) == (b.port ?? 443)
    }

    static func component(_ id: String) throws -> String {
        let allowed = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_")
        guard !id.isEmpty, id.unicodeScalars.allSatisfy(allowed.contains) else { throw PaperclipError.invalidResponse }
        return id
    }
}

struct PaperclipTaskReference: Codable, Hashable, Identifiable, Sendable {
    let profileID: UUID
    let origin: URL
    let companyID: String
    let userID: String
    let issueID: String
    var id: String { "\(profileID.uuidString)/\(companyID)/\(userID)/\(issueID)" }

    func validate(profile: PaperclipProfile, companyID: String, userID: String) throws {
        guard profileID == profile.id, origin == profile.origin,
              self.companyID == companyID, self.userID == userID else { throw PaperclipError.identityChanged }
    }
}

struct PaperclipHealth: Decodable, Sendable {
    let status: String
    let deploymentMode: String?
    let authReady: Bool?
    let commit: String?
}
struct PaperclipUser: Decodable, Equatable, Sendable {
    let id: String
    let name: String?
    let email: String?
    var label: String { name ?? email ?? "已登录用户" }
}
struct PaperclipSession: Decodable, Sendable {
    struct Session: Decodable, Sendable { let id: String; let userId: String }
    let session: Session
    let user: PaperclipUser

    static func decode(_ data: Data) throws -> PaperclipSession {
        // 只有空会话（null、{"data":null}、无 session/user）才算未登录；
        // HTTP 200 但结构变了是服务器版本不兼容，不能误报成"登录过期"。
        guard let root = try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed]) else {
            throw PaperclipError.invalidResponse
        }
        var body: Any = root
        if let object = root as? [String: Any], object["session"] == nil, object["user"] == nil, object.keys.contains("data") {
            body = object["data"] ?? NSNull()
        }
        if body is NSNull { throw PaperclipError.signedOut }
        guard let object = body as? [String: Any] else { throw PaperclipError.invalidResponse }
        func empty(_ value: Any?) -> Bool { value == nil || value is NSNull }
        if empty(object["session"]) && empty(object["user"]) { throw PaperclipError.signedOut }
        guard let normalized = try? JSONSerialization.data(withJSONObject: object),
              let value = try? JSONDecoder().decode(PaperclipSession.self, from: normalized) else {
            throw PaperclipError.invalidResponse
        }
        guard !value.user.id.isEmpty, !value.session.id.isEmpty,
              value.session.userId == value.user.id else { throw PaperclipError.signedOut }
        return value
    }
}
struct PaperclipCompany: Decodable, Identifiable, Hashable, Sendable {
    let id: String
    let name: String
}
struct PaperclipAgent: Decodable, Identifiable, Hashable, Sendable {
    let id: String
    let companyId: String
    let name: String
    let status: String
    /// 服务器预设头像（同源 /api/agent-avatars/...png）；旧版本没有此字段。
    let avatarUrl: String?
}
struct PaperclipIssue: Decodable, Identifiable, Sendable, Equatable {
    let id: String
    let companyId: String
    let identifier: String?
    let title: String
    let description: String?
    let status: String
    let priority: String
    let assigneeAgentId: String?
    let updatedAt: String?
    let unblockDescriptor: PaperclipUnblockDescriptor?
}
struct PaperclipUnblockDescriptor: Decodable, Equatable, Sendable {
    let owner: PaperclipJSON
    let action: String
}
struct PaperclipComment: Decodable, Identifiable, Sendable, Equatable {
    let id: String
    let companyId: String
    let issueId: String
    let body: String
    let authorUserId: String?
    let authorAgentId: String?
    let clientRequestId: String?
    let createdAt: String?
    func authorLabel(currentUserID: String) -> String {
        let user = (authorUserId ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let agent = (authorAgentId ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if !user.isEmpty && agent.isEmpty { return user == currentUserID ? "我" : "用户消息" }
        if user.isEmpty && !agent.isEmpty { return "智能体消息" }
        return "未知作者"
    }
}
struct PaperclipRun: Decodable, Identifiable, Sendable, Equatable {
    let runId: String
    let status: String
    let agentId: String
    let startedAt: String?
    let finishedAt: String?
    let createdAt: String?
    let errorCode: String?
    var id: String { runId }
    var isActive: Bool { status == "queued" || status == "running" }
}
/// [G4] 取消与核实运行时只读的字段（POST /cancel 回执与 GET /api/heartbeat-runs/:id）。
struct PaperclipRunReceipt: Decodable, Sendable {
    let id: String
    let companyId: String
    let status: String
}
/// [G4] 停止运行的结果：已停止，或发出前/核实时运行已经自行结束（附结束状态）。
enum PaperclipCancelOutcome: Equatable, Sendable {
    case cancelled
    case alreadyFinished(String)
    static let terminalStatuses: Set<String> = ["cancelled", "succeeded", "failed", "timed_out"]
}
struct PaperclipRunLogChunk: Decodable, Sendable {
    let runId: String
    let content: String
    let nextOffset: Int?
}
struct PaperclipApproval: Decodable, Identifiable, Sendable, Equatable {
    let id: String
    let companyId: String
    let type: String
    let status: String
    let payload: [String: PaperclipJSON]
    let requestedByAgentId: String?
    let requestedByUserId: String?
    let decisionNote: String?
    var payloadText: String {
        guard let data = try? JSONEncoder.paperclipPretty.encode(payload) else { return "无法显示审批内容" }
        return String(data: data, encoding: .utf8) ?? "无法显示审批内容"
    }
    var title: String {
        switch type {
        case "hire_agent": return "聘用代理"
        case "approve_ceo_strategy": return "批准负责人策略"
        default: return "服务器审批"
        }
    }
}
indirect enum PaperclipJSON: Codable, Sendable, Equatable {
    case string(String), number(Double), bool(Bool), object([String: PaperclipJSON]), array([PaperclipJSON]), null
    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let v = try? c.decode(Bool.self) { self = .bool(v) }
        else if let v = try? c.decode(String.self) { self = .string(v) }
        else if let v = try? c.decode(Double.self) { self = .number(v) }
        else if let v = try? c.decode([String: PaperclipJSON].self) { self = .object(v) }
        else { self = .array(try c.decode([PaperclipJSON].self)) }
    }
    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .string(let v): try c.encode(v)
        case .number(let v): try c.encode(v)
        case .bool(let v): try c.encode(v)
        case .object(let v): try c.encode(v)
        case .array(let v): try c.encode(v)
        case .null: try c.encodeNil()
        }
    }
}
extension JSONEncoder {
    static var paperclipPretty: JSONEncoder {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        return encoder
    }
}

enum PaperclipIssueStatus: String, Codable, CaseIterable, Identifiable {
    case backlog, todo, inProgress = "in_progress", inReview = "in_review", done, blocked, cancelled
    var id: String { rawValue }
    var title: String { PaperclipLabels.status(rawValue) }
}
enum PaperclipPollingPolicy {
    static let baseInterval: Double = 15
    static let maximumInterval: Double = 120
    /// 没有实时通道、且有运行中的任务时的轮询间隔。
    static let activeRunInterval: Double = 3
    /// 实时通道已连接时只做低频兜底（事件驱动刷新为主）。
    static let liveSafetyInterval: Double = 60
    /// 修复「发送后一直卡住」：只读刷新从不改写草稿、焦点或面板状态，
    /// 以前因输入框聚焦、面板打开而暂停，键盘不收起就永远看不到进展。
    /// 现在只在写请求（创建、回复、状态、审批）进行中暂停。
    static func canRefresh(active: Bool, mutating: Bool) -> Bool {
        active && !mutating
    }
    /// 详情页轮询节奏：实时通道已连接时 60 秒兜底；否则运行中 3 秒、空闲 15 秒。
    static func detailInterval(liveOpen: Bool, runActive: Bool) -> Double {
        if liveOpen { return liveSafetyInterval }
        return runActive ? activeRunInterval : baseInterval
    }
    /// 离线或服务器故障时每 15 秒重试会持续耗电；失败按 2 倍退避到 2 分钟，成功后复位。
    static func nextInterval(after current: Double, succeeded: Bool) -> Double {
        succeeded ? baseInterval : min(max(current, baseInterval) * 2, maximumInterval)
    }
    /// 轮询只重读第一页：一页以内整体替换；已加载多页时按 id 合并，保留后续页。
    static func merge(firstPage: [PaperclipIssue], into loaded: [PaperclipIssue]) -> [PaperclipIssue] {
        guard loaded.count > 100 else { return firstPage }
        let fresh = Set(firstPage.map(\.id))
        return firstPage + loaded.filter { !fresh.contains($0.id) }
    }
}

struct PaperclipStatusExpectation: Codable {
    let status: PaperclipIssueStatus
    let userID: String
    let unblockAction: String?
    init(status: PaperclipIssueStatus, userID: String, unblockAction: String?) throws {
        self.status = status
        self.userID = userID
        if status == .blocked {
            guard let action = PaperclipUnblockAction.resolved(unblockAction) else { throw PaperclipError.unblockActionRequired }
            self.unblockAction = action
        } else { self.unblockAction = nil }
    }
    func matches(_ issue: PaperclipIssue) -> Bool {
        guard issue.status == status.rawValue else { return false }
        if status == .blocked {
            return issue.unblockDescriptor?.owner == .object(["userId": .string(userID)]) &&
                issue.unblockDescriptor?.action == unblockAction
        }
        return true
    }
}

enum PaperclipUnblockAction {
    /// [A5] 解除条件可不填:空着时默认写这句。
    static let defaultAction = "等我处理"
    /// 上游 z.string().trim().min(1).max(2000) 按 UTF-16 长度计数。
    static func normalized(_ raw: String?) -> String? {
        guard let raw else { return nil }
        let action = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !action.isEmpty, action.utf16.count <= 2_000 else { return nil }
        return action
    }
    /// [A5] 设为「受阻」时实际发送的解除条件:空 → 默认句;超长仍拒绝(返回 nil)。
    static func resolved(_ raw: String?) -> String? {
        let trimmed = raw?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? defaultAction : normalized(trimmed)
    }
}

/// [A5] 全自动开着时 Paperclip 审批一点即提交,不再弹二次确认。
/// 只读全自动这一个布尔(与 FullAutoGate.defaultsKey 同一个键,MinisTests 校验两者一致);
/// Paperclip 边界内不引用 App 的其他模块,原生审计工程也能单独编译。
enum PaperclipFullAuto {
    static let defaultsKey = "permissions.fullAuto.enabled"
    static var isOn: Bool { UserDefaults.standard.bool(forKey: defaultsKey) }
    /// 审批决定要不要再弹「确认批准 / 拒绝？」。
    static func needsDecisionConfirmation(fullAuto: Bool) -> Bool { !fullAuto }
}

/// [G1] 「读取工单结果」：智能体最近一条回复全文作为结果，交给快捷指令下一步；Siri 只念开头。
enum PaperclipIssueResult {
    static let finishedStatuses: Set<String> = ["done", "in_review"]
    static let valueLimit = 20_000
    static let spokenLimit = 300
    static func compose(issue: PaperclipIssue, comments: [PaperclipComment]) -> (value: String, dialog: String) {
        let reply = comments.last { !($0.authorAgentId ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
        let body = reply?.body.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let status = PaperclipLabels.status(issue.status)
        guard !body.isEmpty else { return ("", "「\(issue.title)」\(status)，还没有智能体给出结果。") }
        let value = String(body.prefix(valueLimit))
        let spoken = String(body.prefix(spokenLimit))
        if finishedStatuses.contains(issue.status) { return (value, "「\(issue.title)」\(status)。结果：\(spoken)") }
        return (value, "「\(issue.title)」当前状态为\(status)，目前最新的结果：\(spoken)")
    }
}

enum PaperclipLabels {
    static func status(_ value: String) -> String {
        ["backlog": "待规划", "todo": "待处理", "in_progress": "进行中", "in_review": "待审核",
         "done": "已完成", "blocked": "受阻", "cancelled": "已取消", "queued": "排队中",
         "running": "运行中", "succeeded": "运行成功", "failed": "运行失败", "timed_out": "运行超时",
         "pending": "待审批", "approved": "已批准", "rejected": "已拒绝", "revision_requested": "要求修改",
         "idle": "空闲", "active": "可用", "paused": "已暂停", "error": "异常", "terminated": "已停用"][value] ?? "未知状态"
    }
    static func priority(_ value: String) -> String {
        ["critical": "紧急", "high": "高", "medium": "中", "low": "低"][value] ?? "未指定"
    }
    /// 运行失败原因的中文摘要；未知代码统一显示，不把原始枚举值直接抛给用户。
    static func runError(_ code: String?) -> String? {
        guard let code = code?.trimmingCharacters(in: .whitespacesAndNewlines), !code.isEmpty else { return nil }
        return ["adapter_failed": "智能体执行器出错", "process_lost": "执行进程意外中断",
                "timeout": "运行超时", "cancelled": "运行已取消", "operator_interrupted": "已被手动中断",
                "server_shutdown_interrupted": "服务器重启中断了运行", "provider_quota": "模型服务额度不足",
                "provider_transport_failed": "连接模型服务失败", "issue_reassigned": "任务已改派给其他智能体",
                "workspace_restore_failed": "工作区恢复失败", "workspace_validation_failed": "工作区校验失败",
                "agent_not_invokable": "智能体当前不可调用", "adapter_engine_unavailable": "执行引擎不可用",
                "ai_connection_busy": "模型连接繁忙", "turn_limit_exhausted": "已达到对话轮次上限",
                "tool_not_found": "找不到所需工具", "tool_execution_failed": "工具执行失败",
                "invalid_response": "模型返回格式无效", "setup_failed": "运行准备失败",
                "execution_finalization_deadline_exceeded": "收尾超时"][code] ?? "运行异常结束"
    }
    static func error(_ error: Error) -> String {
        (error as? PaperclipError)?.errorDescription ?? "连接失败，请检查网络和服务器地址后重试。不会转为本机执行。"
    }
}
indirect enum PaperclipError: LocalizedError, Equatable {
    case invalidAddress, signedOut, forbidden, identityChanged, invalidResponse, unavailable, cancelled
    case http(Int), uncertain, unblockActionRequired, statusNotConfirmed
    /// 写操作前的健康/身份/任务读取失败：写请求确定没有发出，草稿可以安全解锁。
    case preflightFailed(PaperclipError)
    /// 预检包装只说明"未发出"，登录过期、身份变化等处理仍看原始原因。
    var underlying: PaperclipError {
        if case .preflightFailed(let error) = self { return error.underlying }
        return self
    }
    var errorDescription: String? {
        switch self {
        case .preflightFailed(let error):
            return (error.errorDescription ?? "") + "操作尚未发送到服务器，可以修改后重新提交。"
        case .invalidAddress: return "请输入独立服务器的 HTTPS 根地址，不包含账号、密码、路径、查询参数或片段。"
        case .signedOut: return "登录已过期或尚未登录，请打开服务器登录页，用你的人类用户账号登录。"
        case .forbidden: return "当前用户没有执行此操作的权限，请联系服务器管理员。"
        case .identityChanged: return "任务绑定的服务器、公司或用户与当前身份不一致。请回到原配置和账号，不会自动迁移任务。"
        case .invalidResponse: return "服务器响应格式不兼容，请确认部署版本与客户端契约一致。"
        case .unavailable: return "服务器尚未就绪或无法连接，请稍后重试。不会改用本机执行。"
        case .cancelled: return "请求已取消。"
        case .http(409): return "任务或审批已被其他操作更新，请刷新并重新核对后再决定。"
        case .http(let status): return "服务器请求失败（状态码 \(status)），请刷新后检查结果。"
        case .unblockActionRequired: return "请填写解除受阻需要做什么（1 到 2000 个字符）。"
        case .statusNotConfirmed: return "服务器状态或解除条件与原目标不同，尚未核实成功；没有重新发送。"
        case .uncertain: return "服务器可能已收到操作，但返回结果尚未确认。请先刷新核对；创建和回复重试会保留同一请求编号。不会自动重发或转为本机执行。"
        }
    }
}
