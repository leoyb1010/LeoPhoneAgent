import XCTest

final class AgentChatCorrectnessTests: XCTestCase {

    func testRelativeCalendarPhrasesResolveWithoutModelGuessing() throws {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        let monday = try XCTUnwrap(calendar.date(from: DateComponents(year: 2026, month: 9, day: 7)))
        XCTAssertEqual(ActionRouter.dayOffset("9月18日", today: monday, calendar: calendar), 11)
        XCTAssertEqual(ActionRouter.dayOffset("周五", today: monday, calendar: calendar), 4)
        XCTAssertEqual(ActionRouter.dayOffset("下周五", today: monday, calendar: calendar), 11)
        XCTAssertEqual(ActionRouter.dayOffset("3天后", today: monday, calendar: calendar), 3)
    }

    func testLastAssistantIndexSkipsTrailingQueuedUser() {
        // assistant, user (queued) — Resume/Stop must target index 0
        XCTAssertEqual(AgentChatCorrectness.lastAssistantIndex(isAssistant: [true, false]), 0)
        XCTAssertEqual(AgentChatCorrectness.lastAssistantIndex(isAssistant: [false, true, false]), 1)
        XCTAssertNil(AgentChatCorrectness.lastAssistantIndex(isAssistant: [false, false]))
        XCTAssertEqual(AgentChatCorrectness.lastAssistantIndex(isAssistant: [true]), 0)
    }

    func testImageAttachmentsBlockedOnTextOnlyModel() {
        XCTAssertTrue(AgentChatCorrectness.shouldBlockImageAttachments(hasImages: true, supportsImageInput: false))
        XCTAssertFalse(AgentChatCorrectness.shouldBlockImageAttachments(hasImages: true, supportsImageInput: true))
        XCTAssertFalse(AgentChatCorrectness.shouldBlockImageAttachments(hasImages: false, supportsImageInput: false))
    }

    func testReadImageRegisteredOnlyForVisionModels() {
        XCTAssertTrue(AgentChatCorrectness.shouldRegisterReadImage(supportsImageInput: true))
        XCTAssertFalse(AgentChatCorrectness.shouldRegisterReadImage(supportsImageInput: false))
    }

    func testOmittedImageReminderIsHonestForTextOnlyModels() {
        let vision = AgentChatCorrectness.omittedImageReminder(inlined: 1, total: 3, supportsImageInput: true)
        XCTAssertNotNil(vision)
        XCTAssertTrue(vision?.contains("read_image") == true)

        let textOnly = AgentChatCorrectness.omittedImageReminder(inlined: 0, total: 2, supportsImageInput: false)
        XCTAssertNotNil(textOnly)
        XCTAssertFalse(textOnly?.contains("read_image") == true)
        XCTAssertTrue(textOnly?.contains("cannot view images") == true)

        XCTAssertNil(AgentChatCorrectness.omittedImageReminder(inlined: 2, total: 2, supportsImageInput: true))
    }

