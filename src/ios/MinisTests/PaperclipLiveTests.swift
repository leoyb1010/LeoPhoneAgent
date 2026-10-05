import Combine
import Foundation
import Network
import XCTest

/// 实时通道、运行模型与解析的单测（不连网：URLProtocol 固定响应 + 脚本化 WebSocket）。
private final class PaperclipLiveTestProtocol: URLProtocol, @unchecked Sendable {
    static let lock = NSLock()
    nonisolated(unsafe) static var handler: (@Sendable (URLRequest) throws -> (Int, String, String))?
    nonisolated(unsafe) static var requests: [String] = []
    /// 路径包含此前缀的请求在后台线程阻塞，直到测试放行（模拟“请求进行中”的竞态窗口）。
    nonisolated(unsafe) static var gate: (prefix: String, semaphore: DispatchSemaphore)?
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Self.lock.lock()
        let handler = Self.handler
        Self.requests.append((request.httpMethod ?? "GET") + " " + (request.url?.path ?? "") + (request.url?.query.map { "?" + $0 } ?? ""))
        let gate = Self.gate
        Self.lock.unlock()
        if let gate, (request.url?.path ?? "").hasPrefix(gate.prefix) {
            Self.lock.lock(); Self.gate = nil; Self.lock.unlock()
            gate.semaphore.wait()
        }
        do {
            let result = try handler!(request)
            let response = HTTPURLResponse(url: request.url!, statusCode: result.0, httpVersion: nil, headerFields: ["Content-Type": result.2])!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: Data(result.1.utf8))
            client?.urlProtocolDidFinishLoading(self)
        } catch { client?.urlProtocol(self, didFailWithError: error) }
    }
    override func stopLoading() {}
    static func install(_ handler: @escaping @Sendable (URLRequest) throws -> (Int, String, String)) {
        lock.lock(); self.handler = handler; requests = []; gate = nil; lock.unlock()
    }
    /// 下一次匹配前缀的请求阻塞，返回用于放行的信号量。
    static func hold(_ prefix: String) -> DispatchSemaphore {
        let semaphore = DispatchSemaphore(value: 0)
        lock.lock(); gate = (prefix, semaphore); lock.unlock()
        return semaphore
    }
    static var ledger: [String] { lock.lock(); defer { lock.unlock() }; return requests }
}

/// 脚本化 WebSocket：按顺序返回消息，消息耗尽后抛错（模拟断线）。
@MainActor
private final class ScriptedLiveSocket: PaperclipLiveSocket {
    var messages: [String]
    var openError: Error?
    var handshakeStatus: Int?
    var responseURL: URL?
    private(set) var cancelled = false
    private var waiter: CheckedContinuation<String, Error>?
    let holdOpen: Bool
    init(messages: [String], openError: Error? = nil, handshakeStatus: Int? = nil, holdOpen: Bool = false) {
        self.messages = messages; self.openError = openError; self.handshakeStatus = handshakeStatus; self.holdOpen = holdOpen
    }
    func resume() {}
    func waitUntilOpen() async throws { if let openError { throw openError } }
    func receiveText() async throws -> String {
        if cancelled { throw URLError(.cancelled) }
        if !messages.isEmpty { return messages.removeFirst() }
        if holdOpen {
            return try await withCheckedThrowingContinuation { waiter = $0 }
        }
        throw URLError(.networkConnectionLost)
    }
    func cancel() {
        cancelled = true
        waiter?.resume(throwing: URLError(.cancelled)); waiter = nil
    }
}

@MainActor
final class PaperclipLiveTests: XCTestCase {
    private static let session = #"{"session":{"id":"s","userId":"human"},"user":{"id":"human"}}"#
    private static let issue = #"{"id":"issue","companyId":"company","title":"任务","status":"in_progress","priority":"medium"}"#

    private func client(cookie: String = "fixture") throws -> PaperclipClient {
        let profile = try PaperclipProfile(name: "测试", address: "https://example.com")
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [PaperclipLiveTestProtocol.self]
        let cookies = [
            HTTPCookie(properties: [.domain: "example.com", .path: "/", .name: "paperclip.session_token", .value: cookie, .secure: "TRUE"])!,
            HTTPCookie(properties: [.domain: "other.example", .path: "/", .name: "foreign", .value: "leak", .secure: "TRUE"])!
        ]
        return PaperclipClient(profile: profile, configuration: config, readCookies: { cookies })
    }

    private func reference(_ client: PaperclipClient) -> PaperclipTaskReference {
        PaperclipTaskReference(profileID: client.profile.id, origin: client.profile.origin, companyID: "company", userID: "human", issueID: "issue")
    }

    private func event(company: String = "company", type: String, payload: [String: Any]) -> String {
        let object: [String: Any] = ["id": 1, "companyId": company, "type": type, "createdAt": "2026-10-05T10:00:00.000Z", "payload": payload]
        return String(decoding: try! JSONSerialization.data(withJSONObject: object), as: UTF8.self)
    }

    private func waitUntil(_ condition: @escaping @MainActor () -> Bool, timeout: TimeInterval = 3) async {
        let deadline = Date().addingTimeInterval(timeout)
        while !condition() && Date() < deadline { try? await Task.sleep(for: .milliseconds(10)) }
    }

    // MARK: 握手请求与身份

