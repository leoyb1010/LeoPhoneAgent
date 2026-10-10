import XCTest

/// [V] 语音 / 手表 / 灵动岛硬化(第三轮计划 §2.4、§3.1)。
final class VoiceHardeningTests: XCTestCase {

    // MARK: - VAD raw buffer

    /// 旧实现在满 5 分钟后每个 tap 回调 `removeFirst` 前移 1440 万个采样。环形缓冲的
    /// 追加成本只和这次写入量有关:满载时和空载时一样快。
    func testRawBufferTrimIsO1() {
        let capacity = 48_000 * 300
        var full = FloatRingBuffer(capacity: capacity)
        full.append(contentsOf: [Float](repeating: 0.1, count: capacity))
        XCTAssertEqual(full.count, capacity)
        let tap = [Float](repeating: 0.5, count: 4_800)

        var small = FloatRingBuffer(capacity: 48_000)
        let clock = ContinuousClock()
        let fullCost = clock.measure { for _ in 0..<500 { full.append(contentsOf: tap) } }
        let smallCost = clock.measure { for _ in 0..<500 { small.append(contentsOf: tap) } }
        XCTAssertEqual(full.count, capacity, "stays capped")
        XCTAssertLessThan(fullCost, smallCost * 4 + .milliseconds(50),
                          "appending to a full 5-minute buffer must cost about the same as to a small one")
        // 500 taps × 0.1 s = 50 s of audio through a full buffer in well under a second
        // (the old removeFirst path moved 58 MB per tap — minutes for the same loop).
        XCTAssertLessThan(fullCost, .seconds(1))
    }

    func testRingBufferKeepsNewestInOrder() {
        var ring = FloatRingBuffer(capacity: 5)
        ring.append(contentsOf: [1, 2, 3])
        XCTAssertEqual(ring.contents, [1, 2, 3])
        ring.append(contentsOf: [4, 5, 6, 7])
        XCTAssertEqual(ring.contents, [3, 4, 5, 6, 7])
        XCTAssertEqual(ring.suffix(2), [6, 7])
        XCTAssertEqual(ring.suffix(99), [3, 4, 5, 6, 7])
        ring.append(contentsOf: (10...20).map(Float.init))
        XCTAssertEqual(ring.contents, [16, 17, 18, 19, 20], "oversize write keeps its tail")
        XCTAssertEqual(ring.drain(), [16, 17, 18, 19, 20])
        XCTAssertTrue(ring.isEmpty)
        XCTAssertEqual(ring.suffix(3), [])
    }

    func testRingBufferResizeKeepsNewest() {
        var ring = FloatRingBuffer(capacity: 4)
        ring.append(contentsOf: [1, 2, 3, 4, 5])
        ring.resize(capacity: 2)
        XCTAssertEqual(ring.contents, [4, 5])
        ring.resize(capacity: 6)
        ring.append(contentsOf: [6, 7, 8, 9, 10])
        XCTAssertEqual(ring.contents, [5, 6, 7, 8, 9, 10])
    }

    func testRingBufferGrowsLazily() {
        // A 5-minute cap must not allocate 58 MB for a two-second utterance.
        var ring = FloatRingBuffer(capacity: 48_000 * 300)
        ring.append(contentsOf: [Float](repeating: 0, count: 96_000))
        XCTAssertEqual(ring.count, 96_000)
        XCTAssertEqual(ring.capacity, 48_000 * 300)
    }

    // MARK: - Watch

    func testWatchTranscribeTimesOut() async {
        let cancelled = expectation(description: "recognition task cancelled at the deadline")
        let started = Date()
        do {
            _ = try await CallbackSpeechTask.run(timeoutSeconds: 0.2) { (_: @escaping @Sendable (Result<String, Error>) -> Void) in
                // The recognizer never calls back.
                return { cancelled.fulfill() }
            }
            XCTFail("must time out")
        } catch {
            XCTAssertEqual(error as? SystemSpeechError, .timedOut)
        }
        XCTAssertLessThan(Date().timeIntervalSince(started), 2)
        await fulfillment(of: [cancelled], timeout: 1)
    }

