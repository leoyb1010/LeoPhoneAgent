//
//  MarkdownStreamPresentation.swift
//
//  [output-render] Pure presentation decisions for chat Markdown, kept out of the 8K-line
//  renderer so the logic-test target can pin them: list marker glyphs and the marker column,
//  the code-block language label, and the pacing of the streaming word reveal.
//  No UIKit text layout here — only numbers and strings.
//

import CoreGraphics
import Foundation

enum MarkdownListMarkers {
    /// Bullet glyph per nesting depth: filled dot, ring, small square. Plain characters, never
    /// attachments (a list of image attachments is O(glyphs × runs) in TextKit 1 and has hung
    /// the main thread before — see the HangFix note in the renderer).
    static func bullet(depth: Int) -> String {
        switch depth {
        case 0: return "\u{2022}"   // •
        case 1: return "\u{25E6}"   // ◦
        // ▪ with VS15: U+25AA has an emoji presentation, and without the text selector it drew
        // as a large black Apple Color Emoji square that ignored the marker color.
        default: return "\u{25AA}\u{FE0E}"
        }
    }

    /// `1.` … `n.` — the label written before an ordered item.
    static func ordinal(_ n: Int) -> String { "\(n)." }

    /// The widest ordinal a list will show (its last number; numbers only grow).
    static func widestOrdinal(start: Int, count: Int) -> String {
        ordinal(start + max(count, 1) - 1)
    }

    /// Width from the item's start to where its text begins. Markers sit at the start and a tab
    /// carries the first line's text to this column; wrapped lines hang at the same column, so a
    /// `10.` item and a `9.` item start their text at the same x and wrap under it.
    static func markerColumn(widestMarkerWidth: CGFloat, minimum: CGFloat, gap: CGFloat) -> CGFloat {
        max(minimum, ceil(widestMarkerWidth) + gap)
    }

    /// Check box for a task item: ☑ / □. Both come from the system face at the same box size;
    /// the usual ☐ (U+2610) falls back to Apple Symbols and draws a visibly smaller box than ☑.
    static func taskBox(completed: Bool) -> String { completed ? "\u{2611}" : "\u{25A1}" }
}

enum MarkdownCodeLabel {
    /// Language label for a fenced block: the info string's first word, lowercased, at most
    /// 24 characters; `text` when the fence has none.
    static func language(fenceInfo: String?) -> String {
        let first = fenceInfo?
            .split(whereSeparator: { $0 == " " || $0 == "\t" || $0 == "{" })
            .first
            .map(String.init) ?? ""
        let cleaned = first.trimmingCharacters(in: CharacterSet(charactersIn: "`~"))
        return cleaned.isEmpty ? "text" : String(cleaned.lowercased().prefix(24))
    }
}

/// Paces the streaming word fade so a flushed batch reveals over roughly the time until the next
/// flush arrives, instead of popping in all at once and then sitting still.
///
/// Flushes come every 200–500 ms (the SSE throttle). Revealing each batch inside a fixed 0.1 s
/// window made the text arrive in visible sentence-sized jumps. Here the window follows the
/// observed gap between batches (85 % of it, clamped), and each batch starts no earlier than the
/// previous batch's last word, so words always appear in reading order. The start is never
/// pushed more than `maxLag` past "now", so a burst cannot build a growing backlog.
struct StreamRevealPacer {
    static let minWindow: Double = 0.10
    static let maxWindow: Double = 0.42
    static let maxLag: Double = 0.20
    /// A gap this long means a new burst (first tokens, or after a tool call): use the short window.
    static let idleGap: Double = 1.0

    private(set) var lastBatchAt: Double?
    private(set) var lastUnitStart: Double = -.infinity

    struct Plan: Equatable {
        let base: Double
        let step: Double
    }

    mutating func plan(unitCount: Int, now: Double) -> Plan {
        guard unitCount > 0 else { return Plan(base: now, step: 0) }
        let window: Double
        if let last = lastBatchAt, now - last < Self.idleGap {
            window = min(Self.maxWindow, max(Self.minWindow, (now - last) * 0.85))
        } else {
            window = Self.minWindow
        }
        let step = window / Double(unitCount)
        let earliest = max(now, lastUnitStart + step)
        let base = min(earliest, now + Self.maxLag)
        lastBatchAt = now
        lastUnitStart = base + step * Double(unitCount - 1)
        return Plan(base: base, step: step)
    }

    mutating func reset() {
        lastBatchAt = nil
        lastUnitStart = -.infinity
    }
}
