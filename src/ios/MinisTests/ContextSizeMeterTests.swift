import XCTest

/// [T-ctx-measure-outbound] ContextSizeMeter: estimation by character class,
/// calibration, overflow handling and warm-up fitting.
final class ContextSizeMeterTests: XCTestCase {

    // MARK: Estimation

    func testCJKIsNotReadAtAThird() {
        let cjk = String(repeating: "上下文压缩测试", count: 100)   // 700 CJK chars
        let old = Int(Double(cjk.count) / 3.5)
        let new = ContextSizeMeter.estimateTokens(cjk)
        XCTAssertEqual(new, 700, "one token per CJK scalar")
        XCTAssertGreaterThan(new, old * 3, "the old chars/3.5 read CJK at under a third")
    }

    func testEnglishAndDigitsByClass() {
        XCTAssertEqual(ContextSizeMeter.estimateTokens("abcdefghi"), 2)        // 9 / 4.5
        XCTAssertEqual(ContextSizeMeter.estimateTokens("1234"), 2)             // 4 / 2
        XCTAssertEqual(ContextSizeMeter.estimateTokens(""), 0)
    }

    func testReasoningContentIsCounted() {
        let plain = AgentMessage(role: .assistant, parts: [.text("ok")])
        var thinking = plain
        thinking.reasoningContent = String(repeating: "思", count: 500)
        XCTAssertEqual(ContextSizeMeter.estimateTokens(message: thinking)
                       - ContextSizeMeter.estimateTokens(message: plain), 500)
    }

    func testCacheKeyFollowsContentShape() {
        var msg = AgentMessage(role: .assistant, parts: [.text("hello")], reasoningContent: String(repeating: "x", count: 900),
                               dbMessageId: "db-shape-1")
        let full = ContextSizeMeter.estimateTokens(message: msg)
        msg.reasoningContent = ""
        let trimmed = ContextSizeMeter.estimateTokens(message: msg)
        XCTAssertLessThan(trimmed, full, "same id, different content must not hit the stale cache entry")
    }

    func testFixedTokensIncludeToolsAndSystemPrompt() {
        let tool = AgentToolDefinition(name: "file_read", description: "Read a file",
                                       parameters: ["path": AgentToolParam(type: .string, description: "Path")],
                                       required: ["path"])
        let withTools = ContextSizeMeter.estimateFixedTokens(systemPrompt: "You are helpful.", tools: [tool])
        let without = ContextSizeMeter.estimateFixedTokens(systemPrompt: "You are helpful.", tools: [])
        XCTAssertGreaterThan(withTools, without)
        XCTAssertGreaterThan(without, 0)
    }

    func testUnreadableImageFallsBackTo1000() {
        XCTAssertEqual(ContextSizeMeter.imageTokens(Data([0, 1, 2, 3])), 1_000)
    }

    // MARK: Calibration

    func testCalibrationRatioClamped() {
        XCTAssertEqual(ContextSizeMeter.calibrationRatio(reported: 1_000, estimated: 10_000), 0.8)
        XCTAssertEqual(ContextSizeMeter.calibrationRatio(reported: 100_000, estimated: 1_000), 3.0)
        XCTAssertEqual(ContextSizeMeter.calibrationRatio(reported: 1_500, estimated: 1_000), 1.5)
        XCTAssertNil(ContextSizeMeter.calibrationRatio(reported: 0, estimated: 1_000))
    }

    func testSmoothingRisesAtOnceFallsSlowly() {
        XCTAssertEqual(ContextSizeMeter.smoothed(previous: 1.2, sample: 1.8), 1.8)
        XCTAssertEqual(ContextSizeMeter.smoothed(previous: 2.0, sample: 1.0), 1.7, accuracy: 1e-9)
        XCTAssertEqual(ContextSizeMeter.smoothed(previous: nil, sample: 1.3), 1.3)
    }

    func testBorrowedRatioGetsMargin() {
        XCTAssertEqual(ContextSizeMeter.ratio(for: "a", known: ["a": 1.4], lastLearned: 2.0), 1.4)
        XCTAssertEqual(ContextSizeMeter.ratio(for: "b", known: ["a": 1.4], lastLearned: 1.5), 1.8, accuracy: 1e-9)
        XCTAssertEqual(ContextSizeMeter.ratio(for: "b", known: [:], lastLearned: nil), 1.0)
        XCTAssertEqual(ContextSizeMeter.ratio(for: "b", known: [:], lastLearned: 2.9), 3.0, "capped")
    }

