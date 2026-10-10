import XCTest

/// [T-tool-step-collapse] Which tool capsules of one reply fold into
/// "已运行 N 个工具 · 9 秒". Pure rules in `ToolStepGrouping.swift`; the list
/// only maps blocks to steps and renders the entries.
final class ToolStepGroupingTests: XCTestCase {

    private func tool(_ role: ToolStep.Role = .completedTool, summary: String? = nil, useId: String? = nil,
                      start: Date? = nil, duration: TimeInterval? = nil) -> ToolStep {
        ToolStep(id: UUID(), role: role, toolUseId: useId, summary: summary, startTime: start, duration: duration)
    }
    private func other(_ role: ToolStep.Role) -> ToolStep { ToolStep(id: UUID(), role: role) }

    func testConsecutiveCompletedToolsCollapseIntoOneGroup() {
        let steps = [other(.barrier), tool(), tool(), tool(), other(.barrier)]
        let groups = ToolStepGrouping.groups(steps)
        XCTAssertEqual(groups.count, 1)
        XCTAssertEqual(groups[0].toolCount, 3)
        XCTAssertEqual(groups[0].firstId, steps[1].id)
        XCTAssertEqual(groups[0].memberIds, steps[1...3].map(\.id))
        let entries = ToolStepGrouping.layout(steps, expanded: [])
        XCTAssertEqual(entries, [.step(steps[0].id), .group(groups[0]), .step(steps[4].id)],
                       "collapsed: one row stands for the three capsules")
    }

    func testSingleCompletedToolIsNotGrouped() {
        let steps = [tool(), other(.barrier), tool()]
        XCTAssertTrue(ToolStepGrouping.groups(steps).isEmpty, "one capsule → no summary row")
        XCTAssertEqual(ToolStepGrouping.layout(steps, expanded: []), steps.map { .step($0.id) })
    }

    func testRunningStepStaysVisibleAndSplits() {
        let steps = [tool(), tool(), tool(.liveTool), tool(), tool()]
        let groups = ToolStepGrouping.groups(steps)
        XCTAssertEqual(groups.map(\.toolCount), [2, 2])
        let entries = ToolStepGrouping.layout(steps, expanded: [])
        XCTAssertEqual(entries.count, 3)
        XCTAssertEqual(entries[1], .step(steps[2].id), "the running step is never folded")
    }

    func testFailedAndCancelledStepsStayVisible() {
        let steps = [tool(), tool(), tool(.failedTool), tool(.cancelledTool), tool()]
        let entries = ToolStepGrouping.layout(steps, expanded: [])
        XCTAssertTrue(entries.contains(.step(steps[2].id)), "a failure stays in view")
        XCTAssertTrue(entries.contains(.step(steps[3].id)))
        XCTAssertTrue(entries.contains(.step(steps[4].id)), "the lone tool after them is not grouped")
        XCTAssertEqual(ToolStepGrouping.groups(steps).count, 1)
    }

    func testTextBreaksAGroupThinkingBetweenToolsIsAbsorbed() {
        let lead = other(.transparent)       // thinking before the first tool
        let a = tool(), think = other(.transparent), b = tool(), trail = other(.transparent)
        let text = other(.barrier), c = tool(), d = tool()
        let steps = [lead, a, think, b, trail, text, c, d]
        let groups = ToolStepGrouping.groups(steps)
        XCTAssertEqual(groups.count, 2)
        XCTAssertEqual(groups[0].memberIds, [a.id, think.id, b.id], "thinking between two tools folds with them")
        let entries = ToolStepGrouping.layout(steps, expanded: [])
        XCTAssertEqual(entries.first, .step(lead.id), "thinking at the edge stays visible")
        XCTAssertTrue(entries.contains(.step(trail.id)))
        XCTAssertTrue(entries.contains(.step(text.id)), "written text is never folded")
    }

    func testExpandedGroupShowsRowThenMembersInOrder() {
        let a = tool(useId: "toolu_a"), b = tool(useId: "toolu_b")
        let group = ToolStepGrouping.groups([a, b])[0]
        XCTAssertEqual(group.expansionKey, "toolu_a", "keyed by the saved tool id so it survives a reload")
        let entries = ToolStepGrouping.layout([a, b], expanded: [group.expansionKey])
        XCTAssertEqual(entries, [.group(group), .step(a.id), .step(b.id)])
    }

    func testGroupKeepsItsIdentityWhenTheNextToolCompletes() {
        let a = tool(useId: "x"), b = tool()
        let before = ToolStepGrouping.groups([a, b])[0]
        let after = ToolStepGrouping.groups([a, b, tool()])[0]
        XCTAssertEqual(before.firstId, after.firstId, "the row's list item stays put while it grows")
        XCTAssertEqual(before.expansionKey, after.expansionKey)
        XCTAssertEqual(after.toolCount, 3)
    }

    func testLastInformativeSummary() {
        let steps = [tool(summary: "读取配置"), tool(summary: "运行测试"), tool(summary: "  ")]
        XCTAssertEqual(ToolStepGrouping.groups(steps)[0].lastSummary, "运行测试",
                       "the last step that says something")
        XCTAssertNil(ToolStepGrouping.groups([tool(), tool()])[0].lastSummary)
    }

    func testElapsedUsesWallClockSpanWhenTimedAndSumsOtherwise() {
        let t0 = Date(timeIntervalSince1970: 1000)
        let parallel = [tool(start: t0, duration: 5), tool(start: t0.addingTimeInterval(1), duration: 8)]
        XCTAssertEqual(ToolStepGrouping.groups(parallel)[0].elapsed, 9, accuracy: 0.001,
                       "parallel calls overlap: 0 → 9 s, not 13")
        let reloaded = [tool(duration: 2), tool(duration: 3)]
        XCTAssertEqual(ToolStepGrouping.groups(reloaded)[0].elapsed, 5, accuracy: 0.001,
                       "after a reload only durations exist")
    }
}
