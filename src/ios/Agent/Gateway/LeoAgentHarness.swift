//
//  LeoAgentHarness.swift
//  MinisApp
//
//  [T-leoagent-harness] Drive a real coding CLI on the Mac from the phone.
//
//  This is the half of LeoAgent that has no equivalent on the engine side: a
//  harness session is Claude Code / Codex / Grok actually working in a real
//  directory, steerable and approvable mid-run.
//
//  The protocol is ours, so it has the one property the engine's stream lacks:
//  every event carries a monotonic `seq` and the server keeps the log, so
//  `?after=N` replays what a dropped connection missed instead of losing it.
//  That is why this client reconnects by resuming rather than by polling.
//

import Foundation

struct HarnessKind: Sendable, Identifiable, Hashable {
    let key: String
    let name: String
    var id: String { key }
}

struct HarnessSessionSummary: Sendable, Identifiable, Hashable {
    let id: String
    let harness: String
    let name: String
    let cwd: String
    let status: String
    let seq: Int
    let waitingForApproval: Bool
    /// 队首待审批(Siri「批准」与通知按钮按它寻址);无待审批为 nil。
    var pendingApprovalId: String? = nil
    var pendingApprovalCommand: String? = nil
}

/// One event from a harness session. Same vocabulary as a gateway run, plus a
/// sequence number — the thing that makes the stream resumable.
struct HarnessEvent: Sendable {
    let seq: Int
    let event: GatewayEvent
}

extension LeoAgentClient {

    // MARK: Discovery

    /// Which coding CLIs this Mac can actually run.
    ///
    /// The server only reports what it can locate on disk, so a CLI the user
    /// has not installed never appears as a choice that would fail on use.
    func harnessKinds() async throws -> [HarnessKind] {
        let obj = try await getJSON("/v1/capabilities", service: .harness)
        let rows = obj["harnesses"] as? [[String: Any]] ?? []
        return rows.compactMap { row in
            guard let key = row["key"] as? String else { return nil }
            return HarnessKind(key: key, name: row["name"] as? String ?? key)
        }
    }

    func harnessSessions() async throws -> [HarnessSessionSummary] {
        let obj = try await getJSON("/harness/sessions", service: .harness)
        let rows = obj["sessions"] as? [[String: Any]] ?? []
        return rows.compactMap { row in
            guard let id = row["session_id"] as? String else { return nil }
            let pending = (row["pending_approvals"] as? [[String: Any]])?.first
            return HarnessSessionSummary(
                id: id,
                harness: row["harness"] as? String ?? "",
                name: row["name"] as? String ?? "",
                cwd: row["cwd"] as? String ?? "",
                status: row["status"] as? String ?? "unknown",
                seq: row["seq"] as? Int ?? 0,
                waitingForApproval: row["waiting_for_approval"] as? Bool ?? false,
                pendingApprovalId: pending?["approval_id"] as? String,
                pendingApprovalCommand: pending?["command"] as? String)
        }
    }

    // MARK: Control

    func createHarnessSession(harness: String, cwd: String, prompt: String?, thinking: String? = nil) async throws -> String {
        var payload: [String: Any] = ["harness": harness, "cwd": cwd]
        if let prompt, !prompt.isEmpty { payload["prompt"] = prompt }
        if let thinking, !thinking.isEmpty { payload["thinking"] = thinking }
        let obj = try await postJSON("/harness/sessions", body: payload, service: .harness)
        guard let id = obj["session_id"] as? String else {
            throw GatewayError.malformedResponse("missing session_id")
        }
        return id
    }

    func steerHarness(sessionId: String, text: String) async throws {
        _ = try await postJSON("/harness/sessions/\(sessionId)/send", body: ["text": text],
                               service: .harness)
    }

    /// `approvalId` is the server's own id for the request. Without it the
    /// server can only fall back to "the one pending approval" — and 409s the
    /// moment a CLI raises two at once.
    func approveHarness(sessionId: String, choice: String, approvalId: String?) async throws {
        var body: [String: Any] = ["choice": choice]
        if let approvalId { body["approval_id"] = approvalId }
        _ = try await postJSON("/harness/sessions/\(sessionId)/approval", body: body,
                               service: .harness)
    }

