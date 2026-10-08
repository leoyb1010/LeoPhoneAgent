import XCTest

/// [T-ios-listsessions-perf] Provider send-path caches (ported from upstream
/// Standalone/ProviderSendPathCacheTests, against the production helpers).
final class ProviderSendPathCacheTests: XCTestCase {
    override func setUp() { ProviderSendPathCache.clearDownscaleCache() }

    func testBodyMentionsToolsNeverFalseNegative() throws {
        let bodies: [[String: Any]] = [
            ["model": "m", "tools": [["name": "shell"]], "messages": []],
            ["tools": [], "model": "m"],
            ["model": "m", "messages": [["role": "user", "content": "x"]], "tools": [["name": "a"], ["name": "b"]]],
        ]
        for object in bodies {
            for options: JSONSerialization.WritingOptions in [[], [.sortedKeys], [.prettyPrinted]] {
                let data = try JSONSerialization.data(withJSONObject: object, options: options)
                XCTAssertTrue(ProviderSendPathCache.bodyMentionsTools(data))
            }
        }
    }

    func testBodyWithoutToolsSkipsTheParse() {
        XCTAssertFalse(ProviderSendPathCache.bodyMentionsTools(Data(#"{"model":"m","messages":[{"role":"user","content":"hi"}]}"#.utf8)))
        XCTAssertFalse(ProviderSendPathCache.bodyMentionsTools(Data()))
        XCTAssertFalse(ProviderSendPathCache.bodyMentionsTools(Data("{}".utf8)))
        // The key as a string VALUE is a harmless false positive (falls through
        // to the parse); an escaped mention inside prose does not even match.
        XCTAssertTrue(ProviderSendPathCache.bodyMentionsTools(Data(#"{"messages":[{"content":"tools"}]}"#.utf8)))
        XCTAssertFalse(ProviderSendPathCache.bodyMentionsTools(Data(#"{"messages":[{"content":"list \"tools\" please"}]}"#.utf8)))
    }

    func testDownscaleIsComputedOncePerImageAndRemembersNoOp() {
        var calls = 0
        let big = Data(repeating: 7, count: 4096)
        let first = ProviderSendPathCache.memoizedDownscale(big, maxLongEdge: 2000) { _ in calls += 1; return Data([1, 2, 3]) }
        let second = ProviderSendPathCache.memoizedDownscale(big, maxLongEdge: 2000) { _ in calls += 1; return Data([9]) }
        XCTAssertEqual(first, Data([1, 2, 3]))
        XCTAssertEqual(second, Data([1, 2, 3]))
        XCTAssertEqual(calls, 1)

        let small = Data(repeating: 1, count: 100)
        XCTAssertNil(ProviderSendPathCache.memoizedDownscale(small, maxLongEdge: 2000) { _ in calls += 1; return nil })
        XCTAssertNil(ProviderSendPathCache.memoizedDownscale(small, maxLongEdge: 2000) { _ in calls += 1; return Data([5]) },
                     "NSNull memo: 'no downscale needed' is remembered")
        XCTAssertEqual(calls, 2)
    }

    /// Foundation's Data hash digests only the length and the first 80 bytes;
    /// two same-size images with identical headers must still get distinct keys.
    func testKeyCoversTheWholeImageNotJustTheHeader() {
        var a = Data(repeating: 0xAB, count: 10_000)
        var b = a
        a[9_999] = 1
        b[9_999] = 2
        XCTAssertNotEqual(ProviderSendPathCache.downscaleKey(a, maxLongEdge: 2000),
                          ProviderSendPathCache.downscaleKey(b, maxLongEdge: 2000))
        var calls = 0
        _ = ProviderSendPathCache.memoizedDownscale(a, maxLongEdge: 2000) { _ in calls += 1; return Data([1]) }
        let rb = ProviderSendPathCache.memoizedDownscale(b, maxLongEdge: 2000) { _ in calls += 1; return Data([2]) }
        XCTAssertEqual(rb, Data([2]))
        XCTAssertEqual(calls, 2)
        XCTAssertNotEqual(ProviderSendPathCache.downscaleKey(a, maxLongEdge: 2000),
                          ProviderSendPathCache.downscaleKey(a, maxLongEdge: 1000))
    }
}
