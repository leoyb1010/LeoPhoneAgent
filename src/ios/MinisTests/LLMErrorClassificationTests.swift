import XCTest

/// [B2][B3][B4] 错误分类、重试等待策略、重试成功后保留失败原因。
final class LLMErrorClassificationTests: XCTestCase {
    private func network(_ code: URLError.Code) -> LLMError { .networkError(underlying: URLError(code)) }

    func testURLErrorCodesAreClassified() {
        XCTAssertEqual(network(.networkConnectionLost).networkFailure, .connectionLost)
        XCTAssertEqual(network(.notConnectedToInternet).networkFailure, .notConnected)
        XCTAssertEqual(network(.dataNotAllowed).networkFailure, .notConnected)
        XCTAssertEqual(network(.timedOut).networkFailure, .timedOut)
        XCTAssertEqual(network(.cancelled).networkFailure, .cancelled)
        XCTAssertEqual(network(.cannotFindHost).networkFailure, .other)
        XCTAssertEqual(LLMError.transientError(message: "HTTP 503: busy").networkFailure, .server(status: 503))
        XCTAssertEqual(LLMError.transientError(message: "Gemini API error 502: x").networkFailure, .server(status: 502))
        XCTAssertEqual(LLMError.transientError(message: "overloaded").networkFailure, .server(status: 0))
        XCTAssertEqual(LLMError.cancelled.networkFailure, .cancelled)
        XCTAssertNil(LLMError.rateLimited.networkFailure)
    }

    func testConnectionLostRetriesImmediatelyOnlyOnce() {
        let delays = [3, 5, 10, 15, 30]
        XCTAssertEqual(LLMRetryPolicy.wait(after: .connectionLost, attempt: 1, immediateUsed: false, delays: delays), .immediate)
        XCTAssertEqual(LLMRetryPolicy.wait(after: .connectionLost, attempt: 1, immediateUsed: true, delays: delays), .countdown(seconds: 3))
    }

    func testNotConnectedWaitsForNetworkInsteadOfCountdown() {
        XCTAssertEqual(LLMRetryPolicy.wait(after: .notConnected, attempt: 2, immediateUsed: false, delays: [3, 5]),
                       .untilNetwork(maxSeconds: LLMRetryPolicy.networkWaitLimit))
    }

    func testOtherFailuresUseCountdownSchedule() {
        let delays = [3, 5, 10, 15, 30]
        XCTAssertEqual(LLMRetryPolicy.wait(after: .timedOut, attempt: 1, immediateUsed: false, delays: delays), .countdown(seconds: 3))
        XCTAssertEqual(LLMRetryPolicy.wait(after: .server(status: 503), attempt: 3, immediateUsed: false, delays: delays), .countdown(seconds: 10))
        XCTAssertEqual(LLMRetryPolicy.wait(after: nil, attempt: 9, immediateUsed: false, delays: delays), .countdown(seconds: 30))
    }

    func testRecoveredErrorSurvivesSuccessfulRetry() {
        // 模拟:一次 networkError → 倒计时期间 error 显示原因 → 重试前清空 → 成功。
        var error: String? = network(.networkConnectionLost).errorDescription
        var recovered: [String] = []
        LLMRetryPolicy.recover(error: &error, into: &recovered)
        XCTAssertNil(error)
        XCTAssertEqual(recovered.count, 1)
        XCTAssertEqual(LLMRetryPolicy.recoveredSummary(count: recovered.count), "中途断开 1 次,已自动恢复")
        var empty: String? = "  "
        LLMRetryPolicy.recover(error: &empty, into: &recovered)
        XCTAssertNil(empty)
        XCTAssertEqual(recovered.count, 1)
    }

    func testRecoveredErrorsAreCapped() {
        var recovered: [String] = []
        for index in 0..<15 {
            var error: String? = "e\(index)" + String(repeating: "x", count: 300)
            LLMRetryPolicy.recover(error: &error, into: &recovered)
        }
        XCTAssertEqual(recovered.count, LLMRetryPolicy.recoveredLimit)
        XCTAssertTrue(recovered.first?.hasPrefix("e5") == true)
        XCTAssertEqual(recovered.first?.count, 200)
    }

    func testReconnectingLabel() {
        XCTAssertEqual(LLMRetryPolicy.reconnectingLabel(attempt: 2), "重连中 · 第 2 次")
    }
}
