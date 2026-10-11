import Foundation
import XCTest

/// 服务器任务界面的纯展示规则：状态外观、分组排序、相对时间、朗读文本、插入动效门槛。
final class PaperclipPresentationTests: XCTestCase {
    private func issue(_ id: String, status: String, priority: String = "medium", updatedAt: String? = nil,
                       identifier: String? = nil, title: String = "任务") throws -> PaperclipIssue {
        var fields = [#""id":"\#(id)""#, #""companyId":"co""#, #""title":"\#(title)""#, #""status":"\#(status)""#, #""priority":"\#(priority)""#]
        if let updatedAt { fields.append(#""updatedAt":"\#(updatedAt)""#) }
        if let identifier { fields.append(#""identifier":"\#(identifier)""#) }
        return try JSONDecoder().decode(PaperclipIssue.self, from: Data(("{" + fields.joined(separator: ",") + "}").utf8))
    }

    // MARK: 状态 → 外观

    func testEveryStatusHasDistinctShapeWithinItsKind() {
        // 色弱用户靠形状区分：同类状态（工单 / 运行）符号互不相同，且都不是未知占位。
        for statuses in [PaperclipStatusLook.issueStatuses, PaperclipStatusLook.runStatuses] {
            let symbols = statuses.map(PaperclipStatusLook.symbol)
            XCTAssertEqual(Set(symbols).count, statuses.count, "\(statuses)")
            XCTAssertFalse(symbols.contains("questionmark.circle"))
        }
        XCTAssertEqual(PaperclipStatusLook.symbol("something_new"), "questionmark.circle")
    }

    func testStatusToneMapping() {
        XCTAssertEqual(PaperclipStatusLook.tone("in_progress"), .accent)
        XCTAssertEqual(PaperclipStatusLook.tone("running"), .accent)
        XCTAssertEqual(PaperclipStatusLook.tone("in_review"), .review)
        XCTAssertEqual(PaperclipStatusLook.tone("blocked"), .attention)
        XCTAssertEqual(PaperclipStatusLook.tone("done"), .success)
        XCTAssertEqual(PaperclipStatusLook.tone("succeeded"), .success)
        XCTAssertEqual(PaperclipStatusLook.tone("failed"), .failure)
        XCTAssertEqual(PaperclipStatusLook.tone("timed_out"), .failure)
        XCTAssertEqual(PaperclipStatusLook.tone("cancelled"), .muted)
        XCTAssertEqual(PaperclipStatusLook.tone("backlog"), .neutral)
        XCTAssertEqual(PaperclipStatusLook.tone("unknown"), .neutral)
        // 每个工单状态都有中文名（不会显示「未知状态」）。
        for status in PaperclipStatusLook.issueStatuses + PaperclipStatusLook.runStatuses {
            XCTAssertNotEqual(PaperclipLabels.status(status), "未知状态", status)
        }
    }

    func testPriorityShapesAndRanks() {
        let known = ["critical", "high", "medium", "low"]
        XCTAssertEqual(known.map(PaperclipPriorityLook.rank), [3, 2, 1, 0])
        XCTAssertEqual(Set(known.compactMap(PaperclipPriorityLook.symbol)).count, 4)
        XCTAssertNil(PaperclipPriorityLook.symbol("none"))
        XCTAssertEqual(PaperclipPriorityLook.rank("none"), -1)
        XCTAssertEqual(PaperclipPriorityLook.tone("critical"), .failure)
        XCTAssertEqual(PaperclipPriorityLook.tone("high"), .attention)
        XCTAssertEqual(PaperclipPriorityLook.tone("low"), .muted)
    }

    // MARK: 分组与排序

    func testGroupingPutsAttentionFirstAndRunningIntoActive() throws {
        XCTAssertEqual(PaperclipIssueGroup.group(try issue("a", status: "blocked"), running: false), .attention)
        XCTAssertEqual(PaperclipIssueGroup.group(try issue("a", status: "in_review"), running: false), .attention)
        XCTAssertEqual(PaperclipIssueGroup.group(try issue("a", status: "in_progress"), running: false), .active)
        XCTAssertEqual(PaperclipIssueGroup.group(try issue("a", status: "todo"), running: false), .pending)
        XCTAssertEqual(PaperclipIssueGroup.group(try issue("a", status: "backlog"), running: false), .pending)
        XCTAssertEqual(PaperclipIssueGroup.group(try issue("a", status: "done"), running: false), .finished)
        XCTAssertEqual(PaperclipIssueGroup.group(try issue("a", status: "cancelled"), running: false), .finished)
        // 有运行中的 run 一律进「进行中」，即使状态是待处理或受阻。
        XCTAssertEqual(PaperclipIssueGroup.group(try issue("a", status: "todo"), running: true), .active)
        XCTAssertEqual(PaperclipIssueGroup.group(try issue("a", status: "blocked"), running: true), .active)
    }

    func testSectionsOrderGroupsSortRunningFirstThenNewestAndStayStable() throws {
        let issues = [
            try issue("done1", status: "done", updatedAt: "2026-10-10T08:00:00Z"),
            try issue("todo-old", status: "todo", updatedAt: "2026-10-01T08:00:00Z"),
            try issue("todo-new", status: "todo", updatedAt: "2026-10-09T08:00:00Z"),
            try issue("todo-nodate-1", status: "todo"),
            try issue("todo-nodate-2", status: "todo"),
            try issue("blocked", status: "blocked", updatedAt: "2026-10-02T08:00:00Z"),
            try issue("ip-new", status: "in_progress", updatedAt: "2026-10-10T09:00:00Z"),
            try issue("ip-running-old", status: "in_progress", updatedAt: "2026-09-01T09:00:00Z"),
        ]
        let sections = PaperclipIssueGroup.sections(issues, running: ["ip-running-old"])
        XCTAssertEqual(sections.map(\.group), [.attention, .active, .pending, .finished])
        XCTAssertEqual(sections[1].issues.map(\.id), ["ip-running-old", "ip-new"], "运行中的排在最前")
        XCTAssertEqual(sections[2].issues.map(\.id), ["todo-new", "todo-old", "todo-nodate-1", "todo-nodate-2"],
                       "新→旧；缺时间的保持服务器顺序")
        // 空组省略；同样的输入再算一次结果完全一致（轮询不让行跳动）。
        XCTAssertEqual(PaperclipIssueGroup.sections([try issue("x", status: "todo")], running: []).map(\.group), [.pending])
        XCTAssertEqual(PaperclipIssueGroup.sections(issues, running: ["ip-running-old"]), sections)
        XCTAssertTrue(PaperclipIssueGroup.sections([], running: []).isEmpty)
    }

    // MARK: 相对时间

    private var calendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "Asia/Shanghai")!
        return calendar
    }

    private func date(_ value: String) -> Date { PaperclipDates.parse(value)! }

    func testCompactRelativeTime() {
        let now = date("2026-10-11T12:00:00+08:00")
        func compact(_ value: String) -> String { PaperclipRelativeTime.compact(date(value), now: now, calendar: calendar) }
        XCTAssertEqual(compact("2026-10-11T11:59:30+08:00"), "刚刚")
        XCTAssertEqual(compact("2026-10-11T12:05:00+08:00"), "刚刚", "服务器时钟略快也不显示负数")
        XCTAssertEqual(compact("2026-10-11T11:55:00+08:00"), "5 分钟前")
        XCTAssertEqual(compact("2026-10-11T09:00:00+08:00"), "3 小时前")
        XCTAssertEqual(compact("2026-10-11T05:30:00+08:00"),
                       PaperclipRelativeTime.clock(date("2026-10-11T05:30:00+08:00"), calendar: calendar), "6 小时以上的今天显示时刻")
        XCTAssertEqual(compact("2026-10-10T23:00:00+08:00"), "昨天")
        XCTAssertEqual(compact("2026-10-08T10:00:00+08:00"), "3 天前")
        XCTAssertEqual(compact("2026-09-20T10:00:00+08:00"), "9月20日")
        XCTAssertEqual(compact("2025-12-31T10:00:00+08:00"), "2025年12月31日")
    }

    func testDetailRelativeTimeKeepsClockForYesterday() {
        let now = date("2026-10-11T12:00:00+08:00")
        let yesterday = date("2026-10-10T08:30:00+08:00")
        XCTAssertEqual(PaperclipRelativeTime.detail(yesterday, now: now, calendar: calendar),
                       "昨天 " + PaperclipRelativeTime.clock(yesterday, calendar: calendar))
        XCTAssertEqual(PaperclipRelativeTime.detail(date("2026-10-11T11:30:00+08:00"), now: now, calendar: calendar), "30 分钟前")
        XCTAssertEqual(PaperclipRelativeTime.detail(date("2026-10-01T08:30:00+08:00"), now: now, calendar: calendar), "10月1日")
    }

    // MARK: 朗读

    func testRowAccessibilityLabelReadsWholeRowOnce() throws {
        let row = try issue("1", status: "in_progress", priority: "high", identifier: "LEO-123", title: "修复登录")
        XCTAssertEqual(PaperclipIssueRowText.accessibilityLabel(issue: row, assigneeName: "小助手", running: true, time: "5 分钟前"),
                       "LEO-123，修复登录，状态：进行中，智能体正在运行，负责人：小助手，优先级：高，更新于5 分钟前")
        let bare = try issue("2", status: "todo", priority: "none", title: "整理文档")
        XCTAssertEqual(PaperclipIssueRowText.accessibilityLabel(issue: bare, assigneeName: nil, running: false, time: nil),
                       "整理文档，状态：待处理，未分配")
    }

    // MARK: 插入动效门槛

    func testInsertAnimationOnlyForSmallAppendsAndNeverWithReduceMotion() {
        XCTAssertTrue(PaperclipInsertMotion.animates(old: ["a", "b"], new: ["a", "b", "c"], reduceMotion: false))
        XCTAssertTrue(PaperclipInsertMotion.animates(old: ["a"], new: ["a", "b", "c", "d"], reduceMotion: false))
        XCTAssertFalse(PaperclipInsertMotion.animates(old: ["a", "b"], new: ["a", "b", "c"], reduceMotion: true), "Reduce Motion")
        XCTAssertFalse(PaperclipInsertMotion.animates(old: [], new: ["a", "b"], reduceMotion: false), "首次加载")
        XCTAssertFalse(PaperclipInsertMotion.animates(old: ["a"], new: ["a", "b", "c", "d", "e"], reduceMotion: false), "批量补拉")
        XCTAssertFalse(PaperclipInsertMotion.animates(old: ["a", "b"], new: ["b", "a", "c"], reduceMotion: false), "全量替换改了顺序")
        XCTAssertFalse(PaperclipInsertMotion.animates(old: ["a", "b"], new: ["a", "b"], reduceMotion: false), "没有新条目")
        XCTAssertFalse(PaperclipInsertMotion.animates(old: ["a", "b"], new: ["a"], reduceMotion: false), "删除")
    }
}