    func testLiveSocketRequestFreshlyConfirmsIdentityAndUsesFilteredCookiesOnSameOriginWSS() async throws {
        let session = Self.session
        PaperclipLiveTestProtocol.install { request in
            XCTAssertEqual(request.url?.path, "/api/auth/get-session")
            return (200, session, "application/json")
        }
        let client = try client()
        let request = try await client.liveSocketRequest(companyID: "company", userID: "human")
        XCTAssertEqual(request.url?.absoluteString, "wss://example.com/api/companies/company/events/ws")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Origin"), "https://example.com")
        let cookie = try XCTUnwrap(request.value(forHTTPHeaderField: "Cookie"))
        XCTAssertTrue(cookie.contains("paperclip.session_token=fixture"))
        XCTAssertFalse(cookie.contains("foreign"), "其他域 Cookie 不得进入握手")
        XCTAssertNil(request.value(forHTTPHeaderField: "Authorization"))
        XCTAssertFalse(request.httpShouldHandleCookies)
        // 第二次建连仍要新鲜确认，不复用 30 秒只读缓存。
        _ = try await client.liveSocketRequest(companyID: "company", userID: "human")
        XCTAssertEqual(PaperclipLiveTestProtocol.ledger.filter { $0.hasSuffix("get-session") }.count, 2)
        XCTAssertThrowsError(try PaperclipProfile.component("../x"))
        XCTAssertTrue(PaperclipClient.liveSameOrigin(URL(string: "wss://example.com/api/x")!, client.profile.origin))
        XCTAssertFalse(PaperclipClient.liveSameOrigin(URL(string: "ws://example.com/api/x")!, client.profile.origin))
        XCTAssertFalse(PaperclipClient.liveSameOrigin(URL(string: "wss://evil.example/api/x")!, client.profile.origin))
        XCTAssertFalse(PaperclipClient.liveSameOrigin(URL(string: "wss://example.com:8443/api/x")!, client.profile.origin))
    }

    func testIdentityMismatchStopsChannelBeforeAnySocketOpens() async throws {
        let session = Self.session
        PaperclipLiveTestProtocol.install { _ in (200, session, "application/json") }
        let client = try client()
        var sockets = 0
        let live = PaperclipLiveConnection(profile: client.profile, companyID: "company", userID: "other",
            makeRequest: { try await client.liveSocketRequest(companyID: "company", userID: "other") },
            makeSocket: { _ in sockets += 1; return ScriptedLiveSocket(messages: []) },
            sleep: { _ in })
        live.start()
        await waitUntil { live.isStopped }
        XCTAssertEqual(live.state, .stopped(.identityChanged))
        XCTAssertEqual(sockets, 0, "身份不符不得建立 WebSocket")
        // 已因身份停止的通道不会被再次启动。
        live.start()
        try await Task.sleep(for: .milliseconds(50))
        XCTAssertEqual(sockets, 0)
    }

    // MARK: 事件公司过滤

    func testForeignCompanyEventIsDroppedAndDisconnects() async throws {
        let profile = try PaperclipProfile(name: "测试", address: "https://example.com")
        let own = event(type: "heartbeat.run.progress", payload: ["runId": "run", "issueId": "issue", "currentToolName": "bash"])
        let foreign = event(company: "other", type: "heartbeat.run.progress", payload: ["runId": "run", "issueId": "issue"])
        let after = event(type: "activity.logged", payload: ["entityType": "issue", "entityId": "issue"])
        let socket = ScriptedLiveSocket(messages: [own, "不是 JSON", foreign, after], holdOpen: true)
        let live = PaperclipLiveConnection(profile: profile, companyID: "company", userID: "human",
            makeRequest: { URLRequest(url: URL(string: "wss://example.com/api/companies/company/events/ws")!) },
            makeSocket: { _ in socket }, sleep: { _ in })
        var received: [PaperclipLiveEvent] = []
        let token = live.events.sink { received.append($0) }
        live.start()
        await waitUntil { live.isStopped }
        XCTAssertEqual(live.state, .stopped(.protocolViolation))
        XCTAssertEqual(received.map(\.companyId), ["company"], "其他公司的事件不得送达，之后的事件也不再处理")
        XCTAssertTrue(socket.cancelled)
        token.cancel()
    }

    // MARK: 重连退避状态机

    func testReconnectBacksOffOneTwoFourEightFifteenAndResetsAfterOpen() async throws {
        let profile = try PaperclipProfile(name: "测试", address: "https://example.com")
        var delays: [Double] = []
        var attempt = 0
        var opens = 0
        weak var weakLive: PaperclipLiveConnection?
        let live = PaperclipLiveConnection(profile: profile, companyID: "company", userID: "human",
            makeRequest: {
                attempt += 1
                // 前 6 次网络失败，第 7 次成功建连后立刻断线，再失败一次。
                if attempt <= 6 || attempt == 8 { throw PaperclipError.unavailable }
                return URLRequest(url: URL(string: "wss://example.com/api/companies/company/events/ws")!)
            },
            makeSocket: { _ in ScriptedLiveSocket(messages: []) },
            sleep: { delay in
                delays.append(delay)
                if delays.count >= 8 { weakLive?.stop() }
            })
        weakLive = live
        let token = live.reconnected.sink { opens += 1 }
        live.start()
        await waitUntil { delays.count >= 8 }
        XCTAssertEqual(Array(delays.prefix(6)), [1, 2, 4, 8, 15, 15])
        XCTAssertEqual(opens, 1, "连上后发出全量补拉信号")
        // 连上后失败计数复位：断线后重新从 1 秒开始。
        XCTAssertEqual(delays[6], 1)
        XCTAssertEqual(delays[7], 2)
        XCTAssertEqual(PaperclipLiveBackoff.delay(afterFailures: 99), 15)
        token.cancel()
        live.stop()
        XCTAssertEqual(live.state, .idle)
    }

