//
//  ScheduledTaskIntents.swift
//  MinisApp
//
//  [C6] 定时任务进 Siri / 快捷指令:列出、立即运行(念出结果摘要)、开关。
//  开关直接改 ScheduledTaskStore,设置页观察同一个 store,会立即同步。
//

import AppIntents
import Foundation

struct ScheduledTaskEntity: AppEntity {
    static var typeDisplayRepresentation = TypeDisplayRepresentation(name: "定时任务")
    static var defaultQuery = ScheduledTaskEntityQuery()

    var id: String
    var name: String
    var schedule: String
    var isEnabled: Bool

    var displayRepresentation: DisplayRepresentation {
        DisplayRepresentation(title: "\(name)", subtitle: "\(schedule) · \(isEnabled ? "已开启" : "已关闭")")
    }

    @MainActor
    init(_ task: ScheduledTask) {
        id = task.id
        name = QuickTaskStore.shared.definition(for: task.quickTaskId)?.displayName ?? "已删除的快捷任务"
        schedule = task.cadence == .hourly ? task.cadence.title : "\(task.cadence.title) \(task.timeText)"
        isEnabled = task.isEnabled
    }

    @MainActor
    static func all() -> [ScheduledTaskEntity] {
        ScheduledTaskStore.shared.tasks.map(ScheduledTaskEntity.init)
    }
}

struct ScheduledTaskEntityQuery: EntityStringQuery {
    func entities(for identifiers: [String]) async throws -> [ScheduledTaskEntity] {
        await ScheduledTaskEntity.all().filter { identifiers.contains($0.id) }
    }

    func entities(matching string: String) async throws -> [ScheduledTaskEntity] {
        let query = string.trimmingCharacters(in: .whitespacesAndNewlines)
        let all = await ScheduledTaskEntity.all()
        guard !query.isEmpty else { return all }
        return all.filter { $0.name.localizedCaseInsensitiveContains(query) }
    }

    func suggestedEntities() async throws -> [ScheduledTaskEntity] {
        await ScheduledTaskEntity.all()
    }
}

struct ListScheduledTasksIntent: AppIntent {
    static var title: LocalizedStringResource = "列出定时任务"
    static var description = IntentDescription("列出 LeoPhoneAgent 里的定时任务和开关状态。")
    static var openAppWhenRun: Bool = false
    static var supportedModes: IntentModes = .background
    static var authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication

    @MainActor
    func perform() async throws -> some IntentResult & ReturnsValue<[ScheduledTaskEntity]> & ProvidesDialog {
        let tasks = ScheduledTaskEntity.all()
        guard !tasks.isEmpty else {
            return .result(value: [], dialog: "还没有定时任务，可以在 App 的设置 › 定时任务里添加。")
        }
        let lines = tasks.map { "\($0.name)（\($0.schedule)，\($0.isEnabled ? "开" : "关")）" }
        return .result(value: tasks, dialog: IntentDialog(stringLiteral: "共 \(tasks.count) 个定时任务：" + lines.joined(separator: "；")))
    }
}

struct RunScheduledTaskNowIntent: AppIntent {
    static var title: LocalizedStringResource = "立即运行定时任务"
    static var description = IntentDescription("不等时间到，现在就跑一次某个定时任务，跑完返回结果摘要。不影响它原本的时间表。")
    static var openAppWhenRun: Bool = false
    static var supportedModes: IntentModes = [.background, .foreground(.deferred)]
    static var authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication

    @Parameter(title: "定时任务")
    var task: ScheduledTaskEntity

    static var parameterSummary: some ParameterSummary {
        Summary("立即运行 \(\.$task)")
    }

    @MainActor
    func perform() async throws -> some IntentResult & ReturnsValue<String> & ProvidesDialog {
        guard let stored = ScheduledTaskStore.shared.tasks.first(where: { $0.id == task.id }),
              let definition = QuickTaskStore.shared.definition(for: stored.quickTaskId) else {
            return .result(value: "", dialog: "找不到这个定时任务，它可能已被删除。")
        }
        let run = {
            try await QuickTaskIntent.execute(definition: definition, files: nil, model: nil,
                                              waitForResult: true, inputValues: [:]).value
        }
        let value: SendPromptResult?
        if #available(iOS 27, *) {
            value = try await performBackgroundTask { try await run() }
        } else {
            value = try await run()
        }
        let summary = String((value?.responseText ?? "").trimmingCharacters(in: .whitespacesAndNewlines).prefix(240))
        let spoken = summary.isEmpty ? "「\(definition.displayName)」已运行，打开 App 查看结果。" : summary
        var voiceOnly = false
        if #available(iOS 27, *) { voiceOnly = systemContext.isVoiceOnly }
        let dialog = SiriReplyPrivacy.dialogText(
            spoken, deviceLocked: !UIApplication.shared.isProtectedDataAvailable,
            privacyMode: SiriReplyPrivacy.privacyModeEnabled, voiceOnly: voiceOnly)
        return .result(value: summary, dialog: IntentDialog(stringLiteral: dialog))
    }
}

@available(iOS 27, *)
extension RunScheduledTaskNowIntent: LongRunningIntent {}

struct SetScheduledTaskEnabledIntent: AppIntent {
    static var title: LocalizedStringResource = "开关定时任务"
    static var description = IntentDescription("打开或关闭某个定时任务，App 设置页同步更新。")
    static var openAppWhenRun: Bool = false
    static var supportedModes: IntentModes = .background
    static var authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication

    @Parameter(title: "定时任务")
    var task: ScheduledTaskEntity

    @Parameter(title: "开启", default: false)
    var enabled: Bool

    static var parameterSummary: some ParameterSummary {
        Summary("把 \(\.$task) 设为开启：\(\.$enabled)")
    }

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog {
        let store = ScheduledTaskStore.shared
        guard store.tasks.contains(where: { $0.id == task.id }) else {
            return .result(dialog: "找不到这个定时任务，它可能已被删除。")
        }
        store.setEnabled(enabled, id: task.id)
        return .result(dialog: IntentDialog(stringLiteral: "已\(enabled ? "开启" : "关闭")「\(task.name)」。"))
    }
}
