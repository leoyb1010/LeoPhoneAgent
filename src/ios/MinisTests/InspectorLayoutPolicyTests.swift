import XCTest

/// [leo] 右栏「点一下就无限折叠展开」:系统把右栏改成弹出面板时,旧算法把整个对话宽度都当成「被盖住」,
/// 对话塌掉 → 布局翻转 → 右栏关 → 再开。只认贴在对话右侧、等高、不超过一半宽的浮动栏。
final class InspectorLayoutPolicyTests: XCTestCase {
    private let chat = CGRect(x: 300, y: 0, width: 651, height: 669)   // Duo 内屏横向:侧栏 300 + 对话 651

    func testFloatingColumnOverTheChatsTrailingEdgeIsCovered() {
        let column = CGRect(x: 651, y: 0, width: 300, height: 669)
        XCTAssertEqual(LeoWorkspaceLayoutPolicy.coveredTrailing(content: chat, inspector: column), 300)
    }

    func testSheetPresentationIsNotTreatedAsCoveringTheChat() {
        // 弹出面板:从屏幕左边开始、比对话还宽
        let sheet = CGRect(x: 0, y: 40, width: 951, height: 629)
        XCTAssertEqual(LeoWorkspaceLayoutPolicy.coveredTrailing(content: chat, inspector: sheet), 0)
        // 居中的表单式面板:不贴右边
        let card = CGRect(x: 350, y: 80, width: 500, height: 500)
        XCTAssertEqual(LeoWorkspaceLayoutPolicy.coveredTrailing(content: chat, inspector: card), 0)
    }

    func testSqueezedColumnBesideTheChatCoversNothing() {
        let besideChat = CGRect(x: chat.maxX, y: 0, width: 300, height: 669)
        XCTAssertEqual(LeoWorkspaceLayoutPolicy.coveredTrailing(content: chat, inspector: besideChat), 0)
        XCTAssertEqual(LeoWorkspaceLayoutPolicy.coveredTrailing(content: chat, inspector: .zero), 0)
    }

    func testOverlayKeepsAtLeast300PointsOfChat() {
        // 浮动栏让出后对话剩 ≥ 300 才算合法:让出 351 剩 300 照让,让出 400 剩 251 不让
        let ideal = CGRect(x: chat.maxX - 351, y: 0, width: 351, height: 669)
        XCTAssertEqual(LeoWorkspaceLayoutPolicy.coveredTrailing(content: chat, inspector: ideal), 351)
        let tooWide = CGRect(x: chat.maxX - 400, y: 0, width: 400, height: 669)
        XCTAssertEqual(LeoWorkspaceLayoutPolicy.coveredTrailing(content: chat, inspector: tooWide), 0)
    }

    func testTheContainerPicksItsOwnPresentationAndHonorsSystemCloses() throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
        let src = try String(contentsOf: root.appendingPathComponent("Views/Chat/ChatInspector.swift"), encoding: .utf8)
        XCTAssertTrue(src.contains("LeoWorkspaceLayoutPolicy.coveredTrailing(content: contentFrame, inspector: inspectorFrame)"))
        XCTAssertTrue(src.contains(".inspector(isPresented: columnPresented)"))
        XCTAssertTrue(src.contains(".sheet(isPresented: sheetPresented)"))
        XCTAssertTrue(src.contains("!LeoWorkspaceLayoutPolicy.canPinContextColumn(width: windowWidth)"), "< 900 pt 自己用弹出面板")
        XCTAssertFalse(src.contains("isOscillating"), "不再拦截系统的关闭")
        XCTAssertFalse(src.contains("max(0, contentFrame.maxX - inspectorFrame.minX)"), "旧的无条件算法不能回来")
    }

    /// 1.87 真机日志:点开右栏后 [Inspector] width rule 951⇄867 一秒四次。根因是窗口宽度只看了安全区内的宽度。
    func testWindowWidthIncludesSafeAreaAndWidthRuleIsDebouncedAndYieldsToTheUser() throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
        let content = try String(contentsOf: root.appendingPathComponent("Views/ContentView.swift"), encoding: .utf8)
        XCTAssertTrue(content.contains(".onChange(of: geo.size.width + geo.safeAreaInsets.leading + geo.safeAreaInsets.trailing)"))
        XCTAssertFalse(content.contains(".onChange(of: geo.size.width) { _, width in updateWindowWidth(width) }"))
        let src = try String(contentsOf: root.appendingPathComponent("Views/Chat/ChatInspector.swift"), encoding: .utf8)
        XCTAssertTrue(src.contains(".onChange(of: windowWidth) { _, width in scheduleWidthRule(width) }"), "宽度稳定后才套规则")
        XCTAssertTrue(src.contains("Date().timeIntervalSince(lastHandToggle) < LeoWorkspaceLayoutPolicy.handToggleGrace"),
                      "不推翻用户刚刚的手动开关")
        XCTAssertEqual(LeoWorkspaceLayoutPolicy.handToggleGrace, 1.5)
    }
}
