import Foundation
import cmark_gfm
import cmark_gfm_extensions

private let markdownLogger = AppLogger(category: "MarkdownParser")

// MARK: - Block & Inline Node types (inlined from swift-markdown-ui)

enum BlockNode: Hashable {
    case blockquote(children: [BlockNode])
    case bulletedList(isTight: Bool, items: [RawListItem])
    case numberedList(isTight: Bool, start: Int, items: [RawListItem])
    case taskList(isTight: Bool, items: [RawTaskListItem])
    case codeBlock(fenceInfo: String?, content: String)
    case htmlBlock(content: String)
    case paragraph(content: [InlineNode])
    case heading(level: Int, content: [InlineNode])
    case table(columnAlignments: [RawTableColumnAlignment], rows: [RawTableRow])
    case thematicBreak
    case mathBlock(content: String)
}

extension BlockNode {
    var children: [BlockNode] {
        switch self {
        case .blockquote(let children):
            return children
        case .bulletedList(_, let items):
            return items.map(\.children).flatMap { $0 }
        case .numberedList(_, _, let items):
            return items.map(\.children).flatMap { $0 }
        case .taskList(_, let items):
            return items.map(\.children).flatMap { $0 }
        default:
            return []
        }
    }

    var isParagraph: Bool {
        guard case .paragraph = self else { return false }
        return true
    }
}

struct RawListItem: Hashable {
    let children: [BlockNode]
}

struct RawTaskListItem: Hashable {
    let isCompleted: Bool
    let children: [BlockNode]
}

enum RawTableColumnAlignment: Character {
    case none = "\0"
    case left = "l"
    case center = "c"
    case right = "r"
}

struct RawTableRow: Hashable {
    let cells: [RawTableCell]
}

struct RawTableCell: Hashable {
    let content: [InlineNode]
}

enum InlineNode: Hashable, Sendable {
    case text(String)
    case softBreak
    case lineBreak
    case code(String)
    case html(String)
    case emphasis(children: [InlineNode])
    case strong(children: [InlineNode])
    case strikethrough(children: [InlineNode])
    case link(destination: String, children: [InlineNode])
    case image(source: String, children: [InlineNode])
    case inlineMath(String)
}

extension InlineNode {
    var children: [InlineNode] {
        get {
            switch self {
            case .emphasis(let children): return children
            case .strong(let children): return children
            case .strikethrough(let children): return children
            case .link(_, let children): return children
            case .image(_, let children): return children
            case .inlineMath: return []
            default: return []
            }
        }
        set {
            switch self {
            case .emphasis: self = .emphasis(children: newValue)
            case .strong: self = .strong(children: newValue)
            case .strikethrough: self = .strikethrough(children: newValue)
            case .link(let destination, _): self = .link(destination: destination, children: newValue)
            case .image(let source, _): self = .image(source: source, children: newValue)
            default: break
            }
        }
    }
}

// MARK: - MarkdownContent (minimal replacement for MarkdownUI.MarkdownContent)

struct MarkdownContent: Hashable {
    let blocks: [BlockNode]

    init(_ markdown: String) {
        // [T-r3-markdown-hardening] Bounded before anything recursive sees it:
        // bidi overrides / combining-mark floods are stripped and blockquote
        // nesting past 8 levels becomes literal text.
        // [B21] Past 200k characters the remainder is one plain code block.
        let (head, overflow) = MarkdownSizeGuard.split(markdown)
        let bounded = MarkdownNestingGuard.collapseDeepBlockquotes(MarkdownTextSanitizer.sanitize(head))
        let (cleaned, mathSpans) = MarkdownMathExtractor.extract(from: bounded)
        let parsed = [BlockNode](markdown: cleaned)
        var blocks = mathSpans.isEmpty ? parsed : MarkdownMathExtractor.restore(blocks: parsed, spans: mathSpans)
        if let overflow {
            blocks.append(.codeBlock(fenceInfo: nil, content: MarkdownTextSanitizer.sanitize(overflow)))
        }
        self.blocks = blocks
    }

    init(blocks: [BlockNode]) {
        self.blocks = blocks
    }
}