    func testWatchTranscribeDeliversResultAndIgnoresLateCallbacks() async throws {
        let text = try await CallbackSpeechTask.run(timeoutSeconds: 5) { (complete: @escaping @Sendable (Result<String, Error>) -> Void) in
            complete(.success("你好"))
            complete(.success("迟到的第二次"))
            complete(.failure(SystemSpeechError.timedOut))
            return {}
        }
        XCTAssertEqual(text, "你好")
    }

    func testWatchRequestIdIsValidatedBeforeUseInAFileName() {
        for good in ["ABC-123_x", UUID().uuidString, "a"] {
            XCTAssertTrue(WatchRequestIdPolicy.isSafe(good), good)
            XCTAssertEqual(WatchRequestIdPolicy.sanitized(good), good)
        }
        for bad in ["../../Library/x", "a/b", "", "with space", String(repeating: "a", count: 65), "名字", "a\u{0}b", nil] {
            XCTAssertFalse(WatchRequestIdPolicy.isSafe(bad), String(describing: bad))
            let safe = WatchRequestIdPolicy.sanitized(bad)
            XCTAssertNotNil(UUID(uuidString: safe), "unsafe ids are replaced, never used")
            XCTAssertFalse(safe.contains("/"))
        }
    }

    func testWatchRecordingRemoteRoundTrip() {
        XCTAssertEqual(WatchRecordingRemote.action(from: WatchRecordingRemote.payload(.mark)), .mark)
        XCTAssertNil(WatchRecordingRemote.action(from: ["kind": "ask", "action": "start"]))
        XCTAssertNil(WatchRecordingRemote.action(from: ["kind": WatchRecordingRemote.kind, "action": "format-disk"]))
        let status = WatchRecordingRemote.Status(isRecording: true, isPaused: false, elapsed: 125, highlightCount: 2,
                                                 message: String(repeating: "长", count: 200))
        let reply = WatchRecordingRemote.reply(status, ok: true)
        let back = WatchRecordingRemote.status(fromReply: reply)
        XCTAssertTrue(back.ok)
        XCTAssertEqual(back.status.elapsed, 125)
        XCTAssertEqual(back.status.highlightCount, 2)
        XCTAssertEqual(back.status.message?.count, 80)
        XCTAssertEqual(WatchRecordingRemote.elapsedText(125), "02:05")
        XCTAssertEqual(WatchRecordingRemote.reply(.init(isRecording: false, isPaused: false, elapsed: .nan,
                                                        highlightCount: -3, message: nil), ok: false)["elapsed"] as? Double, 0)
    }

    // MARK: - Live Activity payload

    /// ActivityKit 对 >4 KB 的状态静默丢弃更新(灵动岛卡住)。最坏输入(很多会话、超长标题和工具状态)
    /// 推送前也要压到 3 KB 以内。
    func testSnapshotEncodedSizeUnder3KB() throws {
        let huge = String(repeating: "很长的标题和工具状态", count: 400)
        let rows = (0..<40).map { i in
            LiveSessionSnapshot(sessionId: "session-\(i)-" + String(repeating: "x", count: 200), title: huge,
                                toolIcon: String(repeating: "i", count: 300), toolStatus: huge,
                                loopIteration: i, isCompleted: i % 2 == 0, lastMessage: huge)
        }
        let state = AgentActivityAttributes.ContentState(activeSessionCount: 40, sessions: rows, carouselIndex: 37,
                                                         soulName: huge, latestToolIcon: huge, minimalShowsTool: true,
                                                         allCompleted: false, isAudioPlaying: true, isAudioLoaded: true,
                                                         audioTitle: huge)
        let capped = state.cappedForPayload()
        let size = try JSONEncoder().encode(capped).count
        XCTAssertLessThan(size, 3 * 1024, "encoded \(size) bytes")
        XCTAssertEqual(capped.activeSessionCount, 40, "the count still tells the truth")
        XCTAssertLessThan(capped.carouselIndex, capped.sessions.count)
        XCTAssertEqual(capped.sessions[capped.carouselIndex].loopIteration, 37, "the displayed row survives trimming")
        XCTAssertTrue(capped.sessions.allSatisfy { $0.title.count <= AgentActivityAttributes.ContentState.maxTitle })
        XCTAssertFalse(capped.sessions.contains { $0.toolStatus.contains("\n") })
    }

