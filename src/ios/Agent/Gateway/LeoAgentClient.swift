//
//  LeoAgentClient.swift
//  MinisApp
//
//  [T-leogateway] The phone's arm into a desktop-class agent.
//
//  LeoAgent is the Mac half of this product: a full agent of its own that
//  keeps working while the phone is asleep. This client drives it — start a
//  run, watch it stream, approve what it asks, stop it.
//
//  The Mac side vendors a third-party agent engine the way the iOS side
//  vendors iSH: the engine keeps its own internal names, and nothing about it
//  reaches the product surface. Everything named here is ours.
//
//  Protocol facts below were captured from a LIVE gateway (Hermes v0.20.0,
//  2026-08-05), not inferred from docs — see Desktop/LeoGateway_协议真相.
//
//  Additive guarantee: no gateway host configured → nothing here ever runs.
//

import Foundation
import CryptoKit

// MARK: - Wire types

/// One frame of a run's server-sent event stream.
///
/// The gateway emits exactly nine event names; anything else is surfaced as
/// `.unknown` rather than dropped, so a gateway upgrade degrades to "shown
/// but unstyled" instead of "silently missing".
enum GatewayEvent: Sendable {
    case messageDelta(String)
    case reasoning(String)
    /// `toolUseId` 把开始和结束配成一对(同名工具并行时按名字配会配错);`input` / `output` 是展开工具行时看的
    /// 完整命令与输出 —— Mac 发了才有,没发时展开只看得到 `preview`。
    case toolStarted(tool: String, preview: String?, toolUseId: String? = nil, input: String? = nil)
    case toolCompleted(tool: String, duration: Double?, isError: Bool, toolUseId: String? = nil, output: String? = nil)
    case approvalRequest(GatewayApprovalRequest)
    /// `auto` 非 nil:[A1] Mac 在全自动下自己应答了这次审批(没有先发 approval.request),内容是工具 / 命令摘要。
    case approvalResponded(choice: String?, approvalId: String?, auto: String? = nil)
    case runCompleted(output: String?, usage: GatewayUsage?)
    case runFailed(message: String?)
    case runCancelled
    /// Payload is stringified: `Any` is not Sendable, and an unmodelled
    /// event only needs to be displayable, not re-decoded.
    case unknown(name: String, payload: [String: String])

    /// True once the run can produce no further events.
    var isTerminal: Bool {
        switch self {
        case .runCompleted, .runFailed, .runCancelled: return true
        default: return false
        }
    }
}

/// A tool call the gateway is holding until the operator decides.
///
/// `command` arrives already redacted by the gateway (it runs
/// `_redact_approval_command` before the payload reaches this transport), so
/// credentials in a flagged command never cross the wire.
struct GatewayApprovalRequest: Sendable, Identifiable {
    /// Identity of THIS approval, not of the run.
    ///
    /// A run can ask several times, and every request carries the same
    /// `run_id` — the gateway payload has no approval id of its own. Keying on
    /// run_id let a second request silently inherit the first one's card
    /// (SwiftUI reuses a sheet whose Identifiable id is unchanged), so a user
    /// could approve a command they never saw. Minted locally, per request.
    let approvalId: String
    let runId: String
    /// Server-computed valid choices, e.g. ["once","session","always","deny"].
    let choices: [String]
    let command: String?
    /// Always nil today: the gateway's approval payload carries no tool name.
    /// Kept so the UI has a slot when one appears.
    let tool: String?
    /// The gateway's own explanation, from `description`.
    let reason: String?
    /// Everything the gateway sent, for fields this build does not model yet.
    let extras: [String: String]

    var id: String { approvalId }

    /// The gateway shrinks the choice set itself (a "smart denied" command
    /// only ever offers once/deny), so the UI must render what it was given
    /// rather than a hardcoded four buttons.
    var allowsPermanent: Bool { choices.contains("always") }
}

struct GatewayUsage: Sendable, Equatable {
    let inputTokens: Int
    let outputTokens: Int
    let totalTokens: Int
}

/// Snapshot of a run, used both for polling and for recovering after the
/// event stream drops (see `GatewayRunStatus.isTerminal`).
struct GatewayRunStatus: Sendable {
    let runId: String
    let status: String
    let lastEvent: String?
    let output: String?
    let usage: GatewayUsage?
    let sessionId: String?
    let model: String?