    func testActionRouterSavePhotoAndAlarm() {
        let photo = ActionRouter.decide(text: "把这张图存进相册", imageCount: 1)
        XCTAssertEqual(photo.path, .native)
        XCTAssertEqual(photo.kind, .savePhoto)
        XCTAssertEqual(ActionRouter.decide(text: "把这张图存进相册", imageCount: 0).path, .agent)

        let alarm = ActionRouter.decide(text: "定个明早 8 点闹钟", imageCount: 0)
        XCTAssertEqual(alarm.kind, .setAlarm)
        XCTAssertEqual(alarm.hour, 8)
        XCTAssertEqual(alarm.minute, 0)
        XCTAssertTrue(alarm.tomorrow)

        // 日程 / 待办交给模型分析时间后再写入，不走规则直写。
        XCTAssertEqual(ActionRouter.decide(text: "把明早 9:00 开会加到日历", imageCount: 0).path, .agent)

        XCTAssertEqual(ActionRouter.decide(text: "帮我看看这张图", imageCount: 1).path, .agent)
        XCTAssertEqual(ActionRouter.decide(text: "设个闹钟", imageCount: 0).path, .agent)

        let torch = ActionRouter.decide(text: "打开手电筒", imageCount: 0)
        XCTAssertEqual(torch.kind, .toggleFlashlight)
        XCTAssertEqual(torch.label, "on")
        let torchOff = ActionRouter.decide(text: "turn off flashlight", imageCount: 0)
        XCTAssertEqual(torchOff.label, "off")
        XCTAssertEqual(ActionRouter.decide(text: "记个待办 买牛奶", imageCount: 0).path, .agent)
        XCTAssertEqual(ActionRouter.decide(text: "手电筒坏了怎么办", imageCount: 0).path, .agent)

        XCTAssertEqual(ActionRouter.decide(text: "提醒我后天下午3点去医院复诊", imageCount: 0).path, .agent)
        XCTAssertEqual(ActionRouter.decide(text: "提醒我明天下午三点半开会", imageCount: 0).path, .agent)
        // 带「提醒我」的闹钟也先交给模型，不再被当成没日期的待办直写。
        XCTAssertEqual(ActionRouter.decide(text: "明天7点闹钟提醒我起床", imageCount: 0).path, .agent)

        let enPhoto = ActionRouter.decide(text: "Save this photo to the album", imageCount: 1)
        XCTAssertEqual(enPhoto.path, .native)
        XCTAssertEqual(ActionRouter.decide(text: "add to calendar tomorrow 10:00 standup", imageCount: 0).path, .agent)
        let dawn = ActionRouter.decide(text: "明早 6:30 闹钟", imageCount: 0)
        XCTAssertEqual(dawn.kind, .setAlarm)
        XCTAssertEqual(dawn.hour, 6)
        XCTAssertEqual(dawn.minute, 30)
        XCTAssertTrue(dawn.tomorrow)
    }

    func testActionRouterClipboardAndDeviceInfo() {
        XCTAssertEqual(ActionRouter.decide(text: "剪贴板里有什么", imageCount: 0).kind, .readClipboard)

        let write = ActionRouter.decide(text: "把发布说明复制到剪贴板", imageCount: 0)
        XCTAssertEqual(write.kind, .writeClipboard)
        XCTAssertEqual(write.label, "发布说明")

        let english = ActionRouter.decide(text: "copy hello world to the clipboard", imageCount: 0)
        XCTAssertEqual(english.kind, .writeClipboard)
        XCTAssertEqual(english.label, "hello world")

        XCTAssertEqual(ActionRouter.decide(text: "这台手机是什么型号", imageCount: 0).kind, .deviceInfo)
        XCTAssertEqual(ActionRouter.decide(text: "怎么复制到剪贴板", imageCount: 0).path, .agent)
    }

    func testNativeReceiptNamesPathVerificationAndUndo() {
        let route = ActionRouter.Decision(
            path: .native,
            kind: .setAlarm,
            hour: 7,
            minute: 0,
            tomorrow: true,
            label: "起床"
        )
        let receipt = route.receipt()
        XCTAssertTrue(receipt.contains("路径：系统闹钟"))
        XCTAssertTrue(receipt.contains("系统已确认完成"))
        XCTAssertTrue(receipt.contains("可在系统时钟中关闭"))
    }

    func testResizableWorkspaceLayoutPolicy() {
        XCTAssertFalse(LeoWorkspaceLayoutPolicy.usesSplit(width: 700, regularWidth: true, regularHeight: true))
        XCTAssertTrue(LeoWorkspaceLayoutPolicy.usesSplit(width: 820, regularWidth: true, regularHeight: true))
        XCTAssertTrue(LeoWorkspaceLayoutPolicy.usesSplit(width: 980, regularWidth: true, regularHeight: true))
        XCTAssertFalse(LeoWorkspaceLayoutPolicy.usesSplit(width: 980, regularWidth: false, regularHeight: true))
        // Pro Max phone in landscape: regular width, compact height.
        XCTAssertFalse(LeoWorkspaceLayoutPolicy.usesSplit(width: 932, regularWidth: true, regularHeight: false))
    }

