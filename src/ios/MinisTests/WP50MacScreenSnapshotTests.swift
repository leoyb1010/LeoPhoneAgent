import XCTest

/// WP-50 R0:看 Mac 屏幕的线格式、错误指引、轮询节奏、手表转发(契约 src/mac/leophone/docs/specs/leo-screen.md)。
final class WP50MacScreenSnapshotTests: XCTestCase {
    typealias W = MacScreenSnapshotWire

    func testRequestPathClampsAndCarriesEtagAsQuery() throws {
        let path = W.requestPath(maxEdge: 9999, quality: 0.1, display: "2", etag: "\"abc\"")
        XCTAssertTrue(path.hasPrefix("/screen/snapshot?"))
        let items = try XCTUnwrap(URLComponents(string: path)?.queryItems)
        let q = Dictionary(uniqueKeysWithValues: items.map { ($0.name, $0.value ?? "") })
        XCTAssertEqual(q["max_edge"], "2560")
        XCTAssertEqual(q["q"], "0.30")
        XCTAssertEqual(q["display"], "2")
        XCTAssertEqual(q["if_none_match"], "\"abc\"", "relay does not forward If-None-Match, so the query carries it")
        XCTAssertFalse(path.contains("\""), "quotes must be percent-encoded")
        XCTAssertFalse(W.requestPath(display: "1; rm").contains("display="), "display ids are digits only")
        XCTAssertFalse(W.requestPath().contains("if_none_match"))
    }

    func testDirectBinaryFrameAnd304() {
        let jpeg = Data([0xFF, 0xD8, 0xFF, 0xD9])
        let ok = W.parse(status: 200, headers: ["Content-Type": "image/jpeg", "ETag": "\"e1\"",
                                                "X-Leo-Screen-Width": "1280", "X-Leo-Screen-Height": "800",
                                                "X-Leo-Screen-Display": "1", "X-Leo-Screen-Captured-At": "1792213314960"],
                         data: jpeg)
        XCTAssertEqual(ok, .frame(MacScreenFrame(jpeg: jpeg, etag: "\"e1\"", width: 1280, height: 800,
                                                 displayId: "1", capturedAtMs: 1792213314960)))
        XCTAssertEqual(W.parse(status: 304, headers: ["etag": "\"e1\""], data: Data()), .notModified(etag: "\"e1\""))
    }

