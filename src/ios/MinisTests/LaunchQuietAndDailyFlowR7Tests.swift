import XCTest

/// [r7 round 2] Launch-second log volume (perf gate budget ≤ 80 lines; the
/// 1.64 device log had 127, ~89 after round 1) and daily-flow dead ends.
/// Pure helpers are exercised directly; wiring in files the logic target
/// cannot compile is pinned by source, like LaunchForegroundPerfTests.
final class LaunchQuietAndDailyFlowR7Tests: XCTestCase {
    private func source(_ relative: String) throws -> String {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
        return try String(contentsOf: root.appendingPathComponent(relative), encoding: .utf8)
    }

    // MARK: - Proxy dump

    func testDirectConnectionDetection() {
        let none: [String: Any] = ["HTTPEnable": 0, "HTTPSEnable": 0, "ExceptionsList": ["*.local"], "FTPPassive": 1,
                                   "__SCOPED__": ["en0": ["FTPPassive": 1]]]
        XCTAssertTrue(LaunchLogCompaction.isDirectConnection(settings: none, probeTypes: ["kCFProxyTypeNone"]))
        XCTAssertTrue(LaunchLogCompaction.isDirectConnection(settings: [:], probeTypes: []))
        XCTAssertFalse(LaunchLogCompaction.isDirectConnection(settings: ["HTTPSEnable": 1], probeTypes: ["kCFProxyTypeNone"]))
        XCTAssertFalse(LaunchLogCompaction.isDirectConnection(settings: ["ProxyAutoConfigEnable": 1], probeTypes: []))
        // VPN-injected proxy visible only to the per-URL probe still gets the full dump.
        XCTAssertFalse(LaunchLogCompaction.isDirectConnection(settings: none, probeTypes: ["kCFProxyTypeHTTPS"]))
    }

    func testNetworkMonitorLogsOneLinePerDirectDumpAndPathTick() throws {
        let src = try source("Shared/NetworkMonitor.swift")
        XCTAssertTrue(src.contains("let direct = LaunchLogCompaction.isDirectConnection(settings: dict, probeTypes: probeTypes)"))
        XCTAssertTrue(src.contains("            logger.verbose(summary)"))
        XCTAssertFalse(src.contains("logger.info(\"[Network] Path updated — refreshing DNS\")"), "path + action are one line now")
        // The first callback only sets the baseline (no second dump / eviction at launch).
        XCTAssertTrue(src.contains("let typesChanged = !isFirstPath && currentTypes != lastInterfaceTypes"))
    }

    func testISHKernelLogsMissingDnsHostPathOnce() throws {
        let src = try source("iSH/ISHKernel.m")
        XCTAssertTrue(src.contains("static BOOL loggedMissingHostPath = NO;"))
    }

    // MARK: - Per-item → one line

    func testCredentialSummaryIsOneLineAndNamesMissing() {
        let items: [LaunchLogCompaction.Credential] = [
            .init(id: "7E5F783B-AAAA", type: "anthropic", cred: "apiKey", enabled: true,
                  hasApiKey: true, hasOAuthToken: false, hasManualOAuth: false),
            .init(id: "B6A9FD1A-BBBB", type: "xAI", cred: "oauth", enabled: true,
                  hasApiKey: false, hasOAuthToken: false, hasManualOAuth: false),
            .init(id: "584D68B9-CCCC", type: "openCodeGo", cred: "apiKey", enabled: false,
                  hasApiKey: false, hasOAuthToken: false, hasManualOAuth: false),
        ]
        let line = LaunchLogCompaction.credentialSummary(items)
        XCTAssertFalse(line.contains("\n"))
        XCTAssertTrue(line.contains("n=3 missing=1"))
        XCTAssertTrue(line.contains("7E5F783B:anthropic/apiKey=ok"))
        XCTAssertTrue(line.contains("B6A9FD1A:xAI/oauth=MISSING"))
        XCTAssertTrue(line.contains("584D68B9:openCodeGo/apiKey=off"), "a disabled instance is not reported as missing")
        XCTAssertFalse(line.contains("AAAA"), "ids stay truncated to 8 characters")
    }

    func testLaunchSecondRepeatersAreFoldedOrVerbose() throws {
        let app = try source("MinisApp.swift")
        XCTAssertTrue(app.contains("logger.info(LaunchLogCompaction.credentialSummary(summary))"))
        XCTAssertFalse(app.contains("logger.info(\"appPhase=active instanceId="))
        XCTAssertTrue(app.contains("lifecycleLog.verbose(\"[FPSyncTrace] root=\\(name) path="))
        XCTAssertTrue(app.contains("lifecycleLog.info(\"[FPSyncTrace] container=\\(resolvedContainer) roots"))
        XCTAssertFalse(app.contains("[Share] onAppear — checking for pending share"))

        let store = try source("Agent/Chat/ChatStore.swift")
        XCTAssertFalse(store.contains("[iCloud]   device: id="), "one line for the device list")

        let bka = try source("Agent/Background/BackgroundKeepAliveManager.swift")
        XCTAssertTrue(bka.contains("if !shouldPlay && !silentAudioActive {\n            logger.verbose(evaluateLine)"))

        for (file, marker) in [("Providers/ProviderConfigDB.swift", "[v3] schema up-to-date"),
                               ("Providers/ProviderConfigStore.swift", "normalizeReferences no-op"),
                               ("Agent/Background/AgentLiveActivityManager.swift", "nothing to clean: systemActivities is empty"),
                               ("Agent/Session/MCPStore.swift", "[Migrate] skip: servers.json already at"),
                               ("Shared/ShareCoordinator.swift", "[Share] No pending share found")] {
            let text = try source(file)
            let line = try XCTUnwrap(text.components(separatedBy: "\n").first { $0.contains(marker) }, marker)
            XCTAssertTrue(line.contains(".verbose("), marker)
        }
    }

