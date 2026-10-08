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

    /// [T-prompt-cache-no-random] A random key guaranteed a cache miss on every turn of a
    /// text-less conversation. The key is now deterministic across turns.
    func testNoTextFallsBackToStableShapeKey() {
        let a = PromptCacheKey.derive(sessionId: nil, firstUserText: nil, firstMessageShape: "user|img:image/png")
        XCTAssertEqual(a, PromptCacheKey.derive(sessionId: nil, firstUserText: nil, firstMessageShape: "user|img:image/png"))
        XCTAssertNotEqual(a, PromptCacheKey.derive(sessionId: nil, firstUserText: nil, firstMessageShape: "user|img:image/jpeg"))
        XCTAssertEqual(PromptCacheKey.derive(sessionId: nil, firstUserText: nil),
                       PromptCacheKey.derive(sessionId: nil, firstUserText: nil))
        XCTAssertTrue(PromptCacheKey.derive(sessionId: nil, firstUserText: nil).hasPrefix("minis-"))
    }

    /// [T-ios-prompt-cache-key-400] Strict-schema gateways 400 on the unknown field.
    func testOnlyOfficialOpenAIAndForcedResponsesRelaysGetTheKey() {
        XCTAssertTrue(PromptCacheKey.shouldSend(customBaseURL: nil, isAzure: false, forceResponsesAPI: false))
        XCTAssertTrue(PromptCacheKey.shouldSend(customBaseURL: "https://relay.example/v1", isAzure: false, forceResponsesAPI: true))
        XCTAssertFalse(PromptCacheKey.shouldSend(customBaseURL: "https://api.deepseek.com", isAzure: false, forceResponsesAPI: false))
        XCTAssertFalse(PromptCacheKey.shouldSend(customBaseURL: nil, isAzure: true, forceResponsesAPI: false))
    }
}
