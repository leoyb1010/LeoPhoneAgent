//
//  ScheduledFollowUpDispatcher.swift
//  MinisApp
//
//  [F2-self-schedule] App-side half of the agent's self-scheduled follow-ups:
//  the `schedule_followup` tool handler, delivery into the session (the same
//  headless follow-up path Shortcuts uses), the "safety" reminder notification
//  at the due time, and the after-completion observer that kicks the ledger's
//  reconcile once the current run ends.
//

import Foundation
import UserNotifications

private let logger = AppLogger(category: "ScheduledFollowUp")

@MainActor
enum ScheduledFollowUpDispatcher {
    enum DispatchError: Error {
        case sessionMissing
        case busy
    }

    // MARK: Tool

    /// Handles a `schedule_followup` call from `vm`. Returns (output, success).
    static func handleTool(argsJson: String, vm: AIChatViewModel) async -> (String, Bool) {
        // Defence in depth: the tool is not even offered in these contexts.
        guard AgentToolToggles.selfSchedulingEnabled else {
            return ("Error: scheduling follow-ups is turned off in Settings › Tool Switches.", false)
        }
        guard !vm.isSubAgentChild, !vm.blocksSideEffectTools, vm.remoteDeviceId == nil else {
            return ("Error: sub agents and unattended turns cannot schedule follow-ups.", false)
        }
        guard let sessionId = vm.sessionId, !sessionId.isEmpty else {
            return ("Error: this conversation has no saved session yet.", false)
        }
        let args = (try? JSONSerialization.jsonObject(with: Data(argsJson.utf8)) as? [String: Any]) ?? [:]
        let now = Date()
        let runId = AgentActivityLog.shared.latestRunState(sessionId: sessionId).flatMap {
            $0.phase.isTerminal ? nil : $0.runId
        }
        let followUp: ScheduledFollowUp
        switch ScheduledFollowUp.parse(args, sessionId: sessionId, currentRunId: runId, now: now) {
        case .failure(let error): return (error.message, false)
        case .success(let parsed): followUp = parsed
        }
        switch ScheduledTaskStore.shared.addFollowUp(followUp, now: now) {
        case .failure(let error):
            return (error.message, false)
        case .success(let task):
            logger.info("follow-up scheduled id=\(task.id.prefix(8)) trigger=\(followUp.trigger.rawValue)")
            switch followUp.trigger {
            case .once:
                scheduleReminder(for: task)
                let when = followUp.fireAt.map { Self.localStamp.string(from: $0) } ?? "?"
                return ("Scheduled follow-up \"\(followUp.title)\" for \(when) (device local time). It runs in this conversation the next time LeoBot is awake at or after that time — not to the second. A reminder notification fires at the due time in case the app is not woken. The user can see and remove it in Settings › Scheduled Tasks.", true)
            case .afterCompletion:
                observeCompletion(of: task)
                return ("Scheduled follow-up \"\(followUp.title)\" to run in this conversation right after the current turn finishes (only if it finishes normally). End your turn now; do not wait for it.", true)
            }
        }
    }