    /// Gateway enum: queued · running · waiting_for_approval · stopping ·
    /// cancelled · failed · completed.
    var isTerminal: Bool {
        ["completed", "failed", "cancelled"].contains(status)
    }
    /// A terminal run that did not succeed — recovery must not report these
    /// as a normal completion.
    var isFailure: Bool { status == "failed" || status == "cancelled" }
    var isWaitingForApproval: Bool { status == "waiting_for_approval" }
}

/// What the gateway says it can do. Read once per connection so the UI can
/// hide actions an older gateway does not implement instead of failing on use.
struct GatewayCapabilities: Sendable {
    let platform: String
    let version: String?
    let features: [String: Bool]
    /// 承载 harness 协议的宿主("leocodebox" = leocodebox 1.63+ 接管;nil =
    /// 原版 leoagent Python 服务)。协议同构,仅用于展示与诊断。
    let server: String?
    /// 这台 Mac sshd 的公钥(仅公钥),经已配对的加密通道取得;用于一键固定 SSH 服务器身份。
    var sshHostKeys: [String] = []

    func has(_ feature: String) -> Bool { features[feature] == true }

    static let unknown = GatewayCapabilities(platform: "", version: nil, features: [:], server: nil)
}

// GatewayError 在 GatewayError.swift(只依赖 Foundation,逻辑测试包也编它)。

// MARK: - Client

/// Which of the two Mac-side services a request targets. They are separate
/// processes on separate ports: the vendored agent engine, and our own
/// harness service. One base URL cannot serve both.
enum GatewayService: Sendable {
    case engine
    case harness
}

