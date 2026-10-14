import XCTest

/// 流式输出里「最后一个代码块的围栏闭合了没有」：它决定高亮要不要节流（CodeSyntaxFence）。
final class CodeSyntaxFenceTests: XCTestCase {
    private func open(_ source: String, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertTrue(MarkdownFenceTracker.endsInsideOpenFence(source), "expected an open fence in:\n\(source)", file: file, line: line)
    }

    private func closed(_ source: String, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertFalse(MarkdownFenceTracker.endsInsideOpenFence(source), "expected no open fence in:\n\(source)", file: file, line: line)
    }

    func testAFenceThatIsStillStreamingIsOpen() {
        open("```swift")
        open("```swift\n")
        open("```swift\nlet x = 1")
        open("Here is code:\n\n```swift\nlet x = 1\nlet y = 2\n")
        open("~~~\ncode")
    }

    func testAClosedFenceIsNotOpen() {
        closed("```swift\nlet x = 1\n```")
        closed("```swift\nlet x = 1\n```\n")
        closed("```swift\nlet x = 1\n```\nand then some text")
        closed("~~~\ncode\n~~~")
    }

    func testNoFenceAtAllIsNotOpen() {
        closed("")
        closed("plain text")
        closed("# Title\n\n- a\n- b")
    }

    func testAnInlineTripleBacktickIsNotAFence() {
        closed("use ```inline``` here")
        closed("```inline``` at the start")
    }

    func testALongerFenceIsNotClosedByAShorterOne() {
        open("````md\n```swift\nlet x = 1\n```\n")
        closed("````md\n```swift\nlet x = 1\n```\n````")
    }

    func testTheFenceCharacterMustMatch() {
        open("```\ncode\n~~~")
        open("~~~\ncode\n```")
    }

    func testASecondBlockOpensAfterTheFirstClosed() {
        open("```a\none\n```\n\n```b\ntwo")
        closed("```a\none\n```\n\n```b\ntwo\n```")
    }

    func testAnIndentedFenceInsideAListItemIsTracked() {
        open("- item\n\n  ```py\n  x = 1")
        closed("- item\n\n  ```py\n  x = 1\n  ```")
    }

    func testAFenceInsideABlockquoteIsTracked() {
        open("> ```swift\n> let x = 1")
        closed("> ```swift\n> let x = 1\n> ```")
        open(">```swift\n>let x = 1")
        open("> > ```swift\n> > let x")
        closed("> > ```swift\n> > let x\n> > ```")
        open("intro\n\n> quoted text\n>\n> ```py\n> x = 1")
    }

    func testAQuoteMarkerInsideAnOrdinaryFenceDoesNotCloseIt() {
        // 围栏里的内容行以 `>` 开头（shell 提示符、HTML）：围栏仍然开着。
        open("```bash\n> echo hi\n> echo there")
        closed("```bash\n> echo hi\n```")
    }

    func testClosingFenceMayHaveTrailingWhitespaceButNoInfo() {
        closed("```\ncode\n```   ")
        open("```\ncode\n``` still text")
    }
}
