import XCTest

/// [V-rec] 录音分块状态机:换块、暂停 / 继续、打断、换采样率、停止。
final class RecordingChunkPlannerTests: XCTestCase {
    private let rate = 48_000.0

    private func frames(_ seconds: Double, rate: Double = 48_000) -> Int { Int(seconds * rate) }

    func testStartOpensFirstChunk() {
        var p = RecordingChunkPlanner()
        let actions = p.start(sampleRate: rate)
        XCTAssertEqual(actions.count, 1)
        guard case .open(let chunk) = actions[0] else { return XCTFail("expected open") }
        XCTAssertEqual(chunk.index, 0)
        XCTAssertEqual(chunk.fileName, "chunk-000.m4a")
        XCTAssertEqual(chunk.startOffset, 0)
        XCTAssertTrue(chunk.isOpen)
        XCTAssertEqual(p.state, .recording)
        // A second start is ignored.
        XCTAssertEqual(p.start(sampleRate: rate), [])
    }

    func testRolloverAtTenMinutesKeepsEveryFrame() {
        var p = RecordingChunkPlanner()
        _ = p.start(sampleRate: rate)
        let buffer = 4_800   // 0.1 s
        var rollovers = 0
        var written = 0
        // 25 minutes of audio.
        for _ in 0..<(25 * 60 * 10) {
            let actions = p.append(frames: buffer, sampleRate: rate)
            if actions.contains(where: { if case .close = $0 { return true }; return false }) { rollovers += 1 }
            for case .write(_, let n) in actions { written += n }
        }
        XCTAssertEqual(rollovers, 2, "25 min → chunks of 10 + 10 + 5")
        XCTAssertEqual(p.chunks.count, 3)
        XCTAssertEqual(written, 25 * 60 * 10 * buffer)
        XCTAssertEqual(p.chunks.reduce(Int64(0)) { $0 + $1.frameCount }, Int64(written))
        for chunk in p.chunks.dropLast() {
            XCTAssertLessThanOrEqual(chunk.duration, RecordingChunkPlanner.defaultChunkSeconds + 0.0001)
            XCTAssertGreaterThan(chunk.duration, RecordingChunkPlanner.defaultChunkSeconds - 0.2)
            XCTAssertFalse(chunk.isOpen)
        }
        // Offsets are contiguous on the recording timeline.
        XCTAssertEqual(p.chunks[1].startOffset, p.chunks[0].duration, accuracy: 0.0001)
        XCTAssertEqual(p.chunks[2].startOffset, p.chunks[0].duration + p.chunks[1].duration, accuracy: 0.0001)
        XCTAssertEqual(p.elapsed, 25 * 60, accuracy: 0.001)
        XCTAssertEqual(p.chunks.map(\.fileName), ["chunk-000.m4a", "chunk-001.m4a", "chunk-002.m4a"])
    }

    func testRolloverSequenceIsCloseThenOpenThenWrite() {
        var p = RecordingChunkPlanner(maxChunkSeconds: 1)
        _ = p.start(sampleRate: 1_000)
        _ = p.append(frames: 900, sampleRate: 1_000)
        let actions = p.append(frames: 200, sampleRate: 1_000)
        XCTAssertEqual(actions.count, 3)
        XCTAssertEqual(actions[0], .close(index: 0))
        guard case .open(let next) = actions[1] else { return XCTFail("expected open") }
        XCTAssertEqual(next.index, 1)
        XCTAssertEqual(next.startOffset, 0.9, accuracy: 1e-9)
        XCTAssertEqual(actions[2], .write(index: 1, frames: 200))
    }

    func testUserPauseKeepsChunkOpenAndDropsAudio() {
        var p = RecordingChunkPlanner()
        _ = p.start(sampleRate: rate)
        _ = p.append(frames: frames(2), sampleRate: rate)
        XCTAssertEqual(p.pause(.user), [], "user pause keeps the writer open")
        XCTAssertEqual(p.state, .paused(.user))
        XCTAssertEqual(p.append(frames: frames(5), sampleRate: rate), [], "paused audio is not recorded")
        XCTAssertEqual(p.resume(sampleRate: rate), [], "same chunk continues")
        _ = p.append(frames: frames(3), sampleRate: rate)
        XCTAssertEqual(p.chunks.count, 1)
        XCTAssertEqual(p.elapsed, 5, accuracy: 0.0001, "elapsed excludes the pause")
    }

