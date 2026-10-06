import XCTest

/// [D1][D3][D4][D5][D6] 情境层的纯逻辑。
final class ContextLayerTests: XCTestCase {
    private var calendar: Calendar = {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = TimeZone(identifier: "Asia/Shanghai")!
        return c
    }()

    private func date(_ day: Int, _ hour: Int, _ minute: Int = 0) -> Date {
        calendar.date(from: DateComponents(year: 2026, month: 10, day: day, hour: hour, minute: minute))!
    }

    // MARK: D1 规则模型

    func testLegacyRuleJSONDecodesAsTierTwo() throws {
        // 1.56.0 及以前写下的规则:没有 tier 字段。
        let legacy = """
        [{"id":"r1","name":"到公司简报","trigger":{"beforeEvent":{"minutes":30}},
          "quickTaskId":"q1","isEnabled":true,"score":-1}]
        """
        let rules = try JSONDecoder().decode([AutomationRule].self, from: Data(legacy.utf8))
        XCTAssertEqual(rules.count, 1)
        XCTAssertEqual(rules[0].tier, AutomationRule.Tier.speak)
        XCTAssertEqual(rules[0].trigger, .beforeEvent(minutes: 30))
        XCTAssertEqual(rules[0].score, -1)
        XCTAssertEqual(rules[0].quickTaskId, "q1")
    }

    func testLegacyNightChargingRuleStillDecodes() throws {
        let legacy = #"{"id":"r2","name":"夜里","trigger":{"nightCharging":{}},"prompt":"整理","isEnabled":false,"score":0}"#
        let rule = try JSONDecoder().decode(AutomationRule.self, from: Data(legacy.utf8))
        XCTAssertEqual(rule.trigger, .nightCharging)
        XCTAssertFalse(rule.isEnabled)
        XCTAssertEqual(rule.tier, 2)
    }

    func testSignalRuleRoundTripsWithTier() throws {
        var rule = AutomationRule(name: "到家", trigger: .signal(name: "到家"), prompt: "看看今天还差什么")
        rule.tier = AutomationRule.Tier.prepare
        let decoded = try JSONDecoder().decode(AutomationRule.self, from: JSONEncoder().encode(rule))
        XCTAssertEqual(decoded, rule)
        XCTAssertEqual(decoded.tier, 1)
    }

    func testSignalTriggerMatching() {
        let trigger = AutomationRule.Trigger.signal(name: "Car Bluetooth")
        XCTAssertTrue(trigger.matchesSignal("car bluetooth"))
        XCTAssertTrue(trigger.matchesSignal("  Car Bluetooth \n"))
        XCTAssertFalse(trigger.matchesSignal("到家"))
        XCTAssertFalse(AutomationRule.Trigger.nightCharging.matchesSignal("Car Bluetooth"))
        XCTAssertFalse(AutomationRule.Trigger.signal(name: " ").matchesSignal(" "))
    }

    func testDedupeWindowStillThirtyMinutes() {
        var rule = AutomationRule(name: "x", trigger: .signal(name: "到家"))
        let now = date(6, 18)
        rule.lastFiredAt = now.addingTimeInterval(-29 * 60)
        XCTAssertFalse(rule.canFire(now: now))
        rule.lastFiredAt = now.addingTimeInterval(-31 * 60)
        XCTAssertTrue(rule.canFire(now: now))
    }

    // MARK: D3 决策

    private func snapshot(_ candidates: [ContextDecision.Candidate], now: Date) -> ContextDecision.Snapshot {
        .init(interrupted: candidates, now: now, isLocked: true)
    }

    func testHomeWithInterruptedSessionTodayPinsIt() {
        let now = date(6, 19)
        let d = ContextDecision.decide(
            signal: "到家",
            snapshot: snapshot([.init(sessionId: "s1", title: "改简历", updatedAt: date(6, 18, 10))], now: now),
            calendar: calendar)
        XCTAssertEqual(d.tier, AutomationRule.Tier.prepare)
        XCTAssertEqual(d.sessionId, "s1")
        XCTAssertTrue(d.worthSpeaking)
    }

