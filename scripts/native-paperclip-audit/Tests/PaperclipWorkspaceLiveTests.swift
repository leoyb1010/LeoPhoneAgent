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
}
