//
//  GatewayRunDriver.swift
//  MinisApp
//
//  [T-leogateway] Drives one remote run and keeps a UI-shaped mirror of it.
//
//  The hard problem this solves is not streaming — it is RECONNECTING. The
//  gateway's SSE frames carry no `id:` field, so there is no Last-Event-ID to
//  resume from: a dropped socket loses whatever deltas were in flight, and
//  reopening the stream does not replay them. Reconnecting therefore means
//  *reconciling*: re-read the run's status, which still holds the authoritative
//  final output, and repair the transcript from it.
//
//  That is why a phone can walk out of Wi-Fi mid-task and still come back to a
//  correct transcript instead of a truncated one.
//

import Foundation

/// One rendered line of a remote run, in arrival order.
struct GatewayTranscriptItem: Identifiable, Sendable {
    enum Kind: Sendable {
        case assistantText
        case reasoning
        case tool(name: String, isRunning: Bool, isError: Bool, duration: Double?)
        case notice
        case failure
    }
    let id = UUID()
    var kind: Kind
    var text: String
}

@MainActor
final class GatewayRunDriver: ObservableObject {
    @Published private(set) var items: [GatewayTranscriptItem] = []
    @Published private(set) var isRunning = false
    @Published private(set) var status: String = "idle"
    @Published private(set) var usage: GatewayUsage?
    /// Non-nil while the remote agent is blocked waiting on the operator.
    @Published private(set) var pendingApproval: GatewayApprovalRequest?
    @Published private(set) var lastError: String?
    /// Bumps whenever the stream dropped and was re-established, so the UI can
    /// say so honestly rather than pretending nothing happened.
    @Published private(set) var reconnectCount = 0

    private let client: LeoAgentClient
    private let hostId: String
    private var runId: String?
    private var streamTask: Task<Void, Never>?
    /// Runs whose approval this client already answered. Without it the 3s
    /// poll re-synthesises a card in the window before the gateway's status
    /// flips, and a second answer gets a 400 the user cannot interpret.
    private var answeredApprovalRuns: Set<String> = []

    /// How many times to re-open a dropped stream before giving up. The run
    /// keeps going on the Mac regardless; this only bounds client-side retry.
    private let maxReconnects = 6

    init(client: LeoAgentClient, hostId: String) {
        self.client = client
        self.hostId = hostId
    }

    // MARK: - Lifecycle

    func send(_ prompt: String) {
        guard !isRunning else { return }
        let trimmed = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }

        lastError = nil
        usage = nil
        pendingApproval = nil
        reconnectCount = 0
        isRunning = true
        status = "submitting"
        // Drop the previous run's identity before the new id exists, so the
        // Stop button in this window cannot target the last run.
        streamTask?.cancel()
        runId = nil

