import XCTest

/// [F5][F7][F8] UI 统一与首页的纯逻辑部分（LeoUIPolicies.swift）。
final class UIUnificationTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_790_000_000)

    private func session(_ id: String, minutesAgo: Double, unfinished: Bool) -> HomeContextSession {
        HomeContextSession(id: id, title: "T-\(id)", updatedAt: now.addingTimeInterval(-minutesAgo * 60), unfinished: unfinished)
    }

    private func snapshot(_ sessions: [HomeContextSession], pending: Int = 0, hasFolders: Bool = false,
                          inbox: Bool = false, pinnedId: String? = nil, pinnedAt: Double? = nil,
                          focus: Any? = nil) -> HomeContextSnapshot {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "Asia/Shanghai")!
        return HomeContextResolver.snapshot(sessions: sessions, pendingCount: pending, hasFolders: hasFolders,
                                            inboxActive: inbox, pinnedSessionId: pinnedId, pinnedAt: pinnedAt,
                                            focusPayload: focus, now: now, calendar: calendar)
    }

    private func focusJSON(createdAt: Double, title: String = "写周报") -> String {
        "{\"title\":\"\(title)\",\"done\":[\"大纲\",\"数据\"],\"pending\":[\"配图\"],\"createdAt\":\(createdAt)}"
    }

    // MARK: F5 继续上次

    func testResumePicksMostRecentUnfinishedSession() {
        let s = snapshot([session("a", minutesAgo: 5, unfinished: false),
                          session("b", minutesAgo: 30, unfinished: true),
                          session("c", minutesAgo: 90, unfinished: true)])
        XCTAssertEqual(s.resume?.sessionId, "b")
        XCTAssertEqual(s.resume?.pinned, false)
    }

    func testNoUnfinishedSessionMeansNoResumeRow() {
        let s = snapshot([session("a", minutesAgo: 5, unfinished: false)])
        XCTAssertNil(s.resume)
    }

    func testFreshPinFromContextLayerWinsOverRecency() {
        let pinnedAt = now.timeIntervalSince1970 - 3600
        let s = snapshot([session("a", minutesAgo: 1, unfinished: true),
                          session("old", minutesAgo: 600, unfinished: false)],
                         pinnedId: "old", pinnedAt: pinnedAt)
        XCTAssertEqual(s.resume?.sessionId, "old")
        XCTAssertEqual(s.resume?.pinned, true)
    }

    func testStalePinOrMissingSessionFallsBackToRecency() {
        let sessions = [session("a", minutesAgo: 1, unfinished: true)]
        let stale = snapshot(sessions, pinnedId: "a2", pinnedAt: now.timeIntervalSince1970 - 60)
        XCTAssertEqual(stale.resume?.sessionId, "a", "pinned session no longer exists")
        let old = snapshot(sessions + [session("p", minutesAgo: 900, unfinished: false)],
                           pinnedId: "p", pinnedAt: now.timeIntervalSince1970 - 13 * 3600)
        XCTAssertEqual(old.resume?.sessionId, "a", "pins expire after 12h")
        XCTAssertEqual(old.resume?.pinned, false)
    }

    // MARK: F5 今日 / 收件箱 / 全空

    func testTodayCountsOnlySessionsTouchedToday() {
        let s = snapshot([session("a", minutesAgo: 1, unfinished: false),
                          session("b", minutesAgo: 3 * 24 * 60, unfinished: false)], pending: 2)
        XCTAssertEqual(s.todaySessions, 1)
        XCTAssertEqual(s.pendingCount, 2)
        XCTAssertTrue(s.showsToday)
    }

    func testInboxToggleOnlyWhenFoldersExistOrActive() {
        XCTAssertFalse(snapshot([]).showsInboxToggle)
        XCTAssertTrue(snapshot([], hasFolders: true).showsInboxToggle)
        let active = snapshot([], inbox: true)
        XCTAssertTrue(active.showsInboxToggle, "must always offer the way back to 全部")
        XCTAssertTrue(active.inboxActive)
    }

    func testEmptyLibraryHidesWholeStrip() {
        XCTAssertTrue(snapshot([]).isEmpty)
        XCTAssertTrue(snapshot([session("a", minutesAgo: 3 * 24 * 60, unfinished: false)]).isEmpty)
        XCTAssertFalse(snapshot([session("a", minutesAgo: 5, unfinished: false)]).isEmpty)
    }

    func testQuietUnreadResultsSurfaceTheInboxToggle() {
        let s = HomeContextResolver.snapshot(sessions: [], pendingCount: 0, hasFolders: false, inboxActive: false,
                                             quietUnread: 3, pinnedSessionId: nil, pinnedAt: nil,
                                             focusPayload: nil, now: now)
        XCTAssertEqual(s.quietUnread, 3)
        XCTAssertTrue(s.showsInboxToggle)
        XCTAssertFalse(s.isEmpty)
        XCTAssertEqual(HomeContextResolver.quietSources, ["quiet", "context"])
    }

    // MARK: F5 专注收尾卡

    func testFocusWrapUpDecodesStringDataAndDictionaryWithin24h() throws {
        let created = now.timeIntervalSince1970 - 2 * 3600
        let json = focusJSON(createdAt: created)
        let fromString = try XCTUnwrap(snapshot([], focus: json).focus)
        XCTAssertEqual(fromString.title, "写周报")
        XCTAssertEqual(fromString.done.count, 2)
        XCTAssertEqual(fromString.pending, ["配图"])
        XCTAssertEqual(snapshot([], focus: Data(json.utf8)).focus, fromString)
        let dict: [String: Any] = ["title": "写周报", "done": ["大纲", "数据"], "pending": ["配图"], "createdAt": created]
        XCTAssertEqual(snapshot([], focus: dict).focus, fromString)
        XCTAssertFalse(snapshot([], focus: json).isEmpty, "a focus card alone keeps the strip")
    }

    func testFocusWrapUpOlderThan24hOrMalformedIsIgnored() {
        XCTAssertNil(snapshot([], focus: focusJSON(createdAt: now.timeIntervalSince1970 - 25 * 3600)).focus)
        XCTAssertNil(snapshot([], focus: "{\"title\":1}").focus)
        XCTAssertNil(snapshot([], focus: 42).focus)
        XCTAssertNil(snapshot([], focus: nil).focus)
    }

    func testContextKeysMatchTheContextLayerContract() {
        XCTAssertEqual(HomeContextResolver.pinnedSessionIdKey, "leo.context.pinnedSessionId")
        XCTAssertEqual(HomeContextResolver.pinnedAtKey, "leo.context.pinnedAt")
        XCTAssertEqual(HomeContextResolver.focusSummaryKey, "leo.context.focusSummary")
    }

    // MARK: F7 思考窗口

    func testThinkingTailIsShortWhileStreamingAndLongWhenSettled() {
        let line = String(repeating: "想", count: 99) + "\n"
        let content = String(repeating: line, count: 100)   // 10_000 chars
        let streaming = ThinkingDisplayPolicy.tail(of: content, isStreaming: true)
        XCTAssertTrue(streaming.truncated)
        XCTAssertLessThanOrEqual(streaming.text.count, ThinkingDisplayPolicy.streamingWindow)
        XCTAssertTrue(streaming.text.hasPrefix("想"), "cut lands on a line start")
        let settled = ThinkingDisplayPolicy.tail(of: content, isStreaming: false)
        XCTAssertTrue(settled.truncated)
        XCTAssertGreaterThan(settled.text.count, streaming.text.count)
        XCTAssertLessThanOrEqual(settled.text.count, ThinkingDisplayPolicy.settledWindow)
        XCTAssertTrue(content.hasSuffix(settled.text))
    }

    func testShortThinkingIsShownWhole() {
        let tail = ThinkingDisplayPolicy.tail(of: "短短的思考", isStreaming: true)
        XCTAssertFalse(tail.truncated)
        XCTAssertEqual(String(tail.text), "短短的思考")
    }

    func testThinkingTailWithoutNewlinesStillCaps() {
        let content = String(repeating: "x", count: 5_000)
        let tail = ThinkingDisplayPolicy.tail(of: content, isStreaming: true)
        XCTAssertTrue(tail.truncated)
        XCTAssertEqual(tail.text.count, ThinkingDisplayPolicy.streamingWindow)
    }

    // MARK: F8 检查器三页

    func testInspectorHasThreeFixedTabsAndMigratesOldSelections() {
        XCTAssertEqual(ChatInspectorTabPolicy.tabs, ["run", "usage", "memory"])
        XCTAssertEqual(ChatInspectorTabPolicy.resolve("memory"), "memory")
        XCTAssertEqual(ChatInspectorTabPolicy.resolve("session"), "usage")
        XCTAssertEqual(ChatInspectorTabPolicy.resolve("artifacts"), "run")
        XCTAssertEqual(ChatInspectorTabPolicy.resolve("files"), "run")
        XCTAssertEqual(ChatInspectorTabPolicy.resolve(nil), "run")
    }
}
