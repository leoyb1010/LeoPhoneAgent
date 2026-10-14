import XCTest

/// 聊天代码块的词法高亮器（CodeSyntaxLexer / CodeSyntaxLanguages）。
/// 它是「近似」的：这里钉住的是「读起来该有的样子」，以及任何输入下范围都合法。
final class CodeSyntaxLexerTests: XCTestCase {
    // MARK: Helpers

    private func tokens(_ code: String, _ language: String?) -> [(text: String, token: LeoSyntaxToken)] {
        let text = code as NSString
        return LeoSyntaxHighlighter.highlight(code, language: language).map { (text.substring(with: $0.range), $0.token) }
    }

    /// 第一段恰好等于 `piece` 的 token 的类别；没被着色返回 nil。
    private func kind(of piece: String, in code: String, _ language: String?) -> LeoSyntaxToken? {
        tokens(code, language).first { $0.text == piece }?.token
    }

    /// 范围合法：升序、互不重叠、不越界、长度为正，边界不落在代理对中间。
    private func assertWellFormed(_ spans: [LeoSyntaxSpan], in code: String,
                                  file: StaticString = #filePath, line: UInt = #line) {
        let units = Array(code.utf16)
        let hasReplacementCharacter = code.contains("\u{FFFD}")
        var previousEnd = 0
        for span in spans {
            XCTAssertGreaterThan(span.length, 0, "empty span \(span)", file: file, line: line)
            XCTAssertGreaterThanOrEqual(span.location, previousEnd, "unsorted/overlapping \(span)", file: file, line: line)
            XCTAssertLessThanOrEqual(span.end, units.count, "out of bounds \(span)", file: file, line: line)
            guard span.length > 0, span.location >= 0, span.end <= units.count else { return }
            if span.location > 0 {
                XCTAssertFalse(
                    LeoSyntaxUnit.isLowSurrogate(units[span.location]) && LeoSyntaxUnit.isHighSurrogate(units[span.location - 1]),
                    "span starts inside a surrogate pair \(span)", file: file, line: line
                )
            }
            if span.end < units.count {
                XCTAssertFalse(
                    LeoSyntaxUnit.isHighSurrogate(units[span.end - 1]) && LeoSyntaxUnit.isLowSurrogate(units[span.end]),
                    "span ends inside a surrogate pair \(span)", file: file, line: line
                )
            }
            // 能原样取出文本，不会出现替换字符。
            if !hasReplacementCharacter {
                let piece = String(decoding: units[span.location ..< span.end], as: UTF16.self)
                XCTAssertFalse(piece.contains("\u{FFFD}"), "span splits a scalar \(span)", file: file, line: line)
            }
            previousEnd = span.end
        }
    }

    // MARK: 已知片段的类别

    func testSwiftSnippetTokenKinds() {
        let code = """
        @MainActor
        func load(_ query: String) -> Int {
            return 42 // done
        }
        let name = "a \\"quoted\\" word"
        """
        XCTAssertEqual(kind(of: "@MainActor", in: code, "swift"), .attribute)
        XCTAssertEqual(kind(of: "func", in: code, "swift"), .keyword)
        XCTAssertEqual(kind(of: "load", in: code, "swift"), .function)
        XCTAssertEqual(kind(of: "String", in: code, "swift"), .type)
        XCTAssertEqual(kind(of: "Int", in: code, "swift"), .type)
        XCTAssertEqual(kind(of: "->", in: code, "swift"), .punctuation)
        XCTAssertEqual(kind(of: "return", in: code, "swift"), .keyword)
        XCTAssertEqual(kind(of: "42", in: code, "swift"), .number)
        XCTAssertEqual(kind(of: "// done", in: code, "swift"), .comment)
        XCTAssertEqual(kind(of: "\"a \\\"quoted\\\" word\"", in: code, "swift"), .string)
        XCTAssertNil(kind(of: "query", in: code, "swift"), "a plain identifier keeps the default colour")
        XCTAssertNil(kind(of: "name", in: code, "swift"))
    }

