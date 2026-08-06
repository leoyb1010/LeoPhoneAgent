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

private let logger = AppLogger(category: "Gateway")

// MARK: - Wire types

/// One frame of a run's server-sent event stream.
///
/// The gateway emits exactly nine event names; anything else is surfaced as
/// `.unknown` rather than dropped, so a gateway upgrade degrades to "shown
/// but unstyled" instead of "silently missing".
enum GatewayEvent: Sendable {
    case messageDelta(String)
    case reasoning(String)
    case toolStarted(tool: String, preview: String?)
    case toolCompleted(tool: String, duration: Double?, isError: Bool)
    case approvalRequest(GatewayApprovalRequest)
    case approvalResponded(choice: String?, approvalId: String?)
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

struct GatewaySessionSummary: Sendable, Identifiable {
    let id: String
    let title: String?
    let updatedAt: Double?
    let messageCount: Int?
}

/// What the gateway says it can do. Read once per connection so the UI can
/// hide actions an older gateway does not implement instead of failing on use.
struct GatewayCapabilities: Sendable {
    let platform: String
    let version: String?
    let features: [String: Bool]

    func has(_ feature: String) -> Bool { features[feature] == true }

    static let unknown = GatewayCapabilities(platform: "", version: nil, features: [:])
}

enum GatewayError: LocalizedError {
    case notConfigured
    case harnessNotConfigured
    case badURL
    case unauthorized
    case http(status: Int, message: String?)
    case malformedResponse(String)

    var errorDescription: String? {
        switch self {
        case .notConfigured:
            return String(localized: "No Mac is connected.")
        case .harnessNotConfigured:
            // The engine and the harness service listen on different ports;
            // pointing harness traffic at the engine used to 404 (or worse,
            // read as "no CLI installed"). Now it is a named setup step.
            return String(localized: "This Mac has no harness address set. Edit the Mac and fill in the LeoAgent service address (port 8647).")
        case .badURL:
            return String(localized: "That Mac address is not a valid URL.")
        case .unauthorized:
            // Deliberately no key echo — this string reaches logs and UI.
            return String(localized: "密钥被拒绝。三台 Mac 与中继共用同一把钥匙:在 cortex 终端运行 cat ~/.leoagent/key,把结果重新粘贴到「设置 → 我的 Mac」。")
        case .http(let status, let message):
            if let message, !message.isEmpty {
                return String(localized: "LeoAgent error \(status): \(message)")
            }
            return String(localized: "LeoAgent error \(status)")
        case .malformedResponse(let detail):
            return String(localized: "Unexpected response from LeoAgent: \(detail)")
        }
    }
}

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
    private let baseURL: URL
    /// Where the harness service lives (tailnet :8647 → local :8646). nil for
    /// hosts configured before this existed; harness calls then fail with a
    /// named, actionable error instead of hitting the engine port and 404ing.
    private let harnessBaseURL: URL?
    private let apiKey: String
    let session: URLSession

    init(baseURL: URL, apiKey: String, harnessBaseURL: URL? = nil) {
        self.baseURL = baseURL
        self.harnessBaseURL = harnessBaseURL
        self.apiKey = apiKey
        let config = URLSessionConfiguration.ephemeral
        // A run can think for minutes before its first token; the resource
        // timeout must not guillotine a long remote task.
        config.timeoutIntervalForRequest = 60
        config.timeoutIntervalForResource = 60 * 60
        config.waitsForConnectivity = true
        config.httpAdditionalHeaders = ["Accept-Encoding": "identity"]
        self.session = URLSession(configuration: config)
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
        req.httpMethod = method
        req.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let body {
            req.httpBody = body
        }
        return req
    }

    private func send(_ req: URLRequest) async throws -> Data {
        let (data, response) = try await session.data(for: req)
        try Self.validate(response: response, data: data)
        return data
    }

    private static func validate(response: URLResponse, data: Data) throws {
        guard let http = response as? HTTPURLResponse else {
            throw GatewayError.malformedResponse("not an HTTP response")
        }
        guard (200..<300).contains(http.statusCode) else {
            if http.statusCode == 401 || http.statusCode == 403 { throw GatewayError.unauthorized }
            throw GatewayError.http(status: http.statusCode, message: Self.errorMessage(from: data))
        }
    }

    /// The gateway speaks OpenAI's error envelope: {"error":{"message":…}}.
    private static func errorMessage(from data: Data) -> String? {
        guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        if let err = obj["error"] as? [String: Any], let msg = err["message"] as? String { return msg }
        return obj["message"] as? String
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

    func postJSON(_ path: String, body: [String: Any],
                  service: GatewayService = .engine) async throws -> [String: Any] {
        let data = try JSONSerialization.data(withJSONObject: body)
        let raw = try await send(try request(path, method: "POST", body: data, service: service))
        return (try? Self.json(raw)) ?? [:]
    }

    // MARK: Probes

    /// Unauthenticated liveness check — /health needs no key, so this also
    /// distinguishes "host unreachable" from "key wrong".
    func health() async throws -> Bool {
        guard let url = URL(string: "/health", relativeTo: baseURL) else { throw GatewayError.badURL }
        let (data, response) = try await session.data(from: url)
        try Self.validate(response: response, data: data)
        let obj = try Self.json(data)
        return (obj["status"] as? String) == "ok"
    }

    func capabilities() async throws -> GatewayCapabilities {
        let obj = try Self.json(try await send(try request("/v1/capabilities")))
        var features: [String: Bool] = [:]
        for (key, value) in (obj["features"] as? [String: Any] ?? [:]) {
            if let flag = value as? Bool { features[key] = flag }
        }
        return GatewayCapabilities(
            platform: obj["platform"] as? String ?? "",
            version: obj["version"] as? String,
            features: features)
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

    // MARK: Sessions

    func listSessions() async throws -> [GatewaySessionSummary] {
        let obj = try Self.json(try await send(try request("/api/sessions")))
        let rows = (obj["sessions"] as? [[String: Any]]) ?? (obj["data"] as? [[String: Any]]) ?? []
        return rows.compactMap { row in
            guard let id = (row["session_id"] as? String) ?? (row["id"] as? String) else { return nil }
            return GatewaySessionSummary(
                id: id,
                title: row["title"] as? String,
                updatedAt: row["updated_at"] as? Double,
                messageCount: row["message_count"] as? Int)
        }
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
        let name = obj["event"] as? String ?? ""
        switch name {
        case "message.delta":
            return .messageDelta(obj["delta"] as? String ?? "")
        case "reasoning.available":
            return .reasoning(obj["text"] as? String ?? "")
        case "tool.started":
            return .toolStarted(tool: obj["tool"] as? String ?? "tool",
                                preview: obj["preview"] as? String)
        case "tool.completed":
            return .toolCompleted(tool: obj["tool"] as? String ?? "tool",
                                  duration: obj["duration"] as? Double,
                                  // `error` is a Bool today, but a field with
                                  // that name may carry a message instead; a
                                  // non-empty string is still a failure.
                                  isError: (obj["error"] as? Bool)
                                      ?? !((obj["error"] as? String)?.isEmpty ?? true))
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
                                      approvalId: obj["approval_id"] as? String)
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
