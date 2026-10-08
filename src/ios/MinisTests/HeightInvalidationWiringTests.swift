import XCTest

/// [T-ios-bg-resume-collapse] / [T-ios-plaf-cache-footer-staleness] /
/// [T-ios-defer-retry-never-consumed]: the message list and markdown view are
/// not in the logic-test target, so these guards pin the invalidation wiring.
final class HeightInvalidationWiringTests: XCTestCase {
    private func source(_ relative: String) throws -> String {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
        return try String(contentsOf: root.appendingPathComponent(relative), encoding: .utf8)
    }

    func testForegroundResumeRemeasuresOnAnyLiveChange() throws {
        let list = try source("Agent/MessageList/CollectionViewMessageListV3.swift")
        XCTAssertFalse(list.contains("guard accumulated >= 200"), "small deltas still shift layout")
        XCTAssertTrue(list.contains("guard accumulated != 0 else"))
        XCTAssertFalse(list.contains("lastAssistantContentLength()"), "earlier live messages must count")
        XCTAssertTrue(list.contains("private func liveContentLength() -> Int"))
        XCTAssertTrue(list.contains("self.remeasureVisibleCells(reason: \"foreground"))
        XCTAssertTrue(list.contains("(cv.cellForItem(at: ip) as? SelfSizingCell)?.clearCachedHeight()"))
        XCTAssertTrue(list.contains("remeasureVisibleCells(reason: \"skip-after-defer"))
    }

    func testFooterShapeChangeDropsCachedHeight() throws {
        let list = try source("Agent/MessageList/CollectionViewMessageListV3.swift")
        XCTAssertTrue(list.contains("private struct FooterHeightShape: Equatable"))
        XCTAssertTrue(list.contains("hasRetryRow = bridge.autoRetryAttempt != 0"), "countdown ticks must not invalidate")
        XCTAssertTrue(list.contains("if !isInitialBridgeSetup, afterShape != beforeShape {"))
        XCTAssertTrue(list.contains("updateBridge(bridge, message: message, in: messages, isInitialBridgeSetup: true)"))
    }

    func testDeferredCorrectionConsumedAtSettle() throws {
        let list = try source("Agent/MessageList/CollectionViewMessageListV3.swift")
        let settle = try XCTUnwrap(list.range(of: "layout.deferSelfSizing = false"))
        let after = list[settle.upperBound...].prefix(800)
        XCTAssertTrue(after.contains("consumeDeferredCorrectionIfNeeded()"))
        let md = try source("Views/Chat/SelectableMarkdownView.swift")
        XCTAssertTrue(md.contains("func consumeDeferredCorrectionIfNeeded()"))
        XCTAssertTrue(md.contains("deferredCorrectionPending = true\n                armDeferredRemeasureBackstop()"))
        XCTAssertTrue(md.contains("maxDeferredRemeasureAttempts = 10"))
        XCTAssertTrue(md.contains("lastComputedHeight = newHeight\n        deferredCorrectionPending = false"))
    }

    func testCellDedupWindowKeptBounded() throws {
        let infra = try source("Agent/MessageList/MessageListInfrastructure.swift")
        XCTAssertTrue(infra.contains("measureDedupWindow: CFTimeInterval = 0.050"))
    }
}
