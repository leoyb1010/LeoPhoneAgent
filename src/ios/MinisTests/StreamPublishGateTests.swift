import XCTest

/// [T-ios-stream-publish-transition-gap] The SSE stream's manual publishes
/// must go through `publishUnlessTransitioning()` so an outgoing vm stops
/// notifying SwiftUI during a navigation transition's hosting-view teardown.
final class StreamPublishGateTests: XCTestCase {
    private func source(_ relative: String) throws -> String {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
        return try String(contentsOf: root.appendingPathComponent(relative), encoding: .utf8)
    }

    func testSSEStreamHasNoUngatedPublish() throws {
        let text = try source("Agent/Chat/AIChatViewModel+SSEStream.swift")
        XCTAssertFalse(text.contains("objectWillChange.send()"), "use publishUnlessTransitioning() on streaming paths")
        XCTAssertGreaterThanOrEqual(text.components(separatedBy: "publishUnlessTransitioning()").count - 1, 4)
    }

    func testGateElidesOnlyWhileTransitionSuspended() throws {
        let text = try source("Agent/Chat/AIChatViewModel.swift")
        XCTAssertTrue(text.contains("func publishUnlessTransitioning() {\n        guard !transitionSuspended else { return }\n        objectWillChange.send()"))
    }
}