    func stopHarness(sessionId: String) async throws {
        _ = try await postJSON("/harness/sessions/\(sessionId)/stop", body: [:],
                               service: .harness)
    }

    // MARK: Resumable stream

    /// Events from `after` onwards: replay first, then follow live.
    ///
    /// Passing the last seq you rendered is what makes a reconnect lossless —
    /// the caller never has to reason about what it might have missed.
    nonisolated func harnessEvents(sessionId: String, after: Int) -> AsyncThrowingStream<HarnessEvent, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                await self.pumpHarness(sessionId: sessionId, after: after, into: continuation)
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    private func pumpHarness(
        sessionId: String,
        after: Int,
        into continuation: AsyncThrowingStream<HarnessEvent, Error>.Continuation
    ) async {
        do {
            var req = try request("/harness/sessions/\(sessionId)/events?after=\(after)",
                                  service: .harness)
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
                guard line.hasPrefix("data:") else { continue }
                let raw = line.dropFirst(5).trimmingCharacters(in: .whitespaces)
                guard !raw.isEmpty,
                      let data = raw.data(using: .utf8),
                      let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
                else { continue }
                continuation.yield(HarnessEvent(
                    seq: obj["seq"] as? Int ?? 0,
                    event: GatewayEvent.parse(obj)))
            }
            continuation.finish()
        } catch {
            continuation.finish(throwing: error)
        }
    }
}

// MARK: - Driver

/// Drives one harness session. Structurally close to `GatewayRunDriver`, with
/// one important difference: recovery resumes the stream at the last seq
/// instead of falling back to status polling, because this protocol can.
@MainActor
final class HarnessSessionDriver: ObservableObject {
    @Published private(set) var items: [GatewayTranscriptItem] = []
    @Published private(set) var isRunning = false
    @Published private(set) var status = "idle"
    /// A queue, not a slot: a CLI can raise a second approval before the
    /// first is answered, and a single slot silently dropped the first one —
    /// unanswerable from any surface, CLI blocked forever.
    @Published private(set) var pendingApprovals: [GatewayApprovalRequest] = []
    @Published private(set) var lastError: String?
    @Published private(set) var resumeCount = 0

    /// The one the UI shows; the rest wait their turn behind it.
    var pendingApproval: GatewayApprovalRequest? { pendingApprovals.first }

    let harness: HarnessKind
    let cwd: String
    private let client: LeoAgentClient
    private(set) var sessionId: String?
    private var lastSeq = 0
    private var streamTask: Task<Void, Never>?
    /// Kept so a session abandoned before it existed can be re-created.
    private var firstPrompt: String?

    init(client: LeoAgentClient, harness: HarnessKind, cwd: String) {
        self.client = client
        self.harness = harness
        self.cwd = cwd
    }

    /// [T-composer-send-dead] 会话建立期间(经中继 1~3 秒)用户就开始发送。
    /// 排队而不是拒绝:sessionId 一到就依序发出。点击永远有响应。
    private var queuedSteers: [String] = []

    func start(prompt: String, thinking: String? = nil) {
        guard sessionId == nil, !isRunning else { return }
        firstPrompt = prompt
        isRunning = true
        status = "starting"
        streamTask = Task { [weak self] in
            guard let self else { return }
            do {
                let id = try await self.client.createHarnessSession(
                    harness: self.harness.key, cwd: self.cwd, prompt: prompt,
                    thinking: thinking)
                await MainActor.run {
                    self.sessionId = id
                    self.status = "running"
                    self.flushQueuedSteers()
                    HarnessLiveActivityBridge.shared.register(driver: self, hostName: self.client.hostName)
                }
                await self.follow(sessionId: id)
            } catch {
                await MainActor.run {
                    self.fail(error.localizedDescription)
                    self.status = "pending"   // recoverable: nothing was created
                }
            }
        }
    }

    private func flushQueuedSteers() {
        guard let sessionId else { return }
        let queued = queuedSteers
        queuedSteers = []
        guard !queued.isEmpty else { return }
        Task { [client] in
            for text in queued {
                do { try await client.steerHarness(sessionId: sessionId, text: text) }
                catch { await MainActor.run { self.lastError = error.localizedDescription } }
            }
        }
    }

