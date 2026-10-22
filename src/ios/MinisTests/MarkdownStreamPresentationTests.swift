import XCTest

/// [output-render] Chat answer presentation: list marker column, code label, the streaming word
/// reveal pacing, inline-math detection, and the streaming table-tail split around open fences.
final class MarkdownStreamPresentationTests: XCTestCase {

    // MARK: - List markers

    func testBulletGlyphPerDepthAreTextNotEmoji() {
        XCTAssertEqual(MarkdownListMarkers.bullet(depth: 0), "\u{2022}")
        XCTAssertEqual(MarkdownListMarkers.bullet(depth: 1), "\u{25E6}")
        // U+25AA has an emoji presentation; the text selector keeps it a small square in the marker color.
        XCTAssertEqual(MarkdownListMarkers.bullet(depth: 2), "\u{25AA}\u{FE0E}")
        XCTAssertEqual(MarkdownListMarkers.bullet(depth: 7), MarkdownListMarkers.bullet(depth: 2))
    }

    func testTaskBoxesComeFromOneFace() {
        XCTAssertEqual(MarkdownListMarkers.taskBox(completed: true), "\u{2611}")
        // Not U+2610 (☐): it falls back to Apple Symbols and draws smaller than ☑.
        XCTAssertEqual(MarkdownListMarkers.taskBox(completed: false), "\u{25A1}")
    }

    func testWidestOrdinalIsTheLastNumber() {
        XCTAssertEqual(MarkdownListMarkers.widestOrdinal(start: 1, count: 11), "11.")
        XCTAssertEqual(MarkdownListMarkers.widestOrdinal(start: 9, count: 1), "9.")
        XCTAssertEqual(MarkdownListMarkers.widestOrdinal(start: 98, count: 3), "100.")
        XCTAssertEqual(MarkdownListMarkers.widestOrdinal(start: 3, count: 0), "3.", "an empty list still has a sane width")
    }

    func testMarkerColumnHasAFloorAndGrowsWithTheWidestMarker() {
        XCTAssertEqual(MarkdownListMarkers.markerColumn(widestMarkerWidth: 6, minimum: 24, gap: 8), 24)
        XCTAssertEqual(MarkdownListMarkers.markerColumn(widestMarkerWidth: 23.2, minimum: 24, gap: 8), 32)
        XCTAssertEqual(MarkdownListMarkers.markerColumn(widestMarkerWidth: 40, minimum: 24, gap: 8), 48)
    }

    func testParsedLongOrderedListNeedsAWiderColumn() throws {
        let md = (1...11).map { "\($0). item \($0)" }.joined(separator: "\n")
        guard case let .numberedList(_, start, items) = try XCTUnwrap(MarkdownContent(md).blocks.first) else {
            return XCTFail("expected an ordered list")
        }
        XCTAssertEqual(MarkdownListMarkers.widestOrdinal(start: start, count: items.count), "11.")
    }

    // MARK: - Code label

    func testCodeLabel() {
        XCTAssertEqual(MarkdownCodeLabel.language(fenceInfo: nil), "text")
        XCTAssertEqual(MarkdownCodeLabel.language(fenceInfo: ""), "text")
        XCTAssertEqual(MarkdownCodeLabel.language(fenceInfo: "  "), "text")
        XCTAssertEqual(MarkdownCodeLabel.language(fenceInfo: "Swift"), "swift")
        XCTAssertEqual(MarkdownCodeLabel.language(fenceInfo: "python title=replay.py"), "python")
        XCTAssertEqual(MarkdownCodeLabel.language(fenceInfo: "ts{1,3}"), "ts")
        XCTAssertEqual(MarkdownCodeLabel.language(fenceInfo: String(repeating: "x", count: 80)).count, 24)
    }

    func testPartialFenceInfoParsesToThePartialWordUntilTheLineEnds() throws {
        // What the stream shows while the info line arrives in pieces: the view has to refresh
        // its label from the current attachment, or "swi" sticks for the whole block.
        func fenceInfo(_ md: String) throws -> String? {
            guard case let .codeBlock(info, _) = try XCTUnwrap(MarkdownContent(md).blocks.last) else { return nil }
            return info
        }
        XCTAssertEqual(MarkdownCodeLabel.language(fenceInfo: try fenceInfo("```swi")), "swi")
        XCTAssertEqual(MarkdownCodeLabel.language(fenceInfo: try fenceInfo("```swift\nlet x")), "swift")
    }

