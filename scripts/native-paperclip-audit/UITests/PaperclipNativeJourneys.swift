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
        XCTAssertTrue(app.buttons["paperclip.create"].exists)
        XCTAssertFalse(app.buttons["paperclip.create"].isEnabled)
        XCTAssertEqual(app.searchFields.count, 0)
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

extension PaperclipNativeJourneys {
    @MainActor
    func testProductionTaskListReplyStatusAndApprovalWithFixtureAPI() {
        let app = XCUIApplication()
        app.launchArguments = ["--reset-paperclip-fixture", "--server-task-fixture", "-AppleLanguages", "(zh-Hans)", "-AppleLocale", "zh_CN"]
        app.launch()
        let task = app.descendants(matching: .any).matching(identifier: "paperclip.issue.issue-1").firstMatch
        XCTAssertTrue(task.waitForExistence(timeout: 20))
        XCTAssertTrue(task.isHittable, "连接后任务应直接可见，不应被配置表单挤到屏幕下方")
        XCTAssertFalse(app.buttons["paperclip.login"].exists)
        XCTAssertTrue(app.buttons["paperclip.serverSettings"].exists)
        screenshot("真实生产任务列表_模拟接口", app)
        app.buttons["paperclip.create"].tap()
        let title = app.textFields["paperclip.taskTitle"]
        XCTAssertTrue(title.waitForExistence(timeout: 5))
        title.tap(); title.typeText("创建中文任务")
        let create = app.buttons["paperclip.submitTask"]
        scrollTo(create, app)
        create.tap()
        XCTAssertTrue(app.navigationBars["Paperclip 工作区"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["创建中文任务"].waitForExistence(timeout: 10))
        screenshot("真实生产创建回执_模拟接口", app)
        scrollTo(task, app)
        task.tap()
        XCTAssertTrue(app.navigationBars["服务器任务详情"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["状态：进行中"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["修复登录流程"].isHittable)
        XCTAssertFalse(app.staticTexts["用户编号：human"].exists, "技术归属应默认收起，并保留展开入口")
        XCTAssertTrue(app.buttons["paperclip.attribution"].exists)
        screenshot("真实生产任务详情_模拟接口", app)
        app.buttons["paperclip.changeStatus"].tap()
        let done = app.buttons["paperclip.status.done"]
        XCTAssertTrue(done.waitForExistence(timeout: 5))
        done.tap()
        screenshot("真实生产状态确认_模拟接口", app)
        let confirmStatus = app.buttons["paperclip.confirmStatus"]
        scrollTo(confirmStatus, app)
        confirmStatus.tap()
        XCTAssertTrue(app.staticTexts["状态：已完成"].waitForExistence(timeout: 10))
        let reply = app.descendants(matching: .any).matching(identifier: "paperclip.replyBody").firstMatch
        scrollTo(reply, app)
        reply.tap(); reply.typeText("请补充验证结果")
        let send = app.buttons["paperclip.sendReply"]
        scrollTo(send, app)
        send.tap()
        XCTAssertTrue(app.staticTexts["请补充验证结果"].waitForExistence(timeout: 10))
        screenshot("真实生产回复回执_模拟接口", app)
        let approval = app.buttons["聘用智能体 · 待审批"]
        scrollTo(approval, app)
        approval.tap()
        let approve = app.buttons["paperclip.approve.approval-1"]
        scrollTo(approve, app)
        approve.tap()
        app.alerts.buttons["确认"].tap()
        XCTAssertTrue(app.buttons["聘用智能体 · 已批准"].waitForExistence(timeout: 10))
        screenshot("真实生产审批回执_模拟接口", app)
    }
    @MainActor
    private func scrollTo(_ target: XCUIElement, _ app: XCUIApplication) {
        for _ in 0..<10 {
            if target.exists && target.isHittable { return }
            app.swipeUp()
        }
        XCTAssertTrue(target.exists && target.isHittable)
    }
}