    func testSwiftDirectivesDeclaredTypesAndCalls() {
        let code = "#if DEBUG\nstruct Box: Hashable { var n = 0 }\nprint(Box().n)\n#endif"
        XCTAssertEqual(kind(of: "#if", in: code, "swift"), .keyword)
        XCTAssertEqual(kind(of: "Box", in: code, "swift"), .type, "a name declared by struct is a type")
        XCTAssertEqual(kind(of: "Hashable", in: code, "swift"), .type)
        XCTAssertEqual(kind(of: "print", in: code, "swift"), .function, "a name followed by ( is a call")
    }

    func testPythonSnippetTokenKinds() {
        let code = """
        @dataclass
        class User(Base):
            \"\"\"doc\"\"\"
            def greet(self, n: int = 3) -> str:
                # hi
                return f"x {n}" if n else None

        print(len("a"), True)
        """
        XCTAssertEqual(kind(of: "@dataclass", in: code, "python"), .attribute)
        XCTAssertEqual(kind(of: "class", in: code, "python"), .keyword)
        XCTAssertEqual(kind(of: "User", in: code, "python"), .type)
        XCTAssertEqual(kind(of: "Base", in: code, "python"), .type)
        XCTAssertEqual(kind(of: "\"\"\"doc\"\"\"", in: code, "python"), .string)
        XCTAssertEqual(kind(of: "def", in: code, "python"), .keyword)
        XCTAssertEqual(kind(of: "greet", in: code, "python"), .function)
        XCTAssertEqual(kind(of: "self", in: code, "python"), .keyword)
        XCTAssertEqual(kind(of: "int", in: code, "python"), .type)
        XCTAssertEqual(kind(of: "3", in: code, "python"), .number)
        XCTAssertEqual(kind(of: "# hi", in: code, "python"), .comment)
        XCTAssertEqual(kind(of: "\"x {n}\"", in: code, "python"), .string)
        XCTAssertEqual(kind(of: "None", in: code, "python"), .keyword)
        XCTAssertEqual(kind(of: "print", in: code, "python"), .function)
        XCTAssertEqual(kind(of: "len", in: code, "python"), .function)
        XCTAssertEqual(kind(of: "True", in: code, "python"), .keyword)
    }

    func testJSONSnippetKeysAndValuesTakeDifferentKinds() {
        let code = "{\"name\": \"leo\", \"n\": 1, \"ok\": null, \"list\": [true]}"
        XCTAssertEqual(kind(of: "\"name\"", in: code, "json"), .attribute)
        XCTAssertEqual(kind(of: "\"leo\"", in: code, "json"), .string)
        XCTAssertEqual(kind(of: "1", in: code, "json"), .number)
        XCTAssertEqual(kind(of: "null", in: code, "json"), .keyword)
        XCTAssertEqual(kind(of: "true", in: code, "json"), .keyword)
        XCTAssertEqual(kind(of: "\"list\"", in: code, "json"), .attribute)
        XCTAssertTrue(tokens(code, "json").contains { $0.text.contains(":") && $0.token == .punctuation })
    }

    func testBashSnippetTokenKinds() {
        let code = """
        #!/bin/bash
        # build
        export APP="$HOME/app"
        if [ -f "$APP/x" ]; then
          npm install --save-dev x && echo $HOME ${name} $# # done
        fi
        """
        XCTAssertEqual(kind(of: "#!/bin/bash", in: code, "bash"), .comment)
        XCTAssertEqual(kind(of: "# build", in: code, "bash"), .comment)
        XCTAssertEqual(kind(of: "export", in: code, "bash"), .keyword)
        XCTAssertEqual(kind(of: "\"$HOME/app\"", in: code, "bash"), .string)
        XCTAssertEqual(kind(of: "if", in: code, "bash"), .keyword)
        XCTAssertEqual(kind(of: "-f", in: code, "bash"), .attribute, "a command-line option")
        XCTAssertEqual(kind(of: "npm", in: code, "bash"), .function)
        XCTAssertEqual(kind(of: "--save-dev", in: code, "bash"), .attribute)
        XCTAssertEqual(kind(of: "&&", in: code, "bash"), .punctuation)
        XCTAssertEqual(kind(of: "echo", in: code, "bash"), .function)
        XCTAssertEqual(kind(of: "$HOME", in: code, "bash"), .attribute, "a shell variable")
        XCTAssertEqual(kind(of: "${name}", in: code, "bash"), .attribute)
        XCTAssertEqual(kind(of: "$#", in: code, "bash"), .attribute)
        XCTAssertEqual(kind(of: "# done", in: code, "bash"), .comment, "a # after $# still starts a comment")
        XCTAssertEqual(kind(of: "fi", in: code, "bash"), .keyword)
    }

