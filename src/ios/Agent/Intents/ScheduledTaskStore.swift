//
//  ScheduledTaskStore.swift
//  MinisApp
//
//  [T-scheduled-tasks] Recurring quick tasks.
//
//  iOS gives an app no reliable wall-clock wakeup: there is no cron, and
//  BGTaskScheduler only offers "sometime, maybe". So this deliberately does
//  NOT try to be a scheduler. It is a *ledger* of intent plus a reconciler:
//
//    • the schedule lives here, persisted;
//    • the actual firing is delegated to whatever CAN wake us — a Shortcuts
//      personal automation the user sets up once, or simply the user opening
//      the app;
//    • every time we are alive we reconcile: anything whose due time has
//      passed and that has not run for that slot runs now, once.
//
//  That makes a missed window recoverable instead of silently lost, which is
//  the honest best an iOS app can do. The UI says so rather than implying
//  second-accurate timing.
//

import Foundation

struct ScheduledTask: Codable, Identifiable, Hashable {
    enum Cadence: String, Codable, CaseIterable, Identifiable {
        case daily
        case weekdays
        case weekly
        case hourly

        var id: String { rawValue }

        var title: String {
            switch self {
            case .daily: return String(localized: "Daily")
            case .weekdays: return String(localized: "Weekdays")
            case .weekly: return String(localized: "Weekly")
            case .hourly: return String(localized: "Hourly")
            }
        }
    }

    var id: String
    /// Quick task to run. Kept as an id so edits to the task itself apply.
    var quickTaskId: String
    var cadence: Cadence
    /// Minutes past midnight (local). Ignored for `.hourly`.
    var minuteOfDay: Int
    /// 1 = Sunday … 7 = Saturday, matching Calendar. Only for `.weekly`.
    var weekday: Int
    var isEnabled: Bool
    /// Start of the slot we last ran, so a slot fires at most once.
    var lastRunSlot: Date?
    var lastRunAt: Date?
    /// [E3] 最近一次运行的结果回写。全部可选：旧数据没有这些键也照样解码。
    enum RunStatus: String, Codable {
        case success, failure, skipped
        var title: String {
            switch self {
            case .success: return "成功"
            case .failure: return "失败"
            case .skipped: return "跳过"
            }
        }
    }
    /// 那次运行所在的会话，点设置页的行可以直接进去。
    var lastSessionId: String?
    /// 回复的前 120 字。
    var lastResultPreview: String?
    var lastStatus: RunStatus?

    static let previewLimit = 120

    /// 回复正文压成一行、截到 120 字。
    static func preview(_ text: String) -> String {
        let flat = text.split(whereSeparator: \.isNewline)
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
            .joined(separator: " ")
        return String(flat.prefix(previewLimit))
    }

    init(
        id: String = UUID().uuidString.lowercased(),
        quickTaskId: String,
        cadence: Cadence = .daily,
        minuteOfDay: Int = 8 * 60,
        weekday: Int = 2,
        isEnabled: Bool = true,
        now: Date = Date()
    ) {
        self.id = id
        self.quickTaskId = quickTaskId
        self.cadence = cadence
        self.minuteOfDay = minuteOfDay
        self.weekday = weekday
        self.isEnabled = isEnabled
        // [T-schedule-fires-on-create] Claim the slot that has already passed
        // today, so a task created at 09:00 for "daily 08:00" waits until
        // tomorrow instead of running the instant it is saved. `isDue` treats a
        // nil lastRunSlot as "never ran, owes a run now", which is right for
        // reconciliation but wrong at creation time.
        self.lastRunSlot = mostRecentDueSlot(now: now)
    }

    var timeText: String {
        switch cadence {
        case .hourly:
            return String(localized: "Every hour, on the hour")
        default:
            return String(format: "%02d:%02d", minuteOfDay / 60, minuteOfDay % 60)
        }
    }

    /// Start of the most recent slot that should already have fired, or nil
    /// when this cadence has not come round yet today.
    func mostRecentDueSlot(now: Date, calendar: Calendar = .current) -> Date? {
        switch cadence {
        case .hourly:
            return calendar.dateInterval(of: .hour, for: now)?.start

        case .daily, .weekdays, .weekly:
            // Walk back day by day to the newest slot that has already passed
            // AND matches this cadence's day rule; `isDue`'s 26h guard then
            // decides whether it is too stale to be worth running.
            //
            // [T-schedule-weekly-catchup] The previous version only ever looked
            // at today's slot (or yesterday's when today's was still ahead), so
            // a weekly Monday task missed on Monday was gone for good by
            // Tuesday morning — the 26h recovery window the UI promises was
            // unreachable for weekly/weekdays.
            //
            // [T-schedule-dst] Using `bySettingHour` rather than adding
            // `minuteOfDay` minutes to midnight keeps the wall-clock time
            // stable: minute arithmetic across a DST change shifted an 08:00
            // task to 09:00 or 07:00 on the changeover day.
            let hour = minuteOfDay / 60
            let minute = minuteOfDay % 60
            for dayOffset in 0...7 {
                guard let day = calendar.date(byAdding: .day, value: -dayOffset, to: now),
                      let slot = calendar.date(bySettingHour: hour, minute: minute, second: 0, of: day),
                      slot <= now,
                      matchesDay(slot, calendar: calendar) else { continue }
                return slot
            }
            return nil
        }
    }