    func testReplayReproducesSmoothedRatioPerModel() {
        let samples: [ContextSizeMeter.CalibrationSample] = [
            .init(reported: 2_000, estimated: 1_000, fixedTokens: 300, modelId: "m"),
            .init(reported: 1_000, estimated: 1_000, fixedTokens: 310, modelId: "m"),
            .init(reported: 1_200, estimated: 1_000, fixedTokens: 320, modelId: nil),
            .init(reported: 0, estimated: 1_000, fixedTokens: 999, modelId: "m"),
        ]
        let state = ContextSizeMeter.replayCalibration(samples)
        XCTAssertEqual(state.ratios["m"]!, 1.7, accuracy: 1e-9)
        XCTAssertEqual(state.lastLearned!, 1.2, accuracy: 1e-9)
        XCTAssertEqual(state.fixedTokens, 320)
        XCTAssertEqual(state.samples, 3)
    }

    func testReloadKeepsInMemoryRatios() {
        let fromTranscript = ContextSizeMeter.CalibrationState(ratios: ["m": 1.3, "n": 1.1], lastLearned: 1.1, fixedTokens: 100)
        let inMemory = ContextSizeMeter.CalibrationState(ratios: ["m": 1.97], lastLearned: 1.97, fixedTokens: 0)
        let merged = fromTranscript.carryingOver(inMemory)
        XCTAssertEqual(merged.ratios["m"], 1.97, "a rejection-raised ratio survives a reload of the same session")
        XCTAssertEqual(merged.ratios["n"], 1.1)
        XCTAssertEqual(merged.fixedTokens, 100)
    }

    // MARK: Overflow

    func testOverflowDetection() {
        XCTAssertTrue(ContextSizeMeter.isContextOverflow("[400] This model's maximum context length is 131072 tokens"))
        XCTAssertTrue(ContextSizeMeter.isContextOverflow("[context_length_exceeded] Your input exceeds the context window"))
        XCTAssertTrue(ContextSizeMeter.isContextOverflow("请求内容过长"))
        XCTAssertFalse(ContextSizeMeter.isContextOverflow("[429] too many tokens per minute"))
        XCTAssertFalse(ContextSizeMeter.isContextOverflow("[413] Request exceeds the maximum allowed number of bytes"))
        XCTAssertFalse(ContextSizeMeter.isContextOverflow("[500] internal error"))
    }

    func testRatioAfterOverflowUsesStatedCount() {
        let n = ContextSizeMeter.requestedTokens(inOverflowMessage: "maximum context length is 128,000 tokens. However, you requested 150,000 tokens")
        XCTAssertEqual(n, 150_000)
        let raised = ContextSizeMeter.ratioAfterOverflow(current: 1.0, estimated: 100_000, requested: n, window: 128_000)
        XCTAssertEqual(raised, 1.5, accuracy: 1e-9)
        // An implausible number (a request id) is ignored: just over the window.
        let fallback = ContextSizeMeter.ratioAfterOverflow(current: 1.0, estimated: 100_000, requested: 99_999_999, window: 128_000)
        XCTAssertEqual(fallback, 1.3056, accuracy: 1e-4)
        // Never lowers the ratio.
        XCTAssertEqual(ContextSizeMeter.ratioAfterOverflow(current: 2.5, estimated: 100_000, requested: n, window: 128_000), 2.5)
    }

    // MARK: Warm-up fit

    func testWarmUpDropKeepsWholeTurns() {
        // turn A = [user, assistant, toolResult-user], turn B = [user, assistant]
        let sizes = [10, 50, 40, 10, 20]
        let starts = [true, false, false, true, false]
        XCTAssertEqual(ContextSizeMeter.warmUpDrop(sizes: sizes, startsTurn: starts, restTokens: 100, budget: 1_000), 0)
        XCTAssertEqual(ContextSizeMeter.warmUpDrop(sizes: sizes, startsTurn: starts, restTokens: 100, budget: 150), 3,
                       "drops all of turn A, never splitting a call from its result")
        XCTAssertEqual(ContextSizeMeter.warmUpDrop(sizes: sizes, startsTurn: starts, restTokens: 100, budget: 50), 5)
    }
}
