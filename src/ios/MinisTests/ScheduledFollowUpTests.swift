import XCTest

/// [F2-self-schedule] schedule_followup: parsing, validation, ledger insertion,
/// readiness, daily budget, countdown wording, tool gating.
final class ScheduledFollowUpTests: XCTestCase {
    private var suite: String!
    private var defaults: UserDefaults!
    private let utc8 = TimeZone(secondsFromGMT: 8 * 3600)!

    override func setUp() {
        suite = "f2-followup-\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suite)
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suite)
    }

    private var now: Date { Date(timeIntervalSince1970: 1_791_000_000) }

    private func parse(_ args: [String: Any], runId: String? = "run-1") -> Result<ScheduledFollowUp, ScheduledFollowUp.ParseError> {
        ScheduledFollowUp.parse(args, sessionId: "s1", currentRunId: runId, now: now, timeZone: utc8)
    }

    private func onceArgs(_ extra: [String: Any]) -> [String: Any] {
        ["when": "once", "title": "查快递", "prompt": "看看快递到哪了"].merging(extra) { $1 }
    }

    // MARK: Parsing / validation

    func testParseOnceWithLocalISOTimeUsesDeviceZone() throws {
        let target = now.addingTimeInterval(2 * 3600)
        let local = DateFormatter()
        local.locale = Locale(identifier: "en_US_POSIX")
        local.timeZone = utc8
        local.dateFormat = "yyyy-MM-dd'T'HH:mm"
        let at = local.string(from: target)
        let followUp = try parse(onceArgs(["at": at])).get()
        XCTAssertEqual(followUp.trigger, .once)
        XCTAssertEqual(followUp.fireAt?.timeIntervalSince1970 ?? 0, target.timeIntervalSince1970, accuracy: 60)
        XCTAssertNil(followUp.afterRunId)
        XCTAssertEqual(followUp.sessionId, "s1")
    }

    func testParseOnceWithOffsetAndSpaceSeparatedForms() throws {
        let iso = ISO8601DateFormatter()
        let target = now.addingTimeInterval(3 * 3600)
        let withOffset = try parse(onceArgs(["at": iso.string(from: target)])).get()
        XCTAssertEqual(withOffset.fireAt?.timeIntervalSince1970 ?? 0, target.timeIntervalSince1970, accuracy: 1)
        XCTAssertNotNil(ScheduledFollowUp.parseTime("2026-10-10 15:30", timeZone: utc8))
        XCTAssertNil(ScheduledFollowUp.parseTime("tomorrow afternoon", timeZone: utc8))
    }

    func testParseDelayMinutesHugeOrNonFiniteDoesNotTrap() {
        XCTAssertEqual(parse(onceArgs(["delay_minutes": 1e300])), .failure(.tooFar))
        XCTAssertEqual(parse(onceArgs(["delay_minutes": -1e300])), .failure(.tooSoon))
        XCTAssertEqual(parse(onceArgs(["delay_minutes": Double.nan])), .failure(.missingTime))
        XCTAssertEqual(parse(onceArgs(["delay_minutes": "abc"])), .failure(.missingTime))
        let ok = try? parse(onceArgs(["delay_minutes": 90])).get()
        XCTAssertEqual(ok?.fireAt, now.addingTimeInterval(90 * 60))
    }

    func testParseRejectsMissingFieldsTooSoonAndOverlongPrompt() {
        XCTAssertEqual(parse(["title": "x", "prompt": "y"]), .failure(.missingTrigger))
        XCTAssertEqual(parse(["when": "sometimes", "title": "x", "prompt": "y"]), .failure(.missingTrigger))
        XCTAssertEqual(parse(["when": "once", "title": "  \n ", "prompt": "y", "delay_minutes": 5]), .failure(.missingTitle))
        XCTAssertEqual(parse(["when": "once", "title": "x", "prompt": "  ", "delay_minutes": 5]), .failure(.missingPrompt))
        XCTAssertEqual(parse(onceArgs([:])), .failure(.missingTime))
        XCTAssertEqual(parse(onceArgs(["at": "not a time"])), .failure(.unparseableTime("not a time")))
        XCTAssertEqual(parse(onceArgs(["delay_minutes": 0])), .failure(.tooSoon))
        XCTAssertEqual(parse(onceArgs(["delay_minutes": 31 * 24 * 60])), .failure(.tooFar))
        let long = String(repeating: "长", count: ScheduledFollowUp.promptMaxLength + 1)
        XCTAssertEqual(parse(onceArgs(["prompt": long, "delay_minutes": 5])),
                       .failure(.promptTooLong(ScheduledFollowUp.promptMaxLength + 1)))
        // Every error tells the model what to do.
        XCTAssertTrue(ScheduledFollowUp.ParseError.tooSoon.message.contains("after_completion"))
    }

    func testTitleIsSingleLineAndCapped() throws {
        let title = "第一行\n第二行 " + String(repeating: "很", count: 100)
        let followUp = try parse(onceArgs(["title": title, "delay_minutes": 10])).get()
        XCTAssertFalse(followUp.title.contains("\n"))
        XCTAssertEqual(followUp.title.count, ScheduledFollowUp.titleMaxLength)
        XCTAssertTrue(followUp.title.hasPrefix("第一行 第二行"))
    }

    func testAfterCompletionKeepsTheCurrentRunAndNeedsNoTime() throws {
        let followUp = try parse(["when": "after_completion", "title": "总结", "prompt": "总结刚才的结果"]).get()
        XCTAssertEqual(followUp.trigger, .afterCompletion)
        XCTAssertNil(followUp.fireAt)
        XCTAssertEqual(followUp.afterRunId, "run-1")
        XCTAssertTrue(followUp.deliveredPrompt.hasSuffix("总结刚才的结果"))
    }

    // MARK: Ledger

    @MainActor func testLedgerInsertionAndDueOnlyAtFireTime() throws {
        let store = ScheduledTaskStore(defaults: defaults)
        let followUp = try parse(onceArgs(["delay_minutes": 30])).get()
        let task = try store.addFollowUp(followUp, now: now).get()
        XCTAssertEqual(store.tasks.map(\.id), [task.id])
        XCTAssertTrue(task.isPendingFollowUp)
        XCTAssertEqual(store.pendingFollowUps(sessionId: "s1").map(\.id), [task.id])
        XCTAssertTrue(store.dueTasks(now: now.addingTimeInterval(29 * 60)).isEmpty)
        let fire = now.addingTimeInterval(30 * 60)
        XCTAssertEqual(store.dueTasks(now: fire).map(\.id), [task.id])

        // Persisted and decoded back.
        let reloaded = ScheduledTaskStore(defaults: defaults)
        XCTAssertEqual(reloaded.tasks.first?.followUp, followUp)

        // Once run, it never fires again.
        store.markRun(id: task.id, slot: fire)
        store.setEnabled(false, id: task.id)
        XCTAssertTrue(store.dueTasks(now: fire.addingTimeInterval(60)).isEmpty)
        XCTAssertTrue(store.pendingFollowUps(sessionId: "s1").isEmpty)
    }

    @MainActor func testOnceMissedByMoreThan26HoursExpiresInsteadOfFiring() throws {
        let store = ScheduledTaskStore(defaults: defaults)
        let task = try store.addFollowUp(try parse(onceArgs(["delay_minutes": 10])).get(), now: now).get()
        let late = now.addingTimeInterval(27 * 3600)
        XCTAssertTrue(store.dueTasks(now: late).isEmpty)
        guard case .expired = task.followUpReadiness(now: late, runEnd: { _ in .completed }) else {
            return XCTFail("expected expired")
        }
        store.expireFollowUp(id: task.id, reason: "missed", now: late)
        XCTAssertEqual(store.tasks.first?.lastStatus, .skipped)
        XCTAssertFalse(store.tasks.first?.isPendingFollowUp ?? true)
    }

    @MainActor func testAfterCompletionFollowsTheRunReceipt() throws {
        let store = ScheduledTaskStore(defaults: defaults)
        let followUp = try parse(["when": "after_completion", "title": "t", "prompt": "p"]).get()
        let task = try store.addFollowUp(followUp, now: now).get()
        XCTAssertTrue(store.dueTasks(now: now, runEnd: { _ in .running }).isEmpty)
        XCTAssertEqual(store.dueTasks(now: now, runEnd: { _ in .completed }).map(\.id), [task.id])
        XCTAssertTrue(store.dueTasks(now: now, runEnd: { _ in .notCompleted }).isEmpty)
        guard case .expired = task.followUpReadiness(now: now, runEnd: { _ in .notCompleted }) else {
            return XCTFail("a cancelled/failed run must not trigger its follow-up")
        }
        XCTAssertEqual(task.countdownText(now: now), String(localized: "本轮结束后运行"))
    }

    @MainActor func testDailyBudgetAndPerSessionPendingLimit() throws {
        let store = ScheduledTaskStore(defaults: defaults)
        for i in 0..<ScheduledFollowUp.perSessionPendingLimit {
            _ = try store.addFollowUp(try parse(onceArgs(["delay_minutes": 10 + i])).get(), now: now).get()
        }
        let fourth = try parse(onceArgs(["delay_minutes": 60])).get()
        XCTAssertEqual(store.addFollowUp(fourth, now: now).failureValue, .sessionPendingLimitReached)

        // Other sessions keep going until the daily budget is used up.
        var made = ScheduledFollowUp.perSessionPendingLimit
        var session = 2
        while made < ScheduledFollowUp.dailyLimit {
            var f = fourth
            f.sessionId = "s\(session)"
            _ = try store.addFollowUp(f, now: now).get()
            made += 1
            if made % ScheduledFollowUp.perSessionPendingLimit == 0 { session += 1 }
        }
        var other = fourth
        other.sessionId = "fresh"
        XCTAssertEqual(store.addFollowUp(other, now: now).failureValue, .dailyLimitReached)
        // A new local day resets the budget.
        other.createdAt = now.addingTimeInterval(24 * 3600)
        XCTAssertNotNil(try? store.addFollowUp(other, now: now.addingTimeInterval(24 * 3600)).get())
    }

    @MainActor func testFinishedFollowUpsArePrunedAfterAWeek() throws {
        let store = ScheduledTaskStore(defaults: defaults)
        let task = try store.addFollowUp(try parse(onceArgs(["delay_minutes": 10])).get(), now: now).get()
        store.expireFollowUp(id: task.id, reason: "x", now: now)
        store.pruneFinishedFollowUps(now: now.addingTimeInterval(6 * 24 * 3600))
        XCTAssertEqual(store.tasks.count, 1)
        store.pruneFinishedFollowUps(now: now.addingTimeInterval(8 * 24 * 3600))
        XCTAssertTrue(store.tasks.isEmpty)
    }

    @MainActor func testLegacyLedgerWithoutFollowUpStillDecodes() throws {
        let raw = #"[{"id":"a","quickTaskId":"q","cadence":"daily","minuteOfDay":480,"weekday":2,"isEnabled":true}]"#
        let tasks = ScheduledTaskStore.decodeTasks(Data(raw.utf8), defaults: defaults)
        XCTAssertEqual(tasks.count, 1)
        XCTAssertNil(tasks.first?.followUp)
        XCTAssertFalse(tasks.first?.isFollowUp ?? true)
    }

    // MARK: Countdown

    func testCountdownWordingIsHonest() {
        XCTAssertEqual(ScheduledTask.countdownText(until: now.addingTimeInterval(-5), now: now),
                       String(localized: "已到期 · App 被唤醒时运行"))
        XCTAssertEqual(ScheduledTask.countdownText(until: now.addingTimeInterval(30), now: now),
                       String(localized: "下次应运行 · 还有 \(1) 分钟"))
        XCTAssertEqual(ScheduledTask.countdownText(until: now.addingTimeInterval(2 * 3600 + 100), now: now),
                       String(localized: "下次应运行 · 还有 \(2) 小时"))
        XCTAssertEqual(ScheduledTask.countdownText(until: now.addingTimeInterval(3 * 24 * 3600), now: now),
                       String(localized: "下次应运行 · 还有 \(3) 天"))
    }

    func testRecurringCountdownPointsAtNextSlot() throws {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = utc8
        let morning = try XCTUnwrap(calendar.date(from: DateComponents(year: 2026, month: 10, day: 7, hour: 7)))
        var daily = ScheduledTask(quickTaskId: "q", cadence: .daily, minuteOfDay: 8 * 60, now: morning)
        daily.lastRunSlot = morning   // yesterday's slot already claimed, independent of the simulator's zone
        let next = try XCTUnwrap(daily.nextSlot(after: morning, calendar: calendar))
        XCTAssertEqual(calendar.component(.hour, from: next), 8)
        XCTAssertEqual(daily.countdownTarget(now: morning, calendar: calendar), next)

        // Friday 09:00 → weekdays task next runs Monday 08:00.
        let friday = try XCTUnwrap(calendar.date(from: DateComponents(year: 2026, month: 10, day: 9, hour: 9)))
        let weekdays = ScheduledTask(quickTaskId: "q", cadence: .weekdays, minuteOfDay: 8 * 60, now: friday)
        let monday = try XCTUnwrap(weekdays.nextSlot(after: friday, calendar: calendar))
        XCTAssertEqual(calendar.component(.weekday, from: monday), 2)

        let hourly = ScheduledTask(quickTaskId: "q", cadence: .hourly, now: friday)
        XCTAssertEqual(hourly.nextSlot(after: friday.addingTimeInterval(10 * 60), calendar: calendar),
                       friday.addingTimeInterval(3600))

        var off = daily
        off.isEnabled = false
        XCTAssertNil(off.countdownText(now: morning, calendar: calendar))
    }

    // MARK: Tool gating

    func testToolIsOfferedOnlyToAttendedTopLevelConversations() {
        XCTAssertTrue(AgentToolToggles.offersSelfScheduling(enabled: true, isSubAgentChild: false,
                                                           blocksSideEffectTools: false, isRemote: false))
        XCTAssertFalse(AgentToolToggles.offersSelfScheduling(enabled: true, isSubAgentChild: true,
                                                            blocksSideEffectTools: false, isRemote: false))
        XCTAssertFalse(AgentToolToggles.offersSelfScheduling(enabled: true, isSubAgentChild: false,
                                                            blocksSideEffectTools: true, isRemote: false))
        XCTAssertFalse(AgentToolToggles.offersSelfScheduling(enabled: true, isSubAgentChild: false,
                                                            blocksSideEffectTools: false, isRemote: true))
        XCTAssertFalse(AgentToolToggles.offersSelfScheduling(enabled: false, isSubAgentChild: false,
                                                            blocksSideEffectTools: false, isRemote: false))
        // Quiet / context turns filter it out even if something added it.
        let filtered = ContextToolPolicy.filter([ScheduledFollowUp.toolName, "file_read"], name: { $0 })
        XCTAssertEqual(filtered, ["file_read"])
        XCTAssertEqual(ScheduledFollowUp.toolDefinition.name, ScheduledFollowUp.toolName)
        XCTAssertEqual(Set(ScheduledFollowUp.toolDefinition.required), ["tool_title", "when", "title", "prompt"])
    }
}

private extension Result {
    var failureValue: Failure? {
        if case .failure(let error) = self { return error }
        return nil
    }
}
