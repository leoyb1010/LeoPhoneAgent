import Foundation

// [T-r3-markdown-hardening] Linear-time guards that run before cmark and the
// renderers see model text. Each one bounds something that used to be
// unbounded: blockquote depth (stack overflow), combining-mark runs and bidi
// overrides (layout blow-ups / spoofing), fence tracking (list normalisation
// drifting out of sync), backtick-run matching (O(k²)) and LaTeX nesting
// (SwiftMath recursion).

// MARK: - Nesting

enum MarkdownNestingGuard {
    /// Deepest blockquote nesting handed to cmark. Deeper `>` markers are
    /// escaped so they render as literal text.
    static let maxBlockquoteDepth = 8
    /// Deepest container (quote / list / item) the Swift block walker descends.
    static let maxBlockDepth = 32
    /// Deepest inline container (emphasis / strong / link …) the walker descends.
    static let maxInlineDepth = 32

    /// Escape every blockquote marker past `maxDepth` on each line. Fenced code
    /// is left alone. Lines without deep nesting are returned byte-identical.
    static func collapseDeepBlockquotes(_ markdown: String, maxDepth: Int = maxBlockquoteDepth) -> String {
        // Fast path: deep nesting needs at least maxDepth+1 `>` characters.
        var gtCount = 0
        for b in markdown.utf8 where b == UInt8(ascii: ">") {
            gtCount += 1
            if gtCount > maxDepth { break }
        }
        guard gtCount > maxDepth else { return markdown }

        var fence = MarkdownFenceTracker()
        var out: [String] = []
        var changed = false
        let lines = markdown.split(separator: "\n", omittingEmptySubsequences: false)
        out.reserveCapacity(lines.count)
        for line in lines {
            if !fence.consume(line), let fixed = escapeMarkers(in: line, beyond: maxDepth) {
                out.append(fixed)
                changed = true
            } else {
                out.append(String(line))
            }
        }
        return changed ? out.joined(separator: "\n") : markdown
    }

    /// The line with the (maxDepth+1)-th blockquote marker escaped, or nil
    /// when the line nests no deeper than `maxDepth`.
    private static func escapeMarkers(in line: Substring, beyond maxDepth: Int) -> String? {
        var depth = 0
        var idx = line.startIndex
        // Up to 3 leading spaces before the first marker.
        var spaces = 0
        while idx < line.endIndex, line[idx] == " ", spaces < 3 { idx = line.index(after: idx); spaces += 1 }
        while idx < line.endIndex, line[idx] == ">" {
            depth += 1
            if depth > maxDepth {
                var s = String(line[..<idx])
                s += "\\"
                s += line[idx...]
                return s
            }
            idx = line.index(after: idx)
            // Optional single space / tab after each marker, then further
            // indentation is allowed before the next marker.
            while idx < line.endIndex, line[idx] == " " || line[idx] == "\t" { idx = line.index(after: idx) }
        }
        return nil
    }
}

// MARK: - Fences

/// CommonMark fence tracking shared by every line-based pre-pass. An opener is
/// (indentation, then) ≥3 backticks or ≥3 tildes (a backtick fence's
/// info string may not contain a backtick); it is closed only by a line of the
/// SAME character, at least as long, followed by nothing but whitespace. The
/// old trackers toggled on any ``` prefix and so lost sync on ```` fences that
/// contain ``` lines, or on ~~~ fences.
struct MarkdownFenceTracker {
    private(set) var isOpen = false
    private var fenceChar: Character = "`"
    private var fenceLength = 0

    /// Feed one line. Returns true when the line belongs to a fenced block
    /// (its opener, body or closer) and must be passed through untouched.
    mutating func consume<S: StringProtocol>(_ line: S) -> Bool {
        // Any leading indentation is accepted (fences nested in list items are
        // indented by the item's content offset; the previous trackers trimmed
        // all leading whitespace too).
        var idx = line.startIndex
        while idx < line.endIndex, line[idx] == " " || line[idx] == "\t" { idx = line.index(after: idx) }
        var runLength = 0
        var runChar: Character?
        if idx < line.endIndex, line[idx] == "`" || line[idx] == "~" {
            runChar = line[idx]
            while idx < line.endIndex, line[idx] == runChar! { idx = line.index(after: idx); runLength += 1 }
        }
        if isOpen {
            if let runChar, runChar == fenceChar, runLength >= fenceLength,
               line[idx...].allSatisfy({ $0 == " " || $0 == "\t" }) {
                isOpen = false
            }
            return true
        }
        guard let runChar, runLength >= 3 else { return false }
        if runChar == "`", line[idx...].contains("`") { return false } // inline code, not a fence
        isOpen = true
        fenceChar = runChar
        fenceLength = runLength
        return true
    }
}

// MARK: - Backtick runs

/// Index of backtick runs in one line/paragraph, so "find the closing run of
/// the same length after position p" is a binary search instead of a rescan
/// (the rescans made a line of many unmatched runs O(k²)–O(k³)).
struct BacktickRunIndex {
    /// run length → sorted start positions
    private var startsByLength: [Int: [Int]] = [:]

    init(_ chars: [Character]) {
        var i = 0
        let n = chars.count
        while i < n {
            if chars[i] == "`" {
                var j = i
                while j < n, chars[j] == "`" { j += 1 }
                startsByLength[j - i, default: []].append(i)
                i = j
            } else {
                i += 1
            }
        }
    }

    /// Start of the first run of exactly `length` backticks starting at or after `position`.
    func closingRunStart(length: Int, after position: Int) -> Int? {
        guard let starts = startsByLength[length] else { return nil }
        var lo = 0, hi = starts.count
        while lo < hi {
            let mid = (lo + hi) / 2
            if starts[mid] < position { lo = mid + 1 } else { hi = mid }
        }
        return lo < starts.count ? starts[lo] : nil
    }
}

