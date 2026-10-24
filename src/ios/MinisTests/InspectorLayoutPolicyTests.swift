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

    func testCoveringMoreThanHalfTheChatIsIgnored() {
        let wide = CGRect(x: 400, y: 0, width: 551, height: 669)   // 盖住 551 > 651/2
        XCTAssertEqual(LeoWorkspaceLayoutPolicy.coveredTrailing(content: chat, inspector: wide), 0)
    }

    func testOscillationIsDetectedOnlyForRapidRepeatedSystemToggles() {
        let now = Date()
        let rapid = (0..<4).map { now.addingTimeInterval(-Double($0) * 0.2) }
        XCTAssertTrue(LeoWorkspaceLayoutPolicy.isOscillating(recentAutoToggles: rapid, now: now))
        XCTAssertFalse(LeoWorkspaceLayoutPolicy.isOscillating(recentAutoToggles: Array(rapid.prefix(3)), now: now))
        let spread = (0..<4).map { now.addingTimeInterval(-Double($0) * 1.0) }
        XCTAssertFalse(LeoWorkspaceLayoutPolicy.isOscillating(recentAutoToggles: spread, now: now))
    }

    func testTheContainerUsesThePolicyAndTheGuardedBinding() throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
        let src = try String(contentsOf: root.appendingPathComponent("Views/Chat/ChatInspector.swift"), encoding: .utf8)
        XCTAssertTrue(src.contains("LeoWorkspaceLayoutPolicy.coveredTrailing(content: contentFrame, inspector: inspectorFrame)"))
        XCTAssertTrue(src.contains(".inspector(isPresented: inspectorBinding)"))
        XCTAssertFalse(src.contains("max(0, contentFrame.maxX - inspectorFrame.minX)"), "旧的无条件算法不能回来")
    }
}