    func testHomeWithoutInterruptedSessionIsLogOnly() {
        let d = ContextDecision.decide(signal: "到家", snapshot: snapshot([], now: date(6, 19)), calendar: calendar)
        XCTAssertEqual(d.tier, AutomationRule.Tier.logOnly)
        XCTAssertNil(d.sessionId)
        XCTAssertFalse(d.worthSpeaking)
    }

    func testInterruptedYesterdayDoesNotCount() {
        let d = ContextDecision.decide(
            signal: "到家",
            snapshot: snapshot([.init(sessionId: "old", title: "", updatedAt: date(5, 15))], now: date(6, 19)),
            calendar: calendar)
        XCTAssertEqual(d.tier, 0)
        XCTAssertNil(d.sessionId)
    }

    func testLateNightStillPinsButNeverSpeaks() {
        // 凌晨 1 点到家:昨晚 22:40 中断的会话还算「今天」,放上首页,但不开口。
        let now = date(7, 1)
        let d = ContextDecision.decide(
            signal: "到家",
            snapshot: snapshot([.init(sessionId: "night", title: "", updatedAt: date(6, 22, 40))], now: now),
            calendar: calendar)
        XCTAssertEqual(d.tier, AutomationRule.Tier.prepare)
        XCTAssertEqual(d.sessionId, "night")
        XCTAssertFalse(d.worthSpeaking)
        XCTAssertFalse(ContextDecision.allowsSpeaking(d, enabled: true, onDeviceModelReady: true, spokenToday: 0))
        // 凌晨 1 点时,前一天凌晨 3 点的会话已经是「昨天」。
        let stale = ContextDecision.decide(
            signal: "到家",
            snapshot: snapshot([.init(sessionId: "x", title: "", updatedAt: date(6, 3))], now: now),
            calendar: calendar)
        XCTAssertEqual(stale.tier, 0)
    }

    func testMultipleCandidatesPicksMostRecent() {
        let now = date(6, 20)
        let d = ContextDecision.decide(
            signal: "到家",
            snapshot: snapshot([
                .init(sessionId: "a", title: "", updatedAt: date(6, 9)),
                .init(sessionId: "c", title: "", updatedAt: date(6, 17, 30)),
                .init(sessionId: "b", title: "", updatedAt: date(6, 12)),
            ], now: now),
            calendar: calendar)
        XCTAssertEqual(d.sessionId, "c")
        XCTAssertEqual(d.tier, 1)
        // 最近的那个已经过去两个半小时:放上首页,但不值得开口。
        XCTAssertFalse(d.worthSpeaking)
    }

    func testNonHomeSignalIsLogOnly() {
        let d = ContextDecision.decide(
            signal: "上车",
            snapshot: snapshot([.init(sessionId: "s", title: "", updatedAt: date(6, 18))], now: date(6, 18, 30)),
            calendar: calendar)
        XCTAssertEqual(d.tier, 0)
        XCTAssertNil(d.sessionId)
    }

    // MARK: D6 闸门

    func testSpeakingGate() {
        let worth = ContextDecision(tier: 1, reason: "", sessionId: "s", worthSpeaking: true)
        XCTAssertTrue(ContextDecision.allowsSpeaking(worth, enabled: true, onDeviceModelReady: true, spokenToday: 2))
        XCTAssertFalse(ContextDecision.allowsSpeaking(worth, enabled: false, onDeviceModelReady: true, spokenToday: 0))
        XCTAssertFalse(ContextDecision.allowsSpeaking(worth, enabled: true, onDeviceModelReady: false, spokenToday: 0))
        XCTAssertFalse(ContextDecision.allowsSpeaking(worth, enabled: true, onDeviceModelReady: true, spokenToday: 3))
        let notWorth = ContextDecision(tier: 1, reason: "", sessionId: "s", worthSpeaking: false)
        XCTAssertFalse(ContextDecision.allowsSpeaking(notWorth, enabled: true, onDeviceModelReady: true, spokenToday: 0))
    }

