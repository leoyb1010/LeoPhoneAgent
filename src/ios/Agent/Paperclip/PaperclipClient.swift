import Foundation

/// 不跟随重定向，防止登录 Cookie 发送到代理、登录页或其他服务器。
private final class PaperclipNoRedirect: NSObject, URLSessionTaskDelegate, Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest,
                    completionHandler: @escaping @Sendable (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

@MainActor
final class PaperclipClient {
    let profile: PaperclipProfile
    private let session: URLSession
    private var invalidated = false
    private let readCookies: @MainActor () async -> [HTTPCookie]
    private let saveCookies: @MainActor ([HTTPCookie]) async -> Void

    init(profile: PaperclipProfile, configuration: URLSessionConfiguration = .ephemeral,
         readCookies: @escaping @MainActor () async -> [HTTPCookie],
         saveCookies: @escaping @MainActor ([HTTPCookie]) async -> Void = { _ in }) {
        self.profile = profile
        self.readCookies = readCookies
        self.saveCookies = saveCookies
        configuration.httpShouldSetCookies = false
        configuration.httpCookieStorage = nil
        configuration.urlCredentialStorage = nil
        configuration.urlCache = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.timeoutIntervalForRequest = 25
        configuration.timeoutIntervalForResource = 40
        session = URLSession(configuration: configuration, delegate: PaperclipNoRedirect(), delegateQueue: nil)
    }

    deinit { session.invalidateAndCancel() }

    func invalidate() {
        invalidated = true
        session.invalidateAndCancel()
    }

    /// 不读取系统共享 Cookie、不保存令牌，不接受 API Key。
    static func cookies(_ cookies: [HTTPCookie], for url: URL, now: Date = Date()) -> [HTTPCookie] {
        cookies.filter {
            $0.domain.trimmingCharacters(in: CharacterSet(charactersIn: ".")).lowercased() == url.host?.lowercased() &&
            $0.isSecure && ($0.expiresDate == nil || $0.expiresDate! > now) &&
            (url.path == $0.path || url.path.hasPrefix($0.path.hasSuffix("/") ? $0.path : $0.path + "/"))
        }
    }

    func health() async throws -> PaperclipHealth {
        let result: PaperclipHealth = try await request("/api/health", cookies: [])
        guard result.status == "ok", result.deploymentMode != "local_trusted" else { throw PaperclipError.unavailable }
        return result
    }

    func humanSession() async throws -> PaperclipSession {
        let cookies = await readCookies()
        let data = try await raw("/api/auth/get-session", cookies: cookies)
        return try PaperclipSession.decode(data)
    }

    func companies(userID: String) async throws -> [PaperclipCompany] {
        try await authenticated("/api/companies?scope=accessible", userID: userID)
    }

    func agents(companyID: String, userID: String) async throws -> [PaperclipAgent] {
        let id = try PaperclipProfile.component(companyID)
        let rows: [PaperclipAgent] = try await authenticated("/api/companies/\(id)/agents", userID: userID)
        guard rows.allSatisfy({ $0.companyId == companyID }) else { throw PaperclipError.identityChanged }
        return rows
    }

    func issues(companyID: String, userID: String, offset: Int = 0) async throws -> [PaperclipIssue] {
        let id = try PaperclipProfile.component(companyID)
        let rows: [PaperclipIssue] = try await authenticated("/api/companies/\(id)/issues?limit=100&offset=\(max(0, offset))", userID: userID)
        guard rows.allSatisfy({ $0.companyId == companyID }) else { throw PaperclipError.identityChanged }
        return rows
    }

    func refreshedIssues(companyID: String, userID: String, loadedCount: Int) async throws -> [PaperclipIssue] {
        // 官方列表按 100 条分页；重读已加载窗口，让前台轮询更新内容且不截掉后续页。
        var rows: [PaperclipIssue] = []
        repeat {
            let page = try await issues(companyID: companyID, userID: userID, offset: rows.count)
            rows += page
            if page.count < 100 { break }
        } while rows.count < max(100, loadedCount)
        return rows
    }

    func reference(for issue: PaperclipIssue, userID: String) -> PaperclipTaskReference {
        PaperclipTaskReference(profileID: profile.id, origin: profile.origin, companyID: issue.companyId,
                               userID: userID, issueID: issue.id)
    }

    func issue(_ ref: PaperclipTaskReference) async throws -> PaperclipIssue {
        let path = try issuePath(ref)
        let value: PaperclipIssue = try await authenticated(path, userID: ref.userID)
        try verify(value, ref)
        return value
    }

    func comments(_ ref: PaperclipTaskReference) async throws -> [PaperclipComment] {
        let rows: [PaperclipComment] = try await authenticated(try issuePath(ref) + "/comments?order=asc", userID: ref.userID)
        guard rows.allSatisfy({ $0.companyId == ref.companyID && $0.issueId == ref.issueID }) else { throw PaperclipError.identityChanged }
        return rows
    }

    func runs(_ ref: PaperclipTaskReference) async throws -> [PaperclipRun] {
        try await authenticated(try issuePath(ref) + "/runs", userID: ref.userID)
    }

    func approvals(_ ref: PaperclipTaskReference) async throws -> [PaperclipApproval] {
        let rows: [PaperclipApproval] = try await authenticated(try issuePath(ref) + "/approvals", userID: ref.userID)
        guard rows.allSatisfy({ $0.companyId == ref.companyID }) else { throw PaperclipError.identityChanged }
        return rows
    }

    func create(companyID: String, userID: String, title: String, description: String,
                agentID: String?, requestID: UUID) async throws -> PaperclipIssue {
        let id = try PaperclipProfile.component(companyID)
        var body: [String: Any] = ["title": title, "description": description, "priority": "medium",
                                   "status": agentID == nil ? "backlog" : "todo", "idempotencyKey": requestID.uuidString]
        if let agentID { body["assigneeAgentId"] = try PaperclipProfile.component(agentID) }
        let issue: PaperclipIssue = try await authenticated("/api/companies/\(id)/issues", method: "POST", body: body, userID: userID)
        guard issue.companyId == companyID, !issue.id.isEmpty else { throw PaperclipError.uncertain }
        return issue
    }

    func reply(_ ref: PaperclipTaskReference, body: String, requestID: UUID) async throws -> PaperclipComment {
        _ = try await issue(ref)
        let row: PaperclipComment = try await authenticated(try issuePath(ref) + "/comments", method: "POST",
            body: ["body": body, "clientRequestId": requestID.uuidString], userID: ref.userID)
        guard row.companyId == ref.companyID, row.issueId == ref.issueID, !row.id.isEmpty else { throw PaperclipError.uncertain }
        return row
    }

    func setStatus(_ ref: PaperclipTaskReference, status: PaperclipIssueStatus) async throws -> PaperclipIssue {
        _ = try await issue(ref)
        let row: PaperclipIssue = try await authenticated(try issuePath(ref), method: "PATCH", body: ["status": status.rawValue], userID: ref.userID)
        try verify(row, ref)
        return row
    }

    func resolve(_ ref: PaperclipTaskReference, approval: PaperclipApproval, approve: Bool, note: String) async throws -> PaperclipApproval {
        // 在提交前重新验证此审批确实属于当前任务，不能拿公司级列表误审批其他任务。
        _ = try await issue(ref)
        let current = try await approvals(ref)
        guard approval.companyId == ref.companyID, approval.status == "pending",
              current.contains(where: { $0 == approval }) else { throw PaperclipError.http(409) }
        let approvalID = approval.id
        let id = try PaperclipProfile.component(approvalID)
        let action = approve ? "approve" : "reject"
        let row: PaperclipApproval = try await authenticated("/api/approvals/\(id)/\(action)", method: "POST",
                                                            body: ["decisionNote": note], userID: ref.userID)
        guard row.id == approvalID, row.companyId == ref.companyID,
              row.status == (approve ? "approved" : "rejected") else { throw PaperclipError.uncertain }
        return row
    }

    func runLog(_ ref: PaperclipTaskReference, runID: String, offset: Int = 0) async throws -> PaperclipRunLogChunk {
        _ = try await issue(ref)
        let linked = try await runs(ref)
        guard linked.contains(where: { $0.runId == runID }) else { throw PaperclipError.identityChanged }
        let id = try PaperclipProfile.component(runID)
        let log: PaperclipRunLogChunk = try await authenticated("/api/heartbeat-runs/\(id)/log?offset=\(max(0, offset))&limitBytes=64000", userID: ref.userID)
        guard log.runId == runID else { throw PaperclipError.identityChanged }
        return log
    }

    private func issuePath(_ ref: PaperclipTaskReference) throws -> String {
        try ref.validate(profile: profile, companyID: ref.companyID, userID: ref.userID)
        return "/api/issues/" + (try PaperclipProfile.component(ref.issueID))
    }
    private func verify(_ issue: PaperclipIssue, _ ref: PaperclipTaskReference) throws {
        guard issue.id == ref.issueID, issue.companyId == ref.companyID else { throw PaperclipError.identityChanged }
    }

    private func authenticated<T: Decodable>(_ path: String, method: String = "GET",
                                            body: [String: Any]? = nil, userID: String) async throws -> T {
        // 同一 Cookie 快照用于身份校验和实际请求，切换账号不会改变进行中的请求归属。
        let cookies = await readCookies()
        let identity = try PaperclipSession.decode(try await raw("/api/auth/get-session", cookies: cookies))
        guard identity.user.id == userID else { throw PaperclipError.identityChanged }
        return try await request(path, method: method, body: body, cookies: cookies)
    }

    private func request<T: Decodable>(_ path: String, method: String = "GET", body: [String: Any]? = nil,
                                      cookies: [HTTPCookie]) async throws -> T {
        let data = try await raw(path, method: method, body: body, cookies: cookies)
        do { return try JSONDecoder().decode(T.self, from: data) }
        catch { throw method == "GET" ? PaperclipError.invalidResponse : PaperclipError.uncertain }
    }

    private func raw(_ path: String, method: String = "GET", body: [String: Any]? = nil,
                     cookies: [HTTPCookie]) async throws -> Data {
        guard !invalidated else { throw PaperclipError.signedOut }
        let url = try profile.url(path)
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.httpShouldHandleCookies = false
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue(profile.origin.absoluteString, forHTTPHeaderField: "Origin")
        request.setValue(profile.origin.absoluteString + "/", forHTTPHeaderField: "Referer")
        let matching = Self.cookies(cookies, for: url)
        for (key, value) in HTTPCookie.requestHeaderFields(with: matching) { request.setValue(value, forHTTPHeaderField: key) }
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        let mutation = method != "GET"
        let result: (Data, URLResponse)
        do { result = try await session.data(for: request) }
        catch {
            if mutation { throw PaperclipError.uncertain }
            if Task.isCancelled { throw PaperclipError.cancelled }
            throw PaperclipError.unavailable
        }
        guard let http = result.1 as? HTTPURLResponse,
              let responseURL = http.url, PaperclipProfile.sameOrigin(responseURL, profile.origin) else {
            throw mutation ? PaperclipError.uncertain : PaperclipError.invalidResponse
        }
        switch http.statusCode {
        case 200..<300: break
        case 401: throw PaperclipError.signedOut
        case 403: throw PaperclipError.forbidden
        case 300..<400: throw PaperclipError.invalidResponse
        case 500...599 where mutation: throw PaperclipError.uncertain
        default: throw PaperclipError.http(http.statusCode)
        }
        guard let type = http.value(forHTTPHeaderField: "Content-Type")?.lowercased(),
              type.contains("application/json") || type.contains("+json"), result.0.count <= 8_000_000 else {
            throw mutation ? PaperclipError.uncertain : PaperclipError.invalidResponse
        }
        guard !invalidated else { throw mutation ? PaperclipError.uncertain : PaperclipError.signedOut }
        // 接收服务器轮换的 Cookie，但只能写入此配置专用的 WebKit 容器。
        var headers: [String: String] = [:]
        for (key, value) in http.allHeaderFields { if let key = key as? String, let value = value as? String { headers[key] = value } }
        let updated = HTTPCookie.cookies(withResponseHeaderFields: headers, for: url).filter {
            $0.domain.trimmingCharacters(in: CharacterSet(charactersIn: ".")).lowercased() == profile.origin.host?.lowercased()
        }
        if !updated.isEmpty { await saveCookies(updated) }
        return result.0
    }
}
