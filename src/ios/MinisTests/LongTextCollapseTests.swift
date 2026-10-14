import Foundation
import XCTest

/// [T-long-reply-collapse] 超长回复折叠 / 阅读器分页的纯逻辑。
/// 切分只看 UTF-8 字节上的行与块,所以这里的小阈值(10 / 100)能精确断言每个切点;
/// 视图接线(流式不折叠、全文给阅读器、折叠块不吃全文缓存)在文件末尾用源码扫描钉住,
/// 因为 AssistantBlockView 不在逻辑测试 target 里。
final class LongTextCollapseTests: XCTestCase {

    // MARK: - Helpers

    private func run(_ char: String, _ count: Int) -> String {
        String(repeating: char, count: count)
    }

    private func lines(_ text: String) -> [String] {
        text.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
    }

    private func fenceLineCount(_ text: String) -> Int {
        lines(text).filter { $0.trimmingCharacters(in: .whitespaces).hasPrefix("```") }.count
    }

    private func split(_ text: String, _ threshold: Int) throws -> (head: String, tail: String) {
        try XCTUnwrap(LongTextCollapse.split(markdown: text, threshold: threshold))
    }

    // MARK: - Threshold boundary

    func testSplit_atOrBelowThreshold_returnsNil() {
        XCTAssertNil(LongTextCollapse.split(markdown: "", threshold: 10))
        XCTAssertNil(LongTextCollapse.split(markdown: "short", threshold: 10))
        XCTAssertNil(LongTextCollapse.split(markdown: run("字", 10), threshold: 10), "exactly the threshold is not collapsed")
        XCTAssertNil(LongTextCollapse.split(markdown: run("a\n", 5), threshold: 10))
        // UTF-8 字节数远大于阈值,但 Character 数没超:不能折叠(快速否决不能误伤 CJK / emoji)。
        XCTAssertNil(LongTextCollapse.split(markdown: run("👨‍👩‍👧‍👦", 10), threshold: 10))
    }

    func testSplit_defaultThresholdIs20K() {
        XCTAssertEqual(LongTextCollapse.collapseThreshold, 20_000)
        XCTAssertNil(LongTextCollapse.split(markdown: run("字", 20_000)))
        XCTAssertNotNil(LongTextCollapse.split(markdown: run("字", 20_001)))
    }

    func testSplit_oneCharacterOverThreshold_collapses() throws {
        let text = run("字", 11)
        let result = try split(text, 10)
        XCTAssertEqual(result.head.count, 10)
        XCTAssertEqual(result.tail.count, 1)
        XCTAssertEqual(result.head + result.tail, text)
    }

    func testSplit_nonPositiveThresholdDisablesCollapse() {
        XCTAssertNil(LongTextCollapse.split(markdown: run("a", 100), threshold: 0))
        XCTAssertNil(LongTextCollapse.split(markdown: run("a", 100), threshold: -5))
    }

    // MARK: - Paragraph boundary

    func testSplit_prefersParagraphBoundary() throws {
        let p1 = run("A", 40), p2 = run("B", 40), p3 = run("C", 40)
        let text = p1 + "\n\n" + p2 + "\n\n" + p3
        let result = try split(text, 100)
        XCTAssertEqual(result.head, p1 + "\n\n" + p2 + "\n\n")
        XCTAssertEqual(result.tail, p3)
    }

    func testSplit_boundaryExactlyAtBudgetIsAllowed() throws {
        // 预算恰好落在下一段开头:head 恰好 100 个字符。
        let text = run("A", 98) + "\n\n" + run("B", 40)
        let result = try split(text, 100)
        XCTAssertEqual(result.head.count, 100)
        XCTAssertEqual(result.tail, run("B", 40))
    }

    func testSplit_tailStartsOnContent_notOnBlankLines() throws {
        let text = run("A", 40) + "\n\n\n\n" + run("B", 80)
        let result = try split(text, 100)
        XCTAssertEqual(result.head, run("A", 40) + "\n\n\n\n")
        XCTAssertTrue(result.tail.hasPrefix("B"))
    }

