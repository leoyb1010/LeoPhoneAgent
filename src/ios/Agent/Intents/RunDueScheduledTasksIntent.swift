import AppIntents
import Foundation

/// [T-scheduled-tasks] The wakeup half of the schedule.
///
/// iOS will not wake this app on a wall clock, but Shortcuts *personal
/// automations* will — "every day at 08:00, run this action". Pointing such
/// an automation at this intent turns the ledger in `ScheduledTaskStore` into
/// something that actually fires on time, while the same reconcile also runs
/// on app foreground so a missed automation is caught up rather than lost.
///
/// Conforms to `LiveActivityIntent` so the system performs it in the app's
/// process (a plain AppIntent from an automation can be run out-of-process,
/// where the agent loop is unreachable). Starting a task does start a Live
/// Activity, so the conformance is accurate.
@available(iOS 17.0, *)
struct RunDueScheduledTasksIntent: LiveActivityIntent {
    static var title: LocalizedStringResource = "Run Due Scheduled Tasks"
    static var description = IntentDescription(
        "Runs any LeoPhoneAgent scheduled task whose time has come. Point a Shortcuts personal automation at this to get reliable timed runs."
    )
    static var openAppWhenRun = false

    @MainActor
    func perform() async throws -> some IntentResult & ReturnsValue<Int> & ProvidesDialog {
        let started = await ScheduledTaskRunner.runDueTasks(reason: "shortcutsAutomation")
        let dialog: IntentDialog = started == 0
            ? IntentDialog("No scheduled tasks are due right now.")
            : IntentDialog("Started \(started) scheduled task(s).")
        return .result(value: started, dialog: dialog)
    }
}
