//
//  ReplyNextStep.swift
//  MinisApp
//
//  [E1] 回复的「下一步」:一条 Agent 回复可以一步流到别的功能。
//  菜单固定 5 项、顺序固定。这里只放与界面无关的部分(编进 MinisTests);
//  菜单在回复底部的操作条里,表单与跳转在 AIChatView。
//

import Foundation

extension Notification.Name {
    /// object = 发出请求的 AIChatViewModel(多窗口时只由那一个对话响应),
    /// userInfo["request"] = ReplyNextStep.Request。
    static let replyNextStepRequested = Notification.Name("leo.replyNextStepRequested")
}

enum ReplyNextStep {
    enum Action: String, CaseIterable, Identifiable {
        case collect, quickTask, schedule, mac, paperclip

        var id: String { rawValue }

        var title: String {
            switch self {
            case .collect: return "收进藏宝阁"
            case .quickTask: return "存为快捷任务"
            case .schedule: return "设为定时任务"
            case .mac: return "发到 Mac"
            case .paperclip: return "转为服务器任务"
            }
        }

        var symbolName: String {
            switch self {
            case .collect: return "archivebox"
            case .quickTask: return "bolt"
            case .schedule: return "clock.arrow.circlepath"
            case .mac: return "macbook.and.iphone"
            case .paperclip: return "paperclip"
            }
        }
    }

    /// 菜单项最多 5 个,顺序固定。
    static let menu: [Action] = [.collect, .quickTask, .schedule, .mac, .paperclip]

    /// 实际显示的菜单:没连过 Paperclip 服务器时不出现「转为服务器任务」(本机优先,不把人引到空的连接页);
    /// Mac 舰队没打开时不出现「发到 Mac」。
    static func visibleMenu(paperclipConfigured: Bool, macFleetEnabled: Bool) -> [Action] {
        menu.filter { action in
            switch action {
            case .paperclip: return paperclipConfigured
            case .mac: return macFleetEnabled
            default: return true
            }
        }
    }

    /// 这一轮:用户的提示 + Agent 的回复(纯文本)。
    struct Request: Identifiable, Equatable {
        let id = UUID()
        let action: Action
        let prompt: String
        let reply: String

        static func == (a: Request, b: Request) -> Bool { a.id == b.id }
    }

    // MARK: 文本整形

    /// 用户消息里夹带的系统提示(手表、快捷指令附加的 <system-reminder>)不进模板。
    static func cleanPrompt(_ text: String) -> String {
        var result = text
        while let start = result.range(of: "<system-reminder>") {
            guard let end = result.range(of: "</system-reminder>", range: start.upperBound..<result.endIndex) else {
                result.removeSubrange(start.lowerBound..<result.endIndex)
                break
            }
            result.removeSubrange(start.lowerBound..<end.upperBound)
        }
        return result.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// 一行、去首尾空白,截到 limit 个字。
    static func firstLine(_ text: String, limit: Int) -> String {
        let line = text.split(whereSeparator: \.isNewline)
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .first { !$0.isEmpty } ?? ""
        return String(line.prefix(limit))
    }

    /// 回复摘要:压成段落、截到 limit 字,截断时加省略号。
    static func summary(_ reply: String, limit: Int = 600) -> String {
        let flat = reply.split(whereSeparator: \.isNewline)
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
            .joined(separator: "\n")
        guard flat.count > limit else { return flat }
        return String(flat.prefix(limit)) + "…"
    }

    /// 快捷任务的默认名字:提示的第一行,最多 16 字。
    static func quickTaskName(prompt: String) -> String {
        let name = firstLine(prompt, limit: 16)
        return name.isEmpty ? "来自对话的任务" : name
    }

    /// 「发到 Mac」的任务描述:这一轮的提示 + 回复摘要。
    static func macTaskText(prompt: String, reply: String) -> String {
        let ask = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        let answer = summary(reply, limit: 1500)
        var parts = ["在手机上的对话里接着做这件事。"]
        if !ask.isEmpty { parts.append("我的要求:\n" + ask) }
        if !answer.isEmpty { parts.append("手机上已经得到的结果(摘要):\n" + answer) }
        return parts.joined(separator: "\n\n")
    }

    /// 收进藏宝阁的笔记:标题取提示第一行,正文是提示 + 完整回复。
    static func noteContent(prompt: String, reply: String) -> (title: String, body: String) {
        let title = firstLine(prompt, limit: 30)
        let ask = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        let answer = reply.trimmingCharacters(in: .whitespacesAndNewlines)
        let body = ask.isEmpty ? answer : "> " + ask.replacingOccurrences(of: "\n", with: "\n> ") + "\n\n" + answer
        return (title.isEmpty ? firstLine(answer, limit: 30) : title, body)
    }

    // MARK: 写入

    /// 「存为快捷任务」/「设为定时任务」:用这一轮的提示当模板存一个快捷任务;
    /// `scheduleMinuteOfDay` 非空时再给它建一个每天这个时刻的定时任务。
    @MainActor
    @discardableResult
    static func saveQuickTask(name: String, prompt: String, scheduleMinuteOfDay: Int?,
                              quickTasks: QuickTaskStore? = nil,
                              scheduled: ScheduledTaskStore? = nil,
                              now: Date = Date()) -> (task: QuickTaskDefinition, schedule: ScheduledTask?)? {
        let quickTasks = quickTasks ?? .shared
        let scheduled = scheduled ?? .shared
        guard let task = quickTasks.add(name: name, prompt: prompt, symbolName: "text.bubble") else { return nil }
        guard let minute = scheduleMinuteOfDay else { return (task, nil) }
        let schedule = ScheduledTask(quickTaskId: task.id, cadence: .daily,
                                     minuteOfDay: max(0, min(24 * 60 - 1, minute)), now: now)
        scheduled.add(schedule)
        return (task, schedule)
    }

    /// 当前时刻(本地),给「设为定时任务」当默认时间。
    static func minuteOfDay(_ date: Date, calendar: Calendar = .current) -> Int {
        let parts = calendar.dateComponents([.hour, .minute], from: date)
        return (parts.hour ?? 8) * 60 + (parts.minute ?? 0)
    }

    /// 「收进藏宝阁」:存成一条笔记(先落正文再入库,与「记一条笔记」相同)。
    @discardableResult
    static func collect(prompt: String, reply: String) async -> Bool {
        let content = noteContent(prompt: prompt, reply: reply)
        guard !content.body.isEmpty else { return false }
        var note = CollectedItem.newNote(title: content.title)
        note.value = String(content.body.prefix(200))
        note.tags = ["对话"]
        if let file = note.bodyFile {
            guard await NoteBodyStore.save(content.body, to: file) else { return false }
        }
        CollectionStore.add([note])
        await CollectionSearchIndex.shared.index(itemId: note.id, title: note.title ?? "", body: content.body)
        return true
    }
}
