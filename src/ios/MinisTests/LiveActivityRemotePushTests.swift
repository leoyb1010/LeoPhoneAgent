import XCTest

/// WP-41:中继远程推 Live Activity —— App 侧的解码宽容、token 登记载荷、更新节流。
final class LiveActivityRemotePushTests: XCTestCase {
    // 与 src/mac/leoagent/live_activity.py `aps_payload` 产出的 content-state / attributes 同形。
    private let relayContentState = """
    {"activeSessionCount": 1, "sessions": [{"sessionId": "s1", "title": "🖥 MacBook", "toolIcon": "hand.raised.fill",
     "toolStatus": "等你审批:Bash", "loopIteration": 0, "isCompleted": false, "lastMessage": "", "outcome": "done"}],
     "carouselIndex": 0, "soulName": "", "latestToolIcon": "hand.raised.fill", "minimalShowsTool": false,
     "allCompleted": false, "isAudioPlaying": false, "isAudioLoaded": false, "audioTitle": "", "privacyMode": false}
    """

    func testRelayContentStateDecodes() throws {
        let state = try JSONDecoder().decode(AgentActivityAttributes.ContentState.self, from: Data(relayContentState.utf8))
        XCTAssertEqual(state.activeSessionCount, 1)
        XCTAssertTrue(state.sessions[0].needsApproval)
        XCTAssertNil(state.finishedAt)
    }