    // MARK: - Daily flow

    func testFailureClassifierIshIsAWholeWord() {
        XCTAssertEqual(AgentActivityFailureClassifier.reason(for: "Failed to establish a secure connection"), .connectionDropped)
        XCTAssertEqual(AgentActivityFailureClassifier.reason(for: "Could not finish the request: network lost"), .connectionDropped)
        XCTAssertEqual(AgentActivityFailureClassifier.reason(for: "iSH not ready"), .kernelUnavailable)
        XCTAssertEqual(AgentActivityFailureClassifier.reason(for: "Kernel boot failed"), .kernelUnavailable)
    }

    func testMissingModelErrorIsRecognisedInEveryShippedLanguage() {
        XCTAssertTrue(AgentActivityFailureClassifier.isMissingModel("No model configured. Add a provider in Settings."))
        XCTAssertTrue(AgentActivityFailureClassifier.isMissingModel("未配置模型。请在设置中添加服务商。"))
        XCTAssertTrue(AgentActivityFailureClassifier.isMissingModel("未設定模型。請在設置中新增服務商。"))
        XCTAssertFalse(AgentActivityFailureClassifier.isMissingModel("401 invalid API key"))
        XCTAssertFalse(AgentActivityFailureClassifier.isMissingModel(nil))
        XCTAssertFalse(AgentActivityFailureClassifier.isMissingModel(""))
    }

    func testMissingModelErrorOffersAddProviderNotRetry() throws {
        let list = try source("Agent/MessageList/CollectionViewMessageListV3.swift")
        let branch = try XCTUnwrap(list.range(of: "} else if AgentActivityFailureClassifier.isMissingModel(error) {"))
        let retry = try XCTUnwrap(list.range(of: "} else if let onRetry = bridge.onRetry {"))
        XCTAssertLessThan(branch.lowerBound, retry.lowerBound, "checked before the generic Retry")
        XCTAssertTrue(list[branch.lowerBound...].prefix(400).contains("pendingSettingsTarget = .providers"))
    }

    func testClearingSpeakersAsksFirst() throws {
        let view = try source("Views/Recording/RecordingDetailView.swift")
        XCTAssertTrue(view.contains("Button(role: .destructive) { confirmClearSpeakers = true }"))
        XCTAssertTrue(view.contains("Button(\"清除说话人\", role: .destructive) { controller.clearSpeakers(recordingId) }"))
        XCTAssertEqual(view.components(separatedBy: "controller.clearSpeakers(").count - 1, 1,
                       "the only call is behind the confirmation")
    }

    func testRecordingListReappearReadsOffMain() throws {
        let controller = try source("Agent/Recording/RecordingController.swift")
        XCTAssertTrue(controller.contains("let list = await Task.detached(priority: .userInitiated) { store.list() }.value"))
        XCTAssertTrue(controller.contains("guard startGeneration == self.listGeneration, list != self.recordings else { return }"))
        XCTAssertTrue(controller.contains("didSet { listGeneration &+= 1 }"))
        let list = try source("Views/Recording/RecordingListView.swift")
        XCTAssertTrue(list.contains(".onAppear { controller.reloadForDisplay() }"))
    }

    func testMoveToSearchShowsEmptyResultsState() throws {
        let chat = try source("Views/Chat/AIChatView.swift")
        XCTAssertTrue(chat.contains("if isSearching, searchMatchedIds != nil, displayedSessions.isEmpty {\n                    ContentUnavailableView.search(text: searchText)"))
    }

    func testNewUserVisibleStringsAreLocalized() throws {
        let data = try Data(contentsOf: URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .deletingLastPathComponent().appendingPathComponent("Localizable.xcstrings"))
        let root = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let strings = try XCTUnwrap(root["strings"] as? [String: Any])
        for key in ["检查 AI 服务商", "清除说话人标注?", "清除说话人",
                    "说话人标注和改过的名字都会清掉。之后可以重新区分说话人,需要再调用一次模型。", "Add Provider"] {
            let entry = try XCTUnwrap(strings[key] as? [String: Any], key)
            let locs = try XCTUnwrap(entry["localizations"] as? [String: Any], key)
            for lang in ["en", "zh-Hans", "zh-Hant"] { XCTAssertNotNil(locs[lang], "\(key) \(lang)") }
        }
    }
}
