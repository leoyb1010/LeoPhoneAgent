import XCTest

/// [F2] Memory undo, tool switches, VoiceOver turn announcement, long-image
/// transcript/pagination, widget background-run gating.
final class F2FeatureTests: XCTestCase {

    // MARK: Memory undo

    func testMemoryUndoTargetParsesOnlyFinishedWrites() {
        let args = ###"{"tool_title":"记住偏好","content":"## 偏好\n用户喜欢简短回答"}"###
        XCTAssertEqual(MemoryWriteUndo.target(toolName: "memory_write", inputArgs: args,
                                              output: "Memory saved to 2026-10-06.md (14 chars)"),
                       .daily(fileName: "2026-10-06.md", content: "## 偏好\n用户喜欢简短回答"))
        XCTAssertNil(MemoryWriteUndo.target(toolName: "memory_write", inputArgs: args,
                                            output: "Error writing memory: disk full"))
        XCTAssertNil(MemoryWriteUndo.target(toolName: "memory_get", inputArgs: args,
                                            output: "Memory saved to 2026-10-06.md (14 chars)"))
        let correction = #"{"content":"不要用英文回复","kind":"correction"}"#
        XCTAssertEqual(MemoryWriteUndo.target(toolName: "memory_write", inputArgs: correction,
                                              output: "Correction recorded permanently. It will be injected…"),
                       .correction(content: "不要用英文回复"))
        // Only a plain dated file name is accepted, never a path.
        XCTAssertNil(MemoryWriteUndo.savedFileName(in: "Memory saved to ../../GLOBAL.md (3 chars)"))
        XCTAssertNil(MemoryWriteUndo.savedFileName(in: "Memory saved to GLOBAL.md (3 chars)"))
    }

    func testRemovingDailyEntryRemovesExactlyThatEntry() throws {
        let a = MemoryDailyLog.entry("A 条", at: Date(timeIntervalSince1970: 3))
        let b = MemoryDailyLog.entry("目标条目\n第二行", at: Date(timeIntervalSince1970: 2))
        let c = MemoryDailyLog.entry("C 条", at: Date(timeIntervalSince1970: 1))
        let text = a + b + c
        let updated = try XCTUnwrap(MemoryWriteUndo.removingDailyEntry(from: text, content: "目标条目\n第二行"))
        XCTAssertEqual(updated, a + c, "only the matching entry goes; neighbours stay byte-identical")
        XCTAssertNil(MemoryWriteUndo.removingDailyEntry(from: text, content: "不存在"))
    }

    func testRemovingDailyEntryWithDuplicatesRemovesNewestOnly() throws {
        let newer = MemoryDailyLog.entry("同样的内容", at: Date(timeIntervalSince1970: 2))
        let older = MemoryDailyLog.entry("同样的内容", at: Date(timeIntervalSince1970: 1))
        let updated = try XCTUnwrap(MemoryWriteUndo.removingDailyEntry(from: newer + older, content: "同样的内容"))
        XCTAssertEqual(updated, older)
    }

    func testRemoveEntryRoundTripsThroughTheDailyLogFile() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("f2-mem-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: dir) }
        let day = Date(timeIntervalSince1970: 1_791_000_000)
        let name = try MemoryDailyLog.prepend("保留这条", in: dir, at: day)
        _ = try MemoryDailyLog.prepend("撤销这条", in: dir, at: day.addingTimeInterval(60))
        XCTAssertTrue(try MemoryDailyLog.removeEntry(matching: "撤销这条", fileName: name, in: dir))
        let text = try String(contentsOf: dir.appendingPathComponent(name), encoding: .utf8)
        XCTAssertFalse(text.contains("撤销这条"))
        XCTAssertTrue(text.contains("保留这条"))
        XCTAssertFalse(try MemoryDailyLog.removeEntry(matching: "撤销这条", fileName: name, in: dir),
                       "a second undo finds nothing")
        XCTAssertFalse(try MemoryDailyLog.removeEntry(matching: "x", fileName: "2000-01-01.md", in: dir))
    }

    func testRemovingCorrectionTakesNewestMatchingLine() throws {
        let lines = ["- [2026-10-01] 不要用英文", "- [2026-10-02] 先给结论", "- [2026-10-03] 不要用英文"]
        let kept = try XCTUnwrap(MemoryWriteUndo.removingCorrection(from: lines, content: "不要用英文"))
        XCTAssertEqual(kept, ["- [2026-10-01] 不要用英文", "- [2026-10-02] 先给结论"])
        XCTAssertEqual(MemoryWriteUndo.removingCorrection(from: lines, content: "先给\n结论"), nil)
        XCTAssertEqual(MemoryWriteUndo.removingCorrection(from: ["- [d] 多行 内容"], content: "多行\n内容"), [])
    }

