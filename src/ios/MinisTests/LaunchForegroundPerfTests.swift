import XCTest

/// [S4/S5/S6/WP8] Launch and foreground-return work: what may run inside the
/// returning frame, what is coalesced, throttled or memoized. Pure parts are
/// exercised directly; wiring in files the logic target cannot compile
/// (MinisApp, LeoPerf, BackgroundKeepAliveManager …) is pinned by source.
final class LaunchForegroundPerfTests: XCTestCase {
    private func source(_ relative: String) throws -> String {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
        return try String(contentsOf: root.appendingPathComponent(relative), encoding: .utf8)
    }

    // MARK: - Foreground plan

    func testForegroundPlan_blipAndChurnSkipFullPass() {
        XCTAssertEqual(ForegroundWorkPolicy.plan(isFirstActivation: true, backgroundedFor: nil), .full)
        XCTAssertEqual(ForegroundWorkPolicy.plan(isFirstActivation: false, backgroundedFor: nil), .resumeOnly,
                       "inactive↔active churn (banner, Control Center) never left the foreground")
        XCTAssertEqual(ForegroundWorkPolicy.plan(isFirstActivation: false, backgroundedFor: 1.9), .resumeOnly)
        XCTAssertEqual(ForegroundWorkPolicy.plan(isFirstActivation: false, backgroundedFor: 2.0), .full)
        XCTAssertEqual(ForegroundWorkPolicy.plan(isFirstActivation: false, backgroundedFor: 600), .full)
    }

    func testIntervalGate() {
        let t0 = Date(timeIntervalSince1970: 1_000)
        var gate = IntervalGate(interval: 300, last: t0)
        XCTAssertFalse(gate.admit(now: t0.addingTimeInterval(10)), "no reload right after creation")
        XCTAssertTrue(gate.admit(now: t0.addingTimeInterval(300)))
        XCTAssertFalse(gate.admit(now: t0.addingTimeInterval(400)))
        var fresh = IntervalGate(interval: 60)
        XCTAssertTrue(fresh.admit(now: t0))
    }

    // MARK: - Widget reload coalescing

    private final class FakeScheduler {
        var now = Date(timeIntervalSince1970: 0)
        var scheduled: [(at: Date, work: () -> Void)] = []
        func advance(to t: TimeInterval) {
            now = Date(timeIntervalSince1970: t)
            let due = scheduled.filter { $0.at <= now }
            scheduled.removeAll { $0.at <= now }
            due.forEach { $0.work() }
        }
    }

    func testWidgetReloads_coalescedIntoOnePassTwoSecondsAfterForeground() {
        let clock = FakeScheduler()
        var reloaded: [String] = []
        let coalescer = WidgetReloadCoalescer(
            window: 2, now: { clock.now },
            schedule: { delay, work in clock.scheduled.append((clock.now.addingTimeInterval(delay), work)) },
            reload: { reloaded.append($0) })
        coalescer.noteForeground()
        for kind in ["status", "iPadConsole", "memory", "status", "todayOverview", "iPadConsole", "briefing"] {
            coalescer.request(kind)
        }
        XCTAssertTrue(reloaded.isEmpty, "nothing wakes the widget process inside the foreground window")
        XCTAssertEqual(clock.scheduled.count, 1, "one pass")
        clock.advance(to: 1.9)
        XCTAssertTrue(reloaded.isEmpty)
        clock.advance(to: 2.0)
        XCTAssertEqual(reloaded, ["status", "iPadConsole", "memory", "todayOverview", "briefing"], "each kind once")
        // Outside the window requests pass straight through.
        coalescer.request("recentSessions")
        XCTAssertEqual(reloaded.last, "recentSessions")
        XCTAssertTrue(clock.scheduled.isEmpty)
    }

    func testRecentSessionsSignatureIgnoresTimestampsOnly() {
        let a = RecentSessionsWidgetSignature(ids: ["1", "2"], titles: ["A", "B"])
        XCTAssertEqual(a, RecentSessionsWidgetSignature(ids: ["1", "2"], titles: ["A", "B"]))
        XCTAssertNotEqual(a, RecentSessionsWidgetSignature(ids: ["2", "1"], titles: ["B", "A"]), "order matters")
        XCTAssertNotEqual(a, RecentSessionsWidgetSignature(ids: ["1", "2"], titles: ["A", "B2"]), "titles matter")
        let nine = (0..<9).map(String.init)
        XCTAssertEqual(RecentSessionsWidgetSignature(ids: nine, titles: nine),
                       RecentSessionsWidgetSignature(ids: nine.dropLast() + ["x"], titles: nine.dropLast() + ["x"]),
                       "only the top 8 are on the widget")
    }

    // MARK: - Memo

