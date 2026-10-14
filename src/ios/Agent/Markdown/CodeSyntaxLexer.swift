//
//  CodeSyntaxLexer.swift
//
//  聊天代码块的词法高亮器（只依赖 Foundation，输出「按 UTF-16 范围的 token 列表」）。
//
//  改写自 MarkdownView 的 Syntax 目录（SyntaxToken / SyntaxWord / SyntaxHighlighter）：
//    https://github.com/Lakr233/MarkdownView
//    Copyright (c) 2025 Lakr Aream
//    MIT License（全文见下，另见仓库根 THIRD_PARTY_LICENSES.md）
//
//  相对上游的改动：类型加 Leo 前缀并去掉对其内部类型/平台的依赖；token 改为 8 类
//  （关键字/字符串/数字/注释/类型/函数/属性/运算符与标点）；输出 [LeoSyntaxSpan] 而不是
//  [NSRange: SyntaxToken]；新增函数调用识别、运算符/标点、diff 的新增/删除/文件头区分、
//  shell 命令行选项；token 边界一律对齐到代理对（emoji 不会被劈成两半）。
//
//  MIT License
//
//  Copyright (c) 2025 Lakr Aream
//
//  Permission is hereby granted, free of charge, to any person obtaining a copy
//  of this software and associated documentation files (the "Software"), to deal
//  in the Software without restriction, including without limitation the rights
//  to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
//  copies of the Software, and to permit persons to whom the Software is
//  furnished to do so, subject to the following conditions:
//
//  The above copyright notice and this permission notice shall be included in all
//  copies or substantial portions of the Software.
//
//  THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
//  IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
//  FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
//  AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
//  LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
//  OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
//  SOFTWARE.
//

import Foundation

// MARK: - Token / Span

/// 一段高亮范围「是什么」。只记类别、不记颜色：同一份结果适用于任何主题，
/// 颜色在 `LeoCodePalette` / `SelectableMarkdownTheme` 里按明暗各取一套。
enum LeoSyntaxToken: Int, CaseIterable, Hashable, Sendable {
    /// 关键字、字面量（true / nil / self）、标记语言的标签名、预处理指令（#if / #include）。
    case keyword
    case string
    /// 数字字面量。
    case number
    case comment
    /// 内置类型、首字母大写的标识符、class / struct 等声明引入的名字。
    case type
    /// func / def 等声明引入的名字、紧跟 `(` 的调用、常见 shell 命令。
    case function
    /// JSON / YAML 的键、标记语言的属性、`@注解` / 装饰器 / `#[属性]`、`$变量`、shell 命令行选项。
    case attribute
    /// 运算符与标点。
    case punctuation
}

/// UTF-16 范围内的一段着色（与 NSAttributedString / NSRange 的计数方式一致）。
/// 一次高亮的结果按 location 升序、互不重叠，相邻同类已合并，边界不会落在代理对中间。
struct LeoSyntaxSpan: Hashable, Sendable {
    var location: Int
    var length: Int
    var token: LeoSyntaxToken

    var end: Int { location + length }
    var range: NSRange { NSRange(location: location, length: length) }
}

// MARK: - UTF-16 code unit helpers

/// 扫描器按 UTF-16 码元工作：位置直接就是 NSRange 的位置，不用在 String.Index 之间换算。
/// 放进命名空间而不是扩展 UInt16，避免与同模块其他文件的扩展重名。
enum LeoSyntaxUnit {
    static let newline: UInt16 = 0x0A
    static let carriageReturn: UInt16 = 0x0D
    static let space: UInt16 = 0x20
    static let tab: UInt16 = 0x09
    static let doubleQuote: UInt16 = 0x22
    static let singleQuote: UInt16 = 0x27
    static let backtick: UInt16 = 0x60
    static let backslash: UInt16 = 0x5C
    static let hash: UInt16 = 0x23
    static let at: UInt16 = 0x40
    static let dollar: UInt16 = 0x24
    static let colon: UInt16 = 0x3A
    static let equals: UInt16 = 0x3D
    static let openParen: UInt16 = 0x28
    static let openBracket: UInt16 = 0x5B
    static let closeBracket: UInt16 = 0x5D
    static let openBrace: UInt16 = 0x7B
    static let closeBrace: UInt16 = 0x7D
    static let lessThan: UInt16 = 0x3C
    static let greaterThan: UInt16 = 0x3E
    static let slash: UInt16 = 0x2F
    static let hyphen: UInt16 = 0x2D
    static let period: UInt16 = 0x2E
    static let plus: UInt16 = 0x2B
    static let exclamation: UInt16 = 0x21
    static let question: UInt16 = 0x3F
    static let asterisk: UInt16 = 0x2A
    static let underscore: UInt16 = 0x5F

