import Foundation
import XCTest

/// 详情页模型的并发与刷新回归（模型位于 Views/Paperclip，只在独立宿主编译）。
private final class DetailTestProtocol: URLProtocol, @unchecked Sendable {
    static let lock = NSLock()
    nonisolated(unsafe) static var routes: [String: String] = [:]
    nonisolated(unsafe) static var requests: [String] = []
    nonisolated(unsafe) static var gate: (path: String, semaphore: DispatchSemaphore)?
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let path = request.url?.path ?? ""
        Self.lock.lock()
        Self.requests.append(path + (request.url?.query.map { "?" + $0 } ?? ""))
        let body = Self.routes[path]
        let gate = Self.gate?.path == path ? Self.gate : nil
        if gate != nil { Self.gate = nil }
        Self.lock.unlock()
        gate?.semaphore.wait()
        let response = HTTPURLResponse(url: request.url!, statusCode: body == nil ? 404 : 200, httpVersion: nil,
                                       headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data((body ?? "{}").utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
    static func set(_ path: String, _ body: String) { lock.withLock { routes[path] = body } }
    static func hold(_ path: String) -> DispatchSemaphore {
        let semaphore = DispatchSemaphore(value: 0)
        lock.withLock { gate = (path, semaphore) }
        return semaphore
    }
    static var ledger: [String] { lock.withLock { requests } }
    static func reset() { lock.withLock { requests = []; gate = nil } }
}

@MainActor
final class PaperclipDetailModelTests: XCTestCase {
    private func comment(_ id: String) -> String {
        #"{"id":"\#(id)","companyId":"company","issueId":"issue","body":"\#(id)","authorUserId":"human","createdAt":"2026-10-05T10:00:00Z"}"#
    }

    private func makeModel(runsActive: Bool = false) throws -> PaperclipIssueDetailModel {
        DetailTestProtocol.reset()
        DetailTestProtocol.routes = [
            "/api/auth/get-session": #"{"session":{"id":"s","userId":"human"},"user":{"id":"human"}}"#,
            "/api/issues/issue": #"{"id":"issue","companyId":"company","title":"任务","status":"in_progress","priority":"medium"}"#,
            "/api/issues/issue/comments": "[" + comment("c1") + "]",
            "/api/issues/issue/runs": "[]",
            "/api/issues/issue/approvals": "[]",
            "/api/issues/issue/live-runs": runsActive ? #"[{"id":"run","status":"running","agentId":"a"}]"# : "[]"
        ]
        let profile = try PaperclipProfile(name: "测试", address: "https://example.com")
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [DetailTestProtocol.self]
        let cookie = HTTPCookie(properties: [.domain: "example.com", .path: "/", .name: "s", .value: "v", .secure: "TRUE"])!
        let client = PaperclipClient(profile: profile, configuration: config, readCookies: { [cookie] })
        let reference = PaperclipTaskReference(profileID: profile.id, origin: profile.origin, companyID: "company", userID: "human", issueID: "issue")
        return PaperclipIssueDetailModel(client: client, reference: reference)
    }

    private func waitUntil(_ condition: @escaping @MainActor () -> Bool, timeout: TimeInterval = 3) async {
        let deadline = Date().addingTimeInterval(timeout)
        while !condition() && Date() < deadline { try? await Task.sleep(for: .milliseconds(10)) }
    }

    /// 回归：同步进行中发出的回复不能被较早开始的全量结果冲掉；发送后的刷新排队执行而不是被丢弃。
    func testFullRefreshKeepsJustSentCommentAndQueuedRefreshRuns() async throws {
        let model = try makeModel()
        let release = DetailTestProtocol.hold("/api/issues/issue/comments")
        let full = Task { @MainActor in await model.refresh(full: true) }
        await waitUntil { DetailTestProtocol.ledger.contains("/api/issues/issue/comments?order=asc") }
        let sent = try JSONDecoder().decode(PaperclipComment.self, from: Data(comment("c2").utf8))
        model.appendSent(sent)
        await model.refresh()   // 撞上进行中的同步：排队，不丢弃
        release.signal()
        await full.value
        XCTAssertEqual(model.comments.map(\.id), ["c1", "c2"], "刚发出的回复不得因旧的全量结果消失")
        XCTAssertTrue(DetailTestProtocol.ledger.contains("/api/issues/issue/comments?after=c2&order=asc"), "排队的刷新必须执行")
        // 之后的全量结果里没有、且早于读取开始插入的评论视为已删除。
        DetailTestProtocol.set("/api/issues/issue/comments", "[" + comment("c1") + "]")
        await model.refresh(full: true)
        XCTAssertEqual(model.comments.map(\.id), ["c1"])
    }

    /// 回归：身份失效清空页面后，进行中请求迟到的结果不能把旧账号数据写回。
    func testLateResultsAfterIdentityLossAreDropped() async throws {
        let model = try makeModel()
        let release = DetailTestProtocol.hold("/api/issues/issue/comments")
        let refresh = Task { @MainActor in await model.refresh(full: true) }
        await waitUntil { DetailTestProtocol.ledger.contains("/api/issues/issue/comments?order=asc") }
        model.record(PaperclipError.signedOut)
        release.signal()
        await refresh.value
        XCTAssertNil(model.issue)
        XCTAssertTrue(model.comments.isEmpty)
        XCTAssertNotNil(model.error)
    }

    /// 无实时通道且运行中：两次全量之间只读评论增量与运行中 run，不再每 3 秒请求任务、运行历史与审批。
    func testActiveRunPollingWithoutLiveUsesLightRequestsBetweenFullSyncs() async throws {
        let model = try makeModel(runsActive: true)
        await model.poll()
        XCTAssertTrue(model.runStream.hasActiveRun)
        DetailTestProtocol.reset()
        await model.poll()
        let light = DetailTestProtocol.ledger.filter { !$0.hasSuffix("get-session") }
        XCTAssertEqual(Set(light), ["/api/issues/issue/comments?after=c1&order=asc", "/api/issues/issue/live-runs"])
        DetailTestProtocol.reset()
        await model.poll(now: Date().addingTimeInterval(PaperclipPollingPolicy.baseInterval + 1))
        XCTAssertTrue(DetailTestProtocol.ledger.contains("/api/issues/issue/approvals"), "每 15 秒仍做一次全量")
    }

    func testThreadEntriesAreCachedUntilCommentsChange() throws {
        let model = try makeModel()
        model.comments = [try JSONDecoder().decode(PaperclipComment.self, from: Data(comment("c1").utf8))]
        XCTAssertEqual(model.threadEntries(activeRunIDs: []).map(\.id), ["comment-c1"])
        model.comments.append(try JSONDecoder().decode(PaperclipComment.self, from: Data(comment("c2").utf8)))
        XCTAssertEqual(model.threadEntries(activeRunIDs: []).map(\.id), ["comment-c1", "comment-c2"], "评论变化后缓存必须失效")
    }

    /// 键盘与输入栏占据的底部内边距要从可见区扣除，否则往上翻阅时也会被当作“停在底部”而被强制跳到底。
    func testNearBottomAccountsForComposerAndKeyboardInset() {
        XCTAssertTrue(PaperclipScrollPosition.isNearBottom(offsetY: 1_000, containerHeight: 800, bottomInset: 100, contentHeight: 1_700))
        XCTAssertFalse(PaperclipScrollPosition.isNearBottom(offsetY: 600, containerHeight: 800, bottomInset: 400, contentHeight: 1_700),
                       "键盘弹出（底部内边距 400）时上翻约 500 点不算在底部")
        XCTAssertTrue(PaperclipScrollPosition.isNearBottom(offsetY: 0, containerHeight: 800, bottomInset: 100, contentHeight: 300))
    }
}