    // MARK: D2 工具限制

    func testContextTurnsDropSendDeleteRemoteTools() {
        let names = ["shell_execute", "file_read", "browser_use", "remote_shell", "remote_agent",
                     "dispatch_subtask", "memory_write", "treasury_save"]
        let kept = ContextToolPolicy.filter(names, name: { $0 })
        XCTAssertEqual(kept, ["file_read", "memory_write", "treasury_save"])
    }

    /// 无人值守回合不给能覆盖 / 清空文件的工具。
    func testContextToolPolicyBlocksFileMutation() {
        XCTAssertTrue(ContextToolPolicy.blockedTools.contains("file_write"))
        XCTAssertTrue(ContextToolPolicy.blockedTools.contains("file_edit"))
        XCTAssertFalse(ContextToolPolicy.blockedTools.contains("memory_write"), "安静任务的记忆整理要用")
    }

    /// 先压缩再发:压缩中 / 待发都算回合还在,工具限制不能提前解除。
    func testTurnStillActiveWhileCompacting() {
        XCTAssertTrue(ContextToolPolicy.isTurnActive(processing: false, compacting: true, pendingCompactSend: false, tracked: false))
        XCTAssertTrue(ContextToolPolicy.isTurnActive(processing: false, compacting: false, pendingCompactSend: true, tracked: false))
        XCTAssertFalse(ContextToolPolicy.isTurnActive(processing: false, compacting: false, pendingCompactSend: false, tracked: false))
    }

    // MARK: D4 预算

    func testBudgetCountsAndResetsDaily() {
        let morning = date(6, 2)
        var budget = QuietTaskBudget(day: QuietTaskBudget.dayString(morning, calendar: calendar), used: 0)
        budget = budget.adding(12_000, now: morning, calendar: calendar)
        budget = budget.adding(5_000, now: morning, calendar: calendar)
        XCTAssertEqual(budget.used, 17_000)
        XCTAssertEqual(budget.remaining(limit: 20_000, now: morning, calendar: calendar), 3_000)
        budget = budget.adding(9_000, now: morning, calendar: calendar)
        XCTAssertEqual(budget.remaining(limit: 20_000, now: morning, calendar: calendar), 0)
        // 第二天清零
        XCTAssertEqual(budget.remaining(limit: 20_000, now: date(7, 2), calendar: calendar), 20_000)
        XCTAssertEqual(budget.adding(100, now: date(7, 2), calendar: calendar).used, 100)
        XCTAssertEqual(QuietTaskBudget.defaultLimit, 20_000)
    }

    // MARK: D5 专注收尾卡片

    func testFocusSummarySplitsDoneAndPendingWithinWindow() throws {
        let start = date(6, 9), end = date(6, 10, 30)
        let summary = try XCTUnwrap(FocusSummary.make(
            modeName: "深度工作", start: start, end: end,
            sessions: [
                .init(sessionId: "a", title: "写周报", updatedAt: date(6, 9, 20)),
                .init(sessionId: "b", title: "", updatedAt: date(6, 10)),
                .init(sessionId: "c", title: "昨天的", updatedAt: date(5, 9, 30)),
            ],
            interrupted: ["b"]))
        XCTAssertEqual(summary.title, "深度工作 · 90 分钟")
        XCTAssertEqual(summary.done, ["写周报"])
        XCTAssertEqual(summary.pending, ["未命名会话"])
        XCTAssertEqual(summary.createdAt, end.timeIntervalSince1970)
        // 契约字段名
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(summary)) as? [String: Any])
        XCTAssertEqual(Set(json.keys), ["title", "done", "pending", "createdAt"])
    }

    func testFocusSummaryNilWhenNothingHappened() {
        XCTAssertNil(FocusSummary.make(modeName: "专注", start: date(6, 9), end: date(6, 10),
                                       sessions: [.init(sessionId: "x", title: "", updatedAt: date(6, 11))],
                                       interrupted: []))
    }
}
