import XCTest

final class SyncRetryPolicyTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_000)

    func testMissingTypeDoesNotDelayOtherQueriesOrUploads() {
        var policy = SyncRetryPolicy()
        policy.failed(.query("MissingOptionalType"), at: now, jitter: 0)
        XCTAssertFalse(policy.isEligible(.query("MissingOptionalType"), at: now))
        XCTAssertTrue(policy.isEligible(.query("MessageV2"), at: now))
        XCTAssertTrue(policy.isEligible(.send, at: now))
        XCTAssertNil(policy.serviceNotBefore)
    }

    func testServiceThrottleSurvivesUnrelatedSuccessAndRestart() throws {
        var policy = SyncRetryPolicy()
        policy.observeServiceRetry(after: 300, at: now)
        policy.succeeded(.send)
        policy.succeeded(.query("MessageV2"))
        let restored = try JSONDecoder().decode(SyncRetryPolicy.self, from: JSONEncoder().encode(policy))
        XCTAssertFalse(restored.isEligible(.send, at: now.addingTimeInterval(299)))
        XCTAssertFalse(restored.isEligible(.changes, at: now))
        XCTAssertTrue(restored.isEligible(.send, at: now.addingTimeInterval(300)))
    }

    func testSendRetryHintIsFloorAndDoesNotThrottleReads() {
        var policy = SyncRetryPolicy()
        policy.failed(.send, at: now, minimumDelay: 60, jitter: 0)
        XCTAssertEqual(policy.deadline(for: .send), now.addingTimeInterval(60))
        XCTAssertTrue(policy.isEligible(.changes, at: now))
        XCTAssertTrue(policy.isEligible(.query("MessageV2"), at: now))
        policy.succeeded(.send)
        XCTAssertTrue(policy.isEligible(.send, at: now))
    }

    func testRepeatedFailuresStayBoundedAndRecoveryIsScoped() {
        var policy = SyncRetryPolicy()
        for _ in 0..<100 { policy.failed(.send, at: now, jitter: 1) }
        XCTAssertEqual(policy.deadline(for: .send), now.addingTimeInterval(300))
        policy.failed(.query("SkillV2"), at: now, jitter: 0)
        policy.succeeded(.send)
        XCTAssertFalse(policy.isEligible(.query("SkillV2"), at: now))
        XCTAssertTrue(policy.isEligible(.send, at: now))
    }
}
