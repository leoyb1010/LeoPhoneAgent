import XCTest

/// Compaction hardening ported from upstream 1.12–1.14: user-cap thresholds,
/// window hard stop, in-loop decision table, summary watchdog and the split
/// retry classification.
final class CompactionHardeningTests: XCTestCase {

    // MARK: [T-ctx-user-cap]

    func testUserCapGetsProportionalThresholds() {
        let p = ContextPolicy(contextWindow: 32_000, isUserCap: true)
        XCTAssertEqual(p.offloadThreshold, 22_400)   // 70%
        XCTAssertEqual(p.offloadTarget, 17_600)      // 55%
        XCTAssertEqual(p.compactThreshold, 27_200)   // 85%
        XCTAssertFalse(p.exhaustedOnly, "a user cap is an instruction to compact, not to stop")
        XCTAssertTrue(p.manualCompactAllowed)
        XCTAssertEqual(p.check(estimatedTokens: 27_200, contextWindow: 32_000), .needsCompact)
        XCTAssertEqual(p.check(estimatedTokens: 27_199, contextWindow: 32_000), .ok)
    }

    func testNativeWindowKeepsTierTable() {
        XCTAssertEqual(ContextPolicy(contextWindow: 200_000).compactThreshold, 180_000)
        XCTAssertEqual(ContextPolicy(contextWindow: 200_000, isUserCap: false).compactThreshold, 180_000)
    }

    // MARK: [T-ctx-overflow-hard-stop]

    func testPastWindowNeverReadsOK() {
        // 32K–64K tier: exhausted-only with offload at window-10K; past 100% the
        // tier can still compact manually → needsCompact rather than ok.
        let mid = ContextPolicy(contextWindow: 48_000)
        XCTAssertEqual(mid.check(estimatedTokens: 48_000, contextWindow: 48_000), .needsCompact)
        // < 32K cannot compact at all → exhausted.
        let tiny = ContextPolicy(contextWindow: 16_000)
        XCTAssertEqual(tiny.check(estimatedTokens: 20_000, contextWindow: 16_000), .exhausted)
    }

    // MARK: In-loop decision table [T-ctx-measure-outbound]

    func testInLoopStep() {
        typealias P = ContextPolicy
        XCTAssertEqual(P.inLoopStep(verdict: .ok, measured: 1, rawTokens: 1, window: 10, canCompact: true, ratio: 1, uncalibratedSendUsed: false), .proceed)
        XCTAssertEqual(P.inLoopStep(verdict: .exhausted, measured: 1, rawTokens: 1, window: 10, canCompact: true, ratio: 1, uncalibratedSendUsed: false), .stop)
        XCTAssertEqual(P.inLoopStep(verdict: .needsCompact, measured: 95, rawTokens: 90, window: 100, canCompact: true, ratio: 1, uncalibratedSendUsed: false), .compact)
        // No progress / budget spent but still under the window → send, don't wedge.
        XCTAssertEqual(P.inLoopStep(verdict: .needsCompact, measured: 95, rawTokens: 90, window: 100, canCompact: false, ratio: 1, uncalibratedSendUsed: false), .sendWithinWindow)
        // Over the window only by the ratio → one real request.
        XCTAssertEqual(P.inLoopStep(verdict: .needsCompact, measured: 130, rawTokens: 90, window: 100, canCompact: false, ratio: 1.4, uncalibratedSendUsed: false), .sendUncalibratedOnce)
        XCTAssertEqual(P.inLoopStep(verdict: .needsCompact, measured: 130, rawTokens: 90, window: 100, canCompact: false, ratio: 1.4, uncalibratedSendUsed: true), .stop)
        XCTAssertEqual(P.inLoopStep(verdict: .needsCompact, measured: 130, rawTokens: 120, window: 100, canCompact: false, ratio: 1.1, uncalibratedSendUsed: false), .stop)
        // Unknown window never stops.
        XCTAssertEqual(P.inLoopStep(verdict: .needsCompact, measured: 1_000_000, rawTokens: 1, window: 0, canCompact: false, ratio: 1, uncalibratedSendUsed: true), .sendWithinWindow)
    }

    // MARK: Summary watchdog [T-ios-compact-no-timeout]

    func testWatchdogLimits() {
        XCTAssertEqual(AIChatViewModel.compactStallLimit, 120)
        XCTAssertEqual(AIChatViewModel.compactOverallLimit, 900)
    }

    func testStallBreachAfterSilence() async {
        let clock = TestClock()
        let p = CompactStreamProgress(overallLimit: 900, stallLimit: 120, now: { clock.now })
        clock.advance(119)
        let early = await p.breach()
        XCTAssertNil(early)
        clock.advance(2)
        let stalled = await p.breach()
        XCTAssertEqual(stalled, .stalled(121))
    }

    func testChunksResetStallButNotOverall() async {
        let clock = TestClock()
        let p = CompactStreamProgress(overallLimit: 900, stallLimit: 120, now: { clock.now })
        for _ in 0..<8 {   // a slow but live stream: a chunk every 100 s
            clock.advance(100)
            await p.touch()
            let b = await p.breach()
            XCTAssertNil(b)
        }
        clock.advance(101)   // 901 s total, last chunk 101 s ago (under the stall limit)
        let overall = await p.breach()
        XCTAssertEqual(overall, .overall(901), "a dribbling stream still ends at the wall-clock backstop")
    }

    func testBreachIsRecordedForTimeoutVersusStop() async {
        let p = CompactStreamProgress(overallLimit: 900, stallLimit: 120)
        let none = await p.breachReason()
        XCTAssertNil(none, "a user Stop has no recorded breach")
        await p.recordBreach(.stalled(120))
        let reason = await p.breachReason()
        XCTAssertEqual(reason, .stalled(120))
        XCTAssertFalse(CompactStreamTimeout(breach: .stalled(120)).localizedDescription.isEmpty)
    }

    // MARK: Split retry classification [T-compact-segment-retry-any-error]

    func testSegmentRetryClassification() {
        XCTAssertTrue(AIChatViewModel.isSegmentRetryableError(LLMError.providerError(message: "[400] context_length_exceeded")))
        XCTAssertTrue(AIChatViewModel.isSegmentRetryableError(LLMError.providerError(message: "some unknown wording")))
        XCTAssertTrue(AIChatViewModel.isSegmentRetryableError(NSError(domain: "Compact", code: -2)))
        XCTAssertFalse(AIChatViewModel.isSegmentRetryableError(CancellationError()))
        XCTAssertFalse(AIChatViewModel.isSegmentRetryableError(LLMError.rateLimited))
        XCTAssertFalse(AIChatViewModel.isSegmentRetryableError(LLMError.transientError(message: "x")))
        XCTAssertFalse(AIChatViewModel.isSegmentRetryableError(URLError(.notConnectedToInternet)))
        XCTAssertFalse(AIChatViewModel.isSegmentRetryableError(CompactStreamTimeout(breach: .overall(900))),
                       "halves inherit the same deadlines — splitting a timeout multiplies it")
    }
}

private final class TestClock: @unchecked Sendable {
    private let lock = NSLock()
    private var t = Date(timeIntervalSince1970: 1_000_000)
    var now: Date { lock.lock(); defer { lock.unlock() }; return t }
    func advance(_ s: TimeInterval) { lock.lock(); t += s; lock.unlock() }
}