    func testShellMinusIsOnlyAnOptionWhenItStartsAWord() {
        let code = "x=$((a - b)); cd -; echo a-b"
        XCTAssertNil(tokens(code, "bash").first { $0.token == .attribute && $0.text.hasPrefix("-") },
                     "`a - b`, `cd -` and `a-b` contain no option")
    }

    func testJavaScriptSnippetTokenKinds() {
        let code = """
        import { a } from './a.js';
        export default async function load(id) {
          const url = `https://x/${id}`;
          return await fetch(url).then(r => r.json()) ?? null; // done
        }
        class Cache extends Map {}
        """
        XCTAssertEqual(kind(of: "import", in: code, "javascript"), .keyword)
        XCTAssertEqual(kind(of: "from", in: code, "javascript"), .keyword)
        XCTAssertEqual(kind(of: "'./a.js'", in: code, "javascript"), .string)
        XCTAssertEqual(kind(of: "async", in: code, "javascript"), .keyword)
        XCTAssertEqual(kind(of: "load", in: code, "javascript"), .function)
        XCTAssertEqual(kind(of: "const", in: code, "javascript"), .keyword)
        XCTAssertEqual(kind(of: "`https://x/${id}`", in: code, "javascript"), .string)
        XCTAssertEqual(kind(of: "await", in: code, "javascript"), .keyword)
        XCTAssertEqual(kind(of: "fetch", in: code, "javascript"), .function)
        XCTAssertEqual(kind(of: "then", in: code, "javascript"), .function)
        XCTAssertEqual(kind(of: "=>", in: code, "javascript"), .punctuation)
        XCTAssertEqual(kind(of: "null", in: code, "javascript"), .keyword)
        XCTAssertEqual(kind(of: "// done", in: code, "javascript"), .comment)
        XCTAssertEqual(kind(of: "Cache", in: code, "javascript"), .type)
        XCTAssertEqual(kind(of: "Map", in: code, "javascript"), .type)
        XCTAssertNil(kind(of: "r", in: code, "javascript"))
    }

    func testTypeScriptAndJSXShareTheJavaScriptGrammar() {
        XCTAssertEqual(kind(of: "interface", in: "interface Foo { bar: string }", "typescript"), .keyword)
        XCTAssertEqual(kind(of: "const", in: "const a = <div/>", "jsx"), .keyword)
    }

    func testYAMLSnippetTokenKinds() {
        let code = """
        # service
        name: leobot-api
        replicas: 3
        enabled: true
        url: http://x.io:80/path
        items:
          - a
        """
        XCTAssertEqual(kind(of: "# service", in: code, "yaml"), .comment)
        XCTAssertEqual(kind(of: "name", in: code, "yaml"), .attribute)
        XCTAssertNil(kind(of: "leobot-api", in: code, "yaml"), "a hyphenated value is one plain word")
        XCTAssertEqual(kind(of: "replicas", in: code, "yaml"), .attribute)
        XCTAssertEqual(kind(of: "3", in: code, "yaml"), .number)
        XCTAssertEqual(kind(of: "true", in: code, "yaml"), .keyword)
        XCTAssertEqual(kind(of: "url", in: code, "yaml"), .attribute)
        XCTAssertNil(kind(of: "http", in: code, "yaml"), "the colon in a URL does not make `http` a key")
        XCTAssertEqual(kind(of: "items", in: code, "yaml"), .attribute)
    }

    func testYAMLHyphenatedKeys() {
        XCTAssertEqual(kind(of: "app-name", in: "app-name: demo # the name\nreplicas: 3", "yaml"), .attribute)
    }

