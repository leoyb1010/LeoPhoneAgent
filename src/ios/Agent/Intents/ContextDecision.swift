//
//  ContextDecision.swift
//  MinisApp
//
//  [D3] 情境层的纯逻辑:信号 + 状态快照 → 档位 + 理由 + 目标会话。只依赖 Foundation,
//  逻辑测试直接编译。还放着同属情境层、需要单测的几块小逻辑:
//  [D2] 情境触发回合禁用的工具、[D4] 安静任务的每日 token 预算、[D5] 专注收尾卡片、
//  [D6] 第 2 档主动出声的闸门。
//
//  跨模块契约(首页情境条读,不产生编译依赖):
//  - leo.context.pinnedSessionId (String) + leo.context.pinnedAt (Double, 1970 秒):「继续上次」
//  - leo.context.focusSummary (JSON {title, done, pending, createdAt}):专注收尾卡片
//

import Foundation

enum ContextKeys {
    static let pinnedSessionId = "leo.context.pinnedSessionId"
    static let pinnedAt = "leo.context.pinnedAt"
    static let focusSummary = "leo.context.focusSummary"
    /// [D6] 第 2 档主动出声开关,默认关(先看两周决策日志再开)。
    static let proactiveSpeechEnabled = "leo.context.proactiveSpeech"
    /// [D6] 当天已出声次数:{"day": "yyyy-MM-dd", "count": Int}
    static let proactiveSpeechCount = "leo.context.proactiveSpeechCount"
}

/// 系统内置的信号名(NoteContextIntent 的选项、专注过滤器)。
enum ContextSignalName {
    static let home = "到家"
    static let leave = "出门"
    static let car = "上车"
    static let focusStart = "开始专注"
    static let focusEnd = "结束专注"
}

struct ContextDecision: Equatable {
    struct Candidate: Equatable {
        var sessionId: String
        var title: String
        var updatedAt: Date
    }

    struct Snapshot {
        /// 未完成(中断)的会话。
        var interrupted: [Candidate]
        var now: Date
        var isLocked: Bool
    }

    var tier: Int
    var reason: String
    var sessionId: String?
    /// [D6] 规则判断这件事值不值得开口(最终还要过 allowsSpeaking 的闸门)。
    var worthSpeaking: Bool = false

    /// 「今天」的分界:凌晨 4 点。深夜 1 点到家,昨晚 22 点中断的会话还算今天的。
    static let dayBoundaryHour = 4

    static func logicalDayStart(for now: Date, calendar: Calendar = .current) -> Date {
        let midnight = calendar.startOfDay(for: now)
        let boundary = calendar.date(byAdding: .hour, value: dayBoundaryHour, to: midnight) ?? midnight
        if now >= boundary { return boundary }
        return calendar.date(byAdding: .day, value: -1, to: boundary) ?? boundary
    }

    /// 深夜:23:00–06:59。深夜照样把会话放上首页,但不开口。
    static func isLateNight(_ now: Date, calendar: Calendar = .current) -> Bool {
        let hour = calendar.component(.hour, from: now)
        return hour >= 23 || hour < 7
    }

    static func decide(signal: String, snapshot: Snapshot, calendar: Calendar = .current) -> ContextDecision {
        let name = signal.trimmingCharacters(in: .whitespacesAndNewlines)
        guard name == ContextSignalName.home else {
            return ContextDecision(tier: AutomationRule.Tier.logOnly, reason: "信号「\(name)」没有内置决策,只交给规则")
        }
        let dayStart = logicalDayStart(for: snapshot.now, calendar: calendar)
        let today = snapshot.interrupted.filter { $0.updatedAt >= dayStart && $0.updatedAt <= snapshot.now }
        guard let latest = today.max(by: { $0.updatedAt < $1.updatedAt }) else {
            return ContextDecision(tier: AutomationRule.Tier.logOnly, reason: "到家,今天没有中断的会话")
        }
        let lateNight = isLateNight(snapshot.now, calendar: calendar)
        // 两小时内刚中断的才值得开口提醒;深夜一律不开口。
        let fresh = snapshot.now.timeIntervalSince(latest.updatedAt) <= 2 * 3600
        let reason = today.count > 1
            ? "到家,今天有 \(today.count) 个中断的会话,接最近的一个"
            : "到家,今天有中断的会话"
        return ContextDecision(tier: AutomationRule.Tier.prepare,
                               reason: reason + (lateNight ? "(深夜,不出声)" : ""),
                               sessionId: latest.sessionId,
                               worthSpeaking: fresh && !lateNight)
    }

