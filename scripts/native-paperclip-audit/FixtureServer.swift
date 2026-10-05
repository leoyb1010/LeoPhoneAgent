import Foundation
import UIKit

/// 仅测试宿主编译的确定性 API；所有页面和客户端使用生产源码。
@MainActor
private final class FixtureCookieStorage: PaperclipCookieStorage {
    func allCookies() async -> [HTTPCookie] {
        [HTTPCookie(properties: [.domain: "paperclip.fixture.invalid", .path: "/", .name: "paperclip-fixture.session_token", .value: "fixture-only", .secure: "TRUE"])!]
    }
    func setCookie(_ cookie: HTTPCookie) async {}
    func removeAllData() async {}
}

@MainActor
enum PaperclipAuditFixture {
    static var showcase: Bool { ProcessInfo.processInfo.arguments.contains("--showcase-fixture") }

    static func makeStore() -> PaperclipWorkspaceStore {
        let domain = "com.leoyuan.paperclip-native-audit.fixture"
        let defaults = UserDefaults(suiteName: domain)!
        defaults.removePersistentDomain(forName: domain)
        PaperclipFixtureProtocol.reset()
        let store = PaperclipWorkspaceStore(defaults: defaults,
            makeCookieVault: { _ in PaperclipCookieVault(storage: FixtureCookieStorage()) },
            makeConfiguration: {
                let config = URLSessionConfiguration.ephemeral
                config.protocolClasses = [PaperclipFixtureProtocol.self]
                return config
            },
            // URLProtocol 无法承载 WebSocket：演示数据用脚本化事件流；其余旅程模拟服务器拒绝实时通道（403），走轮询回退。
            makeLiveSocket: { request in
                showcase ? PaperclipFixtureLiveSocket(request: request) as PaperclipLiveSocket : PaperclipFixtureRejectedSocket()
            })
        try! store.add(name: "原生测试服务器", address: "https://paperclip.fixture.invalid")
        if ProcessInfo.processInfo.arguments.contains("--saved-draft-refresh-fixture"), let profile = store.selectedProfile {
            for issueID in [nil, "issue-1"] as [String?] {
                var draft = PaperclipDraft()
                draft.title = "保留创建草稿"; draft.body = "保留回复草稿"
                if ProcessInfo.processInfo.arguments.contains("--unknown-draft-refresh-fixture") { draft.markSubmitted() }
                draft.save(key: PaperclipDraft.key(profile: profile, companyID: "company", userID: "human", issueID: issueID))
            }
        }
        return store
    }
}

/// 模拟不提供实时通道的服务器：握手 403，客户端再确认身份后停止重连、回退轮询。
@MainActor
private final class PaperclipFixtureRejectedSocket: PaperclipLiveSocket {
    func resume() {}
    func waitUntilOpen() async throws { throw URLError(.badServerResponse) }
    func receiveText() async throws -> String { throw URLError(.badServerResponse) }
    func cancel() {}
    var handshakeStatus: Int? { 403 }
    var responseURL: URL? { nil }
}