    /// Send a follow-up. Never a dead tap: with no session yet the text is
    /// queued (create in flight) or becomes the first prompt of a fresh
    /// create (previous create failed). Returns false only for empty text.
    @discardableResult
    func steer(_ text: String) -> Bool {
        guard !text.isEmpty else { return false }
        guard let sessionId else {
            items.append(GatewayTranscriptItem(kind: .notice, text: "→ " + text))
            if status == "starting" {
                queuedSteers.append(text)
            } else {
                // pending/idle:上次创建失败或从未创建——用这条文字当首条
                // 消息重建。isRunning 已置位时 start() 会拒,先复位。
                isRunning = false
                start(prompt: text)
            }
            return true
        }
        items.append(GatewayTranscriptItem(kind: .notice, text: "→ " + text))
        if status == "idle" { status = "running" }
        Task { [client] in
            do { try await client.steerHarness(sessionId: sessionId, text: text) }
            catch { await MainActor.run { self.lastError = error.localizedDescription } }
        }
        return true
    }

    func stop() {
        guard let sessionId else { return }
        Task { [client] in
            do { try await client.stopHarness(sessionId: sessionId) }
            catch { await MainActor.run { self.lastError = error.localizedDescription } }
        }
    }

    func respond(to approval: GatewayApprovalRequest, choice: String) {
        guard let sessionId, approval.choices.contains(choice) else { return }
        WatchBridge.shared.clearApprovalRequest(approvalId: approval.approvalId)
        pendingApprovals.removeAll { $0.approvalId == approval.approvalId }
        status = pendingApprovals.isEmpty ? "running" : "waiting_for_approval"
        if let next = pendingApprovals.first { armWatch(for: next) }
        Task { [weak self, client] in
            do {
                try await client.approveHarness(sessionId: sessionId, choice: choice,
                                                approvalId: approval.approvalId)
            } catch {
                await MainActor.run {
                    guard let self else { return }
                    // Server refused or never got it: the card comes back,
                    // honestly, at the front of the queue.
                    if !self.pendingApprovals.contains(where: { $0.approvalId == approval.approvalId }) {
                        self.pendingApprovals.insert(approval, at: 0)
                    }
                    self.status = "waiting_for_approval"
                    self.lastError = error.localizedDescription
                    // Re-arm the wrist too: restoring only the phone card would
                    // leave the watch button silently dead on a retry.
                    self.armWatch(for: approval)
                }
            }
        }
    }

    func detach() {
        streamTask?.cancel()
        streamTask = nil
        HarnessLiveActivityBridge.shared.unregister(driver: self)
        guard isRunning else { return }
        isRunning = false
        // Leaving before the session id came back would otherwise strand this
        // driver at detached/nil forever, with no Start button on this screen
        // to recover from. "pending" lets resume re-issue the create instead.
        status = (sessionId == nil) ? "pending" : "detached"
    }

    func resumeIfNeeded() {
        guard !isRunning else { return }
        if let sessionId, status == "detached" {
            isRunning = true
            status = "running"
            streamTask = Task { [weak self] in await self?.follow(sessionId: sessionId) }
        } else if sessionId == nil, status == "pending", let prompt = firstPrompt {
            status = "idle"
            start(prompt: prompt)
        }
    }

    /// 接管 Mac 上已存在的会话:从 seq 0 全量回放再实时跟随。
    /// 这正是可续传协议的意义——桌面上开的会话,手机随时拿起来继续。
    func attach(existingSessionId: String) {
        guard sessionId == nil, !isRunning else { return }
        sessionId = existingSessionId
        isRunning = true
        status = "running"
        HarnessLiveActivityBridge.shared.register(driver: self, hostName: client.hostName)
        streamTask = Task { [weak self] in
            await self?.follow(sessionId: existingSessionId)
        }
    }

    // MARK: Stream

