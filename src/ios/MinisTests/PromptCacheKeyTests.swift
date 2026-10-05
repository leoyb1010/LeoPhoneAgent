import XCTest

final class PromptCacheKeyTests: XCTestCase {
    func testSessionIdWinsOverFirstMessage() {
        let a = PromptCacheKey.derive(sessionId: "s1", firstUserText: "继续")
        let b = PromptCacheKey.derive(sessionId: "s2", firstUserText: "继续")
        XCTAssertNotEqual(a, b, "two chats that both start with 继续 must not share a cache key")
        XCTAssertEqual(a, PromptCacheKey.derive(sessionId: "s1", firstUserText: "changed after compaction"))
    }

    func testKeyShape() {
        let key = PromptCacheKey.derive(sessionId: "s1", firstUserText: nil)
        XCTAssertTrue(key.hasPrefix("minis-"))
        XCTAssertEqual(key.count, "minis-".count + 32)
    }

    func testWithoutSessionFallsBackToFirstMessageHash() {
        let a = PromptCacheKey.derive(sessionId: nil, firstUserText: "hello")
        XCTAssertEqual(a, PromptCacheKey.derive(sessionId: "", firstUserText: "hello"))
        XCTAssertNotEqual(a, PromptCacheKey.derive(sessionId: nil, firstUserText: "other"))
    }

    func testNothingStableGivesRandomKey() {
        XCTAssertNotEqual(PromptCacheKey.derive(sessionId: nil, firstUserText: nil),
                          PromptCacheKey.derive(sessionId: nil, firstUserText: nil))
    }
}