    func testInterruptionClosesChunkAndResumeOpensNewOne() {
        var p = RecordingChunkPlanner()
        _ = p.start(sampleRate: rate)
        _ = p.append(frames: frames(4), sampleRate: rate)
        XCTAssertEqual(p.pause(.interruption), [.close(index: 0)])
        XCTAssertNil(p.openChunk)
        let resumed = p.resume(sampleRate: rate)
        XCTAssertEqual(resumed.count, 1)
        guard case .open(let chunk) = resumed[0] else { return XCTFail("expected open") }
        XCTAssertEqual(chunk.index, 1)
        XCTAssertEqual(chunk.startOffset, 4, accuracy: 0.0001)
        _ = p.append(frames: frames(1), sampleRate: rate)
        XCTAssertEqual(p.chunks.count, 2)
        XCTAssertEqual(p.elapsed, 5, accuracy: 0.0001)
    }

    func testInterruptionWhileUserPausedClosesOpenChunk() {
        var p = RecordingChunkPlanner()
        _ = p.start(sampleRate: rate)
        _ = p.append(frames: frames(1), sampleRate: rate)
        _ = p.pause(.user)
        XCTAssertEqual(p.pause(.interruption), [.close(index: 0)])
        XCTAssertEqual(p.state, .paused(.interruption))
    }

    func testEmptyChunkIsDiscardedNotKept() {
        var p = RecordingChunkPlanner()
        _ = p.start(sampleRate: rate)
        XCTAssertEqual(p.pause(.interruption), [.discard(index: 0)])
        XCTAssertTrue(p.chunks.isEmpty)
        _ = p.resume(sampleRate: rate)
        XCTAssertEqual(p.stop(), [.discard(index: 0)])
        XCTAssertTrue(p.chunks.isEmpty)
    }

    func testSampleRateChangeStartsNewChunk() {
        var p = RecordingChunkPlanner()
        _ = p.start(sampleRate: 48_000)
        _ = p.append(frames: 48_000, sampleRate: 48_000)
        let actions = p.append(frames: 16_000, sampleRate: 16_000)
        XCTAssertEqual(actions.first, .close(index: 0))
        XCTAssertEqual(p.chunks.count, 2)
        XCTAssertEqual(p.chunks[1].sampleRate, 16_000)
        XCTAssertEqual(p.elapsed, 2, accuracy: 0.0001)
    }

    func testResumeOnDifferentRateAfterUserPauseRollsChunk() {
        var p = RecordingChunkPlanner()
        _ = p.start(sampleRate: 48_000)
        _ = p.append(frames: 4_800, sampleRate: 48_000)
        _ = p.pause(.user)
        let actions = p.resume(sampleRate: 24_000)
        XCTAssertEqual(actions.first, .close(index: 0))
        XCTAssertEqual(p.openChunk?.sampleRate, 24_000)
    }

    func testStopClosesAndIgnoresLaterAudio() {
        var p = RecordingChunkPlanner()
        _ = p.start(sampleRate: rate)
        _ = p.append(frames: 100, sampleRate: rate)
        XCTAssertEqual(p.stop(), [.close(index: 0)])
        XCTAssertEqual(p.state, .stopped)
        XCTAssertEqual(p.append(frames: 100, sampleRate: rate), [])
        XCTAssertEqual(p.stop(), [])
        XCTAssertFalse(p.chunks[0].isOpen)
    }

    func testHostileInputsAreIgnored() {
        var p = RecordingChunkPlanner()
        _ = p.start(sampleRate: rate)
        XCTAssertEqual(p.append(frames: 0, sampleRate: rate), [])
        XCTAssertEqual(p.append(frames: -5, sampleRate: rate), [])
        XCTAssertEqual(p.append(frames: 10, sampleRate: .nan), [])
        XCTAssertEqual(p.append(frames: 10, sampleRate: 0), [])
        XCTAssertEqual(p.chunks.count, 1)
        XCTAssertEqual(p.chunks[0].frameCount, 0)
    }

    func testContinuesAfterExistingChunks() {
        let existing = [RecordingChunk(index: 0, fileName: "chunk-000.m4a", startOffset: 0, sampleRate: 48_000,
                                       frameCount: 48_000 * 30, isOpen: true)]
        var p = RecordingChunkPlanner(existing: existing)
        XCTAssertFalse(p.chunks[0].isOpen)
        guard case .open(let next)? = p.start(sampleRate: 48_000).first else { return XCTFail("expected open") }
        XCTAssertEqual(next.index, 1)
        XCTAssertEqual(next.startOffset, 30, accuracy: 0.0001)
    }
}