    func testCappedEntryIsStillFoundByPrefix() throws {
        let content = String(repeating: "很长的记忆", count: 200)
        let stored = MemoryDailyLog.entry(String(content.prefix(600)) + "…(已截断)", at: Date(timeIntervalSince1970: 1))
        XCTAssertEqual(MemoryWriteUndo.removingDailyEntry(from: stored, content: content), "")
    }

    // MARK: Tool switches

    func testBrowserSwitchRemovesBrowserAndAddsSchedulingOnce() {
        let tools = ["shell_execute", "browser_use", "file_read"]
        XCTAssertEqual(AgentToolToggles.apply(tools, name: { $0 }, browserUse: false, selfScheduling: nil),
                       ["shell_execute", "file_read"])
        XCTAssertEqual(AgentToolToggles.apply(tools, name: { $0 }, browserUse: true, selfScheduling: "schedule_followup"),
                       ["shell_execute", "browser_use", "file_read", "schedule_followup"])
        XCTAssertEqual(AgentToolToggles.apply(tools + ["schedule_followup"], name: { $0 }, browserUse: true,
                                              selfScheduling: "schedule_followup").filter { $0 == "schedule_followup" }.count, 1)
        XCTAssertNil(AgentToolToggles.promptFragment(browserUse: true), "prompt unchanged while the browser is on")
        XCTAssertTrue(AgentToolToggles.promptFragment(browserUse: false)?.contains("minis-browser-use") ?? false)
    }

    func testSwitchesDefaultOnAndPersist() {
        let defaults = UserDefaults.standard
        let saved = defaults.object(forKey: AgentToolToggles.browserUseKey)
        defer { defaults.set(saved, forKey: AgentToolToggles.browserUseKey) }
        defaults.removeObject(forKey: AgentToolToggles.browserUseKey)
        XCTAssertTrue(AgentToolToggles.browserUseEnabled)
        AgentToolToggles.browserUseEnabled = false
        XCTAssertFalse(AgentToolToggles.browserUseEnabled)
        // Sub agents keep their own existing key, so both settings pages are one switch.
        XCTAssertEqual(SubAgentSettings.enabledKey, "subagents.enabled")
    }

    // MARK: VoiceOver

    func testTurnAnnouncementIsConciseAndErrorFirst() {
        XCTAssertEqual(TurnAnnouncement.text(replyText: "**好的**,马上处理。下面是详细步骤……", error: nil),
                       String(localized: "回复完成:") + "好的,马上处理。")
        XCTAssertEqual(TurnAnnouncement.text(replyText: "完成了", error: "网络超时\n详细堆栈"),
                       String(localized: "出错了:") + "网络超时")
        XCTAssertEqual(TurnAnnouncement.text(replyText: "", error: nil), String(localized: "回复完成"))
        let long = String(repeating: "字", count: 500)
        let spoken = TurnAnnouncement.text(replyText: long, error: nil)
        XCTAssertLessThanOrEqual(spoken.count, String(localized: "回复完成:").count + TurnAnnouncement.summaryLimit + 1)
    }

    func testTurnAnnouncementGateFiresOncePerTurn() {
        var gate = TurnAnnouncement.Gate()
        XCTAssertTrue(gate.shouldAnnounce(messageId: "m1", error: nil))
        XCTAssertFalse(gate.shouldAnnounce(messageId: "m1", error: nil), "a second isProcessing flip is the same turn")
        XCTAssertTrue(gate.shouldAnnounce(messageId: "m1", error: "boom"), "an error after the reply is news")
        XCTAssertTrue(gate.shouldAnnounce(messageId: "m2", error: nil))
    }

    // MARK: Long image

