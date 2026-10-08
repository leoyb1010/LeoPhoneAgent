import XCTest

// Ported from upstream Standalone/MarkdownStripperFastPathTests.swift
// [T-ios-listsessions-perf]: the static-regex / UTF-8 rewrite of
// MarkdownStripper is a PURE performance change. The pre-rewrite
// implementation is kept below as `LegacyStripper` and every corpus entry must
// produce identical output, except the deliberate 1024-character inline-pass
// cap, which only changes text past the 100 characters any preview keeps.

private enum LegacyStripper {
    static func plainText(_ input: String) -> String {
        var s = input

        s = s.replacingOccurrences(of: "```[\\s\\S]*?```", with: " ", options: .regularExpression)
        s = s.replacingOccurrences(of: "!\\[([^\\]]*)\\]\\([^)]*\\)", with: "$1", options: .regularExpression)
        s = rewriteLinks(s)
        s = s.replacingOccurrences(of: "<(https?://[^>]+)>", with: "$1", options: .regularExpression)

        let inlinePatterns: [(String, String)] = [
            ("\\*\\*([^*]+)\\*\\*", "$1"),
            ("__([^_]+)__",          "$1"),
            ("\\*([^*]+)\\*",        "$1"),
            ("(?<!\\w)_([^_]+)_(?!\\w)", "$1"),
            ("~~([^~]+)~~",          "$1"),
            ("`([^`]*)`",            "$1"),
        ]
        for (pattern, replacement) in inlinePatterns {
            s = s.replacingOccurrences(of: pattern, with: replacement, options: .regularExpression)
        }

        let lines = s.components(separatedBy: "\n")
        let cleaned: [String] = lines.compactMap { raw in
            var line = raw.trimmingCharacters(in: .whitespaces)
            guard !line.isEmpty else { return nil }

            let sepStripped = line.trimmingCharacters(in: CharacterSet(charactersIn: "-=*_ "))
            if sepStripped.isEmpty { return nil }

            if line.hasPrefix("|") || (line.contains("|") && line.hasSuffix("|")) { return nil }
            if line.allSatisfy({ "|-: ".contains($0) }) && line.contains("|") { return nil }

            if line.hasPrefix("```") || line.hasPrefix("~~~") { return nil }

            line = line.replacingOccurrences(of: "^#{1,6}\\s+", with: "", options: .regularExpression)
            line = line.replacingOccurrences(of: "^>\\s?", with: "", options: .regularExpression)
            line = line.replacingOccurrences(of: "^[-*+]\\s+", with: "", options: .regularExpression)
            line = line.replacingOccurrences(of: "^\\d+[.):]\\s+", with: "", options: .regularExpression)
            line = line.replacingOccurrences(of: "[*_~`]{2,}", with: "", options: .regularExpression)

            line = line.trimmingCharacters(in: .whitespaces)
            return line.isEmpty ? nil : line
        }

        var result = cleaned.joined(separator: " ")
        result = result.replacingOccurrences(of: "  +", with: " ", options: .regularExpression)
        return result.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func rewriteLinks(_ text: String) -> String {
        let pattern = "!?\\[([^\\]]*)\\]\\(([^)\\s]+)[^)]*\\)"
        guard let re = try? NSRegularExpression(pattern: pattern) else { return text }
        let ns = text as NSString
        var result = ""
        result.reserveCapacity(ns.length)
        var last = 0
        for m in re.matches(in: text, range: NSRange(location: 0, length: ns.length)) {
            result += ns.substring(with: NSRange(location: last, length: m.range.location - last))
            let title = ns.substring(with: m.range(at: 1)).trimmingCharacters(in: .whitespaces)
            let url   = ns.substring(with: m.range(at: 2))
            result += title.isEmpty ? url : title
            last = m.range.location + m.range.length
        }
        result += ns.substring(from: last)
        return result
    }

    private static let opaqueRegions: [(open: String, close: String)] = [
        ("```", "```"),
        ("<system-reminder>", "</system-reminder>"),
        ("<user-attached-files>", "</user-attached-files>"),
        ("<treasury_context", "</treasury_context>"),  // LeoBot region, mirrored
    ]

    static func previewSource(_ input: String, maxLength: Int = 4096) -> String {
        guard maxLength > 0 else { return "" }
        var out = ""
        out.reserveCapacity(min(maxLength, 8192))
        var remaining = maxLength
        var cursor = input.startIndex
        let end = input.endIndex

        while cursor < end, remaining > 0 {
            let windowEnd = input.index(cursor, offsetBy: remaining, limitedBy: end) ?? end
            var nearest: (range: Range<String.Index>, close: String)?
            for region in opaqueRegions {
                guard let r = input.range(of: region.open, range: cursor..<windowEnd) else { continue }
                if nearest == nil || r.lowerBound < nearest!.range.lowerBound {
                    nearest = (r, region.close)
                }
            }

            guard let hit = nearest else {
                out += input[cursor..<windowEnd]
                break
            }

            if hit.range.lowerBound > cursor {
                let prose = input[cursor..<hit.range.lowerBound]
                out += prose
                remaining -= prose.count
            }
            guard let closer = input.range(of: hit.close, range: hit.range.upperBound..<end) else { break }
            cursor = closer.upperBound
            if remaining > 0, !out.isEmpty, !(out.last?.isWhitespace ?? true) {
                out += " "
                remaining -= 1
            }
        }
        return out
    }
}

private let longProse = String(repeating: "The quick brown fox jumps over the lazy dog. ", count: 140)
private let longFence = "```swift\n" + String(repeating: "let x = 1\n", count: 600) + "```"

private let corpus: [(name: String, text: String)] = [
    ("empty", ""),
    ("plain", "just a plain sentence"),
    ("heading", "# Title\n\nBody text here."),
    ("deep heading", "###### Six levels\ncontent"),
    ("bold", "This is **bold** and __also bold__."),
    ("italic", "This is *italic* and _also italic_ but snake_case_word stays."),
    ("strike + code", "~~gone~~ and `inline code` here."),
    ("fence", "Before\n```swift\nlet x = 1\nprint(x)\n```\nAfter"),
    ("tilde fence line", "~~~\nnot markdown\n~~~\ntail"),
    ("unclosed fence", "Intro\n```\nnever closed"),
    ("image", "See ![alt text](https://example.com/a.png) here."),
    ("image empty alt", "See ![](https://example.com/a.png) here."),
    ("link", "Read [the docs](https://example.com/docs) now."),
    ("link empty title", "Read [](https://example.com/docs) now."),
    ("link with title attr", "Read [docs](https://example.com \"Title\") now."),
    ("autolink", "Visit <https://example.com/x> today."),
    ("bullets", "- one\n- two\n* three\n+ four"),
    ("ordered", "1. first\n2) second\n3: third"),
    ("blockquote", "> quoted line\n> another"),
    ("hrule", "text\n---\nmore\n***\nend"),
    ("table", "| a | b |\n|---|---|\n| 1 | 2 |\ntail line"),
    ("table no trailing pipe", "a | b\n--- | ---\n1 | 2"),
    ("emoji", "Done ✅ shipped 🚀🎉 and family 👨‍👩‍👧‍👦 here."),
    ("CJK", "这是一段中文预览文本，包含标点。还有更多内容。"),
    ("CJK + markdown", "## 标题\n\n**粗体**中文和`代码`混排。"),
    ("mixed scripts", "Hello 世界 مرحبا שלום こんにちは"),
    ("system reminder", "Answer here.<system-reminder>hidden instructions</system-reminder> Tail."),
    ("reminder only", "<system-reminder>all hidden</system-reminder>"),
    ("unclosed reminder", "Visible<system-reminder>never closed"),
    ("attached files", "Question?<user-attached-files>\n<file>a.txt</file>\n</user-attached-files> More."),
    ("attachment markers", "Look at this [attached image: photo.png] and [image omitted to save context — too big]."),
    ("multi space", "a    b\t\tc     d"),
    ("whitespace only", "   \n\n \t \n  "),
    ("newlines heavy", "a\n\n\n\nb\n\n\nc"),
    ("long prose >4096", longProse),
    ("long fence", longFence),
    ("long fence then prose", longFence + "\nThe real answer is 42."),
    ("reminder then long", "<system-reminder>" + String(repeating: "x", count: 5000) + "</system-reminder>Real answer."),
    ("emoji at cut", String(repeating: "a", count: 4095) + "🚀tail"),
    ("CJK at cut", String(repeating: "中", count: 4100)),
    ("treasury block", "Q<treasury_context untrusted=\"true\">secret items</treasury_context> answer"),
    ("treasury straddle", "Hi <treasury_context a=\"1\">" + String(repeating: "t", count: 6000) + "</treasury_context> tail"),
    ("nested markers", "```\n<system-reminder>inside fence</system-reminder>\n```\nafter"),
    ("everything", """
    # Report 报告

    Here is **bold**, *italic*, `code`, ~~strike~~ and a [link](https://x.com/a).

    ```python
    def f():
        return 1
    """ + "\n```\n\n| col | col |\n|-----|-----|\n| 1   | 2   |\n\n> a quote\n\n- bullet ✅\n\n<system-reminder>hide me</system-reminder>\n\nFinal line."),
]

final class MarkdownStripperFastPathTests: XCTestCase {
    func testPreviewSourceMatchesLegacyByteForByte() {
        for (name, text) in corpus {
            XCTAssertEqual(MarkdownStripper.previewSource(text), LegacyStripper.previewSource(text), name)
        }
    }

