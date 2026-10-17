import XCTest

/// WP-46:2026-10-17 真机日志取证里列出的真实缺陷,每条一个回归测试。
final class WP46DeviceEvidenceFixTests: XCTestCase {
    private var iosRoot: URL {
        URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
    }
    private func source(_ path: String) throws -> String {
        try String(contentsOf: iosRoot.appendingPathComponent(path), encoding: .utf8)
    }

    // MARK: #1 崩溃记录器

    func testMarkerMergesOnlyIntoThisProcessesMarker() {
        XCTAssertTrue(CrashMarkerPolicy.mayMerge(storedPid: 42, currentPid: 42))
        XCTAssertFalse(CrashMarkerPolicy.mayMerge(storedPid: 41, currentPid: 42), "previous process's marker")
        XCTAssertFalse(CrashMarkerPolicy.mayMerge(storedPid: nil, currentPid: 42))
    }

    func testClassificationKeepsRealForegroundKillsAndSkipsNormalReclaims() {
        let reclaim = CrashMarkerPolicy.classify(lastPhase: "background", runningShell: false, memoryMB: 120,
                                                 memoryFreeMB: 2000, bgTaskRemaining: nil)
        XCTAssertFalse(reclaim.writesReport, "13 of 20 device reports were this")
        let watchdog = CrashMarkerPolicy.classify(lastPhase: "active", runningShell: false, memoryMB: 120,
                                                  memoryFreeMB: 2000, bgTaskRemaining: nil)
        XCTAssertTrue(watchdog.writesReport)
        XCTAssertTrue(watchdog.type.contains("FOREGROUND CRASH"))
        let jetsam = CrashMarkerPolicy.classify(lastPhase: "background", runningShell: false, memoryMB: 400,
                                                memoryFreeMB: 2000, bgTaskRemaining: nil)
        XCTAssertTrue(jetsam.writesReport)
        XCTAssertEqual(CrashMarkerPolicy.initialPhase(isBackgroundLaunch: true), "background")
        XCTAssertEqual(CrashMarkerPolicy.initialPhase(isBackgroundLaunch: false), "inactive")
    }

    func testStaleMarkerIsJudgedFirstThingInDidFinishLaunching() throws {
        let app = try source("AppDelegate.swift")
        let launch = try XCTUnwrap(app.range(of: "didFinishLaunchingWithOptions launchOptions"))
        let body = String(app[launch.upperBound...].prefix(900))
        let check = try XCTUnwrap(body.range(of: "CrashReporter.shared.onAppLaunch(isBackgroundLaunch:"))
        let firstOther = try XCTUnwrap(body.range(of: "BackgroundKeepAliveManager.probeOrphanedLocationSessionAtLaunch()"))
        XCTAssertLessThan(check.lowerBound, firstOther.lowerBound, "must run before anything else at launch")
        let reporter = try source("Diagnostics/CrashReporter.swift")
        XCTAssertTrue(reporter.contains("guard launched else { return }"))
        XCTAssertTrue(reporter.contains("CrashMarkerPolicy.mayMerge("))
        XCTAssertTrue(reporter.contains("logLinesOverride: (markerInfo?[\"lastLogLines\"]"),
                      "report must use the previous process's log lines")
    }

    // MARK: #2 旧日志切片

    func testScrubberCutsStreamHangSlices() {
        let log = """
        [10:06:01] [StreamHang] [WARN] [StreamHang]   assign[0] slice=0 │我的私人对话⏎第二行│
        [10:06:02] [CompactDiag] [INFO] pruned slice=12 fine
        [10:06:03] [Chat] [INFO] [Stage4-PageLoop] page=1 slice=[0.0,10.0] sliceH=10
        """
        let r = LegacyLogScrubber.scrub(log)
        XCTAssertFalse(r.text.contains("私人"))
        XCTAssertTrue(r.text.contains("assign[0] slice=0[redacted]"))
        XCTAssertTrue(r.text.contains("pruned slice=12 fine"), "numeric diagnostics stay")
        XCTAssertTrue(r.text.contains("slice=[0.0,10.0]"))
        XCTAssertEqual(r.changedLines, 1)
    }