    func testKeyedMemoRecomputesOnlyOnKeyChange() {
        let memo = KeyedMemo<[String], Int>(capacity: 2)
        XCTAssertEqual(memo.value(for: ["a"]) { 1 }, 1)
        XCTAssertEqual(memo.value(for: ["a"]) { 99 }, 1)
        XCTAssertEqual(memo.value(for: ["b"]) { 2 }, 2)
        XCTAssertEqual(memo.value(for: ["a"]) { 99 }, 1, "two call sites with different lists both stay cached")
        XCTAssertEqual(memo.computeCount, 2)
        _ = memo.value(for: ["c"]) { 3 }
        XCTAssertEqual(memo.value(for: ["b"]) { 22 }, 22, "least recently used entry evicted")
    }

    func testHomeMemosWiredInContentView() throws {
        let text = try source("Views/ContentView.swift")
        XCTAssertTrue(text.contains("homeContextMemo.value(for: key) { computeHomeContextSnapshot() }"))
        XCTAssertTrue(text.contains("return groupedSessionIDsMemo.value(for: key)"))
        XCTAssertTrue(text.contains("migrationSubtitleRefreshInterval: UInt64 = 60"))
        XCTAssertTrue(text.contains("guard signature != recentSessionsWidgetSignature else { return }"))
        XCTAssertTrue(text.contains("if onScreenSessionId == nil, activeToolSheet == nil { LeoPerf.coldHomeReady() }"))
    }

    // MARK: - Skills fingerprint

    func testSkillDiskFingerprintChangesOnlyWhenSkillsChange() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("skills-fp-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: dir) }
        try FileManager.default.createDirectory(at: dir.appendingPathComponent("a"), withIntermediateDirectories: true)
        let skill = dir.appendingPathComponent("a/SKILL.md")
        try "name: a".write(to: skill, atomically: true, encoding: .utf8)
        let fp1 = SkillDiskFingerprint.compute(skillsDir: dir)
        XCTAssertEqual(fp1, SkillDiskFingerprint.compute(skillsDir: dir))
        try FileManager.default.setAttributes([.modificationDate: Date().addingTimeInterval(60)], ofItemAtPath: skill.path)
        let fp2 = SkillDiskFingerprint.compute(skillsDir: dir)
        XCTAssertNotEqual(fp1, fp2, "an edited SKILL.md is noticed")
        try FileManager.default.createDirectory(at: dir.appendingPathComponent("b"), withIntermediateDirectories: true)
        try FileManager.default.setAttributes([.modificationDate: Date().addingTimeInterval(120)], ofItemAtPath: dir.path)
        XCTAssertNotEqual(fp2, SkillDiskFingerprint.compute(skillsDir: dir), "a new skill folder is noticed")
    }

    // MARK: - Codex ceiling cache

    func testCodexCeilingReadsAreCachedButSeeExternalWrites() {
        let defaults = UserDefaults.standard
        let key = "codex.reasoningCeiling.v1"
        let saved = defaults.object(forKey: key)
        defer { defaults.set(saved, forKey: key) }
        defaults.set(["gpt-x": "high"], forKey: key)
        XCTAssertEqual(CodexReasoningCeiling.level(for: "GPT-X"), .high)
        defaults.set(["gpt-x": "low"], forKey: key)   // written behind save()'s back
        XCTAssertEqual(CodexReasoningCeiling.level(for: "gpt-x"), .low)
        defaults.removeObject(forKey: key)
        XCTAssertNil(CodexReasoningCeiling.level(for: "gpt-x"))
    }

    // MARK: - Wiring (source guards)

    func testForegroundWindowKeepsOnlyFirstFrameWork() throws {
        let app = try source("MinisApp.swift")
        let active = try XCTUnwrap(app.range(of: "        case .active:"))
        let inactive = try XCTUnwrap(app.range(of: "        case .inactive:"))
        let window = String(app[active.lowerBound..<inactive.lowerBound])
        XCTAssertTrue(window.contains("ForegroundWorkPolicy.plan("))
        XCTAssertTrue(window.contains("ProviderCredentialCache.shared.markAllStale()"))
        XCTAssertTrue(window.contains("ViewModelCache.shared.resumeAllStreamingUI()"))
        XCTAssertTrue(window.contains("SessionLockStore.shared.evaluateAppLock()"))
        XCTAssertTrue(window.contains("LeoPerf.afterNextFrame"))
        for deferred in ["cleanupStaleActivities", "updateMarkerPhase", "SkillStore.shared",
                         "resumableSessionIds", "ShortcutRunTracker", "WidgetDataMirror"] {
            XCTAssertFalse(window.contains(deferred), "\(deferred) must not run inside the foreground window")
        }
        XCTAssertTrue(window.contains("Task.detached(priority: .utility) {\n                ISHKernel.shared.refreshDns()"))
        XCTAssertTrue(app.contains("private static func runAfterForegroundFrame()"))
    }

