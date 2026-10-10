import XCTest

/// [T-r3-markdown-hardening] Plan §2.1 P0 #6–#9 and the rendering P2s: model
/// text that used to overflow the stack, hang the main thread or trap is fed
/// through the real parser (`MarkdownContent` → cmark → Swift walker) and the
/// real pre-passes (`prepareMarkdownForRender` & co.).
final class MarkdownHostileInputTests: XCTestCase {

    private func blockquoteDepth(_ blocks: [BlockNode]) -> Int {
        var maxDepth = 0
        var stack: [([BlockNode], Int)] = [(blocks, 0)]
        while let (nodes, depth) = stack.popLast() {
            for node in nodes {
                if case .blockquote(let children) = node {
                    maxDepth = max(maxDepth, depth + 1)
                    stack.append((children, depth + 1))
                } else {
                    stack.append((node.children, depth))
                }
            }
        }
        return maxDepth
    }

    private func blockDepth(_ blocks: [BlockNode]) -> Int {
        var maxDepth = 0
        var stack: [([BlockNode], Int)] = [(blocks, 1)]
        while let (nodes, depth) = stack.popLast() {
            for node in nodes {
                maxDepth = max(maxDepth, depth)
                stack.append((node.children, depth + 1))
            }
        }
        return maxDepth
    }

    private func inlineDepth(_ inlines: [InlineNode]) -> Int {
        var maxDepth = 0
        var stack: [([InlineNode], Int)] = [(inlines, 1)]
        while let (nodes, depth) = stack.popLast() {
            for node in nodes {
                maxDepth = max(maxDepth, depth)
                stack.append((node.children, depth + 1))
            }
        }
        return maxDepth
    }

    // MARK: - P0 #6 nesting

    func testParse_2000NestedBlockquotesDoesNotCrash() {
        let md = String(repeating: ">", count: 2000) + " x"
        let content = MarkdownContent(md)
        XCTAssertFalse(content.blocks.isEmpty)
        XCTAssertLessThanOrEqual(blockquoteDepth(content.blocks), MarkdownNestingGuard.maxBlockquoteDepth)
        // Spaced markers are nested too.
        let spaced = MarkdownContent(String(repeating: "> ", count: 2000) + "y")
        XCTAssertLessThanOrEqual(blockquoteDepth(spaced.blocks), MarkdownNestingGuard.maxBlockquoteDepth)
        // Hashing the result (the renderer caches by hash) is bounded too.
        _ = content.hashValue
    }

    func testParse_deepListsAndEmphasisAreDepthLimited() {
        let lists = MarkdownContent(String(repeating: "- ", count: 2000) + "item")
        XCTAssertLessThanOrEqual(blockDepth(lists.blocks), MarkdownNestingGuard.maxBlockDepth + 2)
        _ = lists.hashValue
        let mixed = MarkdownContent(String(repeating: "> - ", count: 1000) + "z")
        XCTAssertLessThanOrEqual(blockDepth(mixed.blocks), MarkdownNestingGuard.maxBlockDepth + 2)
        let emphasis = MarkdownContent(String(repeating: "*a ", count: 3000) + "b" + String(repeating: " a*", count: 3000))
        for block in emphasis.blocks {
            if case .paragraph(let inlines) = block {
                XCTAssertLessThanOrEqual(inlineDepth(inlines), MarkdownNestingGuard.maxInlineDepth + 1)
            }
        }
        let links = MarkdownContent(String(repeating: "[", count: 5000) + "x" + String(repeating: "](u)", count: 5000))
        XCTAssertFalse(links.blocks.isEmpty)
    }

    func testDeepNestingKeepsTheTextVisible() {
        let content = MarkdownContent(String(repeating: "- ", count: 200) + "needle")
        var found = false
        var stack: [BlockNode] = content.blocks
        while let node = stack.popLast() {
            if case .paragraph(let inlines) = node,
               inlines.contains(where: { if case .text(let t) = $0 { return t.contains("needle") }; return false }) {
                found = true
            }
            stack.append(contentsOf: node.children)
        }
        XCTAssertTrue(found, "content past the depth limit is flattened, not dropped")
    }

    func testNormalBlockquotesAreUntouched() {
        let md = "> quote\n>> nested\n\n```\n>>>>>>>>>>>>> in code\n```"
        XCTAssertEqual(MarkdownNestingGuard.collapseDeepBlockquotes(md), md, "shallow quotes and code fences pass through")
        let content = MarkdownContent("> a\n>> b")
        XCTAssertEqual(blockquoteDepth(content.blocks), 2)
        let deepInCode = "```\n" + String(repeating: ">", count: 50) + "\n```"
        XCTAssertEqual(MarkdownNestingGuard.collapseDeepBlockquotes(deepInCode), deepInCode)
        let deep = String(repeating: ">", count: 12) + " x"
        XCTAssertEqual(MarkdownNestingGuard.collapseDeepBlockquotes(deep), String(repeating: ">", count: 8) + "\\" + String(repeating: ">", count: 4) + " x")
    }

