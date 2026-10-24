import XCTest

/// [T-la-false-failure] How a run rests on the Dynamic Island once it leaves the
/// tracker. A run parked until the app returns used to rest as "needs attention"
/// (orange exclamation) — the same look as a failure — while it was going to resume.
/// [leo] 第二轮:「等你批准 / 可续跑的中断 / 没回执」也都落在感叹号里;系统后台进度条
/// 因为进度从不推进被判到期,也挂了失败。只有真失败才配感叹号,而且要说原因。
final class LiveActivityRestingOutcomeTests: XCTestCase {
    typealias Outcome = LiveSessionSnapshot.RestingOutcome

    func testOnlyARealFailureGetsTheFailureLook() {
        XCTAssertEqual(Outcome(ending: .completed), .done)
        XCTAssertEqual(Outcome(ending: nil), .done)
        XCTAssertEqual(Outcome(ending: .cancelled), .stopped)
        XCTAssertEqual(Outcome(ending: .failed), .attention)
        XCTAssertEqual(Outcome(ending: .unverified), .unknown)
        XCTAssertEqual(Outcome(ending: .waitingForPermission), .waiting)
        XCTAssertEqual(Outcome(ending: .waitingForUser, reason: .userQuestion), .waiting)
        XCTAssertEqual(Outcome(ending: .waitingForUser, reason: .permissionApproval), .waiting)
        // 断流、输出超限、被系统结束后可续跑:中断,不是失败。
        for reason in [AgentActivityReason.userInterruption, .responseLimit, .unexpectedTermination, .connectionDropped] {
            XCTAssertEqual(Outcome(ending: .waitingForUser, reason: reason), .interrupted, "\(reason)")
        }
        XCTAssertEqual(Outcome(ending: .waitingForUser), .interrupted)
        for phase in AgentActivityPhase.allCases where phase != .failed {
            XCTAssertNotEqual(Outcome(ending: phase), .attention, "\(phase) must not look like a failure")
        }
    }

    func testBackgroundSuspensionIsPausedNotAttention() {
        XCTAssertEqual(Outcome(ending: .suspended), .paused)
        XCTAssertEqual(Outcome(ending: .suspended, reason: .backgroundTimeExpired), .paused)
    }

    func testEveryOutcomeHasItsOwnIconAndWords() {
        let all: [Outcome] = [.done, .attention, .stopped, .paused, .interrupted, .waiting, .unknown]
        XCTAssertEqual(Set(all.map(\.symbol)).count, all.count)
        XCTAssertEqual(Set(all.map(\.label)).count, all.count)
        // 感叹号只留给失败。
        XCTAssertEqual(all.filter { $0.symbol.contains("exclamationmark") }, [.attention])
    }

    func testFailureSaysWhy() {
        let net = AgentRunEnding(phase: .failed, reason: .connectionDropped)
        XCTAssertTrue(net.isFailure)
        XCTAssertNotEqual(net.label, Outcome.attention.label)
        XCTAssertTrue(net.label.contains(AgentRunEnding.failureCause(.connectionDropped)!))
        XCTAssertNotEqual(net.label, AgentRunEnding(phase: .failed, reason: .authenticationRequired).label)
        // 说不清原因时只写「失败」,不编。
        XCTAssertEqual(AgentRunEnding(phase: .failed, reason: nil).label, Outcome.attention.label)
        XCTAssertEqual(AgentRunEnding(phase: .failed, reason: .userQuestion).label, Outcome.attention.label)
    }

    func testNonFailuresAreNotFailuresAndReadDifferently() {
        let endings = [
            AgentRunEnding(phase: .completed, reason: nil),
            AgentRunEnding(phase: .cancelled, reason: .userInterruption),
            AgentRunEnding(phase: .suspended, reason: .backgroundTimeExpired),
            AgentRunEnding(phase: .waitingForUser, reason: .userInterruption),
            AgentRunEnding(phase: .waitingForPermission, reason: .permissionApproval),
            AgentRunEnding(phase: .waitingForUser, reason: .userQuestion),
            AgentRunEnding(phase: .unverified, reason: nil),
        ]
        XCTAssertTrue(endings.allSatisfy { !$0.isFailure })
        XCTAssertEqual(Set(endings.map(\.label)).count, endings.count)
    }