    static func isDigit(_ unit: UInt16) -> Bool { unit >= 0x30 && unit <= 0x39 }
    static func isUppercase(_ unit: UInt16) -> Bool { unit >= 0x41 && unit <= 0x5A }
    static func isLetter(_ unit: UInt16) -> Bool { (unit | 0x20) >= 0x61 && (unit | 0x20) <= 0x7A }
    static func isSpace(_ unit: UInt16) -> Bool { unit == space || unit == tab }
    static func isLineBreak(_ unit: UInt16) -> Bool { unit == newline || unit == carriageReturn }

    /// 字母、`_`，以及 ASCII 以外的一切：中文变量名是一个整词。
    static func startsIdentifier(_ unit: UInt16) -> Bool { isLetter(unit) || unit == underscore || unit >= 0x80 }
    static func continuesIdentifier(_ unit: UInt16) -> Bool { startsIdentifier(unit) || isDigit(unit) }

    static func isHighSurrogate(_ unit: UInt16) -> Bool { unit & 0xFC00 == 0xD800 }
    static func isLowSurrogate(_ unit: UInt16) -> Bool { unit & 0xFC00 == 0xDC00 }

    /// 把 `start..<end` 的两端对齐到代理对边界：起点落在低代理项上就退一格，
    /// 终点落在高代理项之后就进一格（再夹到 `0...count`）。落在代理对中间的范围交给
    /// NSAttributedString 会把 emoji 劈成两个孤立码元，渲染成 �。
    static func alignedToSurrogatePairs(_ start: Int, _ end: Int, in units: UnsafeBufferPointer<UInt16>) -> (start: Int, end: Int) {
        let count = units.count
        var from = max(0, min(start, count))
        var to = max(from, min(end, count))
        if from > 0, from < count, isLowSurrogate(units[from]), isHighSurrogate(units[from - 1]) {
            from -= 1
        }
        if to > 0, to < count, isHighSurrogate(units[to - 1]), isLowSurrogate(units[to]) {
            to += 1
        }
        return (from, to)
    }

    /// 运算符与标点。引号、`#`、`@`、`$`、反斜杠不算：它们另有含义，落不进别的规则时保持默认色。
    static func isPunctuation(_ unit: UInt16) -> Bool {
        switch unit {
        case 0x21 ... 0x2F where unit != doubleQuote && unit != hash && unit != dollar && unit != singleQuote:
            // ! % & ( ) * + , - . /
            return true
        case 0x3A ... 0x3F: // : ; < = > ?
            return true
        case openBracket, closeBracket, 0x5E, openBrace, closeBrace, 0x7C, 0x7E: // [ ] ^ { } | ~
            return true
        default:
            return false
        }
    }
}

// MARK: - Packed word

/// 把 ASCII 标识符压进两个整数，查关键字表只需哈希 16 字节、没有分配。
///
/// 每个字符占 6 位，每个整数放 10 个，所以最长 20 个字符，0 表示结束。更长的词、
/// 或含 `[A-Za-z0-9_]` 以外字符的词没有打包形式，永远不是关键字。
struct LeoSyntaxWord: Hashable, Sendable {
    static let maximumLength = 20

    private var low: UInt64 = 0
    private var high: UInt64 = 0

