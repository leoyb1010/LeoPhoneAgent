//
//  WatchBridge.swift
//  MinisApp
//
//  [T-watch-companion] iPhone side of the Apple Watch companion.
//
//  IMPORTANT correction to an earlier assumption: App Group UserDefaults do
//  NOT cross from iPhone to Watch — an App Group is shared between processes
//  on ONE device. So the widget snapshot the Home Screen reads is unreachable
//  from watchOS, and the companion needs WatchConnectivity instead. This file
//  is that transport.
//
//  Direction of travel:
//    • phone → watch  `updateApplicationContext` with the current agent
//      status. Last-value-wins semantics are exactly right for "what is the
//      agent doing"; a queue would just deliver stale frames.
//    • watch → phone  `sendMessage` naming a quick task to run, which lands
//      in the same runner the Home Screen widget uses.
//
//  Inert when no watch is paired, so shipping it costs nothing.
//

import Foundation
#if canImport(WatchConnectivity)
import WatchConnectivity
#endif

private let logger = AppLogger(category: "WatchBridge")

/// Keys shared with the watch target. Kept as plain strings so the watch app
/// can depend on this contract without importing app code.
enum WatchPayloadKey {
    static let kind = "kind"
    static let state = "state"
    static let title = "title"
    static let status = "status"
    static let activeCount = "activeCount"
    static let updatedAt = "updatedAt"
    static let quickTasks = "quickTasks"      // [[id, name, symbol]]
    static let taskId = "taskId"

    static let briefingTask = "briefingTask"
    static let briefingText = "briefingText"
    static let sessions = "sessions"          // [[id, title, state, unread]]
    static let scheduled = "scheduled"        // [[id, name, timeText, enabled]]
    static let requestId = "requestId"
    static let text = "text"
    static let sessionId = "sessionId"

    static let kindStatus = "status"
    static let kindRunQuickTask = "runQuickTask"
    static let kindStopAll = "stopAll"
    static let kindAsk = "ask"                // watch → phone: run a prompt
    static let kindAskReply = "askReply"      // phone → watch: final answer
    static let kindTranscript = "transcript"  // watch → phone (replyHandler)
    static let kindStopSession = "stopSession"
    static let kindScheduledRun = "scheduledRun"
    static let kindScheduledToggle = "scheduledToggle"
}

#if canImport(WatchConnectivity)

@MainActor
final class WatchBridge: NSObject, ObservableObject {
    static let shared = WatchBridge()

    private var session: WCSession? {
        WCSession.isSupported() ? WCSession.default : nil
    }

    private var lastPushedSignature: String = ""

    func resetDedupe() { lastPushedSignature = "" }

    /// Last ask answer, folded into the application context as a fallback for
    /// when the live message can't be delivered (watch briefly unreachable).
    private var pendingAskReply: (id: String, text: String)?

    func sendAskReply(requestId: String, text: String) {
        pendingAskReply = (requestId, text)
        if let session, session.isReachable {
            session.sendMessage([
                WatchPayloadKey.kind: WatchPayloadKey.kindAskReply,
                WatchPayloadKey.requestId: requestId,
                WatchPayloadKey.text: text,
            ], replyHandler: nil, errorHandler: { _ in })
        }
        resetDedupe()
        pushStatus()
    }

    func activate() {
        guard let session else {
            logger.info("WatchConnectivity unsupported on this device")
            return
        }
        session.delegate = self
        session.activate()
        logger.info("WCSession activating")
    }

    /// Publishes the current agent status to the watch. Cheap and idempotent:
    /// identical payloads are dropped, because `updateApplicationContext`
    /// is rate-limited by the system and a redundant push wastes that budget.
    func pushStatus() {
        guard let session, session.activationState == .activated else { return }
        #if os(iOS)
        guard session.isPaired, session.isWatchAppInstalled else { return }
        #endif

        let snapshot = AgentWidgetSnapshotStore.load()
        let tasks = WidgetQuickTasksStore.load().prefix(4).map { [$0.id, $0.name, $0.symbolName] }

        let context: [String: Any] = [
            WatchPayloadKey.kind: WatchPayloadKey.kindStatus,
            WatchPayloadKey.state: snapshot.state.rawValue,
            WatchPayloadKey.title: snapshot.title,
            WatchPayloadKey.status: snapshot.status,
            WatchPayloadKey.activeCount: snapshot.activeCount,
            WatchPayloadKey.briefingTask: WidgetBriefingStore.load()?.taskName ?? "",
            WatchPayloadKey.briefingText: String((WidgetBriefingStore.load()?.summary ?? "").prefix(300)),
            WatchPayloadKey.sessions: Self.sessionsPayload(),
            WatchPayloadKey.scheduled: Self.scheduledPayload(),
            "askReplyId": pendingAskReply?.id ?? "",
            "askReplyText": pendingAskReply?.text ?? "",
            WatchPayloadKey.updatedAt: snapshot.updatedAt.timeIntervalSince1970,
            WatchPayloadKey.quickTasks: tasks,
        ]

        // [T-watch-signature-count-only] Dedupe on the actual payload. The
        // signature only counted the tasks, so renaming a quick task or
        // changing its icon produced an identical signature and the watch kept
        // showing the old label indefinitely.
        let taskSignature = tasks.map { $0.joined(separator: "\u{1}") }.joined(separator: "\u{2}")
        let signature = "\(snapshot.state.rawValue)|\(snapshot.activeCount)|\(snapshot.title)|\(snapshot.status)|\(taskSignature)"
        guard signature != lastPushedSignature else { return }
        lastPushedSignature = signature

        do {
            try session.updateApplicationContext(context)
            logger.info("pushed status to watch state=\(snapshot.state.rawValue) active=\(snapshot.activeCount)")
        } catch {
            logger.error("watch context push failed: \(error.localizedDescription)")
        }
    }
}