    // MARK: - Reveal pacing

    func testFirstBatchUsesTheShortWindow() {
        var pacer = StreamRevealPacer()
        let plan = pacer.plan(unitCount: 10, now: 100)
        XCTAssertEqual(plan.base, 100)
        XCTAssertEqual(plan.step, StreamRevealPacer.minWindow / 10, accuracy: 1e-9)
    }

    func testWindowFollowsTheFlushGapWithinBounds() {
        var pacer = StreamRevealPacer()
        _ = pacer.plan(unitCount: 4, now: 100)
        let plan = pacer.plan(unitCount: 10, now: 100.4)        // 400 ms flush cadence
        XCTAssertEqual(plan.step * 10, 0.34, accuracy: 1e-9)    // 85 % of the gap
        let slow = pacer.plan(unitCount: 10, now: 100.4 + 0.9)  // a slow gap is capped
        XCTAssertEqual(slow.step * 10, StreamRevealPacer.maxWindow, accuracy: 1e-9)
        let fast = pacer.plan(unitCount: 10, now: 100.4 + 0.9 + 0.05)
        XCTAssertEqual(fast.step * 10, StreamRevealPacer.minWindow, accuracy: 1e-9)
    }

    func testBatchesRevealInReadingOrder() {
        var pacer = StreamRevealPacer()
        _ = pacer.plan(unitCount: 2, now: 0)
        let first = pacer.plan(unitCount: 20, now: 0.5)          // 0.42 s window: last word starts ~0.9 s
        let lastOfFirst = first.base + first.step * 19
        let second = pacer.plan(unitCount: 5, now: 0.8)          // next flush lands before that
        XCTAssertGreaterThan(second.base, lastOfFirst, "starts after the previous batch's last word")
    }

    func testABurstCannotBuildABacklog() {
        var pacer = StreamRevealPacer()
        _ = pacer.plan(unitCount: 2, now: 0)
        _ = pacer.plan(unitCount: 20, now: 0.5)
        let burst = pacer.plan(unitCount: 5, now: 0.55)          // newline fast-path flush right after
        XCTAssertEqual(burst.base, 0.55 + StreamRevealPacer.maxLag, accuracy: 1e-9,
                       "ordering yields to a bounded lag")
    }

    func testIdleGapAndResetStartFresh() {
        var pacer = StreamRevealPacer()
        _ = pacer.plan(unitCount: 3, now: 0)
        let afterTool = pacer.plan(unitCount: 10, now: 5)        // e.g. text resumes after a tool call
        XCTAssertEqual(afterTool.base, 5)
        XCTAssertEqual(afterTool.step * 10, StreamRevealPacer.minWindow, accuracy: 1e-9)
        pacer.reset()
        XCTAssertNil(pacer.lastBatchAt)
        XCTAssertEqual(pacer.plan(unitCount: 0, now: 9), .init(base: 9, step: 0))
        XCTAssertNil(pacer.lastBatchAt, "an empty batch does not count as a flush")
    }

    // MARK: - Inline math

    func testSingleLetterInlineMathIsMath() {
        let (_, spans) = MarkdownMathExtractor.extract(from: "其中 $r$ 是压缩比,$xy$ 也是")
        XCTAssertEqual(spans.map(\.latex), ["r", "xy"])
        XCTAssertTrue(spans.allSatisfy { !$0.isBlock })
    }

    func testCurrencyAndDigitsStayText() {
        XCTAssertTrue(MarkdownMathExtractor.extract(from: "价格 $5").1.isEmpty)
        XCTAssertTrue(MarkdownMathExtractor.extract(from: "a $1$ b").1.isEmpty, "a lone digit is not a variable")
        XCTAssertTrue(MarkdownMathExtractor.extract(from: "a $é$ b").1.isEmpty, "ASCII letters only")
    }

    // MARK: - Streaming table tail vs. open fences

    func testInFlightTableRowIsSplitOff() {
        let md = "| a | b |\n|---|---|\n| 1 | 2"
        let split = splitStreamingTableTail(md)
        XCTAssertEqual(split.prefix, "| a | b |\n|---|---|\n")
        XCTAssertEqual(split.plainSuffix, "| 1 | 2")
    }