    func testScrubRerunsUnderV2Key() throws {
        let manager = try source("Shared/LoggingManager.swift")
        XCTAssertTrue(manager.contains("\"leo.logs.legacyScrubCutoffDone.v2\""))
    }

    // MARK: #3 / #5 MCP 守护进程

    func testMCPCallLogIsParsedIntoDiagEvents() throws {
        let data = Data("""
        {"ts": 1800000000.5, "server": "exa", "method": "call", "tool": "search", "ok": false, "code": "TIMEOUT", "ms": 120000}
        {"ts": 1800000001, "server": "context7", "method": "tools", "ok": true, "code": "OK", "ms": 830}
        {"ts": 18000000
        """.utf8)
        let rows = MCPDaemonBridge.parse(data)
        XCTAssertEqual(rows.count, 2, "a half-written last line is skipped")
        let event = MCPDaemonBridge.event(for: rows[0])
        XCTAssertEqual(event.kind, "mcp.call")
        XCTAssertEqual(event.server, "exa")
        XCTAssertEqual(event.tool, "search")
        XCTAssertEqual(event.ok, false)
        XCTAssertEqual(event.code, "TIMEOUT")
        XCTAssertEqual(event.durationMs, 120000)
    }

    func testDrainMovesCallsIntoDiagJsonlAndDeletesSource() throws {
        let fm = FileManager.default
        let dir = fm.temporaryDirectory.appendingPathComponent("mcp-\(UUID().uuidString)")
        let logs = dir.appendingPathComponent("Logs")
        try fm.createDirectory(at: logs, withIntermediateDirectories: true)
        defer { try? fm.removeItem(at: dir) }
        try #"{"ts": 1800000000, "server": "exa", "method": "ping", "ok": true, "code": "OK", "ms": 5}"#
            .appending("\n").write(to: dir.appendingPathComponent("calls.jsonl"), atomically: true, encoding: .utf8)
        let ring = DiagnosticRing(directory: logs)
        XCTAssertEqual(MCPDaemonBridge.drainCallLog(in: dir, into: ring), 1)
        ring.flush()
        XCTAssertFalse(fm.fileExists(atPath: dir.appendingPathComponent("calls.jsonl").path))
        let written = try fm.contentsOfDirectory(at: logs, includingPropertiesForKeys: nil)
            .filter { $0.lastPathComponent.hasPrefix("diag-") }
            .map { try String(contentsOf: $0, encoding: .utf8) }.joined()
        XCTAssertTrue(written.contains("\"kind\":\"mcp.call\""))
        XCTAssertTrue(written.contains("\"server\":\"exa\""))
        XCTAssertEqual(MCPDaemonBridge.drainCallLog(in: dir, into: ring), 0, "nothing left to drain")
    }

    func testDaemonPortFileValidation() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("port-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        XCTAssertNil(MCPDaemonBridge.daemonPort(in: dir))
        try "51234\n".write(to: dir.appendingPathComponent("daemon.port"), atomically: true, encoding: .utf8)
        XCTAssertEqual(MCPDaemonBridge.daemonPort(in: dir), 51234)
        try "99999".write(to: dir.appendingPathComponent("daemon.port"), atomically: true, encoding: .utf8)
        XCTAssertNil(MCPDaemonBridge.daemonPort(in: dir))
    }

    func testIdleDaemonIsShutDownWhenBackgroundedWithoutSessions() throws {
        let app = try source("MinisApp.swift")
        XCTAssertTrue(app.contains("if idleForMCP { MCPDaemonBridge.requestShutdown(in: dir) }"))
        let daemon = try source("default_mount/usr/local/lib/leophoneagent-mcp-cli/daemon.py")
        XCTAssertFalse(daemon.contains("srv.settimeout(1.0)"), "no 1 s accept polling (busy ppoll after resume)")
        XCTAssertTrue(daemon.contains("record_call("))
    }

    // MARK: #4 / #6 性能埋点