    func testSplit_earlyParagraphBoundaryYieldsToLaterLineBoundary() throws {
        // 只有标题后一个空行,后面是一长串紧凑列表:不能只露出标题。
        let text = "title\n\n" + run("list item line\n", 30)
        let result = try split(text, 100)
        XCTAssertGreaterThan(result.head.count, 50)
        XCTAssertLessThanOrEqual(result.head.count, 100)
        XCTAssertTrue(result.head.hasSuffix("\n"))
        XCTAssertEqual(result.head + result.tail, text)
    }

    func testSplit_softWrappedParagraphCutsAtLastLineBoundary() throws {
        let text = run("soft wrapped line\n", 20)   // 18 字符一行,无空行
        let result = try split(text, 100)
        XCTAssertTrue(result.head.hasSuffix("\n"), "cut after a newline, not mid-line")
        XCTAssertLessThanOrEqual(result.head.count, 100)
        XCTAssertGreaterThan(result.head.count, 80)
        XCTAssertEqual(result.head + result.tail, text)
    }

    func testSplit_leadingBlankLinesNeverMakeABlankHead() throws {
        let text = "\n\n\n\n" + run("字", 200)
        let result = try split(text, 100)
        XCTAssertFalse(result.head.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        XCTAssertEqual(result.head + result.tail, text)
    }

    func testSplit_neverEndsOnALoneHeading() throws {
        // 预算内最后一个段落边界正好在「## 标题」之后:切点退到标题之前。
        let text = run("A", 60) + "\n\n## Section\n\n" + run("B", 60)
        let result = try split(text, 80)
        XCTAssertEqual(result.head, run("A", 60) + "\n\n")
        XCTAssertTrue(result.tail.hasPrefix("## Section"))
    }

    func testSplit_headingThenOneHugeParagraphFallsBackToASoftCutInsideIt() throws {
        let text = "# 标题\n\n" + run("字", 300)
        let result = try split(text, 100)
        XCTAssertTrue(result.head.hasPrefix("# 标题\n\n字"), "the heading keeps company with the start of its body")
        XCTAssertEqual(result.head.count, 100)
    }

    func testSplit_hashtagIsNotAHeading() throws {
        let text = run("A", 40) + "\n\n#话题 " + run("x", 20) + "\n\n" + run("C", 60)
        let result = try split(text, 100)
        XCTAssertTrue(result.head.hasSuffix("xxxx\n\n"), "#话题 has no space after the hash: an ordinary line")
    }

    func testSplit_budgetEntirelyInsideLeadingBlankLinesStillKeepsContentInHead() throws {
        let text = run("\n", 150) + run("字", 50)
        let result = try split(text, 100)
        XCTAssertTrue(result.head.contains("字"))
        XCTAssertEqual(result.head + result.tail, text)
    }

    func testSplit_whitespaceOnlyOverflowIsNotWorthCollapsing() {
        XCTAssertNil(LongTextCollapse.split(markdown: run("a", 10) + "\n\n\n", threshold: 10), "tail would be blank")
        XCTAssertNil(LongTextCollapse.split(markdown: run("字", 10) + " ", threshold: 10))
        XCTAssertNil(LongTextCollapse.split(markdown: run("\n", 200), threshold: 100), "nothing visible at all")
    }

    func testSplit_CRLFParagraphsKeepTheCRLFCharacterWhole() throws {
        let p = run("A", 40)
        let text = p + "\r\n\r\n" + p + "\r\n\r\n" + p
        let result = try split(text, 100)
        XCTAssertTrue(result.head.hasSuffix("\r\n"), "a CRLF is one Character; never cut between CR and LF")
        XCTAssertEqual(result.head.count, 84)
        XCTAssertEqual(result.head + result.tail, text)
    }

    // MARK: - Fenced code

    func testSplit_neverCutsInsideFencedCodeBlock() throws {
        let intro = "intro paragraph\n\n"
        let fence = "```swift\n" + run("code line\n", 20) + "```\n"
        let text = intro + fence + "\nafter paragraph"
        let result = try split(text, 100)
        XCTAssertEqual(result.head, intro, "the cut moves to before the block")
        XCTAssertFalse(result.head.contains("```"))
        XCTAssertTrue(result.tail.hasPrefix("```swift"))
    }

    func testSplit_unclosedFenceBeforeBudgetIsCutBeforeItsOpener() throws {
        let text = "intro\n\n```\n" + run("x\n", 100)
        let result = try split(text, 100)
        XCTAssertEqual(result.head, "intro\n\n")
        XCTAssertEqual(result.head + result.tail, text)
    }

    func testSplit_unclosedFenceFromTheStartFallsBackToALineBoundary() throws {
        let text = "```\n" + run("code\n", 100)
        let result = try split(text, 100)
        XCTAssertTrue(result.head.hasPrefix("```\n"))
        XCTAssertTrue(result.head.hasSuffix("\n"))
        XCTAssertLessThanOrEqual(result.head.count, 100)
        XCTAssertGreaterThan(result.head.count, 90)
        XCTAssertEqual(result.head + result.tail, text)
    }

    func testSplit_oversizedFirstFenceStaysWholeWhenItEndsWithinOvershoot() throws {
        // 围栏 128 字符 > 阈值 100,但在 1.5× 阈值内结束:整块留在 head,不切坏。
        let fence = "```\n" + run("code line\n", 12) + "```\n"
        XCTAssertEqual(fence.count, 128)
        let text = fence + "\nafter paragraph\n" + run("more text line\n", 20)
        let result = try split(text, 100)
        XCTAssertEqual(result.head, fence)
        XCTAssertEqual(fenceLineCount(result.head), 2)
    }

    func testSplit_oversizedFirstFenceBeyondOvershootIsCutAtALine() throws {
        let fence = "```\n" + run("code line\n", 40) + "```\n"   // 408 字符,远超 1.5× 阈值
        let text = fence + "\nafter"
        let result = try split(text, 100)
        XCTAssertLessThanOrEqual(result.head.count, 100)
        XCTAssertTrue(result.head.hasSuffix("\n"), "line granularity, never mid-line")
        XCTAssertEqual(result.head + result.tail, text)
    }

    func testSplit_longerOuterFenceIsNotClosedByInnerShorterFence() throws {
        let inner = run("```\nx\n```\n", 12)
        let text = "intro\n\n````md\n" + inner + "````\n\nafter " + run("z", 50)
        let result = try split(text, 100)
        XCTAssertEqual(result.head, "intro\n\n")
    }

    func testSplit_tildeFenceIsProtectedToo() throws {
        let text = "intro\n\n~~~\n" + run("tilde code\n", 20) + "~~~\n\nafter"
        let result = try split(text, 100)
        XCTAssertEqual(result.head, "intro\n\n")
    }

    func testSplit_fenceIndentedInsideAListItemIsProtected() throws {
        let text = "- item\n\n    ```\n" + run("    nested code\n", 20) + "    ```\n\nafter"
        let result = try split(text, 100)
        XCTAssertEqual(result.head, "- item\n\n")
    }

    func testSplit_backtickFenceWithBacktickInInfoIsNotAFence() throws {
        // ```a``` 是行内代码,不是围栏:后面的普通段落边界照常可切。
        let text = "```a``` inline\n\n" + run("B", 60) + "\n\n" + run("C", 60)
        let result = try split(text, 100)
        XCTAssertEqual(result.head, "```a``` inline\n\n" + run("B", 60) + "\n\n")
    }

    // MARK: - Tables and math

    func testSplit_neverCutsInsideATable() throws {
        let table = run("| a | b |\n", 15)
        let text = "intro\n\n" + table + "\nafter paragraph"
        let result = try split(text, 100)
        XCTAssertEqual(result.head, "intro\n\n")
        XCTAssertTrue(result.tail.hasPrefix("| a | b |"))
        XCTAssertFalse(result.head.contains("|"))
    }

    func testSplit_tableRowsStayTogetherWhenNoBlankLineBeforeTable() throws {
        let text = "some line\n" + run("| a | b |\n", 15) + "after"
        let result = try split(text, 100)
        XCTAssertEqual(result.head, "some line\n", "table starts a block even without a blank line")
    }

    func testSplit_oversizedFirstTableStaysWholeWithinOvershoot() throws {
        let table = run("| a | b |\n", 12)   // 120 字符
        let text = table + "\nafter paragraph\n" + run("filler line\n", 20)
        let result = try split(text, 100)
        XCTAssertEqual(result.head, table)
    }

    func testSplit_displayMathBlockIsProtected() throws {
        let text = "intro\n\n$$\n" + run("x = 1\n", 30) + "$$\n\nafter"
        let result = try split(text, 100)
        XCTAssertEqual(result.head, "intro\n\n")
    }

    // MARK: - Single long paragraph fallback, CJK, emoji, combining marks

    func testSplit_pureCJKWithoutNewlinesCutsAtExactlyTheThreshold() throws {
        let text = run("字", 20_500)
        let result = try split(text, LongTextCollapse.collapseThreshold)
        XCTAssertEqual(result.head.count, 20_000)
        XCTAssertEqual(result.tail.count, 500)
        XCTAssertEqual(result.head + result.tail, text)
    }

    func testSplit_singleLongLineBacksOffToASentenceEnd() throws {
        let text = run("这是一句话。", 50)   // 300 字符,每 6 字一句
        let result = try split(text, 100)
        XCTAssertEqual(result.head.last, "。")
        XCTAssertEqual(result.head.count, 96)
        XCTAssertEqual(result.head + result.tail, text)
    }

    func testSplit_singleLongLineBacksOffToWhitespace() throws {
        let text = run("word ", 60)   // 300 字符
        let result = try split(text, 100)
        XCTAssertTrue(result.head.hasSuffix(" "), "never cut a word in half")
        XCTAssertEqual(result.head.count, 100)
    }

    func testSplit_emojiZWJSequenceIsNeverSplit() throws {
        let family = "👨‍👩‍👧‍👦"   // 1 个 Character = 7 个 Unicode 标量
        let text = run(family, 13)
        let result = try split(text, 10)
        XCTAssertEqual(result.head.count, 10)
        XCTAssertEqual(result.tail.count, 3)
        XCTAssertEqual(result.head.unicodeScalars.count, 70)
        XCTAssertEqual(result.tail.first, Character(family))
    }

    func testSplit_combiningMarksStayWithTheirBase() throws {
        let accented = "e\u{301}"
        let text = run(accented, 25)
        let result = try split(text, 10)
        XCTAssertEqual(result.head.count, 10)
        XCTAssertEqual(result.tail.count, 15)
        XCTAssertEqual(result.head.last, Character(accented))
        XCTAssertEqual(result.tail.first, Character(accented))
    }

    func testSplit_regionalIndicatorFlagsAreCountedAndCutAsCharacters() throws {
        let text = "a" + run("🇨🇳", 30)
        let result = try split(text, 10)
        XCTAssertEqual(result.head.count, 10)
        XCTAssertEqual(result.head.unicodeScalars.count, 1 + 9 * 2)
        XCTAssertEqual(result.head + result.tail, text)
    }

    func testSplit_surrogatePairsSurviveTheCut() throws {
        let text = run("𠮷", 25)   // U+20BB7:UTF-16 代理对,UTF-8 4 字节
        let result = try split(text, 10)
        XCTAssertEqual(result.head.count, 10)
        XCTAssertEqual(result.head + result.tail, text)
    }

    // MARK: - Invariants over mixed content

    func testSplit_headPlusTailAlwaysEqualsTheOriginal() throws {
        let sample = [
            "# 标题\n\n" + run("正文段落,包含 **加粗** 与 `code`。\n\n", 40),
            run("```python\nprint('x')\n```\n\n文字\n\n", 30),
            run("| 列 | 值 |\n|---|---|\n| a | 1 |\n\n说明\n\n", 25),
            run("emoji 🙂 与 👨‍👩‍👧‍👦 混排,e\u{301} 组合。\n", 60),
            run("$$\nE=mc^2\n$$\n\n公式\n\n", 40),
            "```\n" + run("unterminated\n", 200),
            run("字", 999),
            "a\r\nb\r\n" + run("line\r\n", 200),
        ]
        for text in sample {
            for threshold in [10, 37, 100, 500] where text.count > threshold {
                let result = try XCTUnwrap(LongTextCollapse.split(markdown: text, threshold: threshold),
                                           "threshold \(threshold) must collapse a \(text.count)-char text")
                XCTAssertEqual(result.head + result.tail, text)
                XCTAssertFalse(result.head.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                XCTAssertFalse(result.tail.isEmpty)
                XCTAssertLessThanOrEqual(result.head.count, threshold + threshold / 2,
                                         "never beyond the 1.5× overshoot")
            }
        }
    }

    func testSplit_plainTextNeverExceedsTheThreshold() throws {
        let text = run("普通段落,没有围栏也没有表格。\n\n", 200)
        for threshold in [10, 37, 100, 500] where text.count > threshold {
            let result = try split(text, threshold)
            XCTAssertLessThanOrEqual(result.head.count, threshold)
        }
    }

    func testSplit_hugeInputIsFast() throws {
        let text = run("第 N 行:混合 emoji 🙂 与 **markdown**,用于测试性能。\n\n", 40_000)   // ~1.2M 字符
        let start = Date()
        let result = try split(text, LongTextCollapse.collapseThreshold)
        let pageStart = Date()
        let pages = LongTextCollapse.pages(markdown: text)
        XCTAssertLessThan(pageStart.timeIntervalSince(start), 1.0)
        XCTAssertLessThan(Date().timeIntervalSince(pageStart), 3.0)
        XCTAssertLessThanOrEqual(result.head.count, 20_000)
        XCTAssertEqual(pages.joined(), text, "no fences: pages are a lossless partition")
    }

    // MARK: - Seeded fuzz (structure-aware random markdown)

    private struct SplitMix64: RandomNumberGenerator {
        var state: UInt64
        mutating func next() -> UInt64 {
            state &+= 0x9E37_79B9_7F4A_7C15
            var z = state
            z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
            z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
            return z ^ (z >> 31)
        }
    }

    /// 随机 markdown:正文、中文、emoji、组合字符、空行、围栏块(成对)、表格、公式块。
    /// `structured == false` 时只生成纯文本(没有围栏 / 表格 / 公式)。
    private func randomMarkdown(_ rng: inout SplitMix64, size: Int, structured: Bool) -> String {
        var out = ""
        let letters = Array("abcdefghijklmnopqrstuvwxyz")
        func word() -> String {
            String((0..<Int.random(in: 1...12, using: &rng)).map { _ in letters.randomElement(using: &rng)! })
        }
        while out.count < size {
            switch Int.random(in: 0..<(structured ? 14 : 9), using: &rng) {
            case 0, 1: out += word() + " "
            case 2: out += String(repeating: "字", count: Int.random(in: 1...40, using: &rng)) + "。"
            case 3: out += "🙂👨‍👩‍👧‍👦🇨🇳"
            case 4: out += "e\u{301}"
            case 5: out += "\n"
            case 6, 7: out += "\n\n"
            case 8: out += "- " + word() + "\n"
            case 9, 10:
                let rows = Int.random(in: 1...12, using: &rng)
                out += "\n```swift\n" + (0..<rows).map { _ in "let \(word()) = 1\n" }.joined() + "```\n"
            case 11:
                out += "\n" + (0..<Int.random(in: 2...10, using: &rng)).map { _ in "| \(word()) | \(word()) |\n" }.joined()
            default:
                out += "\n$$\n" + word() + " = " + word() + "\n$$\n"
            }
        }
        return out
    }

    /// 独立于实现的判据:head 结束在围栏 / 公式块 / 表格「里面」时,只可能是整段文本一开头就是那个块
    /// (没有更早的安全切点),否则说明算法本来可以切在块之前却没有。
    private func assertCutIsNotAvoidablyInsideABlock(head: String, tail: String, text: String,
                                                    _ message: @autoclosure () -> String,
                                                    file: StaticString = #filePath, line: UInt = #line) {
        let headLines = lines(head)
        let firstContent = lines(text).first { !$0.allSatisfy { $0 == " " || $0 == "\t" } } ?? ""
        let fenceOpen = headLines.filter { $0.hasPrefix("```") }.count % 2 == 1
        let mathOpen = headLines.filter { $0 == "$$" }.count % 2 == 1
        if fenceOpen {
            XCTAssertTrue(firstContent.hasPrefix("```"), "cut inside a fence that did not open the text — \(message())", file: file, line: line)
        }
        if mathOpen {
            XCTAssertEqual(firstContent, "$$", "cut inside a math block that did not open the text — \(message())", file: file, line: line)
        }
        // head 以换行结尾时,split 出的最后一个元素是空串;真正的末行是它前一个(空行就不是表格行)。
        let lastHead = head.hasSuffix("\n") ? (headLines.dropLast().last ?? "") : (headLines.last ?? "")
        let firstTail = lines(tail).first ?? ""
        if head.hasSuffix("\n"), lastHead.hasPrefix("|"), firstTail.hasPrefix("|") {
            XCTAssertTrue(firstContent.hasPrefix("|"), "cut between two table rows of a table that did not open the text — \(message())", file: file, line: line)
        }
    }

    func testFuzz_splitInvariants() {
        var rng = SplitMix64(state: 0xC0FFEE)
        for iteration in 0..<400 {
            let structured = iteration % 2 == 0
            let text = randomMarkdown(&rng, size: Int.random(in: 40...1_500, using: &rng), structured: structured)
            let threshold = Int.random(in: 10...400, using: &rng)
            guard let result = LongTextCollapse.split(markdown: text, threshold: threshold) else {
                let blankTail = text.count > threshold
                    && (text.dropFirst(threshold).allSatisfy { $0.isWhitespace } || text.allSatisfy { $0.isWhitespace })
                XCTAssertTrue(text.count <= threshold || blankTail, "iteration \(iteration): nil for a \(text.count)-char text at \(threshold)")
                continue
            }
            XCTAssertEqual(result.head + result.tail, text, "iteration \(iteration)")
            XCTAssertFalse(result.head.allSatisfy { $0.isWhitespace }, "iteration \(iteration)")
            XCTAssertFalse(result.tail.allSatisfy { $0.isWhitespace }, "iteration \(iteration)")
            XCTAssertLessThanOrEqual(result.head.count, threshold + threshold / 2, "iteration \(iteration)")
            if !structured {
                XCTAssertLessThanOrEqual(result.head.count, threshold, "plain text never overshoots (iteration \(iteration))")
            } else {
                assertCutIsNotAvoidablyInsideABlock(head: result.head, tail: result.tail, text: text, "iteration \(iteration)")
            }
        }
    }

    func testFuzz_pagesInvariants() {
        var rng = SplitMix64(state: 0xBADC0DE)
        for iteration in 0..<300 {
            let structured = iteration % 2 == 0
            let text = randomMarkdown(&rng, size: Int.random(in: 60...2_500, using: &rng), structured: structured)
            let pageSize = Int.random(in: 20...300, using: &rng)
            let pages = LongTextCollapse.pages(markdown: text, pageSize: pageSize)
            XCTAssertFalse(pages.isEmpty, "iteration \(iteration)")
            for page in pages {
                XCTAssertFalse(page.allSatisfy { $0.isWhitespace }, "iteration \(iteration): blank page")
                XCTAssertEqual(fenceLineCount(page) % 2, 0, "iteration \(iteration): unbalanced fences\n\(page)")
                // 1.5× 整块保留上限,外加重开 / 收尾围栏各一行的余量。
                XCTAssertLessThanOrEqual(page.count, pageSize + pageSize / 2 + 24, "iteration \(iteration)")
            }
            if !structured {
                XCTAssertEqual(pages.joined(), text, "iteration \(iteration): plain text partitions losslessly")
            }
        }
    }

    // MARK: - Reader pages

    func testPages_shortTextIsOnePage_emptyIsNone() {
        XCTAssertEqual(LongTextCollapse.pages(markdown: ""), [])
        XCTAssertEqual(LongTextCollapse.pages(markdown: "短文本"), ["短文本"])
        XCTAssertEqual(LongTextCollapse.pages(markdown: run("a", 100), pageSize: 100), [run("a", 100)])
    }

    func testPages_paragraphsPartitionLosslessly() {
        let text = run("一段正文,不太长。\n\n", 100)   // 1,100 字符
        let pages = LongTextCollapse.pages(markdown: text, pageSize: 300)
        XCTAssertGreaterThan(pages.count, 3)
        XCTAssertEqual(pages.joined(), text)
        for page in pages {
            XCTAssertLessThanOrEqual(page.count, 300)
            XCTAssertFalse(page.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
    }

    func testPages_singleHugeLineIsSplitOnCharacterBoundaries() {
        let text = run("字", 3 * 100 + 7)
        let pages = LongTextCollapse.pages(markdown: text, pageSize: 100)
        XCTAssertEqual(pages.count, 4)
        XCTAssertTrue(pages.dropLast().allSatisfy { $0.count == 100 })
        XCTAssertEqual(pages.joined(), text)
    }

    func testPages_fenceIsClosedAndReopenedAcrossPages() {
        let code = (1...400).map { "let value\($0) = \($0)" }
        let text = "```swift\n" + code.joined(separator: "\n") + "\n```\n"
        let pages = LongTextCollapse.pages(markdown: text, pageSize: 500)
        XCTAssertGreaterThan(pages.count, 4)
        for page in pages {
            XCTAssertEqual(fenceLineCount(page) % 2, 0, "every page parses on its own: balanced fences\n\(page.prefix(80))")
        }
        XCTAssertTrue(pages.dropFirst().allSatisfy { $0.hasPrefix("```swift\n") }, "continuation pages reopen with the same info string")
        let restored = pages.flatMap { lines($0) }.filter { !$0.hasPrefix("```") && !$0.isEmpty }
        XCTAssertEqual(restored, code, "nothing lost or duplicated besides the fence lines")
    }

    func testPages_aHugeLineInsideAFenceKeepsEveryPageBalanced() {
        let json = run("{\"k\":1},", 120)   // 960 字符,没有换行
        let text = "```json\n" + json + "\n```\n"
        let pages = LongTextCollapse.pages(markdown: text, pageSize: 300)
        XCTAssertGreaterThan(pages.count, 2)
        for page in pages {
            XCTAssertEqual(fenceLineCount(page) % 2, 0, "balanced even when the cut lands mid-line\n\(page.prefix(60))")
        }
        let restored = pages.flatMap { lines($0) }.filter { !$0.hasPrefix("```") }.joined()
        XCTAssertEqual(restored, json)
    }

    func testSplit_textWithOnlyCarriageReturnsHasNoLineBoundariesButStillSplits() throws {
        let text = run("line\r", 200)   // 旧 Mac 行尾:没有 LF,整段是一行
        let result = try split(text, 100)
        XCTAssertEqual(result.head + result.tail, text)
        XCTAssertLessThanOrEqual(result.head.count, 100)
    }

    func testPages_whitespaceOnlyRemainderMergesIntoThePreviousPage() {
        let text = run("A", 90) + "\n" + run("\n", 30)
        let pages = LongTextCollapse.pages(markdown: text, pageSize: 100)
        XCTAssertEqual(pages, [text])
    }

    func testPages_tablesAreNotSplitAcrossPages() {
        let table = run("| 列 | 值 |\n", 30)
        let text = run("前置段落。\n\n", 30) + table + "\n" + run("后续段落。\n\n", 30)
        let pages = LongTextCollapse.pages(markdown: text, pageSize: 200)
        let withRows = pages.filter { $0.contains("| 列 | 值 |") }
        XCTAssertEqual(withRows.count, 1, "the 300-char table fits within the 1.5× overshoot and stays whole")
    }

    // MARK: - View wiring (source scan: the views are not in the logic-test target)

    private func source(_ relative: String) throws -> String {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
        return try String(contentsOf: root.appendingPathComponent(relative), encoding: .utf8)
    }

    func testWiring_collapseSkipsStreamingAndTheLiveTailOfTheActiveMessage() throws {
        let view = try source("Views/Chat/AssistantBlockView.swift")
        let start = try XCTUnwrap(view.range(of: "private var collapsedText"))
        let body = String(view[start.lowerBound...].prefix(500))
        XCTAssertTrue(body.contains("isActiveMessage && message.blocks.last?.id == block.id"),
                      "the live tail of the turn in flight is never collapsed (resume would flicker)")
        XCTAssertTrue(body.contains("collapse(for: block, isLiveTail: isLiveTail)"))
        let reader = try source("Views/Chat/LongTextReader.swift")
        let decision = try XCTUnwrap(reader.range(of: "func collapse(for block: AssistantBlock, isLiveTail: Bool)"))
        let gate = String(reader[decision.lowerBound...].prefix(300))
        XCTAssertTrue(gate.contains("guard !block.isStreamingText, !isLiveTail else { return nil }"),
                      "never collapse while the block still streams")
    }

    func testWiring_expandOpensTheReaderWithTheFullOriginalText() throws {
        let view = try source("Views/Chat/AssistantBlockView.swift")
        let reader = try source("Views/Chat/LongTextReader.swift")
        XCTAssertTrue(view.contains("LongTextReaderPresenter.present(markdown: block.content"),
                      "the reader gets block.content, never the truncated head")
        XCTAssertTrue(reader.contains("LeoHaptics.selection()"), "one selection haptic when expanding")
    }

    func testWiring_collapsedBlockNeverReusesTheFullTextCaches() throws {
        let view = try source("Views/Chat/AssistantBlockView.swift")
        XCTAssertTrue(view.contains("markdown: collapse?.head ?? block.content"))
        XCTAssertTrue(view.contains("cachedContent: collapse.map"), "collapsed: the head's own parse")
        XCTAssertTrue(view.contains("?? block.cachedMarkdown"), "not collapsed: the VM's cache, as before")
        XCTAssertTrue(view.contains("?? block.cachedAttributedString"))
    }

    /// 折叠时文本视图里只有开头;选区菜单「Copy Markdown」必须复制完整原文。
    func testWiring_copyMarkdownCopiesTheFullTextWhenCollapsed() throws {
        let view = try source("Views/Chat/AssistantBlockView.swift")
        XCTAssertTrue(view.contains("fullMarkdownForCopy: collapse == nil ? nil : block.content"))
        let md = try source("Views/Chat/SelectableMarkdownView.swift")
        XCTAssertTrue(md.contains("var md = copyMarkdownSource ?? rawMarkdown"))
        // makeUIView 和 updateUIView 都要接上,复用的视图不能带着上一个块的全文。
        XCTAssertEqual(md.components(separatedBy: "textView.copyMarkdownSource = fullMarkdownForCopy").count - 1, 2)
    }

    func testWiring_readerPresentsFromUIKitNotFromTheCell() throws {
        let reader = try source("Views/Chat/LongTextReader.swift")
        XCTAssertTrue(reader.contains("UIHostingController"), "cells run with disablesAnimations; the list presents sheets outside them")
        XCTAssertTrue(reader.contains("leoActiveKeyWindow"))
        XCTAssertTrue(reader.contains("LongTextCollapse.pages("))
        XCTAssertTrue(reader.contains("accessibilityLabel"))
        XCTAssertTrue(reader.contains("LeoTheme.TouchTarget.minimum"))
    }
}
