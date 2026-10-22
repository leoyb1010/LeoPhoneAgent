import XCTest

/// [up-perf-ios] 1.77.6 真机数据挂了三条性能预算(fg.frame p90、scroll.hitch p90、启动那一秒的日志行数)。
/// 纯逻辑直接测;逻辑测试编译不了的接线按源码钉住(同 LaunchForegroundPerfTests 的做法)。
final class ForegroundPerfBudgetFixTests: XCTestCase {
    private func source(_ relative: String) throws -> String {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
        return try String(contentsOf: root.appendingPathComponent(relative), encoding: .utf8)
    }

    // MARK: - fg.frame 拆分字段

    func testTimelineSplitsFirstFrameActiveAndStall() {
        var t = ForegroundFrameTimeline(start: 100.0)
        t.tick(100.020)            // 第一帧:20 ms
        t.tick(100.037)
        t.tick(100.437)            // 主线程空档 400 ms
        t.markActive(100.800)      // 系统转场 / 排队到 800 ms 才 active
        t.tick(100.817)
        t.markActive(101.5)        // 只认第一次
        XCTAssertEqual(t.fields["first"], 20)
        XCTAssertEqual(t.fields["active"], 800)
        XCTAssertEqual(t.fields["stall"], 400)
    }

    func testTimelineCountsTheGapBeforeTheFirstFrame() {
        var t = ForegroundFrameTimeline(start: 10.0)
        t.tick(10.3)               // willEnterForeground 之后主线程 300 ms 没空出来
        t.tick(10.316)
        XCTAssertEqual(t.fields["first"], 300)
        XCTAssertEqual(t.fields["stall"], 300)
        XCTAssertNil(t.fields["active"])
    }

    func testTimelineWritesNothingItDidNotMeasure() {
        let t = ForegroundFrameTimeline(start: 1.0)
        XCTAssertTrue(t.fields.isEmpty)
    }

    func testFgFrameKeepsItsDefinitionAndAddsTheSplit() throws {
        let perf = try source("Diagnostics/LeoPerf.swift")
        // `ms` 仍是 willEnterForeground → didBecomeActive 之后的第一帧(门禁读它),只是多带几个字段。
        XCTAssertTrue(perf.contains("let ms = (CACurrentMediaTime() - began) * 1000"))
        XCTAssertTrue(perf.contains("LeoPerf.record(\"fg.frame\", ms: ms, extra: ForegroundFrameMeter.shared.finish())"))
        XCTAssertTrue(perf.contains("ForegroundFrameMeter.shared.begin(at: now)"))
        XCTAssertTrue(perf.contains("ForegroundFrameMeter.shared.markActive(at: CACurrentMediaTime())"))
        // 回前台的画面已经在屏幕上:从 willEnterForeground 起就计卡顿,回后台关掉。
        let wef = try XCTUnwrap(perf.range(of: "forName: UIApplication.willEnterForegroundNotification"))
        let dba = try XCTUnwrap(perf.range(of: "forName: UIApplication.didBecomeActiveNotification"))
        XCTAssertTrue(perf[wef.upperBound..<dba.lowerBound].contains("HangCounter.shared.setActive(true)"))
        let deb = try XCTUnwrap(perf.range(of: "forName: UIApplication.didEnterBackgroundNotification"))
        XCTAssertTrue(perf[deb.upperBound..<wef.lowerBound].contains("HangCounter.shared.setActive(false)"))
    }

    // MARK: - 回前台之后的非界面工作

    func testSettlePolicyWaitsForTheFirstFrameWindow() {
        XCTAssertEqual(ForegroundSettlePolicy.decide(sinceAnchor: 0, scrolling: false, inForeground: true),
                       .wait(ForegroundSettlePolicy.settleDelay))
        XCTAssertEqual(ForegroundSettlePolicy.decide(sinceAnchor: 1.0, scrolling: false, inForeground: true),
                       .wait(ForegroundSettlePolicy.settleDelay - 1.0))
        XCTAssertEqual(ForegroundSettlePolicy.decide(sinceAnchor: 1.6, scrolling: false, inForeground: true), .run)
    }

