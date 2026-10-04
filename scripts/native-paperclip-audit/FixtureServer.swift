import Foundation

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
            })
        try! store.add(name: "原生测试服务器", address: "https://paperclip.fixture.invalid")
        return store
    }
}

private final class PaperclipFixtureProtocol: URLProtocol, @unchecked Sendable {
    private static let lock = NSLock()
    nonisolated(unsafe) private static var status = "in_progress"
    nonisolated(unsafe) private static var approvalStatus = "pending"
    nonisolated(unsafe) private static var comments: [[String: Any]] = []
    nonisolated(unsafe) private static var created: [[String: Any]] = []
    static func reset() {
        lock.lock(); defer { lock.unlock() }
        status = "in_progress"; approvalStatus = "pending"; comments = []; created = []
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
            let data = try JSONSerialization.data(withJSONObject: result)
            let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch { client?.urlProtocol(self, didFailWithError: error) }
    }
    private static func issue() -> [String: Any] {
        ["id": "issue-1", "companyId": "company", "identifier": "任务-1", "title": "修复登录流程",
         "description": "检查身份边界，完成中文界面回归验证。", "status": status, "priority": "high", "assigneeAgentId": "agent"]
    }
    private static func approval() -> [String: Any] {
        ["id": "approval-1", "companyId": "company", "type": "hire_agent", "status": approvalStatus,
         "requestedByAgentId": "agent", "payload": ["名称": "验证代理", "职责": "执行界面回归"]]
    }
    private static func respond(path: String, method: String, body: [String: Any], query: String) -> Any {
        switch path {
        case "/api/health": return ["status": "ok", "deploymentMode": "authenticated"]
        case "/api/auth/get-session": return ["session": ["id": "session", "userId": "human"], "user": ["id": "human", "name": "验证用户"]]
        case "/api/companies": return [["id": "company", "name": "中文验证公司"]]
        case "/api/companies/company/agents": return [["id": "agent", "companyId": "company", "name": "验证代理", "status": "idle"]]
        case "/api/companies/company/issues":
            if method == "POST" {
                var new = issue(); new["id"] = "issue-2"; new["title"] = body["title"] ?? "新任务"; new["status"] = "backlog"
                created = [new]; return new
            }
            return [issue()] + created
        case "/api/issues/issue-1":
            if method == "PATCH", let newStatus = body["status"] as? String { status = newStatus }
            return issue()
        case "/api/issues/issue-1/comments":
            if method == "POST" {
                let row: [String: Any] = ["id": "comment-1", "companyId": "company", "issueId": "issue-1", "authorUserId": "human",
                                          "body": body["body"] ?? "", "clientRequestId": body["clientRequestId"] ?? ""]
                comments = [row]; return row
            }
            return comments
        case "/api/issues/issue-1/runs": return [["runId": "run-1", "status": "succeeded", "agentId": "agent"]]
        case "/api/issues/issue-1/approvals": return [approval()]
        case "/api/approvals/approval-1/approve": approvalStatus = "approved"; return approval()
        case "/api/approvals/approval-1/reject": approvalStatus = "rejected"; return approval()
        case "/api/heartbeat-runs/run-1/log": return ["runId": "run-1", "content": query.contains("offset=0&") ? "验证完成：全部中文界面检查通过。\n" : "", "nextOffset": 100]
        default: return ["error": "测试接口未定义"]
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
