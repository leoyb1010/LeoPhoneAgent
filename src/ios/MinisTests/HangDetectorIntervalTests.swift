import XCTest

/// [r7] HangDetector must not report process suspension / device sleep as a
/// main-thread hang (device log: "MAIN HANG 491700ms", AfterWaiting beat from
/// before an 8-minute background stay).
final class HangDetectorIntervalTests: XCTestCase {
    private let pollMs = 100.0
    private let thresholdMs = 1000.0

    /// Replays the monitor loop: every poll updates the floor on a gap, then
    /// measures busy time from max(lastBeat, floor).
    private func reportedHangs(polls: [(cont: Double, abs: Double)], lastBeat: Double) -> [Double] {
        var lastPoll: Double?
        var lastOffset: Double?
        var floor = 0.0
        var reported: [Double] = []
        for p in polls {
            let offset = p.cont - p.abs
            let gap = lastPoll.map { p.cont - $0 } ?? 0
            let sleep = lastOffset.map { offset - $0 } ?? 0
            lastPoll = p.cont
            lastOffset = offset
            if LeoHangIsSuspensionGap(gap, pollMs, sleep) { floor = p.cont; continue }
            let busy = LeoHangEffectiveBusyMs(p.cont, lastBeat, floor)
            if busy >= thresholdMs { reported.append(busy) }
        }
        return reported
    }

    func testSuspensionGap_appSuspendedWhileDeviceAwake_isExcluded() {
        // Main beat AfterWaiting at t=0, process suspended at ~200 ms, resumed
        // 491.7 s later (device awake: absolute time keeps running).
        var polls: [(Double, Double)] = [(100, 100), (200, 200)]
        polls += [(491_900, 491_900), (492_000, 492_000)]
        XCTAssertEqual(reportedHangs(polls: polls, lastBeat: 0), [],
                       "the suspension must not be reported as a 491 s hang")
    }

    func testSuspensionGap_deviceSleep_isExcluded() {
        // Device slept 300 s: continuous time jumps, absolute time does not.
        let polls: [(Double, Double)] = [(100, 100), (200, 200), (300_250, 250), (300_350, 350)]
        XCTAssertEqual(reportedHangs(polls: polls, lastBeat: 0), [])
        XCTAssertTrue(LeoHangIsSuspensionGap(150, pollMs, 300_000))
    }

    func testRealHang_stillReported() {
        // Main stuck 1.6 s with the monitor polling normally.
        let polls = (1...16).map { (Double($0) * 100, Double($0) * 100) }
        let hangs = reportedHangs(polls: polls, lastBeat: 0)
        XCTAssertEqual(hangs.first, 1000)
        XCTAssertEqual(hangs.last, 1600)
    }

    func testRealHangAfterResume_measuredFromResume() {
        // Suspended, resumed at 500 000, then main really stuck 1.2 s.
        var polls: [(Double, Double)] = [(100, 100)]
        polls += (0...12).map { (500_000 + Double($0) * 100, 500_000 + Double($0) * 100) }
        XCTAssertEqual(reportedHangs(polls: polls, lastBeat: 0).last, 1200,
                       "only the stall after resume counts")
    }

    func testIsSuspensionGap_thresholds() {
        XCTAssertFalse(LeoHangIsSuspensionGap(100, pollMs, 0))
        XCTAssertFalse(LeoHangIsSuspensionGap(900, pollMs, 10), "a slow but live monitor is not a suspension")
        XCTAssertTrue(LeoHangIsSuspensionGap(1_200, pollMs, 0))
        XCTAssertTrue(LeoHangIsSuspensionGap(100, pollMs, kLeoHangSleepSlackMs + 1))
    }

    func testEffectiveBusy_usesLaterOfBeatAndFloor() {
        XCTAssertEqual(LeoHangEffectiveBusyMs(2_000, 500, 0), 1_500)
        XCTAssertEqual(LeoHangEffectiveBusyMs(2_000, 500, 1_800), 200)
        XCTAssertEqual(LeoHangEffectiveBusyMs(100, 500, 0), 0)
    }
}
