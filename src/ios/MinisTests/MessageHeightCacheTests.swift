import CoreGraphics
import XCTest

/// [T-ios-listsessions-perf] Content-keyed, bounded height cache (ported from
/// upstream Standalone/HeightCacheKeyTests) + B2 live-message rule guard.
final class MessageHeightCacheTests: XCTestCase {
    private let body = "## Title\n\nSome **bold** text and a [link](https://example.com).\n\n- one\n- two"

    func testSameInputsSameKey() {
        XCTAssertEqual(HeightCacheKey(content: body, width: 358, fontSize: 16),
                       HeightCacheKey(content: String(body), width: 358, fontSize: 16))
    }

    func testAnyDifferingInputMisses() {
        let base = HeightCacheKey(content: body, width: 358, fontSize: 16)
        XCTAssertNotEqual(HeightCacheKey(content: body + "!", width: 358, fontSize: 16), base)
        XCTAssertNotEqual(HeightCacheKey(content: body, width: 744, fontSize: 16), base, "rotation")
        XCTAssertNotEqual(HeightCacheKey(content: body, width: 358, fontSize: 20), base, "Dynamic Type")
        XCTAssertNotEqual(HeightCacheKey(content: "**bold**", width: 358, fontSize: 16),
                          HeightCacheKey(content: "bold", width: 358, fontSize: 16), "markdown source, not rendered text")
    }

    func testWidthAndFontKeyedAtHundredthsOfAPoint() {
        XCTAssertNotEqual(HeightCacheKey(content: body, width: 358.0, fontSize: 16),
                          HeightCacheKey(content: body, width: 358.4, fontSize: 16))
        XCTAssertNotEqual(HeightCacheKey(content: body, width: 358, fontSize: 16.49),
                          HeightCacheKey(content: body, width: 358, fontSize: 16.51))
        XCTAssertEqual(HeightCacheKey(content: body, width: 358.001, fontSize: 16),
                       HeightCacheKey(content: body, width: 358.0, fontSize: 16))
    }

    func testLRUCapAndFIFOEviction() {
        var lru = HeightLRU(capacity: 3)
        let keys = (0..<4).map { HeightCacheKey(content: "k\($0)", width: 100, fontSize: 16) }
        for (i, key) in keys.enumerated() { lru[key] = CGFloat(i) }
        XCTAssertEqual(lru.count, 3)
        XCTAssertNil(lru[keys[0]], "oldest evicted")
        XCTAssertEqual(lru[keys[3]], 3)
        lru[keys[1]] = 42   // overwrite: no growth, no reorder
        XCTAssertEqual(lru.count, 3)
        lru[HeightCacheKey(content: "k4", width: 100, fontSize: 16)] = 4
        XCTAssertNil(lru[keys[1]], "overwrite did not refresh its slot")
        lru[keys[2]] = nil
        XCTAssertEqual(lru.count, 2)
        lru.removeAll()
        XCTAssertEqual(lru.count, 0)
        var tiny = HeightLRU(capacity: 0)
        tiny[keys[0]] = 1; tiny[keys[1]] = 2
        XCTAssertEqual(tiny.count, 1, "capacity floor is 1")
    }

    func testCapHoldsUnderChurnAndRevisitHits() {
        var lru = HeightLRU(capacity: 300)
        for i in 0..<5_000 { lru[HeightCacheKey(content: "block \(i)", width: 358, fontSize: 16.5)] = CGFloat(i) }
        XCTAssertEqual(lru.count, 300)
        // A session revisit: three passes over the same 40 blocks measure once.
        var measures = 0
        for _ in 0..<3 {
            for i in 0..<40 {
                let key = HeightCacheKey(content: "visit \(i)", width: 358, fontSize: 16.5)
                if lru[key] == nil { measures += 1; lru[key] = 10 }
            }
        }
        XCTAssertEqual(measures, 40)
    }

    /// The list sources are not compiled into the logic-test target; guard the
    /// wiring the cache's correctness depends on.
    func testMessageListWiring() throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
        let src = try String(contentsOf: root.appendingPathComponent("Agent/MessageList/CollectionViewMessageListV3.swift"), encoding: .utf8)
        XCTAssertTrue(src.contains("HeightLRU(capacity: 300)"))
        XCTAssertFalse(src.contains("ObjectIdentifier(attrStr)"))
        XCTAssertTrue(src.contains("content: block.content"))
        XCTAssertTrue(src.contains("scaledMessage(16.5)"))
        XCTAssertTrue(src.contains("didReceiveMemoryWarningNotification"))
        XCTAssertTrue(src.contains("containsAttachments(in:"), "attachment strings are never cached")
        XCTAssertTrue(src.contains("attrStr.length <= 8000"), "sizeThatFits watchdog unchanged")
        // B2: one live-message rule for the seed exclusion and the streaming ranges.
        XCTAssertTrue(src.contains("static func liveAssistantMessageIds(messages: [ChatMessage], isProcessing: Bool)"))
        XCTAssertTrue(src.contains("let streamingIds = Array(liveAssistantIds(in: messages, isProcessing: true))"))
        XCTAssertFalse(src.contains("itemMsgId == messages.last?.id && messages.last?.role == .assistant"),
                       "the last-message-only exclusion froze growing earlier messages")
        XCTAssertTrue(src.contains("streamGeneration &+= 1"))
    }
}
