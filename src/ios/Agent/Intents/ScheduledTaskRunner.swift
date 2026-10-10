//
//  ScheduledTaskRunner.swift
//  MinisApp
//
//  [T-scheduled-tasks] Reconciles the schedule ledger against the clock.
//  Called from every moment we are known to be alive — app foreground, and
//  the `RunDueScheduledTasksIntent` a Shortcuts personal automation can fire.
//  Idempotent by slot, so calling it repeatedly is harmless.
//

import Foundation
import UserNotifications
import WidgetKit

private let logger = AppLogger(category: "ScheduledTask")

enum ScheduledTaskRunner {
    /// [T-schedule-reentrancy] A reconcile pass suspends on every `execute`, so
    /// a foreground reconcile and the Shortcuts automation's
    /// `RunDueScheduledTasksIntent` can interleave. Each held its own snapshot
    /// of `due` taken before the other claimed anything, so a task could be
    /// dispatched twice for one slot. One pass at a time, and re-check each
    /// task against the live store before dispatching it.
    @MainActor private static var isReconciling = false

    /// Runs every task whose slot has come due. Returns how many started.
    /// `forceTaskId`: the countdown pill's long-press「立即运行」— that one task
    /// runs now through this same path even though it is not due. A recurring
    /// task run this way keeps its schedule (its slot is not consumed).
    @discardableResult
    @MainActor
    static func runDueTasks(reason: String, forceTaskId: String? = nil) async -> Int {
        guard !isReconciling else {
            logger.info("reconcile reason=\(reason) SKIPPED — already running")
            return 0
        }
        isReconciling = true
        defer { isReconciling = false }

        let store = ScheduledTaskStore.shared
        let now = Date()
        expireStaleFollowUps(store: store, now: now)
        let due: [ScheduledTask]
        if let forceTaskId {
            due = store.tasks.filter { $0.id == forceTaskId && ($0.followUp == nil || $0.isPendingFollowUp) }
        } else {
            due = store.dueTasks(now: now, runEnd: ScheduledFollowUpDispatcher.runEnd)
        }
        guard !due.isEmpty else { return 0 }

        logger.info("reconcile reason=\(reason) due=\(due.count)")
        var started = 0

        for task in due {
            let forced = task.id == forceTaskId
            // Re-read from the store: an earlier iteration's await may have let
            // the user disable or delete this one.
            guard let task = store.tasks.first(where: { $0.id == task.id }) else { continue }
            if let followUp = task.followUp {
                guard task.isPendingFollowUp,
                      forced || task.followUpReadiness(now: now, runEnd: ScheduledFollowUpDispatcher.runEnd) == .due
                else { continue }
                if await runFollowUp(task, followUp: followUp, store: store, now: now) { started += 1 }
                continue
            }
            guard forced || task.isDue(now: now) else { continue }
            guard let slot = forced ? now : task.mostRecentDueSlot(now: now) else { continue }
            guard let definition = QuickTaskStore.shared.definition(for: task.quickTaskId) else {
                // The quick task was deleted out from under the schedule.
                // Mark the slot consumed so we don't retry forever, and
                // disable it so the UI can show why nothing happens.
                logger.error("scheduled task \(task.id) references missing quick task \(task.quickTaskId) — disabling")
                if !forced { store.markRun(id: task.id, slot: slot) }
                store.recordStart(id: task.id, sessionId: nil)
                store.recordOutcome(id: task.id, status: .skipped, preview: "对应的快捷任务已删除")
                store.setEnabled(false, id: task.id)
                continue
            }

            // Claim the slot BEFORE dispatching. If the run itself crashes or
            // the app is killed mid-flight we must not fire the same slot
            // again on next launch. [T-schedule-lastrun-flag] Claim it as
            // "not yet succeeded" and upgrade below — writing `true` up front
            // meant the flag only ever said true and told the user nothing.
            if !forced { store.markRun(id: task.id, slot: slot) }

            let widgetRequestId = UUID().uuidString
            WidgetQuickTasksStore.beginRun(id: definition.id, requestId: widgetRequestId)
            do {
                TaskSourceRegistry.setPending(.scheduled)
                defer { TaskSourceRegistry.setPending(nil) }
                let result = try await QuickTaskIntent.execute(
                    definition: definition,
                    files: nil,
                    model: nil,
                    waitForResult: false,
                    inputValues: [:]
                )
                started += 1
                if !forced { store.markRun(id: task.id, slot: slot) }
                // [E3] 记下这次运行的会话；回复落地后由 resolvePendingBriefings 回写摘要与状态。
                let startedSession = result.value?.sessionId
                store.recordStart(id: task.id, sessionId: startedSession?.isEmpty == false ? startedSession : nil)
                if let sessionId = result.value?.sessionId, !sessionId.isEmpty {
                    if let runId = result.value?.runId, !runId.isEmpty {
                        WidgetQuickTasksStore.bindRun(id: definition.id, requestId: widgetRequestId,
                                                     runId: runId, sessionId: sessionId)
                    }
                    // Reuse the widget briefing pipeline so a scheduled run's
                    // result lands on the Home Screen the same way a manual
                    // one does.
                    WidgetPendingBriefingStore.add(
                        sessionId: sessionId, taskName: definition.displayName,
                        origin: "scheduled", runId: result.value?.runId, taskId: definition.id)
                }
                logger.info("started scheduled task \(task.id) (\(definition.displayName)) slot=\(slot)")
            } catch {
                WidgetQuickTasksStore.updateRunState(id: definition.id, state: .failed,
                                                    requestId: widgetRequestId)
                if !forced { store.markRun(id: task.id, slot: slot) }
                store.recordStart(id: task.id, sessionId: nil)
                store.recordOutcome(id: task.id, status: .failure, preview: error.localizedDescription)
                logger.error("scheduled task \(task.id) failed to start: \(error.localizedDescription)")
                // [T-scheduled-report] The other half of "scheduled work WITH
                // reporting": a silent failure is indistinguishable from
                // "never ran".
                Self.notify(
                    title: String(localized: "Scheduled task failed to start"),
                    body: definition.displayName,
                    sessionId: nil)
            }
        }

        if started > 0 {
            WidgetCenter.shared.reloadTimelines(ofKind: LeoWidgetKind.quickTasks)
            WidgetCenter.shared.reloadTimelines(ofKind: LeoWidgetKind.iPadConsole)
        }
        return started
    }

