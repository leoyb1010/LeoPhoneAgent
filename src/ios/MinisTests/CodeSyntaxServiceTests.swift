import XCTest

/// 代码块高亮的调度层：大小阈值、流式节奏、后台队列与 LRU 缓存（CodeSyntaxHighlighter）。
final class CodeSyntaxServiceTests: XCTestCase {
    /// 装异步回调的结果。回调在主线程，断言在测试线程：用锁保护，避免数据竞争。
    private final class Box: @unchecked Sendable {
        private let lock = NSLock()
        private var _calls = 0
        private var _spans: [LeoSyntaxSpan]?
        private var _onMain = false

        func record(_ spans: [LeoSyntaxSpan]?, onMain: Bool) {
            lock.lock(); defer { lock.unlock() }
            _calls += 1
            _spans = spans
            _onMain = onMain
        }

        var calls: Int { lock.lock(); defer { lock.unlock() }; return _calls }
        var spans: [LeoSyntaxSpan]? { lock.lock(); defer { lock.unlock() }; return _spans }
        var onMain: Bool { lock.lock(); defer { lock.unlock() }; return _onMain }
    }

    private func lines(_ count: Int, width: Int = 10) -> String {
        Array(repeating: String(repeating: "a", count: width), count: count).joined(separator: "\n")
    }

    /// 恰好 `characters` 个码元、每行 ≤ 1999 的文本（只碰字符上限，不碰行数/行长上限）。
    private func block(characters: Int) -> String {
        let line = String(repeating: "a", count: 1999) + "\n"
        let repeated = String(repeating: line, count: characters / 2000 + 1)
        return String(repeated.prefix(characters))
    }

    /// 每行 999 个 emoji（1998 个码元）+ 换行。
    private func emojiBlock(lines count: Int) -> String {
        Array(repeating: String(repeating: "😀", count: 999), count: count).joined(separator: "\n")
    }

    /// 脚本化时钟：依次返回预设的时刻，用完后一直返回最后一个。
    private final class ScriptedClock: @unchecked Sendable {
        private let lock = NSLock()
        private var values: [TimeInterval]
        init(_ values: [TimeInterval]) { self.values = values }
        func tick() -> TimeInterval {
            lock.lock(); defer { lock.unlock() }
            return values.count > 1 ? values.removeFirst() : (values.first ?? 0)
        }
    }

    // MARK: 阈值

    func testLimitsAcceptTheBoundaryAndRejectOneBeyond() {
        XCTAssertTrue(LeoCodeHighlightLimits.allowsHighlighting(""))
        XCTAssertTrue(LeoCodeHighlightLimits.allowsHighlighting("let x = 1"))
        // 行数：2000 行可以，2001 行不行
        XCTAssertTrue(LeoCodeHighlightLimits.allowsHighlighting(lines(2000)))
        XCTAssertFalse(LeoCodeHighlightLimits.allowsHighlighting(lines(2001)))
        // 字符数：128_000 可以，128_001 不行（每行都很短，不会先撞上行长上限）
        XCTAssertTrue(LeoCodeHighlightLimits.allowsHighlighting(block(characters: 128_000)))
        XCTAssertFalse(LeoCodeHighlightLimits.allowsHighlighting(block(characters: 128_001)))
        // 单行长度：2000 可以，2001 不行
        XCTAssertTrue(LeoCodeHighlightLimits.allowsHighlighting(String(repeating: "a", count: 2000)))
        XCTAssertFalse(LeoCodeHighlightLimits.allowsHighlighting(String(repeating: "a", count: 2001)))
        // 只要有任意一行超长就不行，哪怕总量很小
        XCTAssertFalse(LeoCodeHighlightLimits.allowsHighlighting("short\n" + String(repeating: "b", count: 2001) + "\nshort"))
    }

