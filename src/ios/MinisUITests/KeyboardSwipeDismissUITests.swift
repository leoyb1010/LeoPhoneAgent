import XCTest

/// [T-keyboard-swipe] 真机:键盘弹着时,在输入框上方下滑应收起键盘;在新对话空白处
/// (那里铺着一层只接点按的透明层,聊天列表的 .onDrag 收不到拖动)也一样。
/// 驱动已安装的 Release 版(按 bundle id),不覆盖安装。
final class KeyboardSwipeDismissUITests: XCTestCase {
    override class func setUp() {
        super.setUp()
        UITestRecordingPolicy.apply()
    }

    private func settle(_ seconds: Double = 0.8) {
        RunLoop.current.run(until: Date().addingTimeInterval(seconds))
    }

    func testSwipeDownAboveInputDismissesKeyboard() throws {
        let app = XCUIApplication(bundleIdentifier: "com.leoyuan.leophoneagent")
        app.launch()
        settle(2.5)
        for label in ["知道了", "好的", "开始使用", "继续", "完成"] where app.buttons[label].waitForExistence(timeout: 1.2) {
            app.buttons[label].tap()
            break
        }
        // [G2] 没配模型的新装机,看完「本次更新」会出新手引导。
        if app.buttons["onboarding.skip"].waitForExistence(timeout: 2) { app.buttons["onboarding.skip"].tap() }
        settle(1.0)
        // 新对话
        let newChat = app.buttons["新对话"]
        if newChat.waitForExistence(timeout: 2) { newChat.tap(); settle(1.2) }

        // SwiftUI 的多行输入框在不同的 Duo 环境可被系统报告为 TextField 或 TextView。
        let homeField = app.descendants(matching: .any)["home.prompt"].firstMatch
        let field = homeField.exists ? homeField
            : (app.textViews.firstMatch.exists ? app.textViews.firstMatch : app.textFields.firstMatch)
        guard field.waitForExistence(timeout: 5), field.isHittable else {
            XCTFail("找不到可用的输入框")
            return
        }
        field.tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 3), "点输入框后键盘没出来")
        settle(0.6)

        // 输入框上方空白处往下滑
        let window = app.windows.firstMatch
        let x = min(0.86, max(0.14, (field.frame.midX - window.frame.minX) / window.frame.width))
        let start = window.coordinate(withNormalizedOffset: CGVector(dx: x, dy: 0.22))
        let end = window.coordinate(withNormalizedOffset: CGVector(dx: x, dy: 0.45))
        start.press(forDuration: 0.05, thenDragTo: end)
        settle(1.0)
        XCTAssertFalse(app.keyboards.firstMatch.exists, "下滑后键盘还在")
    }
}
