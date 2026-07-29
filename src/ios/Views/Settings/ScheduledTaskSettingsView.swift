//
//  ScheduledTaskSettingsView.swift
//  MinisApp
//
//  [T-scheduled-tasks] Manage recurring quick tasks. The copy is deliberately
//  honest about the mechanism: iOS cannot guarantee a wall-clock wakeup, so
//  the app reconciles on launch and the user can opt into a Shortcuts
//  automation for punctual firing.
//

import SwiftUI

struct ScheduledTaskSettingsView: View {
    @ObservedObject private var store = ScheduledTaskStore.shared
    @ObservedObject private var quickTasks = QuickTaskStore.shared
    @State private var editing: ScheduledTask?
    @State private var showCreate = false
    @State private var runNowMessage: String?

    var body: some View {
        List {
            Section {
                if store.tasks.isEmpty {
                    Text("No scheduled tasks yet. Tap + to add one — for example, run “Morning Briefing” at 8 AM every day.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                } else {
                    ForEach(store.tasks) { task in
                        Button {
                            editing = task
                        } label: {
                            row(task)
                        }
                        .buttonStyle(.plain)
                    }
                    .onDelete { offsets in
                        // [T-ondelete-index-shift] Resolve ids FIRST.
                        // `store.delete` shrinks the published array, so on a
                        // multi-row delete the second lookup indexed a shifted
                        // array — wrong row removed, or an out-of-range crash.
                        let ids = offsets.map { store.tasks[$0].id }
                        for id in ids { store.delete(id: id) }
                    }
                }
            } header: {
                Text("Scheduled Tasks")
            } footer: {
                Text("iOS does not let an app wake itself on a clock, so due tasks run at one of two moments: automatically when you open the app, or on time via a Shortcuts personal automation you set up. Tasks more than 26 hours overdue are skipped rather than all firing at once.")
            }

            Section {
                Button {
                    Task {
                        let n = await ScheduledTaskRunner.runDueTasks(reason: "manual")
                        runNowMessage = n == 0 ? String(localized: "No tasks are due right now") : String(localized: "Started \(n) task(s)")
                    }
                } label: {
                    Label("Check and run due tasks now", systemImage: "arrow.clockwise")
                }
                if let runNowMessage {
                    Text(runNowMessage)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }

            Section {
                stepRow(1, String(localized: "Open the Shortcuts app → Automation → New"))
                stepRow(2, String(localized: "Choose “Time of Day” and set the time you want (e.g. 08:00 daily)"))
                stepRow(3, String(localized: "For the action, search LeoPhoneAgent and pick “Run Due Scheduled Tasks”"))
                stepRow(4, String(localized: "Turn off “Ask Before Running” and save"))
            } header: {
                Text("Make it fire on time (recommended)")
            } footer: {
                Text("With this set up, Shortcuts wakes the app at the chosen time even if it is closed. Without it things still work — due tasks just wait until you next open the app.")
            }
        }
        .navigationTitle("Scheduled Tasks")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    showCreate = true
                } label: {
                    Image(systemName: "plus")
                }
                .disabled(quickTasks.tasks.isEmpty)
            }
        }
        .sheet(isPresented: $showCreate) {
            ScheduledTaskEditorView(existing: nil)
        }
        .sheet(item: $editing) { task in
            ScheduledTaskEditorView(existing: task)
        }
    }

    private func row(_ task: ScheduledTask) -> some View {
        let name = quickTasks.definition(for: task.quickTaskId)?.displayName ?? String(localized: "(task deleted)")
        return HStack(spacing: 12) {
            Image(systemName: quickTasks.definition(for: task.quickTaskId)?.symbolName ?? "questionmark")
                .frame(width: 26)
                .foregroundStyle(task.isEnabled ? Color.accentColor : .secondary)
            VStack(alignment: .leading, spacing: 2) {
                Text(name)
                    .font(.body)
                    .foregroundStyle(task.isEnabled ? .primary : .secondary)
                HStack(spacing: 5) {
                    Text("\(task.cadence.title) · \(task.timeText)")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    if let last = task.lastRunAt {
                        Text("· last \(last, style: .relative) ago")
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                    }
                }
            }
            Spacer(minLength: 0)
            Toggle("", isOn: Binding(
                get: { task.isEnabled },
                set: { store.setEnabled($0, id: task.id) }
            ))
            .labelsHidden()
        }
        .contentShape(Rectangle())
        .hoverEffect(.highlight)
    }

    private func stepRow(_ index: Int, _ text: String) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Text("\(index)")
                .font(.caption2.weight(.bold))
                .foregroundStyle(.white)
                .frame(width: 18, height: 18)
                .background(Color.accentColor, in: Circle())
            Text(text)
                .font(.footnote)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

