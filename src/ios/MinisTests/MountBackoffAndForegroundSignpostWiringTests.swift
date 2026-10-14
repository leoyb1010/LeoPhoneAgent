import XCTest

/// 接线守卫(逻辑 target 编不进 MountedFoldersManager / MinisApp,和 LaunchForegroundPerfTests 同一做法):
///  - [T-mount-backoff] 失效挂载书签的退避:失败持久化、退避期内不解析、手动重试清零且不占主线程。
///    退避表本身见 MountActivationBackoffTests。
///  - [T-fg-attribution] 回前台各步骤的 signpost 区间。只加观测,不改行为:
///    原有的回前台守卫(LaunchForegroundPerfTests / DailyFlowSmoothnessTests)继续钉着原来的语句。
final class MountBackoffAndForegroundSignpostWiringTests: XCTestCase {
    private func source(_ relative: String) throws -> String {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
        return try String(contentsOf: root.appendingPathComponent(relative), encoding: .utf8)
    }

    // MARK: - 挂载书签退避

    func testFailureRecordIsPersistedWithTheEntryAndOldFilesStillDecode() throws {
        let manager = try source("Views/Settings/MountedFoldersManager.swift")
        // 和书签同一个 mounted-folders.json:新增两个键,老文件里没有就按「没失败过」。
        XCTAssertTrue(manager.contains("var lastFailureAt: Date?"))
        XCTAssertTrue(manager.contains("var consecutiveFailures: Int = 0"))
        XCTAssertTrue(manager.contains("case lastFailureAt, consecutiveFailures"))
        XCTAssertTrue(manager.contains("decodeIfPresent(Date.self, forKey: .lastFailureAt)"))
        XCTAssertTrue(manager.contains("decodeIfPresent(Int.self, forKey: .consecutiveFailures) ?? 0"))
    }

    func testLaunchPassSkipsBookmarksInsideTheirBackoffWindow() throws {
        let manager = try source("Views/Settings/MountedFoldersManager.swift")
        let pass = try XCTUnwrap(manager.range(of: "func ensureActivated() async {"))
        let end = try XCTUnwrap(manager.range(of: "func ensureActivated(timeout:", range: pass.upperBound..<manager.endIndex))
        let body = String(manager[pass.lowerBound..<end.lowerBound])
        // 整句钉住(`if` 紧挨着调用):别人把它改成 `true || …` 之类也会红。
        XCTAssertTrue(body.contains("if MountActivationBackoff.shouldAttempt(consecutiveFailures: entry.consecutiveFailures,"))
        XCTAssertTrue(body.contains("activationStates[entry.id] = .failed(Self.needsReauthorizationMessage)"),
                      "退避期内的书签标「需要重新授权」,不留在「检查中」")
        // 解析在后台任务里,而且并发:一个迟迟不回的书签只拖它自己。
        XCTAssertTrue(body.contains("Task.detached(priority: .userInitiated)"))
        XCTAssertTrue(body.contains("withTaskGroup(of: Void.self)"))
        XCTAssertTrue(body.contains("group.addTask { await Self.resolveAndCommit(entry: entry) }"))
        XCTAssertFalse(body.contains("URL(resolvingBookmarkData"), "启动这一轮自己不在主 actor 上解析书签")
    }

    func testEveryUnusableOutcomeIsRecordedAndEverySuccessClearsTheRecord() throws {
        let manager = try source("Views/Settings/MountedFoldersManager.swift")
        // 超时、解析失败、拿不到 scope(异步路径 + 同步 activate 路径)都计入。
        XCTAssertGreaterThanOrEqual(manager.components(separatedBy: "recordActivationFailure(id: entry.id)").count - 1, 5)
        // 书签只是快过期但挂载能用的那一支不能计入退避,否则下次启动会把能用的挂载整个跳过。
        let stale = try XCTUnwrap(manager.range(of: "activationStates[entry.id] = .stale\n                mountLog.warning(\"activate '\\(entry.name)' [\\(idPrefix)] bookmark stale and refresh failed\")"))
        let staleWindow = String(manager[manager.index(stale.lowerBound, offsetBy: -420)..<stale.lowerBound])
        XCTAssertFalse(staleWindow.contains("recordActivationFailure"))
        XCTAssertTrue(manager.contains("clearActivationFailures(id: entry.id)"))
    }

