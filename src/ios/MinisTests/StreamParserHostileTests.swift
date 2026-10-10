import XCTest

/// [T-r3-stream-hardening] Plan §2.3 B1–B4 and the stream P2s. Raw SSE lines
/// are pushed through the same framing / classification / accumulation code
/// the provider parsers call (`Providers/StreamHardening.swift`); the small
/// `feedChatCompletions` harness mirrors the Chat Completions loop line by line.
final class StreamParserHostileTests: XCTestCase {

    private func isTransient(_ error: LLMError?, status: Int? = nil) -> Bool {
        guard case .transientError(_, let code)? = error else { return false }
        if let status { return code == status }
        return true
    }

    // MARK: - B1 error events

    func testAnthropicErrorEventThrowsTransient() {
        let lines = [
            "event: error",
            #"data: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}"#,
        ]
        XCTAssertEqual(SSEFraming.eventName(fromLine: lines[0]), "error")
        let err = StreamErrorClassifier.anthropicErrorEvent(fromLine: lines[1])
        XCTAssertTrue(isTransient(err, status: 529), "overloaded mid-stream must auto-retry, not end the turn")
        XCTAssertEqual(err?.isRetryable, true)
        XCTAssertTrue(isTransient(StreamErrorClassifier.anthropic(type: "api_error", message: "boom"), status: 500))
        if case .rateLimited = StreamErrorClassifier.anthropic(type: "rate_limit_error", message: "slow") {} else {
            XCTFail("rate_limit_error maps to .rateLimited")
        }
        if case .providerError = StreamErrorClassifier.anthropic(type: "invalid_request_error", message: "bad") {} else {
            XCTFail("a request error is not retried")
        }
        // Ordinary events are not errors.
        XCTAssertNil(StreamErrorClassifier.anthropicErrorEvent(
            fromLine: #"data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}"#))
    }

    func testResponsesErrorEventThrows() {
        let topLevel = SSEFraming.jsonObject(fromLine: #"data: {"type":"error","code":"server_error","message":"The server had an error"}"#)!
        XCTAssertTrue(isTransient(StreamErrorClassifier.responsesErrorEvent(topLevel), status: 500))
        let nested = SSEFraming.jsonObject(fromLine: #"data: {"type":"response.error","error":{"type":"overloaded","message":"busy"}}"#)!
        XCTAssertTrue(isTransient(StreamErrorClassifier.responsesErrorEvent(nested), status: 529))
        let rate = SSEFraming.jsonObject(fromLine: #"data: {"type":"error","error":{"code":"rate_limit_exceeded","message":"slow down"}}"#)!
        if case .rateLimited? = StreamErrorClassifier.responsesErrorEvent(rate) {} else { XCTFail("rate limit maps to .rateLimited") }
        let delta = SSEFraming.jsonObject(fromLine: #"data: {"type":"response.output_text.delta","delta":"x"}"#)!
        XCTAssertNil(StreamErrorClassifier.responsesErrorEvent(delta))
    }

    func testChatCompletionsAndGeminiErrorObjects() {
        let chat = SSEFraming.jsonObject(fromLine: #"data: {"error":{"message":"upstream","code":502}}"#)!
        XCTAssertTrue(isTransient(StreamErrorClassifier.topLevelError(chat), status: 502))
        let gemini = SSEFraming.jsonObject(fromLine: #"data:{"error":{"code":503,"message":"The model is overloaded.","status":"UNAVAILABLE"}}"#)!
        XCTAssertTrue(isTransient(StreamErrorClassifier.topLevelError(gemini), status: 503))
        let auth = SSEFraming.jsonObject(fromLine: #"data: {"error":{"code":401,"message":"no"}}"#)!
        if case .invalidAPIKey? = StreamErrorClassifier.topLevelError(auth) {} else { XCTFail("401 → invalid key") }
        let normal = SSEFraming.jsonObject(fromLine: #"data: {"choices":[{"delta":{"content":"hi"}}]}"#)!
        XCTAssertNil(StreamErrorClassifier.topLevelError(normal))
    }

    // MARK: - Framing

    func testDataLineWithoutSpaceBOMAndCRAreAccepted() {
        XCTAssertEqual(SSEFraming.payload(fromLine: #"data:{"a":1}"#), #"{"a":1}"#)
        XCTAssertEqual(SSEFraming.payload(fromLine: #"data: {"a":1}"#), #"{"a":1}"#)
        XCTAssertEqual(SSEFraming.payload(fromLine: "\u{FEFF}data: {\"a\":1}"), #"{"a":1}"#, "BOM on the first line")
        XCTAssertEqual(SSEFraming.payload(fromLine: "data: {\"a\":1}\r"), #"{"a":1}"#)
        XCTAssertNil(SSEFraming.payload(fromLine: ": keep-alive"))
        XCTAssertNil(SSEFraming.payload(fromLine: "event: message_start"))
        XCTAssertNil(SSEFraming.jsonObject(fromLine: "data: [DONE]"))
        XCTAssertEqual(SSEFraming.eventName(fromLine: "\u{FEFF}event: ping"), "ping")
    }

    // MARK: - B2 tool arguments

    func testLargeToolArgsAccumulateLinearly() {
        // 5 MB of arguments in 20-byte deltas: the old `json += delta` + whole
        // string yield per delta was O(n²) and ran for minutes.
        let delta = String(repeating: "a", count: 20)
        let count = 5 * 1_048_576 / 20
        var acc = StreamToolArgsAccumulator()
        var snapshots = 0
        let clock = Date(timeIntervalSince1970: 0)
        let start = CFAbsoluteTimeGetCurrent()
        for i in 0..<count {
            // Simulated clock: one delta per millisecond.
            if acc.append(delta, now: clock.addingTimeInterval(Double(i) / 1000)) {
                snapshots += 1
                _ = acc.joined()
            }
        }
        let elapsed = CFAbsoluteTimeGetCurrent() - start
        XCTAssertLessThan(elapsed, 3.0, "accumulating 5 MB must be linear (took \(elapsed)s)")
        XCTAssertTrue(acc.overLimit)
        let args = acc.finalArgs(toolName: "file_write")
        let message = args[StreamToolArgsAccumulator.oversizeSentinelKey] as? String
        XCTAssertNotNil(message, "an oversized call completes as a readable error")
        XCTAssertNotNil(AIChatViewModel.preflightValidateToolCall(name: "file_write", args: args, tools: []),
                        "preflight turns the sentinel into a tool error even for unknown tools")
        XCTAssertLessThan(snapshots, count / 50, "progress snapshots are throttled, not per delta")
    }

    func testNormalToolArgsStillParse() {
        var acc = StreamToolArgsAccumulator()
        for piece in [#"{"pa"#, #"th":"/var/mi"#, #"nis/a.txt","con"#, #"tent":"héllo"}"#] {
            _ = acc.append(piece)
        }
        let args = acc.finalArgs(toolName: "file_write")
        XCTAssertEqual(args["path"] as? String, "/var/minis/a.txt")
        XCTAssertEqual(args["content"] as? String, "héllo")
        XCTAssertNil(AIChatViewModel.preflightValidateToolCall(name: "file_write", args: args, tools: []))
    }

    /// Mirrors the Chat Completions loop: SSE line → JSON → tool_call deltas
    /// into the table → drain on finish_reason.
    private func feedChatCompletions(_ lines: [String]) -> [(id: String, name: String, args: [String: Any], raw: String)] {
        var table = OpenAIToolCallTable()
        var completed: [(id: String, name: String, args: [String: Any], raw: String)] = []
        for line in lines {
            guard let event = SSEFraming.jsonObject(fromLine: line),
                  let choice = (event["choices"] as? [[String: Any]])?.first else { continue }
            let delta = choice["delta"] as? [String: Any] ?? [:]
            for tc in (delta["tool_calls"] as? [[String: Any]]) ?? [] {
                guard let index = tc["index"] as? Int else { continue }
                let fn = tc["function"] as? [String: Any] ?? [:]
                if let id = tc["id"] as? String, !id.isEmpty, let name = fn["name"] as? String, !name.isEmpty {
                    _ = table.start(index: index, id: id, name: name)
                }
                if let arg = fn["arguments"] as? String { _ = table.appendArguments(index: index, delta: arg) }
            }
            if let fr = choice["finish_reason"] as? String, !fr.isEmpty { completed += table.drain() }
        }
        return completed
    }

    func testSameIndexSecondToolCallDoesNotOrphanFirst() {
        let lines = [
            #"data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_a","function":{"name":"file_read","arguments":"{\"path\":"}}]}}]}"#,
            #"data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\"/a\"}"}}]}}]}"#,
            // A second call reusing index 0 (seen on some gateways).
            #"data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_b","function":{"name":"file_read","arguments":"{\"path\":\"/b\"}"}}]}}]}"#,
            // DeepSeek-style empty id/name on a continuation chunk must not start a call.
            #"data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"","function":{"name":"","arguments":""}}]}}]}"#,
            #"data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}"#,
            "data: [DONE]",
        ]
        let calls = feedChatCompletions(lines)
        XCTAssertEqual(calls.map(\.id), ["call_a", "call_b"])
        XCTAssertEqual(calls[0].args["path"] as? String, "/a", "the first call keeps its arguments")
        XCTAssertEqual(calls[1].args["path"] as? String, "/b")
    }

    func testParallelToolCallsByIndexKeepArrivalOrder() {
        let lines = [
            #"data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"x","function":{"name":"a","arguments":"{}"}},{"index":1,"id":"y","function":{"name":"b","arguments":"{\"k\":1}"}}]}}]}"#,
            #"data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}"#,
        ]
        let calls = feedChatCompletions(lines)
        XCTAssertEqual(calls.map(\.name), ["a", "b"])
        XCTAssertEqual(calls[1].args["k"] as? Int, 1)
    }

    // MARK: - B3 tool names

    func testInvalidToolNameSanitizedOnReplay() {
        XCTAssertEqual(ToolNameSanitizer.sanitize("foo bar"), "foo_bar")
        XCTAssertEqual(ToolNameSanitizer.sanitize("shell_execute"), "shell_execute")
        XCTAssertEqual(ToolNameSanitizer.sanitize("mcp-server-tool_1"), "mcp-server-tool_1")
        XCTAssertEqual(ToolNameSanitizer.sanitize("读取 文件"), "_____")
        XCTAssertEqual(ToolNameSanitizer.sanitize("a.b/c:d"), "a_b_c_d")
        XCTAssertEqual(ToolNameSanitizer.sanitize(""), "tool")
        XCTAssertEqual(ToolNameSanitizer.sanitize(String(repeating: "x", count: 500)).count, 64)
        let valid = try! NSRegularExpression(pattern: "^[A-Za-z0-9_-]{1,64}$")
        for name in ["🔥🔥", "a b c", String(repeating: "é", count: 100), "\u{0}x"] {
            let s = ToolNameSanitizer.sanitize(name)
            XCTAssertEqual(valid.numberOfMatches(in: s, range: NSRange(location: 0, length: (s as NSString).length)), 1, name)
        }
    }

    // MARK: - B4 streamed text

    func testHundredKDeltasStaysLinear() {
        var budget = StreamTextBudget()
        var crossings = 0
        let delta = "word "
        let start = CFAbsoluteTimeGetCurrent()
        for _ in 0..<100_000 where budget.add(delta) { crossings += 1 }
        XCTAssertLessThan(CFAbsoluteTimeGetCurrent() - start, 1.0)
        XCTAssertEqual(budget.utf8Count, 500_000)
        XCTAssertEqual(crossings, 0)

        // Past 2 MB the turn ends exactly once.
        var big = StreamTextBudget()
        let chunk = String(repeating: "数", count: 10_000) // 30 KB per delta
        var firedAt: Int?
        for i in 0..<200 where big.add(chunk) {
            XCTAssertNil(firedAt, "fires once")
            firedAt = i
        }
        XCTAssertNotNil(firedAt)
        XCTAssertTrue(big.exceeded)
        XCTAssertEqual(firedAt, StreamTextBudget.maxBytes / 30_000)
    }

    // MARK: - Usage / stop reason

    func testUsageTokenCountsAreClamped() throws {
        let usage = try XCTUnwrap(SSEFraming.jsonObject(fromLine:
            #"data: {"usage":{"prompt_tokens":9223372036854775807,"completion_tokens":1e30,"cached":-4}}"#)?["usage"] as? [String: Any])
        let input = try XCTUnwrap(UsageTokenClamp.value(usage["prompt_tokens"]))
        let output = try XCTUnwrap(UsageTokenClamp.value(usage["completion_tokens"]))
        XCTAssertEqual(input, UsageTokenClamp.maxTokens)
        XCTAssertEqual(output, UsageTokenClamp.maxTokens)
        XCTAssertEqual(UsageTokenClamp.value(usage["cached"]), 0)
        // The sum TokenUsage computes can no longer overflow.
        let (sum, overflow) = input.addingReportingOverflow(output)
        XCTAssertFalse(overflow)
        XCTAssertEqual(sum, 2 * UsageTokenClamp.maxTokens)
        XCTAssertEqual(UsageTokenClamp.clamp(Int.max), UsageTokenClamp.maxTokens)
        XCTAssertNil(UsageTokenClamp.clamp(nil as Int?))
    }

    func testDuplicateDoneDoesNotOverwriteMaxTokens() {
        enum Stop { case endTurn, maxTokens }
        var gate = StreamStopReasonGate<Stop>()
        XCTAssertTrue(gate.record(.maxTokens))   // Gemini finishReason MAX_TOKENS
        XCTAssertFalse(gate.record(.endTurn))    // trailing end-of-body .done
        XCTAssertEqual(gate.reason, .maxTokens)
    }
}