    func testLimitsCountCharactersInUTF16AndTreatCRLFAsOneBreak() {
        // 每个 emoji 两个码元：65 行 × 1998 = 129_870 > 128_000，但只有 65 行、每行 1998，不会先撞上别的上限
        XCTAssertFalse(LeoCodeHighlightLimits.allowsHighlighting(emojiBlock(lines: 65)))
        XCTAssertTrue(LeoCodeHighlightLimits.allowsHighlighting(emojiBlock(lines: 60)))
        // 一行 1001 个 emoji = 2002 个码元 > 2000（String.count 只有 1001）
        XCTAssertFalse(LeoCodeHighlightLimits.allowsHighlighting(String(repeating: "😀", count: 1001)))
        XCTAssertTrue(LeoCodeHighlightLimits.allowsHighlighting(String(repeating: "😀", count: 1000)))
        // \r\n 只算一个换行：2000 行可以，2001 行不行
        XCTAssertTrue(LeoCodeHighlightLimits.allowsHighlighting(Array(repeating: "x", count: 2000).joined(separator: "\r\n")))
        XCTAssertFalse(LeoCodeHighlightLimits.allowsHighlighting(Array(repeating: "x", count: 2001).joined(separator: "\r\n")))
        // 单独的 \r 也算换行
        XCTAssertFalse(LeoCodeHighlightLimits.allowsHighlighting(Array(repeating: "x", count: 2001).joined(separator: "\r")))
    }

    func testSynchronousHighlightingRefusesOversizedOrPlainText() {
        let highlighter = LeoCodeHighlighter()
        XCTAssertNil(highlighter.spans(code: lines(2001), language: "swift", isDark: false))
        XCTAssertNil(highlighter.spans(code: String(repeating: "a", count: 2001), language: "swift", isDark: false))
        XCTAssertNil(highlighter.spans(code: "let x = 1", language: "text", isDark: false), "plain text stays plain")
        XCTAssertEqual(highlighter.cachedEntryCount, 0, "refused work must not be cached")
        XCTAssertNotNil(highlighter.spans(code: "let x = 1", language: "swift", isDark: false))
        XCTAssertEqual(highlighter.cachedEntryCount, 1)
    }

    func testRequestForAnOversizedBlockCompletesWithNilAndCachesNothing() {
        let highlighter = LeoCodeHighlighter()
        let done = expectation(description: "completion")
        let box = Box()
        highlighter.request(code: lines(2001), language: "swift", isDark: false) { spans in
            box.record(spans, onMain: Thread.isMainThread)
            done.fulfill()
        }
        wait(for: [done], timeout: 10)
        XCTAssertEqual(box.calls, 1)
        XCTAssertNil(box.spans)
        XCTAssertTrue(box.onMain)
        XCTAssertEqual(highlighter.cachedEntryCount, 0)
    }

    // MARK: 异步请求

    func testRequestDeliversSpansOnTheMainThreadExactlyOnceAndCaches() {
        let highlighter = LeoCodeHighlighter()
        let code = "let x = \"a\" // b"
        let done = expectation(description: "completion")
        let box = Box()
        // 超时放宽到 60 秒：这里测的不是超时，别让繁忙的 CI 机器把结果误判成「晚到」。
        highlighter.request(code: code, language: "swift", isDark: false, timeout: 60) { spans in
            box.record(spans, onMain: Thread.isMainThread)
            done.fulfill()
        }
        wait(for: [done], timeout: 10)
        XCTAssertEqual(box.calls, 1)
        XCTAssertTrue(box.onMain)
        XCTAssertEqual(box.spans, LeoSyntaxHighlighter.highlight(code, language: "swift"))
        let key = LeoCodeHighlighter.key(code: code, language: "swift", isDark: false)
        XCTAssertEqual(highlighter.cachedSpans(for: key), box.spans, "a later view finds it synchronously")
    }

