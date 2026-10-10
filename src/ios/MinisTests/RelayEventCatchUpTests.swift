import Foundation
import XCTest

/// Relay catch-up: one future-dated event must not push the cursor to year
/// 3000, and one catch-up must stay small however much the relay returns.
final class RelayEventCatchUpTests: XCTestCase {

    private let now: Double = 2_000_000_000

    private func item(_ at: Double, seq: Int? = nil, approval: String? = nil, event: String = "run.completed") -> RelayEventItem {
        var raw: [String: Any] = ["event": event, "session_id": "s1"]
        if let seq { raw["seq"] = seq }
        if let approval { raw["approval_id"] = approval }
        return RelayEventItem(machine: "Mac", receivedAt: at, raw: raw)
    }

    func testFutureReceivedAtDoesNotAdvanceCursor() {
        let year3000 = now + 1000 * 365 * 86_400
        let plan = RelayCatchUpPolicy.plan([item(now - 10, seq: 1), item(year3000, seq: 2)], lastSeenAt: now - 100, now: now)
        XCTAssertEqual(plan.highWater, now + RelayCatchUpPolicy.maxFutureSkew)
        XCTAssertLessThanOrEqual(plan.highWater, now + 60)
        // A cursor an older build already pushed into the future is repaired.
        XCTAssertEqual(RelayCatchUpPolicy.repairedCursor(year3000, now: now), now)
        XCTAssertEqual(RelayCatchUpPolicy.repairedCursor(now - 5, now: now), now - 5)
        XCTAssertEqual(RelayCatchUpPolicy.repairedCursor(.infinity, now: now), 0)
        // An ordinary batch moves the cursor to what was seen.
        XCTAssertEqual(RelayCatchUpPolicy.plan([item(now - 10, seq: 1)], lastSeenAt: now - 100, now: now).highWater, now - 10)
    }

    func testCatchUpCapsItemsAndBytes() throws {
        let many = (0..<5_000).map { item(now - Double(5_000 - $0), seq: $0) }
        let plan = RelayCatchUpPolicy.plan(many.shuffled(), lastSeenAt: 0, now: now)
        XCTAssertEqual(plan.items.count, RelayCatchUpPolicy.maxItems)
        XCTAssertEqual(plan.items.last?.seq, 4_999, "the newest are kept")
        XCTAssertEqual(plan.items.first?.seq, 4_800)
        XCTAssertEqual(plan.droppedOlder, 4_800)
        XCTAssertEqual(plan.highWater, now - 1)

        let small = try JSONSerialization.data(withJSONObject: [
            "now": now, "events": [["machine": "Mac", "received_at": now - 1, "event": ["event": "run.failed", "seq": 3]]],
        ])
        let decoded = try RelayCatchUpPolicy.decode(small)
        XCTAssertEqual(decoded.items.count, 1)
        XCTAssertEqual(decoded.items.first?.eventName, "run.failed")

        let huge = Data(repeating: 0x20, count: RelayCatchUpPolicy.maxResponseBytes + 1)
        XCTAssertThrowsError(try RelayCatchUpPolicy.decode(huge)) {
            XCTAssertTrue($0 is RelayCatchUpPolicy.ResponseTooLarge)
        }
    }

    func testFingerprintWithoutSeqKeepsDistinctApprovals() {
        let a = item(now - 2, approval: "ap-1", event: "approval.request")
        let b = item(now - 1, approval: "ap-2", event: "approval.request")
        XCTAssertNotEqual(a.fingerprint, b.fingerprint, "two approvals without seq are two prompts")
        XCTAssertEqual(item(now, seq: 7).fingerprint, item(now + 5, seq: 7).fingerprint, "seq stays the identity when present")
    }
}