    func testSettlePolicyYieldsToAScrollButNotForever() {
        XCTAssertEqual(ForegroundSettlePolicy.decide(sinceAnchor: 2, scrolling: true, inForeground: true),
                       .wait(ForegroundSettlePolicy.pollInterval))
        let deadline = ForegroundSettlePolicy.settleDelay + ForegroundSettlePolicy.maxScrollWait
        XCTAssertEqual(ForegroundSettlePolicy.decide(sinceAnchor: deadline - 0.1, scrolling: true, inForeground: true),
                       .wait(0.1), accuracy: 1e-9)
        XCTAssertEqual(ForegroundSettlePolicy.decide(sinceAnchor: deadline, scrolling: true, inForeground: true), .run)
        XCTAssertGreaterThan(ForegroundSettlePolicy.fallbackDelay, deadline, "兜底晚于正常路径,不抢跑")
    }

    func testSettlePolicyNeverHoldsWorkInTheBackgroundOrOutsideTheWindow() {
        XCTAssertEqual(ForegroundSettlePolicy.decide(sinceAnchor: 0, scrolling: true, inForeground: false), .run)
        XCTAssertEqual(ForegroundSettlePolicy.decide(sinceAnchor: nil, scrolling: true, inForeground: true), .run)
        XCTAssertEqual(ForegroundSettlePolicy.decide(sinceAnchor: -1, scrolling: false, inForeground: true), .run)
    }

    func testForegroundSyncAndCatchUpWorkIsDeferred() throws {
        let app = try source("MinisApp.swift")
        let kick = try XCTUnwrap(app.range(of: "fgSteps.next(\"fg.step.syncKick\")"))
        XCTAssertTrue(app[kick.upperBound...].prefix(200).contains("LeoPerf.afterForegroundSettles {"))
        XCTAssertTrue(app.contains("LeoPerf.afterForegroundSettles {\n            Self.runAfterForegroundSettled()"))
        let settled = try XCTUnwrap(app.range(of: "private static func runAfterForegroundSettled()"))
        let body = app[settled.upperBound...].prefix(6000)
        for work in ["SessionBadgeStore.shared.reconcileInterruptedSessions", "SkillStore.shared.reloadIfChangedOnDisk()",
                     "SessionSpotlightIndexer.reindexAll()", "MountedFoldersManager.shared.refreshAllWritability()"] {
            XCTAssertTrue(body.contains(work), "\(work) runs after the foreground settles")
        }
        let transport = try source("Agent/Sync/V2/ICloudSharedZoneTransport.swift")
        XCTAssertTrue(transport.contains("await LeoPerf.waitForForegroundSettle(resumeGrace: 0.3)\n                await self?.fetchRecentV2()"))
        let bka = try source("Agent/Background/BackgroundKeepAliveManager.swift")
        let deferred = try XCTUnwrap(bka.range(of: "guard !self.appIsInBackground else { return }\n                        ISHKernel.shared.endBackgroundCPUGovernor()"))
        XCTAssertTrue(bka[deferred.upperBound...].prefix(900).contains("self.cleanupLocationStateOnForeground()"))
        XCTAssertTrue(try source("Agent/Gateway/RelayEventCatchUp.swift")
            .contains("LeoPerf.afterNextFrame { Task { @MainActor in await self?.catchUp() } }"))
    }

    // MARK: - 启动那一秒

    func testProxiedDumpIsOneInfoLine() throws {
        let src = try source("Shared/NetworkMonitor.swift")
        XCTAssertTrue(src.contains("logger.info(\"\\(summary) probe=\\(probeTypes)\")"))
        XCTAssertFalse(src.contains("logger.info(\"[Proxy] dump (\\(reason)) extra keys"), "多行字典只进 .verbose")
        XCTAssertFalse(src.contains("logger.info(\"[Proxy] dump (\\(reason)) CFNetworkCopyProxiesForURL"))
        XCTAssertTrue(src.contains("logger.verbose(\"[Proxy] dump (\\(reason)) extra keys: \\(extras)\")"))
    }
}

private func XCTAssertEqual(_ a: ForegroundSettlePolicy.Decision, _ b: ForegroundSettlePolicy.Decision,
                            accuracy: Double, file: StaticString = #filePath, line: UInt = #line) {
    switch (a, b) {
    case (.run, .run): return
    case (.wait(let x), .wait(let y)): XCTAssertEqual(x, y, accuracy: accuracy, file: file, line: line)
    default: XCTFail("\(a) != \(b)", file: file, line: line)
    }
}