// MARK: - Math Extraction

/// Extracts LaTeX math from markdown before cmark parsing, then restores math nodes in the AST.
enum MarkdownMathExtractor {
    struct MathSpan {
        let placeholder: String
        let latex: String
        let isBlock: Bool
    }

    /// Extract math expressions, replacing them with placeholders.
    /// Returns the cleaned markdown and the list of extracted spans.
    static func extract(from markdown: String) -> (String, [MathSpan]) {
        var spans: [MathSpan] = []
        var result = ""
        // Fast path: nothing that can start math → nothing to extract.
        guard markdown.utf8.contains(where: { $0 == UInt8(ascii: "$") || $0 == UInt8(ascii: "\\") }) else {
            return (markdown, [])
        }
        let chars = Array(markdown)
        let count = chars.count
        var i = 0
        // [T-r3-markdown-hardening] Closer lookups are O(1) amortised: every
        // search below used to rescan to the end of the line / document for
        // each opener, so 100k unclosed `$` took O(n²) on the main thread.
        let closers = MathCloserIndex(chars)
        let backticks = BacktickRunIndex(chars)

        // Track code fences and inline code to skip them
        var inFencedCode = false
        var fenceChar: Character = "`"
        var fenceLen = 0

        while i < count {
            // Check for fenced code blocks (``` or ~~~)
            if !inFencedCode && (i == 0 || chars[i - 1] == "\n" || (i > 0 && chars[i - 1] == "\r")) {
                let fc = chars[i]
                if fc == "`" || fc == "~" {
                    var fl = 0
                    var j = i
                    while j < count && chars[j] == fc { fl += 1; j += 1 }
                    if fl >= 3 {
                        inFencedCode = true
                        fenceChar = fc
                        fenceLen = fl
                        // Copy the fence line
                        while i < count && chars[i] != "\n" {
                            result.append(chars[i]); i += 1
                        }
                        if i < count { result.append(chars[i]); i += 1 } // newline
                        continue
                    }
                }
            }

            if inFencedCode {
                // Look for closing fence
                if (i == 0 || chars[i - 1] == "\n") && chars[i] == fenceChar {
                    var fl = 0
                    var j = i
                    while j < count && chars[j] == fenceChar { fl += 1; j += 1 }
                    if fl >= fenceLen {
                        inFencedCode = false
                        // Copy through the rest of the fence line
                        while i < count && chars[i] != "\n" {
                            result.append(chars[i]); i += 1
                        }
                        if i < count { result.append(chars[i]); i += 1 }
                        continue
                    }
                }
                result.append(chars[i]); i += 1
                continue
            }

            // Skip inline code spans
            if chars[i] == "`" {
                var backtickLen = 0
                var j = i
                while j < count && chars[j] == "`" { backtickLen += 1; j += 1 }
                // Find matching closing backticks (indexed: no rescan per opener)
                if let k = backticks.closingRunStart(length: backtickLen, after: j) {
                    result.append(contentsOf: String(chars[i..<(k + backtickLen)]))
                    i = k + backtickLen
                    continue
                }
                // No matching close — just output the backticks
                result.append(contentsOf: String(chars[i..<j]))
                i = j
                continue
            }

            // Escaped dollar sign
            if chars[i] == "\\" && i + 1 < count && chars[i + 1] == "$" {
                result.append(chars[i]); result.append(chars[i + 1])
                i += 2
                continue
            }

            // Check for \[ ... \] (display math)
            if chars[i] == "\\" && i + 1 < count && chars[i + 1] == "[" {
                if let end = closers.next(.displayBracket, from: i + 2) {
                    let latex = String(chars[(i + 2)..<end])
                    let placeholder = "\u{FFFC}MATH\(spans.count)\u{FFFC}"
                    spans.append(MathSpan(placeholder: placeholder, latex: latex, isBlock: true))
                    result.append(placeholder)
                    i = end + 2 // skip past \]
                    continue
                }
            }

            // Check for \( ... \) (inline math)
            if chars[i] == "\\" && i + 1 < count && chars[i + 1] == "(" {
                if let end = closers.next(.inlineParen, from: i + 2) {
                    let latex = String(chars[(i + 2)..<end])
                    let placeholder = "\u{FFFC}MATH\(spans.count)\u{FFFC}"
                    spans.append(MathSpan(placeholder: placeholder, latex: latex, isBlock: false))
                    result.append(placeholder)
                    i = end + 2
                    continue
                }
            }

            // Check for $$ ... $$ (display math)
            if chars[i] == "$" && i + 1 < count && chars[i + 1] == "$" {
                if let end = closers.next(.doubleDollar, from: i + 2) {
                    let latex = String(chars[(i + 2)..<end])
                    let placeholder = "\u{FFFC}MATH\(spans.count)\u{FFFC}"
                    spans.append(MathSpan(placeholder: placeholder, latex: latex, isBlock: true))
                    result.append(placeholder)
                    i = end + 2
                    continue
                }
            }

            // Check for $ ... $ (inline math)
            if chars[i] == "$" && i + 1 < count && chars[i + 1] != "$" && chars[i + 1] != " " {
                if let end = closers.singleDollar(from: i + 1) {
                    let latex = String(chars[(i + 1)..<end])
                    // Heuristic: skip plain currency like $5, $10.
                    // [T-ios-table-cell-katex-false-positive] Also skip a span
                    // that is really a table-cell artifact: a row like
                    // `| 月付 | $20|$ **3** |` lets the `$` at `$20` pair with a
                    // later `$` and capture `20|` (a number + the column pipe)
                    // as a fake formula — rendered serif-italic with the bold
                    // `**3**` lost. See isTablePipeArtifact for the rule
                    // (whitespace-adjacent or unbalanced bars), which preserves
                    // real absolute-value formulas like $|x|$ / $\|v\|$.
                    if looksLikeMath(latex) && !isTablePipeArtifact(latex) {
                        let placeholder = "\u{FFFC}MATH\(spans.count)\u{FFFC}"
                        spans.append(MathSpan(placeholder: placeholder, latex: latex, isBlock: false))
                        result.append(placeholder)
                        i = end + 1
                        continue
                    }
                }
            }

            result.append(chars[i])
            i += 1
        }

        return (result, spans)
    }

