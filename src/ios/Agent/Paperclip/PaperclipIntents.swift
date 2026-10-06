import AppIntents
import Foundation

/// [C7] Paperclip 进 Siri / 快捷指令：派工单、查进度。
/// 留在 Paperclip 边界内，只依赖 PaperclipWorkspaceStore / PaperclipClient；
/// 用当前选中的服务器配置、它自己的 Cookie 容器和上次选的公司，不经本机 Agent。
@MainActor
enum PaperclipIntentConnection {
    struct Context {
        let store: PaperclipWorkspaceStore
        let client: PaperclipClient
        let profile: PaperclipProfile
        let userID: String
        let companyID: String
    }

    static func open() async throws -> Context {
        let store = PaperclipWorkspaceStore()
        // 一次性动作不开实时通道。
        await store.setForeground(false)
        guard store.selectedProfile != nil else { throw PaperclipIntentError.notConfigured }
        let connected = await store.connect()
        guard connected, let client = store.client, let user = store.user, let profile = store.selectedProfile else {
            let signedOut = [PaperclipError.signedOut, .identityChanged].map { PaperclipLabels.error($0) }
            if store.error == nil || signedOut.contains(store.error ?? "") { throw PaperclipIntentError.signedOut }
            throw PaperclipIntentError.failed(store.error ?? PaperclipLabels.error(PaperclipError.unavailable))
        }
        guard !store.companyID.isEmpty else { throw PaperclipIntentError.noCompany }
        return Context(store: store, client: client, profile: profile, userID: user.id, companyID: store.companyID)
    }

    static func agents() async throws -> [PaperclipAgentEntity] {
        try await open().store.agents.map(PaperclipAgentEntity.init)
    }

    static func issues() async throws -> [PaperclipIssueEntity] {
        try await open().store.issues.map(PaperclipIssueEntity.init)
    }
}

enum PaperclipIntentError: Error, CustomLocalizedStringResourceConvertible {
    case notConfigured, signedOut, noCompany, notFound
    case failed(String)

    var localizedStringResource: LocalizedStringResource {
        switch self {
        case .notConfigured: return "还没有配置 Paperclip 服务器，请先在 App 里添加。"
        case .signedOut: return "请在 App 里重新登录 Paperclip。"
        case .noCompany: return "当前 Paperclip 账号没有可用的公司。"
        case .notFound: return "找不到这个工单，它可能属于别的公司或账号。"
        case .failed(let message): return "\(message)"
        }
    }

    /// 登录失效：切到服务器任务页并请系统打开 App，让你直接重新登录。
    @MainActor
    static func surfaced(_ error: Error, by intent: some AppIntent) -> Error {
        guard case PaperclipIntentError.signedOut = error else {
            if let paperclip = error as? PaperclipError { return PaperclipIntentError.failed(PaperclipLabels.error(paperclip)) }
            return error
        }
        UserDefaults.standard.set(IOSExecutionBackend.paperclip.rawValue, forKey: IOSExecutionBackend.storageKey)
        return intent.needsToContinueInForegroundError("请在 App 里重新登录 Paperclip。")
    }
}

struct PaperclipAgentEntity: AppEntity, Sendable {
    static let typeDisplayRepresentation = TypeDisplayRepresentation(name: "Paperclip 智能体")
    static let defaultQuery = PaperclipAgentQuery()

    let id: String
    let name: String
    let status: String

    var displayRepresentation: DisplayRepresentation {
        DisplayRepresentation(title: "\(name)", subtitle: "\(PaperclipLabels.status(status))")
    }

    init(_ agent: PaperclipAgent) {
        id = agent.id
        name = agent.name
        status = agent.status
    }
}

struct PaperclipAgentQuery: EntityStringQuery {
    func entities(for identifiers: [String]) async throws -> [PaperclipAgentEntity] {
        try await PaperclipIntentConnection.agents().filter { identifiers.contains($0.id) }
    }

    func entities(matching string: String) async throws -> [PaperclipAgentEntity] {
        let query = string.trimmingCharacters(in: .whitespacesAndNewlines)
        let all = try await PaperclipIntentConnection.agents()
        return query.isEmpty ? all : all.filter { $0.name.localizedCaseInsensitiveContains(query) }
    }

    func suggestedEntities() async throws -> [PaperclipAgentEntity] {
        try await PaperclipIntentConnection.agents()
    }
}

struct PaperclipIssueEntity: AppEntity, Sendable {
    static let typeDisplayRepresentation = TypeDisplayRepresentation(name: "Paperclip 工单")
    static let defaultQuery = PaperclipIssueQuery()

    let id: String
    let companyID: String
    let identifier: String
    let title: String
    let status: String

