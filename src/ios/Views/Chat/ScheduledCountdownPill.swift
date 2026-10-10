import SwiftUI

// [F2-countdown] 「下次应运行 · 还有 2 小时」. The wording is deliberately
// "should run": iOS does not wake the app on a clock, so a due task runs the
// next time the app is awake. Long-press → 立即运行 goes through the same
// ScheduledTaskRunner.runDueTasks path the reconcile uses.

struct ScheduledCountdownPill: View {
    let task: ScheduledTask
    /// Shown before the countdown (the follow-up title in the chat header).
    var label: String?
    /// "+N" when more follow-ups are waiting in the same conversation.
    var moreCount: Int = 0

    var body: some View {
        TimelineView(.periodic(from: .now, by: 30)) { context in
            if let text = task.countdownText(now: context.date) {
                pill(text)
            }
        }
    }

    private func pill(_ text: String) -> some View {
        HStack(spacing: 5) {
            Image(systemName: "clock")
                .font(.system(size: 10, weight: .semibold))
            if let label, !label.isEmpty {
                Text(label).fontWeight(.semibold).lineLimit(1)
                Text(verbatim: "·")
            }
            Text(text).lineLimit(1)
            if moreCount > 0 {
                Text(verbatim: "+\(moreCount)").foregroundStyle(.secondary)
            }
        }
        .font(.system(size: 11))
        .foregroundStyle(Color.orange)
        .padding(.horizontal, 10)
        .padding(.vertical, 4)
        .background(Color.orange.opacity(0.10), in: Capsule())
        .contentShape(Capsule())
        .contextMenu {
            Button { Self.runNow(task) } label: {
                Label(String(localized: "立即运行"), systemImage: "play.fill")
            }
            if task.isFollowUp {
                Button(role: .destructive) { Self.cancel(task) } label: {
                    Label(String(localized: "取消这条跟进"), systemImage: "xmark.circle")
                }
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityHint(Text(String(localized: "长按可立即运行")))
        .accessibilityAction(named: Text(String(localized: "立即运行"))) { Self.runNow(task) }
    }

    @MainActor
    static func runNow(_ task: ScheduledTask) {
        LeoHaptics.selection()
        Task { @MainActor in
            let started = await ScheduledTaskRunner.runDueTasks(reason: "runNow", forceTaskId: task.id)
            MinisToast.show(started > 0
                            ? String(localized: "已开始运行")
                            : String(localized: "现在没能运行,会话可能正忙,稍后再试"))
        }
    }

    @MainActor
    static func cancel(_ task: ScheduledTask) {
        ScheduledFollowUpDispatcher.cancelReminder(taskId: task.id)
        ScheduledTaskStore.shared.delete(id: task.id)
        LeoHaptics.selection()
    }
}

/// Chat header: the soonest pending follow-up of this conversation.
struct ScheduledFollowUpHeaderPill: View {
    let sessionId: String?
    @ObservedObject private var store = ScheduledTaskStore.shared

    var body: some View {
        let pending = sessionId.map { store.pendingFollowUps(sessionId: $0) } ?? []
        if let first = pending.min(by: Self.sooner) {
            ScheduledCountdownPill(task: first, label: first.followUp?.title, moreCount: pending.count - 1)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 4)
        }
    }

    /// once-follow-ups by due time first; after-completion ones last.
    private static func sooner(_ a: ScheduledTask, _ b: ScheduledTask) -> Bool {
        (a.followUp?.fireAt ?? .distantFuture) < (b.followUp?.fireAt ?? .distantFuture)
    }
}