extension WatchBridge: WCSessionDelegate {
    nonisolated func session(
        _ session: WCSession,
        activationDidCompleteWith activationState: WCSessionActivationState,
        error: Error?
    ) {
        if let error {
            logger.error("WCSession activation failed: \(error.localizedDescription)")
            return
        }
        logger.info("WCSession activated state=\(activationState.rawValue)")
        Task { @MainActor in
            // [T-watch-signature-reset] A just-paired watch has an EMPTY
            // application context; if the signature happened to match the last
            // push to the previous watch, the dedupe skipped the send and the
            // new watch stayed blank until the agent state next changed.
            WatchBridge.shared.resetDedupe()
            WatchBridge.shared.pushStatus()
        }
    }

    #if os(iOS)
    nonisolated func sessionDidBecomeInactive(_ session: WCSession) {}

    nonisolated func sessionDidDeactivate(_ session: WCSession) {
        // Re-activate so a switched watch keeps working.
        Task { @MainActor in WatchBridge.shared.resetDedupe() }
        session.activate()
    }
    #endif

    /// Watch asked us to run a quick task. Route it through the same runner
    /// the widget button uses so badges, briefing capture and keep-alive all
    /// behave identically no matter which surface started the run.
    nonisolated func session(
        _ session: WCSession,
        didReceiveMessage message: [String: Any],
        replyHandler: @escaping ([String: Any]) -> Void
    ) {
        let kind = message[WatchPayloadKey.kind] as? String
        if kind == WatchPayloadKey.kindAsk {
            let requestId = (message[WatchPayloadKey.requestId] as? String) ?? UUID().uuidString
            let text = (message[WatchPayloadKey.text] as? String) ?? ""
            let sessionId = message[WatchPayloadKey.sessionId] as? String
            replyHandler(["ok": !text.isEmpty])
            guard !text.isEmpty else { return }
            Task { @MainActor in
                await WatchAskRunner.run(requestId: requestId, prompt: text, sessionId: sessionId)
            }
            return
        }
        if kind == WatchPayloadKey.kindTranscript {
            let sessionId = (message[WatchPayloadKey.sessionId] as? String) ?? ""
            Task { @MainActor in
                let lines = await WatchAskRunner.transcript(sessionId: sessionId)
                replyHandler([WatchPayloadKey.text: lines])
            }
            return
        }
        if kind == WatchPayloadKey.kindStopSession {
            let sessionId = (message[WatchPayloadKey.sessionId] as? String) ?? ""
            Task { @MainActor in
                ViewModelCache.shared.get(for: sessionId)?.cancel(queuePolicy: .discardQueuedPrompts)
                WatchBridge.shared.resetDedupe()
                WatchBridge.shared.pushStatus()
            }
            replyHandler(["ok": true])
            return
        }
        if kind == WatchPayloadKey.kindScheduledRun || kind == WatchPayloadKey.kindScheduledToggle {
            let id = (message[WatchPayloadKey.sessionId] as? String) ?? ""
            let isRun = (kind == WatchPayloadKey.kindScheduledRun)
            Task { @MainActor in
                if isRun {
                    if let task = ScheduledTaskStore.shared.tasks.first(where: { $0.id == id }) {
                        _ = await QuickTaskWidgetRunner.run(taskId: task.quickTaskId)
                    }
                } else {
                    if let task = ScheduledTaskStore.shared.tasks.first(where: { $0.id == id }) {
                        ScheduledTaskStore.shared.setEnabled(!task.isEnabled, id: id)
                    }
                }
                WatchBridge.shared.resetDedupe()
                WatchBridge.shared.pushStatus()
            }
            replyHandler(["ok": true])
            return
        }
        if kind == WatchPayloadKey.kindStopAll {
            Task { @MainActor in
                await WidgetIntentBridge.shared.stopAllTasks()
                WatchBridge.shared.resetDedupe()
                WatchBridge.shared.pushStatus()
            }
            replyHandler(["ok": true])
            return
        }
        guard (message[WatchPayloadKey.kind] as? String) == WatchPayloadKey.kindRunQuickTask,
              let taskId = message[WatchPayloadKey.taskId] as? String else {
            replyHandler(["ok": false])
            return
        }
        // [T-watch-reply-before-dispatch] The reply used to be sent here,
        // synchronously, before the task had even been looked up — so the watch
        // said "started on iPhone" for a task id that did not exist, or for a
        // run that failed immediately. Worse: a watch message often wakes the
        // iPhone app from not-running, and returning the reply releases the
        // process assertion that delivery holds, so the work could be suspended
        // before it began. Reply only once the run has actually been dispatched,
        // and report what really happened.
        Task { @MainActor in
            let started = await QuickTaskWidgetRunner.run(taskId: taskId)
            WatchBridge.shared.pushStatus()
            replyHandler(["ok": started])
        }
    }
}