    func testForbiddenHandshakeReverifiesThenFallsBackToPollingWithoutRetryLoop() async throws {
        let profile = try PaperclipProfile(name: "测试", address: "https://example.com")
        var verifications = 0
        let live = PaperclipLiveConnection(profile: profile, companyID: "company", userID: "human",
            makeRequest: { verifications += 1; return URLRequest(url: URL(string: "wss://example.com/api/companies/company/events/ws")!) },
            makeSocket: { _ in ScriptedLiveSocket(messages: [], openError: URLError(.badServerResponse), handshakeStatus: 403) },
            sleep: { _ in XCTFail("403 不应进入重连退避") })
        live.start()
        await waitUntil { live.isStopped }
        XCTAssertEqual(live.state, .stopped(.unavailable))
        XCTAssertEqual(verifications, 2, "被拒后必须再新鲜确认一次身份")
        // 回前台允许重新尝试。
        live.resumeFromBackground()
        await waitUntil { verifications >= 3 }
        XCTAssertGreaterThanOrEqual(verifications, 3)
        live.stop()
    }

    func testForbiddenHandshakeWithExpiredSessionStopsAsSignedOut() async throws {
        let profile = try PaperclipProfile(name: "测试", address: "https://example.com")
        var verifications = 0
        let live = PaperclipLiveConnection(profile: profile, companyID: "company", userID: "human",
            makeRequest: {
                verifications += 1
                if verifications > 1 { throw PaperclipError.signedOut }
                return URLRequest(url: URL(string: "wss://example.com/api/companies/company/events/ws")!)
            },
            makeSocket: { _ in ScriptedLiveSocket(messages: [], openError: URLError(.badServerResponse), handshakeStatus: 401) },
            sleep: { _ in })
        live.start()
        await waitUntil { live.isStopped }
        XCTAssertEqual(live.state, .stopped(.signedOut))
        live.resumeFromBackground()
        try await Task.sleep(for: .milliseconds(50))
        XCTAssertEqual(verifications, 2, "登录失效后不自动恢复，等待重新登录")
    }

    func testConnectionOnlyMatchesSameProfileCompanyAndUser() throws {
        let profile = try PaperclipProfile(name: "测试", address: "https://example.com")
        let live = PaperclipLiveConnection(profile: profile, companyID: "company", userID: "human",
                                           makeRequest: { throw PaperclipError.unavailable })
        let base = PaperclipTaskReference(profileID: profile.id, origin: profile.origin, companyID: "company", userID: "human", issueID: "i")
        XCTAssertTrue(live.matches(base))
        XCTAssertFalse(live.matches(PaperclipTaskReference(profileID: profile.id, origin: profile.origin, companyID: "other", userID: "human", issueID: "i")))
        XCTAssertFalse(live.matches(PaperclipTaskReference(profileID: profile.id, origin: profile.origin, companyID: "company", userID: "other", issueID: "i")))
        XCTAssertFalse(live.matches(PaperclipTaskReference(profileID: UUID(), origin: profile.origin, companyID: "company", userID: "human", issueID: "i")))
    }

    // MARK: 评论增量