    func testLongImageStripsInternalTagsAndEmptyMessages() {
        let sources: [LongImageTranscript.Source] = [
            .init(role: .user, text: "帮我查天气<system-reminder>internal</system-reminder>"),
            .init(role: .user, text: "<agent_callback job=\"1\">子代理结果</agent_callback>"),
            .init(role: .assistant, text: "今天晴。<treasury_context id=\"x\">藏宝阁</treasury_context>"),
            .init(role: .assistant, text: "", error: "网络错误"),
            .init(role: .user, text: "", attachmentCount: 2),
            .init(role: .assistant, text: "前半段<system-reminder>never closed and secret"),
        ]
        let items = LongImageTranscript.items(from: sources)
        XCTAssertEqual(items.map(\.text), ["帮我查天气", "今天晴。", "网络错误", "", "前半段"])
        XCTAssertEqual(items[2].isError, true)
        XCTAssertEqual(items[3].attachmentCount, 2)
        XCTAssertFalse(items.contains { $0.text.contains("secret") || $0.text.contains("藏宝阁") })
    }

    func testLongImageCapsHugeMessages() {
        let items = LongImageTranscript.items(from: [.init(role: .assistant, text: String(repeating: "a", count: 50_000))])
        XCTAssertLessThan(items[0].text.count, LongImageTranscript.itemTextLimit + 20)
    }

    func testLongImagePaginationKeepsEverythingWithinMaxHeight() {
        let heights: [CGFloat] = [100, 900, 50, 2500, 300, 0, .nan, 40]
        let pages = LongImageTranscript.paginate(heights: heights, maxHeight: 1000)
        for page in pages {
            XCTAssertLessThanOrEqual(page.reduce(0) { $0 + $1.height }, 1000)
        }
        // Every positive item is fully covered exactly once.
        for (index, height) in heights.enumerated() where height.isFinite && height > 0 {
            let covered = pages.flatMap { $0 }.filter { $0.index == index }.reduce(0) { $0 + $1.height }
            XCTAssertEqual(covered, height, "item \(index)")
        }
        // The 2500 pt item is cut into 1000 + 1000 + 500 strips at increasing offsets.
        let strips = pages.flatMap { $0 }.filter { $0.index == 3 }
        XCTAssertEqual(strips.map(\.y), [0, 1000, 2000])
        XCTAssertTrue(LongImageTranscript.paginate(heights: [10], maxHeight: 0).isEmpty)
    }

    func testLongImageTurnRangeSelection() {
        let items = LongImageTranscript.items(from: [
            .init(role: .assistant, text: "欢迎"),
            .init(role: .user, text: "Q1"), .init(role: .assistant, text: "A1"),
            .init(role: .user, text: "Q2"), .init(role: .assistant, text: "A2"),
            .init(role: .user, text: "Q3"), .init(role: .assistant, text: "A3"),
        ])
        XCTAssertEqual(LongImageTranscript.turnStarts(items), [0, 1, 3, 5])
        XCTAssertEqual(LongImageTranscript.items(items, turns: 2, through: 3).map(\.text), ["Q2", "A2", "Q3", "A3"])
        XCTAssertEqual(LongImageTranscript.items(items, turns: 3, through: 2).map(\.text), ["Q2", "A2", "Q3", "A3"])
        XCTAssertEqual(LongImageTranscript.items(items, turns: 9, through: 99).map(\.text), ["Q3", "A3"])
    }

    // MARK: Widget background run

    func testWidgetRunsOnlyTasksThatWorkInTheBackground() {
        let plain = QuickTaskDefinition(id: "w", name: "天气", prompt: "查询今天的天气", symbolName: "cloud",
                                        isBuiltIn: false, sortOrder: 0)
        XCTAssertTrue(plain.runsInBackground)
        let slots = QuickTaskDefinition(id: "t", name: "翻译", prompt: "把 {{text}} 翻译成英文", symbolName: "a",
                                        isBuiltIn: false, sortOrder: 0)
        XCTAssertFalse(slots.runsInBackground)
        let clipboard = QuickTaskDefinition.builtIns.first { $0.id == "clipboardAssistant" }
        XCTAssertEqual(clipboard?.runsInBackground, false)
    }

    func testWidgetItemNeedsAppDecodesFromLegacySnapshots() throws {
        let legacy = Data(#"{"id":"task","name":"Task","symbolName":"bolt"}"#.utf8)
        XCTAssertFalse(try JSONDecoder().decode(WidgetQuickTaskItem.self, from: legacy).needsApp)
        var item = WidgetQuickTaskItem(id: "c", name: "C", symbolName: "doc")
        item.needsApp = true
        let round = try JSONDecoder().decode(WidgetQuickTaskItem.self, from: JSONEncoder().encode(item))
        XCTAssertTrue(round.needsApp)
    }
}
