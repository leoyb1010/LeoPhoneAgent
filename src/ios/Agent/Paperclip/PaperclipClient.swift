import CryptoKit
import Foundation

/// 不跟随重定向，防止登录 Cookie 发送到代理、登录页或其他服务器。
final class PaperclipNoRedirect: NSObject, URLSessionTaskDelegate, Sendable {
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
    /// 只读请求在短时间内复用同一份 Cookie 的身份确认，避免每个 GET 都附带 get-session。
    /// 以前 10 秒小于 15 秒轮询节奏，几乎每轮都多一次 get-session；改为与轮询匹配的 30 秒。
    /// Cookie 指纹变化仍立即失效，写操作仍每次新鲜确认。
    static let identityReuseInterval: TimeInterval = 30
    private var confirmedIdentity: (fingerprint: String, userID: String, at: Date)?
    private var identityCheck: (fingerprint: String, task: Task<PaperclipSession, Error>)?
    /// 已确认属于某任务的运行（键含配置、公司、用户、任务）；运行日志分段读取不再每段重查任务与运行列表。
    private var verifiedRuns: Set<String> = []
    /// 已通过 issue(ref) 校验属于绑定公司的任务；只有它们的运行才会记入 verifiedRuns。
    private var verifiedIssues: Set<String> = []

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
        guard result.status == "ok", result.deploymentMode == "authenticated", result.authReady != false else { throw PaperclipError.unavailable }
        return result
    }

    /// health 只在 connect() 时做一次；这里不再重复探测。
    func humanSession() async throws -> PaperclipSession {
        let cookies = await readCookies()
        let data = try await raw("/api/auth/get-session", cookies: cookies)
        return try PaperclipSession.decode(data)
    }

    /// 尽力撤销服务器会话；失败、超时都不抛出，不阻塞本机清理。
    func signOut() async {
        let cookies = await readCookies()
        _ = try? await raw("/api/auth/sign-out", method: "POST", body: [:], cookies: cookies, timeout: 8)
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

    func reference(for issue: PaperclipIssue, userID: String) -> PaperclipTaskReference {
        PaperclipTaskReference(profileID: profile.id, origin: profile.origin, companyID: issue.companyId,
                               userID: userID, issueID: issue.id)
    }

    func issue(_ ref: PaperclipTaskReference) async throws -> PaperclipIssue {
        let path = try issuePath(ref)
        let value: PaperclipIssue = try await authenticated(path, userID: ref.userID)
        try verify(value, ref)
        verifiedIssues.insert(ref.id)
        return value
    }

    /// - Parameter after: 已有的最后一条评论 id；提供时只增量读取其后的评论，nil 时全量读取。
    func comments(_ ref: PaperclipTaskReference, after: String? = nil) async throws -> [PaperclipComment] {
        let query = try after.map { "/comments?after=\(try PaperclipProfile.component($0))&order=asc" } ?? "/comments?order=asc"
        let rows: [PaperclipComment] = try await authenticated(try issuePath(ref) + query, userID: ref.userID)
        guard rows.allSatisfy({ $0.companyId == ref.companyID && $0.issueId == ref.issueID }) else { throw PaperclipError.identityChanged }
        return rows
    }

    func runs(_ ref: PaperclipTaskReference) async throws -> [PaperclipRun] {
        let rows: [PaperclipRun] = try await authenticated(try issuePath(ref) + "/runs", userID: ref.userID)
        if verifiedIssues.contains(ref.id) { for row in rows { verifiedRuns.insert(ref.id + "/" + row.runId) } }
        return rows
    }

    /// 任务当前排队/运行中的 run（带当前工具、最近输出）。接口行不含公司编号，
    /// 由任务路径限定归属：任务本身已通过 issue(ref) 校验属于绑定公司。
    func liveRuns(_ ref: PaperclipTaskReference) async throws -> [PaperclipLiveRun] {
        if !verifiedIssues.contains(ref.id) { _ = try await issue(ref) }
        let rows: [PaperclipLiveRun] = try await authenticated(try issuePath(ref) + "/live-runs", userID: ref.userID)
        guard rows.allSatisfy({ $0.issueId == nil || $0.issueId == ref.issueID }) else { throw PaperclipError.identityChanged }
        for row in rows { verifiedRuns.insert(ref.id + "/" + row.id) }
        return rows
    }

    /// 公司内正在运行的 run，用于列表的“运行中”标识；每行都必须属于当前公司。
    func companyLiveRuns(companyID: String, userID: String) async throws -> [PaperclipLiveRun] {
        let id = try PaperclipProfile.component(companyID)
        let rows: [PaperclipLiveRun] = try await authenticated("/api/companies/\(id)/live-runs", userID: userID)
        guard rows.allSatisfy({ $0.companyId == companyID }) else { throw PaperclipError.identityChanged }
        return rows.filter(\.isActive)
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
        // 预检读取失败时回复确定未发出，包装成 .preflightFailed 让草稿解锁。
        try await preflight { _ = try await issue(ref) }
        let row: PaperclipComment = try await authenticated(try issuePath(ref) + "/comments", method: "POST",
            body: ["body": body, "clientRequestId": requestID.uuidString], userID: ref.userID)
        guard row.companyId == ref.companyID, row.issueId == ref.issueID, !row.id.isEmpty,
              row.clientRequestId == requestID.uuidString, row.authorUserId == ref.userID,
              (row.authorAgentId ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, row.body == body else { throw PaperclipError.uncertain }
        return row
    }

    func setStatus(_ ref: PaperclipTaskReference, status: PaperclipIssueStatus, unblockAction: String? = nil) async throws -> PaperclipIssue {
        let expected = try PaperclipStatusExpectation(status: status, userID: ref.userID, unblockAction: unblockAction)
        var body: [String: Any] = ["status": status.rawValue]
        if let action = expected.unblockAction { body["unblockDescriptor"] = ["owner": ["userId": ref.userID], "action": action] }
        try await preflight { _ = try await issue(ref) }
        let row: PaperclipIssue = try await authenticated(try issuePath(ref), method: "PATCH", body: body, userID: ref.userID)
        try verify(row, ref)
        guard expected.matches(row) else { throw PaperclipError.uncertain }
        return row
    }

    func resolve(_ ref: PaperclipTaskReference, approval: PaperclipApproval, approve: Bool, note: String) async throws -> PaperclipApproval {
        // 在提交前重新验证此审批确实属于当前任务，不能拿公司级列表误审批其他任务。
        let current = try await preflight { () async throws -> [PaperclipApproval] in
            _ = try await issue(ref)
            return try await approvals(ref)
        }
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
        // 运行与任务归属确认一次后缓存：以前每读一段都重新请求 issue + runs。
        let key = ref.id + "/" + runID
        if !verifiedRuns.contains(key) {
            _ = try await issue(ref)
            let linked = try await runs(ref)
            if !linked.contains(where: { $0.runId == runID }) {
                // 刚开始的运行可能只出现在 live-runs 中。
                let live = try await liveRuns(ref)
                guard live.contains(where: { $0.id == runID }) else { throw PaperclipError.identityChanged }
            }
            guard verifiedRuns.contains(key) else { throw PaperclipError.identityChanged }
        }
        let id = try PaperclipProfile.component(runID)
        let log: PaperclipRunLogChunk = try await authenticated("/api/heartbeat-runs/\(id)/log?offset=\(max(0, offset))&limitBytes=64000", userID: ref.userID)
        guard log.runId == runID else { throw PaperclipError.identityChanged }
        return log
    }

    /// 实时通道握手请求。建连前用同一份 Cookie 快照新鲜确认身份（比对 userID），
    /// 再用同一快照经同一 Cookie 过滤写入 Cookie 头；地址只由已校验的 https 配置同源派生为 wss。
    func liveSocketRequest(companyID: String, userID: String) async throws -> URLRequest {
        guard !invalidated else { throw PaperclipError.signedOut }
        let id = try PaperclipProfile.component(companyID)
        let httpsURL = try profile.url("/api/companies/\(id)/events/ws")
        let cookies = await readCookies()
        try await confirmIdentity(cookies: cookies, userID: userID, fresh: true)
        guard !invalidated else { throw PaperclipError.signedOut }
        guard var parts = URLComponents(url: httpsURL, resolvingAgainstBaseURL: false) else { throw PaperclipError.invalidAddress }
        parts.scheme = "wss"
        guard let url = parts.url, Self.liveSameOrigin(url, profile.origin) else { throw PaperclipError.invalidAddress }
        var request = URLRequest(url: url)
        request.httpShouldHandleCookies = false
        request.timeoutInterval = 25
        request.setValue(profile.origin.absoluteString, forHTTPHeaderField: "Origin")
        for (key, value) in HTTPCookie.requestHeaderFields(with: Self.cookies(cookies, for: httpsURL)) {
            request.setValue(value, forHTTPHeaderField: key)
        }
        return request
    }

    /// wss 地址必须与 https 配置同主机同端口。
    static func liveSameOrigin(_ url: URL, _ origin: URL) -> Bool {
        url.scheme?.lowercased() == "wss" && origin.scheme?.lowercased() == "https" &&
        url.host?.lowercased() == origin.host?.lowercased() && (url.port ?? 443) == (origin.port ?? 443)
    }

    /// 智能体头像（服务器预设 PNG）。只允许同源 /api/agent-avatars/ 路径，带同一 Cookie 过滤，
    /// 不跟随重定向、不写回 Cookie；响应必须是同源 PNG 且不超过 2MB。
    func avatarData(path: String) async throws -> Data {
        guard !invalidated else { throw PaperclipError.signedOut }
        guard path.hasPrefix("/api/agent-avatars/") else { throw PaperclipError.invalidAddress }
        let url = try profile.url(path)
        var request = URLRequest(url: url)
        request.httpShouldHandleCookies = false
        request.timeoutInterval = 20
        request.setValue("image/png", forHTTPHeaderField: "Accept")
        let cookies = await readCookies()
        for (key, value) in HTTPCookie.requestHeaderFields(with: Self.cookies(cookies, for: url)) { request.setValue(value, forHTTPHeaderField: key) }
        let result: (Data, URLResponse)
        do { result = try await session.data(for: request) } catch { throw PaperclipError.unavailable }
        guard let http = result.1 as? HTTPURLResponse, http.statusCode == 200,
              let responseURL = http.url, PaperclipProfile.sameOrigin(responseURL, profile.origin),
              http.value(forHTTPHeaderField: "Content-Type")?.lowercased().hasPrefix("image/png") == true,
              !result.0.isEmpty, result.0.count <= 2_000_000 else { throw PaperclipError.invalidResponse }
        return result.0
    }

    private func issuePath(_ ref: PaperclipTaskReference) throws -> String {
        try ref.validate(profile: profile, companyID: ref.companyID, userID: ref.userID)
        return "/api/issues/" + (try PaperclipProfile.component(ref.issueID))
    }
    private func verify(_ issue: PaperclipIssue, _ ref: PaperclipTaskReference) throws {
        guard issue.id == ref.issueID, issue.companyId == ref.companyID else { throw PaperclipError.identityChanged }
    }

    /// 写请求之前的读取失败一律标记为"未发出"；已是预检错误的不重复包装。
    private func preflight<T>(_ work: () async throws -> T) async throws -> T {
        do { return try await work() }
        catch let error as PaperclipError {
            if case .preflightFailed = error { throw error }
            throw PaperclipError.preflightFailed(error)
        }
    }

    private func authenticated<T: Decodable>(_ path: String, method: String = "GET",
                                            body: [String: Any]? = nil, userID: String) async throws -> T {
        // 同一 Cookie 快照用于身份校验和实际请求，切换账号不会改变进行中的请求归属。
        // health 已在 connect() 完成，不再每次请求重复。
        let cookies = await readCookies()
        let mutation = method != "GET"
        if mutation {
            // 写操作必须新鲜确认身份；确认失败时写请求尚未发出。
            try await preflight { try await confirmIdentity(cookies: cookies, userID: userID, fresh: true) }
        } else {
            try await confirmIdentity(cookies: cookies, userID: userID, fresh: false)
        }
        return try await request(path, method: method, body: body, cookies: cookies)
    }

    /// 身份确认按 Cookie 指纹缓存 30 秒，并发读取共享同一个进行中的 get-session。
    /// Cookie 变化（重新登录、换账号、服务器轮换）指纹即变化，必定重新确认。
    private func confirmIdentity(cookies: [HTTPCookie], userID: String, fresh: Bool) async throws {
        let url = try profile.url("/api/auth/get-session")
        let header = HTTPCookie.requestHeaderFields(with: Self.cookies(cookies, for: url))["Cookie"] ?? ""
        let fingerprint = SHA256.hash(data: Data(header.utf8)).map { String(format: "%02x", $0) }.joined()
        if !fresh, let confirmed = confirmedIdentity, confirmed.fingerprint == fingerprint,
           Date().timeIntervalSince(confirmed.at) < Self.identityReuseInterval {
            guard confirmed.userID == userID else { throw PaperclipError.identityChanged }
            return
        }
        let task: Task<PaperclipSession, Error>
        if !fresh, let running = identityCheck, running.fingerprint == fingerprint {
            task = running.task
        } else {
            task = Task { @MainActor in
                try PaperclipSession.decode(try await self.raw("/api/auth/get-session", cookies: cookies))
            }
            identityCheck = (fingerprint, task)
        }
        let identity: PaperclipSession
        do { identity = try await task.value }
        catch {
            if identityCheck?.task == task { identityCheck = nil }
            confirmedIdentity = nil
            throw error
        }
        if identityCheck?.task == task { identityCheck = nil }
        guard identity.user.id == userID else {
            confirmedIdentity = nil
            throw PaperclipError.identityChanged
        }
        confirmedIdentity = (fingerprint, identity.user.id, Date())
    }

    private func request<T: Decodable>(_ path: String, method: String = "GET", body: [String: Any]? = nil,
                                      cookies: [HTTPCookie]) async throws -> T {
        let data = try await raw(path, method: method, body: body, cookies: cookies)
        do { return try JSONDecoder().decode(T.self, from: data) }
        catch { throw method == "GET" ? PaperclipError.invalidResponse : PaperclipError.uncertain }
    }

    private func raw(_ path: String, method: String = "GET", body: [String: Any]? = nil,
                     cookies: [HTTPCookie], timeout: TimeInterval? = nil) async throws -> Data {
        guard !invalidated else { throw PaperclipError.signedOut }
        let url = try profile.url(path)
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.httpShouldHandleCookies = false
        if let timeout { request.timeoutInterval = timeout }
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