    init?(_ units: UnsafeBufferPointer<UInt16>, from start: Int, to end: Int, foldsCase: Bool) {
        guard end - start <= Self.maximumLength else { return nil }
        for offset in 0 ..< end - start {
            guard let code = Self.code(for: units[start + offset], foldsCase: foldsCase) else { return nil }
            if offset < 10 {
                low |= code << UInt64(offset * 6)
            } else {
                high |= code << UInt64((offset - 10) * 6)
            }
        }
    }

    /// 词表里的词：按它们匹配的大小写书写；大小写不敏感的语言（SQL）一律写小写。
    init(_ word: Substring) {
        let units = Array(word.utf16)
        let packed = units.withUnsafeBufferPointer { buffer in
            Self(buffer, from: 0, to: buffer.count, foldsCase: false)
        }
        guard let packed else {
            preconditionFailure("catalog word '\(word)' cannot be packed")
        }
        self = packed
    }

    private static func code(for unit: UInt16, foldsCase: Bool) -> UInt64? {
        switch unit {
        case 0x61 ... 0x7A: // a-z
            return UInt64(unit - 0x61 + 1)
        case 0x41 ... 0x5A: // A-Z
            return foldsCase ? UInt64(unit - 0x41 + 1) : UInt64(unit - 0x41 + 27)
        case 0x30 ... 0x39: // 0-9
            return UInt64(unit - 0x30 + 53)
        case 0x5F: // _
            return 63
        default:
            return nil
        }
    }
}

extension Set where Element == LeoSyntaxWord {
    /// 用空白分隔的词表建表。
    init(words: String) {
        self.init(words.split(whereSeparator: \.isWhitespace).map(LeoSyntaxWord.init))
    }
}

// MARK: - Entry point

enum LeoSyntaxHighlighter {
    /// 对 `content` 做一趟词法扫描。`language` 是围栏的信息串（取第一个词、不分大小写）。
    ///
    /// 纯文本类语言（text / markdown / log …）与空串返回 `[]`；不认识的语言按通用规则
    /// （// # /* */ 注释、引号字符串、常见关键字）着色，而不是整块放弃。
    /// 这里不做任何大小限制：是否值得着色由 `LeoCodeHighlightLimits` 在调用前决定。
    static func highlight(_ content: String, language info: String?) -> [LeoSyntaxSpan] {
        guard let language = LeoSyntaxLanguage.named(info), !content.isEmpty else { return [] }
        let units = Array(content.utf16)
        return units.withUnsafeBufferPointer { buffer in
            var scanner = LeoSyntaxScanner(units: buffer, language: language)
            scanner.scan()
            return scanner.spans
        }
    }

    /// 这个围栏语言值不值得着色（纯文本类返回 false）。
    static func canHighlight(language info: String?) -> Bool {
        LeoSyntaxLanguage.named(info) != nil
    }

    /// 缓存键里的语言名：围栏信息串的第一个词，小写。
    static func normalizedLanguage(_ info: String?) -> String {
        LeoSyntaxLanguage.name(from: info)
    }
}

// MARK: - Scanner

private struct LeoSyntaxScanner {
    typealias U = LeoSyntaxUnit

    /// 声明之后紧跟的名字是函数而不是类型的那些关键字。
    private static let functionDeclarers = Set<LeoSyntaxWord>(words: "func def fn fun function defn macro macro_rules")

    let units: UnsafeBufferPointer<UInt16>
    let language: LeoSyntaxLanguage
    private let lineComments: [[UInt16]]
    private let blockOpen: [UInt16]
    private let blockClose: [UInt16]

    private(set) var spans: [LeoSyntaxSpan] = []
    private var index = 0
    /// 自上一个换行以来只见过空格。
    private var atLineStart = true
    /// 上一个词是 `func` / `class` 这样的声明关键字：下一个标识符就是被声明的名字（函数或类型）。
    private var expectedName: LeoSyntaxToken?

