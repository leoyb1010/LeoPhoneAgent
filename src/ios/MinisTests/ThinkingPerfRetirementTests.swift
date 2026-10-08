import XCTest

/// [T-thinkperf-release-displaylink] The ThinkPerf hitch monitor (a 60 fps
/// CADisplayLink alive for the whole life of an expanded thinking block, in
/// Release too) and the per-token timing on the thinking stream are retired.
/// These sources are not compiled into the logic-test target, so the guard
/// reads them: a reintroduced display link or per-delta probe fails here.
final class ThinkingPerfRetirementTests: XCTestCase {
    private func source(_ relative: String) throws -> String {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
        return try String(contentsOf: root.appendingPathComponent(relative), encoding: .utf8)
    }

    func testAssistantBlockViewHasNoDisplayLinkMonitor() throws {
        let text = try source("Views/Chat/AssistantBlockView.swift")
        XCTAssertFalse(text.contains("CADisplayLink("), "thinking view must not run a per-frame display link")
        XCTAssertFalse(text.contains("final class ThinkingHitchMonitor"))
        XCTAssertFalse(text.contains("AppLogger(category: \"ThinkPerf\")"))
    }

    func testThinkingDeltaPathCarriesNoTimingProbe() throws {
        let text = try source("Agent/Chat/ChatModels.swift")
        guard let start = text.range(of: "func appendThinkingDelta("),
              let end = text.range(of: "func syncThinkingBuffer(", range: start.upperBound..<text.endIndex) else {
            return XCTFail("appendThinkingDelta not found")
        }
        let body = text[start.upperBound..<end.lowerBound]
        XCTAssertFalse(body.contains("Date()"), "no clock read per streamed token")
        XCTAssertFalse(body.contains("Logger"), "no logging per streamed token")
        XCTAssertFalse(text.contains("category: \"ThinkPerf\""))
    }
}
