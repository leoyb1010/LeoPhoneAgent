import XCTest

final class PaperclipNativeJourneys: XCTestCase {
    override func setUpWithError() throws { continueAfterFailure = false }

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
    func testProductionTaskListCreateAndDetailWithFixtureAPI() {
        let app = launchTaskFixture()
        let task = taskLink(app)
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
        openDetail(app)
        XCTAssertTrue(app.staticTexts["修复登录流程"].isHittable)
        XCTAssertFalse(app.staticTexts["用户编号：human"].exists, "技术归属应默认收起，并保留展开入口")
        XCTAssertTrue(app.descendants(matching: .any).matching(identifier: "paperclip.attribution").firstMatch.exists)
        screenshot("真实生产任务详情_模拟接口", app)
    }

    @MainActor
    func testProductionStatusChangeWithFixtureAPI() {
        let app = launchTaskFixture()
        openDetail(app)
        app.buttons["paperclip.changeStatus"].tap()
        let done = app.buttons["paperclip.status.done"]
        XCTAssertTrue(done.waitForExistence(timeout: 5))
        done.tap()
        screenshot("真实生产状态确认_模拟接口", app)
        let confirm = app.buttons["paperclip.confirmStatus"]
        scrollTo(confirm, app)
        confirm.tap()
        XCTAssertTrue(app.staticTexts["状态：已完成"].waitForExistence(timeout: 10))
        screenshot("真实生产状态回执_模拟接口", app)
    }

    @MainActor
    func testProductionReplyWithFixtureAPI() {
        let app = launchTaskFixture()
        openDetail(app)
        let reply = app.descendants(matching: .any).matching(identifier: "paperclip.replyBody").firstMatch
        scrollTo(reply, app)
        reply.tap(); reply.typeText("请补充验证结果")
        let send = app.buttons["paperclip.sendReply"]
        scrollTo(send, app)
        send.tap()
        let receipt = app.staticTexts["请补充验证结果"]
        XCTAssertTrue(receipt.waitForExistence(timeout: 10))
        scrollTo(receipt, app)
        XCTAssertTrue(app.staticTexts["用户回复"].exists)
        screenshot("真实生产回复回执_模拟接口", app)
    }

    @MainActor
    func testProductionApprovalWithFixtureAPI() {
        let app = launchTaskFixture()
        openDetail(app)
        let approval = app.descendants(matching: .any).matching(identifier: "paperclip.approval.approval-1").firstMatch
        scrollTo(approval, app)
        approval.tap()
        let approve = app.buttons["paperclip.approve.approval-1"]
        scrollTo(approve, app)
        screenshot("真实生产审批内容_模拟接口", app)
        approve.tap()
        XCTAssertTrue(app.alerts.buttons["确认"].waitForExistence(timeout: 5))
        app.alerts.buttons["确认"].tap()
        let receipt = app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "聘用智能体 · 已批准")).firstMatch
        XCTAssertTrue(receipt.waitForExistence(timeout: 10))
        screenshot("真实生产审批回执_模拟接口", app)
    }

    @MainActor
    func testBlockedStatusRequiresExplicitUnblockAction() {
        let app = launchTaskFixture()
        openDetail(app)
        app.buttons["paperclip.changeStatus"].tap()
        let blocked = app.buttons["paperclip.status.blocked"]
        XCTAssertTrue(blocked.waitForExistence(timeout: 5))
        blocked.tap()
        let action = app.descendants(matching: .any).matching(identifier: "paperclip.unblockAction").firstMatch
        scrollTo(action, app)
        let confirm = app.buttons["paperclip.confirmStatus"]
        XCTAssertTrue(confirm.exists)
        XCTAssertFalse(confirm.isEnabled, "不能在用户未说明解除阻塞条件时提交")
        action.tap(); action.typeText("请确认访问范围")
        scrollTo(confirm, app)
        XCTAssertTrue(confirm.isEnabled)
        screenshot("真实生产受阻说明确认_模拟接口", app)
        confirm.tap()
        XCTAssertTrue(app.staticTexts["状态：受阻"].waitForExistence(timeout: 10))
        screenshot("真实生产受阻状态回执_模拟接口", app)
    }

    @MainActor
    func testUnknownStatusReceiptOnlyAllowsReadOnlyVerification() {
        let app = launchTaskFixture(extraArguments: ["--status-receipt-unknown-fixture"])
        openDetail(app)
        app.buttons["paperclip.changeStatus"].tap()
        let done = app.buttons["paperclip.status.done"]
        XCTAssertTrue(done.waitForExistence(timeout: 5))
        done.tap()
        let confirm = app.buttons["paperclip.confirmStatus"]
        scrollTo(confirm, app)
        confirm.tap()
        let verify = app.buttons["paperclip.verifyStatus"]
        XCTAssertTrue(verify.waitForExistence(timeout: 10))
        XCTAssertFalse(app.buttons["paperclip.confirmStatus"].exists, "未知结果不能再次PATCH")
        XCTAssertFalse(app.buttons["paperclip.status.todo"].isEnabled, "未知目标必须锁定")
        screenshot("真实生产未知回执只读核实_模拟接口", app)
        scrollTo(verify, app)
        verify.tap()
        XCTAssertTrue(app.staticTexts["状态：已完成"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["检查身份边界，完成中文界面回归验证。\n状态写入次数：1"].exists)
        screenshot("真实生产只读核实成功_模拟接口", app)
    }

    @MainActor
    private func launchTaskFixture(extraArguments: [String] = []) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["--reset-paperclip-fixture", "--server-task-fixture", "-AppleLanguages", "(zh-Hans)", "-AppleLocale", "zh_CN"] + extraArguments
        app.launch()
        XCTAssertTrue(taskLink(app).waitForExistence(timeout: 20))
        return app
    }

    @MainActor
    private func taskLink(_ app: XCUIApplication) -> XCUIElement {
        app.descendants(matching: .any).matching(identifier: "paperclip.issue.issue-1").firstMatch
    }

    @MainActor
    private func openDetail(_ app: XCUIApplication) {
        let task = taskLink(app)
        scrollTo(task, app)
        task.tap()
        XCTAssertTrue(app.navigationBars["服务器任务详情"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["状态：进行中"].waitForExistence(timeout: 10))
    }

    @MainActor
    private func scrollTo(_ target: XCUIElement, _ app: XCUIApplication) {
        for _ in 0..<10 {
            if target.exists && target.isHittable { return }
            if target.exists && target.frame.minY < app.frame.minY + 100 { app.swipeDown() }
            else { app.swipeUp() }
        }
        XCTAssertTrue(target.exists && target.isHittable)
    }

    @MainActor
    private func screenshot(_ name: String, _ app: XCUIApplication) {
        XCTAssertEqual(app.state, .runningForeground)
        // 捕获真实前台模拟器画面，避免为每张图再查询整个应用AX树。
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
