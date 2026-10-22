//
//  ReplyNextStep.swift
//  MinisApp
//
//  [E1] 回复的「下一步」:一条 Agent 回复可以一步流到别的功能。
//  菜单最多 5 项、顺序固定。这里只放与界面无关的部分(编进 MinisTests);
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
        case collect, brain, quickTask, schedule, mac

        var id: String { rawValue }

        var title: String {
            switch self {
            case .collect: return "收进藏宝阁"
            case .brain: return "收进大脑"
            case .quickTask: return "存为快捷任务"
            case .schedule: return "设为定时任务"
            case .mac: return "发到 Mac"
            }
        }

        var symbolName: String {
            switch self {
            case .collect: return "archivebox"
            case .brain: return "brain.head.profile"
            case .quickTask: return "bolt"
            case .schedule: return "clock.arrow.circlepath"
            case .mac: return "macbook.and.iphone"
            }
        }
    }

    /// 菜单项最多 5 个,顺序固定。
    static let menu: [Action] = [.collect, .brain, .quickTask, .schedule, .mac]

    /// 实际显示的菜单:Mac 舰队没打开时不出现「发到 Mac」;没连资料库时不出现「收进大脑」。
    static func visibleMenu(macFleetEnabled: Bool, brainConnected: Bool = false) -> [Action] {
        menu.filter { action in
            switch action {
            case .mac: return macFleetEnabled
            case .brain: return brainConnected
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

    /// [P2] 「收进大脑」:这一轮存成资料库的草稿知识卡(Leo 在资料库审阅队列里确认)。
    /// 标题同藏宝阁笔记;正文末尾注明来自哪次对话,知识卡日后能追溯。
    static func brainCardContent(prompt: String, reply: String, now: Date = Date()) -> (title: String, body: String, category: String) {
        let note = noteContent(prompt: prompt, reply: reply)
        let fmt = DateFormatter()
        fmt.dateFormat = "yyyy-MM-dd HH:mm"
        fmt.locale = Locale(identifier: "en_US_POSIX")
        let body = note.body.isEmpty ? "" : note.body + "\n\n— 来自 LeoBot 对话,\(fmt.string(from: now))"
        return (note.title.isEmpty ? "LeoBot 对话" : note.title, body, "LeoBot 对话")
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

// MARK: - [E2] 「值得收进大脑？」建议

extension ReplyNextStep {
    /// 便宜的本地判断:够长(≥ 400 字)且有结构(标题、两条以上列表、表格),
    /// 不是报错 / 道歉,也不是出错的回合。只决定要不要出那一行建议,从不自动保存。
    static func suggestsBrain(reply: String, hasError: Bool = false) -> Bool {
        guard !hasError else { return false }
        let text = reply.trimmingCharacters(in: .whitespacesAndNewlines)
        guard text.count >= 400 else { return false }
        let head = firstLine(text, limit: 40).lowercased()
        let errorPrefixes = ["error", "错误", "出错", "失败", "抱歉", "sorry", "⚠️"]
        if errorPrefixes.contains(where: { head.hasPrefix($0) }) { return false }

        var inFence = false
        var listItems = 0
        var hasHeading = false
        var tableRows = 0
        var hasTableSeparator = false
        for raw in text.split(whereSeparator: \.isNewline) {
            let line = raw.trimmingCharacters(in: .whitespaces)
            if line.hasPrefix("```") || line.hasPrefix("~~~") { inFence.toggle(); continue }
            if inFence || line.isEmpty { continue }
            if line.range(of: #"^#{1,6}\s+\S"#, options: .regularExpression) != nil { hasHeading = true }
            let isRule = line.allSatisfy { "-*_ ".contains($0) }
            if !isRule, line.range(of: #"^([-*+•]\s+\S|\d{1,3}[.)]\s+\S|\d{1,3}、\s*\S)"#,
                                   options: .regularExpression) != nil { listItems += 1 }
            if line.hasPrefix("|") && line.dropFirst().contains("|") {
                tableRows += 1
                if line.range(of: #"^\|?\s*:?-{3,}"#, options: .regularExpression) != nil { hasTableSeparator = true }
            }
        }
        let hasTable = hasTableSeparator && tableRows >= 3
        return hasHeading || listItems >= 2 || hasTable
    }

    /// 每条回复最多出一次:点过「收进大脑」或关掉后记下,不再出现。只留最近 200 条。
    struct BrainSuggestionLedger {
        static let key = "leo.reply.brainSuggestion.handled"
        static let limit = 200
        var defaults: UserDefaults = .standard

        func isHandled(_ id: UUID) -> Bool {
            (defaults.stringArray(forKey: Self.key) ?? []).contains(id.uuidString)
        }

        func markHandled(_ id: UUID) {
            var ids = defaults.stringArray(forKey: Self.key) ?? []
            guard !ids.contains(id.uuidString) else { return }
            ids.append(id.uuidString)
            if ids.count > Self.limit { ids.removeFirst(ids.count - Self.limit) }
            defaults.set(ids, forKey: Self.key)
        }
    }
}
