import Combine
import Foundation

/// WebSocket 的最小抽象：生产用 URLSessionWebSocketTask，测试注入脚本化实现。
@MainActor
protocol PaperclipLiveSocket: AnyObject {
    func resume()
    /// 握手完成的确认（生产实现用 ping 往返）；失败即握手失败。
    func waitUntilOpen() async throws
    func receiveText() async throws -> String
    func cancel()
    /// 握手响应状态码，用于区分 401/403/404 与网络错误。
    var handshakeStatus: Int? { get }
    /// 握手响应地址；必须与配置同源。
    var responseURL: URL? { get }
}

/// 生产实现：独立 ephemeral 会话，不读写任何 Cookie 存储、不缓存、不跟随重定向；
/// Cookie 只来自握手请求里已过滤的头。
@MainActor
final class PaperclipURLSessionLiveSocket: PaperclipLiveSocket {
    private let session: URLSession
    private let task: URLSessionWebSocketTask

    init(request: URLRequest) {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpShouldSetCookies = false
        configuration.httpCookieStorage = nil
        configuration.urlCredentialStorage = nil
        configuration.urlCache = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        session = URLSession(configuration: configuration, delegate: PaperclipNoRedirect(), delegateQueue: nil)
        task = session.webSocketTask(with: request)
        task.maximumMessageSize = 4 << 20
    }

    deinit { session.invalidateAndCancel() }

    func resume() { task.resume() }

    func waitUntilOpen() async throws {
        let task = task
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            task.sendPing { error in
                if let error { continuation.resume(throwing: error) } else { continuation.resume() }
            }
        }
    }

    func receiveText() async throws -> String {
        switch try await task.receive() {
        case .string(let text): return text
        case .data(let data): return String(decoding: data, as: UTF8.self)
        @unknown default: return ""
        }
    }

    func cancel() {
        task.cancel(with: .goingAway, reason: nil)
        session.invalidateAndCancel()
    }

    var handshakeStatus: Int? { (task.response as? HTTPURLResponse)?.statusCode }
    var responseURL: URL? { task.response?.url ?? task.currentRequest?.url }
}

/// 公司级实时事件通道。
///
/// 状态机：idle → verifying → connecting → open；关闭或错误 → waiting（1/2/4/8/15 秒退避，
/// 期间页面回退 15 秒轮询）→ verifying …；身份不符 / 401 / 公司不符 → stopped，不再重连。
/// 服务器只在升级时鉴权一次且不重放，所以：每次（重新）连接都先新鲜确认身份，
/// 连上后发出 `reconnected` 让页面全量补拉；连上 10 分钟后主动重连以重新确认身份。
@MainActor
final class PaperclipLiveConnection: ObservableObject {
    enum StopReason: Equatable, Sendable {
        case signedOut, identityChanged, protocolViolation, unavailable
    }
    enum State: Equatable, Sendable {
        case idle, verifying, connecting, open
        case waiting(retryIn: Double)
        case stopped(StopReason)
    }

    @Published private(set) var state: State = .idle
    let profile: PaperclipProfile
    let companyID: String
    let userID: String
    /// 已通过公司校验的事件。
    let events = PassthroughSubject<PaperclipLiveEvent, Never>()
    /// 每次连上（含重连）后发出；服务器不重放，订阅方据此全量补拉。
    let reconnected = PassthroughSubject<Void, Never>()
    static let identityRefreshInterval: Double = 600

    private let makeRequest: @MainActor () async throws -> URLRequest
    private let makeSocket: @MainActor (URLRequest) -> PaperclipLiveSocket
    private let sleep: @MainActor (Double) async throws -> Void
    private var loop: Task<Void, Never>?
    private var socket: PaperclipLiveSocket?
    private var refreshTimer: Task<Void, Never>?
    private var identityRefreshDue = false
    private(set) var failures = 0

    var isOpen: Bool { state == .open }
    var isStopped: Bool { if case .stopped = state { return true }; return false }

    init(profile: PaperclipProfile, companyID: String, userID: String,
         makeRequest: @escaping @MainActor () async throws -> URLRequest,
         makeSocket: @escaping @MainActor (URLRequest) -> PaperclipLiveSocket = { PaperclipURLSessionLiveSocket(request: $0) },
         sleep: @escaping @MainActor (Double) async throws -> Void = { try await Task.sleep(for: .seconds($0)) }) {
        self.profile = profile
        self.companyID = companyID
        self.userID = userID
        self.makeRequest = makeRequest
        self.makeSocket = makeSocket
        self.sleep = sleep
    }