// MARK: - Text sanitising

enum MarkdownTextSanitizer {
    /// Combining marks kept per base character (Vietnamese, Thai, Devanagari
    /// and emoji sequences stay far below this).
    static let maxCombiningMarksPerBase = 8

    /// Remove bidi override/isolate controls (U+202A–202E, U+2066–2069) and
    /// cap runs of combining marks. Returns the input unchanged (no copy) when
    /// there is nothing to remove.
    static func sanitize(_ text: String) -> String {
        guard needsSanitizing(text) else { return text }
        var out = String.UnicodeScalarView()
        var marksInRun = 0
        for scalar in text.unicodeScalars {
            if isBidiControl(scalar) { continue }
            if isCombiningMark(scalar) {
                marksInRun += 1
                if marksInRun > maxCombiningMarksPerBase { continue }
            } else {
                marksInRun = 0
            }
            out.append(scalar)
        }
        return String(out)
    }

    static func needsSanitizing(_ text: String) -> Bool {
        // Every scalar we act on is ≥ U+0300 (2+ UTF-8 bytes): pure ASCII is clean.
        guard text.utf8.contains(where: { $0 >= 0xC0 }) else { return false }
        var marksInRun = 0
        for scalar in text.unicodeScalars {
            if isBidiControl(scalar) { return true }
            if isCombiningMark(scalar) {
                marksInRun += 1
                if marksInRun > maxCombiningMarksPerBase { return true }
            } else {
                marksInRun = 0
            }
        }
        return false
    }

    @inline(__always)
    static func isBidiControl(_ s: Unicode.Scalar) -> Bool {
        (0x202A...0x202E).contains(s.value) || (0x2066...0x2069).contains(s.value)
    }

    @inline(__always)
    static func isCombiningMark(_ s: Unicode.Scalar) -> Bool {
        guard s.value >= 0x0300 else { return false }
        switch s.properties.generalCategory {
        case .nonspacingMark, .enclosingMark, .spacingMark: return true
        default: return false
        }
    }
}

// MARK: - Math

enum MathLatexGuard {
    /// LaTeX longer than this (UTF-8 bytes) is not handed to SwiftMath.
    static let maxNativeBytes = 4 * 1024
    /// Brace / \left / \frac nesting deeper than this is not handed to SwiftMath
    /// (its parser recurses once per level on the main thread).
    static let maxNativeNesting = 64
    /// The text fallback shows at most this many characters.
    static let maxFallbackCharacters = 4 * 1024

    /// True when the native (recursive) renderer may be used for `latex`.
    static func allowsNativeRender(_ latex: String) -> Bool {
        if latex.utf8.count > maxNativeBytes { return false }
        return nestingDepth(latex) <= maxNativeNesting
    }

    /// Maximum `{`/`\left` nesting depth in one linear pass (escaped braces ignored).
    static func nestingDepth(_ latex: String) -> Int {
        var depth = 0, maxDepth = 0
        var prevBackslash = false
        let bytes = Array(latex.utf8)
        var i = 0
        while i < bytes.count {
            let b = bytes[i]
            if prevBackslash {
                prevBackslash = false
                if b == UInt8(ascii: "l"), matches(bytes, at: i, "left") { depth += 1; maxDepth = max(maxDepth, depth); i += 4; continue }
                if b == UInt8(ascii: "r"), matches(bytes, at: i, "right") { depth = max(0, depth - 1); i += 5; continue }
                i += 1
                continue
            }
            switch b {
            case UInt8(ascii: "\\"): prevBackslash = true
            case UInt8(ascii: "{"): depth += 1; maxDepth = max(maxDepth, depth)
            case UInt8(ascii: "}"): depth = max(0, depth - 1)
            default: break
            }
            i += 1
        }
        return maxDepth
    }

    private static func matches(_ bytes: [UInt8], at i: Int, _ word: String) -> Bool {
        let w = Array(word.utf8)
        guard i + w.count <= bytes.count else { return false }
        for k in 0..<w.count where bytes[i + k] != w[k] { return false }
        return true
    }

    /// Text for the fallback renderer: capped so a 1 MB formula cannot become
    /// a 1 MB attributed string.
    static func fallbackSource(_ latex: String) -> String {
        guard latex.count > maxFallbackCharacters else { return latex }
        return String(latex.prefix(maxFallbackCharacters)) + " …"
    }
}

// MARK: - Size

/// [B21 parsing side] Only the first `maxParsedCharacters` of a message go
/// through the markdown pre-passes and cmark; the rest is handed over as one
/// plain code block. A 1 MB line without spaces used to be copied into a
/// `[Character]` on every streaming flush and parsed whole.
enum MarkdownSizeGuard {
    static let maxParsedCharacters = 200_000
    /// A cut moves back to the previous newline when one is this close.
    static let newlineSearchWindow = 20_000

    static func split(_ markdown: String, limit: Int = maxParsedCharacters) -> (head: String, tail: String?) {
        // Characters ≤ UTF-8 bytes, so a short byte count needs no walk.
        guard markdown.utf8.count > limit,
              let cut = markdown.index(markdown.startIndex, offsetBy: limit, limitedBy: markdown.endIndex),
              cut < markdown.endIndex else { return (markdown, nil) }
        var splitAt = cut
        let windowStart = markdown.index(cut, offsetBy: -min(newlineSearchWindow, limit), limitedBy: markdown.startIndex)
            ?? markdown.startIndex
        if let nl = markdown[windowStart..<cut].lastIndex(of: "\n") {
            splitAt = markdown.index(after: nl)
        }
        return (String(markdown[..<splitAt]), String(markdown[splitAt...]))
    }
}
