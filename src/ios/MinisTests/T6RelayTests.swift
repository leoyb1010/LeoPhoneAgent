import XCTest

final class T6RelayTests: XCTestCase {
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
