import XCTest

/// [r7] Smoothness sweep of the daily flows, driven by the iPhone device log.
/// These views cannot run in the logic-test host, so the fixes are pinned at
/// the source level (same pattern as LaunchForegroundPerfTests).
final class DailyFlowSmoothnessTests: XCTestCase {
    private func source(_ relative: String) throws -> String {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
        return try String(contentsOf: root.appendingPathComponent(relative), encoding: .utf8)
    }

    /// Cold launch filled the credential cache moments earlier; marking it
    /// stale on that first activation re-read every instance from Keychain
    /// (device log: a second `caller=hasAnyCredential` round in the launch second).
    func testColdLaunchDoesNotRestaleFreshCredentialCache() throws {
        let app = try source("MinisApp.swift")
        XCTAssertTrue(app.contains("""
            if !isFirstActivation {
                ProviderCredentialCache.shared.markAllStale()
            }
"""))
    }

    /// Per-read Keychain lines were 29 of the 127 lines in the busiest launch second.
    func testKeychainReadTracesAreVerbose() throws {
        let store = try source("Providers/ProviderConfigStore.swift")
        for marker in ["read apiKey instanceId=\\(instanceId.prefix(8)) src=sync",
                       "read oauthToken instanceId=\\(instanceId.prefix(8)) hit=false",
                       "read oauthString instanceId=\\(instanceId.prefix(8)) acct=\\(account) src=sync"] {
            let line = try XCTUnwrap(store.components(separatedBy: "\n").first { $0.contains(marker) }, marker)
            XCTAssertTrue(line.contains(".verbose("), marker)
        }
    }

    /// 99 one-record "inbound from iCloud: applied=1" lines in one second.
    func testCleanSingleRecordInboundBatchIsVerbose() throws {
        let core = try source("Agent/Sync/V2/SyncCore.swift")
        XCTAssertTrue(core.contains("if summary.applied <= 1 && summary.quarantined == 0 && summary.dropped == 0 && summary.blocked == 0 {\n            logger.verbose(inboundLine)"))
    }

    /// 藏宝阁: back navigation reloads off main; item open reads SQLite off main;
    /// pending jobs read the library once per batch instead of once per job.
    func testTreasuryKeepsSQLiteOffTheMainThreadDuringNavigation() throws {
        let view = try source("Views/CollectionsView.swift")
        XCTAssertTrue(view.contains("if items.isEmpty { reload() } else { reloadOffMain() }"))
        XCTAssertTrue(view.contains("Task.detached(priority: .userInitiated) { CollectionStore.load() }"))
        XCTAssertTrue(view.contains("guard generation == reloadGeneration else { return }"))
        XCTAssertTrue(view.contains("(CollectionStore.isRemoteItem(itemID: id), CollectionStore.highlights(itemID: id))"))
        XCTAssertFalse(view.contains("isRemoteItem = CollectionStore.isRemoteItem(itemID: item.id)"))
        XCTAssertFalse(view.contains("guard let item = CollectionStore.load().first(where: { $0.id == job.itemID }) else {"))
    }

    /// 服务器任务: the live snippet keeps its identity (no `.id(snippet)` rebuild)
    /// and the card animates only the snippet appearing.
    func testPaperclipLiveSnippetKeepsIdentity() throws {
        let thread = try source("Views/Paperclip/PaperclipThreadViews.swift")
        XCTAssertFalse(thread.contains(".id(snippet)"))
        XCTAssertFalse(thread.contains("value: progress?.lastAssistantSnippet)"))
        XCTAssertTrue(thread.contains("value: progress?.lastAssistantSnippet?.isEmpty == false)"))
    }

    /// The terminal re-laid out its text container on every redraw.
    func testTerminalAssignsContainerSizeOnlyOnChange() throws {
        let canvas = try source("iSH/Terminal/TerminalCanvasView.swift")
        XCTAssertTrue(canvas.contains("if LeoTextContainer.needsResize(current: textView.textContainer.size, to: containerSize) {"))
    }
}