    // MARK: - P0 #7 math extraction

    func testMathExtract_unclosedDollarsIsLinear() {
        let md = String(repeating: "$a ", count: 100_000)
        let start = CFAbsoluteTimeGetCurrent()
        let (cleaned, spans) = MarkdownMathExtractor.extract(from: md)
        let elapsed = CFAbsoluteTimeGetCurrent() - start
        XCTAssertLessThan(elapsed, 2.0, "100k unclosed $ must not be quadratic (took \(elapsed)s)")
        XCTAssertEqual(cleaned, md)
        XCTAssertTrue(spans.isEmpty)

        // Many unclosed \( and $$ across lines.
        let mixed = String(repeating: "\\( $$ \\[ x\n", count: 30_000)
        let t0 = CFAbsoluteTimeGetCurrent()
        _ = MarkdownMathExtractor.extract(from: mixed)
        XCTAssertLessThan(CFAbsoluteTimeGetCurrent() - t0, 2.0)
    }

    func testMathExtractSemanticsUnchanged() {
        func spans(_ s: String) -> [String] { MarkdownMathExtractor.extract(from: s).1.map(\.latex) }
        XCTAssertEqual(spans("Euler: $e^{i\\pi}+1=0$ done"), ["e^{i\\pi}+1=0"])
        XCTAssertEqual(spans("$$\\int_0^1 x\\,dx$$"), ["\\int_0^1 x\\,dx"])
        XCTAssertEqual(spans("\\[a^2\\] and \\(b_1\\)"), ["a^2", "b_1"])
        XCTAssertEqual(spans("costs $5 and $10 today"), [], "currency is not math")
        XCTAssertEqual(spans("escaped \\$x^2$ stays"), [], "an escaped opener is skipped")
        XCTAssertEqual(spans("$a\\$b^2$"), ["a\\$b^2"], "an escaped $ inside does not close")
        XCTAssertEqual(spans("$x^2 \n y$"), [], "inline math is single-line")
        XCTAssertEqual(spans("`$x^2$` code"), [], "inline code is skipped")
        XCTAssertEqual(spans("``a ` $x^2$ ``"), [], "a two-backtick span hides one backtick")
        XCTAssertEqual(spans("```\n$x^2$\n```\n$y^2$"), ["y^2"])
        XCTAssertEqual(spans("$a $b^2$"), ["a $b^2"], "the old scanner pairs with the next unspaced $")
    }

    // MARK: - P0 #8 SwiftMath nesting

    func testMath_10kNestedFracFallsBackWithoutCrash() {
        let hostile = String(repeating: "\\frac{", count: 10_000) + "1" + String(repeating: "}{2}", count: 10_000)
        XCTAssertFalse(MathLatexGuard.allowsNativeRender(hostile))
        XCTAssertGreaterThan(MathLatexGuard.nestingDepth(String(repeating: "{", count: 100)), MathLatexGuard.maxNativeNesting)
        XCTAssertFalse(MathLatexGuard.allowsNativeRender(String(repeating: "x+", count: 3000)), "> 4 KB goes to the fallback")
        XCTAssertFalse(MathLatexGuard.allowsNativeRender(String(repeating: "\\left(", count: 70) + "x" + String(repeating: "\\right)", count: 70)))
        XCTAssertTrue(MathLatexGuard.allowsNativeRender("\\frac{a}{b} + \\sqrt{x^2+1}"))
        XCTAssertTrue(MathLatexGuard.allowsNativeRender("\\{x\\} \\{y\\}"), "escaped braces are not nesting")
        XCTAssertLessThanOrEqual(MathLatexGuard.fallbackSource(hostile).count, MathLatexGuard.maxFallbackCharacters + 2)
        // The extractor hands the formula over intact; the renderer decides.
        let (_, spans) = MarkdownMathExtractor.extract(from: "$$" + hostile + "$$")
        XCTAssertEqual(spans.count, 1)
    }

    // MARK: - P2 fences / backticks / unicode

    func testListNormalizationTracksLongAndTildeFences() {
        let md = "````\n```\n1) inside\n```\n````\n1) outside"
        XCTAssertEqual(normalizeMarkdownListSyntax(md), "````\n```\n1) inside\n```\n````\n1. outside")
        let tilde = "~~~\n• inside\n~~~\n• outside"
        XCTAssertEqual(normalizeMarkdownListSyntax(tilde), "~~~\n• inside\n~~~\n- outside")
        let indented = "1. step\n   ```bash\n   2) not a list\n   ```\n2) next"
        XCTAssertEqual(normalizeMarkdownListSyntax(indented), "1. step\n   ```bash\n   2) not a list\n   ```\n2. next")
    }

