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
            guard let action = PaperclipUnblockAction.normalized(unblockAction) else { throw PaperclipError.unblockActionRequired }
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
    /// 上游 z.string().trim().min(1).max(2000) 按 UTF-16 长度计数。
    static func normalized(_ raw: String?) -> String? {
        guard let raw else { return nil }
        let action = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !action.isEmpty, action.utf16.count <= 2_000 else { return nil }
        return action
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