    /// Restore math nodes in the parsed AST by replacing placeholder text nodes.
    static func restore(blocks: [BlockNode], spans: [MathSpan]) -> [BlockNode] {
        let placeholderMap = Dictionary(uniqueKeysWithValues: spans.map { ($0.placeholder, $0) })
        return blocks.map { restoreBlock($0, placeholderMap: placeholderMap) }
    }

    // MARK: - Private Helpers

    /// Precomputed closer positions for every math delimiter, so each opener
    /// finds its closer in O(log n) instead of scanning forward. Semantics
    /// match the old scanners exactly:
    ///   - `\]`, `\)`, `$$`: the first occurrence at or after `from`;
    ///   - single `$`: the first `$` at or after `from` on the same line that
    ///     is not escaped by a preceding `\` (escapes are consumed pairwise
    ///     from `from`, as the old scanner did) and not preceded by a space.
    struct MathCloserIndex {
        enum Kind { case displayBracket, inlineParen, doubleDollar }
        private var positions: [Kind: [Int]] = [:]
        /// For the single-dollar scan: position of the next newline at or after i.
        private let nextNewline: [Int]
        /// Candidate `$` closers (not preceded by a space), ascending.
        private let dollarCandidates: [Int]
        private let chars: [Character]

        init(_ chars: [Character]) {
            self.chars = chars
            let n = chars.count
            var bracket: [Int] = [], paren: [Int] = [], dd: [Int] = [], dollars: [Int] = []
            var newline = [Int](repeating: n, count: n + 1)
            var i = n - 1
            while i >= 0 {
                newline[i] = chars[i] == "\n" ? i : newline[i + 1]
                i -= 1
            }
            for j in 0..<n {
                let c = chars[j]
                if c == "\\", j + 1 < n {
                    if chars[j + 1] == "]" { bracket.append(j) }
                    if chars[j + 1] == ")" { paren.append(j) }
                } else if c == "$" {
                    if j + 1 < n, chars[j + 1] == "$" { dd.append(j) }
                    if j == 0 || chars[j - 1] != " " { dollars.append(j) }
                }
            }
            positions = [.displayBracket: bracket, .inlineParen: paren, .doubleDollar: dd]
            nextNewline = newline
            dollarCandidates = dollars
        }