    func testStreamDeltaDroppedAfterCancelOrIdentityMismatch() {
        let expected = UUID()
        let other = UUID()
        XCTAssertFalse(AgentChatCorrectness.shouldApplyStreamDelta(
            userDidCancel: true, messageId: expected, expectedMessageId: expected
        ))
        XCTAssertFalse(AgentChatCorrectness.shouldApplyStreamDelta(
            userDidCancel: false, messageId: other, expectedMessageId: expected
        ))
        XCTAssertTrue(AgentChatCorrectness.shouldApplyStreamDelta(
            userDidCancel: false, messageId: expected, expectedMessageId: expected
        ))
        XCTAssertTrue(AgentChatCorrectness.shouldApplyStreamDelta(
            userDidCancel: false, messageId: nil, expectedMessageId: nil
        ))
    }

    func testSchedulingIntentsGoToAgentForAnalysis() {
        for text in ["帮我记录明天下午19:00要去北京的高铁，车次是，座位是",
                     "记录明天下午19:00去北京的高铁 G1234，座位12A",
                     "帮我记下明天早上8点去机场的行程",
                     "把明天产品评审加到日历"] {
            XCTAssertEqual(ActionRouter.decide(text: text, imageCount: 0).path, .agent, text)
        }
        XCTAssertTrue(ActionRouter.isTravel("记录明天下午19:00去北京的高铁 g1234，座位12a"))
        XCTAssertFalse(ActionRouter.isTravel("高铁真快"), "只有交通工具、没有记录意图不算")
    }

    func testPromptClockIsLocalToTheMinuteWithWeekday() throws {
        var calendar = Calendar(identifier: .gregorian)
        let shanghai = try XCTUnwrap(TimeZone(identifier: "Asia/Shanghai"))
        calendar.timeZone = shanghai
        let date = try XCTUnwrap(calendar.date(from: DateComponents(year: 2026, month: 10, day: 20, hour: 14, minute: 5)))
        XCTAssertEqual(AgentChatCorrectness.promptClock(date, timeZone: shanghai), "2026-10-20 14:05 Tuesday")
    }

    /// [P1-cache] 系统提示尾段在所有消息之前，只能放一天才变一次的日期；分钟级时间跟着用户消息走。
    func testSystemTailDateIsStableWithinADayAndSentAtCarriesTheMinute() throws {
        var calendar = Calendar(identifier: .gregorian)
        let shanghai = try XCTUnwrap(TimeZone(identifier: "Asia/Shanghai"))
        calendar.timeZone = shanghai
        let morning = try XCTUnwrap(calendar.date(from: DateComponents(year: 2026, month: 10, day: 22, hour: 9, minute: 1)))
        let evening = try XCTUnwrap(calendar.date(from: DateComponents(year: 2026, month: 10, day: 22, hour: 23, minute: 59)))
        XCTAssertEqual(AgentChatCorrectness.promptDate(morning, timeZone: shanghai), "2026-10-22 Thursday")
        XCTAssertEqual(AgentChatCorrectness.promptDate(morning, timeZone: shanghai),
                       AgentChatCorrectness.promptDate(evening, timeZone: shanghai))
        let reminder = AgentChatCorrectness.sentAtReminder(morning, timeZone: shanghai)
        XCTAssertEqual(reminder, "<system-reminder>Sent at 2026-10-22 09:01 Thursday (Asia/Shanghai).</system-reminder>")
    }

    func testTitleSourceTextDropsSentAtReminder() {
        let stamp = AgentChatCorrectness.sentAtReminder(Date(timeIntervalSince1970: 0),
                                                        timeZone: TimeZone(identifier: "Asia/Shanghai")!)
        XCTAssertEqual(AgentChatCorrectness.titleSourceText(["帮我订周五的机票", stamp], limit: 200), "帮我订周五的机票")
        XCTAssertEqual(AgentChatCorrectness.titleSourceText(["hi <system-reminder>x</system-reminder> there"], limit: 200), "hi  there")
        XCTAssertEqual(AgentChatCorrectness.titleSourceText([stamp], limit: 200), "")
        XCTAssertEqual(AgentChatCorrectness.titleSourceText(["abcdef", stamp], limit: 3), "abc")
    }
}
