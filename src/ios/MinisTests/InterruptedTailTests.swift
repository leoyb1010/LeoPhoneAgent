import XCTest

final class InterruptedTailTests: XCTestCase {
    func testPlainUserTailIsRecoverable() {
        XCTAssertTrue(AgentChatCorrectness.isInterruptedTail(role: .user, parts: [.text("hello")]))
    }

    func testEmptyUserTailIsNotRecoverable() {
        XCTAssertFalse(AgentChatCorrectness.isInterruptedTail(role: .user, parts: []))
    }

    func testCompletedAssistantTextIsNotRecoverable() {
        XCTAssertFalse(AgentChatCorrectness.isInterruptedTail(role: .assistant, parts: [.text("done")]))
    }
}