        func next(_ kind: Kind, from start: Int) -> Int? {
            guard let list = positions[kind] else { return nil }
            return Self.firstAtOrAfter(start, in: list)
        }

        /// The old `findSingleDollar`: walk from `start`, skipping `\x` pairs,
        /// stop at a newline. Escapes are only relevant for candidates whose
        /// preceding character is a backslash; those (rare) are verified with
        /// a bounded local scan, everything else is a binary search.
        func singleDollar(from start: Int) -> Int? {
            guard start < chars.count else { return nil }
            let lineEnd = nextNewline[start]
            var from = start
            while let cand = Self.firstAtOrAfter(from, in: dollarCandidates), cand < lineEnd {
                if isEscaped(cand, scanStart: start) {
                    from = cand + 1
                    continue
                }
                return cand
            }
            return nil
        }

        /// True when the pairwise `\` walk that starts at `scanStart` would
        /// consume the character at `pos` as the second half of an escape.
        private func isEscaped(_ pos: Int, scanStart: Int) -> Bool {
            var run = 0
            var k = pos - 1
            while k >= scanStart, chars[k] == "\\" { run += 1; k -= 1 }
            // The run of backslashes immediately before `pos` started at k+1.
            // The walk reaches k+1 aligned (it is either scanStart or follows a
            // non-backslash char, which the walk steps over one at a time), so
            // an odd run escapes `pos`.
            return run % 2 == 1
        }

        private static func firstAtOrAfter(_ value: Int, in list: [Int]) -> Int? {
            var lo = 0, hi = list.count
            while lo < hi {
                let mid = (lo + hi) / 2
                if list[mid] < value { lo = mid + 1 } else { hi = mid }
            }
            return lo < list.count ? list[lo] : nil
        }
    }

    /// Heuristic: content looks like LaTeX if it contains special chars or is long enough.
    private static func looksLikeMath(_ content: String) -> Bool {
        if content.isEmpty { return false }
        let mathChars: Set<Character> = ["\\", "^", "_", "{", "}", "∫", "∑", "∏", "√"]
        for ch in content {
            if mathChars.contains(ch) { return true }
        }
        // Length > 2 also qualifies (e.g., "x+y")
        return content.count > 2
    }

    /// [T-ios-table-cell-katex-false-positive] True when a candidate inline-math
    /// span is really a markdown table-cell artifact (a `$` that paired across
    /// `|` column separators) rather than a formula. Two signals, both of which
    /// a real formula avoids:
    ///   1. An unescaped pipe with whitespace on a side — the table column
    ///      separator is written ` | ` / `| ` / ` |`. Real LaTeX keeps pipes
    ///      flush against operands.
    ///   2. An ODD number of unescaped pipes — absolute-value / norm bars always
    ///      come in balanced pairs (`|x|`, `\frac{|a|}{|b|}`), so an odd count
    ///      (e.g. `20|`, `240|`) is a stray column separator, not math.
    /// Escaped `\|` (LaTeX norm) is never counted as a bare pipe.
    private static func isTablePipeArtifact(_ content: String) -> Bool {
        let chars = Array(content)
        var bareCount = 0
        for (idx, ch) in chars.enumerated() where ch == "|" {
            if idx > 0 && chars[idx - 1] == "\\" { continue }   // escaped norm bar
            bareCount += 1
            let prevIsSpace = idx > 0 && chars[idx - 1].isWhitespace
            let nextIsSpace = idx + 1 < chars.count && chars[idx + 1].isWhitespace
            if prevIsSpace || nextIsSpace { return true }
        }
        return bareCount % 2 == 1
    }