    /// 只有同一配置、公司、用户的页面才能订阅此通道。
    func matches(_ reference: PaperclipTaskReference) -> Bool {
        reference.profileID == profile.id && reference.origin == profile.origin &&
        reference.companyID == companyID && reference.userID == userID
    }

    /// 回到前台或首次进入时调用；已在运行或已因身份停止时不重复启动。
    func start() {
        guard loop == nil, !isStopped else { return }
        failures = 0
        loop = Task { @MainActor [weak self] in await self?.run() }
    }

    /// 回到前台：上次因服务器暂不提供实时通道而停止的，重新尝试；身份问题导致的停止不自动恢复。
    func resumeFromBackground() {
        if state == .stopped(.unavailable) { state = .idle }
        start()
    }

    /// 离开前台、切换身份或公司时主动断开。
    func stop() {
        loop?.cancel(); loop = nil
        teardownSocket()
        if !isStopped { state = .idle }
    }

    private func finish(_ reason: StopReason) {
        teardownSocket()
        state = .stopped(reason)
        loop = nil
    }

    private func teardownSocket() {
        refreshTimer?.cancel(); refreshTimer = nil
        socket?.cancel(); socket = nil
    }

    private static func terminalReason(_ error: Error) -> StopReason? {
        switch (error as? PaperclipError)?.underlying {
        case .signedOut?: return .signedOut
        case .identityChanged?: return .identityChanged
        case .invalidAddress?: return .protocolViolation
        default: return nil
        }
    }

    private func run() async {
        while !Task.isCancelled {
            state = .verifying
            let request: URLRequest
            do { request = try await makeRequest() }
            catch {
                guard !Task.isCancelled else { return }
                if let reason = Self.terminalReason(error) { finish(reason); return }
                guard await backoff() else { return }
                continue
            }
            guard !Task.isCancelled else { return }
            state = .connecting
            let socket = makeSocket(request)
            self.socket = socket
            identityRefreshDue = false
            socket.resume()
            do {
                try await socket.waitUntilOpen()
                guard !Task.isCancelled else { return }
                // 握手不跟随重定向；仍核对最终地址与配置同源。
                if let url = socket.responseURL, !PaperclipClient.liveSameOrigin(url, profile.origin) {
                    finish(.protocolViolation); return
                }
                state = .open
                failures = 0
                scheduleIdentityRefresh()
                reconnected.send()
                while !Task.isCancelled {
                    let text = try await socket.receiveText()
                    guard let event = PaperclipLiveEvent.decode(text) else { continue }
                    // 每条事件都校验公司；不符说明通道归属异常，丢弃并断开，不再自动重连。
                    guard event.companyId == companyID else { finish(.protocolViolation); return }
                    events.send(event)
                }
                return
            } catch {
                guard !Task.isCancelled else { return }
                let status = socket.handshakeStatus
                teardownSocket()
                if identityRefreshDue { identityRefreshDue = false; continue }
                switch status {
                case 401?, 403?:
                    // 刚新鲜确认过身份仍被拒：再新鲜确认一次。身份失效则停止并提示重新登录；
                    // 否则是此服务器、代理或账号不提供实时通道，停止重连，页面保持轮询。
                    do { _ = try await makeRequest(); finish(.unavailable) }
                    catch { finish(Self.terminalReason(error) ?? .unavailable) }
                    return
                case 404?, 400?: finish(.unavailable); return
                default:
                    guard await backoff() else { return }
                }
            }
        }
    }

    /// 连上 10 分钟后主动断开重连，重连路径会重新新鲜确认身份。
    private func scheduleIdentityRefresh() {
        refreshTimer?.cancel()
        refreshTimer = Task { @MainActor [weak self] in
            do { try await Task.sleep(for: .seconds(Self.identityRefreshInterval)) } catch { return }
            guard let self, !Task.isCancelled, self.state == .open else { return }
            self.identityRefreshDue = true
            self.socket?.cancel()
        }
    }

    private func backoff() async -> Bool {
        failures += 1
        let delay = PaperclipLiveBackoff.delay(afterFailures: failures)
        state = .waiting(retryIn: delay)
        do { try await sleep(delay) } catch { return false }
        return !Task.isCancelled
    }
}