/// 演示用实时事件流：每 1.6 秒推送一条运行进度/日志，第 4 条时智能体发出新评论。
@MainActor
private final class PaperclipFixtureLiveSocket: PaperclipLiveSocket {
    private let url: URL?
    private var cancelled = false
    private var step = 0
    private var logSeq = 0
    init(request: URLRequest) { url = request.url }
    func resume() {}
    func waitUntilOpen() async throws {}
    var handshakeStatus: Int? { 101 }
    var responseURL: URL? { url }
    func cancel() { cancelled = true }
    func receiveText() async throws -> String {
        try await Task.sleep(for: .milliseconds(1_600))
        if cancelled { throw URLError(.cancelled) }
        step += 1
        let tools = ["读取仓库", "bash", "编辑文件", "运行测试"]
        let snippets = ["正在比对登录接口的会话校验逻辑。", "发现 Cookie 过期后没有回到登录页，正在补充处理。",
                        "已修改 **AuthGuard**，现在运行回归测试。", "测试全部通过，正在整理结果。"]
        let index = (step - 1) % tools.count
        let payload: [String: Any]
        let type: String
        switch step % 3 {
        case 1:
            type = "heartbeat.run.progress"
            payload = ["runId": "run-live", "agentId": "agent", "issueId": "issue-1", "phase": "run_activity",
                       "message": "执行中", "currentToolName": tools[index], "lastAssistantSnippet": snippets[index],
                       "lastEventAt": ISO8601DateFormatter().string(from: Date())]
        case 2:
            type = "heartbeat.run.log"
            logSeq += 1
            payload = ["runId": "run-live", "agentId": "agent", "issueId": "issue-1", "ts": "t", "seq": logSeq,
                       "stream": "stdout", "chunk": "\u{1B}[36m[\(tools[index])]\u{1B}[0m 第 \(step) 步完成\n", "truncated": false]
        default:
            type = "heartbeat.run.event"
            payload = ["runId": "run-live", "agentId": "agent", "issueId": "issue-1", "seq": step, "eventType": "tool",
                       "currentToolName": tools[index], "lastAssistantSnippet": snippets[index]]
        }
        if step == 4 {
            PaperclipFixtureProtocol.appendAgentComment("已定位问题：会话过期时前端没有清理本地状态。我已提交修复，正在跑回归测试。")
            return Self.encode(type: "activity.logged", payload: ["entityType": "issue", "entityId": "issue-1", "action": "issue.comment_added",
                                                                 "actorType": "agent", "actorId": "agent"])
        }
        return Self.encode(type: type, payload: payload)
    }
    private static func encode(type: String, payload: [String: Any]) -> String {
        let object: [String: Any] = ["id": 1, "companyId": "company", "type": type, "createdAt": ISO8601DateFormatter().string(from: Date()), "payload": payload]
        return String(decoding: try! JSONSerialization.data(withJSONObject: object), as: UTF8.self)
    }
}

private struct PaperclipFixtureLostReceipt {}

private final class PaperclipFixtureProtocol: URLProtocol, @unchecked Sendable {
    private static let lock = NSLock()
    nonisolated(unsafe) private static var status = "in_progress"
    nonisolated(unsafe) private static var approvalStatus = "pending"
    nonisolated(unsafe) private static var unblockDescriptor: [String: Any]?
    nonisolated(unsafe) private static var loseStatusReceipt = false
    nonisolated(unsafe) private static var statusPatchCount = 0
    nonisolated(unsafe) private static var comments: [[String: Any]] = []
    nonisolated(unsafe) private static var created: [[String: Any]] = []
    nonisolated(unsafe) private static var listReads = 0
    nonisolated(unsafe) private static var detailReads = 0
    nonisolated(unsafe) private static var refreshDraftFixture = false
    nonisolated(unsafe) private static var showcase = false
    nonisolated(unsafe) private static var start = Date()
    nonisolated(unsafe) private static var avatarPNG: Data?