    private static func restoreBlock(_ block: BlockNode, placeholderMap: [String: MathSpan]) -> BlockNode {
        switch block {
        case .paragraph(let content):
            let restored = restoreInlines(content, placeholderMap: placeholderMap)
            // If paragraph contains only a single block-math placeholder, promote to mathBlock
            if restored.count == 1, case .inlineMath(let latex) = restored[0] {
                if let span = placeholderMap.values.first(where: { $0.latex == latex && $0.isBlock }) {
                    return .mathBlock(content: span.latex)
                }
            }
            // Check for mathBlock in a paragraph that has only whitespace + the math
            let nonWhitespace = restored.filter {
                switch $0 {
                case .text(let t): return !t.trimmingCharacters(in: .whitespaces).isEmpty
                case .softBreak, .lineBreak: return false
                default: return true
                }
            }
            if nonWhitespace.count == 1, case .inlineMath(let latex) = nonWhitespace[0] {
                if let span = placeholderMap.values.first(where: { $0.latex == latex && $0.isBlock }) {
                    return .mathBlock(content: span.latex)
                }
            }
            return .paragraph(content: restored)
        case .heading(let level, let content):
            return .heading(level: level, content: restoreInlines(content, placeholderMap: placeholderMap))
        case .blockquote(let children):
            return .blockquote(children: children.map { restoreBlock($0, placeholderMap: placeholderMap) })
        case .bulletedList(let isTight, let items):
            return .bulletedList(isTight: isTight, items: items.map {
                RawListItem(children: $0.children.map { restoreBlock($0, placeholderMap: placeholderMap) })
            })
        case .numberedList(let isTight, let start, let items):
            return .numberedList(isTight: isTight, start: start, items: items.map {
                RawListItem(children: $0.children.map { restoreBlock($0, placeholderMap: placeholderMap) })
            })
        case .taskList(let isTight, let items):
            return .taskList(isTight: isTight, items: items.map {
                RawTaskListItem(isCompleted: $0.isCompleted, children: $0.children.map { restoreBlock($0, placeholderMap: placeholderMap) })
            })
        case .table(let alignments, let rows):
            return .table(columnAlignments: alignments, rows: rows.map { row in
                RawTableRow(cells: row.cells.map { cell in
                    RawTableCell(content: restoreInlines(cell.content, placeholderMap: placeholderMap))
                })
            })
        default:
            return block
        }
    }

    private static func restoreInlines(_ inlines: [InlineNode], placeholderMap: [String: MathSpan]) -> [InlineNode] {
        inlines.flatMap { restoreInline($0, placeholderMap: placeholderMap) }
    }

    private static func restoreInline(_ node: InlineNode, placeholderMap: [String: MathSpan]) -> [InlineNode] {
        switch node {
        case .text(let text):
            return splitTextWithPlaceholders(text, placeholderMap: placeholderMap)
        case .emphasis(let children):
            return [.emphasis(children: children.flatMap { restoreInline($0, placeholderMap: placeholderMap) })]
        case .strong(let children):
            return [.strong(children: children.flatMap { restoreInline($0, placeholderMap: placeholderMap) })]
        case .strikethrough(let children):
            return [.strikethrough(children: children.flatMap { restoreInline($0, placeholderMap: placeholderMap) })]
        case .link(let dest, let children):
            return [.link(destination: dest, children: children.flatMap { restoreInline($0, placeholderMap: placeholderMap) })]
        case .image(let src, let children):
            return [.image(source: src, children: children.flatMap { restoreInline($0, placeholderMap: placeholderMap) })]
        default:
            return [node]
        }
    }

    private static func splitTextWithPlaceholders(_ text: String, placeholderMap: [String: MathSpan]) -> [InlineNode] {
        var result: [InlineNode] = []
        var remaining = text

        while !remaining.isEmpty {
            // Find the next placeholder
            var earliest: (range: Range<String.Index>, span: MathSpan)?
            for (placeholder, span) in placeholderMap {
                if let range = remaining.range(of: placeholder) {
                    if earliest == nil || range.lowerBound < earliest!.range.lowerBound {
                        earliest = (range, span)
                    }
                }
            }

            guard let match = earliest else {
                result.append(.text(remaining))
                break
            }

            // Text before the placeholder
            let before = String(remaining[remaining.startIndex..<match.range.lowerBound])
            if !before.isEmpty {
                result.append(.text(before))
            }

            // The math node
            result.append(.inlineMath(match.span.latex))

            remaining = String(remaining[match.range.upperBound...])
        }

        return result
    }
}

