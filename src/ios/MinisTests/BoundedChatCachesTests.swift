import XCTest

/// [T-vmcache-pools] / [T-vmcache-release] / [T-renderer-cache-bounded]:
/// ViewModelCache, SelectableMarkdownView and the cold-load path are not in
/// the logic-test target, so these guards read the sources the behaviour
/// depends on.
final class BoundedChatCachesTests: XCTestCase {
    private func source(_ relative: String) throws -> String {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
        return try String(contentsOf: root.appendingPathComponent(relative), encoding: .utf8)
    }

    private func body(of function: String, in text: String) -> Substring? {
        guard let start = text.range(of: function) else { return nil }
        var depth = 0
        var i = start.upperBound
        var opened = false
        while i < text.endIndex {
            let c = text[i]
            if c == "{" { depth += 1; opened = true }
            if c == "}" { depth -= 1; if opened && depth == 0 { return text[start.lowerBound...i] } }
            i = text.index(after: i)
        }
        return nil
    }

    func testEvictionReleasesInsteadOfCancelling() throws {
        let text = try source("Agent/Chat/ChatLifecycleSupport.swift")
        let evict = try XCTUnwrap(body(of: "private func evict(_ sessionId: String", in: text))
        XCTAssertFalse(evict.contains(".cancel("), "a cache-size policy must never stop running work")
        XCTAssertTrue(evict.contains("vm.releaseForEviction()"))
        let remove = try XCTUnwrap(body(of: "func remove(sessionId: String)", in: text))
        XCTAssertTrue(remove.contains("cancel(queuePolicy: .discardQueuedPrompts)"), "deletion still stops the chat")
    }

    func testEvictableRefusesEveryKindOfLiveWork() throws {
        let text = try source("Agent/Chat/ChatLifecycleSupport.swift")
        let guardBody = try XCTUnwrap(body(of: "private func isEvictable(", in: text))
        for condition in ["vm.isProcessing", "AIChatViewModel.activeSessionId", "SessionActivityTracker.shared.activeSessions",
                          "vm.isCompacting", "vm.compactAndSendRequestId != nil", "vm.postCompactDrainPending",
                          "!vm.promptQueue.isEmpty", "vm.compactTask != nil"] {
            XCTAssertTrue(guardBody.contains(condition), condition)
        }
        XCTAssertFalse(guardBody.contains("currentTask"), "currentTask is never reset after a normal turn")
    }

    func testDualPoolCaps() throws {
        let text = try source("Agent/Chat/ChatLifecycleSupport.swift")
        XCTAssertTrue(text.contains("private static let softCap: Int = 6"))
        XCTAssertTrue(text.contains("private static let backgroundSoftCap: Int = 10"))
        XCTAssertTrue(text.contains("evictPool(.normal, cap: Self.softCap)"))
        XCTAssertTrue(text.contains("evictPool(.background, cap: Self.backgroundSoftCap)"))
        XCTAssertTrue(try source("Agent/Background/QuietTaskScheduler.swift").contains("createDraft(pool: .background)"))
        XCTAssertTrue(try source("Agent/Session/WorkerPool.swift").contains("createDraft(pool: .background)"))
    }

    func testReleaseForEvictionTouchesNoRunningWork() throws {
        let text = try source("Agent/Chat/AIChatViewModel.swift")
        let release = try XCTUnwrap(body(of: "func releaseForEviction()", in: text))
        for forbidden in ["currentTask", "compactTask", "promptQueue", "cancel(", "isProcessing ="] {
            XCTAssertFalse(release.replacingOccurrences(of: "cancelKeepAlive(", with: "").contains(forbidden), forbidden)
        }
    }

    func testRendererCacheIsBoundedAndDrainable() throws {
        let text = try source("Views/Chat/SelectableMarkdownView.swift")
        XCTAssertTrue(text.contains("static let rendererCacheCap = 80"))
        XCTAssertTrue(text.contains("static func dropRenderer(for messageId: UUID)"))
        XCTAssertTrue(text.contains("static func dropAllRenderers() -> Int"))
        XCTAssertEqual(text.components(separatedBy: "SelectableMarkdownView.touchRenderer(mid)").count - 1, 2)
    }

    func testColdLoadPrecachesOnlyTheTail() throws {
        let text = try source("Agent/Chat/AIChatViewModel+Persistence.swift")
        XCTAssertTrue(text.contains("static let coldLoadPrecacheTailMessages = 80"))
        XCTAssertTrue(text.contains(".suffix(max(0, Self.coldLoadPrecacheTailMessages - eagerCount))"))
    }
}