    func testPreviewSourceMatchesLegacyAcrossBudgets() {
        for budget in [1, 2, 3, 5, 17, 64, 100, 511, 512, 1023, 1024, 4096] {
            for (name, text) in corpus {
                XCTAssertEqual(MarkdownStripper.previewSource(text, maxLength: budget),
                               LegacyStripper.previewSource(text, maxLength: budget), "\(name) @\(budget)")
            }
        }
    }

    func testPreviewSourceNeverSplitsAGrapheme() {
        let cases: [(String, String)] = [
            ("emoji run", String(repeating: "🚀", count: 200)),
            ("ZWJ family", String(repeating: "👨‍👩‍👧‍👦", count: 50)),
            ("flag", String(repeating: "🇯🇵", count: 80)),
            ("combining", String(repeating: "é", count: 120) + String(repeating: "e\u{0301}", count: 120)),
            ("CJK", String(repeating: "漢字仮名", count: 100)),
            ("skin tone", String(repeating: "👋🏽", count: 90)),
        ]
        for (name, text) in cases {
            for budget in [1, 2, 3, 7, 33, 100] {
                let out = MarkdownStripper.previewSource(text, maxLength: budget)
                XCTAssertEqual(String(decoding: Array(out.utf8), as: UTF8.self), out, "\(name) @\(budget)")
                XCTAssertLessThanOrEqual(out.count, budget, "\(name) @\(budget)")
                XCTAssertTrue(text.hasPrefix(out), "\(name) @\(budget)")
            }
        }
    }