    init(units: UnsafeBufferPointer<UInt16>, language: LeoSyntaxLanguage) {
        self.units = units
        self.language = language
        lineComments = language.lineComments.map { Array($0.utf16) }
        blockOpen = language.blockComment.map { Array($0.open.utf16) } ?? []
        blockClose = language.blockComment.map { Array($0.close.utf16) } ?? []
    }

    mutating func scan() {
        switch language.mode {
        case .code: scanCode()
        case .markup: scanMarkup()
        case .diff: scanDiff()
        }
    }

    // MARK: Code

    private mutating func scanCode() {
        let count = units.count
        while index < count {
            let unit = units[index]
            if U.isLineBreak(unit) {
                atLineStart = true
                index += 1
                continue
            }
            if U.isSpace(unit) {
                index += 1
                continue
            }
            let start = index
            let lineStart = atLineStart
            atLineStart = false

            if U.startsIdentifier(unit) {
                scanWord()
                continue
            }
            expectedName = nil

            if language.variables, unit == U.dollar, let end = variableEnd(from: start) {
                mark(start, end, .attribute)
            } else if !blockOpen.isEmpty, matches(blockOpen, at: start) {
                let end = find(blockClose, from: start + blockOpen.count).map { $0 + blockClose.count } ?? count
                mark(start, end, .comment)
            } else if startsLineComment(at: start) {
                mark(start, lineEnd(from: start), .comment)
            } else if language.tripleQuotes, unit == U.doubleQuote || unit == U.singleQuote, opensTripleQuote(at: start) {
                let delimiter = [unit, unit, unit]
                let end = find(delimiter, from: start + 3).map { $0 + 3 } ?? count
                mark(start, end, .string)
            } else if language.quotes.contains(unit), let end = stringEnd(from: start, quote: unit) {
                mark(start, end, isKey(before: end) ? .attribute : .string)
            } else if U.isDigit(unit) {
                mark(start, numberEnd(from: start), .number)
            } else if language.directives, unit == U.hash, let found = directive(from: start, atLineStart: lineStart) {
                mark(start, found.end, found.token)
            } else if language.annotations, unit == U.at, start + 1 < count, U.startsIdentifier(units[start + 1]) {
                mark(start, identifierEnd(from: start + 1), .attribute)
            } else if language.optionFlags, unit == U.hyphen, let end = optionEnd(from: start) {
                mark(start, end, .attribute)
            } else if U.isPunctuation(unit) {
                mark(start, start + 1, .punctuation)
            } else {
                index = start + 1
            }
        }
    }

    private mutating func scanWord() {
        let start = index
        let end = identifierEnd(from: start)
        index = end
        let word = LeoSyntaxWord(units, from: start, to: end, foldsCase: language.foldsCase)

        if let word, language.keywords.contains(word) {
            mark(start, end, .keyword)
            if language.declarations.contains(word) {
                expectedName = Self.functionDeclarers.contains(word) ? .function : .type
            } else {
                expectedName = nil
            }
            return
        }
        if let name = expectedName {
            expectedName = nil
            mark(start, end, name)
            return
        }
        if let word {
            if language.literals.contains(word) {
                mark(start, end, .keyword)
                return
            }
            if language.types.contains(word) {
                mark(start, end, .type)
                return
            }
            if language.functions.contains(word) {
                mark(start, end, .function)
                return
            }
        }
        if isKey(before: end) {
            mark(start, end, .attribute)
        } else if language.capitalizedTypes, U.isUppercase(units[start]) {
            mark(start, end, .type)
        } else if language.calls, end < units.count, units[end] == U.openParen {
            mark(start, end, .function)
        }
    }

    private func identifierEnd(from start: Int) -> Int {
        var end = start + 1
        while end < units.count {
            let unit = units[end]
            if U.continuesIdentifier(unit) {
                end += 1
            } else if language.hyphenatedWords, unit == U.hyphen,
                      end + 1 < units.count, U.continuesIdentifier(units[end + 1])
            {
                end += 2
            } else {
                break
            }
        }
        return end
    }

