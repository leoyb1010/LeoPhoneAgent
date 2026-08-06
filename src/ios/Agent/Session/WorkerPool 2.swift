//
//  WorkerPool.swift
//  MinisApp
//
//  [T-orchestration] Lead/Worker orchestration (absorbed from Cindy's Orca).
//
//  A Worker IS an ordinary session: it appears in the sidebar, uses the
//  normal send/cancel/keep-alive paths, and can be opened mid-run. This pool
//  only adds the "decompose–dispatch–collect" control surface on top; nothing
//  in the ordinary chat path goes through it.
//
//  Runtime invariants copied from Orca:
//    • a Worker's terminal state is final — collect never resurrects it
//    • a Worker keeps its model for its whole life (no mid-task swap)
//    • dispatch beyond the concurrency cap fails cleanly instead of queueing
//      silently (the Lead is told, and decides)
//
//  Additive guarantee: the tools are only registered when the user enables
//  orchestration in Settings (default OFF) — off means the tool list, prompt
//  bytes and cache prefix are unchanged.
//

import Foundation

private let logger = AppLogger(category: "WorkerPool")

@MainActor
final class WorkerPool {
    static let shared = WorkerPool()
    static let enabledKey = "leo.orchestration.enabled"
    /// User decision 2026-07-29: cap 5.
    static let maxConcurrent = 5

    static var isEnabled: Bool {
        UserDefaults.standard.bool(forKey: enabledKey)
    }

    struct Worker {
        let id: String            // short handle the Lead uses, e.g. "w1"
        let sessionId: String
        let label: String
        let startedAt: Date
        var collected = false
    }

    private var workers: [Worker] = []
    private var counter = 0

    private func runningCount() -> Int {
        // A just-dispatched worker takes a moment to register as active; count
        // fresh ones too so N parallel dispatch calls can't leap the cap.
        workers.filter {
            !$0.collected && (SessionActivityTracker.shared.activeSessions.contains($0.sessionId)
                || Date().timeIntervalSince($0.startedAt) < 60)
        }.count
    }

    /// Create a Worker session and send it the subtask. Returns a status line
    /// for the Lead's tool result.
    func dispatch(prompt: String, label: String, host: String? = nil) async -> (output: String, success: Bool) {
        guard runningCount() < Self.maxConcurrent else {
            return ("Dispatch refused: \(Self.maxConcurrent) workers already running. Collect or wait for one to finish first.", false)
        }
        // [T-worker-active-steal] ensureSessionReturningId writes the global
        // activeSessionId; without restore, dispatching mid-stream yanked the
        // "currently viewed session" away from the Lead and broke its
        // streaming flush/restore gates.
        let previousActive = AIChatViewModel.activeSessionId
        let vm = ViewModelCache.shared.createDraft()
        vm.sessionSource = "orchestration"
        await vm.ensureSessionReturningId()
        AIChatViewModel.activeSessionId = previousActive
        guard let sessionId = vm.sessionId else {
            return ("Dispatch failed: could not create a worker session.", false)
        }
        counter += 1
        let workerId = "w\(counter)"
        let cleanLabel = label.isEmpty ? "Subtask \(counter)" : label
        workers.append(Worker(id: workerId, sessionId: sessionId, label: cleanLabel, startedAt: Date()))
        // Name the session so the sidebar shows what this worker is doing.
        await ChatStore.shared.updateSessionTitle(sessionId, title: "🤖 \(cleanLabel)")
        // [T-fleet] Host pinning is prompt-level routing: the worker is a full
        // agent with the remote tools registered — telling it WHERE to run is
        // both sufficient and honest about the mechanism.
        var finalPrompt = prompt
        if let host, !host.isEmpty {
            finalPrompt = "Run ALL shell work for this task on the remote host '\(host)' via remote_shell (fall back to local only if the host is unreachable and say so).\n\n" + prompt
        }
        vm.inputText = finalPrompt
        vm.send()
        logger.info("dispatched \(workerId) session=\(sessionId.prefix(8)) label=\(cleanLabel)")
        return ("Dispatched worker \(workerId) (\"\(cleanLabel)\") in session \(sessionId.prefix(8)). It runs in parallel; use check_subtasks to monitor and collect_subtask when done.", true)
    }

    /// One status line per worker, cheap enough to poll.
    func status() async -> String {
        guard !workers.isEmpty else { return "No workers have been dispatched in this app run." }
        var lines: [String] = []
        for worker in workers {
            let running = SessionActivityTracker.shared.activeSessions.contains(worker.sessionId)
            let state: String
            if running {
                state = "RUNNING (\(Int(Date().timeIntervalSince(worker.startedAt)))s)"
            } else if worker.collected {
                state = "COLLECTED"
            } else {
                state = "DONE — ready to collect"
            }
            var line = "\(worker.id) [\(state)] \(worker.label)"
            if !running, !worker.collected {
                let preview = await Self.lastAssistantText(sessionId: worker.sessionId)
                if !preview.isEmpty { line += " — \(preview.prefix(120))" }
            }
            lines.append(line)
        }
        return lines.joined(separator: "\n")
    }

    /// Full result of a finished worker. Terminal state is final: collecting
    /// marks it collected, never re-runs anything.
    func collect(workerId: String) async -> (output: String, success: Bool) {
        guard let index = workers.firstIndex(where: { $0.id == workerId }) else {
            return ("No worker named '\(workerId)'. Use check_subtasks to list workers.", false)
        }
        let worker = workers[index]
        if SessionActivityTracker.shared.activeSessions.contains(worker.sessionId) {
            return ("Worker \(workerId) is still running — check_subtasks until it reports DONE.", false)
        }
        let text = await Self.lastAssistantText(sessionId: worker.sessionId, limit: 8000)
        workers[index].collected = true
        guard !text.isEmpty else {
            return ("Worker \(workerId) finished without a text reply (it may have failed — open its session \(worker.sessionId.prefix(8)) to inspect).", false)
        }
        return ("Result from \(workerId) (\"\(worker.label)\"):\n\n\(text)", true)
    }

    private static func lastAssistantText(sessionId: String, limit: Int = 200) async -> String {
        let messages = await ChatStore.shared.loadMessages(sessionId: sessionId)
        guard let last = messages.last(where: { $0.role == .assistant }) else { return "" }
        let text = last.parts.compactMap { part -> String? in
            if case .text(let value) = part { return value }
            return nil
        }.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
        return String(text.prefix(limit))
    }
}
