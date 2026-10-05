import XCTest

final class PaperclipNativeJourneys: XCTestCase {
    // 4ea的AX值读取单次耗时超过4秒；只增加只读观察窗口，不重打字或重发动作。
    private let inputVerificationTimeout: TimeInterval = 15
    override func setUpWithError() throws { continueAfterFailure = false }

    @MainActor
    func testChineseBackendSwitchPreservesLocalWorkspaceAndRejectsHTTP() {
        let app = XCUIApplication()
        app.launchArguments = ["--reset-paperclip-fixture", "-AppleLanguages", "(zh-Hans)", "-AppleLocale", "zh_CN"]
        app.launch()
        XCTAssertTrue(app.staticTexts["fixture.localSessions"].waitForExistence(timeout: 10))
        let draft = app.textFields["fixture.localDraft"]
        enterText("local-draft-retained", into: draft, app: app)
        app.buttons["paperclip.openWorkspace"].tap()
        XCTAssertTrue(app.navigationBars["服务器任务"].waitForExistence(timeout: 10))
        XCTAssertFalse(app.segmentedControls["paperclip.backend"].exists)
        XCTAssertEqual(app.tabBars.count, 0)

        XCTAssertFalse(app.buttons["paperclip.create"].isEnabled)
        XCTAssertEqual(app.searchFields.count, 0)
        screenshot("中文服务器空状态", app)
        app.buttons["paperclip.settings"].tap()
        XCTAssertTrue(app.navigationBars["服务器设置"].waitForExistence(timeout: 5))
        app.buttons["paperclip.addProfile"].tap()
        XCTAssertTrue(app.navigationBars["添加服务器"].waitForExistence(timeout: 5))
        let address = app.textFields["paperclip.serverURL"]
        enterText("http://example.com", into: address, app: app)
        app.buttons["保存"].tap()
        XCTAssertTrue(app.staticTexts["请输入独立服务器的 HTTPS 根地址，不包含账号、密码、路径、查询参数或片段。"].waitForExistence(timeout: 5))
        screenshot("拒绝不安全服务器地址", app)
        app.buttons["取消"].tap()
        XCTAssertTrue(app.navigationBars["服务器设置"].waitForExistence(timeout: 5))
        app.buttons["完成"].tap()
        XCTAssertTrue(app.navigationBars["服务器任务"].waitForExistence(timeout: 5))
        app.buttons["paperclip.returnLocal"].tap()
        XCTAssertTrue(app.staticTexts["fixture.localSessions"].waitForExistence(timeout: 5))
        XCTAssertEqual(app.textFields["fixture.localDraft"].value as? String, "local-draft-retained")
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
    func testProductionTaskListCreateAndDetailWithFixtureAPI() {
        let app = launchTaskFixture()
        let task = taskLink(app)
        XCTAssertTrue(task.isHittable, "连接后任务应直接可见，不应被配置表单挤到屏幕下方")
        XCTAssertFalse(app.buttons["paperclip.login"].exists)
        XCTAssertTrue(app.buttons["paperclip.settings"].exists)
        screenshot("真实生产任务列表_模拟接口", app)
        app.buttons["paperclip.create"].tap()
        let title = app.textFields["paperclip.taskTitle"]
        XCTAssertTrue(title.waitForExistence(timeout: 5))
        enterText("创建中文任务", into: title, app: app)
        let create = app.buttons["paperclip.submitTask"]
        scrollTo(create, app)
        create.tap()
        XCTAssertTrue(app.navigationBars["任务-2"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["创建中文任务"].waitForExistence(timeout: 10))
        screenshot("真实生产创建回执_模拟接口", app)
        app.navigationBars.buttons.firstMatch.tap()
        XCTAssertTrue(app.navigationBars["服务器任务"].waitForExistence(timeout: 5))
        openDetail(app)
        XCTAssertTrue(app.staticTexts["修复登录流程"].isHittable)
        // 主线程不出现“编号：”等调试式文案；绑定的服务器地址收进属性面板，仍可查看。
        XCTAssertEqual(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "编号：")).count, 0)
        XCTAssertFalse(app.staticTexts["https://paperclip.fixture.invalid"].exists)
        openTaskInformation(app)
        XCTAssertTrue(app.staticTexts["运行历史"].waitForExistence(timeout: 5))
        let origin = app.staticTexts["https://paperclip.fixture.invalid"]
        scrollTo(origin, app)
        XCTAssertEqual(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "用户编号")).count, 0)
        screenshot("真实生产任务属性面板", app)
        app.buttons["完成"].tap()
        XCTAssertTrue(app.navigationBars["任务-1"].waitForExistence(timeout: 5))
        screenshot("真实生产任务对话_模拟接口", app)
    }

    @MainActor
    func testProductionStatusChangeWithFixtureAPI() {
        let app = launchTaskFixture()
        openDetail(app)
        chooseStatus("已完成", app)
        screenshot("真实生产状态确认_模拟接口", app)
        let confirm = app.buttons["确认更改状态"]
        scrollTo(confirm, app)
        confirm.tap()
        XCTAssertTrue(app.staticTexts["已完成"].waitForExistence(timeout: 10))
        screenshot("真实生产状态回执_模拟接口", app)
    }

    @MainActor
    func testProductionReplyWithFixtureAPI() {
        let app = launchTaskFixture()
        openDetail(app)
        let reply = app.descendants(matching: .any).matching(identifier: "paperclip.replyBody").firstMatch
        scrollTo(reply, app)
        enterText("请补充验证结果", into: reply, app: app)
        let send = app.buttons["paperclip.sendReply"]
        scrollTo(send, app)
        send.tap()
        let receipt = app.staticTexts["请补充验证结果"]
        XCTAssertTrue(receipt.waitForExistence(timeout: 10))
        // 发送成功后收起键盘：以前焦点留在输入框，只读刷新随之一直暂停。
        let keyboardGone = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: app.keyboards.firstMatch)
        XCTAssertEqual(XCTWaiter.wait(for: [keyboardGone], timeout: 5), .completed, "发送成功后必须释放输入焦点")
        XCTAssertEqual(reply.value as? String ?? "", "", "发送成功后草稿清空")
        scrollTo(receipt, app)
        screenshot("真实生产回复回执_模拟接口", app)
    }

    @MainActor
    func testProductionApprovalWithFixtureAPI() {
        let app = launchTaskFixture()
        openDetail(app)
        // 待处理审批是对话里的内联卡片：完整内容与申请者直接可见。
        let card = app.descendants(matching: .any).matching(identifier: "paperclip.approval.approval-1").firstMatch
        scrollTo(card, app)
        XCTAssertTrue(app.staticTexts["聘用代理"].exists)
        XCTAssertTrue(app.staticTexts["申请者：验证智能体"].exists)
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "执行界面回归")).firstMatch.exists)
        let approve = app.buttons["批准"]
        scrollTo(approve, app)
        screenshot("真实生产审批内容_模拟接口", app)
        approve.tap()
        XCTAssertTrue(app.alerts.buttons["确认"].waitForExistence(timeout: 5))
        app.alerts.buttons["确认"].tap()
        let receipt = app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "聘用代理 · 已批准")).firstMatch
        XCTAssertTrue(receipt.waitForExistence(timeout: 10))
        screenshot("真实生产审批回执_模拟接口", app)
    }

    @MainActor
    func testBlockedStatusRequiresExplicitUnblockAction() {
        let app = launchTaskFixture()
        openDetail(app)
        chooseStatus("受阻", app)
        let action = app.textFields["paperclip.unblockAction"]
        scrollTo(action, app)
        let confirm = app.buttons["确认更改状态"]
        XCTAssertTrue(confirm.exists)
        XCTAssertFalse(confirm.isEnabled, "不能在用户未说明解除阻塞条件时提交")
        enterText("请确认访问范围", into: action, app: app)
        let textEntered = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value == %@", "请确认访问范围"), object: action)
        let inputResult = XCTWaiter.wait(for: [textEntered], timeout: inputVerificationTimeout)
        if inputResult != .completed {
            let hierarchy = XCTAttachment(string: app.debugDescription)
            hierarchy.name = "解除阻塞输入未保留_无障碍层级"
            hierarchy.lifetime = .keepAlways
            add(hierarchy)
            screenshot("解除阻塞输入未保留_真实画面", app)
        }
        XCTAssertEqual(inputResult, .completed, "用户输入必须真实保留，不能仅验证按钮状态")
        let disabledDuringEditing = XCTNSPredicateExpectation(predicate: NSPredicate(format: "enabled == false"), object: action)
        disabledDuringEditing.isInverted = true
        XCTAssertEqual(XCTWaiter.wait(for: [disabledDuringEditing], timeout: 16), .completed, "编辑跨过刷新周期时输入框不得被禁用")
        XCTAssertEqual(action.value as? String, "请确认访问范围")
        scrollTo(confirm, app)
        XCTAssertTrue(confirm.isEnabled)
        screenshot("真实生产受阻说明确认_模拟接口", app)
        confirm.tap()
        XCTAssertTrue(app.staticTexts["受阻"].waitForExistence(timeout: 10))
        screenshot("真实生产受阻状态回执_模拟接口", app)
    }

    @MainActor
    func testUnknownStatusReceiptOnlyAllowsReadOnlyVerification() {
        let app = launchTaskFixture(extraArguments: ["--status-receipt-unknown-fixture"])
        openDetail(app)
        chooseStatus("已完成", app)
        let confirm = app.buttons["确认更改状态"]
        scrollTo(confirm, app)
        confirm.tap()
        XCTAssertTrue(app.navigationBars["任务-1"].waitForExistence(timeout: 10))
        app.buttons["paperclip.taskActions"].tap()
        let verify = app.buttons["核实状态（不会重新发送）"]
        XCTAssertTrue(verify.waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["更改任务状态"].isEnabled, "未知结果不能再次PATCH或改变目标")
        screenshot("真实生产未知回执只读核实_模拟接口", app)
        scrollTo(verify, app)
        verify.tap()
        XCTAssertTrue(app.staticTexts["已完成"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["检查身份边界，完成中文界面回归验证。\n状态写入次数：1"].exists)
        screenshot("真实生产只读核实成功_模拟接口", app)
    }

    @MainActor
    func testLocalChatAndDraftSurviveWorkspaceSwitch() {
        let app = launchTaskFixture()
        app.buttons["paperclip.returnLocal"].tap()
        app.buttons["fixture.openChat"].tap()
        let draft = app.textFields["fixture.chatDraft"]
        XCTAssertTrue(draft.waitForExistence(timeout: 5))
        enterText("chat-draft-retained", into: draft, app: app)
        app.buttons["paperclip.openWorkspace"].tap()
        XCTAssertTrue(taskLink(app).waitForExistence(timeout: 10))
        app.buttons["paperclip.returnLocal"].tap()
        XCTAssertTrue(app.staticTexts["fixture.localChat"].waitForExistence(timeout: 5))
        XCTAssertEqual(draft.value as? String, "chat-draft-retained")
        XCTAssertTrue(app.navigationBars.buttons.firstMatch.isHittable)
        app.navigationBars.buttons.firstMatch.tap()
        XCTAssertTrue(app.staticTexts["fixture.localSessions"].waitForExistence(timeout: 5))
    }

    @MainActor
    func testSavedDraftsDoNotStopListOrDetailPolling() {
        verifyDraftPolling(unknownReceipt: false)
    }

    @MainActor
    func testUnknownDraftReceiptsPermitReadsWithoutUnlockingOrResending() {
        verifyDraftPolling(unknownReceipt: true)
    }

    @MainActor
    private func verifyDraftPolling(unknownReceipt: Bool) {
        var arguments = ["--saved-draft-refresh-fixture"]
        if unknownReceipt { arguments.append("--unknown-draft-refresh-fixture") }
        let app = launchTaskFixture(extraArguments: arguments)
        XCTAssertTrue(app.staticTexts["列表已收到服务器更新"].waitForExistence(timeout: 35), "未聚焦的持久创建草稿不能停止轮询")
        let title = app.textFields["paperclip.taskTitle"]
        XCTAssertEqual(title.value as? String, "保留创建草稿")
        XCTAssertEqual(title.isEnabled, !unknownReceipt)
        XCTAssertFalse(app.navigationBars["任务-2"].exists, "轮询不能重发待核对的创建操作")
        openDetail(app)
        XCTAssertTrue(app.staticTexts["详情已收到服务器更新"].waitForExistence(timeout: 35), "未聚焦的持久回复草稿不能停止轮询")
        let reply = app.descendants(matching: .any).matching(identifier: "paperclip.replyBody").firstMatch
        XCTAssertEqual(reply.value as? String, "保留回复草稿")
        XCTAssertEqual(reply.isEnabled, !unknownReceipt)
        XCTAssertFalse(app.staticTexts["保留回复草稿"].exists, "轮询不能自动重发未知回复")
    }

    @MainActor
    func testFocusedReplyNoLongerPausesDetailPolling() {
        // 修复根因：以前输入框聚焦时只读轮询暂停，键盘不收起就一直看不到进展。
        let app = launchTaskFixture(extraArguments: ["--saved-draft-refresh-fixture"])
        openDetail(app)
        let reply = app.descendants(matching: .any).matching(identifier: "paperclip.replyBody").firstMatch
        scrollTo(reply, app)
        reply.tap()
        dismissObservedKeyboardGuide(app, waitForAppearance: true)
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["详情已收到服务器更新"].waitForExistence(timeout: 35), "输入框聚焦时仍要继续同步")
        XCTAssertTrue(app.keyboards.firstMatch.exists, "同步不能抢走正在编辑的焦点")
        XCTAssertEqual(reply.value as? String, "保留回复草稿", "只读同步不改写草稿")
        screenshot("聚焦输入时仍继续同步", app)
    }

    @MainActor
    func testLiveRunCardStreamsProgressLogAndComments() {
        let app = launchTaskFixture(extraArguments: ["--showcase-fixture"])
        // 卡片整体是一个可点按元素，运行中标识合并进它的朗读标签。
        let running = XCTNSPredicateExpectation(predicate: NSPredicate(format: "label CONTAINS %@", "运行中"), object: taskLink(app))
        XCTAssertEqual(XCTWaiter.wait(for: [running], timeout: 10), .completed, "列表需显示运行中标识")
        openDetail(app)
        let card = app.descendants(matching: .any).matching(identifier: "paperclip.runCard.run-live").firstMatch
        XCTAssertTrue(card.waitForExistence(timeout: 10), "进入详情立即显示运行中卡片")
        let activity = app.staticTexts.matching(identifier: "paperclip.runActivity").firstMatch
        XCTAssertTrue(activity.waitForExistence(timeout: 5))
        XCTAssertTrue((activity.label).hasPrefix("执行中"))
        // 实时事件推动卡片更新：当前工具变化。
        let changed = XCTNSPredicateExpectation(predicate: NSPredicate(format: "label == %@", "执行中 · 编辑文件"), object: activity)
        XCTAssertEqual(XCTWaiter.wait(for: [changed], timeout: 20), .completed, "当前工具需随实时事件更新")
        // 智能体评论实时出现。
        let liveComment = app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "已定位问题")).firstMatch
        XCTAssertTrue(liveComment.waitForExistence(timeout: 20), "新评论需实时出现")
        // 展开实时日志：解析后的可读文本，不显示原始 NDJSON。
        let toggle = app.buttons["paperclip.toggleLog"]
        scrollTo(toggle, app)
        toggle.tap()
        let parsed = app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "正在编译项目")).firstMatch
        XCTAssertTrue(parsed.waitForExistence(timeout: 10))
        XCTAssertEqual(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "\"stream\"")).count, 0, "不能显示原始 NDJSON")
        XCTAssertEqual(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "[36m")).count, 0, "不能显示 ANSI 控制码")
        screenshot("运行中卡片_实时日志", app)
        // 已结束运行的摘要：成功显示耗时，失败显示中文原因。
        let failed = app.descendants(matching: .any).matching(identifier: "paperclip.runSummary.run-0").firstMatch
        scrollTo(failed, app)
        XCTAssertTrue(failed.label.contains("智能体执行器出错"), failed.label)
        let done = app.descendants(matching: .any).matching(identifier: "paperclip.runSummary.run-1").firstMatch
        XCTAssertTrue(done.label.hasPrefix("已完成 · "), done.label)
    }

    @MainActor
    func testDesignShowcaseLight() { captureDesignShowcase(dark: false) }

    @MainActor
    func testDesignShowcaseDark() { captureDesignShowcase(dark: true) }

    @MainActor
    private func captureDesignShowcase(dark: Bool) {
        var arguments = ["--showcase-fixture"]
        if dark { arguments.append("--dark-fixture") }
        let app = launchTaskFixture(extraArguments: arguments)
        let suffix = dark ? "深色" : "浅色"
        let running = XCTNSPredicateExpectation(predicate: NSPredicate(format: "label CONTAINS %@", "运行中"), object: taskLink(app))
        XCTAssertEqual(XCTWaiter.wait(for: [running], timeout: 10), .completed)
        screenshot("设计_列表_\(suffix)", app)
        openDetail(app)
        XCTAssertTrue(app.descendants(matching: .any).matching(identifier: "paperclip.runCard.run-live").firstMatch.waitForExistence(timeout: 10))
        // 等实时事件带来第一条进度。
        _ = app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "已定位问题")).firstMatch.waitForExistence(timeout: 15)
        app.swipeDown(); app.swipeDown()
        screenshot("设计_详情顶部_\(suffix)", app)
        let toggle = app.buttons["paperclip.toggleLog"]
        scrollTo(toggle, app)
        toggle.tap()
        _ = app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "正在编译项目")).firstMatch.waitForExistence(timeout: 10)
        screenshot("设计_运行中卡片_\(suffix)", app)
        let approve = app.buttons["批准"]
        scrollTo(approve, app)
        screenshot("设计_内联审批_\(suffix)", app)
        openTaskInformation(app)
        screenshot("设计_属性面板_\(suffix)", app)
    }

    @MainActor
    private func openTaskInformation(_ app: XCUIApplication) {
        app.buttons["paperclip.properties"].tap()
        XCTAssertTrue(app.navigationBars["任务属性"].waitForExistence(timeout: 5))
    }

    @MainActor
    private func chooseStatus(_ title: String, _ app: XCUIApplication) {
        app.buttons["paperclip.taskActions"].tap()
        app.buttons["更改任务状态"].tap()
        let status = app.buttons[title]
        XCTAssertTrue(status.waitForExistence(timeout: 5))
        status.tap()
        XCTAssertTrue(app.navigationBars["确认状态"].waitForExistence(timeout: 5))
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
        XCTAssertTrue(app.navigationBars["任务-1"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["进行中"].waitForExistence(timeout: 10))
    }

    @MainActor
    private func scrollTo(_ target: XCUIElement, _ app: XCUIApplication) {
        for _ in 0..<10 {
            if target.exists && target.isHittable { return }
            if target.exists && target.frame.minY < app.frame.minY + 100 { app.swipeDown() }
            else { app.swipeUp() }
        }
        let hierarchy = XCTAttachment(string: app.debugDescription)
        hierarchy.name = "目标控件不可点击_无障碍层级"
        hierarchy.lifetime = .keepAlways
        add(hierarchy)
        screenshot("目标控件不可点击_真实画面", app)
        XCTAssertTrue(target.exists && target.isHittable)
    }

    @MainActor
    private func quickPathNotice(_ app: XCUIApplication) -> XCUIElement {
        app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "Speed up your typing by sliding your finger")).firstMatch
    }

    @MainActor
    private func dismissObservedKeyboardGuide(_ app: XCUIApplication, waitForAppearance: Bool = false) {
        let notice = quickPathNotice(app)
        let present = waitForAppearance ? notice.waitForExistence(timeout: 3) : notice.exists
        guard present else { return }
        // 只处理已从失败工件确认的QuickPath说明，不接受其他系统权限或通用Continue按钮。
        let evidence = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        evidence.name = "系统QuickPath首次引导_处理前诊断"
        evidence.lifetime = .keepAlways
        add(evidence)
        let next = app.buttons["Continue"]
        XCTAssertTrue(next.waitForExistence(timeout: 5))
        next.tap()
        let gone = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: notice)
        XCTAssertEqual(XCTWaiter.wait(for: [gone], timeout: 5), .completed, "系统首次键盘引导必须先消失")
    }

    @MainActor
    private func enterText(_ text: String, into field: XCUIElement, app: XCUIApplication) {
        field.tap()
        dismissObservedKeyboardGuide(app, waitForAppearance: true)
        field.tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 10), "输入前必须确认系统键盘就绪")
        field.typeText(text)
        dismissObservedKeyboardGuide(app)
        let entered = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value == %@", text), object: field)
        let result = XCTWaiter.wait(for: [entered], timeout: inputVerificationTimeout)
        if result != .completed {
            let hierarchy = XCTAttachment(string: app.debugDescription)
            hierarchy.name = "输入值不符_真实无障碍层级"
            hierarchy.lifetime = .keepAlways
            add(hierarchy)
        }
        XCTAssertEqual(result, .completed, "输入值必须与用户文本一致，不重试掩盖首次失败")
    }

    @MainActor
    private func screenshot(_ name: String, _ app: XCUIApplication) {
        XCTAssertEqual(app.state, .runningForeground)
        dismissObservedKeyboardGuide(app)
        XCTAssertFalse(quickPathNotice(app).exists, "完整应用截图不能被系统首次引导遮挡")
        // 捕获真实前台模拟器画面，避免为每张图再查询整个应用AX树。
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