    private func follow(sessionId: String) async {
        var attempt = 0
        var seenAtAttemptStart = lastSeq
        while !Task.isCancelled {
            var ended = false
            var cleanClose = false
            do {
                for try await item in client.harnessEvents(sessionId: sessionId, after: lastSeq) {
                    if Task.isCancelled { return }
                    await MainActor.run {
                        // Skip a replay of the last applied seq when `after` is inclusive.
                        // messageDelta concatenates; applying seq N twice doubles the last chunk.
                        // 说明:Android 那条 harness 路径(MinisHarnessRouter)对 `after`
                        // 是严格大于,这个分支在那边永远不会命中——保留它是为了 Mac /
                        // 未来实现真按 inclusive 处理时不至于把最后一段文字重复一遍,
                        // 属于纯防御,不改变已知实现的行为。
                        if item.seq > 0, item.seq <= self.lastSeq { return }
                        if item.seq > 0 { self.lastSeq = item.seq }
                        self.apply(item.event)
                    }
                    // run.completed / run.failed are TURN boundaries here — the
                    // CLI stays alive and steerable. Only a cancel ends the
                    // session from inside the stream.
                    if case .runCancelled = item.event { ended = true }
                }
                cleanClose = true
            } catch {
                await MainActor.run { self.lastError = error.localizedDescription }
            }
            if ended || Task.isCancelled { return }

            if cleanClose {
                // The server closes the stream deliberately when a session is
                // finished or orphaned. Ask it which, rather than reconnecting
                // into a replay loop or guessing.
                if await reconcile(sessionId: sessionId) { return }
            }

            // Reset once a reconnect actually delivered something: the budget
            // is for CONSECUTIVE failures, not for a long healthy session that
            // happened to blip seven times over an hour.
            if lastSeq > seenAtAttemptStart { attempt = 0 }
            seenAtAttemptStart = lastSeq
            attempt += 1
            if attempt > 6 {
                // Before claiming "still running", check: the session may have
                // finished, failed or died while we were unreachable.
                if await reconcile(sessionId: sessionId) { return }
                await MainActor.run {
                    self.status = "detached"
                    self.isRunning = false
                    self.note(String(localized: "Still running on your Mac; reopen to follow along."))
                }
                return
            }
            // Resume, not restart: the server kept every event we missed, so
            // picking up at lastSeq loses nothing.
            await MainActor.run {
                self.resumeCount += 1
                self.note(String(localized: "Reconnecting…"))
            }
            try? await Task.sleep(nanoseconds: UInt64(min(30, 1 << attempt)) * 1_000_000_000)
        }
    }

    /// Ask the server what actually became of the session. Returns true when
    /// the session is over (or gone) and following should stop.
    private func reconcile(sessionId: String) async -> Bool {
        guard let sessions = try? await client.harnessSessions() else { return false }
        guard let summary = sessions.first(where: { $0.id == sessionId }) else {
            await MainActor.run {
                self.status = "completed"
                self.isRunning = false
                self.note(String(localized: "Session is gone from the Mac."))
            }
            return true
        }
        if ["completed", "failed", "cancelled", "orphaned"].contains(summary.status) {
            await MainActor.run {
                self.status = summary.status
                self.isRunning = false
                self.note(summary.status == "failed"
                    ? String(localized: "The session failed on the Mac.")
                    : String(localized: "Session ended."))
            }
            return true
        }
        return false
    }