    func testDiffSnippetTokenKinds() {
        let code = """
        diff --git a/a b/a
        --- a/a
        +++ b/a
        @@ -1,2 +1,2 @@
         keep
        -old
        +new
        \\ No newline at end of file
        """
        XCTAssertEqual(kind(of: "diff --git a/a b/a", in: code, "diff"), .comment)
        XCTAssertEqual(kind(of: "--- a/a", in: code, "diff"), .attribute, "file header")
        XCTAssertEqual(kind(of: "+++ b/a", in: code, "diff"), .attribute, "file header")
        XCTAssertEqual(kind(of: "@@ -1,2 +1,2 @@", in: code, "diff"), .attribute, "hunk header")
        XCTAssertNil(kind(of: " keep", in: code, "diff"), "context lines keep the default colour")
        XCTAssertEqual(kind(of: "-old", in: code, "diff"), .keyword, "removed lines borrow the (pink) keyword colour")
        XCTAssertEqual(kind(of: "+new", in: code, "diff"), .string, "added lines borrow the (green) string colour")
        XCTAssertEqual(kind(of: "\\ No newline at end of file", in: code, "diff"), .comment)
    }

    func testDiffContentThatLooksLikeAFileHeaderInsideAHunkIsStillAChange() {
        let code = "@@ -1 +1 @@\n--- a SQL comment\n+++ more"
        XCTAssertEqual(kind(of: "--- a SQL comment", in: code, "diff"), .keyword)
        XCTAssertEqual(kind(of: "+++ more", in: code, "diff"), .string)
    }

    // MARK: 其它语言与细节

    func testEveryCatalogLanguageColoursItsSample() {
        let samples: [(String, String)] = [
            ("swift", "let x = 1"),
            ("c", "#include <stdio.h>\nint main(void) { return 0; }"),
            ("cpp", "template <typename T> class Box {};"),
            ("objc", "@interface Foo : NSObject\n@end"),
            ("csharp", "public class Foo { int x = 1; }"),
            ("java", "public static void main(String[] args) {}"),
            ("kotlin", "fun main() { val x = 1 }"),
            ("go", "func main() { fmt.Println(\"hi\") }"),
            ("rust", "fn main() { let x: i32 = 1; }"),
            ("javascript", "const x = `hi ${name}`;"),
            ("typescript", "interface Foo { bar: string }"),
            ("python", "def main():\n    return None"),
            ("ruby", "def main\n  puts 'hi'\nend"),
            ("bash", "if [ -f \"$FILE\" ]; then echo ok; fi"),
            ("sql", "SELECT id FROM users WHERE id = 1;"),
            ("lua", "local x = nil -- none"),
            ("haskell", "main = putStrLn \"hi\" -- greet"),
            ("json", "{\"id\": 1, \"ok\": true}"),
            ("yaml", "name: app\nreplicas: 3"),
            ("toml", "[package]\nname = \"app\""),
            ("css", ".a { color: #fff; margin: 0 auto; }"),
            ("html", "<div class=\"a\">text</div>"),
            ("diff", "-old\n+new"),
            ("dockerfile", "FROM swift:6.2\nRUN swift build"),
            ("makefile", "all:\n\techo $(CC) # build"),
            ("php", "<?php echo $name; ?>"),
            ("dart", "void main() { print('hi'); }"),
            ("unknown-language", "if (x) { return 1; }"),
        ]
        for (language, code) in samples {
            let spans = LeoSyntaxHighlighter.highlight(code, language: language)
            XCTAssertFalse(spans.isEmpty, "\(language) coloured nothing")
            assertWellFormed(spans, in: code)
        }
    }

    func testCatalogBuildsAndEveryAliasResolves() {
        // 词表里任何一个词打包失败都会在首次访问目录时 trap：这里触发一次初始化。
        XCTAssertGreaterThan(LeoSyntaxLanguage.catalog.count, 100)
        for name in LeoSyntaxLanguage.catalog.keys {
            XCTAssertNotNil(LeoSyntaxLanguage.named(name), name)
        }
    }

    func testUnknownLanguageFallsBackToGenericRules() {
        let code = "if (x) { return \"a\"; } // note"
        XCTAssertEqual(kind(of: "if", in: code, "frobnicate"), .keyword)
        XCTAssertEqual(kind(of: "\"a\"", in: code, "frobnicate"), .string)
        XCTAssertEqual(kind(of: "// note", in: code, "frobnicate"), .comment)
    }

