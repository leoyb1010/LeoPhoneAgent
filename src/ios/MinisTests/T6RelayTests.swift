import XCTest

final class T6RelayTests: XCTestCase {
    func testJournalControlDoesNotBecomeAnEventCursor() {
        let frame: [String: Any] = ["type": "durability", "state": "pending", "durable_seq": 10, "latest_seq": 12, "missing_ranges": []]
        let status = HarnessJournalStatus.parse(frame)
        XCTAssertEqual(status?.state, "pending")
        XCTAssertEqual(status?.durableSeq, 10)
        XCTAssertEqual(status?.latestSeq, 12)
        XCTAssertNil(T6RelayLogic.parseResume(frame))
    }

    func testIncompleteJournalCannotBePresentedAsDurable() {
        XCTAssertEqual(HarnessJournalStatus.parse(["type": "durability", "state": "durable", "durable_seq": 10, "latest_seq": 12])?.state, "degraded")
        XCTAssertEqual(HarnessJournalStatus.parse(["type": "durability", "state": "durable", "durable_seq": 12, "latest_seq": 12])?.state, "durable")
        XCTAssertNil(HarnessJournalStatus.parse(["type": "durability", "state": "durable", "durable_seq": 13, "latest_seq": 12]))
        XCTAssertNil(HarnessJournalStatus.parse(["event": "message.delta", "seq": 9]))
    }

    func testResumeGapNeverRewinds() {
        let ok = T6RelayLogic.resumeEnvelope(after: 5, minAfter: 0)
        XCTAssertEqual(ok.status, "ok")
        let gap = T6RelayLogic.resumeEnvelope(after: 5, minAfter: 41)
        XCTAssertEqual(gap.status, "gap")
        XCTAssertEqual(T6RelayLogic.advance(current: 5, minAfter: 41), 41)
        XCTAssertEqual(T6RelayLogic.advance(current: 50, minAfter: 41), 50)
        XCTAssertEqual(
            T6RelayLogic.parseResume(["type": "resume", "status": "gap", "after": 5, "min_after": 41])?.minAfter,
            41
        )
        XCTAssertNil(T6RelayLogic.parseResume(["event": "message.delta", "seq": 1]))
    }
}
