import Foundation
import XCTest

/// 工作区列表与实时事件的回归（PaperclipWorkspaceStore 依赖 WebKit 容器，只在独立宿主编译）。
private final class WorkspaceTestProtocol: URLProtocol, @unchecked Sendable {
    static let lock = NSLock()
    nonisolated(unsafe) static var requests: [String] = []
    static let routes: [String: String] = [
        "/api/health": #"{"status":"ok","deploymentMode":"authenticated","authReady":true}"#,
        "/api/auth/get-session": #"{"session":{"id":"s","userId":"human"},"user":{"id":"human"}}"#,
        "/api/companies": #"[{"id":"company","name":"公司"}]"#,
        "/api/companies/company/issues": "[]",
        "/api/companies/company/agents": "[]",
        "/api/companies/company/live-runs": "[]"
    ]
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let path = request.url?.path ?? ""
        Self.lock.withLock { Self.requests.append(path) }
        let body = Self.routes[path]
        let response = HTTPURLResponse(url: request.url!, statusCode: body == nil ? 404 : 200, httpVersion: nil,
                                       headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data((body ?? "{}").utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
    static var ledger: [String] { lock.withLock { requests } }
}

@MainActor
private final class HeldLiveSocket: PaperclipLiveSocket {
    var handshakeStatus: Int? { 101 }
    var responseURL: URL? { nil }
    private var waiter: CheckedContinuation<String, Error>?
    func resume() {}
    func waitUntilOpen() async throws {}
    func receiveText() async throws -> String { try await withCheckedThrowingContinuation { waiter = $0 } }
    func deliver(_ text: String) { waiter?.resume(returning: text); waiter = nil }
    func cancel() { waiter?.resume(throwing: URLError(.cancelled)); waiter = nil }
}

@MainActor
private final class WorkspaceCookieStorage: PaperclipCookieStorage {
    func allCookies() async -> [HTTPCookie] {
        [HTTPCookie(properties: [.domain: "example.com", .path: "/", .name: "paperclip.session_token", .value: "fixture", .secure: "TRUE"])!]
    }
    func setCookie(_ cookie: HTTPCookie) async {}
    func removeAllData() async {}
}

/// 记录工作区交给系统界面（灵动岛、通知、Spotlight、后台时间）的调用。
@MainActor
private final class RecordingSurfaces: PaperclipSystemSurfaces {
    var changes: [PaperclipRunWatch.Change] = []
    var contexts: [PaperclipRunContext] = []
    var indexed: [[String]] = []
    var cleared: [UUID] = []
    var holds = 0
    var releases = 0
    func runChanged(_ change: PaperclipRunWatch.Change, context: PaperclipRunContext) { changes.append(change); contexts.append(context) }
    func activeRuns(profileID: UUID, companyID: String) -> [PaperclipRunWatch.Run] { [] }
    func index(_ issues: [PaperclipIssue], profileID: UUID) { indexed.append(issues.map(\.id)) }
    func clear(profileID: UUID) { cleared.append(profileID) }
    func holdBackground(onExpire: @escaping @MainActor () -> Void) { holds += 1 }
    func releaseBackground() { releases += 1 }
}

@MainActor
final class PaperclipWorkspaceLiveTests: XCTestCase {
    private func waitUntil(_ condition: @escaping @MainActor () -> Bool, timeout: TimeInterval = 4) async {
        let deadline = Date().addingTimeInterval(timeout)
        while !condition() && Date() < deadline { try? await Task.sleep(for: .milliseconds(10)) }
    }

    /// 列表不可见（详情页打开）时，事件不触发三请求的列表刷新；回到列表时补做一次。
    func testListRefreshFromEventsWaitsUntilListIsVisible() async throws {
        let suite = "paperclip.workspace.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let socket = HeldLiveSocket()
        let store = PaperclipWorkspaceStore(defaults: defaults,
            makeCookieVault: { _ in PaperclipCookieVault(storage: WorkspaceCookieStorage()) },
            makeConfiguration: {
                let config = URLSessionConfiguration.ephemeral
                config.protocolClasses = [WorkspaceTestProtocol.self]
                return config
            },
            makeLiveSocket: { _ in socket })
        try store.add(name: "测试", address: "https://example.com")
        let connected = await store.connect()
        XCTAssertTrue(connected)
        await waitUntil { store.liveState == .open }
        XCTAssertEqual(store.liveState, .open)
        func issueReads() -> Int { WorkspaceTestProtocol.ledger.filter { $0 == "/api/companies/company/issues" }.count }
        let before = issueReads()
        store.setListVisible(false)
        socket.deliver(#"{"companyId":"company","type":"activity.logged","payload":{"entityType":"issue","entityId":"issue","action":"issue.updated"}}"#)
        try await Task.sleep(for: .milliseconds(1_600))
        XCTAssertEqual(issueReads(), before, "列表不可见时事件不触发列表刷新")
        store.setListVisible(true)
        await waitUntil { issueReads() > before }
        XCTAssertEqual(issueReads(), before + 1, "回到列表补做一次刷新")
        await store.setForeground(false)
    }

    /// [G2/G5] 只有关注的工单（本机创建或正在查看）的运行进入灵动岛与完成通知；同一运行的终态只报告一次；
    /// 关注的运行仍在进行时进入后台会申请后台时间保持通道，结束后释放；退出登录清空 Spotlight 与活动。
    func testWatchedIssueRunsReachSystemSurfacesOnce() async throws {
        let suite = "paperclip.workspace.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let socket = HeldLiveSocket()
        let surfaces = RecordingSurfaces()
        let store = PaperclipWorkspaceStore(defaults: defaults,
            makeCookieVault: { _ in PaperclipCookieVault(storage: WorkspaceCookieStorage()) },
            makeConfiguration: {
                let config = URLSessionConfiguration.ephemeral
                config.protocolClasses = [WorkspaceTestProtocol.self]
                return config
            },
            makeLiveSocket: { _ in socket }, surfaces: surfaces)
        try store.add(name: "测试", address: "https://example.com")
        let connected = await store.connect()
        XCTAssertTrue(connected)
        await waitUntil { store.liveState == .open }
        XCTAssertEqual(surfaces.indexed.last, [], "刷新后把已加载的工单交给 Spotlight")
        func deliver(_ issue: String, _ type: String, _ status: String) async {
            socket.deliver(#"{"companyId":"company","type":"\#(type)","payload":{"issueId":"\#(issue)","runId":"run-\#(issue)","status":"\#(status)"}}"#)
            try? await Task.sleep(for: .milliseconds(80))
        }
        await deliver("other", "heartbeat.run.status", "running")
        XCTAssertTrue(surfaces.changes.isEmpty, "未关注的工单不进灵动岛")
        store.watch(issueID: "created", created: true)
        store.watch(issueID: "viewed")
        await deliver("created", "heartbeat.run.queued", "queued")
        await deliver("viewed", "heartbeat.run.status", "running")
        XCTAssertEqual(surfaces.changes.count, 2)
        XCTAssertEqual(surfaces.contexts.first?.reference.issueID, "created")
        await store.setForeground(false)
        XCTAssertEqual(surfaces.holds, 1, "关注的运行仍在进行：申请后台时间保持实时通道")
        await deliver("created", "heartbeat.run.status", "succeeded")
        await deliver("created", "heartbeat.run.status", "succeeded")
        await deliver("viewed", "heartbeat.run.status", "failed")
        let finished = surfaces.changes.filter { if case .finished = $0 { return true }; return false }
        XCTAssertEqual(finished.map(\.run.issueID), ["created", "viewed"], "每个运行的终态只报告一次")
        XCTAssertEqual(surfaces.releases, 1, "关注的运行全部结束后释放后台时间")
        XCTAssertEqual(PaperclipWatchList.load(key: PaperclipWatchList.key(profileID: try XCTUnwrap(store.selectedID), companyID: "company", userID: "human"),
                                               defaults: defaults), ["created"], "只持久化本机创建的工单")
        await store.setForeground(true)
        await store.clearLogin()
        XCTAssertEqual(surfaces.cleared, [try XCTUnwrap(store.selectedID)], "退出登录清空此配置的 Spotlight 与活动")
    }
}