    func testBlockThatNamesNoLanguageIsStillHighlighted() {
        XCTAssertFalse(LeoSyntaxHighlighter.highlight("let x = \"a\" // b", language: nil).isEmpty)
        XCTAssertFalse(LeoSyntaxHighlighter.highlight("let x = \"a\" // b", language: "").isEmpty)
    }

    func testPlainTextLanguagesStayUncoloured() {
        for language in ["text", "plaintext", "txt", "output", "markdown", "TEXT", "log"] {
            XCTAssertTrue(LeoSyntaxHighlighter.highlight("let x = \"a\" // b", language: language).isEmpty, language)
            XCTAssertFalse(LeoSyntaxHighlighter.canHighlight(language: language), language)
        }
        XCTAssertTrue(LeoSyntaxHighlighter.canHighlight(language: "swift"))
        XCTAssertTrue(LeoSyntaxHighlighter.canHighlight(language: nil))
    }

    func testEmptyAndWhitespaceOnlyInputProduceNoSpans() {
        for language in ["swift", "python", "json", "bash", "diff", "html", nil] {
            XCTAssertTrue(LeoSyntaxHighlighter.highlight("", language: language).isEmpty)
            XCTAssertTrue(LeoSyntaxHighlighter.highlight("   \n\t \r\n  ", language: language).isEmpty)
        }
    }

    func testLanguageNameIsReadFromTheFirstWordInAnyCase() {
        XCTAssertEqual(kind(of: "func", in: "func a()", "Swift title=\"A\""), .keyword)
        XCTAssertEqual(LeoSyntaxHighlighter.normalizedLanguage("  Swift {1,3}"), "swift")
        XCTAssertEqual(LeoSyntaxHighlighter.normalizedLanguage(nil), "")
    }

    func testRustLifetimeIsNotAStringButACharacterLiteralIs() {
        let code = "fn f<'a>(x: &'a str) -> char { 'x' }"
        XCTAssertEqual(tokens(code, "rust").filter { $0.token == .string }.map(\.text), ["'x'"])
    }

    func testAStrayApostropheDoesNotSwallowTheRestOfTheLine() {
        XCTAssertEqual(kind(of: "1", in: "x = it's + 1", "swift"), .number)
    }

    func testUnterminatedCommentOrDocstringRunsToTheEndWhileStreaming() {
        XCTAssertEqual(kind(of: "/* still typing", in: "a /* still typing", "swift"), .comment)
        XCTAssertEqual(kind(of: "\"\"\"doc\nmore", in: "x = \"\"\"doc\nmore", "python"), .string)
    }

    func testNumbersAndRangesBetweenThem() {
        let pieces = tokens("a = 0x1F + 2.5e-3 + 1_000; for i in 1..5 {}", "swift").filter { $0.token == .number }.map(\.text)
        XCTAssertEqual(pieces, ["0x1F", "2.5e-3", "1_000", "1", "5"])
    }

    func testSQLKeywordsMatchInAnyCase() {
        XCTAssertEqual(kind(of: "SELECT", in: "SELECT 1", "sql"), .keyword)
        XCTAssertEqual(kind(of: "select", in: "select 1", "sql"), .keyword)
        XCTAssertEqual(kind(of: "-- note", in: "select 1 -- note", "sql"), .comment)
        XCTAssertEqual(kind(of: "COUNT", in: "SELECT COUNT(*) FROM t", "sql"), .function)
    }

    func testMarkupColoursTagsAndAttributesNotTheTextBetweenThem() {
        let code = "<!-- note --><div class=\"a\">it's text</div>"
        XCTAssertEqual(kind(of: "<!-- note -->", in: code, "html"), .comment)
        XCTAssertEqual(kind(of: "div", in: code, "html"), .keyword)
        XCTAssertEqual(kind(of: "class", in: code, "html"), .attribute)
        XCTAssertEqual(kind(of: "\"a\"", in: code, "html"), .string)
        XCTAssertTrue(tokens(code, "html").allSatisfy { !$0.text.contains("text") })
    }