    private func matchesDay(_ date: Date, calendar: Calendar) -> Bool {
        switch cadence {
        case .daily, .hourly:
            return true
        case .weekdays:
            let wd = calendar.component(.weekday, from: date)
            return wd >= 2 && wd <= 6   // Mon…Fri
        case .weekly:
            return calendar.component(.weekday, from: date) == weekday
        }
    }

    /// True when this task owes a run right now.
    func isDue(now: Date, calendar: Calendar = .current) -> Bool {
        guard isEnabled, let slot = mostRecentDueSlot(now: now, calendar: calendar) else { return false }
        // Don't resurrect a slot that is more than a day stale — waking up
        // after a week away should not fire seven briefings.
        guard now.timeIntervalSince(slot) < 26 * 3600 else { return false }
        guard let last = lastRunSlot else { return true }
        return slot > last
    }
}

@MainActor
final class ScheduledTaskStore: ObservableObject {
    static let shared = ScheduledTaskStore()

    static let storageKey = "leo.scheduledTasks.v1"

    @Published private(set) var tasks: [ScheduledTask]

    private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        tasks = Self.decodeTasks(defaults.data(forKey: Self.storageKey), defaults: defaults)
    }

    private struct LossyTask: Decodable {
        let task: ScheduledTask?
        init(from decoder: Decoder) throws { task = try? ScheduledTask(from: decoder) }
    }

    /// 逐条解码:某一条解不出来(降级后遇到新版本的频率值等)只跳过那一条;
    /// 原始数据先备份,不会因为一条坏数据、在下一次保存时把全部定时任务清空。
    static func decodeTasks(_ data: Data?, defaults: UserDefaults) -> [ScheduledTask] {
        guard let data else { return [] }
        if let all = try? JSONDecoder().decode([ScheduledTask].self, from: data) { return all }
        defaults.set(data, forKey: storageKey + ".backup")
        let lossy = (try? JSONDecoder().decode([LossyTask].self, from: data)) ?? []
        return lossy.compactMap(\.task)
    }

    func add(_ task: ScheduledTask) {
        tasks.append(task)
        persist()
    }

    func update(_ task: ScheduledTask, now: Date = Date()) {
        guard let index = tasks.firstIndex(where: { $0.id == task.id }) else { return }
        var task = task
        let old = tasks[index]
        // 改了时间 / 频率:和新建一样认领今天已经过去的那一档,别保存的瞬间就跑一次。
        if old.cadence != task.cadence || old.minuteOfDay != task.minuteOfDay || old.weekday != task.weekday {
            task.lastRunSlot = Self.claimed(task.lastRunSlot, task.mostRecentDueSlot(now: now))
        }
        tasks[index] = task
        persist()
    }

    func delete(id: String) {
        tasks.removeAll { $0.id == id }
        persist()
    }

    func setEnabled(_ enabled: Bool, id: String, now: Date = Date()) {
        guard let index = tasks.firstIndex(where: { $0.id == id }) else { return }
        // 停用期间错过的那一档不补跑:重新启用时认领当前档,等下一次到点。
        if enabled && !tasks[index].isEnabled {
            tasks[index].lastRunSlot = Self.claimed(tasks[index].lastRunSlot, tasks[index].mostRecentDueSlot(now: now))
        }
        tasks[index].isEnabled = enabled
        persist()
    }

    private static func claimed(_ last: Date?, _ current: Date?) -> Date? {
        guard let current else { return last }
        guard let last else { return current }
        return max(last, current)
    }

    func markRun(id: String, slot: Date) {
        guard let index = tasks.firstIndex(where: { $0.id == id }) else { return }
        tasks[index].lastRunSlot = slot
        tasks[index].lastRunAt = Date()
        persist()
    }

    /// [E3] 一次运行的去向：开工时记下会话（结果待回写），开工失败 / 被跳过时直接记结果。
    func recordStart(id: String, sessionId: String?) {
        guard let index = tasks.firstIndex(where: { $0.id == id }) else { return }
        tasks[index].lastSessionId = sessionId
        tasks[index].lastResultPreview = nil
        tasks[index].lastStatus = nil
        persist()
    }

    func recordOutcome(id: String, status: ScheduledTask.RunStatus, preview: String? = nil) {
        guard let index = tasks.firstIndex(where: { $0.id == id }) else { return }
        tasks[index].lastStatus = status
        tasks[index].lastResultPreview = preview.map(ScheduledTask.preview)
        persist()
    }

    /// [E3] 运行结束（后台回合跑完后才知道）按会话找回是哪个定时任务。
    /// 返回 true = 找到并写回了。
    @discardableResult
    func recordOutcome(sessionId: String, status: ScheduledTask.RunStatus, preview: String?) -> Bool {
        guard let task = tasks.last(where: { $0.lastSessionId == sessionId }) else { return false }
        recordOutcome(id: task.id, status: status, preview: preview)
        return true
    }

    func dueTasks(now: Date = Date()) -> [ScheduledTask] {
        tasks.filter { $0.isDue(now: now) }
    }

    private func persist() {
        guard let data = try? JSONEncoder().encode(tasks) else { return }
        defaults.set(data, forKey: Self.storageKey)
    }
}
