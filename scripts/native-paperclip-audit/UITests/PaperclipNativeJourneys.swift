import XCTest

final class PaperclipNativeJourneys: XCTestCase {
    @MainActor
    func testChineseBackendSwitchPreservesLocalWorkspaceAndRejectsHTTP() {
        let app = XCUIApplication()
        app.launchArguments = ["--reset-paperclip-fixture", "-AppleLanguages", "(zh-Hans)", "-AppleLocale", "zh_CN"]
        app.launch()
        XCTAssertTrue(app.staticTexts["fixture.localSessions"].waitForExistence(timeout: 10))
        app.segmentedControls["paperclip.backend"].buttons["Paperclip 服务器"].tap()
        XCTAssertTrue(app.navigationBars["Paperclip 工作区"].waitForExistence(timeout: 10))
        XCTAssertFalse(app.buttons["paperclip.create"].isEnabled)
        screenshot("中文服务器空状态", app)
        app.buttons["paperclip.addProfile"].tap()
        XCTAssertTrue(app.navigationBars["添加服务器"].waitForExistence(timeout: 5))
        let address = app.textFields["paperclip.serverURL"]
        address.tap(); address.typeText("http://example.com")
        app.buttons["保存"].tap()
        XCTAssertTrue(app.staticTexts["请输入独立服务器的 HTTPS 根地址，不包含账号、密码、路径、查询参数或片段。"].waitForExistence(timeout: 5))
        screenshot("拒绝不安全服务器地址", app)
        app.buttons["取消"].tap()
        XCTAssertTrue(app.navigationBars["Paperclip 工作区"].waitForExistence(timeout: 5))
        app.segmentedControls["paperclip.backend"].buttons["本机"].tap()
        XCTAssertTrue(app.staticTexts["fixture.localSessions"].waitForExistence(timeout: 5))
        screenshot("返回本机工作区", app)
        app.segmentedControls["paperclip.backend"].buttons["Paperclip 服务器"].tap()
        app.buttons["paperclip.addProfile"].tap()
        app.buttons["取消"].tap()
        XCTAssertTrue(app.navigationBars["Paperclip 工作区"].waitForExistence(timeout: 5))
    }
    @MainActor
    private func screenshot(_ name: String, _ app: XCUIApplication) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