    func testCDirectivesAreKeywordsAndRustAttributesAreAttributes() {
        XCTAssertEqual(kind(of: "#include", in: "#include <stdio.h>", "c"), .keyword)
        XCTAssertEqual(kind(of: "#  define", in: "#  define X 1", "c"), .keyword)
        XCTAssertEqual(kind(of: "#[derive(Debug)]", in: "#[derive(Debug)]\nstruct A;", "rust"), .attribute)
    }

    func testCSSFunctionsAndAtRules() {
        let code = "@media (max-width: 600px) { a { color: rgba(0, 0, 0, 0.8); font-size: 1.25rem } }"
        XCTAssertEqual(kind(of: "@media", in: code, "css"), .attribute)
        XCTAssertEqual(kind(of: "rgba", in: code, "css"), .function)
        XCTAssertEqual(kind(of: "color", in: code, "css"), .attribute)
        XCTAssertEqual(kind(of: "font-size", in: code, "css"), .attribute)
        XCTAssertEqual(kind(of: "1.25rem", in: code, "css"), .number)
    }

    func testAdjacentTokensOfTheSameKindMerge() {
        // `)` `.` 相邻，合成一段，避免给 TextKit 多余的属性段。
        let spans = LeoSyntaxHighlighter.highlight("a).b", language: "swift")
        XCTAssertEqual(spans, [LeoSyntaxSpan(location: 1, length: 2, token: .punctuation)])
    }

    // MARK: UTF-16、emoji 与 CJK

    func testRangesAreUTF16OffsetsAroundEmojiAndCJK() {
        let code = "let 名字 = \"中文😀\" // 注释😀"
        XCTAssertEqual(kind(of: "\"中文😀\"", in: code, "swift"), .string)
        XCTAssertEqual(kind(of: "// 注释😀", in: code, "swift"), .comment)
        XCTAssertNil(kind(of: "名字", in: code, "swift"))
        assertWellFormed(LeoSyntaxHighlighter.highlight(code, language: "swift"), in: code)
    }

    func testEmojiAndCJKInsideEveryKindOfTokenKeepRangesValid() {
        let snippets: [(String, String)] = [
            ("swift", "let s = \"😀😀\" // 😀\nlet 😀 = 1\nfunc 函数😀() {}\n/* 😀 */"),
            ("python", "x = '😀' # 😀\n\"\"\"😀\n中文\"\"\"\n@装饰器😀"),
            ("json", "{\"键😀\": \"值😀\", \"数\": 1}"),
            ("bash", "echo \"😀\" $变量😀 ${名😀} # 注释😀\n-😀"),
            ("javascript", "const a = `😀${中}`; // 😀\nlet 😀"),
            ("yaml", "键😀: 值😀 # 😀\n- 中文😀"),
            ("html", "<div 属性😀=\"值😀\">😀</div><!-- 😀 -->"),
            ("diff", "+😀\n-中文😀\n@@ 😀 @@\n 😀"),
            ("rust", "let c = '😀'; let d = '中'; // 😀"),
            ("css", ".类😀 { color: red; /* 😀 */ }"),
        ]
        for (language, code) in snippets {
            let spans = LeoSyntaxHighlighter.highlight(code, language: language)
            XCTAssertFalse(spans.isEmpty, language)
            assertWellFormed(spans, in: code)
        }
    }

    func testGraphemeClustersZWJAndCombiningMarksKeepRangesValid() {
        let family = "👨‍👩‍👧‍👦"
        let flag = "🇨🇳"
        let combining = "e\u{0301}"
        let code = "let a = \"\(family)\" // \(flag)\nlet b = '\(combining)' + \(family)"
        for language in ["swift", "rust", "python", "bash", "javascript", "text", nil] {
            assertWellFormed(LeoSyntaxHighlighter.highlight(code, language: language), in: code)
        }
    }