// MARK: - cmark parsing glue

// [T-r3-markdown-hardening] The walker is depth-limited: cmark builds any
// nesting iteratively, but this conversion (and every renderer after it)
// recursed once per level, so 2000 nested quotes / lists / emphasis overflowed
// the stack. Past the limit a subtree is flattened to its plain text, collected
// with cmark's own iterator (no recursion). Unknown node types are skipped and
// logged instead of `fatalError`.

extension Array where Element == BlockNode {
    init(markdown: String) {
        let blocks = UnsafeNode.parseMarkdown(markdown) { document in
            document.children.compactMap { BlockNode(unsafeNode: $0, depth: 0) }
        }
        self.init(blocks ?? .init())
    }
}

extension BlockNode {
    fileprivate init?(unsafeNode: UnsafeNode, depth: Int) {
        if depth >= MarkdownNestingGuard.maxBlockDepth {
            let text = unsafeNode.flattenedText
            guard !text.isEmpty else { return nil }
            self = .paragraph(content: [.text(text)])
            return
        }
        let childDepth = depth + 1
        func blockChildren() -> [BlockNode] {
            unsafeNode.children.compactMap { BlockNode(unsafeNode: $0, depth: childDepth) }
        }
        func inlineChildren() -> [InlineNode] {
            unsafeNode.children.compactMap { InlineNode(unsafeNode: $0, depth: 0) }
        }
        switch unsafeNode.nodeType {
        case .blockquote:
            self = .blockquote(children: blockChildren())
        case .list:
            if unsafeNode.children.contains(where: \.isTaskListItem) {
                self = .taskList(
                    isTight: unsafeNode.isTightList,
                    items: unsafeNode.children.map { RawTaskListItem(unsafeNode: $0, depth: childDepth) }
                )
            } else {
                let items = unsafeNode.children.map { RawListItem(unsafeNode: $0, depth: childDepth) }
                switch unsafeNode.listType {
                case CMARK_ORDERED_LIST:
                    self = .numberedList(isTight: unsafeNode.isTightList, start: unsafeNode.listStart, items: items)
                default:
                    // CMARK_BULLET_LIST, and (defensively) a list without a type.
                    self = .bulletedList(isTight: unsafeNode.isTightList, items: items)
                }
            }
        case .codeBlock:
            self = .codeBlock(fenceInfo: unsafeNode.fenceInfo, content: unsafeNode.literal ?? "")
        case .htmlBlock:
            self = .htmlBlock(content: unsafeNode.literal ?? "")
        case .paragraph:
            self = .paragraph(content: inlineChildren())
        case .heading:
            self = .heading(level: unsafeNode.headingLevel, content: inlineChildren())
        case .table:
            self = .table(
                columnAlignments: unsafeNode.tableAlignments,
                rows: unsafeNode.children.compactMap(RawTableRow.init(unsafeNode:))
            )
        case .thematicBreak:
            self = .thematicBreak
        default:
            markdownLogger.warning("skipping unhandled block node '\(unsafeNode.nodeType.rawValue)'")
            return nil
        }
    }
}

extension RawListItem {
    fileprivate init(unsafeNode: UnsafeNode, depth: Int) {
        // A non-item child (never produced by cmark) contributes its content
        // instead of crashing.
        self.init(children: unsafeNode.children.compactMap { BlockNode(unsafeNode: $0, depth: depth) })
    }
}

extension RawTaskListItem {
    fileprivate init(unsafeNode: UnsafeNode, depth: Int) {
        self.init(
            isCompleted: unsafeNode.nodeType == .taskListItem && unsafeNode.isTaskListItemChecked,
            children: unsafeNode.children.compactMap { BlockNode(unsafeNode: $0, depth: depth) }
        )
    }
}

extension RawTableRow {
    fileprivate init?(unsafeNode: UnsafeNode) {
        guard unsafeNode.nodeType == .tableRow || unsafeNode.nodeType == .tableHead else {
            markdownLogger.warning("skipping unexpected table child '\(unsafeNode.nodeType.rawValue)'")
            return nil
        }
        self.init(cells: unsafeNode.children.compactMap(RawTableCell.init(unsafeNode:)))
    }
}

