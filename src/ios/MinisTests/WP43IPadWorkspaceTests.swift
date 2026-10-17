import XCTest

/// WP-43:iPad 三栏宽度规则、右栏模式、⌘K 命令面板的固定命令。
final class WP43IPadWorkspaceTests: XCTestCase {
    typealias L = LeoWorkspaceLayoutPolicy

    func testWidthRulesAtStageManagerSizes() {
        // iPad Pro 13 横屏 1366 / 竖屏 1024 / Stage Manager 窄窗 768。
        XCTAssertTrue(L.sidebarResident(width: 1366)); XCTAssertTrue(L.showsContextColumn(width: 1366))
        XCTAssertTrue(L.sidebarResident(width: 1024)); XCTAssertFalse(L.showsContextColumn(width: 1024))
        XCTAssertFalse(L.sidebarResident(width: 768)); XCTAssertFalse(L.showsContextColumn(width: 768))
        XCTAssertTrue(L.sidebarResident(width: 800)); XCTAssertTrue(L.showsContextColumn(width: 1100))
        XCTAssertFalse(L.sidebarResident(width: .nan))
        // 三栏在 1100 时不重叠:侧栏上限 + 内容上限 ≤ 窗宽,剩下的给第三栏(检查器最小 300)。
        XCTAssertLessThanOrEqual(L.sidebarWidth.max + 500 + 300, 1366)
        XCTAssertEqual(L.sidebarWidth.ideal, 300); XCTAssertEqual(L.sidebarWidth.max, 320)
        XCTAssertEqual(L.contentMaxWidth, 760)
    }

    func testRulesOnlyFireOnThresholdCrossing() {
        let rule = L.showsContextColumn
        XCTAssertEqual(L.crossing(from: 0, to: 1366, rule: rule), true, "first measurement applies the rule")
        XCTAssertNil(L.crossing(from: 1366, to: 1200, rule: rule), "same side: keep the user's choice")
        XCTAssertEqual(L.crossing(from: 1200, to: 1024, rule: rule), false)
        XCTAssertEqual(L.crossing(from: 1024, to: 1366, rule: rule), true)
        XCTAssertEqual(L.crossing(from: 1024, to: 768, rule: L.sidebarResident), false)
    }

    func testContextColumnModeIsGatedByMacFleet() {
        XCTAssertEqual(ChatContextColumnPolicy.resolve(nil), .details)
        XCTAssertEqual(ChatContextColumnPolicy.resolve("bogus"), .details)
        XCTAssertEqual(ChatContextColumnPolicy.effective("macScreen", macFleetEnabled: true), .macScreen)
        XCTAssertEqual(ChatContextColumnPolicy.effective("macScreen", macFleetEnabled: false), .details)
        XCTAssertEqual(ChatContextColumnPolicy.Mode.details.title, "文件/工具详情")
        XCTAssertEqual(ChatContextColumnPolicy.Mode.macScreen.title, "Mac 画面")
    }

    func testPaletteOffersAtLeastTwelveCommandsWithUrgentFirst() {
        let full = CommandPaletteCatalog.commands(.init(hasChat: true, isProcessing: true, hasApproval: true,
                                                        macFleetEnabled: true, splitLayout: true))
        XCTAssertGreaterThanOrEqual(full.count, 12)
        XCTAssertEqual(Set(full).count, full.count)
        XCTAssertEqual(Array(full.prefix(3)), [.approve, .deny, .stopRun])
        for needed in [PaletteCommand.switchModel, .macScreen, .approve, .deny, .stopRun] {
            XCTAssertTrue(full.contains(needed), "\(needed)")
        }
        let home = CommandPaletteCatalog.commands(.init())
        XCTAssertFalse(home.contains(.stopRun)); XCTAssertFalse(home.contains(.approve))
        XCTAssertFalse(home.contains(.macScreen)); XCTAssertFalse(home.contains(.macConsole))
        XCTAssertTrue(home.contains(.newTask))
        let iphone = CommandPaletteCatalog.commands(.init(hasChat: true, macFleetEnabled: true, splitLayout: false))
        XCTAssertFalse(iphone.contains(.contextDetails), "no third column on a narrow layout")
    }

    func testShortcutsMatchTheMenuBar() throws {
        XCTAssertEqual(PaletteCommand.macScreen.shortcut, "⇧⌘M")
        XCTAssertEqual(PaletteCommand.contextDetails.shortcut, "⌥⌘I")
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
        let commands = try String(contentsOf: root.appendingPathComponent("Views/LeoCommands.swift"), encoding: .utf8)
        XCTAssertTrue(commands.contains(#".keyboardShortcut("m", modifiers: [.command, .shift])"#))
        XCTAssertTrue(commands.contains(#".keyboardShortcut(".", modifiers: [.command, .shift])"#))
        XCTAssertTrue(commands.contains(".keyboardShortcut(.return, modifiers: .command)"))
        XCTAssertTrue(commands.contains(".labelStyle(.titleAndIcon)"))
        let widget = try String(contentsOf: root.appendingPathComponent("AgentWidget/AgentLiveActivityWidget.swift"), encoding: .utf8)
        XCTAssertTrue(widget.contains(".systemExtraLargePortrait"))
    }
}
