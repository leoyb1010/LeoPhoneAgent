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
}