    func testARequestThatWaitedTooLongInTheQueueIsAnsweredWithNilWithoutBeingComputed() {
        // 时钟：请求时 0 秒，轮到它执行时已过去 5 秒（超过 1 秒的期限）。
        let clock = ScriptedClock([0, 5])
        let highlighter = LeoCodeHighlighter(now: { clock.tick() })
        let code = "let late = 1"
        let done = expectation(description: "completion")
        let box = Box()
        highlighter.request(code: code, language: "swift", isDark: false) { spans in
            box.record(spans, onMain: Thread.isMainThread)
            done.fulfill()
        }
        wait(for: [done], timeout: 10)
        XCTAssertEqual(box.calls, 1, "the caller is still told, with nil, so it can clear its pending state")
        XCTAssertNil(box.spans)
        XCTAssertNil(highlighter.cachedSpans(for: LeoCodeHighlighter.key(code: code, language: "swift", isDark: false)),
                     "work that was already too late is not even started")
    }

    func testAResultFinishedAfterTheDeadlineIsNotBackFilledButIsCachedForTheNextView() {
        // 时钟：请求 0 秒、开始 0.1 秒（还来得及）、算完 1.5 秒（晚了）。
        let clock = ScriptedClock([0, 0.1, 1.5])
        let highlighter = LeoCodeHighlighter(now: { clock.tick() })
        let code = "let finishedLate = 1"
        let done = expectation(description: "completion")
        let box = Box()
        highlighter.request(code: code, language: "swift", isDark: false) { spans in
            box.record(spans, onMain: Thread.isMainThread)
            done.fulfill()
        }
        wait(for: [done], timeout: 10)
        XCTAssertEqual(box.calls, 1)
        XCTAssertNil(box.spans, "a late result must not appear on a view the user may be scrolling")
        // 但结果进了缓存：下一次创建这段代码的视图时，在第一帧之前当场命中，不会闪。
        XCTAssertEqual(highlighter.cachedSpans(for: LeoCodeHighlighter.key(code: code, language: "swift", isDark: false)),
                       LeoSyntaxHighlighter.highlight(code, language: "swift"))
    }

    func testAResultWithinTheDeadlineIsDelivered() {
        let clock = ScriptedClock([0, 0.1, 0.9])
        let highlighter = LeoCodeHighlighter(now: { clock.tick() })
        let done = expectation(description: "completion")
        let box = Box()
        highlighter.request(code: "let ontime = 1", language: "swift", isDark: false) { spans in
            box.record(spans, onMain: Thread.isMainThread)
            done.fulfill()
        }
        wait(for: [done], timeout: 10)
        XCTAssertNotNil(box.spans)
    }

    func testManyQueuedRequestsAllCompleteExactlyOnce() {
        let highlighter = LeoCodeHighlighter()
        let count = 12
        let done = expectation(description: "all")
        done.expectedFulfillmentCount = count
        let seen = OrderBox()
        for index in 0 ..< count {
            highlighter.request(code: "let v\(index) = \(index)", language: "swift", isDark: false, timeout: 60) { spans in
                XCTAssertNotNil(spans)
                seen.append(index)
                done.fulfill()
            }
        }
        wait(for: [done], timeout: 10)
        XCTAssertEqual(seen.values.sorted(), Array(0 ..< count))
        XCTAssertEqual(highlighter.cachedEntryCount, count)
    }

    private final class OrderBox: @unchecked Sendable {
        private let lock = NSLock()
        private var _values: [Int] = []
        func append(_ value: Int) { lock.lock(); _values.append(value); lock.unlock() }
        var values: [Int] { lock.lock(); defer { lock.unlock() }; return _values }
    }

    // MARK: 缓存键与 LRU