    func testRelayJSONFrameAndNotModified() {
        let jpeg = Data([0xFF, 0xD8, 0x01, 0xFF, 0xD9])
        let body = #"{"etag":"\"e2\"","content_type":"image/jpeg","width":640,"height":400,"display_id":"1","captured_at":1792213314960,"bytes":5,"data_base64":"\#(jpeg.base64EncodedString())"}"#
        guard case .frame(let frame) = W.parse(status: 200, headers: ["content-type": "application/json"], data: Data(body.utf8)) else {
            return XCTFail("expected a frame")
        }
        XCTAssertEqual(frame.jpeg, jpeg); XCTAssertEqual(frame.etag, "\"e2\""); XCTAssertEqual(frame.width, 640)
        let unchanged = Data(#"{"etag":"\"e2\"","not_modified":true}"#.utf8)
        XCTAssertEqual(W.parse(status: 200, headers: [:], data: unchanged), .notModified(etag: "\"e2\""))
        guard case .failure = W.parse(status: 200, headers: [:], data: Data(#"{"etag":"x"}"#.utf8)) else {
            return XCTFail("a frame without data is malformed")
        }
    }

    func testErrorCodesMapToGuidanceAndPolling() {
        func err(_ status: Int, _ code: String, retry: Int? = nil) -> MacScreenError {
            var body = #"{"error":{"message":"m","code":"\#(code)"}"#
            if let retry { body += #","retry_after_ms":\#(retry)"# }
            body += "}"
            guard case .failure(let e) = W.parse(status: status, headers: [:], data: Data(body.utf8)) else {
                XCTFail("expected failure"); return MacScreenError(status: 0, code: "")
            }
            return e
        }
        let disabled = err(403, "screen_disabled")
        XCTAssertTrue(disabled.guidance.contains("允许手机查看屏幕")); XCTAssertTrue(disabled.needsUser)
        XCTAssertNil(MacScreenPollPolicy.nextDelay(after: .failure(disabled), consecutiveFailures: 1), "stop and wait for 重试")
        XCTAssertTrue(err(403, "screen_scope_required").guidance.contains("重新扫码配对"))
        let permission = err(428, "screen_permission")
        XCTAssertTrue(permission.guidance.contains("屏幕录制")); XCTAssertFalse(permission.needsUser)
        XCTAssertEqual(MacScreenPollPolicy.nextDelay(after: .failure(permission), consecutiveFailures: 3), 5)
        let limited = err(429, "rate_limited", retry: 2400)
        XCTAssertEqual(limited.retryAfterMs, 2400)
        XCTAssertEqual(MacScreenPollPolicy.nextDelay(after: .failure(limited), consecutiveFailures: 1), 2.4)
        // Old Mac without the endpoint: plain 404 → not_supported, stop.
        let old = W.error(status: 404, data: Data("Not Found".utf8))
        XCTAssertEqual(old.code, "not_supported"); XCTAssertTrue(old.needsUser)
        XCTAssertEqual(W.error(status: 404, data: Data(#"{"error":{"code":"display_not_found"}}"#.utf8)).code, "display_not_found")
    }

    func testPollingCadenceAndBackoff() {
        let frame = MacScreenSnapshotWire.Result.notModified(etag: "x")
        XCTAssertEqual(MacScreenPollPolicy.nextDelay(after: frame, consecutiveFailures: 0), 1.5)
        let offline = MacScreenSnapshotWire.Result.failure(MacScreenError(status: 0, code: "offline"))
        XCTAssertEqual(MacScreenPollPolicy.nextDelay(after: offline, consecutiveFailures: 1), 1.5)
        XCTAssertEqual(MacScreenPollPolicy.nextDelay(after: offline, consecutiveFailures: 2), 3)
        XCTAssertEqual(MacScreenPollPolicy.nextDelay(after: offline, consecutiveFailures: 9), 10)
        XCTAssertGreaterThanOrEqual(MacScreenPollPolicy.minimumInterval, 1.0, "relay allows 1 fps per device")
        let big = MacScreenError(status: 413, code: "frame_too_large")
        XCTAssertEqual(MacScreenPollPolicy.reducedEdge(after: big, current: 1280), 960)
        XCTAssertEqual(MacScreenPollPolicy.reducedEdge(after: big, current: 400), 320)
        XCTAssertNil(MacScreenPollPolicy.reducedEdge(after: big, current: 320))
    }

    func testWatchRelayRoundTrip() {
        XCTAssertEqual(MacScreenWatchRelay.request(etag: nil)["kind"] as? String, "screenThumb")
        let jpeg = Data([1, 2, 3])
        let frame = MacScreenFrame(jpeg: jpeg, etag: "\"t\"")
        XCTAssertEqual(MacScreenWatchRelay.decode(MacScreenWatchRelay.reply(.frame(frame), host: "mini")),
                       .image(jpeg, etag: "\"t\""))
        XCTAssertEqual(MacScreenWatchRelay.decode(MacScreenWatchRelay.reply(.notModified(etag: "\"t\""), host: nil)), .unchanged)
        let failed = MacScreenWatchRelay.decode(MacScreenWatchRelay.reply(.failure(MacScreenError(status: 428, code: "screen_permission")), host: nil))
        guard case .failed(let text) = failed else { return XCTFail() }
        XCTAssertTrue(text.contains("屏幕录制"))
        XCTAssertLessThanOrEqual(MacScreenSnapshotWire.watchMaxEdge, 400)
    }

    func testDirectRouteAllowsScreenPath() throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
        let routing = try String(contentsOf: root.appendingPathComponent("Agent/Gateway/LeoAgentRouting.swift"), encoding: .utf8)
        XCTAssertTrue(routing.contains(#"relative.hasPrefix("/screen/")"#), "看屏 must try the direct route first")
        let views = try String(contentsOf: root.appendingPathComponent("Views/Settings/MacScreenViews.swift"), encoding: .utf8)
        XCTAssertTrue(views.contains("scenePhase == .active"), "poll only in the foreground")
        XCTAssertTrue(views.contains("onTapGesture(count: 2)"), "double tap resets zoom")
    }
}