extension RawTableCell {
    fileprivate init?(unsafeNode: UnsafeNode) {
        guard unsafeNode.nodeType == .tableCell else {
            markdownLogger.warning("skipping unexpected table-row child '\(unsafeNode.nodeType.rawValue)'")
            return nil
        }
        self.init(content: unsafeNode.children.compactMap { InlineNode(unsafeNode: $0, depth: 0) })
    }
}

extension InlineNode {
    fileprivate init?(unsafeNode: UnsafeNode, depth: Int) {
        if depth >= MarkdownNestingGuard.maxInlineDepth {
            let text = unsafeNode.flattenedText
            guard !text.isEmpty else { return nil }
            self = .text(text)
            return
        }
        func inlineChildren() -> [InlineNode] {
            unsafeNode.children.compactMap { InlineNode(unsafeNode: $0, depth: depth + 1) }
        }
        switch unsafeNode.nodeType {
        case .text: self = .text(unsafeNode.literal ?? "")
        case .softBreak: self = .softBreak
        case .lineBreak: self = .lineBreak
        case .code: self = .code(unsafeNode.literal ?? "")
        case .html: self = .html(unsafeNode.literal ?? "")
        case .emphasis:
            self = .emphasis(children: inlineChildren())
        case .strong:
            self = .strong(children: inlineChildren())
        case .strikethrough:
            self = .strikethrough(children: inlineChildren())
        case .link:
            self = .link(destination: unsafeNode.url ?? "", children: inlineChildren())
        case .image:
            self = .image(source: unsafeNode.url ?? "", children: inlineChildren())
        default:
            markdownLogger.warning("skipping unhandled inline node '\(unsafeNode.nodeType.rawValue)'")
            return nil
        }
    }
}

// MARK: - UnsafeNode helpers

private typealias UnsafeNode = UnsafeMutablePointer<cmark_node>

extension UnsafeNode {
    fileprivate var nodeType: NodeType {
        let typeString = String(cString: cmark_node_get_type_string(self))
        // [T-r3-markdown-hardening] A node type this build does not know (a
        // future cmark extension) is reported as `.unknown` and skipped by the
        // walkers — it used to be a fatalError.
        return NodeType(rawValue: typeString) ?? .unknown
    }

