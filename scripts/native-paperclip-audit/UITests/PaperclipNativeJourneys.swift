import XCTest

final class PaperclipNativeJourneys: XCTestCase {
    @MainActor
    func testChineseBackendSwitchPreservesLocalWorkspaceAndRejectsHTTP() {
        let app = XCUIApplication()
        app.launchArguments = ["--reset-paperclip-fixture", "-AppleLanguages", "(zh-Hans)", "-AppleLocale", "zh_CN"]
        app.launch()
        XCTAssertTrue(app.staticTexts["fixture.localSessions"].waitForExistence(timeout: 10))
        let draft = app.textFields["fixture.localDraft"]
        draft.tap(); draft.typeText("local-draft-retained-140")
        app.buttons["paperclip.openWorkspace"].tap()
        XCTAssertTrue(app.navigationBars["服务器任务"].waitForExistence(timeout: 10))
        XCTAssertFalse(app.buttons["paperclip.create"].isEnabled)
        screenshot("中文服务器空状态", app)
        app.buttons["paperclip.settings"].tap()
        XCTAssertTrue(app.navigationBars["服务器设置"].waitForExistence(timeout: 5))
        app.buttons["paperclip.addProfile"].tap()
        XCTAssertTrue(app.navigationBars["添加服务器"].waitForExistence(timeout: 5))
        let address = app.textFields["paperclip.serverURL"]
        address.tap(); address.typeText("http://example.com")
        app.buttons["保存"].tap()
        XCTAssertTrue(app.staticTexts["请输入独立服务器的 HTTPS 根地址，不包含账号、密码、路径、查询参数或片段。"].waitForExistence(timeout: 5))
        screenshot("拒绝不安全服务器地址", app)
        app.buttons["取消"].tap()
        XCTAssertTrue(app.navigationBars["服务器设置"].waitForExistence(timeout: 5))
        app.buttons["完成"].tap()
        XCTAssertTrue(app.navigationBars["服务器任务"].waitForExistence(timeout: 5))
        app.buttons["paperclip.returnLocal"].tap()
        XCTAssertTrue(app.staticTexts["fixture.localSessions"].waitForExistence(timeout: 5))
        XCTAssertEqual(app.textFields["fixture.localDraft"].value as? String, "local-draft-retained-140")
        screenshot("返回本机工作区", app)
        app.buttons["paperclip.openWorkspace"].tap()
        app.buttons["paperclip.settings"].tap()
        XCTAssertTrue(app.navigationBars["服务器设置"].waitForExistence(timeout: 5))
        app.buttons["paperclip.addProfile"].tap()
        app.buttons["取消"].tap()
        XCTAssertTrue(app.navigationBars["服务器设置"].waitForExistence(timeout: 5))
        app.buttons["完成"].tap()
        XCTAssertTrue(app.navigationBars["服务器任务"].waitForExistence(timeout: 5))
    }
    @MainActor
    private func screenshot(_ name: String, _ app: XCUIApplication) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