    var displayRepresentation: DisplayRepresentation {
        DisplayRepresentation(title: "\(identifier.isEmpty ? title : "\(identifier) \(title)")",
                              subtitle: "\(PaperclipLabels.status(status))")
    }

    init(_ issue: PaperclipIssue) {
        id = issue.id
        companyID = issue.companyId
        identifier = issue.identifier ?? ""
        title = issue.title
        status = issue.status
    }
}

struct PaperclipIssueQuery: EntityStringQuery {
    func entities(for identifiers: [String]) async throws -> [PaperclipIssueEntity] {
        try await PaperclipIntentConnection.issues().filter { identifiers.contains($0.id) }
    }

    func entities(matching string: String) async throws -> [PaperclipIssueEntity] {
        let query = string.trimmingCharacters(in: .whitespacesAndNewlines)
        let all = try await PaperclipIntentConnection.issues()
        guard !query.isEmpty else { return Array(all.prefix(30)) }
        return all.filter { $0.title.localizedCaseInsensitiveContains(query) || $0.identifier.localizedCaseInsensitiveContains(query) }
    }

    func suggestedEntities() async throws -> [PaperclipIssueEntity] {
        Array(try await PaperclipIntentConnection.issues().prefix(30))
    }
}

struct CreatePaperclipIssueIntent: AppIntent {
    static let title: LocalizedStringResource = "派 Paperclip 工单"
    static let description = IntentDescription("在当前 Paperclip 服务器和公司里新建一个工单，可直接指派给智能体。")
    static let supportedModes: IntentModes = [.background, .foreground(.dynamic)]
    static let authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication

    @Parameter(title: "标题", requestValueDialog: "要派什么活？")
    var issueTitle: String

    @Parameter(title: "描述")
    var details: String?

    @Parameter(title: "智能体", description: "可选。指派后工单直接进入待处理。")
    var agent: PaperclipAgentEntity?

    static var parameterSummary: some ParameterSummary {
        Summary("派工单 \(\.$issueTitle)") {
            \.$details
            \.$agent
        }
    }

    @MainActor
    func perform() async throws -> some IntentResult & ReturnsValue<PaperclipIssueEntity> & ProvidesDialog {
        let title = String(issueTitle.trimmingCharacters(in: .whitespacesAndNewlines).prefix(200))
        guard !title.isEmpty else { throw PaperclipIntentError.failed("工单标题不能为空。") }
        do {
            let context = try await PaperclipIntentConnection.open()
            if let agent, !context.store.agents.contains(where: { $0.id == agent.id }) {
                throw PaperclipIntentError.failed("这个智能体不在当前公司里，请重新选择。")
            }
            let issue = try await context.client.create(
                companyID: context.companyID, userID: context.userID, title: title,
                description: details?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "",
                agentID: agent?.id, requestID: UUID())
            let entity = PaperclipIssueEntity(issue)
            let assignee = agent.map { "，已指派给\($0.name)" } ?? ""
            return .result(value: entity, dialog: IntentDialog(stringLiteral: "已派出「\(title)」\(assignee)。"))
        } catch {
            throw PaperclipIntentError.surfaced(error, by: self)
        }
    }
}

struct PaperclipIssueStatusIntent: AppIntent {
    static let title: LocalizedStringResource = "查 Paperclip 工单进度"
    static let description = IntentDescription("返回工单当前状态和智能体最近一条回复。")
    static let supportedModes: IntentModes = [.background, .foreground(.dynamic)]
    static let authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication

    @Parameter(title: "工单")
    var issue: PaperclipIssueEntity

    static var parameterSummary: some ParameterSummary {
        Summary("查 \(\.$issue) 的进度")
    }

    @MainActor
    func perform() async throws -> some IntentResult & ReturnsValue<String> & ProvidesDialog {
        do {
            let context = try await PaperclipIntentConnection.open()
            guard issue.companyID == context.companyID else { throw PaperclipIntentError.notFound }
            let reference = PaperclipTaskReference(profileID: context.profile.id, origin: context.profile.origin,
                                                   companyID: context.companyID, userID: context.userID, issueID: issue.id)
            let current = try await context.client.issue(reference)
            let comments = try await context.client.comments(reference)
            let reply = comments.last { !($0.authorAgentId ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
            var text = "「\(current.title)」\(PaperclipLabels.status(current.status))。"
            if let reply {
                text += "智能体最近回复：\(String(reply.body.trimmingCharacters(in: .whitespacesAndNewlines).prefix(300)))"
            } else {
                text += "智能体还没有回复。"
            }
            return .result(value: text, dialog: IntentDialog(stringLiteral: text))
        } catch {
            throw PaperclipIntentError.surfaced(error, by: self)
        }
    }
}