    private static func iso(_ minutesAgo: Double) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: start.addingTimeInterval(-minutesAgo * 60))
    }

    private static func now() -> String { iso(-Date().timeIntervalSince(start) / 60) }

    static func reset() {
        lock.lock(); defer { lock.unlock() }
        status = "in_progress"; approvalStatus = "pending"; unblockDescriptor = nil; comments = []; created = []
        loseStatusReceipt = ProcessInfo.processInfo.arguments.contains("--status-receipt-unknown-fixture")
        statusPatchCount = 0
        listReads = 0; detailReads = 0
        refreshDraftFixture = ProcessInfo.processInfo.arguments.contains("--saved-draft-refresh-fixture")
        showcase = ProcessInfo.processInfo.arguments.contains("--showcase-fixture")
        start = Date()
        if showcase {
            comments = [
                ["id": "comment-a", "companyId": "company", "issueId": "issue-1", "authorUserId": "human", "createdAt": iso(42),
                 "body": "登录过期后页面一直转圈，帮我查一下原因并修好，顺便补上回归测试。"],
                ["id": "comment-b", "companyId": "company", "issueId": "issue-1", "authorAgentId": "agent", "createdAt": iso(38),
                 "body": "收到。我先复现问题，计划分三步：\n\n1. 复现会话过期场景\n2. 定位 `AuthGuard` 的跳转逻辑\n3. 修复并补充回归测试"],
                ["id": "comment-c", "companyId": "company", "issueId": "issue-1", "authorAgentId": "agent", "createdAt": iso(36),
                 "body": "已复现：会话过期时接口返回 **401**，但前端没有回到登录页。"],
                ["id": "comment-d", "companyId": "company", "issueId": "issue-1", "authorUserId": "human", "createdAt": iso(20),
                 "body": "好的，修复时注意不要影响已登录用户。"]
            ]
        }
    }

    static func appendAgentComment(_ body: String) {
        lock.lock(); defer { lock.unlock() }
        comments.append(["id": "comment-live-\(comments.count)", "companyId": "company", "issueId": "issue-1", "authorAgentId": "agent",
                         "createdAt": now(), "body": body])
    }

    override class func canInit(with request: URLRequest) -> Bool { request.url?.host == "paperclip.fixture.invalid" }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func stopLoading() {}
    override func startLoading() {
        do {
            let body = Self.body(request)
            Self.lock.lock()
            let result = Self.respond(path: request.url!.path, method: request.httpMethod ?? "GET", body: body, query: request.url!.query ?? "")
            Self.lock.unlock()
            if result is PaperclipFixtureLostReceipt {
                client?.urlProtocol(self, didFailWithError: URLError(.networkConnectionLost))
                return
            }
            let data: Data
            let type: String
            var code = 200
            if let png = result as? Data {
                data = png; type = "image/png"
            } else {
                data = try JSONSerialization.data(withJSONObject: result)
                type = "application/json"
                if (result as? [String: Any])?["error"] != nil { code = (result as? [String: Any])?["status"] as? Int ?? 422 }
            }
            let response = HTTPURLResponse(url: request.url!, statusCode: code, httpVersion: nil, headerFields: ["Content-Type": type])!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch { client?.urlProtocol(self, didFailWithError: error) }
    }
    private static func issue() -> [String: Any] {
        var row: [String: Any] = ["id": "issue-1", "companyId": "company", "identifier": "任务-1", "title": "修复登录流程",
         "description": "检查身份边界，完成中文界面回归验证。", "status": status, "priority": "high", "assigneeAgentId": "agent",
         "updatedAt": iso(1)]
        if let unblockDescriptor { row["unblockDescriptor"] = unblockDescriptor }
        if loseStatusReceipt { row["description"] = "检查身份边界，完成中文界面回归验证。\n状态写入次数：\(statusPatchCount)" }
        return row
    }
    private static func showcaseIssues() -> [[String: Any]] {
        guard showcase else { return [] }
        return [
            ["id": "issue-3", "companyId": "company", "identifier": "任务-3", "title": "整理第三季度用户反馈并归类", "status": "in_review",
             "priority": "medium", "assigneeAgentId": "agent-2", "updatedAt": iso(25),
             "description": "从客服工单与应用商店评论中汇总高频问题。"],
            ["id": "issue-4", "companyId": "company", "identifier": "任务-4", "title": "调研竞品定价策略", "status": "blocked",
             "priority": "critical", "assigneeAgentId": "agent-2", "updatedAt": iso(180),
             "description": "需要先拿到最新的销售数据权限。"],
            ["id": "issue-5", "companyId": "company", "identifier": "任务-5", "title": "为新版首页撰写发布说明", "status": "todo",
             "priority": "low", "updatedAt": iso(60 * 26), "description": "突出实时进度与对话式界面。"],
            ["id": "issue-6", "companyId": "company", "identifier": "任务-6", "title": "迁移旧版图片存储到对象存储", "status": "done",
             "priority": "medium", "assigneeAgentId": "agent", "updatedAt": iso(60 * 50), "description": "已完成迁移与校验。"]
        ]
    }
    private static func approval() -> [String: Any] {
        ["id": "approval-1", "companyId": "company", "type": "hire_agent", "status": approvalStatus,
         "requestedByAgentId": "agent", "payload": ["名称": "验证智能体", "职责": "执行界面回归"]]
    }
    private static func runs() -> [[String: Any]] {
        var rows: [[String: Any]] = [["runId": "run-1", "status": "succeeded", "agentId": "agent",
                                       "startedAt": iso(35), "finishedAt": iso(33.5), "createdAt": iso(35)]]
        if showcase {
            rows.insert(["runId": "run-0", "status": "failed", "agentId": "agent", "errorCode": "adapter_failed",
                         "startedAt": iso(41), "finishedAt": iso(40.2), "createdAt": iso(41)], at: 0)
            rows.append(["runId": "run-live", "status": "running", "agentId": "agent", "startedAt": iso(2.2), "createdAt": iso(2.3)])
        }
        return rows
    }
    private static func avatar() -> Data {
        if let avatarPNG { return avatarPNG }
        let renderer = UIGraphicsImageRenderer(size: CGSize(width: 96, height: 96))
        let image = renderer.image { context in
            let colors = [UIColor.systemTeal.cgColor, UIColor.systemBlue.cgColor] as CFArray
            let gradient = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: colors, locations: [0, 1])!
            context.cgContext.drawLinearGradient(gradient, start: .zero, end: CGPoint(x: 96, y: 96), options: [])
            let config = UIImage.SymbolConfiguration(pointSize: 52, weight: .semibold)
            UIImage(systemName: "face.smiling", withConfiguration: config)?.withTintColor(.white, renderingMode: .alwaysOriginal)
                .draw(in: CGRect(x: 18, y: 18, width: 60, height: 60))
        }
        let data = image.pngData() ?? Data()
        avatarPNG = data
        return data
    }
    private static func respond(path: String, method: String, body: [String: Any], query: String) -> Any {
        if path.hasPrefix("/api/agent-avatars/") { return avatar() }
        switch path {
        case "/api/health": return ["status": "ok", "deploymentMode": "authenticated"]
        case "/api/auth/get-session": return ["session": ["id": "session", "userId": "human"], "user": ["id": "human", "name": "验证用户"]]
        case "/api/companies": return [["id": "company", "name": "中文验证组织"]]
        case "/api/companies/company/agents":
            var rows: [[String: Any]] = [["id": "agent", "companyId": "company", "name": "验证智能体", "status": "idle",
                                          "avatarUrl": "/api/agent-avatars/cap-v1/arctic-blue/rest.png?size=512&scale=1"]]
            if showcase { rows.append(["id": "agent-2", "companyId": "company", "name": "研究助理", "status": "idle"]) }
            return rows
        case "/api/companies/company/live-runs":
            return showcase ? [["id": "run-live", "companyId": "company", "status": "running", "agentId": "agent", "issueId": "issue-1"]] : [] as [[String: Any]]
        case "/api/companies/company/issues":
            if method == "POST" {
                var new = issue(); new["id"] = "issue-2"; new["identifier"] = "任务-2"
                new["title"] = body["title"] ?? "新任务"; new["status"] = "backlog"; new["updatedAt"] = now()
                created = [new]; return new
            }
            listReads += 1
            var row = issue()
            if refreshDraftFixture && listReads > 1 { row["title"] = "列表已收到服务器更新" }
            return [row] + created + showcaseIssues()
        case "/api/issues/issue-2": return created.first ?? ["error": "尚未创建测试任务"]
        case "/api/issues/issue-2/comments", "/api/issues/issue-2/runs", "/api/issues/issue-2/approvals", "/api/issues/issue-2/live-runs":
            return [] as [[String: Any]]
        case "/api/issues/issue-1":
            if method == "PATCH", let newStatus = body["status"] as? String {
                if newStatus == "blocked" {
                    guard let descriptor = body["unblockDescriptor"] as? [String: Any],
                          let owner = descriptor["owner"] as? [String: String], owner == ["userId": "human"],
                          let action = descriptor["action"] as? String, !action.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                          action.utf16.count <= 2_000 else { return ["error": "受阻状态缺少有效解除说明或绑定用户"] }
                    unblockDescriptor = descriptor
                }
                status = newStatus
                statusPatchCount += 1
                if loseStatusReceipt { return PaperclipFixtureLostReceipt() }
            }
            if method == "GET" { detailReads += 1 }
            var row = issue()
            if refreshDraftFixture && detailReads > 1 { row["title"] = "详情已收到服务器更新" }
            return row
        case "/api/issues/issue-1/comments":
            if method == "POST" {
                let row: [String: Any] = ["id": "comment-sent-\(comments.count)", "companyId": "company", "issueId": "issue-1", "authorUserId": "human",
                                          "body": body["body"] ?? "", "clientRequestId": body["clientRequestId"] ?? "", "createdAt": now()]
                comments.append(row); return row
            }
            // 支持 after=<评论编号> 增量读取。
            if let after = query.components(separatedBy: "&").first(where: { $0.hasPrefix("after=") })?.dropFirst(6),
               let index = comments.firstIndex(where: { ($0["id"] as? String) == String(after) }) {
                return Array(comments[(index + 1)...])
            }
            return comments
        case "/api/issues/issue-1/runs": return runs()
        case "/api/issues/issue-1/live-runs":
            guard showcase else { return [] as [[String: Any]] }
            return [["id": "run-live", "status": "running", "agentId": "agent", "agentName": "验证智能体",
                     "avatarUrl": "/api/agent-avatars/cap-v1/arctic-blue/rest.png?size=512&scale=1",
                     "startedAt": iso(2.2), "createdAt": iso(2.3), "logBytes": 420,
                     "currentStatusMessage": "执行中", "currentToolName": "读取仓库",
                     "lastAssistantSnippet": "正在比对登录接口的会话校验逻辑。", "lastEventAt": iso(0.2)]]
        case "/api/issues/issue-1/approvals": return [approval()]
        case "/api/approvals/approval-1/approve": approvalStatus = "approved"; return approval()
        case "/api/approvals/approval-1/reject": approvalStatus = "rejected"; return approval()
        case "/api/heartbeat-runs/run-1/log", "/api/heartbeat-runs/run-0/log", "/api/heartbeat-runs/run-live/log":
            let runID = path.components(separatedBy: "/")[3]
            guard query.contains("offset=0&") else { return ["runId": runID, "content": ""] }
            let lines = [
                ["ts": "t", "stream": "stdout", "chunk": "\u{1B}[32m✓\u{1B}[0m 正在编译项目\n"],
                ["ts": "t", "stream": "stdout", "chunk": "验证完成：全部中文界面检查通过。\n"],
                ["ts": "t", "stream": "stderr", "chunk": runID == "run-0" ? "执行器退出码 1\n" : "提示：跳过 2 个慢速用例\n"]
            ]
            let content = lines.map { String(decoding: try! JSONSerialization.data(withJSONObject: $0), as: UTF8.self) }.joined(separator: "\n") + "\n"
            return ["runId": runID, "content": content]
        default: return ["error": "测试接口未定义", "status": 404]
        }
    }
    private static func body(_ request: URLRequest) -> [String: Any] {
        var data = request.httpBody ?? Data()
        if let stream = request.httpBodyStream, data.isEmpty {
            stream.open(); defer { stream.close() }
            var buffer = [UInt8](repeating: 0, count: 4096)
            while stream.hasBytesAvailable {
                let count = stream.read(&buffer, maxLength: buffer.count)
                if count <= 0 { break }
                data.append(contentsOf: buffer.prefix(count))
            }
        }
        return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
    }
}
