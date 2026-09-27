import XCTest

/// [T-la-false-failure] How a run rests on the Dynamic Island once it leaves the
/// tracker. A run parked until the app returns used to rest as "needs attention"
/// (orange exclamation) — the same look as a failure — while it was going to resume.
final class LiveActivityRestingOutcomeTests: XCTestCase {
    func testOnlyRealEndingsGetAVerdict() {
        XCTAssertEqual(LiveSessionSnapshot.RestingOutcome(ending: .completed), .done)
        XCTAssertEqual(LiveSessionSnapshot.RestingOutcome(ending: nil), .done)
        XCTAssertEqual(LiveSessionSnapshot.RestingOutcome(ending: .cancelled), .stopped)
        XCTAssertEqual(LiveSessionSnapshot.RestingOutcome(ending: .failed), .attention)
        XCTAssertEqual(LiveSessionSnapshot.RestingOutcome(ending: .unverified), .attention)
        XCTAssertEqual(LiveSessionSnapshot.RestingOutcome(ending: .waitingForUser), .attention)
    }

    func testBackgroundSuspensionIsPausedNotAttention() {
        XCTAssertEqual(LiveSessionSnapshot.RestingOutcome(ending: .suspended), .paused)
    }

    func testOutcomeRoundTripsThroughCodable() throws {
        var snap = LiveSessionSnapshot(sessionId: "s", title: "t", toolIcon: "pause.circle.fill", toolStatus: "", loopIteration: 1)
        snap.isCompleted = true
        snap.outcome = .paused
        let data = try JSONEncoder().encode(snap)
        let decoded = try JSONDecoder().decode(LiveSessionSnapshot.self, from: data)
        XCTAssertEqual(decoded.outcome, .paused)
        XCTAssertTrue(decoded.isCompleted)
    }
}