    func testPlainTextMatchesLegacyBelowTheCap() {
        for (name, text) in corpus where text.count <= MarkdownStripper.inlinePassCap {
            XCTAssertEqual(MarkdownStripper.plainText(text, inlinePassCap: MarkdownStripper.inlinePassCap),
                           LegacyStripper.plainText(text), name)
            XCTAssertEqual(MarkdownStripper.plainText(text), LegacyStripper.plainText(text), name)
        }
    }

    func testPreviewPipelineFirst100CharsUnchanged() {
        for (name, text) in corpus {
            let new = String(MarkdownStripper.plainText(MarkdownStripper.previewSource(text, maxLength: 4096),
                                                        inlinePassCap: MarkdownStripper.inlinePassCap).prefix(100))
            let old = String(LegacyStripper.plainText(LegacyStripper.previewSource(text, maxLength: 4096)).prefix(100))
            XCTAssertEqual(new, old, name)
        }
    }

    func testInlineCapOnlyAffectsTextPastThePreviewWindow() {
        let probe = String(repeating: "word ", count: 3000)
        let capped = MarkdownStripper.plainText(probe, inlinePassCap: MarkdownStripper.inlinePassCap)
        let legacy = LegacyStripper.plainText(probe)
        XCTAssertLessThan(capped.count, legacy.count)
        XCTAssertEqual(String(capped.prefix(100)), String(legacy.prefix(100)))
        XCTAssertGreaterThanOrEqual(capped.count, 900)
        XCTAssertEqual(MarkdownStripper.inlinePassCap, 1024)

        let tableHeavy = (0..<400).map { "| cell \($0) | cell \($0) |" }.joined(separator: "\n")
            + "\nThe actual answer sentence that the user needs to read in the sidebar preview."
        let new = MarkdownStripper.plainText(MarkdownStripper.previewSource(tableHeavy), inlinePassCap: MarkdownStripper.inlinePassCap)
        let old = LegacyStripper.plainText(LegacyStripper.previewSource(tableHeavy))
        XCTAssertEqual(String(new.prefix(100)), String(old.prefix(100)))
    }

    func testUTF8ContainsMatchesFoundationOnPrefix() {
        let cases: [(String, String, Int)] = [
            ("<agent_callback><result>x</result></agent_callback>", "<agent_callback", 4096),
            ("no marker at all here", "<agent_callback", 4096),
            (String(repeating: "x", count: 5000) + "<agent_callback", "<agent_callback", 4096),
            ("<agent_callback" + String(repeating: "y", count: 9000), "<agent_callback", 4096),
            ("中文前缀<agent_callback>", "<agent_callback", 4096),
            ("", "<agent_callback", 4096),
            ("partial <agent_callbac", "<agent_callback", 4096),
            ("aaab", "aab", Int.max),
        ]
        for (hay, needle, limit) in cases {
            XCTAssertEqual(MarkdownStripper.utf8Contains(hay, needle, withinBytes: limit),
                           String(hay.prefix(limit == Int.max ? hay.count : limit)).contains(needle), String(hay.prefix(24)))
        }
    }

    func testTreasuryContextIsSkippedWholeAtTheCut() {
        let text = "Hi <treasury_context untrusted=\"true\">" + String(repeating: "t", count: 6000) + "</treasury_context> tail"
        let out = MarkdownStripper.previewSource(text, maxLength: 4096)
        XCTAssertFalse(out.contains("<treasury_context"))
        XCTAssertFalse(out.contains("tttt"))
        XCTAssertEqual(MarkdownStripper.plainText(out), "Hi tail")
    }
}
