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
        let obj = try await getJSON("/v1/capabilities")
        let rows = obj["harnesses"] as? [[String: Any]] ?? []
        return rows.compactMap { row in
            guard let key = row["key"] as? String else { return nil }
            return HarnessKind(key: key, name: row["name"] as? String ?? key)
        }
    }

    func harnessSessions() async throws -> [HarnessSessionSummary] {
        let obj = try await getJSON("/harness/sessions")
        let rows = obj["sessions"] as? [[String: Any]] ?? []
        return rows.compactMap { row in
            guard let id = row["session_id"] as? String else { return nil }
            return HarnessSessionSummary(
                id: id,
                harness: row["harness"] as? String ?? "",
                name: row["name"] as? String ?? "",
                cwd: row["cwd"] as? String ?? "",
                status: row["status"] as? String ?? "unknown",
                seq: row["seq"] as? Int ?? 0,
                waitingForApproval: row["waiting_for_approval"] as? Bool ?? false)
        }
    }

    // MARK: Control

    func createHarnessSession(harness: String, cwd: String, prompt: String?) async throws -> String {
        var payload: [String: Any] = ["harness": harness, "cwd": cwd]
        if let prompt, !prompt.isEmpty { payload["prompt"] = prompt }
        let obj = try await postJSON("/harness/sessions", body: payload)
        guard let id = obj["session_id"] as? String else {
            throw GatewayError.malformedResponse("missing session_id")
        }
        return id
    }

    func steerHarness(sessionId: String, text: String) async throws {
        _ = try await postJSON("/harness/sessions/\(sessionId)/send", body: ["text": text])
    }

    func approveHarness(sessionId: String, choice: String) async throws {
        _ = try await postJSON("/harness/sessions/\(sessionId)/approval", body: ["choice": choice])
    }

    func stopHarness(sessionId: String) async throws {
        _ = try await postJSON("/harness/sessions/\(sessionId)/stop", body: [:])
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
            var req = try request("/harness/sessions/\(sessionId)/events?after=\(after)")
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
    @Published private(set) var pendingApproval: GatewayApprovalRequest?
    @Published private(set) var lastError: String?
    @Published private(set) var resumeCount = 0

    let harness: HarnessKind
    let cwd: String
    private let client: LeoAgentClient
    private var sessionId: String?
    private var lastSeq = 0
    private var streamTask: Task<Void, Never>?
    /// Kept so a session abandoned before it existed can be re-created.
    private var firstPrompt: String?

    init(client: LeoAgentClient, harness: HarnessKind, cwd: String) {
        self.client = client
        self.harness = harness
        self.cwd = cwd
    }

    func start(prompt: String) {
        guard sessionId == nil, !isRunning else { return }
        firstPrompt = prompt
        isRunning = true
        status = "starting"
        streamTask = Task { [weak self] in
            guard let self else { return }
            do {
                let id = try await self.client.createHarnessSession(
                    harness: self.harness.key, cwd: self.cwd, prompt: prompt)
                await MainActor.run { self.sessionId = id; self.status = "running" }
                await self.follow(sessionId: id)
            } catch {
                await MainActor.run {
                    self.fail(error.localizedDescription)
                    self.status = "pending"   // recoverable: nothing was created
                }
            }
        }
    }

    /// Send a follow-up into a session that is already going.
    func steer(_ text: String) {
        guard let sessionId, !text.isEmpty else { return }
        items.append(GatewayTranscriptItem(kind: .notice, text: "→ " + text))
        Task { [client] in
            do { try await client.steerHarness(sessionId: sessionId, text: text) }
            catch { await MainActor.run { self.lastError = error.localizedDescription } }
        }
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
        pendingApproval = nil
        status = "running"
        Task { [weak self, client] in
            do {
                try await client.approveHarness(sessionId: sessionId, choice: choice)
            } catch {
                await MainActor.run {
                    guard let self else { return }
                    self.pendingApproval = approval
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

    // MARK: Stream

    private func follow(sessionId: String) async {
        var attempt = 0
        var seenAtAttemptStart = lastSeq
        while !Task.isCancelled {
            var ended = false
            do {
                for try await item in client.harnessEvents(sessionId: sessionId, after: lastSeq) {
                    if Task.isCancelled { return }
                    await MainActor.run {
                        self.lastSeq = max(self.lastSeq, item.seq)
                        self.apply(item.event)
                    }
                    if item.event.isTerminal { ended = true }
                }
            } catch {
                await MainActor.run { self.lastError = error.localizedDescription }
            }
            if ended || Task.isCancelled { return }

            // Reset once a reconnect actually delivered something: the budget
            // is for CONSECUTIVE failures, not for a long healthy session that
            // happened to blip seven times over an hour.
            if lastSeq > seenAtAttemptStart { attempt = 0 }
            seenAtAttemptStart = lastSeq
            attempt += 1
            if attempt > 6 {
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
            pendingApproval = approval
            status = "waiting_for_approval"
            armWatch(for: approval)
        case .approvalResponded:
            pendingApproval = nil
            status = "running"
        case .runCompleted(let output, _):
            if let output, !output.isEmpty,
               !items.contains(where: { if case .assistantText = $0.kind { return $0.text == output }; return false }) {
                items.append(GatewayTranscriptItem(kind: .assistantText, text: output))
            }
            status = "completed"
            isRunning = false
        case .runFailed(let message):
            fail(message ?? String(localized: "The session failed."))
        case .runCancelled:
            status = "cancelled"
            isRunning = false
            note(String(localized: "Session stopped."))
        case .unknown(let name, let payload):
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
        pendingApproval = nil
    }
}
