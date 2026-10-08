import XCTest

/// [T-fallback-503-budget] Ported from upstream. A provider answering HTTP 503
/// (`no_available_workers`) means THIS deployment has no capacity — another group member
/// probably does. The full 3/5/10/15/30s ladder (63s) on the same model read as
/// "fallback never happened". Pinned split:
///   - a 5xx the SERVER produced, with a fallback target → short budget (2s + 5s);
///   - every statusless transient (dropped link, DNS, TTFB stall, empty response) → full ladder;
///   - no fallback target → full ladder.
/// [Leo port] The budget choice lives in `LLMRetryPolicy.delays` (pure, test target).
final class Fallback503BudgetTests: XCTestCase {

    private let full = [3, 5, 10, 15, 30]

    func testHTTP503IsServerCapacityTransient() {
        let e = LLMError.transientError(message: "HTTP 503: no_available_workers", statusCode: 503)
        XCTAssertEqual(e.httpStatusCode, 503)
        XCTAssertTrue(e.isServerCapacityTransient)
        XCTAssertTrue(e.isRetryable)
        XCTAssertFalse(e.isFallbackable)
    }

    func testOther5xxAlsoCountAsServerCapacity() {
        for code in [500, 502, 504, 529] {
            XCTAssertTrue(LLMError.transientError(message: "HTTP \(code)", statusCode: code).isServerCapacityTransient)
        }
    }

    func testStatuslessTransientsAreNotServerCapacity() {
        for e in [LLMError.transientError(message: "No response from the server for 120s"),
                  .transientError(message: "Server returned an empty response")] {
            XCTAssertNil(e.httpStatusCode)
            XCTAssertFalse(e.isServerCapacityTransient)
        }
    }

    /// A body that merely mentions a number must not be mistaken for a status.
    func testBodyTextIsNeverParsedAsAStatusCode() {
        let e = LLMError.transientError(message: "Server returned an empty response after 5030 tokens")
        XCTAssertNil(e.httpStatusCode)
        XCTAssertFalse(e.isServerCapacityTransient)
    }

    func testNonTransientErrorsHaveNoStatusCode() {
        XCTAssertNil(LLMError.rateLimited.httpStatusCode)
        XCTAssertFalse(LLMError.providerError(message: "[503] upstream").isServerCapacityTransient)
        XCTAssertFalse(LLMError.networkError(underlying: URLError(.notConnectedToInternet)).isServerCapacityTransient)
    }

    func testHTTP503WithFallbackTargetGetsTheShortBudget() {
        let e = LLMError.transientError(message: "HTTP 503: no_available_workers", statusCode: 503)
        let delays = LLMRetryPolicy.delays(for: e, hasFallbackTarget: true, full: full)
        XCTAssertEqual(delays, [2, 5])
        XCTAssertLessThan(delays.reduce(0, +), full.reduce(0, +))
    }

    func testStatuslessTransientKeepsTheFullLadder() {
        let e = LLMError.transientError(message: "No response from the server for 120s")
        XCTAssertEqual(LLMRetryPolicy.delays(for: e, hasFallbackTarget: true, full: full), full)
        XCTAssertEqual(LLMRetryPolicy.delays(for: LLMError.networkError(underlying: URLError(.timedOut)),
                                             hasFallbackTarget: true, full: full), full)
    }

    func testHTTP503WithoutFallbackTargetKeepsTheFullLadder() {
        let e = LLMError.transientError(message: "HTTP 503", statusCode: 503)
        XCTAssertEqual(LLMRetryPolicy.delays(for: e, hasFallbackTarget: false, full: full), full)
    }

    /// User-visible text is unchanged; the status rides alongside the message.
    func testMappedTransientKeepsItsMessageAndGainsTheStatus() {
        let body = "{\"error\":{\"message\":\"no_available_workers\"}}"
        let mapped = LLMError.transientError(message: "HTTP 503: \(body)", statusCode: 503)
        XCTAssertEqual(mapped.errorDescription, "Service temporarily unavailable: HTTP 503: \(body)")
        XCTAssertEqual(mapped.networkFailure, .server(status: 503))
    }
}