    func testCompletedLineIsNotSplit() {
        let md = "| a | b |\n|---|---|\n| 1 | 2 |\n"
        XCTAssertEqual(splitStreamingTableTail(md).plainSuffix, "")
    }

    func testPipedCodeLineInsideAnOpenFenceStaysInTheCodeBlock() {
        for md in ["```sh\ncat log | grep err",
                   "Run:\n\n```ts\ntype A = string | number",
                   "> ```sh\n> ps aux | head"] {
            let split = splitStreamingTableTail(md)
            XCTAssertEqual(split.prefix, md, md)
            XCTAssertEqual(split.plainSuffix, "", md)
        }
    }

    func testTableRowAfterAClosedFenceIsStillSplit() {
        let md = "```sh\na | b\n```\n\n| k | v |\n|---|---|\n| x | y"
        XCTAssertEqual(splitStreamingTableTail(md).plainSuffix, "| x | y")
    }

    func testExplicitFenceStateMatchesTheScanningOverload() {
        let cases = ["```sh\ncat a | b", "| a | b |\n|---|---|\n| 1", "plain | text", "no pipes", ""]
        for md in cases {
            let scanned = splitStreamingTableTail(md)
            let explicit = splitStreamingTableTail(md, endsInsideOpenFence: MarkdownFenceTracker.endsInsideOpenFence(md))
            XCTAssertEqual(scanned.prefix, explicit.prefix, md)
            XCTAssertEqual(scanned.plainSuffix, explicit.plainSuffix, md)
        }
    }

    func testPartialFenceIsOpenAtEveryChunkBoundary() {
        // Every prefix of a streamed fenced block (until its closing fence) is "inside an open
        // fence", so no chunk boundary can pull a piped line out of the box.
        let full = "Intro\n\n```sh\nls | wc -l\necho a | tr a b\n```\n"
        let closeStart = (full as NSString).range(of: "\n```\n", options: .backwards).location + 1
        let openEnd = (full as NSString).range(of: "```sh").location + 3
        for cut in openEnd..<closeStart {
            let prefix = (full as NSString).substring(to: cut)
            XCTAssertTrue(MarkdownFenceTracker.endsInsideOpenFence(prefix), "cut at \(cut): \(prefix.debugDescription)")
            XCTAssertEqual(splitStreamingTableTail(prefix).plainSuffix, "", "cut at \(cut)")
        }
    }

    // MARK: - Renderer wiring (SelectableMarkdownView is not in the logic-test target)

    private func source(_ relative: String) throws -> String {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
        return try String(contentsOf: root.appendingPathComponent(relative), encoding: .utf8)
    }

    func testRendererWiring() throws {
        let md = try source("Views/Chat/SelectableMarkdownView.swift")
        XCTAssertTrue(md.contains("splitStreamingTableTail(renderSource, endsInsideOpenFence: _tailFenceOpen)"),
                      "the streaming split shares the one fence scan")
        XCTAssertTrue(md.contains("renderer.streamingTailFenceOpen = isStreaming && _tailFenceOpen"))
        XCTAssertTrue(md.contains("if label.text != text { label.text = text }"), "code label follows the current fence info")
        XCTAssertTrue(md.contains("y: fragment.minY + location.y - image.size.height)"),
                      "inline math sits on the baseline")
        XCTAssertEqual(md.components(separatedBy: "attachmentViewOrigin(for: attachment, glyphRange: glyphRange,").count - 1, 3,
                       "new, reused and re-laid-out overlay views all place math by its baseline")
        XCTAssertTrue(md.contains("style.tabStops = stops"), "list content hangs on a tab stop")
        XCTAssertFalse(md.contains("UIFont.systemFont(ofSize: theme.baseFontSize * 1.25, weight: .bold)"),
                       "no enlarged bullet glyph (it made bulleted lines taller)")
        let fade = try source("Views/Chat/TextFadeAnimator.swift")
        XCTAssertTrue(fade.contains("let plan = pacer.plan(unitCount: wordRanges.count, now: now)"))
        XCTAssertTrue(fade.contains("if UIAccessibility.isReduceMotionEnabled { return false }"), "Reduce Motion: no fade")
    }
}