    /// Plain text of this node's whole subtree, collected with cmark's
    /// iterator (iterative — safe at any depth).
    fileprivate var flattenedText: String {
        guard let iter = cmark_iter_new(self) else { return "" }
        defer { cmark_iter_free(iter) }
        var out = ""
        var ev = cmark_iter_next(iter)
        while ev != CMARK_EVENT_DONE {
            if ev == CMARK_EVENT_ENTER, let node = cmark_iter_get_node(iter) {
                switch cmark_node_get_type(node) {
                case CMARK_NODE_TEXT, CMARK_NODE_CODE, CMARK_NODE_CODE_BLOCK, CMARK_NODE_HTML_INLINE:
                    if let lit = cmark_node_get_literal(node) { out += String(cString: lit) }
                case CMARK_NODE_SOFTBREAK, CMARK_NODE_LINEBREAK:
                    out += " "
                case CMARK_NODE_PARAGRAPH, CMARK_NODE_HEADING:
                    if !out.isEmpty, !out.hasSuffix("\n") { out += "\n" }
                default:
                    break
                }
            }
            ev = cmark_iter_next(iter)
        }
        return out.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    fileprivate var children: UnsafeNodeSequence {
        .init(cmark_node_first_child(self))
    }

    fileprivate var literal: String? {
        cmark_node_get_literal(self).map(String.init(cString:))
    }

    fileprivate var url: String? {
        cmark_node_get_url(self).map(String.init(cString:))
    }

    fileprivate var isTaskListItem: Bool {
        self.nodeType == .taskListItem
    }

    fileprivate var listType: cmark_list_type {
        cmark_node_get_list_type(self)
    }

    fileprivate var listStart: Int {
        Int(cmark_node_get_list_start(self))
    }

    fileprivate var isTaskListItemChecked: Bool {
        cmark_gfm_extensions_get_tasklist_item_checked(self)
    }

    fileprivate var isTightList: Bool {
        cmark_node_get_list_tight(self) != 0
    }

    fileprivate var fenceInfo: String? {
        cmark_node_get_fence_info(self).map(String.init(cString:))
    }

    fileprivate var headingLevel: Int {
        Int(cmark_node_get_heading_level(self))
    }

    fileprivate var tableColumns: Int {
        Int(cmark_gfm_extensions_get_table_columns(self))
    }

    fileprivate var tableAlignments: [RawTableColumnAlignment] {
        (0..<self.tableColumns).map { column in
            let ascii = cmark_gfm_extensions_get_table_alignments(self)[column]
            let scalar = UnicodeScalar(ascii)
            let character = Character(scalar)
            return .init(rawValue: character) ?? .none
        }
    }

    fileprivate static func parseMarkdown<ResultType>(
        _ markdown: String,
        body: (UnsafeNode) throws -> ResultType
    ) rethrows -> ResultType? {
        cmark_gfm_core_extensions_ensure_registered()

        // [T-strikethrough-syntax] Require a DOUBLE tilde for strikethrough.
        // cmark-gfm's strikethrough extension accepts a SINGLE `~` as a
        // delimiter by default, so prose using `~` as a range separator
        // (e.g. "msg 41797~42810", "6月14日~6月16日") was incorrectly struck
        // through. CMARK_OPT_STRIKETHROUGH_DOUBLE_TILDE makes only `~~text~~`
        // trigger strikethrough; a lone `~` stays literal — matching GFM.
        let parser = cmark_parser_new(CMARK_OPT_DEFAULT | CMARK_OPT_STRIKETHROUGH_DOUBLE_TILDE)
        defer { cmark_parser_free(parser) }

        let extensionNames: Set<String>

        if #available(iOS 16.0, macOS 13.0, tvOS 16.0, watchOS 9.0, *) {
            extensionNames = ["autolink", "strikethrough", "tagfilter", "tasklist", "table"]
        } else {
            extensionNames = ["autolink", "strikethrough", "tagfilter", "tasklist"]
        }

        for extensionName in extensionNames {
            guard let syntaxExtension = cmark_find_syntax_extension(extensionName) else {
                continue
            }
            cmark_parser_attach_syntax_extension(parser, syntaxExtension)
        }

        cmark_parser_feed(parser, markdown, markdown.utf8.count)

        guard let document = cmark_parser_finish(parser) else {
            return nil
        }

        defer { cmark_node_free(document) }
        return try body(document)
    }
}

// MARK: - NodeType enum

private enum NodeType: String {
    case document
    case blockquote = "block_quote"
    case list
    case item
    case codeBlock = "code_block"
    case htmlBlock = "html_block"
    case customBlock = "custom_block"
    case paragraph
    case heading
    case thematicBreak = "thematic_break"
    case text
    case softBreak = "softbreak"
    case lineBreak = "linebreak"
    case code
    case html = "html_inline"
    case customInline = "custom_inline"
    case emphasis = "emph"
    case strong
    case link
    case image
    case inlineAttributes = "attribute"
    case none = "NONE"
    case unknown = "<unknown>"

    // Extensions
    case strikethrough
    case table
    case tableHead = "table_header"
    case tableRow = "table_row"
    case tableCell = "table_cell"
    case taskListItem = "tasklist"
}

// MARK: - UnsafeNodeSequence

private struct UnsafeNodeSequence: Sequence {
    struct Iterator: IteratorProtocol {
        private var node: UnsafeNode?

        init(_ node: UnsafeNode?) {
            self.node = node
        }

        mutating func next() -> UnsafeNode? {
            guard let node else { return nil }
            defer { self.node = cmark_node_next(node) }
            return node
        }
    }

    private let node: UnsafeNode?

    init(_ node: UnsafeNode?) {
        self.node = node
    }

    func makeIterator() -> Iterator {
        .init(self.node)
    }
}