    func testManualRetryClearsBackoffAndResolvesOffTheMainThread() throws {
        let manager = try source("Views/Settings/MountedFoldersManager.swift")
        let retry = try XCTUnwrap(manager.range(of: "func retryActivation(id: UUID) async -> MountActivationState? {"))
        let body = String(manager[retry.lowerBound...].prefix(900))
        XCTAssertTrue(body.contains("clearActivationFailures(id: id)"))
        XCTAssertTrue(body.contains("await Self.resolveAndCommit(entry: entry)"))
        XCTAssertFalse(body.contains("URL(resolvingBookmarkData"))
        // 旧的同步入口(add / apple-files reauth 还在用)也是手动路径:一进来就清零。
        let activate = try XCTUnwrap(manager.range(of: "func activate(entry: MountedFolderEntry) -> MountActivationState {"))
        XCTAssertTrue(String(manager[activate.lowerBound...].prefix(700)).contains("clearActivationFailures(id: entry.id)"))
    }

    func testSettingsShowsReauthorizationStateAndRetry() throws {
        let view = try source("Views/Settings/MountedFoldersSettingsView.swift")
        XCTAssertTrue(view.contains("LeoCapsuleBadge(text: String(localized: \"需要重新授权\")"))
        XCTAssertTrue(view.contains("LeoInlineError("))
        XCTAssertTrue(view.contains("onRetry: { model.retry(id: entry.id) }"))
        XCTAssertTrue(view.contains("await MountedFoldersManager.shared.retryActivation(id: id)"))
        // 失败记录是持久化的,冷启动后、解析还没跑完之前也能判断。
        XCTAssertTrue(view.contains("guard entry.hasFailureStreak else { return false }"))
    }

    // MARK: - 回前台 signpost

    func testForegroundStepsAreSignpostedOnTheExistingPerfSignposter() throws {
        let app = try source("MinisApp.swift")
        XCTAssertTrue(app.contains("LeoPerf.signposter.beginInterval(name)"), "复用 LeoPerf 的 OSSignposter(同一个 subsystem)")
        XCTAssertFalse(app.contains("OSSignposter(subsystem"), "不另建 signposter")
        let names = [
            // scenePhase → .active 的同步部分
            "fg.step.activePass", "fg.step.lifecycleLog", "fg.step.foregroundPlan", "fg.step.credentialStale",
            "fg.step.scheduleResumeUI", "fg.step.resumeStreamingUI", "fg.step.evaluateAppLock",
            "fg.step.audioReassert", "fg.step.widgetNoteForeground", "fg.step.scheduleDetached",
            "fg.step.scheduleAfterFrame", "fg.step.syncKick", "fg.step.inactivePass",
            // 下一帧之后的 runAfterForegroundFrame
            "fg.step.afterFrame", "fg.step.pushRegistrar", "fg.step.crashReporterLaunch", "fg.step.resourceDiagStart",
            "fg.step.crashMarker", "fg.step.liveActivityCleanup", "fg.step.brainProvision",
            "fg.step.liveActivityDismiss", "fg.step.badgeKick", "fg.step.badgeResumableQuery", "fg.step.badgeReconcile",
            "fg.step.interruptionCheck", "fg.step.shortcutPendingCheck", "fg.step.skillsReloadKick",
            "fg.step.skillNotifierDrain", "fg.step.widgetKick", "fg.step.mountWritability", "fg.step.credentialDiagKick",
        ]
        for name in names {
            XCTAssertTrue(app.contains("\"\(name)\""), "\(name) 缺失")
        }
        // 名字是 StaticString:区间不分配字符串。
        XCTAssertTrue(app.contains("let name: StaticString"))
        XCTAssertTrue(app.contains("static func begin(_ name: StaticString) -> FgStepInterval"))
    }

    func testForegroundSignpostsDoNotChangeTheForegroundWindowContract() throws {
        let app = try source("MinisApp.swift")
        let active = try XCTUnwrap(app.range(of: "        case .active:"))
        let inactive = try XCTUnwrap(app.range(of: "        case .inactive:"))
        let window = String(app[active.lowerBound..<inactive.lowerBound])
        // 区间只是语句之间多出来的几行;被别的守卫钉住的原语句保持原样、原缩进。
        XCTAssertTrue(window.contains("            if !isFirstActivation {\n                ProviderCredentialCache.shared.markAllStale()\n            }"))
        XCTAssertTrue(window.contains("Task.detached(priority: .utility) {\n                ISHKernel.shared.refreshDns()"))
        // 收尾用 defer:early return(前台抖动只走一半流程)也会结束区间。
        XCTAssertTrue(window.contains("defer { fgSteps.finish() }"))
        XCTAssertTrue(window.contains("defer { fgActivePass.end() }"))
    }
}