    func testContentStateMissingKeysFallBackToDefaults() throws {
        let state = try JSONDecoder().decode(AgentActivityAttributes.ContentState.self,
                                             from: Data(#"{"sessions": [], "activeSessionCount": 0}"#.utf8))
        XCTAssertEqual(state.soulName, "")
        XCTAssertFalse(state.allCompleted)
        XCTAssertFalse(state.privacyMode)
    }

    func testContentStateRoundTrips() throws {
        let original = AgentActivityAttributes.ContentState(
            activeSessionCount: 2,
            sessions: [LiveSessionSnapshot(sessionId: "a", title: "t", toolIcon: "terminal.fill", toolStatus: "x", loopIteration: 3)],
            carouselIndex: 1, soulName: "Leo", latestToolIcon: "terminal.fill", minimalShowsTool: true,
            allCompleted: false, isAudioPlaying: true, isAudioLoaded: true, audioTitle: "a",
            finishedAt: Date(timeIntervalSinceReferenceDate: 1000), privacyMode: true)
        let decoded = try JSONDecoder().decode(AgentActivityAttributes.ContentState.self,
                                               from: JSONEncoder().encode(original))
        XCTAssertEqual(decoded, original)
    }

    func testAttributesAcceptBothDateEpochsAndOrigin() throws {
        let unix: TimeInterval = 1_800_000_000
        let fromRelayReference = try JSONDecoder().decode(AgentActivityAttributes.self, from: Data(
            #"{"startDate": \#(unix - 978_307_200), "origin": "relay"}"#.utf8))
        XCTAssertEqual(fromRelayReference.startDate.timeIntervalSince1970, unix, accuracy: 0.001)
        XCTAssertEqual(fromRelayReference.origin, AgentActivityAttributes.relayOrigin)
        let fromUnix = try JSONDecoder().decode(AgentActivityAttributes.self, from: Data(#"{"startDate": \#(unix)}"#.utf8))
        XCTAssertEqual(fromUnix.startDate.timeIntervalSince1970, unix, accuracy: 0.001)
        XCTAssertNil(fromUnix.origin)
        let local = AgentActivityAttributes(startDate: Date(timeIntervalSince1970: unix))
        let roundTrip = try JSONDecoder().decode(AgentActivityAttributes.self, from: JSONEncoder().encode(local))
        XCTAssertEqual(roundTrip.startDate.timeIntervalSince1970, unix, accuracy: 0.001)
    }

    func testRegistrationPayloadSendsMacTitlesOnly() throws {
        let rows = [
            LiveSessionSnapshot(sessionId: "mac-1", title: "🖥 MacBook · Claude", toolIcon: "", toolStatus: "", loopIteration: 0),
            LiveSessionSnapshot(sessionId: "chat-1", title: "我的私人话题", toolIcon: "", toolStatus: "", loopIteration: 0),
            LiveSessionSnapshot(sessionId: "mac-1", title: "dup", toolIcon: "", toolStatus: "", loopIteration: 0),
        ]
        let payload = try XCTUnwrap(LiveActivityTokenRegistration.payload(
            token: "ab", sessions: rows, privacyMode: false, bundleId: "b", environment: "development"))
        XCTAssertEqual(payload["kind"] as? String, "activity_update")
        XCTAssertEqual(payload["session_ids"] as? [String], ["mac-1", "chat-1"])
        let described = try XCTUnwrap(payload["sessions"] as? [[String: String]])
        XCTAssertEqual(described[0]["title"], "🖥 MacBook · Claude")
        XCTAssertNil(described[1]["title"], "chat titles are user content and stay on the phone")
        let privateMode = try XCTUnwrap(LiveActivityTokenRegistration.payload(
            token: "ab", sessions: rows, privacyMode: true, bundleId: "b", environment: "development"))
        XCTAssertNil((privateMode["sessions"] as? [[String: String]])?[0]["title"])
        XCTAssertNil(LiveActivityTokenRegistration.payload(token: "ab", sessions: [], privacyMode: false,
                                                          bundleId: "b", environment: "development"))
        let many = (0..<12).map { LiveSessionSnapshot(sessionId: "s\($0)", title: "", toolIcon: "", toolStatus: "", loopIteration: 0) }
        let capped = try XCTUnwrap(LiveActivityTokenRegistration.payload(token: "ab", sessions: many, privacyMode: false,
                                                                        bundleId: "b", environment: "development"))
        XCTAssertEqual((capped["session_ids"] as? [String])?.count, LiveActivityTokenRegistration.maxSessions)
        XCTAssertEqual(LiveActivityTokenRegistration.hex(Data([0x0a, 0xff])), "0aff")
    }

    @MainActor
    func testCoalescerKeepsOneInFlightAndOnlyTheNewestQueued() async {
        var performed: [Int] = []
        var release: CheckedContinuation<Void, Never>?
        let coalescer = SingleFlightCoalescer<Int>(merge: { old, new in new + old * 100 }) { value in
            performed.append(value)
            if value == 1 { await withCheckedContinuation { release = $0 } }
        }
        coalescer.submit(1)
        // 让第一个开始执行并卡在 continuation 上
        for _ in 0..<50 where release == nil { await Task.yield() }
        XCTAssertNotNil(release)
        coalescer.submit(2)
        coalescer.submit(3)   // 替换 2(merge 把被替换的带进来:3 + 2*100)
        XCTAssertFalse(coalescer.isIdle)
        release?.resume()
        for _ in 0..<200 where !coalescer.isIdle { await Task.yield() }
        XCTAssertTrue(coalescer.isIdle)
        XCTAssertEqual(performed, [1, 203])
        coalescer.submit(4)
        for _ in 0..<200 where performed.count < 3 { await Task.yield() }
        XCTAssertEqual(performed, [1, 203, 4])
    }

    @MainActor
    func testWaitUntilIdleReturnsAfterQueuedWork() async {
        var performed: [Int] = []
        let coalescer = SingleFlightCoalescer<Int> { value in
            performed.append(value)
            await Task.yield()
        }
        await coalescer.waitUntilIdle()   // 空闲时立即返回
        coalescer.submit(1)
        coalescer.submit(2)
        await coalescer.waitUntilIdle()
        XCTAssertEqual(performed, [1, 2])
        XCTAssertTrue(coalescer.isIdle)
    }
}