    func testCacheKeySeparatesLanguageContentAndAppearance() {
        let base = LeoCodeHighlighter.key(code: "let x = 1", language: "swift", isDark: false)
        XCTAssertEqual(base, LeoCodeHighlighter.key(code: "let x = 1", language: "swift", isDark: false))
        XCTAssertEqual(base, LeoCodeHighlighter.key(code: "let x = 1", language: "Swift", isDark: false), "language is normalised")
        XCTAssertNotEqual(base, LeoCodeHighlighter.key(code: "let x = 1", language: "swift", isDark: true))
        XCTAssertNotEqual(base, LeoCodeHighlighter.key(code: "let x = 1", language: "python", isDark: false))
        XCTAssertNotEqual(base, LeoCodeHighlighter.key(code: "let x = 2", language: "swift", isDark: false))
        XCTAssertNotEqual(base, LeoCodeHighlighter.key(code: "let x = 1 ", language: "swift", isDark: false))
    }

    func testCacheKeyIsByteExactForCanonicallyEquivalentText() {
        // é 的两种写法在 Unicode 上等价，但 UTF-16 偏移不同：不能共用同一份 span。
        let composed = LeoCodeHighlighter.key(code: "let a = \"\u{00E9}\"", language: "swift", isDark: false)
        let decomposed = LeoCodeHighlighter.key(code: "let a = \"e\u{0301}\"", language: "swift", isDark: false)
        XCTAssertNotEqual(composed, decomposed)
    }

    func testLeastRecentlyUsedEntryIsEvictedFirst() {
        let highlighter = LeoCodeHighlighter(capacity: 2)
        func key(_ code: String) -> LeoCodeHighlighter.Key { LeoCodeHighlighter.key(code: code, language: "swift", isDark: false) }
        _ = highlighter.spans(code: "let a = 1", language: "swift", isDark: false)
        _ = highlighter.spans(code: "let b = 2", language: "swift", isDark: false)
        _ = highlighter.cachedSpans(for: key("let a = 1")) // 用一下 a，b 变成最久没用
        _ = highlighter.spans(code: "let c = 3", language: "swift", isDark: false)
        XCTAssertEqual(highlighter.cachedEntryCount, 2)
        XCTAssertNil(highlighter.cachedSpans(for: key("let b = 2")), "b was least recently used")
        XCTAssertNotNil(highlighter.cachedSpans(for: key("let a = 1")))
        XCTAssertNotNil(highlighter.cachedSpans(for: key("let c = 3")))
    }

    func testDefaultCapacityIs256() {
        let highlighter = LeoCodeHighlighter()
        for index in 0 ..< 300 {
            _ = highlighter.spans(code: "let n\(index) = \(index)", language: "swift", isDark: false)
        }
        XCTAssertEqual(highlighter.cachedEntryCount, 256)
        XCTAssertNil(highlighter.cachedSpans(for: LeoCodeHighlighter.key(code: "let n0 = 0", language: "swift", isDark: false)))
        XCTAssertNotNil(highlighter.cachedSpans(for: LeoCodeHighlighter.key(code: "let n299 = 299", language: "swift", isDark: false)))
    }

    func testSpanBudgetBoundsMemoryNotJustTheEntryCount() {
        let highlighter = LeoCodeHighlighter(capacity: 100, spanBudget: 30)
        let first = (0 ..< 16).map { "let a\($0) = \($0)" }.joined(separator: "\n") // 每行 3 个 span，共 48 个，超过预算 30
        let second = "let b = 1"
        XCTAssertGreaterThan(highlighter.spans(code: first, language: "swift", isDark: false)?.count ?? 0, 30)
        XCTAssertEqual(highlighter.cachedEntryCount, 1, "a lone oversized entry is kept so it can be used once")
        _ = highlighter.spans(code: second, language: "swift", isDark: false)
        XCTAssertEqual(highlighter.cachedEntryCount, 1)
        XCTAssertNil(highlighter.cachedSpans(for: LeoCodeHighlighter.key(code: first, language: "swift", isDark: false)))
        XCTAssertNotNil(highlighter.cachedSpans(for: LeoCodeHighlighter.key(code: second, language: "swift", isDark: false)))
    }

