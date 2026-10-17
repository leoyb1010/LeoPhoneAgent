import XCTest

/// WP-51 R1 视频信令 / 视频-截图切换 / ICE 排序;WP-52 R2 输入事件、触控板、HID 键码、工具条。
final class WP51WP52ScreenSessionTests: XCTestCase {
    typealias W = ScreenSessionWire

    // MARK: WP-51 signalling

    func testPreflightAndOpenParsing() throws {
        let pre = W.parsePreflight(Data(#"{"ice_servers":[{"urls":["stun:mini:3478"]},{"urls":"turn:mini:3478?transport=udp","username":"1792:leobot","credential":"c"}],"tailnet_only":false,"control":true}"#.utf8))
        XCTAssertEqual(pre?.iceServers.count, 2)
        XCTAssertEqual(pre?.iceServers[1], ScreenICEServer(urls: ["turn:mini:3478?transport=udp"], username: "1792:leobot", credential: "c"))
        XCTAssertEqual(pre?.control, true)
        let opened = W.parseOpened(Data(#"{"session_id":"scr_1","answer":"v=0\r\n","ice_servers":[],"expires_at":1792217158000,"control":false,"tailnet_only":true}"#.utf8))
        XCTAssertEqual(opened?.sessionId, "scr_1"); XCTAssertEqual(opened?.control, false); XCTAssertEqual(opened?.tailnetOnly, true)
        XCTAssertNil(W.parseOpened(Data(#"{"session_id":"scr_1","answer":"nope"}"#.utf8)), "answer must be SDP")
    }

    func testOpenBodyClampsAndOnlyAsksForControlWhenWanted() throws {
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: W.openBody(offer: "v=0", control: false, display: "x1", maxFps: 120, maxEdge: 100)) as? [String: Any])
        XCTAssertEqual(body["max_fps"] as? Int, 60); XCTAssertEqual(body["max_edge"] as? Int, 640)
        XCTAssertNil(body["control"]); XCTAssertNil(body["display"], "display ids are digits")
        let control = try XCTUnwrap(JSONSerialization.jsonObject(with: W.openBody(offer: "v=0", control: true, display: "2")) as? [String: Any])
        XCTAssertEqual(control["control"] as? Bool, true); XCTAssertEqual(control["display"] as? String, "2")
        XCTAssertEqual(W.inputLabel, "leo-input")
    }

    func testCandidatesAreRankedTailnetFirstAndBatched() throws {
        let relay = W.Candidate(candidate: "candidate:1 1 udp 5 203.0.113.9 3478 typ relay raddr 0.0.0.0 rport 0", sdpMid: "0", sdpMLineIndex: 0)
        let lan = W.Candidate(candidate: "candidate:2 1 udp 9 192.168.1.20 5000 typ host", sdpMid: "0", sdpMLineIndex: 0)
        let tail = W.Candidate(candidate: "candidate:3 1 udp 9 100.81.83.56 5001 typ host", sdpMid: "0", sdpMLineIndex: 0)
        let srflx = W.Candidate(candidate: "candidate:4 1 udp 7 198.51.100.4 5002 typ srflx raddr 192.168.1.20 rport 5000", sdpMid: "0", sdpMLineIndex: 0)
        let bodies = W.iceBodies([relay, lan, srflx, tail])
        XCTAssertEqual(bodies.count, 1)
        let list = try XCTUnwrap((JSONSerialization.jsonObject(with: bodies[0]) as? [String: Any])?["candidates"] as? [[String: Any]])
        XCTAssertEqual(list.map { $0["candidate"] as? String }, [tail.candidate, lan.candidate, srflx.candidate, relay.candidate])
        XCTAssertEqual(W.iceBodies(Array(repeating: lan, count: 120)).count, 3, "≤ 50 per call")
        XCTAssertEqual(ScreenCandidateTier.tier(of: "candidate:5 1 udp 9 fd7a:115c:a1e0::9 5003 typ host"), .tailnet)
        XCTAssertEqual(ScreenCandidateTier.tier(of: "candidate:6 1 udp 9 100.128.0.1 5003 typ host"), .host, "outside 100.64/10")
        XCTAssertEqual(ScreenCandidateTier.label(forStatsCandidate: "prflx 100.70.0.9"), "Tailscale")
    }

    func testStatsSummary() {
        let stats = W.parseStats(Data(#"{"session_id":"scr_1","state":"connected","codec":"video/H264","frames_per_second":30,"rtt_ms":3,"remote_candidate":"host 100.81.83.56"}"#.utf8))
        XCTAssertEqual(stats?.summary, "H264 · 30 fps · 3 ms · Tailscale")
    }

    func testVideoFirstWithSnapshotFallback() {
        let now = Date()
        XCTAssertEqual(ScreenViewModePolicy.mode(screenSessionSupported: true, lastVideoFailure: nil, userForcedSnapshot: false, now: now), .video)
        XCTAssertEqual(ScreenViewModePolicy.mode(screenSessionSupported: false, lastVideoFailure: nil, userForcedSnapshot: false, now: now), .snapshot)
        XCTAssertEqual(ScreenViewModePolicy.mode(screenSessionSupported: true, lastVideoFailure: now.addingTimeInterval(-10), userForcedSnapshot: false, now: now), .snapshot)
        XCTAssertEqual(ScreenViewModePolicy.mode(screenSessionSupported: true, lastVideoFailure: now.addingTimeInterval(-61), userForcedSnapshot: false, now: now), .video, "retry after cooldown")
        XCTAssertEqual(ScreenViewModePolicy.mode(screenSessionSupported: true, lastVideoFailure: nil, userForcedSnapshot: true, now: now), .snapshot)
        XCTAssertTrue(W.guidance(for: MacScreenError(status: 409, code: "session_limit")).contains("另一台设备"))
        XCTAssertTrue(W.guidance(for: MacScreenError(status: 428, code: "screen_permission")).contains("屏幕录制"))
    }

    // MARK: WP-52 input

    private func decode(_ event: ScreenInputEvent) throws -> [String: Any] {
        try XCTUnwrap(JSONSerialization.jsonObject(with: Data(event.message.utf8)) as? [String: Any])
    }

    func testEventsMatchTheContract() throws {
        XCTAssertEqual(try decode(.move(CGPoint(x: 1.4, y: -0.2)))["x"] as? Double, 1)
        let click = try decode(.click(.left, count: 5, at: CGPoint(x: 0.25, y: 0.5)))
        XCTAssertEqual(click["t"] as? String, "click"); XCTAssertEqual(click["n"] as? Int, 3); XCTAssertEqual(click["y"] as? Double, 0.5)
        let scroll = try decode(.scroll(dx: 0, dy: 99_999, at: nil))
        XCTAssertEqual(scroll["dy"] as? Double, 5000); XCTAssertNil(scroll["x"])
        let key = try decode(.key(code: "KeyC", mods: [.shift, .cmd], phase: .press))
        XCTAssertEqual(key["mods"] as? [String], ["cmd", "shift"]); XCTAssertNil(key["phase"], "press is the default")
        XCTAssertEqual(try decode(.key(code: "Escape", mods: [], phase: .down))["phase"] as? String, "down")
        XCTAssertEqual(try decode(.down(.right, nil))["b"] as? String, "right")
    }

    func testLongTextIsSplitOnGraphemes() {
        let text = String(repeating: "你好👨‍👩‍👧", count: 600)
        let events = ScreenInputEvent.textEvents(text)
        XCTAssertGreaterThan(events.count, 1)
        var joined = ""
        for case .text(let s) in events {
            XCTAssertLessThanOrEqual(s.unicodeScalars.count, ScreenInputEvent.maxTextPerMessage)
            joined += s
        }
        XCTAssertEqual(joined, text)
        XCTAssertEqual(ScreenInputEvent.textEvents(""), [])
    }

    func testCoordinatesAreRelativeToTheVideoContentRect() {
        let rect = ScreenGeometry.contentRect(videoSize: CGSize(width: 1920, height: 1200), in: CGRect(x: 0, y: 0, width: 390, height: 844))
        XCTAssertEqual(rect.width, 390, accuracy: 0.01); XCTAssertEqual(rect.height, 243.75, accuracy: 0.01)
        XCTAssertEqual(rect.minY, (844 - 243.75) / 2, accuracy: 0.01)
        XCTAssertNil(ScreenGeometry.normalized(CGPoint(x: 100, y: 10), contentRect: rect), "letterbox is not the screen")
        let center = ScreenGeometry.normalized(CGPoint(x: 195, y: 422), contentRect: rect)
        XCTAssertEqual(center?.x ?? 0, 0.5, accuracy: 0.001); XCTAssertEqual(center?.y ?? 0, 0.5, accuracy: 0.001)
    }

    func testTrackpadGestures() throws {
        var pad = ScreenTrackpad()
        _ = pad.move(by: CGSize(width: 100, height: 0), padSize: CGSize(width: 400, height: 600))
        XCTAssertEqual(pad.cursor.x, 0.5 + 100 * 1.2 / 400, accuracy: 0.0001)
        _ = pad.move(by: CGSize(width: 10_000, height: 10_000), padSize: CGSize(width: 400, height: 600))
        XCTAssertEqual(pad.cursor, CGPoint(x: 1, y: 1), "clamped to the screen")
        XCTAssertEqual(pad.tap(), .click(.left, count: 1, at: pad.cursor))
        XCTAssertEqual(pad.longPress(), .click(.right, count: 1, at: pad.cursor))
        // Fingers move up (negative y) → dy > 0 → content scrolls down.
        guard case .scroll(_, let dy, _) = pad.scroll(by: CGSize(width: 0, height: -30)) else { return XCTFail() }
        XCTAssertGreaterThan(dy, 0)
    }

    func testHIDUsageToW3CCodes() {
        XCTAssertEqual(ScreenHIDKeys.code(forUsage: 0x04), "KeyA")
        XCTAssertEqual(ScreenHIDKeys.code(forUsage: 0x1D), "KeyZ")
        XCTAssertEqual(ScreenHIDKeys.code(forUsage: 0x1E), "Digit1")
        XCTAssertEqual(ScreenHIDKeys.code(forUsage: 0x27), "Digit0")
        XCTAssertEqual(ScreenHIDKeys.code(forUsage: 0x3A), "F1")
        XCTAssertEqual(ScreenHIDKeys.code(forUsage: 0x45), "F12")
        XCTAssertEqual(ScreenHIDKeys.code(forUsage: 0x6C), "F17")
        XCTAssertEqual(ScreenHIDKeys.code(forUsage: 0x50), "ArrowLeft")
        XCTAssertEqual(ScreenHIDKeys.code(forUsage: 0x29), "Escape")
        XCTAssertEqual(ScreenHIDKeys.code(forUsage: 0x59), "Numpad1")
        XCTAssertEqual(ScreenHIDKeys.code(forUsage: 0xE3), "MetaLeft")
        XCTAssertEqual(ScreenHIDKeys.modifier(forUsage: 0xE7), .cmd)
        XCTAssertNil(ScreenHIDKeys.code(forUsage: 0x01))
        XCTAssertTrue(ScreenHIDKeys.reserved.contains { $0.code == "Tab" && $0.mods == [.cmd] }, "⌘Tab is taken by iPadOS")
    }

    func testStickyModifiersApplyOnceAndStatusGuidance() {
        var sticky = ScreenStickyModifiers()
        sticky.toggle(.cmd); sticky.toggle(.shift)
        XCTAssertEqual(sticky.press("ArrowLeft"), .key(code: "ArrowLeft", mods: [.cmd, .shift], phase: .press))
        XCTAssertEqual(sticky.press("Tab"), .key(code: "Tab", mods: [], phase: .press), "released after one key")
        let status = ScreenInputStatus.parse(#"{"t":"status","ok":false,"reason":"accessibility"}"#)
        XCTAssertEqual(status, ScreenInputStatus(ok: false, reason: "accessibility"))
        XCTAssertTrue(status?.guidance?.contains("辅助功能") == true)
        XCTAssertNil(ScreenInputStatus.parse(#"{"t":"status","ok":true}"#)?.guidance)
        XCTAssertNil(ScreenInputStatus.parse(#"{"t":"move"}"#))
        XCTAssertTrue(ScreenControlGuidance.notGranted.contains("允许手机操控"))
    }

    func testWebRTCIsPinnedAndWired() throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
        let project = try String(contentsOf: root.appendingPathComponent("LeoPhoneAgent.xcodeproj/project.pbxproj"), encoding: .utf8)
        XCTAssertTrue(project.contains("https://github.com/stasel/WebRTC"))
        XCTAssertTrue(project.contains("kind = exactVersion;\n\t\t\t\tversion = 154.0.0;"), "pin an exact, released version")
        let peer = try String(contentsOf: root.appendingPathComponent("Agent/Gateway/ScreenPeerClient.swift"), encoding: .utf8)
        XCTAssertTrue(peer.contains("direction = .recvOnly"))
        XCTAssertTrue(peer.contains("ScreenSessionWire.inputLabel"))
    }
}