        streamTask = Task { [weak self] in
            guard let self else { return }
            do {
                let id = try await self.client.submitRun(input: trimmed)
                await MainActor.run {
                    self.runId = id
                    self.status = "running"
                    GatewayHostStore.shared.markSeen(id: self.hostId)
                }
                await self.consume(runId: id)
            } catch {
                await MainActor.run {
                    self.fail(error.localizedDescription)
                }
            }
        }
    }

    func stop() {
        guard let runId else { return }
        Task { [client] in
            do {
                try await client.stopRun(runId: runId)
            } catch {
                // A 404 here means the run already finished — not worth
                // alarming the user, but any other failure must surface or
                // they will keep tapping a button that does nothing.
                await MainActor.run { self.lastError = error.localizedDescription }
            }
        }
    }

    /// Called when the console leaves the screen. The run keeps going on the
    /// Mac; we merely stop following it. isRunning MUST be reset or the view
    /// comes back with a dead composer (send() guards on it) and a spinner
    /// that never stops.
    func cancelLocalStream() {
        streamTask?.cancel()
        streamTask = nil
        if isRunning {
            isRunning = false
            status = "detached"
        }
    }

    /// Re-attach to a run we walked away from.
    func reattachIfNeeded() {
        guard !isRunning, let runId, status == "detached" else { return }
        isRunning = true
        streamTask = Task { [weak self] in
            await self?.pollUntilSettled(runId: runId)
        }
    }

    /// Answer a pending approval with one of the choices the gateway offered.
    func respond(to approval: GatewayApprovalRequest, choice: String) {
        guard approval.choices.contains(choice) else { return }
        WatchBridge.shared.clearApprovalRequest(approvalId: approval.approvalId)
        pendingApproval = nil
        status = "running"
        answeredApprovalRuns.insert(approval.runId)
        Task { [weak self, client] in
            do {
                try await client.respondToApproval(runId: approval.runId, choice: choice)
            } catch {
                // Put the card back. Optimistically clearing it and then
                // failing leaves the Mac blocked with no way to answer again.
                await MainActor.run {
                    guard let self else { return }
                    self.answeredApprovalRuns.remove(approval.runId)
                    self.pendingApproval = approval
                    self.status = "waiting_for_approval"
                    self.lastError = error.localizedDescription
                }
            }
        }
    }

    // MARK: - Stream consumption + reconciliation

    private func consume(runId: String) async {
        var sawTerminal = false
        do {
            for try await event in client.streamEvents(runId: runId) {
                if Task.isCancelled { return }
                await MainActor.run { self.apply(event) }
                if event.isTerminal { sawTerminal = true }
            }
        } catch {
            await MainActor.run { self.lastError = error.localizedDescription }
        }
        if sawTerminal || Task.isCancelled { return }

        // The stream ended early. Re-opening it would be pointless and is a
        // trap worth spelling out: the gateway pops the run's queue the moment
        // a subscriber disconnects, and its producer only enqueues while that
        // exact queue is still installed. Every event after the drop is
        // discarded server-side and can never be replayed. Polling the run's
        // status is the only way back to the truth.
        await MainActor.run {
            self.reconnectCount += 1
            self.note(String(localized: "Stream dropped — following the run by status instead."))
        }
        await pollUntilSettled(runId: runId)
    }

    /// Status polling, used after the one-shot event stream is gone.
    ///
    /// Terminal runs are retained by the gateway for an hour, so a phone that
    /// was away for a few minutes still recovers the full result.
    private func pollUntilSettled(runId: String) async {
        var attempt = 0
        while !Task.isCancelled {
            guard let snapshot = try? await client.runStatus(runId: runId) else {
                attempt += 1
                if attempt > maxReconnects {
                    await MainActor.run { self.fail(String(localized: "Lost contact with that Mac.")) }
                    return
                }
                try? await Task.sleep(nanoseconds: Self.backoff(attempt))
                continue
            }
            attempt = 0

            if snapshot.isTerminal {
                await MainActor.run { self.finish(from: snapshot) }
                return
            }

            if snapshot.isWaitingForApproval {
                // The approval payload rode the stream we lost, and there is no
                // endpoint to re-read it. "once" and "deny" are in every choice
                // set the gateway can produce, so offering exactly those two is
                // safe; anything richer would be guessing on the user's behalf.
                await MainActor.run {
                    if self.pendingApproval == nil, !self.answeredApprovalRuns.contains(runId) {
                        self.pendingApproval = GatewayApprovalRequest(
                            approvalId: UUID().uuidString,
                            runId: runId,
                            choices: ["once", "deny"],
                            command: nil,
                            tool: nil,
                            reason: String(localized: "Details were lost when the connection dropped."),
                            extras: [:])
                        self.status = snapshot.status
                        if let pending = self.pendingApproval { self.pushApprovalToWatch(pending) }
                    }
                }
            } else {
                await MainActor.run { self.status = snapshot.status }
            }

            try? await Task.sleep(nanoseconds: 3_000_000_000)
        }
    }

    /// 2s, 4s, 8s… capped at 30s — the same shape the desktop clients use.
    private static func backoff(_ attempt: Int) -> UInt64 {
        UInt64(min(30, 1 << min(attempt, 5))) * 1_000_000_000
    }

    // MARK: - Event → transcript

    private func apply(_ event: GatewayEvent) {
        switch event {
        case .messageDelta(let delta):
            appendAssistant(delta)

        case .reasoning(let text):
            guard !text.isEmpty else { return }
            items.append(GatewayTranscriptItem(kind: .reasoning, text: text))

        case .toolStarted(let tool, let preview):
            items.append(GatewayTranscriptItem(
                kind: .tool(name: tool, isRunning: true, isError: false, duration: nil),
                text: preview ?? ""))

        case .toolCompleted(let tool, let duration, let isError):
            // Close the most recent open row for this tool rather than
            // appending a second one — a tool call is one line, not two.
            if let index = items.lastIndex(where: {
                if case .tool(let name, let running, _, _) = $0.kind { return name == tool && running }
                return false
            }) {
                items[index].kind = .tool(name: tool, isRunning: false, isError: isError, duration: duration)
            } else {
                items.append(GatewayTranscriptItem(
                    kind: .tool(name: tool, isRunning: false, isError: isError, duration: duration),
                    text: ""))
            }

        case .approvalRequest(let approval):
            pendingApproval = approval
            status = "waiting_for_approval"
            pushApprovalToWatch(approval)

        case .approvalResponded(let choice, _):
            if let pending = pendingApproval {
                WatchBridge.shared.clearApprovalRequest(approvalId: pending.approvalId)
            }
            pendingApproval = nil
            status = "running"
            if let choice {
                note(String(localized: "Approval: \(choice)"))
            }

        case .runCompleted(let output, let usage):
            self.usage = usage
            // `output` is the authoritative full text. If deltas already built
            // an identical body, keep it; otherwise repair from the source of
            // truth — this is what makes a mid-run disconnect recoverable.
            if let output, !output.isEmpty {
                reconcileAssistantText(with: output)
            }
            status = "completed"
            isRunning = false

        case .runFailed(let message):
            fail(message ?? String(localized: "The run failed."))

        case .runCancelled:
            status = "cancelled"
            isRunning = false
            note(String(localized: "Run stopped."))

        case .unknown(let name, _):
            // Forward-compat: a newer gateway's event is shown, not swallowed.
            note(name)
        }
    }

    private func appendAssistant(_ delta: String) {
        guard !delta.isEmpty else { return }
        if let index = items.indices.last, case .assistantText = items[index].kind {
            items[index].text += delta
        } else {
            items.append(GatewayTranscriptItem(kind: .assistantText, text: delta))
        }
    }

    /// Replace the streamed body with the gateway's final text when they differ
    /// (i.e. deltas were lost to a disconnect).
    private func reconcileAssistantText(with output: String) {
        if let index = items.lastIndex(where: { if case .assistantText = $0.kind { return true }; return false }) {
            if items[index].text != output { items[index].text = output }
        } else {
            items.append(GatewayTranscriptItem(kind: .assistantText, text: output))
        }
    }

    private func finish(from snapshot: GatewayRunStatus) {
        if let output = snapshot.output, !output.isEmpty {
            reconcileAssistantText(with: output)
        }
        usage = snapshot.usage
        status = snapshot.status
        isRunning = false
        pendingApproval = nil
        // A recovered run that FAILED must not be reported as a success just
        // because we got its status back.
        if snapshot.isFailure {
            items.append(GatewayTranscriptItem(
                kind: .failure,
                text: snapshot.status == "cancelled"
                    ? String(localized: "Run stopped.")
                    : String(localized: "The run failed.")))
        } else if reconnectCount > 0 {
            note(String(localized: "Reconnected and recovered the result."))
        }
    }

    /// Mirror an approval to the wrist and accept an answer from there.
    ///
    /// The handler is re-armed on every request so a stale closure from an
    /// earlier run can never resolve the current one.
    private func pushApprovalToWatch(_ approval: GatewayApprovalRequest) {
        WatchBridge.shared.registerApprovalHandler(approvalId: approval.approvalId) { [weak self] choice in
            guard let self, let pending = self.pendingApproval,
                  pending.approvalId == approval.approvalId else { return }
            self.respond(to: pending, choice: choice)
        }
        WatchBridge.shared.sendApprovalRequest(
            approvalId: approval.approvalId,
            command: approval.command,
            reason: approval.reason,
            choices: approval.choices)
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