/// Stateless HTTP/SSE client for one gateway host.
///
/// An actor so a session driver and a background health probe can share one
/// instance without racing on URLSession configuration.
actor LeoAgentClient {
    let baseURL: URL
    /// Where the harness service lives (tailnet :8647 → local :8646). nil for
    /// hosts configured before this existed; harness calls then fail with a
    /// named, actionable error instead of hitting the engine port and 404ing.
    nonisolated let harnessBaseURL: URL?
    nonisolated let apiKey: String
    let session: URLSession
    let directSession: URLSession
    var directRoute: DirectDeviceRoute?
    var directProbeUntil = Date.distantPast
    var directCooldownUntil = Date.distantPast
    /// [up-link] 直连能通但比中继慢（例如小火箭里的 Tailscale 走 DERP 远程中继）：这段时间内不用直连。
    var directSlowUntil = Date.distantPast
    /// 经中继做一次轻量请求（capabilities / 会话列表）的最近耗时，毫秒，指数平滑。
    var relayLightLatencyMs: Double?
    var directLastFailure: Date?
    var directEnrollmentAttempted = false
    var directEnrollmentAfter = Date.distantPast
    let supportsDirectDiscovery: Bool
    let expectedDeviceId: String?
    let directOnly: Bool
    nonisolated let relayServices: GatewayRelayServices?
    /// [T-siri-fleet] 这个 client 属于哪台 Mac(GatewayHostStore 填)。
    /// Siri 审批通知需要跨进程回溯到主机来重建 client,靠它寻址。
    nonisolated let hostId: String?
    nonisolated let hostName: String?
    /// 不保存凭据或 URL 明文；主机/设备/端点改变后不会混用旧会话意图。
    nonisolated let harnessOutboxScope: String
    /// [e2e] 固定下来的 Mac 中继加密公钥(base64url);nil = 经中继只能走明文。见 LeoAgentRouting 的 relayData。
    var relayE2EKey: String?
    /// [e2e] Mac 不支持或解不开时,这之前经中继先走明文,不每个请求都白试一次。
    var relayE2EOffUntil = Date.distantPast
    /// [e2e] 和这台 Mac 加密往返成功过:带凭据的请求从此不退回明文中继。
    var relayE2EVerified = false

    /// Coalesce Treasury sync requests without dropping a request that arrives
    /// while the current cursor pass is suspended on network I/O. Actor
    /// reentrancy allows another caller to set `treasurySyncPending`; the
    /// active caller then performs one more complete cursor pass.
    var treasurySyncRunning = false
    var treasurySyncPending = false
    /// One download per asset. The reading sheet and the agent can request the
    /// same attachment concurrently; coalescing prevents interleaved partials.
    var treasuryAssetFetches = Set<String>()

    /// [T-leophone-push] 中继事件端点要绕开 harness 路径前缀自行拼 URL,
    /// 所以把这两样以只读形式露出来(仍然只在本模块内使用)。
    nonisolated var harnessBaseURLForRelay: URL? { harnessBaseURL }
    nonisolated var apiKeyForRelay: String { apiKey }

    init(baseURL: URL, apiKey: String, harnessBaseURL: URL? = nil,
         hostId: String? = nil, hostName: String? = nil, supportsDirectDiscovery: Bool = false, expectedDeviceId: String? = nil, directOnly: Bool = false, relayServices: GatewayRelayServices? = nil, outboxIdentity: String? = nil,
         relayE2EKey: String? = nil, relayE2EVerified: Bool = false) {
        self.relayE2EVerified = relayE2EVerified
        self.relayE2EKey = RelayE2E.validKey(relayE2EKey) == nil ? nil : relayE2EKey
        self.relayServices = relayServices ?? harnessBaseURL.flatMap {
            RelayMachinesClient.apiRoot(fromHarnessURL: $0.absoluteString).flatMap { GatewayRelayServices(apiRoot: $0) }
        }
        self.directOnly = directOnly
        self.expectedDeviceId = expectedDeviceId
        self.supportsDirectDiscovery = supportsDirectDiscovery
        if let hostId, let expectedDeviceId,
           let stored = GatewayHostStore.accessKey(hostId: hostId + ".direct"),
           let data = stored.data(using: .utf8) {
            self.directRoute = DirectDeviceRoute.decode(data, expectedDeviceId: expectedDeviceId)
        }
        self.baseURL = baseURL
        self.harnessBaseURL = harnessBaseURL
        self.apiKey = apiKey
        self.hostId = hostId
        self.hostName = hostName
        let owner = outboxIdentity ?? HarnessOutboxIdentity.initial(hostId: hostId ?? "", endpoint: harnessBaseURL?.absoluteString)
        let identity = try! JSONEncoder().encode([hostId ?? "", owner])
        self.harnessOutboxScope = SHA256.hash(data: identity).map { String(format: "%02x", $0) }.joined()
        let config = URLSessionConfiguration.ephemeral
        // A run can think for minutes before its first token; the resource
        // timeout must not guillotine a long remote task.
        config.timeoutIntervalForRequest = 60
        config.timeoutIntervalForResource = 60 * 60
        // 不能 waitsForConnectivity:没网时它会无视上面的 60 秒,一直挂到 1 小时的资源超时 ——
        // 锁屏审批按钮的后台窗口过期、回前台补齐卡住、离线发送也不会退回输入框。没网就立刻失败,由各处重试。
        config.waitsForConnectivity = false
        config.httpAdditionalHeaders = ["Accept-Encoding": "identity"]
        self.session = URLSession(configuration: config)
        let directConfig = URLSessionConfiguration.ephemeral
        directConfig.timeoutIntervalForRequest = 5
        directConfig.timeoutIntervalForResource = 3600
        directConfig.waitsForConnectivity = false
        self.directSession = URLSession(configuration: directConfig, delegate: GatewayNoRedirect(), delegateQueue: nil)
    }

    // MARK: Request plumbing

    func request(_ path: String, method: String = "GET", body: Data? = nil,
                 service: GatewayService = .engine) throws -> URLRequest {
        let base: URL
        switch service {
        case .engine:
            base = baseURL
        case .harness:
            guard let harnessBaseURL else { throw GatewayError.harnessNotConfigured }
            base = harnessBaseURL
        }
        // relay 模式的 base 自带路径前缀(…/leoagent-relay/relay/api/m/<机器名>)。
        // `URL(string:relativeTo:)` 对以 "/" 开头的路径会整段替换,把前缀吞掉
        // ——必须改为拼接。base 无路径时行为与原来完全一致。
        let resolved: URL?
        if base.path.isEmpty || base.path == "/" {
            resolved = URL(string: path, relativeTo: base)
        } else {
            let split = path.split(separator: "?", maxSplits: 1)
            let basePath = base.path.hasSuffix("/") ? String(base.path.dropLast()) : base.path
            var parts = URLComponents(url: base, resolvingAgainstBaseURL: false)
            parts?.path = basePath + String(split[0])
            parts?.query = split.count > 1 ? String(split[1]) : nil
            resolved = parts?.url
        }
        guard let url = resolved else { throw GatewayError.badURL }
        var req = URLRequest(url: url)
        if directOnly, let expectedDeviceId { req.setValue(expectedDeviceId, forHTTPHeaderField: "X-Leo-Device-ID") }
        req.httpMethod = method
        if method != "GET" && method != "HEAD" {
            let operation = UUID().uuidString.lowercased()
            req.setValue(operation, forHTTPHeaderField: "X-Leo-Request-Id")
            req.setValue(operation, forHTTPHeaderField: "X-Request-ID")
            // [up-ac-ios] 写操作的追踪号就用操作编号,中继 / Mac 日志里本来就有它。
            req.setValue(operation, forHTTPHeaderField: Self.traceHeader)
        } else {
            req.setValue(Self.newTraceId(), forHTTPHeaderField: Self.traceHeader)
        }
        req.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let body {
            req.httpBody = body
        }
        return req
    }

    /// [up-ac-ios] 每个请求一个追踪号,写进诊断日志:慢请求能和中继 / Mac 的日志对上。
    nonisolated static let traceHeader = "X-Leo-Trace-Id"
    nonisolated static func newTraceId() -> String {
        String(UUID().uuidString.lowercased().replacingOccurrences(of: "-", with: "").prefix(12))
    }
    private nonisolated static let traceLog = AppLogger(category: "LeoLinkTrace")
    /// 超过这个时长的请求按 info 记(默认档就能看到);其余走 verbose。
    private nonisolated static let slowRequestSeconds: TimeInterval = 3

    private func send(_ req: URLRequest) async throws -> Data {
        let start = Date()
        let trace = req.value(forHTTPHeaderField: Self.traceHeader) ?? "-"
        // 只记方法和路径:query 里可能带文件路径之类的内容。
        let label = "\(req.httpMethod ?? "GET") \(req.url?.path ?? "?")"
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await routedData(for: req)
        } catch {
            Self.traceLog.info("[trace \(trace)] \(label) → failed after \(Int(Date().timeIntervalSince(start) * 1000))ms: \(error.localizedDescription)")
            throw error
        }
        let elapsed = Date().timeIntervalSince(start)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        let line = "[trace \(trace)] \(label) → \(status) \(Int(elapsed * 1000))ms"
        if elapsed >= Self.slowRequestSeconds || !(200..<300).contains(status) {
            Self.traceLog.info(line)
        } else {
            Self.traceLog.verbose(line)
        }
        try Self.validate(response: response, data: data)
        return data
    }

    private static func validate(response: URLResponse, data: Data) throws {
        guard let http = response as? HTTPURLResponse else {
            throw GatewayError.malformedResponse("not an HTTP response")
        }
        guard (200..<300).contains(http.statusCode) else {
            let message = Self.errorMessage(from: data)
            // 401 是钥匙不对;403 带了原因是"钥匙对、但这件事不允许"(例如全自动只接受 iPhone
            // 设备钥匙),要把原因原样给人看,不能说成钥匙被拒。
            if http.statusCode == 401 || (http.statusCode == 403 && (message ?? "").isEmpty) {
                throw GatewayError.unauthorized
            }
            throw GatewayError.http(status: http.statusCode, message: message)
        }
    }

    /// The gateway speaks OpenAI's error envelope: {"error":{"message":…}}.
    private static func errorMessage(from data: Data) -> String? {
        guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        // [A3] Mac 认不出这台 iPhone 时 403 带修复步骤,一并带给会话显示。
        return HarnessFullAuto.errorMessage(from: obj)
    }

    private static func json(_ data: Data) throws -> [String: Any] {
        guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw GatewayError.malformedResponse(String(data: data.prefix(200), encoding: .utf8) ?? "")
        }
        return obj
    }

    /// Shared JSON helpers so feature extensions do not each re-implement
    /// request building, status validation and decoding.
    func getJSON(_ path: String, service: GatewayService = .engine) async throws -> [String: Any] {
        try Self.json(try await send(try request(path, service: service)))
    }

    /// [T-relay-outbox] What the relay recorded for a queued request
    /// (`/relay/api/queue/<id>`, outside the machine prefix): queued, delivered
    /// with the Mac's status, failed or expired. Throws 404 once forgotten.
    func relayQueueResult(requestId: String) async throws -> [String: Any] {
        guard let base = harnessBaseURL, let range = base.absoluteString.range(of: "/relay/api/"),
              let url = URL(string: String(base.absoluteString[..<range.upperBound]) + "queue/" + requestId)
        else { throw GatewayError.badURL }
        var req = try request("/", service: .harness)
        req.url = url
        return try Self.json(try await send(req))
    }

    /// 回执查询是只读的；不存在或未知都不能授权重新执行副作用。
    func harnessOperationResult(requestId: String) async throws -> [String: Any] {
        guard UUID(uuidString: requestId) != nil else { throw GatewayError.badURL }
        return try await getJSON("/operations/" + requestId, service: .harness)
    }

    func postJSON(_ path: String, body: [String: Any],
                  service: GatewayService = .engine,
                  headers: [String: String] = [:]) async throws -> [String: Any] {
        let data = try JSONSerialization.data(withJSONObject: body)
        var req = try request(path, method: "POST", body: data, service: service)
        for (name, value) in headers { req.setValue(value, forHTTPHeaderField: name) }
        if let operation = req.value(forHTTPHeaderField: "X-Leo-Request-Id") {
            req.setValue(operation, forHTTPHeaderField: "X-Request-ID")
        }
        let raw = try await send(req)
        return (try? Self.json(raw)) ?? [:]
    }

    // MARK: Probes

    func capabilities() async throws -> GatewayCapabilities {
        let obj = try Self.json(try await send(try request("/v1/capabilities")))
        var features: [String: Bool] = [:]
        for (key, value) in (obj["features"] as? [String: Any] ?? [:]) {
            if let flag = value as? Bool { features[key] = flag }
        }
        return GatewayCapabilities(
            platform: obj["platform"] as? String ?? "",
            version: obj["version"] as? String,
            features: features,
            server: obj["server"] as? String,
            sshHostKeys: (obj["ssh_host_keys"] as? [String] ?? []).compactMap(RemoteSSHTrust.normalizedPublicKey))
    }

    // MARK: Runs

    /// Start a run. Returns its id; events arrive via `streamEvents`.
    func submitRun(input: String, sessionId: String? = nil) async throws -> String {
        var payload: [String: Any] = ["input": input]
        if let sessionId { payload["session_id"] = sessionId }
        let body = try JSONSerialization.data(withJSONObject: payload)
        var req = try request("/v1/runs", method: "POST", body: body)
        if let sessionId {
            req.setValue(sessionId, forHTTPHeaderField: "X-Hermes-Session-Id")
        }
        let obj = try Self.json(try await send(req))
        guard let runId = obj["run_id"] as? String else {
            throw GatewayError.malformedResponse("missing run_id")
        }
        return runId
    }

    func runStatus(runId: String) async throws -> GatewayRunStatus {
        let obj = try Self.json(try await send(try request("/v1/runs/\(runId)")))
        return GatewayRunStatus(
            runId: obj["run_id"] as? String ?? runId,
            status: obj["status"] as? String ?? "unknown",
            lastEvent: obj["last_event"] as? String,
            output: obj["output"] as? String,
            usage: Self.parseUsage(obj["usage"]),
            sessionId: obj["session_id"] as? String,
            model: obj["model"] as? String)
    }

    func stopRun(runId: String) async throws {
        _ = try await send(try request("/v1/runs/\(runId)/stop", method: "POST", body: Data("{}".utf8)))
    }

    /// Resolve a pending approval. `choice` must be one the event offered —
    /// the gateway 400s on anything else rather than guessing.
    func respondToApproval(runId: String, choice: String) async throws {
        let body = try JSONSerialization.data(withJSONObject: ["choice": choice])
        _ = try await send(try request("/v1/runs/\(runId)/approval", method: "POST", body: body))
    }

    // MARK: Event stream

    /// Live events for a run.
    ///
    /// The gateway's SSE frames carry no `id:` field, so there is no
    /// Last-Event-ID resumption to lean on: a dropped socket loses whatever
    /// deltas were in flight. The stream therefore ends on disconnect and the
    /// caller reconciles through `runStatus(runId:)`, which still holds the
    /// final output. `GatewayRunDriver` implements that recovery.
    nonisolated func streamEvents(runId: String) -> AsyncThrowingStream<GatewayEvent, Error> {
        AsyncThrowingStream { continuation in
            let task = Task { await self.pumpEvents(runId: runId, into: continuation) }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    /// The read loop lives inside the actor on purpose: `URLSession.AsyncBytes`
    /// is not Sendable, so handing it across an isolation boundary would be a
    /// data race under Swift 6 strict concurrency. Only the (Sendable)
    /// continuation crosses.
    private func pumpEvents(
        runId: String,
        into continuation: AsyncThrowingStream<GatewayEvent, Error>.Continuation
    ) async {
        do {
            var req = try request("/v1/runs/\(runId)/events")
            req.setValue("text/event-stream", forHTTPHeaderField: "Accept")
            req.timeoutInterval = 3600
            let (bytes, response) = try await session.bytes(for: req)
            guard let http = response as? HTTPURLResponse else {
                throw GatewayError.malformedResponse("not an HTTP response")
            }
            guard (200..<300).contains(http.statusCode) else {
                if http.statusCode == 401 || http.statusCode == 403 { throw GatewayError.unauthorized }
                throw GatewayError.http(status: http.statusCode, message: nil)
            }
            for try await line in bytes.lines {
                if Task.isCancelled { break }
                // Frames are `data: {json}` separated by blank lines; SSE
                // comments (`:` keep-alives) and blanks are skipped.
                guard line.hasPrefix("data:") else { continue }
                let raw = line.dropFirst(5).trimmingCharacters(in: .whitespaces)
                // This gateway ends a stream with an SSE comment (": stream
                // closed"), which the `data:` guard above already skips; the
                // [DONE] check is only tolerance for OpenAI-shaped proxies.
                guard !raw.isEmpty, raw != "[DONE]" else { continue }
                guard let data = raw.data(using: .utf8),
                      let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
                else { continue }
                let event = GatewayEvent.parse(obj)
                continuation.yield(event)
                if event.isTerminal { break }
            }
            continuation.finish()
        } catch {
            continuation.finish(throwing: error)
        }
    }
}

// MARK: - Event parsing

extension GatewayEvent {
    /// Map one decoded SSE payload onto the typed event set.
    static func parse(_ obj: [String: Any]) -> GatewayEvent {
        // 跨端约定:权限模式变化发 `{"type":"mode","mode":…}`(没有 event 字段),归到 unknown("mode") 由驱动处理。
        let name = obj["event"] as? String ?? (obj["type"] as? String == "mode" ? "mode" : "")
        switch name {
        case "message.delta":
            return .messageDelta(obj["delta"] as? String ?? "")
        case "reasoning.available":
            return .reasoning(obj["text"] as? String ?? "")
        case "tool.started":
            let input = obj["input"].map { SSHFallbackCLI.describe(input: $0) }.flatMap { $0.isEmpty ? nil : $0 }
            return .toolStarted(tool: obj["tool"] as? String ?? "tool",
                                preview: obj["preview"] as? String,
                                toolUseId: obj["tool_use_id"] as? String,
                                input: input)
        case "tool.completed":
            return .toolCompleted(tool: obj["tool"] as? String ?? "tool",
                                  duration: obj["duration"] as? Double,
                                  // `error` is a Bool today, but a field with
                                  // that name may carry a message instead; a
                                  // non-empty string is still a failure.
                                  isError: (obj["error"] as? Bool)
                                      ?? !((obj["error"] as? String)?.isEmpty ?? true),
                                  toolUseId: obj["tool_use_id"] as? String,
                                  output: ((obj["output"] as? String) ?? (obj["result"] as? String)).map(SSHFallbackCLI.clip))
        case "approval.request":
            var extras: [String: String] = [:]
            let modelled: Set<String> = ["event", "run_id", "timestamp", "choices", "command",
                                         "description", "approval_id", "seq", "session_id"]
            for (key, value) in obj where !modelled.contains(key) {
                extras[key] = String(describing: value)
            }
            return .approvalRequest(GatewayApprovalRequest(
                // The harness mints a real per-approval id and expects it back;
                // minting our own severed that correlation (and changed on
                // every reconnect). The engine's payload has no id, so the
                // local UUID remains its fallback.
                approvalId: obj["approval_id"] as? String ?? UUID().uuidString,
                runId: obj["run_id"] as? String ?? "",
                choices: obj["choices"] as? [String] ?? ["once", "deny"],
                command: obj["command"] as? String,
                tool: obj["tool"] as? String,
                reason: obj["description"] as? String,
                extras: extras))
        case "approval.responded":
            return .approvalResponded(choice: obj["choice"] as? String,
                                      approvalId: obj["approval_id"] as? String,
                                      auto: HarnessFullAuto.autoApprovalSummary(obj))
        case "run.completed":
            return .runCompleted(output: obj["output"] as? String,
                                 usage: LeoAgentClient.parseUsage(obj["usage"]))
        case "run.failed":
            return .runFailed(message: (obj["error"] as? String) ?? (obj["message"] as? String))
        case "run.cancelled":
            return .runCancelled
        default:
            var flat: [String: String] = [:]
            for (key, value) in obj { flat[key] = String(describing: value) }
            return .unknown(name: name, payload: flat)
        }
    }
}

extension LeoAgentClient {
    /// Shared with `GatewayEvent.parse`, which has no actor context.
    nonisolated static func parseUsage(_ any: Any?) -> GatewayUsage? {
        guard let dict = any as? [String: Any] else { return nil }
        return GatewayUsage(
            inputTokens: dict["input_tokens"] as? Int ?? 0,
            outputTokens: dict["output_tokens"] as? Int ?? 0,
            totalTokens: dict["total_tokens"] as? Int ?? 0)
    }
}

// MARK: - 权限模式 / 改动面板(Leo Link 新路由;旧版 Mac 回 404,调用方据此隐藏入口、退回全自动开关)

extension LeoAgentClient {
    /// 切换这个会话的权限模式;返回 Mac 实际生效的模式。
    func setHarnessMode(sessionId: String, mode: HarnessMode) async throws -> HarnessMode {
        let obj = try await postJSON("/harness/sessions/\(sessionId)/mode", body: ["mode": mode.rawValue], service: .harness)
        return HarnessMode.parse(obj["mode"]) ?? mode
    }

    // MARK: [remote-ctl-ios] 模型 / 强度 / 会话操作 / 关注(契约 leo-link-remote-controls.md)

    /// 重新问一次能力开关并记下。
    @discardableResult
    func harnessFeatures() async throws -> HarnessFeatures {
        let features = HarnessFeatures.parse(try await getJSON("/v1/capabilities", service: .harness))
        HarnessFeatureCache.shared.record(features, for: hostId)
        return features
    }

    /// 记住的能力;从没问过就问一次(失败 = nil,按旧 Mac 处理)。
    func knownHarnessFeatures() async -> HarnessFeatures? {
        if let cached = HarnessFeatureCache.shared.features(for: hostId) { return cached }
        return try? await harnessFeatures()
    }

    func harnessModels() async throws -> HarnessModelCatalog {
        HarnessModelCatalog.parse(try await getJSON("/harness/models", service: .harness))
    }

    /// 换模型(可同时给强度);返回 Mac 实际生效的模型。
    func setHarnessModel(sessionId: String, provider: String, model: String, effort: String?) async throws -> HarnessModelRef? {
        let obj = try await postJSON("/harness/sessions/\(sessionId)/model",
                                     body: HarnessRemoteRequests.modelBody(provider: provider, model: model, effort: effort),
                                     service: .harness)
        return HarnessModelRef.parse(obj["model"])
    }

    /// 只改推理强度。
    func setHarnessEffort(sessionId: String, effort: String) async throws -> HarnessModelRef? {
        let obj = try await postJSON("/harness/sessions/\(sessionId)/model",
                                     body: HarnessRemoteRequests.effortBody(effort), service: .harness)
        return HarnessModelRef.parse(obj["model"])
    }

    func compactHarness(sessionId: String) async throws {
        _ = try await postJSON("/harness/sessions/\(sessionId)/compact", body: [:], service: .harness)
    }

    /// 返回 Mac 存下的标题。
    func renameHarness(sessionId: String, title: String) async throws -> String {
        guard let body = HarnessRemoteRequests.renameBody(title) else { throw GatewayError.badURL }
        let obj = try await postJSON("/harness/sessions/\(sessionId)/rename", body: body, service: .harness)
        return obj["title"] as? String ?? (body["title"] as? String ?? title)
    }

    func followHarness(sessionId: String, following: Bool) async throws -> Bool {
        let obj = try await postJSON("/harness/sessions/\(sessionId)/follow",
                                     body: HarnessRemoteRequests.followBody(following), service: .harness)
        return obj["following"] as? Bool ?? following
    }

    func answerHarnessQuestion(sessionId: String, questionId: String, answers: [HarnessQuestionAnswer]) async throws {
        _ = try await postJSON("/harness/sessions/\(sessionId)/answer",
                               body: HarnessRemoteRequests.answerBody(questionId: questionId, answers: answers),
                               service: .harness)
    }

    func declineHarnessQuestion(sessionId: String, questionId: String) async throws {
        _ = try await postJSON("/harness/sessions/\(sessionId)/answer",
                               body: HarnessRemoteRequests.declineBody(questionId: questionId), service: .harness)
    }

    /// 工作区相对 HEAD 的改动 + 每轮开始时的检查点。
    /// [P3] Mac 定时任务(/automations,Leo Link)。返回 Mac 的原始 JSON 文本;
    /// 404 时由调用方提示"这台 Mac 的 LeoBot 太旧"。
    func automationCall(_ request: MacAutomationLogic.Request) async throws -> String {
        let req = try self.request(request.path, method: request.method,
                                   body: request.body.map { Data($0.utf8) }, service: .harness)
        return String(data: try await send(req), encoding: .utf8) ?? "{}"
    }

    func harnessChanges(sessionId: String) async throws -> HarnessChanges {
        HarnessChanges.parse(try await getJSON("/harness/sessions/\(sessionId)/changes", service: .harness))
    }

    /// 单文件统一 diff;不带 checkpoint 相对 HEAD(含未跟踪文件),带了相对那个检查点。
    func harnessDiff(sessionId: String, path: String, checkpoint: String? = nil) async throws -> HarnessFileDiff {
        // 路径里可能有空格、&、+、中文:自己编码后用 percentEncodedQueryItems 原样放进去,
        // 不走 request() 的 query 拼接(那里按未编码处理,& 会把参数劈开)。
        var req = try request("/harness/sessions/\(sessionId)/diff", service: .harness)
        var query = [URLQueryItem(name: "path", value: Self.queryValue(path))]
        if let checkpoint { query.append(URLQueryItem(name: "checkpoint", value: Self.queryValue(checkpoint))) }
        guard let url = req.url, var parts = URLComponents(url: url, resolvingAgainstBaseURL: false) else { throw GatewayError.badURL }
        parts.percentEncodedQueryItems = query
        guard let full = parts.url else { throw GatewayError.badURL }
        req.url = full
        return HarnessFileDiff.parse(try Self.json(try await send(req)), path: path)
    }

    /// 回滚:带 checkpoint 恢复到那一轮开始前(paths 为空 = 全部);只带 paths 恢复到 HEAD。返回实际动过的文件。
    @discardableResult
    func revertHarness(sessionId: String, checkpoint: String?, paths: [String] = []) async throws -> [String] {
        var body: [String: Any] = [:]
        if let checkpoint { body["checkpoint"] = checkpoint }
        if !paths.isEmpty { body["paths"] = paths }
        let obj = try await postJSON("/harness/sessions/\(sessionId)/revert", body: body, service: .harness)
        return obj["reverted"] as? [String] ?? []
    }

    nonisolated static func queryValue(_ raw: String) -> String {
        let allowed = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~/")
        return raw.addingPercentEncoding(withAllowedCharacters: allowed) ?? raw
    }

    /// 新路由失败时给人看的话:404 = 这台 Mac 的 LeoBot 还没有这个功能。
    nonisolated static func describeHarnessFeatureError(_ error: Error) -> String {
        if case GatewayError.http(404, _) = error {
            return AppLocalized("这台 Mac 上的 LeoBot 版本较旧，还没有这个功能；把 Mac 端更新到最新版再试。")
        }
        if case GatewayError.http(_, let message?) = error, !message.isEmpty { return message }
        return error.localizedDescription
    }

    nonisolated static func isNotFound(_ error: Error) -> Bool {
        if case GatewayError.http(404, _) = error { return true }
        return false
    }
}