    func testRemoveAllClearsTheCache() {
        let highlighter = LeoCodeHighlighter()
        _ = highlighter.spans(code: "let a = 1", language: "swift", isDark: false)
        highlighter.removeAll()
        XCTAssertEqual(highlighter.cachedEntryCount, 0)
    }

    // MARK: 流式节奏

    func testPacingConstantsMatchTheSpec() {
        XCTAssertEqual(LeoCodeHighlightPacing.streamingInterval, 0.7)
        XCTAssertEqual(LeoCodeHighlightPacing.streamingMaxCharacters, 8_000)
        XCTAssertEqual(LeoCodeHighlightPacing.resultTimeout, 1.0)
        XCTAssertEqual(LeoCodeHighlightLimits.maxLines, 2000)
        XCTAssertEqual(LeoCodeHighlightLimits.maxCharacters, 128_000)
        XCTAssertEqual(LeoCodeHighlightLimits.maxLineLength, 2000)
    }

    func testAClosedFenceIsHighlightedAtOnceWhateverItsSizeOrHistory() {
        for count in [0, 100, 7_999, 8_000, 100_000] {
            XCTAssertEqual(LeoCodeHighlightPacing.decide(isOpen: false, characterCount: count, lastRequestAt: nil, now: 10), .now)
            XCTAssertEqual(LeoCodeHighlightPacing.decide(isOpen: false, characterCount: count, lastRequestAt: 9.99, now: 10), .now)
        }
    }

    func testAnOpenFenceIsThrottledToOneRequestPer700ms() {
        // 第一次：马上
        XCTAssertEqual(LeoCodeHighlightPacing.decide(isOpen: true, characterCount: 50, lastRequestAt: nil, now: 100), .now)
        // 刚请求过：等到 700ms 为止
        guard case let .wait(shortly) = LeoCodeHighlightPacing.decide(isOpen: true, characterCount: 50, lastRequestAt: 100, now: 100.1) else {
            return XCTFail("expected .wait")
        }
        XCTAssertEqual(shortly, 0.6, accuracy: 0.0001)
        guard case let .wait(almost) = LeoCodeHighlightPacing.decide(isOpen: true, characterCount: 50, lastRequestAt: 100, now: 100.699) else {
            return XCTFail("expected .wait")
        }
        XCTAssertEqual(almost, 0.001, accuracy: 0.0001)
        // 到点了：马上
        XCTAssertEqual(LeoCodeHighlightPacing.decide(isOpen: true, characterCount: 50, lastRequestAt: 100, now: 100.7), .now)
        XCTAssertEqual(LeoCodeHighlightPacing.decide(isOpen: true, characterCount: 50, lastRequestAt: 100, now: 105), .now)
    }

    func testAnOpenFenceOfEightThousandCharactersOrMoreWaitsForTheFenceToClose() {
        XCTAssertEqual(LeoCodeHighlightPacing.decide(isOpen: true, characterCount: 7_999, lastRequestAt: nil, now: 1), .now)
        XCTAssertEqual(LeoCodeHighlightPacing.decide(isOpen: true, characterCount: 8_000, lastRequestAt: nil, now: 1), .skip)
        XCTAssertEqual(LeoCodeHighlightPacing.decide(isOpen: true, characterCount: 50_000, lastRequestAt: 0, now: 100), .skip)
    }

    func testResultFreshnessIsOneSecondFromTheRequest() {
        XCTAssertTrue(LeoCodeHighlightPacing.isFresh(requestedAt: 10, now: 10))
        XCTAssertTrue(LeoCodeHighlightPacing.isFresh(requestedAt: 10, now: 10.999))
        XCTAssertTrue(LeoCodeHighlightPacing.isFresh(requestedAt: 10, now: 11))
        XCTAssertFalse(LeoCodeHighlightPacing.isFresh(requestedAt: 10, now: 11.001))
        XCTAssertFalse(LeoCodeHighlightPacing.isFresh(requestedAt: 10, now: 30))
    }
}