    func testFenceTrackerRules() {
        var f = MarkdownFenceTracker()
        XCTAssertTrue(f.consume("````md"))
        XCTAssertTrue(f.consume("```"), "a shorter fence does not close")
        XCTAssertTrue(f.consume("~~~~"), "a different fence character does not close")
        XCTAssertTrue(f.consume("````  "))
        XCTAssertFalse(f.isOpen)
        XCTAssertFalse(f.consume("``inline`` code"), "inline code is not a fence")
        XCTAssertFalse(f.consume("text"))
    }

    func testBacktickRunsAreLinear() {
        // Runs of growing length, none closed: the old matcher rescanned the
        // rest of the line per run.
        var line = ""
        for k in 1...300 { line += String(repeating: "`", count: k) + " a " }
        line += " **粗体** "
        let start = CFAbsoluteTimeGetCurrent()
        _ = fixEmphasisPairsForCJK(line)
        _ = MarkdownMathExtractor.extract(from: line + " $x^2$")
        XCTAssertLessThan(CFAbsoluteTimeGetCurrent() - start, 2.0)

        let index = BacktickRunIndex(Array("a `x` b ``y`` `z`"))
        XCTAssertEqual(index.closingRunStart(length: 1, after: 3), 4)
        XCTAssertEqual(index.closingRunStart(length: 2, after: 10), 11)
        XCTAssertNil(index.closingRunStart(length: 3, after: 0))
    }

    func testCombiningMarkFloodAndBidiOverridesAreStripped() {
        let zalgo = "e" + String(repeating: "\u{0301}", count: 10_000) + "x"
        let cleaned = MarkdownTextSanitizer.sanitize(zalgo)
        XCTAssertEqual(cleaned.unicodeScalars.count, 1 + MarkdownTextSanitizer.maxCombiningMarksPerBase + 1)
        XCTAssertEqual(MarkdownTextSanitizer.sanitize("pay \u{202E}gnp.exe\u{202C} now"), "pay gnp.exe now")
        XCTAssertEqual(MarkdownTextSanitizer.sanitize("a\u{2066}b\u{2069}c"), "abc")
        for legit in ["Tiếng Việt có dấu", "ภาษาไทย", "हिन्दी", "👨‍👩‍👧‍👦 ❤️", "plain ascii", "中文内容"] {
            XCTAssertEqual(MarkdownTextSanitizer.sanitize(legit), legit, legit)
        }
        // And through the parser: the flood does not reach the AST.
        let content = MarkdownContent(zalgo)
        if case .paragraph(let inlines)? = content.blocks.first, case .text(let t)? = inlines.first {
            XCTAssertLessThan(t.unicodeScalars.count, 20)
        } else {
            XCTFail("expected a paragraph")
        }
    }

    /// [B21 parsing side] A 1 MB line without spaces is parsed only up to the
    /// cap; the rest arrives intact as one plain code block.
    func testParse_1MBSingleLineIsCappedAndFast() {
        let md = "intro\n" + String(repeating: "a", count: 1_000_000)
        let start = CFAbsoluteTimeGetCurrent()
        let content = MarkdownContent(prepareMarkdownForRender(md))
        XCTAssertLessThan(CFAbsoluteTimeGetCurrent() - start, 5.0)
        guard case .codeBlock(_, let tail)? = content.blocks.last else { return XCTFail("tail becomes a code block") }
        var total = tail.count
        for block in content.blocks.dropLast() {
            if case .paragraph(let inlines) = block {
                for case .text(let t) in inlines { total += t.count }
            }
        }
        XCTAssertEqual(total, md.count - 1, "nothing is lost (the newline is the paragraph break)")
        let (head, overflow) = MarkdownSizeGuard.split("short text")
        XCTAssertEqual(head, "short text")
        XCTAssertNil(overflow)
        let lines = String(repeating: "line of text\n", count: 20_000) // 260k chars
        let split = MarkdownSizeGuard.split(lines)
        XCTAssertTrue(split.head.hasSuffix("\n"), "cuts on a line boundary when one is near")
        XCTAssertEqual(split.head + (split.tail ?? ""), lines)
    }

    func testPrepareMarkdownStillRendersOrdinaryContent() {
        let md = "# Title\n\n1) one\n2) two\n\n| a | b |\n|---|---|\n| 1 | 2 |\nafter\n\n**粗体：**内容 and `code` $x^2$"
        let content = MarkdownContent(prepareMarkdownForRender(md))
        XCTAssertTrue(content.blocks.contains { if case .heading = $0 { return true }; return false })
        XCTAssertTrue(content.blocks.contains { if case .numberedList = $0 { return true }; return false })
        XCTAssertTrue(content.blocks.contains { if case .table = $0 { return true }; return false })
    }
}