private struct ScheduledTaskEditorView: View {
    let existing: ScheduledTask?

    @Environment(\.dismiss) private var dismiss
    @ObservedObject private var store = ScheduledTaskStore.shared
    @ObservedObject private var quickTasks = QuickTaskStore.shared

    @State private var quickTaskId: String
    @State private var cadence: ScheduledTask.Cadence
    @State private var time: Date
    @State private var weekday: Int

    init(existing: ScheduledTask?) {
        self.existing = existing
        let first = QuickTaskStore.shared.tasks.first?.id ?? ""
        _quickTaskId = State(initialValue: existing?.quickTaskId ?? first)
        _cadence = State(initialValue: existing?.cadence ?? .daily)
        _weekday = State(initialValue: existing?.weekday ?? 2)
        let minutes = existing?.minuteOfDay ?? 8 * 60
        // [T-datepicker-year-one] DateComponents carrying only hour+minute
        // resolves to year 1 CE, where several zones have odd historical
        // offsets (Asia/Shanghai was UTC+08:05:43 before 1901). Anchor on
        // today so the picker shows a real, current wall-clock time.
        _time = State(initialValue: Calendar.current.date(
            bySettingHour: minutes / 60, minute: minutes % 60, second: 0, of: Date()
        ) ?? Date())
    }

    /// Weekday names come from the user's calendar rather than a hardcoded
    /// table, so they follow the in-app language automatically.
    private static var weekdayNames: [String] {
        [""] + Calendar.current.standaloneWeekdaySymbols
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Which task to run") {
                    Picker("Quick Tasks", selection: $quickTaskId) {
                        ForEach(quickTasks.tasks) { task in
                            Text(task.displayName).tag(task.id)
                        }
                    }
                }
                Section("When") {
                    Picker("Frequency", selection: $cadence) {
                        ForEach(ScheduledTask.Cadence.allCases) { c in
                            Text(c.title).tag(c)
                        }
                    }
                    if cadence != .hourly {
                        DatePicker("Time", selection: $time, displayedComponents: .hourAndMinute)
                    }
                    if cadence == .weekly {
                        Picker("Day", selection: $weekday) {
                            ForEach(1...7, id: \.self) { d in
                                Text(Self.weekdayNames[d]).tag(d)
                            }
                        }
                    }
                }
            }
            .navigationTitle(existing == nil ? String(localized: "New schedule") : String(localized: "Edit schedule"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Save") { save() }
                        .disabled(quickTaskId.isEmpty)
                }
            }
        }
    }

    private func save() {
        let comps = Calendar.current.dateComponents([.hour, .minute], from: time)
        let minuteOfDay = (comps.hour ?? 8) * 60 + (comps.minute ?? 0)
        if var task = existing {
            task.quickTaskId = quickTaskId
            task.cadence = cadence
            task.minuteOfDay = minuteOfDay
            task.weekday = weekday
            store.update(task)
        } else {
            store.add(ScheduledTask(
                quickTaskId: quickTaskId,
                cadence: cadence,
                minuteOfDay: minuteOfDay,
                weekday: weekday
            ))
        }
        dismiss()
    }
}