    func testApprovalRowSurvivesTrimming() {
        var rows = (0..<10).map { LiveSessionSnapshot(sessionId: "s\($0)", title: "t\($0)", toolIcon: "globe",
                                                      toolStatus: "", loopIteration: $0) }
        rows[8].toolIcon = LiveSessionSnapshot.approvalIcon
        let state = AgentActivityAttributes.ContentState(activeSessionCount: 10, sessions: rows, carouselIndex: 2, soulName: "Leo")
        let capped = state.cappedForPayload()
        XCTAssertEqual(capped.sessions.count, AgentActivityAttributes.ContentState.maxRows)
        XCTAssertTrue(capped.sessions.contains { $0.needsApproval }, "a run waiting for your OK is never trimmed away")
        XCTAssertEqual(capped.sessions[capped.carouselIndex].sessionId, "s2")
    }

    func testSmallSnapshotIsUntouched() {
        let row = LiveSessionSnapshot(sessionId: "s", title: "查天气", toolIcon: "globe", toolStatus: "搜索中", loopIteration: 1)
        let state = AgentActivityAttributes.ContentState(activeSessionCount: 1, sessions: [row], carouselIndex: 0, soulName: "Leo")
        XCTAssertEqual(state.cappedForPayload(), state)
    }

    func testRecordingActivityPayloadIsCapped() throws {
        let attrs = RecordingActivityPayload.attributes(recordingId: String(repeating: "r", count: 500),
                                                        title: String(repeating: "会议", count: 1_000))
        let state = RecordingActivityPayload.state(isPaused: false, elapsed: 3_725, level: 7.3, highlightCount: 5_000,
                                                   statusText: "录音中\n" + String(repeating: "x", count: 500),
                                                   now: Date(timeIntervalSince1970: 10_000))
        XCTAssertLessThanOrEqual(attrs.title.count, RecordingActivityPayload.maxTitle)
        XCTAssertLessThanOrEqual(attrs.recordingId.count, RecordingActivityPayload.maxId)
        XCTAssertLessThanOrEqual(state.statusText.count, RecordingActivityPayload.maxStatus)
        XCTAssertEqual(state.level, 1)
        XCTAssertEqual(state.highlightCount, 999)
        XCTAssertEqual(state.timerReferenceDate.timeIntervalSince1970, 10_000 - 3_725, accuracy: 0.001)
        let size = try JSONEncoder().encode(state).count + JSONEncoder().encode(attrs).count
        XCTAssertLessThan(size, 1024)
        let nanState = RecordingActivityPayload.state(isPaused: true, elapsed: .nan, level: .infinity, highlightCount: -1,
                                                      statusText: "", now: Date())
        XCTAssertEqual(nanState.elapsed, 0)
        XCTAssertEqual(nanState.level, 0)
        XCTAssertEqual(nanState.highlightCount, 0)
    }

    // MARK: - Long-audio deadline

    func testLongAudioTimeoutScalesAndIsBounded() {
        XCTAssertEqual(SystemSpeechPolicy.longAudioTimeout(audioDuration: nil), 60)
        XCTAssertEqual(SystemSpeechPolicy.longAudioTimeout(audioDuration: 600), 660)
        XCTAssertEqual(SystemSpeechPolicy.longAudioTimeout(audioDuration: 5_000), 900)
        XCTAssertEqual(SystemSpeechPolicy.longAudioTimeout(audioDuration: .infinity), 60)
        XCTAssertEqual(SystemSpeechPolicy.longAudioTimeout(audioDuration: 1), 61)
    }
}
