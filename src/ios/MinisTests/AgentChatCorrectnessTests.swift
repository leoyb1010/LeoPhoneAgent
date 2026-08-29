import XCTest

final class AgentChatCorrectnessTests: XCTestCase {

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

        let cal = ActionRouter.decide(text: "把明早 9:00 开会加到日历", imageCount: 0)
        XCTAssertEqual(cal.kind, .createCalendar)
        XCTAssertEqual(cal.hour, 9)
        XCTAssertTrue(cal.tomorrow)

        XCTAssertEqual(ActionRouter.decide(text: "帮我看看这张图", imageCount: 1).path, .agent)
        XCTAssertEqual(ActionRouter.decide(text: "设个闹钟", imageCount: 0).path, .agent)

        let torch = ActionRouter.decide(text: "打开手电筒", imageCount: 0)
        XCTAssertEqual(torch.kind, .toggleFlashlight)
        XCTAssertEqual(torch.label, "on")
        let torchOff = ActionRouter.decide(text: "turn off flashlight", imageCount: 0)
        XCTAssertEqual(torchOff.label, "off")
        let todo = ActionRouter.decide(text: "记个待办 买牛奶", imageCount: 0)
        XCTAssertEqual(todo.kind, .createTodo)
        XCTAssertEqual(todo.label, "买牛奶")
        XCTAssertEqual(ActionRouter.decide(text: "手电筒坏了怎么办", imageCount: 0).path, .agent)

        let enPhoto = ActionRouter.decide(text: "Save this photo to the album", imageCount: 1)
        XCTAssertEqual(enPhoto.path, .native)
        let enCal = ActionRouter.decide(text: "add to calendar tomorrow 10:00 standup", imageCount: 0)
        XCTAssertEqual(enCal.kind, .createCalendar)
        XCTAssertEqual(enCal.hour, 10)
        XCTAssertTrue(enCal.tomorrow)
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

    func testResizableWorkspaceLayoutPolicy() {
        XCTAssertFalse(LeoWorkspaceLayoutPolicy.usesSplit(width: 700, height: 900, regularWidth: true))
        XCTAssertTrue(LeoWorkspaceLayoutPolicy.usesSplit(width: 820, height: 1_100, regularWidth: true))
        XCTAssertTrue(LeoWorkspaceLayoutPolicy.usesSplit(width: 980, height: 650, regularWidth: true))
        XCTAssertFalse(LeoWorkspaceLayoutPolicy.usesSplit(width: 980, height: 650, regularWidth: false))
        XCTAssertFalse(LeoWorkspaceLayoutPolicy.usesSplit(width: 1_000, height: 430, regularWidth: true))
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

    func testTravelIntentClarifiesMissingFieldsAndNeverGuesses() {
        let partial = ActionRouter.decide(
            text: "帮我记录明天下午19:00要去北京的高铁，车次是，座位是",
            imageCount: 0
        )
        XCTAssertEqual(partial.path, .clarify)
        XCTAssertEqual(partial.kind, .createTravel)
        XCTAssertEqual(partial.location, "北京")
        XCTAssertEqual(partial.missingFields, ["车次", "座位"])

        let complete = ActionRouter.decide(
            text: "记录明天下午19:00去北京的高铁 G1234，座位12A",
            imageCount: 0
        )
        XCTAssertEqual(complete.path, .native)
        XCTAssertEqual(complete.kind, .createTravel)
        XCTAssertEqual(complete.hour, 19)
        XCTAssertTrue(complete.notes.contains("G1234"))
        XCTAssertTrue(complete.notes.contains("12A"))
    }
}