    func testSurrogateAlignmentMovesBoundariesOutOfTheMiddleOfAPair() {
        // a 😀 b = [a, D83D, DE00, b]
        let units = Array("a😀b".utf16)
        XCTAssertEqual(units.count, 4)
        units.withUnsafeBufferPointer { buffer in
            func aligned(_ start: Int, _ end: Int) -> [Int] {
                let result = LeoSyntaxUnit.alignedToSurrogatePairs(start, end, in: buffer)
                return [result.start, result.end]
            }
            XCTAssertEqual(aligned(0, 4), [0, 4], "already on boundaries")
            XCTAssertEqual(aligned(0, 2), [0, 3], "ends between the halves: take the whole pair")
            XCTAssertEqual(aligned(2, 4), [1, 4], "starts on the low half: take the whole pair")
            XCTAssertEqual(aligned(2, 3), [1, 3])
            XCTAssertEqual(aligned(1, 3), [1, 3])
            XCTAssertEqual(aligned(3, 4), [3, 4])
            XCTAssertEqual(aligned(-5, 99), [0, 4], "clamped to the text")
            XCTAssertEqual(aligned(4, 4), [4, 4])
        }
    }

    func testBackslashBeforeAnEmojiInAStringKeepsRangesValid() {
        // 转义符会跳过两个码元：后面是代理对时，不能把终点停在代理对中间。
        let code = "let s = \"a\\😀b\" + \"\\😀\""
        let spans = LeoSyntaxHighlighter.highlight(code, language: "swift")
        assertWellFormed(spans, in: code)
        XCTAssertEqual(spans.filter { $0.token == .string }.count, 2)
    }

    func testRandomisedInputNeverProducesInvalidRanges() {
        let pieces: [String] = [
            "a", "b", "func ", "let ", "def ", "class ", "if ", "return ", "\"", "'", "`", "\"\"\"", "//", "/*", "*/", "#", "##",
            "$", "${", "@", "\\", "(", ")", "{", "}", "[", "]", ":", ";", ",", ".", "\n", "\r\n", "\r", " ", "\t", "1", "0x1F",
            "3.14e-2", "1..5", "😀", "👨‍👩‍👧", "🇨🇳", "中", "文", "é", "e\u{0301}", "<", ">", "</", "<!--", "-->", "<?", "!", "-",
            "--", "---", "+", "+++", "@@ -1 +1 @@\n", "= ", "==", "::", "->", "=>", "&&", "?", "%", "|", "~", "^",
        ]
        let languages: [String?] = Array(LeoSyntaxLanguage.catalog.keys.sorted()) + ["unknown-language", nil]
        var state: UInt64 = 0x9E37_79B9_7F4A_7C15
        func next() -> Int {
            state = state &* 6_364_136_223_846_793_005 &+ 1_442_695_040_888_963_407
            return Int(truncatingIfNeeded: state >> 33)
        }
        for _ in 0 ..< 150 {
            var code = ""
            for _ in 0 ..< (1 + next() % 60) { code += pieces[next() % pieces.count] }
            for language in languages {
                assertWellFormed(LeoSyntaxHighlighter.highlight(code, language: language), in: code)
            }
        }
    }

    // MARK: 病态输入

    func testPathologicalInputsTerminateWithValidRanges() {
        let manyQuotes = String(repeating: "'", count: 2000)
        let manyOpeners = String(repeating: "\"a", count: 1000)
        let loneQuotePerLine = String(repeating: "x = \"unterminated\n", count: 2000)
        let deepBrackets = String(repeating: "([{", count: 600)
        for (language, code) in [("swift", manyQuotes), ("python", manyQuotes), ("swift", manyOpeners),
                                 ("bash", loneQuotePerLine), ("javascript", deepBrackets), ("html", String(repeating: "<a ", count: 800)),
                                 ("diff", String(repeating: "+", count: 3000))] {
            assertWellFormed(LeoSyntaxHighlighter.highlight(code, language: language), in: code)
        }
    }

    func testAVeryLongSingleLineStillLexesWhenCalledDirectly() {
        // 词法器本身不设上限（上限由 LeoCodeHighlightLimits 在调用前把关）：直接调用也必须安全。
        let code = "let x = 1 + 2 // " + String(repeating: "z", count: 50_000)
        let spans = LeoSyntaxHighlighter.highlight(code, language: "swift")
        assertWellFormed(spans, in: code)
        XCTAssertEqual(spans.last?.token, .comment)
    }
}