    /// 真机两例:API Key 被拒(duo 10-24 18:06)、后台断网重试耗尽(iPad 10-22 20:08)。
    func testDeviceFailureTextsClassifyToTheirReason() {
        func ending(_ text: String) -> AgentRunEnding {
            let c = AgentRunCompletion(userCancelled: false, canResume: false, backgroundSuspended: false, failureText: text)
            return AgentRunEnding(phase: c.phase, reason: c.reason)
        }
        XCTAssertEqual(ending("API Key 无效：[forbidden] Request not allowed").reason, .authenticationRequired)
        XCTAssertEqual(ending("网络错误：网络连接已中断。").reason, .connectionDropped)
        // 同样的错误发生在后台挂起时是「已暂停」,不是失败。
        let parked = AgentRunCompletion(userCancelled: false, canResume: false, backgroundSuspended: true,
                                        failureText: "网络错误：网络连接已中断。")
        XCTAssertFalse(AgentRunEnding(phase: parked.phase, reason: parked.reason).isFailure)
    }

    func testMostUrgentOutcomeDecidesTheSharedCapsule() {
        XCTAssertEqual(Outcome.mostUrgent([.done, .attention, .paused]), .attention)
        XCTAssertEqual(Outcome.mostUrgent([.done, .waiting, .interrupted]), .waiting)
        XCTAssertEqual(Outcome.mostUrgent([.done, .interrupted, .paused]), .interrupted)
        XCTAssertEqual(Outcome.mostUrgent([.stopped, .stopped]), .stopped)
        XCTAssertEqual(Outcome.mostUrgent([.stopped, .done]), .done)
        XCTAssertEqual(Outcome.mostUrgent([]), .done)
    }

    func testOutcomeRoundTripsThroughCodable() throws {
        for outcome in [Outcome.paused, .interrupted, .waiting, .unknown] {
            var snap = LiveSessionSnapshot(sessionId: "s", title: "t", toolIcon: outcome.symbol, toolStatus: "", loopIteration: 1)
            snap.isCompleted = true
            snap.outcome = outcome
            let data = try JSONEncoder().encode(snap)
            let decoded = try JSONDecoder().decode(LiveSessionSnapshot.self, from: data)
            XCTAssertEqual(decoded.outcome, outcome)
            XCTAssertTrue(decoded.isCompleted)
        }
    }

    /// 系统后台进度条(BGContinuedProcessingTask)的三处假失败,源码层钉住。
    func testContinuedProcessingNeverReportsAFalseFailure() throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
        let src = try String(contentsOf: root.appendingPathComponent("Agent/Chat/AIChatViewModel+BackgroundTask.swift"),
                             encoding: .utf8)
        // 1. 进度每一跳都推,不再只在「后台 + 有限后台时间」推(那条路真机上从没走到过)。
        let timer = try XCTUnwrap(src.range(of: "func startBackgroundStatusTimer()"))
        let body = String(src[timer.upperBound...].prefix(900))
        let tick = try XCTUnwrap(body.range(of: "noteContinuedProgress()"))
        let fgGate = try XCTUnwrap(body.range(of: "applicationState != .active"))
        XCTAssertLessThan(tick.lowerBound, fgGate.lowerBound, "progress must tick before the foreground gate")
        XCTAssertFalse(body.contains("timer.invalidate()\n                self.backgroundStatusTimer = nil"),
                       "unlimited background time must not stop the progress timer")
        // 2. 收尾成败只看 AgentRunEnding:可续跑的中断不是失败。
        XCTAssertTrue(src.contains("success: !ending.isFailure"))
        // 3. 系统拉起时这一轮已结束:按成功收,不凭空报失败。
        let attach = try XCTUnwrap(src.range(of: "private func attach("))
        XCTAssertTrue(String(src[attach.upperBound...].prefix(400)).contains("task.setTaskCompleted(success: true)"))
        XCTAssertFalse(String(src[attach.upperBound...].prefix(400)).contains("success: false"))
    }
}
