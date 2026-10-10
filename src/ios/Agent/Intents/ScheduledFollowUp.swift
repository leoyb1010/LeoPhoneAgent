//
//  ScheduledFollowUp.swift
//  MinisApp
//
//  [F2-self-schedule] The model schedules a follow-up in the current session:
//  `once` at a time, or `after_completion` of the current run. It is NOT a
//  second scheduler — it becomes one more entry in the ScheduledTaskStore
//  ledger, and the same reconcile (foreground, Shortcuts automation, the
//  after-completion observer) runs it. Wording stays honest: iOS cannot wake
//  the app on a clock, so a due follow-up runs the next time the app is awake;
//  a local reminder notification fires at the due time as the safety net.
//
//  Pure logic only (parsing, validation, readiness, countdown text) so the
//  logic-test target compiles it.
//

import Foundation

struct ScheduledFollowUp: Codable, Hashable {
    enum Trigger: String, Codable, CaseIterable {
        case once
        case afterCompletion = "after_completion"
    }

    /// How the run a follow-up waits for ended (from the run receipt).
    enum RunEnd: Equatable {
        case running
        case completed
        case notCompleted
    }

    enum Readiness: Equatable {
        case waiting
        case due
        /// Missed by more than `staleAfter`, or the awaited run did not finish normally.
        case expired(reason: String)
        /// Already ran, or switched off.
        case done
    }

    var trigger: Trigger
    /// `once`: when it should run (absolute).
    var fireAt: Date?
    /// `after_completion`: the run it waits for.
    var afterRunId: String?
    var title: String
    var prompt: String
    var sessionId: String
    var createdAt: Date

    // MARK: Limits

    static let toolName = "schedule_followup"
    static let titleMaxLength = 40
    static let promptMaxLength = 2_000
    static let minimumLeadTime: TimeInterval = 60
    static let maximumLeadTime: TimeInterval = 30 * 24 * 3600
    /// Same window recurring tasks get: a slot more than 26 h stale is skipped, not resurrected.
    static let staleAfter: TimeInterval = 26 * 3600
    /// Daily budget: follow-ups the model may create per local day, across all sessions.
    static let dailyLimit = 8
    /// At most this many not-yet-run follow-ups per session.
    static let perSessionPendingLimit = 3

    // MARK: Parsing

    enum ParseError: Error, Equatable {
        case missingTrigger
        case missingTitle
        case missingPrompt
        case promptTooLong(Int)
        case missingTime
        case unparseableTime(String)
        case tooSoon
        case tooFar

        /// Model-facing explanation (English, like every other tool error).
        var message: String {
            switch self {
            case .missingTrigger:
                return "Error: 'when' must be \"once\" or \"after_completion\"."
            case .missingTitle:
                return "Error: 'title' is required — a short label the user will see (max \(ScheduledFollowUp.titleMaxLength) chars)."
            case .missingPrompt:
                return "Error: 'prompt' is required — the full instruction to run later in this conversation."
            case .promptTooLong(let count):
                return "Error: 'prompt' is \(count) characters; keep it under \(ScheduledFollowUp.promptMaxLength)."
            case .missingTime:
                return "Error: when=\"once\" needs 'at' (ISO-8601 local time, e.g. 2026-10-10T15:30) or 'delay_minutes'."
            case .unparseableTime(let raw):
                return "Error: could not read 'at' = \"\(raw.prefix(40))\". Use ISO-8601 like 2026-10-10T15:30 or 2026-10-10T15:30:00+08:00, or pass 'delay_minutes'."
            case .tooSoon:
                return "Error: a once follow-up must be at least 1 minute ahead. To continue right after this turn use when=\"after_completion\"."
            case .tooFar:
                return "Error: follow-ups can be scheduled at most 30 days ahead."
            }
        }
    }