    /// `end` 处的词法单元后面是否紧跟语言的键分隔符：JSON 的 `"name":`、YAML 的 `name:`、TOML 的 `name =`。
    private func isKey(before end: Int) -> Bool {
        guard let separator = language.keySeparator else { return false }
        var cursor = end
        while cursor < units.count, U.isSpace(units[cursor]) {
            cursor += 1
        }
        guard cursor < units.count, units[cursor] == separator else { return false }
        guard cursor + 1 < units.count else { return true }
        let following = units[cursor + 1]
        // `a::b` 是路径、`a == b` 是比较，都不是键。
        if following == separator { return false }
        return !language.keyNeedsTrailingSpace || U.isSpace(following) || U.isLineBreak(following)
    }

    private func startsLineComment(at start: Int) -> Bool {
        for prefix in lineComments where matches(prefix, at: start) {
            // 词中的 `#` 不是注释：`a#b`、URL 片段、`$#`。
            if prefix == [U.hash], start > 0, U.continuesIdentifier(units[start - 1]) || units[start - 1] == U.dollar {
                continue
            }
            return true
        }
        return false
    }

    private func opensTripleQuote(at start: Int) -> Bool {
        start + 2 < units.count && units[start + 1] == units[start] && units[start + 2] == units[start]
    }

    /// 从 `start` 开的字符串的结束位置；该闭合的地方没闭合就返回 nil，所以落单的撇号不会被当成字符串。
    private func stringEnd(from start: Int, quote: UInt16) -> Int? {
        let count = units.count
        if quote == U.singleQuote, language.singleQuoteIsCharacter {
            return characterLiteralEnd(from: start)
        }
        let multiline = language.multilineQuotes.contains(quote)
        var cursor = start + 1
        while cursor < count {
            let unit = units[cursor]
            if unit == U.backslash {
                cursor += 2
                continue
            }
            if unit == quote {
                return cursor + 1
            }
            if U.isLineBreak(unit), !multiline {
                return nil
            }
            cursor += 1
        }
        // 还在流式输出中的多行字符串一直延伸到末尾。
        return multiline ? count : nil
    }

    /// `'a'`、`'\n'`、`'\u{1F600}'`；其余（比如 `&'a str` 里的生命周期）不是字面量。
    private func characterLiteralEnd(from start: Int) -> Int? {
        let count = units.count
        guard start + 2 < count else { return nil }
        if units[start + 1] != U.backslash {
            return units[start + 2] == U.singleQuote ? start + 3 : nil
        }
        var cursor = start + 2
        while cursor < min(count, start + 12) {
            if units[cursor] == U.singleQuote {
                return cursor + 1
            }
            if U.isLineBreak(units[cursor]) {
                return nil
            }
            cursor += 1
        }
        return nil
    }

    /// `42`、`0x1F`、`3.14`、`1_000`、`2.5e3`、`10px`；`1..5` 这样的区间停在点号前。
    private func numberEnd(from start: Int) -> Int {
        let count = units.count
        var end = start + 1
        while end < count {
            let unit = units[end]
            if U.continuesIdentifier(unit), unit < 0x80 {
                end += 1
            } else if unit == U.period, end + 1 < count, U.isDigit(units[end + 1]) {
                end += 1
            } else if unit == U.plus || unit == U.hyphen, (units[end - 1] | 0x20) == 0x65,
                      end + 1 < count, U.isDigit(units[end + 1]), !isHexadecimal(from: start)
            {
                end += 1
            } else {
                break
            }
        }
        return end
    }

    private func isHexadecimal(from start: Int) -> Bool {
        start + 1 < units.count && units[start] == 0x30 && (units[start + 1] | 0x20) == 0x78
    }