    private func apply(_ event: GatewayEvent) {
        switch event {
        case .messageDelta(let delta):
            if let index = items.indices.last, case .assistantText = items[index].kind {
                items[index].text += delta
            } else {
                items.append(GatewayTranscriptItem(kind: .assistantText, text: delta))
            }
        case .reasoning(let text):
            guard !text.isEmpty else { return }
            items.append(GatewayTranscriptItem(kind: .reasoning, text: text))
        case .toolStarted(let tool, let preview):
            items.append(GatewayTranscriptItem(
                kind: .tool(name: tool, isRunning: true, isError: false, duration: nil),
                text: preview ?? ""))
        case .toolCompleted(let tool, let duration, let isError):
            if let index = items.lastIndex(where: {
                if case .tool(let name, let running, _, _) = $0.kind { return name == tool && running }
                return false
            }) {
                items[index].kind = .tool(name: tool, isRunning: false, isError: isError, duration: duration)
            }
        case .approvalRequest(let approval):
            guard !pendingApprovals.contains(where: { $0.approvalId == approval.approvalId }) else { return }
            pendingApprovals.append(approval)
            status = "waiting_for_approval"
            // The wrist shows one card at a time; arm it only for the front of
            // the queue, and the next one when this front resolves.
            if pendingApprovals.count == 1 { armWatch(for: approval) }
            // [T-siri-approval-notify] app 在后台时,审批必须走通知触达,
            // 否则任务静默挂住直到用户想起来打开 app。
            if let sid = sessionId {
                HarnessApprovalNotifier.post(hostId: client.hostId, hostName: client.hostName,
                                             sessionId: sid, approval: approval)
            }
            HarnessLiveActivityBridge.shared.refresh()
        case .approvalResponded(_, let approvalId):
            if let approvalId {
                if let resolved = pendingApprovals.first(where: { $0.approvalId == approvalId }) {
                    WatchBridge.shared.clearApprovalRequest(approvalId: resolved.approvalId)
                }
                pendingApprovals.removeAll { $0.approvalId == approvalId }
                if let sid = sessionId {
                    HarnessApprovalNotifier.clear(sessionId: sid, approvalId: approvalId)
                }
            } else if let first = pendingApprovals.first {
                WatchBridge.shared.clearApprovalRequest(approvalId: first.approvalId)
                if let sid = sessionId {
                    HarnessApprovalNotifier.clear(sessionId: sid, approvalId: first.approvalId)
                }
                pendingApprovals.removeFirst()
            }
            if let next = pendingApprovals.first {
                armWatch(for: next)
            } else {
                status = "running"
            }
            HarnessLiveActivityBridge.shared.refresh()
        case .runCompleted(let output, _):
            if let output, !output.isEmpty,
               !items.contains(where: { if case .assistantText = $0.kind { return $0.text == output }; return false }) {
                items.append(GatewayTranscriptItem(kind: .assistantText, text: output))
            }
            // Turn over, session alive: the CLI is waiting for the next
            // instruction, and marking it dead here froze the console after
            // the first exchange.
            status = "idle"
        case .runFailed(let message):
            // A failed TURN, not a dead session — surface it and stay
            // steerable; a dead process ends via stream close + reconcile.
            lastError = message
            items.append(GatewayTranscriptItem(
                kind: .failure,
                text: message ?? String(localized: "The turn failed.")))
            status = "idle"
        case .runCancelled:
            status = "cancelled"
            isRunning = false
            note(String(localized: "Session stopped."))
        case .unknown(let name, let payload):
            if name == "user.message" {
                // The durable log now carries the user half of the
                // conversation; render it like the local echo, and skip the
                // duplicate when this device just typed it.
                let text = payload["text"] ?? ""
                let echo = "→ " + text
                if !text.isEmpty, items.last?.text != echo { note(echo) }
                if status == "idle" { status = "running" }
                return
            }
            if name == "session.created" { return }   // metadata, already shown by the launcher
            // Engine chatter (retries, init banners) shows up here. Surfacing
            // it is what made a broken CLI on the Mac diagnosable instead of
            // looking like a silent hang.
            let detail = payload["raw"] ?? payload["text"] ?? ""
            note("\(name) \(String(describing: detail).prefix(160))")
        }
    }

    /// Mirror an approval to the wrist and accept an answer from there.
    private func armWatch(for approval: GatewayApprovalRequest) {
        WatchBridge.shared.registerApprovalHandler(approvalId: approval.approvalId) { [weak self] choice in
            guard let self, let pending = self.pendingApproval,
                  pending.approvalId == approval.approvalId else { return }
            self.respond(to: pending, choice: choice)
        }
        WatchBridge.shared.sendApprovalRequest(
            approvalId: approval.approvalId,
            command: approval.command, reason: approval.reason, choices: approval.choices)
    }

    private func note(_ text: String) {
        items.append(GatewayTranscriptItem(kind: .notice, text: text))
    }

    private func fail(_ message: String) {
        lastError = message
        items.append(GatewayTranscriptItem(kind: .failure, text: message))
        status = "failed"
        isRunning = false
        pendingApprovals = []
    }
}
