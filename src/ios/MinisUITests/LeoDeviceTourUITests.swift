import XCTest

/// [T-device-tour] 真机巡检:按 bundle id 驱动**已安装的 Release 版**(xctestrun 里去掉了
/// 被测 App 的安装项,所以不会用 Debug 包覆盖它),每一步截图作为附件,供设计评审和
/// 能力验收。取图:`xcrun xcresulttool export attachments --path <xcresult> --output-path <dir>`。
final class LeoDeviceTourUITests: XCTestCase {
    private let bundleId = "com.leoyuan.leophoneagent"

    override func setUp() {
        continueAfterFailure = true
    }

    private func installedApp() -> XCUIApplication {
        XCUIApplication(bundleIdentifier: bundleId)
    }

    private func shot(_ name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    /// 升级后首启会弹「本次更新」。
    private func dismissWhatsNew(_ app: XCUIApplication) {
        for label in ["知道了", "好的", "开始使用", "继续", "完成", "OK", "Done"] {
            let button = app.buttons[label]
            if button.waitForExistence(timeout: 1.2) {
                button.tap()
                return
            }
        }
    }

    private func settle(_ seconds: Double = 0.8) {
        RunLoop.current.run(until: Date().addingTimeInterval(seconds))
    }

    func testTourHome() {
        let app = installedApp()
        app.launch()
        settle(2.5)
        shot("01-launch")
        dismissWhatsNew(app)
        settle(1.2)
        shot("02-home")

        let capsule = app.buttons.matching(NSPredicate(format: "label BEGINSWITH '执行位置和模型'")).firstMatch
        if capsule.waitForExistence(timeout: 3) {
            capsule.tap()
            settle(1.0)
            shot("03-capsule-menu")
            app.tap()  // 点空白处收起菜单
            settle(0.6)
        }

        let slash = app.buttons["动作、技能和 MCP"]
        if slash.waitForExistence(timeout: 3) {
            slash.tap()
            settle(1.2)
            shot("04-slash-sheet")
            let done = app.buttons["完成"]
            if done.waitForExistence(timeout: 2) { done.tap() } else { app.swipeDown() }
            settle(0.8)
        }

        let field = app.textFields["问 Leo,或直接说要做的事"].exists
            ? app.textFields["问 Leo,或直接说要做的事"]
            : app.textViews.firstMatch
        if field.waitForExistence(timeout: 3) {
            field.tap()
            settle(0.6)
            field.typeText("打开手电筒")
            settle(0.8)
            shot("05-typing")
            // 清掉,别真的发出去
            if let value = field.value as? String, !value.isEmpty {
                field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: value.count + 2))
            }
            app.swipeDown()
            settle(0.6)
        }

        let search = app.buttons["搜索对话"]
        if search.waitForExistence(timeout: 3) {
            search.tap()
            settle(1.0)
            shot("06-search")
            let cancel = app.buttons["取消"]
            if cancel.waitForExistence(timeout: 2) { cancel.tap() }
            settle(0.8)
        }

        // 打开第一条会话
        let firstCell = app.cells.element(boundBy: 0)
        if firstCell.waitForExistence(timeout: 3) {
            firstCell.tap()
            settle(2.0)
            shot("07-chat")
            app.navigationBars.buttons.element(boundBy: 0).tap()
            settle(1.0)
        }
        shot("08-home-again")
    }

    func testSelfTest() {
        let app = installedApp()
        app.launch()
        settle(2.0)
        dismissWhatsNew(app)
        settle(0.8)
        // 深链直接打开能力自检并自动开跑
        app.open(URL(string: "leophoneagent://settings/selftest")!)
        settle(2.0)
        shot("20-selftest-start")
        // 最多等 90 秒跑完
        let deadline = Date().addingTimeInterval(90)
        while Date() < deadline {
            if app.buttons["再测一次"].exists { break }
            settle(2.0)
        }
        shot("21-selftest-done")
        app.swipeUp()
        settle(0.8)
        shot("22-selftest-scrolled")
        app.swipeUp()
        settle(0.8)
        shot("23-selftest-bottom")
    }
}