    /// `#include`、`#if`、`#available` 算关键字；Rust 的 `#[derive(Debug)]` 整段算属性。
    private func directive(from start: Int, atLineStart: Bool) -> (end: Int, token: LeoSyntaxToken)? {
        let count = units.count
        var cursor = start + 1
        if cursor < count, units[cursor] == U.exclamation {
            cursor += 1
        }
        if cursor < count, units[cursor] == U.openBracket {
            let line = lineEnd(from: cursor)
            var depth = 0
            while cursor < line {
                if units[cursor] == U.openBracket {
                    depth += 1
                }
                if units[cursor] == U.closeBracket {
                    depth -= 1
                }
                cursor += 1
                if depth == 0 {
                    return (cursor, .attribute)
                }
            }
            return (line, .attribute)
        }
        // C 允许 `#  define`；只有在行首才算指令。
        if atLineStart {
            while cursor < count, U.isSpace(units[cursor]) {
                cursor += 1
            }
        }
        guard cursor < count, U.isLetter(units[cursor]) else { return nil }
        return (identifierEnd(from: cursor), .keyword)
    }

    /// `$name`、`${name}`、`$1`、`$@`；落单的 `$` 返回 nil。
    private func variableEnd(from start: Int) -> Int? {
        let count = units.count
        guard start + 1 < count else { return nil }
        let next = units[start + 1]
        if next == U.openBrace {
            let line = lineEnd(from: start)
            var cursor = start + 2
            while cursor < line {
                if units[cursor] == U.closeBrace {
                    return cursor + 1
                }
                cursor += 1
            }
            return nil
        }
        if U.startsIdentifier(next), next < 0x80 {
            return identifierEnd(from: start + 1)
        }
        if U.isDigit(next) || next == U.at || next == U.hash || next == U.question || next == U.exclamation
            || next == U.dollar || next == U.asterisk
        {
            return start + 2
        }
        return nil
    }

    /// shell 的命令行选项：`-l`、`-rf`、`--force`、`--dry-run`。前面必须是空白或行首，
    /// 后面必须跟字母，所以 `a - b`、`cd -`、`x-y` 里的减号不受影响。
    private func optionEnd(from start: Int) -> Int? {
        if start > 0, !U.isSpace(units[start - 1]), !U.isLineBreak(units[start - 1]) {
            return nil
        }
        var cursor = start + 1
        if cursor < units.count, units[cursor] == U.hyphen {
            cursor += 1
        }
        guard cursor < units.count, U.isLetter(units[cursor]) else { return nil }
        while cursor < units.count {
            let unit = units[cursor]
            guard U.isLetter(unit) || U.isDigit(unit) || unit == U.underscore || unit == U.hyphen else { break }
            cursor += 1
        }
        return cursor
    }

    // MARK: Markup

    private mutating func scanMarkup() {
        let count = units.count
        var insideTag = false
        while index < count {
            let start = index
            let unit = units[start]

            if matches(Self.markupCommentOpen, at: start) {
                let close = find(Self.markupCommentClose, from: start + 4)
                let end = close.map { $0 + Self.markupCommentClose.count } ?? count
                mark(start, end, .comment)
                continue
            }
            if !insideTag {
                if unit == U.lessThan, start + 1 < count {
                    var cursor = start + 1
                    let next = units[cursor]
                    if next == U.question || next == U.exclamation {
                        // `<?xml …?>`、`<!DOCTYPE html>`
                        let end = find([U.greaterThan], from: cursor).map { $0 + 1 } ?? lineEnd(from: cursor)
                        mark(start, end, .keyword)
                        continue
                    }
                    if next == U.slash {
                        cursor += 1
                    }
                    if cursor < count, U.startsIdentifier(units[cursor]) {
                        let end = markupNameEnd(from: cursor)
                        mark(cursor, end, .keyword)
                        insideTag = true
                        index = end
                        continue
                    }
                }
                index = start + 1
                continue
            }

            if unit == U.greaterThan {
                insideTag = false
                index = start + 1
            } else if unit == U.doubleQuote || unit == U.singleQuote {
                let end = find([unit], from: start + 1).map { $0 + 1 } ?? count
                mark(start, end, .string)
            } else if U.startsIdentifier(unit) {
                mark(start, markupNameEnd(from: start), .attribute)
            } else {
                index = start + 1
            }
        }
    }

    private static let markupCommentOpen: [UInt16] = Array("<!--".utf16)
    private static let markupCommentClose: [UInt16] = Array("-->".utf16)

