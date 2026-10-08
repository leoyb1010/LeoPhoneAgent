import XCTest

/// Ported from upstream ShellTimeoutPreserveOutputTests / ShellTimeoutPartialTailTests
/// (standalone scripts there), now run against the shipping
/// `ShellPartialOutputMirror` used by ISHExecutionCoordinator's timeout path.
final class ShellTimeoutPreserveOutputTests: XCTestCase {
    func testTimedOutCommandKeepsWhatItPrintedWithNoticeLast() {
        let m = ShellPartialOutputMirror()
        ["Compiling module A", "Compiling module B", "error: missing symbol foo"].forEach(m.record)
        let out = m.timedOutOutput(afterSeconds: 30)
        XCTAssertTrue(out.hasPrefix("Compiling module A\nCompiling module B\nerror: missing symbol foo"))
        XCTAssertTrue(out.contains("timed out after 30s"))
        let err = out.range(of: "error: missing symbol foo")!.lowerBound
        let notice = out.range(of: "[Command timed out")!.lowerBound
        XCTAssertLessThan(err, notice, "output precedes the notice")
        XCTAssertTrue(out.hasSuffix("before the timeout]"))
        XCTAssertFalse(out.contains("was dropped"))
    }

    func testCommandWithNoOutputSaysSoOnce() {
        XCTAssertEqual(ShellPartialOutputMirror().timedOutOutput(afterSeconds: 5),
                       "[Command timed out after 5s with no output captured]")
    }

    func testOrdinaryCommandNeverTripsTheCap() {
        let m = ShellPartialOutputMirror()
        for i in 0..<200 { m.record("line \(i) of build output") }
        XCTAssertFalse(m.snapshot().truncated)
    }

    func testConcurrentWritersDoNotLoseLines() {
        let m = ShellPartialOutputMirror()
        DispatchQueue.concurrentPerform(iterations: 8) { w in
            for i in 0..<500 { m.record("w\(w)-\(i)") }
        }
        XCTAssertEqual(m.snapshot().text.split(separator: "\n").count, 4000)
    }
}

final class ShellTimeoutPartialTailTests: XCTestCase {
    func testErrorPrintedRightBeforeTheHangSurvivesTheCap() {
        let cap = 10_000
        let m = ShellPartialOutputMirror(maxChars: cap)
        for i in 0..<6000 { m.record("compiling unit \(i) ........................................") }
        let fatal = "error: linker command failed — undefined symbol _foo"
        m.record(fatal)
        let snap = m.snapshot()
        XCTAssertTrue(snap.truncated)
        XCTAssertLessThanOrEqual(snap.text.count, cap)
        XCTAssertTrue(snap.text.hasSuffix(fatal), "newest line is kept")
        XCTAssertFalse(snap.text.contains("compiling unit 0 "), "oldest lines are evicted")
        let out = m.timedOutOutput(afterSeconds: 60)
        XCTAssertTrue(out.hasPrefix("[Earlier output beyond the last \(cap) chars was dropped]"),
                      "the drop notice sits above the kept tail")
        XCTAssertTrue(out.contains(fatal))
        XCTAssertTrue(out.hasSuffix("before the timeout]"))
    }

    func testSingleOversizedLineIsStillKept() {
        let m = ShellPartialOutputMirror(maxChars: 10)
        m.record("short")
        m.record(String(repeating: "x", count: 50))
        XCTAssertEqual(m.snapshot().text, String(repeating: "x", count: 50))
    }

    func testCompactionKeepsOrderAfterManyEvictions() {
        let m = ShellPartialOutputMirror(maxChars: 100)
        for i in 0..<20_000 { m.record("l\(i)") }
        let lines = m.snapshot().text.split(separator: "\n")
        XCTAssertEqual(lines.last, "l19999")
        let nums = lines.map { Int($0.dropFirst())! }
        XCTAssertEqual(nums, Array(nums.first!...nums.last!), "contiguous and ordered")
    }
}

/// [T-ish-continuation-double-resume] Ported from upstream; exercises the
/// production `ShellResumeClaim` instead of a mirror copy.
final class ISHContinuationResumeRaceTests: XCTestCase {
    private final class Counter: @unchecked Sendable {
        private let lock = NSLock()
        private var count = 0
        func increment() { lock.lock(); count += 1; lock.unlock() }
        var value: Int { lock.lock(); defer { lock.unlock() }; return count }
    }

    func testExactlyOneClaimWinsUnderHeavyContention() {
        for round in 0..<500 {
            let claim = ShellResumeClaim()
            let winners = Counter()
            DispatchQueue.concurrentPerform(iterations: 8) { _ in
                if claim.claim() { winners.increment() }
            }
            XCTAssertEqual(winners.value, 1, "round \(round)")
        }
    }

    func testClaimIsExclusiveAcrossDistinctQueues() {
        for _ in 0..<200 {
            let claim = ShellResumeClaim()
            let winners = Counter()
            let group = DispatchGroup()
            for queue in [DispatchQueue.main, .global(qos: .utility), .main, .global(qos: .userInitiated)] {
                group.enter()
                queue.async { if claim.claim() { winners.increment() }; group.leave() }
            }
            let done = expectation(description: "racers finished")
            group.notify(queue: .global()) { done.fulfill() }
            wait(for: [done], timeout: 5)
            XCTAssertEqual(winners.value, 1)
        }
    }

    func testClaimIsIdempotentAndPermanent() {
        let claim = ShellResumeClaim()
        XCTAssertTrue(claim.claim())
        XCTAssertFalse(claim.claim())
        XCTAssertFalse(claim.claim())
    }
}
