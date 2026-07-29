//
//  QuickTaskWidgetRunner.swift
//  MinisApp
//
//  [T-widget-run-in-place] App-side implementation behind
//  `RunQuickTaskFromWidgetIntent`. The intent type itself lives in
//  AgentActivityAttributes.swift because it must compile into the widget
//  extension too; everything that touches the agent loop lives here, in the
//  app target only, and is reached through WidgetIntentBridge.
//

import Foundation
import WidgetKit

private let logger = AppLogger(category: "QuickTaskWidget")

enum QuickTaskWidgetRunner {
    /// How long we keep watching a widget-launched session before giving up on
    /// labelling its outcome. The task itself is unaffected — this only bounds
    /// how long the badge says "running".
    private static let observationTimeout: TimeInterval = 15 * 60
    private static let pollInterval: UInt64 = 2_000_000_000  // 2s
    /// How long to wait for a dispatched run to actually show up as active
    /// before assuming it already finished (or never started).
    private static let startupGrace: TimeInterval = 90

    /// Dispatches a quick task from the Home Screen widget and keeps the
    /// widget's per-task badge in sync. Dispatch is fire-and-forget
    /// (`waitForResult: false`) so the intent returns quickly; the run itself
    /// continues under the normal background keep-alive path and reports
    /// through the existing Shortcut notifications.
    /// Returns true when the run was actually dispatched. Callers that report
    /// back to another device (WatchBridge) relay this rather than assuming
    /// success. [T-watch-reply-before-dispatch]
    @discardableResult
    @MainActor
    static func run(taskId: String) async -> Bool {
        guard let definition = QuickTaskStore.shared.definition(for: taskId) else {
            logger.error("widget run requested for unknown task id=\(taskId)")
            WidgetQuickTasksStore.updateRunState(id: taskId, state: .failed)
            reload()
            return false
        }

        logger.info("widget run start id=\(taskId) name=\(definition.name)")
        WidgetQuickTasksStore.updateRunState(id: taskId, state: .running)
        reload()

        do {
            let result = try await QuickTaskIntent.execute(
                definition: definition,
                files: nil,
                model: nil,
                waitForResult: false,
                inputValues: [:]
            )
            guard let sessionId = result.value?.sessionId, !sessionId.isEmpty else {
                // Dispatched but we can't identify the session — leave the
                // badge idle rather than claim an outcome we didn't observe.
                WidgetQuickTasksStore.updateRunState(id: taskId, state: .idle)
                reload()
                return true
            }
            // [T-widget-briefing-pending] Persist the obligation BEFORE
            // observing. The in-process observer below is only a fast path;
            // if iOS suspends us mid-run it dies, and the pending entry is
            // what lets the tracker callback / next foreground still publish
            // the result.
            WidgetPendingBriefingStore.add(sessionId: sessionId, taskName: definition.displayName)
            observeCompletion(taskId: taskId, sessionId: sessionId)
            return true
        } catch {
            logger.error("widget run failed id=\(taskId): \(error.localizedDescription)")
            WidgetQuickTasksStore.updateRunState(id: taskId, state: .failed)
            reload()
            return false
        }
    }

    /// Watches the launched session until it leaves the active set, then flips
    /// the badge to succeeded. Detached so the intent can return immediately.
    private static func observeCompletion(taskId: String, sessionId: String) {
        Task.detached(priority: .utility) {
            // [T-widget-run-startup-race] Phase 1 — wait for the session to
            // become ACTIVE before watching for it to finish. `execute` with
            // waitForResult:false returns the moment the prompt is dispatched,
            // and the agent loop can take much longer than one poll to boot
            // the kernel / resolve a provider / receive a first token. Polling
            // straight for "not active" therefore fired on the very first tick,
            // declared success, and read a reply that did not exist yet — the
            // briefing was then dropped by the empty-summary guard.
            var becameActive = false
            let startupDeadline = Date().addingTimeInterval(startupGrace)
            while Date() < startupDeadline {
                try? await Task.sleep(nanoseconds: pollInterval)
                if await MainActor.run(body: { SessionActivityTracker.shared.activeSessions.contains(sessionId) }) {
                    becameActive = true
                    break
                }
                // A very fast task can start AND finish inside the grace window.
                // Treat "a reply already exists" as having completed.
                if await hasAssistantReply(sessionId: sessionId) { break }
            }

            // Phase 2 — if it did start, wait for it to leave the active set.
            if becameActive {
                let deadline = Date().addingTimeInterval(observationTimeout)
                while Date() < deadline {
                    try? await Task.sleep(nanoseconds: pollInterval)
                    let stillRunning = await MainActor.run {
                        SessionActivityTracker.shared.activeSessions.contains(sessionId)
                    }
                    if !stillRunning { break }
                }
            }

            // Phase 3 — publish. The final assistant write can land a moment
            // after the session leaves the active set, so poll briefly for it
            // instead of reading once and giving up.
            var haveReply = false
            for _ in 0..<5 {
                try? await Task.sleep(nanoseconds: pollInterval)
                if await hasAssistantReply(sessionId: sessionId) { haveReply = true; break }
            }

            // [T-widget-runstate-failed] A run that started and produced no
            // reply used to be recorded as `.idle` — indistinguishable from
            // "never ran" — and its pending-briefing entry was left behind
            // forever, so every later foreground re-read the same session's
            // messages and it consumed one of the 10 pending slots.
            let name = await MainActor.run { () -> String in
                WidgetQuickTasksStore.updateRunState(
                    id: taskId,
                    state: haveReply ? .succeeded : (becameActive ? .failed : .idle)
                )
                reload()
                return QuickTaskStore.shared.definition(for: taskId)?.displayName ?? taskId
            }
            if haveReply {
                _ = await WidgetDataMirror.recordBriefing(taskName: name, sessionId: sessionId)
            }
            // Either way this observation is finished; nothing else will publish it.
            await MainActor.run { WidgetPendingBriefingStore.remove(sessionId: sessionId) }
            await WidgetDataMirror.refreshAll()
            logger.info("widget run settled id=\(taskId) session=\(sessionId.prefix(8)) active=\(becameActive) reply=\(haveReply)")
        }
    }

    /// True once the session has a non-empty assistant message on disk.
    private static func hasAssistantReply(sessionId: String) async -> Bool {
        let messages = await ChatStore.shared.loadMessages(sessionId: sessionId)
        guard let last = messages.last(where: { $0.role == .assistant }) else { return false }
        return last.parts.contains { part in
            if case .text(let value) = part {
                return !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            }
            return false
        }
    }

    private static func reload() {
        WidgetCenter.shared.reloadTimelines(ofKind: LeoWidgetKind.quickTasks)
        WidgetCenter.shared.reloadTimelines(ofKind: LeoWidgetKind.iPadConsole)
    }
}