#else

/// Stub so call sites don't need availability checks on platforms without
/// WatchConnectivity.
@MainActor
final class WatchBridge {
    static let shared = WatchBridge()
    func activate() {}
    func pushStatus() {}
}

#endif

// MARK: - Watch payload builders

extension WatchBridge {
    /// Top sessions for the wrist: id, title, state, unread. Small and cold —
    /// rides the same deduped application context as everything else.
    @MainActor static func sessionsPayload() -> [[String]] {
        let items = WidgetRecentSessionsStore.load().prefix(5)
        return items.map { item in
            let running = SessionActivityTracker.shared.activeSessions.contains(item.id)
            let unread = SessionBadgeStore.shared.badgeStates[item.id]?.contains(.unread) ?? false
            return [item.id, item.title, running ? "running" : "idle", unread ? "1" : "0"]
        }
    }

    @MainActor static func scheduledPayload() -> [[String]] {
        ScheduledTaskStore.shared.tasks.prefix(6).map { task in
            let name = QuickTaskStore.shared.definition(for: task.quickTaskId)?.displayName ?? task.quickTaskId
            return [task.id, name, "\(task.cadence.title) \(task.timeText)", task.isEnabled ? "1" : "0"]
        }
    }
}

/// [T-watch-ask] Runs a wrist-dictated prompt through the ordinary agent
/// loop (new session, or follow-up into an existing one) and delivers the
/// final assistant text back to the watch.
@MainActor
enum WatchAskRunner {
    static func run(requestId: String, prompt: String, sessionId: String?) async {
        let previousActive = AIChatViewModel.activeSessionId
        let vm: AIChatViewModel
        if let sessionId, !sessionId.isEmpty {
            vm = ViewModelCache.shared.getOrCreate(for: sessionId).0
        } else {
            vm = ViewModelCache.shared.createDraft()
        }
        vm.sessionSource = "watch"
        await vm.ensureSessionReturningId()
        AIChatViewModel.activeSessionId = previousActive
        guard let sid = vm.sessionId else {
            deliver(requestId: requestId, text: "无法创建会话。")
            return
        }
        vm.inputText = prompt
        vm.send()
        // Wait for the run to settle (same observation pattern as the widget
        // runner): give it up to 3 minutes, then report whatever exists.
        for _ in 0..<360 {
            try? await Task.sleep(nanoseconds: 500_000_000)
            if !SessionActivityTracker.shared.activeSessions.contains(sid),
               !SessionActivityTracker.shared.isActive(sid) { break }
        }
        let reply = await lastAssistantText(sessionId: sid, limit: 2000)
        deliver(requestId: requestId,
                text: reply.isEmpty ? "任务已执行，但没有产生文本回复。可在 iPhone 上查看会话。" : reply)
        WatchBridge.shared.resetDedupe()
        WatchBridge.shared.pushStatus()
    }

    static func transcript(sessionId: String) async -> String {
        let messages = await ChatStore.shared.loadMessages(sessionId: sessionId)
        let recent = messages.suffix(6)
        var lines: [String] = []
        for message in recent {
            let text = message.parts.compactMap { part -> String? in
                if case .text(let value) = part { return value }
                return nil
            }.joined(separator: " ")
            guard !text.isEmpty else { continue }
            let speaker = message.role == .user ? "你" : "Leo"
            lines.append("\(speaker): \(String(text.prefix(400)))")
        }
        return lines.isEmpty ? "（此会话暂无文本内容）" : lines.joined(separator: "\n\n")
    }

    private static func lastAssistantText(sessionId: String, limit: Int) async -> String {
        let messages = await ChatStore.shared.loadMessages(sessionId: sessionId)
        guard let last = messages.last(where: { $0.role == .assistant }) else { return "" }
        let text = last.parts.compactMap { part -> String? in
            if case .text(let value) = part { return value }
            return nil
        }.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
        return String(text.prefix(limit))
    }

    private static func deliver(requestId: String, text: String) {
        WatchBridge.shared.sendAskReply(requestId: requestId, text: text)
    }
}