    /// 标签名与属性名：`svg:path`、`data-id`、`v-on:click`、`@click`。
    private func markupNameEnd(from start: Int) -> Int {
        var end = start + 1
        while end < units.count {
            let unit = units[end]
            guard U.continuesIdentifier(unit) || unit == U.hyphen || unit == U.colon || unit == U.period else { break }
            end += 1
        }
        return end
    }

    // MARK: Diff

    /// 统一 diff，按每行的首字符着色：新增 = 字符串色（绿），删除 = 关键字色（粉红），
    /// 块头 `@@` 与文件头 `---` / `+++` = 属性色，`diff` / `index` 等元信息 = 注释色。
    private mutating func scanDiff() {
        let count = units.count
        var insideHunk = false
        while index < count {
            let start = index
            let end = lineEnd(from: start)
            if end > start {
                switch units[start] {
                case U.plus:
                    mark(start, end, !insideHunk && matches(Self.diffNewFile, at: start) ? .attribute : .string)
                case U.hyphen:
                    mark(start, end, !insideHunk && matches(Self.diffOldFile, at: start) ? .attribute : .keyword)
                case U.at:
                    if matches(Self.diffHunk, at: start) {
                        insideHunk = true
                        mark(start, end, .attribute)
                    }
                case U.backslash:
                    mark(start, end, .comment) // `\ No newline at end of file`
                default:
                    if startsDiffMetadata(at: start) {
                        insideHunk = false
                        mark(start, end, .comment)
                    }
                }
            }
            index = max(index, end)
            while index < count, U.isLineBreak(units[index]) {
                index += 1
            }
        }
    }

    private static let diffNewFile: [UInt16] = Array("+++".utf16)
    private static let diffOldFile: [UInt16] = Array("---".utf16)
    private static let diffHunk: [UInt16] = Array("@@".utf16)
    private static let diffMetadata: [[UInt16]] = [
        "diff ", "index ", "new file", "deleted file", "old mode", "new mode",
        "similarity index", "rename from", "rename to", "copy from", "copy to", "Binary files",
    ].map { Array($0.utf16) }

    private func startsDiffMetadata(at start: Int) -> Bool {
        Self.diffMetadata.contains { matches($0, at: start) }
    }

    // MARK: Helpers

    /// 给 `start..<end` 上色并越过它。
    ///
    /// 边界一律对齐到代理对：起点落在低代理项上就退一格，终点落在高代理项后就进一格，
    /// 并且不与上一段重叠。所以无论词法规则怎么走，吐出的范围都能安全交给 NSAttributedString。
    private mutating func mark(_ start: Int, _ end: Int, _ token: LeoSyntaxToken) {
        index = max(index, end)
        guard min(end, units.count) > start else { return }
        let aligned = U.alignedToSurrogatePairs(start, end, in: units)
        let from = max(aligned.start, spans.last?.end ?? 0)
        let to = aligned.end
        guard to > from else { return }
        index = max(index, to)
        if let last = spans.last, last.token == token, last.end == from {
            spans[spans.count - 1].length = to - last.location
        } else {
            spans.append(LeoSyntaxSpan(location: from, length: to - from, token: token))
        }
    }

    private func matches(_ pattern: [UInt16], at start: Int) -> Bool {
        guard start + pattern.count <= units.count else { return false }
        for offset in 0 ..< pattern.count where units[start + offset] != pattern[offset] {
            return false
        }
        return true
    }

    private func find(_ pattern: [UInt16], from start: Int) -> Int? {
        guard let first = pattern.first else { return nil }
        var cursor = start
        while cursor + pattern.count <= units.count {
            if units[cursor] == first, matches(pattern, at: cursor) {
                return cursor
            }
            cursor += 1
        }
        return nil
    }

    private func lineEnd(from start: Int) -> Int {
        var cursor = start
        while cursor < units.count, !U.isLineBreak(units[cursor]) {
            cursor += 1
        }
        return cursor
    }
}