    static let localStamp: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy-MM-dd HH:mm"
        return formatter
    }()

    // MARK: Run receipts

    static func runEnd(_ runId: String) -> ScheduledFollowUp.RunEnd {
        guard let state = AgentActivityLog.shared.runState(runId: runId) else { return .completed }
        switch state.phase {
        case .completed: return .completed
        case .failed, .cancelled, .unverified: return .notCompleted
        default: return .running
        }
    }

    /// After-completion: wait (bounded) for the turn that scheduled it to end,
    /// then reconcile. If the app is suspended first, the next foreground or
    /// Shortcuts reconcile picks it up from the ledger.
    private static func observeCompletion(of task: ScheduledTask) {
        guard let followUp = task.followUp else { return }
        Task { @MainActor in
            if let runId = followUp.afterRunId {
                _ = await SendPromptIntent.waitForRun(runId: runId)
            } else if let vm = ViewModelCache.shared.get(for: followUp.sessionId) {
                for _ in 0..<900 where vm.isProcessing {
                    try? await Task.sleep(for: .seconds(1))
                }
            }
            // Let the finishing turn release the session before we send into it.
            try? await Task.sleep(for: .seconds(1))
            await ScheduledTaskRunner.runDueTasks(reason: "afterCompletion")
        }
    }

    // MARK: Delivery

    /// Sends the follow-up into its session. Returns the new run's id.
    static func send(_ followUp: ScheduledFollowUp, taskId: String) async throws -> String {
        let sessionId = followUp.sessionId
        guard await ChatStore.shared.sessionExists(id: sessionId) else { throw DispatchError.sessionMissing }
        if let cached = ViewModelCache.shared.get(for: sessionId), cached.isProcessing || cached.isCompacting {
            throw DispatchError.busy
        }
        BackgroundKeepAliveManager.shared.setup()
        let eager = BackgroundKeepAliveManager.shared.armEagerlyForShortcut(
            sessionId: sessionId, caller: "ScheduledFollowUp")
        let pendingId = ShortcutRunTracker.markPending(
            intent: "ScheduledFollowUp", sessionId: sessionId,
            eagerKeepAliveArmed: eager.armed, eagerKeepAliveSkippedReason: eager.skipReason)
        await MountedFoldersManager.shared.ensureActivated(timeout: 12)
        let (vm, isNew) = ViewModelCache.shared.getOrCreate(for: sessionId)
        if isNew {
            // Background action: keep "the session on screen" pointing at what the user is looking at.
            let onScreen = AIChatViewModel.activeSessionId
            await vm.loadSession()
            AIChatViewModel.activeSessionId = onScreen
        }
        guard !vm.isProcessing else {
            ShortcutRunTracker.markCompleted(recordId: pendingId, reason: "busy")
            throw DispatchError.busy
        }
        TaskSourceRegistry.setPending(.scheduled)
        defer { TaskSourceRegistry.setPending(nil) }
        let runId = try vm.withComposerSetAside {
            vm.inputText = followUp.deliveredPrompt
            return try SendPromptIntent.dispatchRun(vm: vm, sessionId: sessionId, pendingId: pendingId) { vm.send() }
        }
        Task { @MainActor in
            let outcome = await SendPromptIntent.waitForRun(runId: runId)
            if !outcome.shouldKeepObserving {
                ShortcutRunTracker.markCompleted(recordId: pendingId, reason: outcome.rawValue)
            }
            let text = outcome == .succeeded
                ? await AgentRunResultReader.text(sessionId: sessionId, runId: runId) : ""
            ScheduledTaskStore.shared.recordOutcome(
                id: taskId, status: outcome == .succeeded ? .success : .failure,
                preview: text.isEmpty ? outcome.summary : text)
            guard !outcome.shouldKeepObserving else { return }
            let hidden = SessionLockStore.isHiddenFromSystemSurfaces(sessionId)
            ScheduledTaskRunner.notify(
                title: String(localized: "定时跟进已完成:\(followUp.title)"),
                body: hidden ? String(localized: "打开 LeoBot 查看结果") : String(text.prefix(200)),
                sessionId: sessionId)
        }
        return runId
    }

    // MARK: Safety reminder

    static func reminderId(_ taskId: String) -> String { "scheduled-followup-\(taskId)" }

    /// A local notification at the due time: if nothing woke the app, the user
    /// is still told the follow-up is waiting and one tap opens the session.
    static func scheduleReminder(for task: ScheduledTask) {
        guard let followUp = task.followUp, followUp.trigger == .once,
              let fireAt = followUp.fireAt, fireAt > Date() else { return }
        let content = UNMutableNotificationContent()
        content.title = String(localized: "定时跟进到点了")
        content.body = SessionLockStore.isHiddenFromSystemSurfaces(followUp.sessionId)
            ? String(localized: "打开 LeoBot 运行它")
            : String(localized: "「\(followUp.title)」· 打开 LeoBot 运行它")
        content.sound = .default
        content.userInfo["sessionId"] = followUp.sessionId
        content.applyFocusQuiet()
        let comps = Calendar.current.dateComponents([.year, .month, .day, .hour, .minute, .second], from: fireAt)
        let trigger = UNCalendarNotificationTrigger(dateMatching: comps, repeats: false)
        UNUserNotificationCenter.current().add(UNNotificationRequest(
            identifier: reminderId(task.id), content: content, trigger: trigger))
    }

    static func cancelReminder(taskId: String) {
        UNUserNotificationCenter.current().removePendingNotificationRequests(withIdentifiers: [reminderId(taskId)])
    }
}

// MARK: - [F2-tool-toggles] View-model hooks (one call site each)

extension AIChatViewModel {
    /// Hook in `makeAgentTools`: drops switched-off tools and offers
    /// `schedule_followup` to top-level, attended, on-device conversations.
    func applyToolToggles(_ tools: [AgentToolDefinition]) -> [AgentToolDefinition] {
        let offer = AgentToolToggles.offersSelfScheduling(
            enabled: AgentToolToggles.selfSchedulingEnabled, isSubAgentChild: isSubAgentChild,
            blocksSideEffectTools: blocksSideEffectTools, isRemote: remoteDeviceId != nil)
        return AgentToolToggles.apply(tools, name: \.name, browserUse: AgentToolToggles.browserUseEnabled,
                                      selfScheduling: offer ? ScheduledFollowUp.toolDefinition : nil)
    }

    /// Hook in `composeUserSystemPrompt` (stable part): empty unless a switch is off.
    var toolTogglesPromptFragment: String {
        AgentToolToggles.promptFragment(browserUse: AgentToolToggles.browserUseEnabled).map { "\n\n" + $0 } ?? ""
    }
}
