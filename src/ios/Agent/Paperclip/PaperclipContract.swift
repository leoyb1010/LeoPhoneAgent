import Foundation

/// Paperclip 994d6edcdd4e15d5f9cc5cf8c135ac599104b86a 的原生客户端契约。
/// 服务器任务独立于 ChatStore 和 Gateway，绝不通过本机代理执行或自动迁移。
enum IOSExecutionBackend: String, CaseIterable, Codable {
    case local
    case paperclip
    var title: String { self == .local ? "本机" : "Paperclip 服务器" }
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
        let decoder = JSONDecoder()
        struct Envelope: Decodable { let data: PaperclipSession? }
        let direct = try? decoder.decode(PaperclipSession.self, from: data)
        let wrapped = try? decoder.decode(Envelope.self, from: data)
        guard let value = direct ?? wrapped?.data,
              !value.user.id.isEmpty, !value.session.id.isEmpty,
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
}
struct PaperclipIssue: Decodable, Identifiable, Sendable {
    let id: String
    let companyId: String
    let identifier: String?
    let title: String
    let description: String?
    let status: String
    let priority: String
    let assigneeAgentId: String?
    let updatedAt: String?
}
struct PaperclipComment: Decodable, Identifiable, Sendable {
    let id: String
    let companyId: String
    let issueId: String
    let body: String
    let authorUserId: String?
    let authorAgentId: String?
    let clientRequestId: String?
    let createdAt: String?
}
struct PaperclipRun: Decodable, Identifiable, Sendable {
    let runId: String
    let status: String
    let agentId: String
    let startedAt: String?
    let finishedAt: String?
    var id: String { runId }
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

enum PaperclipIssueStatus: String, CaseIterable, Identifiable {
    case backlog, todo, inProgress = "in_progress", inReview = "in_review", done, blocked, cancelled
    var id: String { rawValue }
    var title: String { PaperclipLabels.status(rawValue) }
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
    static func error(_ error: Error) -> String {
        (error as? PaperclipError)?.errorDescription ?? "连接失败，请检查网络和服务器地址后重试。不会转为本机执行。"
    }
}
enum PaperclipError: LocalizedError, Equatable {
    case invalidAddress, signedOut, forbidden, identityChanged, invalidResponse, unavailable, cancelled
    case http(Int), uncertain
    var errorDescription: String? {
        switch self {
        case .invalidAddress: return "请输入独立服务器的 HTTPS 根地址，不包含账号、密码、路径、查询参数或片段。"
        case .signedOut: return "登录已过期或尚未登录，请打开服务器登录页，用你的人类用户账号登录。"
        case .forbidden: return "当前用户没有执行此操作的权限，请联系服务器管理员。"
        case .identityChanged: return "任务绑定的服务器、公司或用户与当前身份不一致。请回到原配置和账号，不会自动迁移任务。"
        case .invalidResponse: return "服务器响应格式不兼容，请确认部署版本与客户端契约一致。"
        case .unavailable: return "服务器尚未就绪或无法连接，请稍后重试。不会改用本机执行。"
        case .cancelled: return "请求已取消。"
        case .http(409): return "任务或审批已被其他操作更新，请刷新并重新核对后再决定。"
        case .http(let status): return "服务器请求失败（状态码 \(status)），请刷新后检查结果。"
        case .uncertain: return "服务器可能已收到操作，但返回结果尚未确认。请先刷新核对；创建和回复重试会保留同一请求编号。不会自动重发或转为本机执行。"
        }
    }
}