    /// [D6] 第 2 档闸门:开关打开、本机模型可用、决策认为值得、当天未满上限。
    static let dailySpeechCap = 3

    static func allowsSpeaking(_ decision: ContextDecision, enabled: Bool, onDeviceModelReady: Bool,
                               spokenToday: Int, cap: Int = dailySpeechCap) -> Bool {
        enabled && onDeviceModelReady && decision.tier >= AutomationRule.Tier.prepare
            && decision.worthSpeaking && spokenToday < cap
    }
}

/// [D2] 情境信号(可能在锁屏时)和安静任务触发的回合:不发信、不删除、不远程执行。
/// 发消息 / 跑快捷指令 / 删文件都要经过 shell 或浏览器,所以整类拿掉;
/// file_write / file_edit 能覆盖、清空文件(等同删除),这类无人值守回合也不给。
enum ContextToolPolicy {
    static let blockedTools: Set<String> = [
        "shell_execute", "browser_use", "remote_shell", "remote_agent", "dispatch_subtask",
        "file_write", "file_edit", "subagent_task", "schedule_followup",
        // [T-ask-user] nobody is at the card in these turns.
        "ask_user",
    ]

    static func filter<T>(_ tools: [T], name: (T) -> String) -> [T] {
        tools.filter { !blockedTools.contains(name($0)) }
    }

    /// 受限回合是否还在进行:在跑、在压缩、或压缩完待发,任一成立都算 ——
    /// 否则「先压缩再发」的回合会被当成已结束,工具限制在真正开跑前就被解除。
    static func isTurnActive(processing: Bool, compacting: Bool, pendingCompactSend: Bool,
                             tracked: Bool) -> Bool {
        processing || compacting || pendingCompactSend || tracked
    }
}

/// [D4] 安静任务的每日 token 预算(按本地日期清零)。
struct QuietTaskBudget: Codable, Equatable {
    static let defaultLimit = 20_000
    static let limitKey = "leo.quiet.tokenBudget"
    static let usageKey = "leo.quiet.tokenUsage"
    static let enabledKey = "leo.quiet.enabled"

    var day: String
    var used: Int

    static func dayString(_ date: Date, calendar: Calendar = .current) -> String {
        let c = calendar.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", c.year ?? 0, c.month ?? 0, c.day ?? 0)
    }

    /// 换了一天就从 0 开始。
    func normalized(for now: Date, calendar: Calendar = .current) -> QuietTaskBudget {
        let today = Self.dayString(now, calendar: calendar)
        return day == today ? self : QuietTaskBudget(day: today, used: 0)
    }

    func adding(_ tokens: Int, now: Date, calendar: Calendar = .current) -> QuietTaskBudget {
        var next = normalized(for: now, calendar: calendar)
        next.used += max(0, tokens)
        return next
    }

    func remaining(limit: Int, now: Date, calendar: Calendar = .current) -> Int {
        max(0, limit - normalized(for: now, calendar: calendar).used)
    }
}

/// [D5] 专注收尾卡片。JSON 字段名是首页情境条读的契约,别改。
struct FocusSummary: Codable, Equatable {
    var title: String
    var done: [String]
    var pending: [String]
    var createdAt: Double

    /// 专注期间动过的会话:没中断的算完成,中断的算未完成。都没有就不出卡片。
    static func make(modeName: String, start: Date, end: Date,
                     sessions: [ContextDecision.Candidate], interrupted: Set<String>) -> FocusSummary? {
        let touched = sessions
            .filter { $0.updatedAt >= start && $0.updatedAt <= end }
            .sorted { $0.updatedAt < $1.updatedAt }
        guard !touched.isEmpty else { return nil }
        let minutes = max(1, Int(end.timeIntervalSince(start) / 60))
        let label = { (c: ContextDecision.Candidate) in c.title.isEmpty ? "未命名会话" : c.title }
        return FocusSummary(
            title: "\(modeName) · \(minutes) 分钟",
            done: touched.filter { !interrupted.contains($0.sessionId) }.map(label),
            pending: touched.filter { interrupted.contains($0.sessionId) }.map(label),
            createdAt: end.timeIntervalSince1970)
    }
}
