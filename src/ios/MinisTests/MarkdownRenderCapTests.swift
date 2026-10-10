import Foundation
import XCTest

/// [T-r3-B21] Hard render cap: the parser / TextKit never see more than
/// MarkdownRenderCap.maxMarkdownScalars; the overflow is plain text, capped too.
final class MarkdownRenderCapTests: XCTestCase {
    func testRenderCap_withinCapIsUntouched() {
        let text = String(repeating: "正常长度的回复。\n", count: 1_000)
        XCTAssertNil(MarkdownRenderCap.split(text))
        XCTAssertEqual(MarkdownRenderCap.head(text), text)
    }

    func testRenderCap_1MBSingleLineIsCappedQuickly() throws {
        let text = String(repeating: "x", count: 1_000_000)
        let start = Date()
        let split = try XCTUnwrap(MarkdownRenderCap.split(text))
        XCTAssertLessThan(Date().timeIntervalSince(start), 1.0)
        XCTAssertEqual(split.head.unicodeScalars.count, MarkdownRenderCap.maxMarkdownScalars)
        XCTAssertEqual(split.overflow.unicodeScalars.count, MarkdownRenderCap.maxOverflowScalars)
        XCTAssertTrue(split.overflowTruncated)
        XCTAssertTrue(text.hasPrefix(split.head + split.overflow))
    }

    func testRenderCap_cutsAtLineBoundaryAndKeepsEveryScalar() throws {
        let line = "第 N 行：混合 emoji 🙂 与 **markdown**，用于测试截断。\n"
        var text = ""
        while text.unicodeScalars.count < 230_000 { text += line }
        let split = try XCTUnwrap(MarkdownRenderCap.split(text))
        XCTAssertTrue(split.head.hasSuffix("\n"), "cut after a newline, not mid-line")
        XCTAssertLessThanOrEqual(split.head.unicodeScalars.count, MarkdownRenderCap.maxMarkdownScalars)
        XCTAssertFalse(split.overflowTruncated)
        XCTAssertEqual(split.head + split.overflow, text, "nothing lost below the overflow cap")
    }
}