    func testCommentsIncrementalQueryAndMergeKeepOrderWithoutDuplicates() async throws {
        let session = Self.session
        PaperclipLiveTestProtocol.install { request in
            if request.url!.path == "/api/auth/get-session" { return (200, session, "application/json") }
            XCTAssertEqual(request.url!.path, "/api/issues/issue/comments")
            return (200, #"[{"id":"c2","companyId":"company","issueId":"issue","body":"新"}]"#, "application/json")
        }
        let client = try client()
        let rows = try await client.comments(reference(client), after: "c1")
        XCTAssertEqual(PaperclipLiveTestProtocol.ledger.last, "GET /api/issues/issue/comments?after=c1&order=asc")
        _ = try await client.comments(reference(client))
        XCTAssertEqual(PaperclipLiveTestProtocol.ledger.last, "GET /api/issues/issue/comments?order=asc", "首次全量")
        do { _ = try await client.comments(reference(client), after: "c1&x=1"); XCTFail("评论编号不得注入查询") }
        catch { XCTAssertEqual(error as? PaperclipError, .invalidResponse) }

        func comment(_ id: String, _ body: String) throws -> PaperclipComment {
            try JSONDecoder().decode(PaperclipComment.self, from: Data(#"{"id":"\#(id)","companyId":"company","issueId":"issue","body":"\#(body)"}"#.utf8))
        }
        let existing = [try comment("c0", "零"), try comment("c1", "一")]
        let merged = PaperclipCommentMerge.merge(existing, [try comment("c1", "一（已编辑）")] + rows + rows)
        XCTAssertEqual(merged.map(\.id), ["c0", "c1", "c2"])
        XCTAssertEqual(merged[1].body, "一（已编辑）")
        XCTAssertEqual(PaperclipCommentMerge.merge(existing, []).map(\.id), ["c0", "c1"])
    }

    // MARK: 日志解析

    func testRunLogNDJSONIsParsedIntoReadableStreamsWithoutANSIOrRawJSON() {
        var parser = PaperclipRunLogParser()
        let first = #"{"ts":"t","stream":"stdout","chunk":"\u001b[32m正在读取\u001b[0m 文件"}"# + "\n" +
            #"{"ts":"t","stream":"stdout","chunk":"…完成\n第二行\n"}"# + "\n" + #"{"ts":"t","stream":"stderr","chunk":"警告"#
        parser.feedNDJSON(first)
        XCTAssertEqual(parser.lines.map(\.text), ["正在读取 文件…完成", "第二行"], "跨记录的同一行要拼接，半条记录留到下次")
        parser.feedNDJSON(#"：磁盘\n"}"# + "\n" + #"{"ts":"t","stream":"stdout","chunk":"下载 10%\r下载 100%\n"}"# + "\n")
        XCTAssertEqual(parser.lines.map(\.text), ["正在读取 文件…完成", "第二行", "警告：磁盘", "下载 100%"])
        XCTAssertEqual(parser.lines[2].stream, .stderr)
        XCTAssertFalse(parser.text.contains("{\""), "不能显示原始 NDJSON")
        XCTAssertFalse(parser.text.contains("\u{1B}"))

        var tail = PaperclipRunLogParser()
        tail.feedNDJSON(#"ream":"stdout","chunk":"被截断"}"# + "\n" + #"{"ts":"t","stream":"stdout","chunk":"尾部\n"}"# + "\n", startsMidRecord: true)
        XCTAssertEqual(tail.lines.map(\.text), ["尾部"], "从中间开始读取时丢弃首个不完整记录")

        var plain = PaperclipRunLogParser()
        plain.feedNDJSON("旧版纯文本日志\n")
        XCTAssertEqual(plain.lines.map(\.text), ["旧版纯文本日志"])
        XCTAssertEqual(PaperclipRunLogParser.stripANSI("\u{1B}]8;;https://x\u{07}链接\u{1B}]8;;\u{07}\u{1B}[1;31m红\u{1B}[0m"), "链接红")

        var capped = PaperclipRunLogParser()
        capped.maxLines = 3
        capped.appendChunk("1\n2\n3\n4\n5\n", stream: "stdout")
        XCTAssertEqual(capped.lines.map(\.text), ["3", "4", "5"])
    }

    // MARK: live-runs 解码

    func testLiveRunsDecodeAndCompanyRowsMustBelongToCompany() async throws {
        let rows = #"[{"id":"run-1","status":"running","agentId":"agent","agentName":"研究员","avatarUrl":"/api/agent-avatars/cap-v1/arctic-blue/rest.png?size=512&scale=1","logBytes":"2048","lastOutputSeq":3,"currentStatusMessage":"读取仓库","currentToolName":"bash","lastAssistantSnippet":"正在分析","lastEventAt":"2026-10-05T10:00:00.000Z","startedAt":"2026-10-05T09:59:00.000Z","outputSilence":{"level":"ok"}},{"id":"run-0","status":"queued","agentId":"agent","logBytes":null}]"#
        let decoded = try JSONDecoder().decode([PaperclipLiveRun].self, from: Data(rows.utf8))
        XCTAssertEqual(decoded.map(\.id), ["run-1", "run-0"])
        XCTAssertEqual(decoded[0].logBytes, 2048)
        XCTAssertEqual(decoded[0].progress.currentToolName, "bash")
        XCTAssertEqual(decoded[0].progress.message, "读取仓库")
        XCTAssertTrue(decoded[1].isActive)
        XCTAssertNil(decoded[1].logBytes)

        let session = Self.session, issue = Self.issue
        let company = #"[{"id":"r","companyId":"company","status":"running","agentId":"a","issueId":"issue"},{"id":"r2","companyId":"company","status":"succeeded","agentId":"a","issueId":"done"}]"#
        PaperclipLiveTestProtocol.install { request in
            switch request.url!.path {
            case "/api/auth/get-session": return (200, session, "application/json")
            case "/api/companies/company/live-runs": return (200, company, "application/json")
            case "/api/companies/other/live-runs": return (200, company, "application/json")
            case "/api/issues/issue": return (200, issue, "application/json")
            case "/api/issues/issue/live-runs": return (200, rows, "application/json")
            default: return (404, "{}", "application/json")
            }
        }
        let client = try client()
        let live = try await client.companyLiveRuns(companyID: "company", userID: "human")
        XCTAssertEqual(live.compactMap(\.issueId), ["issue"], "只保留排队/运行中的 run")
        do { _ = try await client.companyLiveRuns(companyID: "other", userID: "human"); XCTFail("其他公司的运行不得混入") }
        catch { XCTAssertEqual(error as? PaperclipError, .identityChanged) }
        let issueRuns = try await client.liveRuns(reference(client))
        XCTAssertEqual(issueRuns.count, 2)
        XCTAssertTrue(PaperclipLiveTestProtocol.ledger.contains("GET /api/issues/issue"), "任务级 live-runs 先确认任务归属")
    }

    func testRunLogOwnershipIsVerifiedOnceThenCached() async throws {
        let session = Self.session, issue = Self.issue
        PaperclipLiveTestProtocol.install { request in
            switch request.url!.path {
            case "/api/auth/get-session": return (200, session, "application/json")
            case "/api/issues/issue": return (200, issue, "application/json")
            case "/api/issues/issue/runs": return (200, #"[{"runId":"run-1","status":"running","agentId":"a"}]"#, "application/json")
            case "/api/issues/issue/live-runs": return (200, "[]", "application/json")
            case "/api/heartbeat-runs/run-1/log": return (200, #"{"runId":"run-1","content":""}"#, "application/json")
            case "/api/heartbeat-runs/foreign/log": XCTFail("未确认归属的运行不得读取日志"); return (500, "{}", "application/json")
            default: return (404, "{}", "application/json")
            }
        }
        let client = try client()
        let ref = reference(client)
        for offset in [0, 100, 200] { _ = try await client.runLog(ref, runID: "run-1", offset: offset) }
        let ledger = PaperclipLiveTestProtocol.ledger
        XCTAssertEqual(ledger.filter { $0 == "GET /api/issues/issue" }.count, 1)
        XCTAssertEqual(ledger.filter { $0 == "GET /api/issues/issue/runs" }.count, 1)
        XCTAssertEqual(ledger.filter { $0.hasPrefix("GET /api/heartbeat-runs/run-1/log") }.count, 3)
        do { _ = try await client.runLog(ref, runID: "foreign"); XCTFail("其他任务的运行不得读取") }
        catch { XCTAssertEqual(error as? PaperclipError, .identityChanged) }
    }

    // MARK: 运行模型

    func testRunStreamAppliesIssueEventsAndRequestsFollowups() throws {
        let client = try client()
        let stream = PaperclipRunStream(client: client, reference: reference(client))
        let running = try JSONDecoder().decode([PaperclipLiveRun].self, from: Data(#"[{"id":"run","status":"running","agentId":"a","currentToolName":"read","lastEventAt":"2026-10-05T10:00:00.000Z"}]"#.utf8))
        stream.apply(running)
        func live(_ type: String, _ payload: [String: Any], company: String = "company") -> PaperclipLiveEvent {
            PaperclipLiveEvent.decode(event(company: company, type: type, payload: payload))!
        }
        XCTAssertEqual(stream.handle(live("heartbeat.run.progress", ["runId": "run", "issueId": "issue", "phase": "run_activity",
            "message": "执行命令", "currentToolName": "bash", "lastAssistantSnippet": "正在编译", "lastEventAt": "2026-10-05T10:00:05.000Z"])), [])
        XCTAssertEqual(stream.progress["run"]?.currentToolName, "bash")
        XCTAssertEqual(stream.progress["run"]?.lastAssistantSnippet, "正在编译")
        // 较旧的接口快照不能覆盖更新的事件进度。
        stream.apply(running)
        XCTAssertEqual(stream.progress["run"]?.currentToolName, "bash")
        // 其他任务的事件不影响本页。
        XCTAssertEqual(stream.handle(live("heartbeat.run.progress", ["runId": "x", "issueId": "other", "currentToolName": "rm"])), [])
        XCTAssertNil(stream.progress["x"])
        XCTAssertEqual(stream.handle(live("heartbeat.run.progress", ["runId": "new", "issueId": "issue"])), [.runs], "新运行需要补拉 live-runs")
        XCTAssertEqual(stream.handle(live("heartbeat.run.status", ["runId": "run", "issueId": "issue", "status": "succeeded"])), [.runs, .issue])
        XCTAssertEqual(stream.handle(live("activity.logged", ["entityType": "issue", "entityId": "issue", "action": "issue.comment_added"])), [.comments, .issue])
        XCTAssertEqual(stream.handle(live("activity.logged", ["entityType": "issue", "entityId": "issue", "action": "issue.comment_deleted"])), [.fullComments, .issue])
        XCTAssertEqual(stream.handle(live("activity.logged", ["entityType": "issue", "entityId": "other", "action": "issue.comment_added"])), [])
        XCTAssertEqual(stream.handle(live("activity.logged", ["entityType": "approval", "entityId": "ap", "action": "approval.approved"])), [.approvals])
    }

    // MARK: 线程与头像

    func testThreadGroupsConsecutiveAuthorsAndInterleavesFinishedRuns() throws {
        func comment(_ id: String, agent: Bool, at time: String) throws -> PaperclipComment {
            let author = agent ? #""authorAgentId":"a""# : #""authorUserId":"human""#
            return try JSONDecoder().decode(PaperclipComment.self, from: Data(#"{"id":"\#(id)","companyId":"c","issueId":"i","body":"x",\#(author),"createdAt":"\#(time)"}"#.utf8))
        }
        let comments = [try comment("1", agent: false, at: "2026-10-05T10:00:00Z"), try comment("2", agent: true, at: "2026-10-05T10:01:00Z"),
                        try comment("3", agent: true, at: "2026-10-05T10:02:00Z"), try comment("4", agent: true, at: "2026-10-05T11:00:00Z")]
        let runs = try JSONDecoder().decode([PaperclipRun].self, from: Data(#"[{"runId":"done","status":"succeeded","agentId":"a","startedAt":"2026-10-05T10:00:30Z","finishedAt":"2026-10-05T10:00:45Z"},{"runId":"live","status":"running","agentId":"a","startedAt":"2026-10-05T10:59:00Z"}]"#.utf8))
        let entries = PaperclipThread.entries(comments: comments, runs: runs, activeRunIDs: ["live"])
        XCTAssertEqual(entries.map(\.id), ["comment-1", "run-done", "comment-2", "comment-3", "comment-4"], "运行中的 run 不进入历史摘要")
        guard case .comment(_, let header2, let footer2) = entries[2], case .comment(_, let header3, let footer3) = entries[3],
              case .comment(_, let header4, _) = entries[4] else { return XCTFail("条目类型不对") }
        XCTAssertTrue(header2)
        XCTAssertFalse(footer2, "同组非最后一条不重复时间")
        XCTAssertFalse(header3, "同一作者 10 分钟内的连续消息合并头像与名字")
        XCTAssertTrue(footer3)
        XCTAssertTrue(header4, "间隔超过 10 分钟重新显示作者")

        let origin = try PaperclipProfile(name: "测试", address: "https://example.com").origin
        XCTAssertEqual(PaperclipAvatarPath.normalized("/api/agent-avatars/cap-v1/arctic-blue/rest.png?size=512&scale=1", origin: origin),
                       "/api/agent-avatars/cap-v1/arctic-blue/rest.png?size=96&scale=1")
        XCTAssertEqual(PaperclipAvatarPath.normalized("https://example.com/api/agent-avatars/cap-v1/a/rest.png", origin: origin),
                       "/api/agent-avatars/cap-v1/a/rest.png?size=96&scale=1")
        for bad in ["https://evil.example/api/agent-avatars/cap-v1/a/rest.png", "/api/issues/x.png", "/api/agent-avatars/../auth.png", "", nil] as [String?] {
            XCTAssertNil(PaperclipAvatarPath.normalized(bad, origin: origin), bad ?? "nil")
        }
        XCTAssertEqual(PaperclipDates.duration(133), "2 分 13 秒")
        XCTAssertEqual(PaperclipDates.clock(65), "1:05")
        XCTAssertEqual(PaperclipLabels.runError("adapter_failed"), "智能体执行器出错")
        XCTAssertEqual(PaperclipLabels.runError("future_code"), "运行异常结束")
        XCTAssertNil(PaperclipLabels.runError(nil))
    }

    // MARK: 审计回归（1.53.4）

    /// 生产 URLSessionWebSocketTask：手写的 Cookie/Origin 头真的随握手发出、服务器 ping 自动回 pong、
    /// cancel 能结束挂起的 receive、握手被拒时能拿到状态码。用本机 Network 框架的 WebSocket 服务器验证
    /// （ws://127.0.0.1；生产只允许 wss，TLS 握手本身不在此覆盖）。
    func testURLSessionSocketSendsManualCookieAndOriginAnswersPingAndEndsReceiveOnCancel() async throws {
        let server = try LoopbackWebSocketServer()
        defer { server.stop() }
        var request = URLRequest(url: URL(string: "ws://127.0.0.1:\(try await server.port())/api/companies/company/events/ws")!)
        request.httpShouldHandleCookies = false
        request.setValue("https://example.com", forHTTPHeaderField: "Origin")
        request.setValue("paperclip.session_token=fixture", forHTTPHeaderField: "Cookie")
        let socket = PaperclipURLSessionLiveSocket(request: request)
        socket.resume()
        try await socket.waitUntilOpen()
        XCTAssertEqual(socket.handshakeStatus, 101)
        let headers = server.headers
        XCTAssertEqual(headers["cookie"], "paperclip.session_token=fixture", "iOS 不能剥离手写的 Cookie 头，否则服务器只会 403")
        XCTAssertEqual(headers["origin"], "https://example.com")
        XCTAssertNil(headers["authorization"])
        server.sendPingThenText(#"{"companyId":"company","type":"activity.logged","payload":{}}"#)
        let text = try await socket.receiveText()
        XCTAssertTrue(text.contains("activity.logged"))
        let ponged = await server.waitForPong()
        XCTAssertTrue(ponged, "服务器每 30 秒 ping，客户端必须自动回 pong，否则会被判定断线")
        let pending = Task { @MainActor in try await socket.receiveText() }
        try await Task.sleep(for: .milliseconds(100))
        socket.cancel()
        do { _ = try await pending.value; XCTFail("cancel 后挂起的 receive 必须结束") } catch {}

        let refusing = try LoopbackRefusingServer()
        defer { refusing.stop() }
        let denied = PaperclipURLSessionLiveSocket(request: URLRequest(url: URL(string: "ws://127.0.0.1:\(try await refusing.port())/x")!))
        denied.resume()
        do { try await denied.waitUntilOpen(); XCTFail("握手被拒必须报错") } catch {}
        XCTAssertEqual(denied.handshakeStatus, 403, "握手被拒时必须拿到状态码，才能区分 401/403 与网络错误")
        denied.cancel()
    }

    /// 回归：401/403 复核身份期间 stop() 并重新 start()，旧循环醒来不能断开新连接、改写状态或清掉新循环。
    func testStopDuringForbiddenReverifyDoesNotClobberNewLoop() async throws {
        let profile = try PaperclipProfile(name: "测试", address: "https://example.com")
        var calls = 0
        var gate: CheckedContinuation<Void, Never>?
        var sockets: [ScriptedLiveSocket] = []
        let url = URL(string: "wss://example.com/api/companies/company/events/ws")!
        let live = PaperclipLiveConnection(profile: profile, companyID: "company", userID: "human",
            makeRequest: {
                calls += 1
                if calls == 2 { await withCheckedContinuation { gate = $0 } } // 第一次 403 后的复核挂起
                return URLRequest(url: url)
            },
            makeSocket: { _ in
                let socket = sockets.isEmpty
                    ? ScriptedLiveSocket(messages: [], openError: URLError(.badServerResponse), handshakeStatus: 403)
                    : ScriptedLiveSocket(messages: [], holdOpen: true)
                sockets.append(socket)
                return socket
            },
            sleep: { _ in })
        live.start()
        await waitUntil { gate != nil }
        live.stop()
        live.start()
        await waitUntil { live.isOpen }
        XCTAssertTrue(live.isOpen)
        gate?.resume(); gate = nil
        try await Task.sleep(for: .milliseconds(100))
        XCTAssertEqual(live.state, .open, "旧循环不得把新连接改写为 stopped")
        XCTAssertEqual(sockets.count, 2)
        XCTAssertFalse(sockets[1].cancelled, "旧循环不得断开新连接")
        live.start()
        try await Task.sleep(for: .milliseconds(50))
        XCTAssertEqual(sockets.count, 2, "不能出现第二条并行循环")
        live.stop()
    }

    /// 连上满一个复核周期后主动重连并新鲜确认身份；身份变化即停止，不再重连。
    func testIdentityRefreshReconnectsWithFreshVerificationAndStopsWhenIdentityChanged() async throws {
        let profile = try PaperclipProfile(name: "测试", address: "https://example.com")
        var verifications = 0
        var sockets: [ScriptedLiveSocket] = []
        var opens = 0
        let live = PaperclipLiveConnection(profile: profile, companyID: "company", userID: "human",
            makeRequest: {
                verifications += 1
                if verifications >= 3 { throw PaperclipError.identityChanged }
                return URLRequest(url: URL(string: "wss://example.com/api/companies/company/events/ws")!)
            },
            makeSocket: { _ in let socket = ScriptedLiveSocket(messages: [], holdOpen: true); sockets.append(socket); return socket },
            sleep: { _ in XCTFail("身份复核重连不走退避") },
            identityRefreshInterval: 0.1)
        let token = live.reconnected.sink { opens += 1 }
        live.start()
        await waitUntil({ live.isStopped }, timeout: 5)
        XCTAssertEqual(live.state, .stopped(.identityChanged))
        XCTAssertEqual(verifications, 3, "每个复核周期都重新新鲜确认身份")
        XCTAssertEqual(opens, 2)
        XCTAssertTrue(sockets.allSatisfy(\.cancelled), "复核时旧连接必须断开")
        token.cancel()
    }

    // MARK: 日志实时与 REST 合并

    private static let runRows = #"[{"id":"run-1","status":"running","agentId":"a","logBytes":10}]"#
    private func logRecord(_ seq: Int, _ text: String) -> String {
        #"{"ts":"t","stream":"stdout","chunk":"\#(text)\n","seq":\#(seq)}"# + "\n"
    }
    private func logEvent(_ seq: Int, _ text: String) -> PaperclipLiveEvent {
        PaperclipLiveEvent.decode(event(type: "heartbeat.run.log", payload: ["runId": "run-1", "issueId": "issue", "seq": seq, "stream": "stdout", "chunk": text + "\n"]))!
    }
    private func installLogServer(_ content: @escaping @Sendable (Int) -> (Int, String)) {
        let session = Self.session, issue = Self.issue, runs = Self.runRows
        PaperclipLiveTestProtocol.install { request in
            switch request.url!.path {
            case "/api/auth/get-session": return (200, session, "application/json")
            case "/api/issues/issue": return (200, issue, "application/json")
            case "/api/issues/issue/runs": return (200, #"[{"runId":"run-1","status":"running","agentId":"a"}]"#, "application/json")
            case "/api/issues/issue/live-runs": return (200, runs, "application/json")
            case "/api/heartbeat-runs/run-1/log":
                let offset = Int(URLComponents(url: request.url!, resolvingAgainstBaseURL: false)!.queryItems!.first { $0.name == "offset" }!.value!)!
                let (status, body) = content(offset)
                if status != 200 { return (status, #"{"error":"Run log not found"}"#, "application/json") }
                let json = String(decoding: try JSONSerialization.data(withJSONObject: ["runId": "run-1", "content": body]), as: UTF8.self)
                return (200, json, "application/json")
            default: return (404, "{}", "application/json")
            }
        }
    }

    /// 回归：REST 已包含的实时片段（seq 不大于已读序号）不重复显示；读取进行中到达、REST 未包含的片段不丢失。
    func testLiveLogDedupesBySeqAndReplaysChunksTheRestReadMissed() async throws {
        let first = logRecord(1, "一") + logRecord(2, "二")
        let firstBytes = first.utf8.count
        let third = logRecord(3, "三")
        installLogServer { offset in offset == 0 ? (200, first) : (200, third) }
        let client = try client()
        let stream = PaperclipRunStream(client: client, reference: reference(client))
        try await stream.reloadLiveRuns()
        await stream.loadLog(runID: "run-1")
        XCTAssertEqual(stream.logs["run-1"]?.parser.lines.map(\.text), ["一", "二"])
        XCTAssertEqual(stream.logs["run-1"]?.restOffset, firstBytes)
        stream.handle(logEvent(2, "二"))
        XCTAssertEqual(stream.logs["run-1"]?.parser.lines.map(\.text), ["一", "二"], "REST 已含的片段不得重复")
        stream.handle(logEvent(3, "三"))
        XCTAssertEqual(stream.logs["run-1"]?.parser.lines.map(\.text), ["一", "二", "三"])
        // 补齐读取进行中又到达 seq 4；服务器这次读取只含到 seq 3。
        let release = PaperclipLiveTestProtocol.hold("/api/heartbeat-runs/run-1/log")
        let load = Task { @MainActor in await stream.loadLog(runID: "run-1") }
        await waitUntil { stream.logs["run-1"]?.loading == true }
        stream.handle(logEvent(4, "四"))
        release.signal()
        await load.value
        XCTAssertEqual(stream.logs["run-1"]?.parser.lines.map(\.text), ["一", "二", "三", "四"], "读取期间到达且 REST 未含的片段不得丢失，也不得重复")
        XCTAssertEqual(stream.logs["run-1"]?.lastSeq, 4)
        stream.handle(logEvent(5, "五"))
        XCTAssertEqual(stream.logs["run-1"]?.parser.lines.last?.text, "五", "补齐后序号连续，继续直接追加")
    }

    /// 日志接口 404（尚未输出或已清理）降级为“暂无日志”，不显示状态码错误，并开始接收实时片段。
    func testRunLogNotFoundDegradesToEmptyAndStillAcceptsLiveChunks() async throws {
        installLogServer { _ in (404, "") }
        let client = try client()
        let stream = PaperclipRunStream(client: client, reference: reference(client))
        try await stream.reloadLiveRuns()
        await stream.loadLog(runID: "run-1")
        let state = try XCTUnwrap(stream.logs["run-1"])
        XCTAssertNil(state.error)
        XCTAssertTrue(state.missing)
        XCTAssertEqual(state.restOffset, 0)
        stream.handle(logEvent(1, "开始"))
        XCTAssertEqual(stream.logs["run-1"]?.parser.lines.map(\.text), ["开始"])
    }

    /// 回归：身份失效 reset() 之后，迟到的日志结果不能把旧账号数据写回。
    func testResetDuringLogLoadDropsLateResult() async throws {
        installLogServer { _ in (200, "") }
        let client = try client()
        let stream = PaperclipRunStream(client: client, reference: reference(client))
        try await stream.reloadLiveRuns()
        installLogServer { _ in (200, #"{"ts":"t","stream":"stdout","chunk":"旧数据\n","seq":1}"# + "\n") }
        let release = PaperclipLiveTestProtocol.hold("/api/heartbeat-runs/run-1/log")
        let load = Task { @MainActor in await stream.loadLog(runID: "run-1") }
        await waitUntil { stream.logs["run-1"]?.loading == true }
        stream.reset()
        release.signal()
        await load.value
        XCTAssertNil(stream.logs["run-1"], "reset 后不得回写日志")
        XCTAssertTrue(stream.liveRuns.isEmpty)
    }
}

/// 与服务器 rejectUpgrade 相同：读到升级请求后直接回 HTTP 403 并关闭。
private final class LoopbackRefusingServer: @unchecked Sendable {
    private let listener: NWListener
    init() throws {
        let queue = DispatchQueue(label: "paperclip.loopback.refuse")
        listener = try NWListener(using: .tcp, on: .any)
        listener.newConnectionHandler = { connection in
            connection.start(queue: queue)
            connection.receive(minimumIncompleteLength: 1, maximumLength: 65_536) { _, _, _, _ in
                let response = "HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Type: text/plain\r\n\r\nforbidden"
                connection.send(content: Data(response.utf8), completion: .contentProcessed { _ in connection.cancel() })
            }
        }
        listener.start(queue: queue)
    }
    func port() async throws -> UInt16 {
        for _ in 0..<200 {
            if listener.state == .ready, let port = listener.port, port.rawValue != 0 { return port.rawValue }
            try await Task.sleep(for: .milliseconds(10))
        }
        throw URLError(.cannotConnectToHost)
    }
    func stop() { listener.cancel() }
}

/// 本机回环 WebSocket 服务器（Network 框架）：记录握手头，可发 ping 并等待 pong。
private final class LoopbackWebSocketServer: @unchecked Sendable {
    private final class State: @unchecked Sendable {
        let lock = NSLock()
        var headers: [String: String] = [:]
        var connection: NWConnection?
        var ponged = false
    }
    private let listener: NWListener
    private let queue = DispatchQueue(label: "paperclip.loopback.ws")
    private let state: State

    init() throws {
        let state = State()
        let queue = queue
        let options = NWProtocolWebSocket.Options()
        options.autoReplyPing = true
        options.setClientRequestHandler(queue) { _, headers in
            state.lock.withLock { for header in headers { state.headers[header.name.lowercased()] = header.value } }
            return NWProtocolWebSocket.Response(status: .accept, subprotocol: nil)
        }
        let parameters = NWParameters.tcp
        parameters.defaultProtocolStack.applicationProtocols.insert(options, at: 0)
        let listener = try NWListener(using: parameters, on: .any)
        listener.newConnectionHandler = { connection in
            state.lock.withLock { state.connection = connection }
            connection.start(queue: queue)
            // 与 ws 库一样持续读取：控制帧（pong）只有在读取时才会被处理。
            func receive() {
                connection.receiveMessage { _, _, _, error in if error == nil { receive() } }
            }
            receive()
        }
        listener.start(queue: queue)
        self.listener = listener
        self.state = state
    }

    func port() async throws -> UInt16 {
        for _ in 0..<200 {
            if listener.state == .ready, let port = listener.port, port.rawValue != 0 { return port.rawValue }
            try await Task.sleep(for: .milliseconds(10))
        }
        throw URLError(.cannotConnectToHost)
    }

    var headers: [String: String] { state.lock.withLock { state.headers } }

    func sendPingThenText(_ text: String) {
        let state = state, queue = queue
        queue.async {
            guard let connection = state.lock.withLock({ state.connection }) else { return }
            let ping = NWProtocolWebSocket.Metadata(opcode: .ping)
            ping.setPongHandler(queue) { error in
                if error == nil { state.lock.withLock { state.ponged = true } }
            }
            connection.send(content: Data(), contentContext: NWConnection.ContentContext(identifier: "ping", metadata: [ping]),
                            isComplete: true, completion: .idempotent)
            let message = NWProtocolWebSocket.Metadata(opcode: .text)
            connection.send(content: Data(text.utf8), contentContext: NWConnection.ContentContext(identifier: "text", metadata: [message]),
                            isComplete: true, completion: .idempotent)
        }
    }

    func waitForPong() async -> Bool {
        for _ in 0..<300 {
            if state.lock.withLock({ state.ponged }) { return true }
            try? await Task.sleep(for: .milliseconds(10))
        }
        return false
    }

    func stop() {
        state.lock.withLock { state.connection?.cancel() }
        listener.cancel()
    }
}