    func testSuspensionAndBackgroundArtifactsAreFiltered() {
        XCTAssertTrue(PerfSanity.isSuspensionArtifact(hangMs: 1_188_000), "the 19.8-minute 'hang'")
        XCTAssertFalse(PerfSanity.isSuspensionArtifact(hangMs: 1_200))
        XCTAssertTrue(PerfSanity.spannedBackground(epochAtStart: 3, epochNow: 4))
        XCTAssertFalse(PerfSanity.spannedBackground(epochAtStart: 4, epochNow: 4))
        XCTAssertFalse(PerfSanity.spannedBackground(epochAtStart: nil, epochNow: 4))
    }

    func testPerfWiring() throws {
        let bka = try source("Agent/Background/BackgroundKeepAliveManager.swift")
        XCTAssertTrue(bka.contains("LeoPerf.markBackgroundLaunch()"))
        let perf = try source("Diagnostics/LeoPerf.swift")
        XCTAssertTrue(perf.contains("HangCounter.shared.start(active: launchActive)"))
        XCTAssertTrue(perf.contains("PerfSanity.isSuspensionArtifact(hangMs: ms)"))
        XCTAssertTrue(perf.contains("extra[\"bg\"] = true"))
    }

    func testSlowForegroundWritesStepBreakdownOnce() {
        var written: [(Double, [String: Double])] = []
        let ledger = FgStepLedger { written.append(($0, $1)) }
        ledger.beginForeground()
        ledger.add("fg.step.liveActivityCleanup", ms: 310)
        ledger.add("fg.step.sync", ms: 120)
        ledger.add("fg.step.sync", ms: 30)
        ledger.afterFrameFinished()
        XCTAssertTrue(written.isEmpty, "waits for fg.frame")
        ledger.frameRecorded(ms: 850)
        XCTAssertEqual(written.count, 1)
        XCTAssertEqual(written[0].0, 850)
        XCTAssertEqual(written[0].1["fg.step.sync"], 150)
        // 快的回前台不落盘
        ledger.beginForeground()
        ledger.add("fg.step.sync", ms: 10)
        ledger.frameRecorded(ms: 300)
        ledger.afterFrameFinished()
        XCTAssertEqual(written.count, 1)
    }

    // MARK: #8 Gemini 关思考

    func testGeminiOffEffortByFamily() {
        XCTAssertEqual(ThinkingRuleResolver.geminiOffEffort(modelId: "gemini-2.5-flash"), "none")
        XCTAssertEqual(ThinkingRuleResolver.geminiOffEffort(modelId: "gemini-2.5-pro"), "low")
        XCTAssertEqual(ThinkingRuleResolver.geminiOffEffort(modelId: "gemini-3.8-flash-high"), "minimal")
        XCTAssertEqual(ThinkingRuleResolver.geminiOffEffort(modelId: "google/gemini-3-pro-preview"), "low")
        XCTAssertNil(ThinkingRuleResolver.geminiOffEffort(modelId: "claude-sonnet-5-5"))
    }

    func testGeminiOffValueReachesTheRequestBody() {
        var body: [String: Any] = [:]
        let ctx = ThinkingResolveContext(modelId: "gemini-3.8-flash-high", supportsReasoning: true, level: .off,
                                         maxTokens: 4096, isOpenRouter: false, usesUnifiedReasoningEffort: false,
                                         isMistral: false, offEffort: ThinkingRuleResolver.geminiOffEffort(modelId: "gemini-3.8-flash-high"))
        _ = ThinkingRuleResolver.apply(to: &body, ctx: ctx)
        XCTAssertEqual(body["reasoning_effort"] as? String, "minimal", "\(body)")
    }

    // MARK: #9 长文折叠日志

    func testLongTextCollapseLogHasNumbersOnly() throws {
        let line = LongTextCollapse.logLine(totalChars: 68_857, headChars: 6_000, ms: 12.34)
        XCTAssertEqual(line, "[LongTextCollapse] collapsed chars=68857 head=6000 pages≈12 split=12.3ms")
        XCTAssertTrue(try source("Views/Chat/LongTextReader.swift").contains("longTextLogger.info(LongTextCollapse.logLine("))
    }
}