    /// Parses `schedule_followup` arguments. `currentRunId` is the run the tool
    /// was called from (needed for `after_completion`).
    static func parse(_ args: [String: Any], sessionId: String, currentRunId: String?,
                      now: Date, timeZone: TimeZone = .current) -> Result<ScheduledFollowUp, ParseError> {
        guard let rawTrigger = (args["when"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(),
              let trigger = Trigger(rawValue: rawTrigger == "after-completion" ? Trigger.afterCompletion.rawValue : rawTrigger) else {
            return .failure(.missingTrigger)
        }
        let title = singleLine(args["title"] as? String ?? "")
        guard !title.isEmpty else { return .failure(.missingTitle) }
        let prompt = (args["prompt"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !prompt.isEmpty else { return .failure(.missingPrompt) }
        guard prompt.count <= promptMaxLength else { return .failure(.promptTooLong(prompt.count)) }

        var fireAt: Date?
        switch trigger {
        case .afterCompletion:
            fireAt = nil
        case .once:
            if let raw = args["at"] as? String, !raw.trimmingCharacters(in: .whitespaces).isEmpty {
                guard let date = parseTime(raw, timeZone: timeZone) else { return .failure(.unparseableTime(raw)) }
                fireAt = date
            } else if let minutes = finiteNumber(args["delay_minutes"]) {
                // Clamp before converting: 1e300 must not reach a Date / Int conversion.
                let seconds = min(max(minutes, -1), maximumLeadTime / 60 + 1) * 60
                fireAt = now.addingTimeInterval(seconds)
            } else {
                return .failure(.missingTime)
            }
            guard let fireAt else { return .failure(.missingTime) }
            let lead = fireAt.timeIntervalSince(now)
            if lead < minimumLeadTime - 1 { return .failure(.tooSoon) }
            if lead > maximumLeadTime { return .failure(.tooFar) }
        }
        return .success(ScheduledFollowUp(
            trigger: trigger, fireAt: fireAt,
            afterRunId: trigger == .afterCompletion ? currentRunId : nil,
            title: String(title.prefix(titleMaxLength)), prompt: prompt,
            sessionId: sessionId, createdAt: now))
    }

    static func singleLine(_ text: String) -> String {
        text.split(whereSeparator: \.isNewline)
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
            .joined(separator: " ")
    }

    private static func finiteNumber(_ value: Any?) -> Double? {
        let number: Double?
        switch value {
        case let n as NSNumber: number = n.doubleValue
        case let s as String: number = Double(s.trimmingCharacters(in: .whitespaces))
        default: number = nil
        }
        guard let number, number.isFinite else { return nil }
        return number
    }

    /// ISO-8601 with or without offset; a time without offset is the user's local time.
    static func parseTime(_ raw: String, timeZone: TimeZone = .current) -> Date? {
        let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withInternetDateTime]
        if let date = iso.date(from: text) { return date }
        iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = iso.date(from: text) { return date }
        let local = DateFormatter()
        local.locale = Locale(identifier: "en_US_POSIX")
        local.timeZone = timeZone
        for format in ["yyyy-MM-dd'T'HH:mm:ss", "yyyy-MM-dd'T'HH:mm", "yyyy-MM-dd HH:mm:ss", "yyyy-MM-dd HH:mm"] {
            local.dateFormat = format
            if let date = local.date(from: text) { return date }
        }
        return nil
    }

    /// What the reminder notification and the delivered message say.
    var deliveredPrompt: String {
        String(localized: "⏰ 定时跟进「\(title)」(Agent 之前自己安排的,不是你新发的消息)") + "\n\n" + prompt
    }
}

extension ScheduledTask {
    /// A ledger entry for a follow-up. `quickTaskId` stays empty: there is no quick task.
    init(followUp: ScheduledFollowUp, id: String = UUID().uuidString.lowercased()) {
        self.init(id: id, quickTaskId: "", cadence: .daily, minuteOfDay: 0, weekday: 2,
                  isEnabled: true, now: followUp.createdAt)
        self.lastRunSlot = nil
        self.followUp = followUp
    }

    var isFollowUp: Bool { followUp != nil }

    /// Not yet run and still switched on.
    var isPendingFollowUp: Bool { followUp != nil && isEnabled && lastRunSlot == nil }

    func followUpReadiness(now: Date, runEnd: (String) -> ScheduledFollowUp.RunEnd) -> ScheduledFollowUp.Readiness {
        guard let followUp else { return .done }
        guard isEnabled, lastRunSlot == nil else { return .done }
        switch followUp.trigger {
        case .once:
            guard let fireAt = followUp.fireAt else { return .expired(reason: "missing time") }
            if fireAt > now { return .waiting }
            return now.timeIntervalSince(fireAt) < ScheduledFollowUp.staleAfter
                ? .due : .expired(reason: String(localized: "错过超过 26 小时,已跳过"))
        case .afterCompletion:
            if now.timeIntervalSince(followUp.createdAt) >= ScheduledFollowUp.staleAfter {
                return .expired(reason: String(localized: "等待本轮结束超过 26 小时,已跳过"))
            }
            guard let runId = followUp.afterRunId else { return .due }
            switch runEnd(runId) {
            case .running: return .waiting
            case .completed: return .due
            case .notCompleted: return .expired(reason: String(localized: "那一轮没有正常完成,已跳过"))
            }
        }
    }

    /// The first slot strictly after `now` (recurring tasks only).
    func nextSlot(after now: Date, calendar: Calendar = .current) -> Date? {
        switch cadence {
        case .hourly:
            guard let start = calendar.dateInterval(of: .hour, for: now)?.start else { return nil }
            return calendar.date(byAdding: .hour, value: 1, to: start)
        case .daily, .weekdays, .weekly:
            let hour = minuteOfDay / 60
            let minute = minuteOfDay % 60
            for dayOffset in 0...8 {
                guard let day = calendar.date(byAdding: .day, value: dayOffset, to: now),
                      let slot = calendar.date(bySettingHour: hour, minute: minute, second: 0, of: day),
                      slot > now else { continue }
                let wd = calendar.component(.weekday, from: slot)
                switch cadence {
                case .weekdays where !(2...6).contains(wd): continue
                case .weekly where wd != weekday: continue
                default: return slot
                }
            }
            return nil
        }
    }

    /// When the countdown pill should point at. nil = no countdown (off, done,
    /// or waiting for the current run to finish).
    func countdownTarget(now: Date, calendar: Calendar = .current) -> Date? {
        guard isEnabled else { return nil }
        if let followUp {
            guard lastRunSlot == nil, followUp.trigger == .once else { return nil }
            return followUp.fireAt
        }
        if isDue(now: now, calendar: calendar) { return now }
        return nextSlot(after: now, calendar: calendar)
    }

    /// 「下次应运行 · 还有 2 小时」. Honest: it runs when the app is awake, not to the second.
    func countdownText(now: Date, calendar: Calendar = .current) -> String? {
        if let followUp, isPendingFollowUp, followUp.trigger == .afterCompletion {
            return String(localized: "本轮结束后运行")
        }
        guard let target = countdownTarget(now: now, calendar: calendar) else { return nil }
        return Self.countdownText(until: target, now: now)
    }

    static func countdownText(until target: Date, now: Date) -> String {
        let seconds = target.timeIntervalSince(now)
        if seconds <= 0 { return String(localized: "已到期 · App 被唤醒时运行") }
        let minutes = max(1, Int((seconds / 60).rounded(.up)))
        if minutes < 60 { return String(localized: "下次应运行 · 还有 \(minutes) 分钟") }
        let hours = minutes / 60
        if hours < 48 { return String(localized: "下次应运行 · 还有 \(hours) 小时") }
        return String(localized: "下次应运行 · 还有 \(hours / 24) 天")
    }

    /// Display name for settings rows / intents.
    var followUpTitle: String? { followUp?.title }
}

extension ScheduledFollowUp {
    enum BudgetError: Error, Equatable {
        case dailyLimitReached
        case sessionPendingLimitReached

        var message: String {
            switch self {
            case .dailyLimitReached:
                return "Error: the daily limit of \(ScheduledFollowUp.dailyLimit) scheduled follow-ups is used up. Tell the user instead of scheduling more today."
            case .sessionPendingLimitReached:
                return "Error: this conversation already has \(ScheduledFollowUp.perSessionPendingLimit) pending follow-ups. Wait for one to run, or ask the user to remove one in Settings › Scheduled Tasks."
            }
        }
    }

    /// The ledger's budget rule for one more follow-up.
    static func checkBudget(existing: [ScheduledTask], sessionId: String, now: Date,
                            calendar: Calendar = .current) -> BudgetError? {
        let today = existing.filter {
            guard let created = $0.followUp?.createdAt else { return false }
            return calendar.isDate(created, inSameDayAs: now)
        }
        if today.count >= dailyLimit { return .dailyLimitReached }
        let pending = existing.filter { $0.isPendingFollowUp && $0.followUp?.sessionId == sessionId }
        if pending.count >= perSessionPendingLimit { return .sessionPendingLimitReached }
        return nil
    }
}