    /// [F2-self-schedule] One follow-up: deliver into its session, then consume
    /// it in the same main-actor turn the run was accepted. A busy session is
    /// not a failure — the follow-up stays pending for the next reconcile.
    @MainActor
    private static func runFollowUp(_ task: ScheduledTask, followUp: ScheduledFollowUp,
                                    store: ScheduledTaskStore, now: Date) async -> Bool {
        do {
            let runId = try await ScheduledFollowUpDispatcher.send(followUp, taskId: task.id)
            store.markRun(id: task.id, slot: followUp.fireAt ?? now)
            store.setEnabled(false, id: task.id)
            store.recordStart(id: task.id, sessionId: followUp.sessionId)
            ScheduledFollowUpDispatcher.cancelReminder(taskId: task.id)
            logger.info("started follow-up \(task.id.prefix(8)) run=\(runId.prefix(8))")
            return true
        } catch ScheduledFollowUpDispatcher.DispatchError.busy {
            // The session is mid-turn: leave it pending; the next reconcile retries.
            logger.info("follow-up \(task.id.prefix(8)) deferred — session busy")
            return false
        } catch ScheduledFollowUpDispatcher.DispatchError.sessionMissing {
            store.expireFollowUp(id: task.id, reason: String(localized: "对应的会话已删除"), now: now)
            ScheduledFollowUpDispatcher.cancelReminder(taskId: task.id)
            return false
        } catch {
            store.expireFollowUp(id: task.id, reason: error.localizedDescription, now: now)
            store.recordOutcome(id: task.id, status: .failure, preview: error.localizedDescription)
            ScheduledFollowUpDispatcher.cancelReminder(taskId: task.id)
            logger.error("follow-up \(task.id.prefix(8)) failed to start")
            Self.notify(title: String(localized: "定时跟进没能开始"), body: followUp.title, sessionId: followUp.sessionId)
            return false
        }
    }

    /// Follow-ups that will never run (missed by >26 h, or the awaited run did
    /// not finish normally) are consumed with a reason instead of lingering.
    @MainActor
    private static func expireStaleFollowUps(store: ScheduledTaskStore, now: Date) {
        for task in store.tasks where task.isPendingFollowUp {
            if case .expired(let reason) = task.followUpReadiness(now: now, runEnd: ScheduledFollowUpDispatcher.runEnd) {
                store.expireFollowUp(id: task.id, reason: reason, now: now)
                ScheduledFollowUpDispatcher.cancelReminder(taskId: task.id)
            }
        }
    }
}

extension ScheduledTaskRunner {
    static let notifyDefaultsKey = "leo.scheduledTasks.notifyOnComplete"

    /// User decision 2026-07-29: default ON.
    static var notifyEnabled: Bool {
        (UserDefaults.standard.object(forKey: notifyDefaultsKey) as? Bool) ?? true
    }

    /// [T-scheduled-report] Local completion/failure notification. Tapping it
    /// deep-links into the session via the existing sessionId routing in
    /// ShortcutNotificationDelegate.
    /// `gated`=true respects the scheduled-task notification toggle; pass
    /// false for channels with their own semantics (automations, installs) —
    /// the toggle used to silently swallow those too. [T-notify-gate]
    static func notify(title: String, body: String, sessionId: String?, gated: Bool = true) {
        if gated { guard notifyEnabled else { return } }
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.sound = .default
        if let sessionId { content.userInfo["sessionId"] = sessionId }
        content.applyFocusQuiet()
        UNUserNotificationCenter.current().add(UNNotificationRequest(
            identifier: "scheduled-report-\(UUID().uuidString)",
            content: content, trigger: nil))
    }
}