    func testLaunchDoesEachSingletonInitOnceAndOffMain() throws {
        let app = try source("MinisApp.swift")
        XCTAssertTrue(app.contains("Task.detached(priority: .userInitiated) { _ = ChatStore.shared }"))
        XCTAssertTrue(app.contains("ProviderConfigStore.prefetchFromDisk()"))
        XCTAssertTrue(app.contains("AgentActivityLog.warmUpOffMain()"))
        XCTAssertFalse(app.contains("cleanupStaleActivities(source: \"MinisApp.init\")"))
        XCTAssertFalse(app.contains("MountedFoldersManager.shared.activateAll()"), "activated once, in didFinishLaunching")
        XCTAssertTrue(app.contains("LoggingManager.shared.startIfEnabled()"))
        let delegate = try source("AppDelegate.swift")
        XCTAssertFalse(delegate.contains("CLBackgroundActivitySession()"))
        XCTAssertTrue(delegate.contains("probeOrphanedLocationSessionAtLaunch()"))
        let bka = try source("Agent/Background/BackgroundKeepAliveManager.swift")
        XCTAssertFalse(bka.contains("private let locationManager = CLLocationManager()"), "created lazily")
        XCTAssertFalse(bka.contains("unconditional orphan-session retract on setup"))
        XCTAssertTrue(bka.contains("guard force || now.timeIntervalSince(Self.lastOrphanProbeAt) >= Self.orphanProbeInterval"))
        let push = try source("Agent/Gateway/PushRegistrar.swift")
        XCTAssertTrue(push.contains("guard now.timeIntervalSince(lastAuthorizationRefresh) >= 10"))
        let network = try source("Shared/NetworkMonitor.swift")
        XCTAssertFalse(network.contains("NSLog("))
        XCTAssertTrue(network.contains("if typesChanged {\n            dumpSystemProxySettings"))
        let models = try source("Providers/ProviderConfigStore.swift")
        XCTAssertTrue(models.contains("func refreshAllModelsIfNeeded(delay: TimeInterval = 10)"))
        XCTAssertTrue(models.contains("await autoRefreshModels(for: instance)\n        }"), "providers refreshed one at a time")
        let skills = try source("Agent/Session/SkillStore.swift")
        XCTAssertTrue(skills.contains("IntervalGate(interval: 300, last: Date())"))
    }

    func testStreamingResumeUsesCompileTimeCaller() throws {
        let vm = try source("Agent/Chat/AIChatViewModel.swift")
        XCTAssertTrue(vm.contains("func setStreamingUIUpdatesSuspended(_ suspended: Bool, caller: String = #function"))
        let start = try XCTUnwrap(vm.range(of: "func setStreamingUIUpdatesSuspended("))
        XCTAssertFalse(vm[start.lowerBound...].prefix(1500).contains("Thread.callStackSymbols["))
    }

    func testColdMetricEndsAtHomeReadyOrInputReady() throws {
        let perf = try source("Diagnostics/LeoPerf.swift")
        XCTAssertTrue(perf.contains("static let coldEndSteps: Set<String> = [\"homeReady\", \"inputReady\"]"))
        XCTAssertTrue(perf.contains("FirstFrameProbe.once { coldStep(\"firstFrame\") }"))
        XCTAssertTrue(perf.contains("FirstFrameProbe.once { coldStep(\"homeReady\") }"))
        let content = try source("Views/ContentView.swift")
        XCTAssertFalse(content.contains("LeoPerf.coldStep(\"firstFrame\")"), "firstFrame comes from the display link")
    }

    func testCrashMarkerAndAudioReadsLeaveTheMainThread() throws {
        let crash = try source("Diagnostics/CrashReporter.swift")
        let update = try XCTUnwrap(crash.range(of: "func updateMarkerPhase(phase: String) {"))
        let body = crash[update.lowerBound...].prefix(6000)
        XCTAssertTrue(body.contains("markerQueue.async {"))
        let audio = try source("Providers/Voice/AudioSessionCoordinator.swift")
        let apply = try XCTUnwrap(audio.range(of: "private func apply(reason: String) {"))
        let applyBody = String(audio[apply.lowerBound...].prefix(2500))
        let queueHop = try XCTUnwrap(applyBody.range(of: "Self.sessionQueue.async {\n            defer"))
        let read = try XCTUnwrap(applyBody.range(of: "session.category != cat"))
        XCTAssertLessThan(queueHop.lowerBound, read.lowerBound, "category reads happen on the session queue")
    }
}
