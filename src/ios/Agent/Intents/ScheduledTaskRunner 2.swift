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
    @discardableResult
    @MainActor
    static func runDueTasks(reason: String) async -> Int {
        guard !isReconciling else {
            logger.info("reconcile reason=\(reason) SKIPPED — already running")
            return 0
        }
        isReconciling = true
        defer { isReconciling = false }

        let store = ScheduledTaskStore.shared
        let now = Date()
        let due = store.dueTasks(now: now)
        guard !due.isEmpty else { return 0 }

        logger.info("reconcile reason=\(reason) due=\(due.count)")
        var started = 0

        for task in due {
            // Re-read from the store: an earlier iteration's await may have let
            // the user disable or delete this one.
            guard let task = store.tasks.first(where: { $0.id == task.id }),
                  task.isDue(now: now) else { continue }
            guard let slot = task.mostRecentDueSlot(now: now) else { continue }
            guard let definition = QuickTaskStore.shared.definition(for: task.quickTaskId) else {
                // The quick task was deleted out from under the schedule.
                // Mark the slot consumed so we don't retry forever, and
                // disable it so the UI can show why nothing happens.
                logger.error("scheduled task \(task.id) references missing quick task \(task.quickTaskId) — disabling")
                store.markRun(id: task.id, slot: slot)
                store.setEnabled(false, id: task.id)
                continue
            }

            // Claim the slot BEFORE dispatching. If the run itself crashes or
            // the app is killed mid-flight we must not fire the same slot
            // again on next launch. [T-schedule-lastrun-flag] Claim it as
            // "not yet succeeded" and upgrade below — writing `true` up front
            // meant the flag only ever said true and told the user nothing.
            store.markRun(id: task.id, slot: slot)

            do {
                let result = try await QuickTaskIntent.execute(
                    definition: definition,
                    files: nil,
                    model: nil,
                    waitForResult: false,
                    inputValues: [:]
                )
                started += 1
                store.markRun(id: task.id, slot: slot)
                if let sessionId = result.value?.sessionId, !sessionId.isEmpty {
                    // Reuse the widget briefing pipeline so a scheduled run's
                    // result lands on the Home Screen the same way a manual
                    // one does.
                    WidgetPendingBriefingStore.add(
                        sessionId: sessionId, taskName: definition.displayName,
                        origin: "scheduled")
                }
                logger.info("started scheduled task \(task.id) (\(definition.displayName)) slot=\(slot)")
            } catch {
                store.markRun(id: task.id, slot: slot)
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
        UNUserNotificationCenter.current().add(UNNotificationRequest(
            identifier: "scheduled-report-\(UUID().uuidString)",
            content: content, trigger: nil))
    }
}
