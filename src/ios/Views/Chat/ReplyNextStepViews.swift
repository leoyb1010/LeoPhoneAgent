//
//  ReplyNextStepViews.swift
//  MinisApp
//
//  [E1] 回复「下一步」里需要你确认的那一步:存为快捷任务(可改名、改模板),
//  或者顺手设成每天这个时刻跑的定时任务。
//

import SwiftUI

struct ReplyQuickTaskForm: View {
    let request: ReplyNextStep.Request
    /// 保存后在对话里留一句结果。
    let onSaved: (String) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var name: String
    @State private var prompt: String
    @State private var schedule: Bool
    @State private var time: Date

    init(request: ReplyNextStep.Request, onSaved: @escaping (String) -> Void) {
        self.request = request
        self.onSaved = onSaved
        _name = State(initialValue: ReplyNextStep.quickTaskName(prompt: request.prompt))
        _prompt = State(initialValue: request.prompt.trimmingCharacters(in: .whitespacesAndNewlines))
        _schedule = State(initialValue: request.action == .schedule)
        // 默认每天当前时刻。
        _time = State(initialValue: Date())
    }

    private var canSave: Bool {
        !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("名称") {
                    TextField("快捷任务名称", text: $name)
                        .accessibilityIdentifier("nextStep.quickTaskName")
                }
                Section {
                    TextField("提示词", text: $prompt, axis: .vertical)
                        .lineLimit(3...10)
                } header: {
                    Text("提示词模板")
                } footer: {
                    Text("用这一轮你问的话当模板。保存后出现在快捷任务列表、输入框的快捷任务和快捷指令「运行快捷任务」里。")
                }
                Section {
                    Toggle("设为定时任务", isOn: $schedule)
                    if schedule {
                        DatePicker("每天", selection: $time, displayedComponents: .hourAndMinute)
                    }
                } footer: {
                    if schedule {
                        Text("每天这个时刻运行一次,结果在设置 › 定时任务里能看到。频率可以之后在那里改。")
                    }
                }
            }
            .navigationTitle(request.action == .schedule ? "设为定时任务" : "存为快捷任务")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("保存") { save() }
                        .disabled(!canSave)
                        .accessibilityIdentifier("nextStep.save")
                }
            }
        }
        .presentationDetents([.medium, .large])
    }

    private func save() {
        let minute = schedule ? ReplyNextStep.minuteOfDay(time) : nil
        guard let saved = ReplyNextStep.saveQuickTask(name: name, prompt: prompt, scheduleMinuteOfDay: minute) else {
            LeoHaptics.notification(.error)
            return
        }
        LeoHaptics.notification(.success)
        if let schedule = saved.schedule {
            onSaved("已存为快捷任务「\(saved.task.displayName)」,并设为每天 \(schedule.timeText) 运行")
        } else {
            onSaved("已存为快捷任务「\(saved.task.displayName)」")
        }
        dismiss()
    }
}
