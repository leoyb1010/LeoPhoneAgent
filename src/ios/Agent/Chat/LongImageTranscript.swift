//
//  LongImageTranscript.swift
//  MinisApp
//
//  [F2-long-image] What goes into「分享为长图」and how it is cut into images.
//  Only what the user saw as conversation: user text and assistant text.
//  Never thinking, tool calls/outputs, file paths, attachment contents or
//  internal tags the model sees but the bubble hides. Pure logic so the
//  logic-test target compiles it.
//

import CoreGraphics
import Foundation

enum LongImageTranscript {
    enum Role: Equatable { case user, assistant }

    /// One message as the app hands it over (already reduced to plain fields).
    struct Source: Equatable {
        var role: Role
        var text: String
        var attachmentCount: Int = 0
        var error: String? = nil
    }

    /// One bubble in the image.
    struct Item: Equatable {
        var role: Role
        var text: String
        var attachmentCount: Int
        var isError: Bool
    }

    /// Per-bubble text cap: a single 100 KB reply must not become a 60 000 pt image.
    static let itemTextLimit = 4_000
    /// Logical page width (points) and the tallest image we emit (points).
    static let pageWidth: CGFloat = 390
    static let maxPageHeight: CGFloat = 4_000
    /// More than this many images is not a "long image" any more.
    static let maxPages = 20

    private static let hiddenBlockRegex = try? NSRegularExpression(
        pattern: "<(system-reminder|treasury_context|agent_callback|context_snapshot|memory_context)\\b[^>]*>[\\s\\S]*?</\\1>",
        options: [.caseInsensitive])
    /// An opening internal tag that never closes hides everything after it.
    private static let unclosedRegex = try? NSRegularExpression(
        pattern: "<(system-reminder|treasury_context|agent_callback)\\b[^>]*>[\\s\\S]*$",
        options: [.caseInsensitive])

    /// Strips internal tags and collapses the blank lines they leave.
    static func clean(_ text: String) -> String {
        var out = text
        for regex in [hiddenBlockRegex, unclosedRegex].compactMap({ $0 }) {
            let range = NSRange(out.startIndex..<out.endIndex, in: out)
            out = regex.stringByReplacingMatches(in: out, range: range, withTemplate: "")
        }
        while out.contains("\n\n\n") { out = out.replacingOccurrences(of: "\n\n\n", with: "\n\n") }
        return out.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    static func items(from sources: [Source]) -> [Item] {
        sources.compactMap { source in
            var text = clean(source.text)
            if text.count > itemTextLimit {
                text = String(text.prefix(itemTextLimit)) + "\n…" + String(localized: "(已截断)")
            }
            let error = source.error.map(clean).flatMap { $0.isEmpty ? nil : $0 }
            if source.role == .assistant, text.isEmpty, let error {
                return Item(role: .assistant, text: String(error.prefix(300)), attachmentCount: 0, isError: true)
            }
            guard !text.isEmpty || source.attachmentCount > 0 else { return nil }
            return Item(role: source.role, text: text, attachmentCount: source.attachmentCount, isError: false)
        }
    }

    /// Turns: each user item starts one; leading assistant items form turn 0.
    static func turnStarts(_ items: [Item]) -> [Int] {
        var starts: [Int] = []
        for (index, item) in items.enumerated() where item.role == .user || index == 0 {
            if starts.last != index { starts.append(index) }
        }
        return starts
    }

    /// Items of turns `from...to` (indices into `turnStarts`).
    static func items(_ items: [Item], turns from: Int, through to: Int) -> [Item] {
        let starts = turnStarts(items)
        guard !starts.isEmpty else { return [] }
        let lo = max(0, min(from, to, starts.count - 1))
        let hi = min(starts.count - 1, max(from, to))
        let begin = starts[lo]
        let end = hi + 1 < starts.count ? starts[hi + 1] : items.count
        return Array(items[begin..<end])
    }

    // MARK: Pagination

    /// A vertical strip of one rendered item placed on a page.
    struct Slice: Equatable {
        var index: Int
        var y: CGFloat
        var height: CGFloat
    }

    /// Greedy pages no taller than `maxHeight`. An item taller than a page is
    /// cut into page-height strips; nothing is dropped, nothing overlaps.
    static func paginate(heights: [CGFloat], maxHeight: CGFloat = maxPageHeight) -> [[Slice]] {
        guard maxHeight > 0 else { return [] }
        var pages: [[Slice]] = []
        var current: [Slice] = []
        var used: CGFloat = 0
        for (index, rawHeight) in heights.enumerated() {
            let height = rawHeight.isFinite ? max(0, rawHeight.rounded(.up)) : 0
            guard height > 0 else { continue }
            if height <= maxHeight {
                if used + height > maxHeight, !current.isEmpty {
                    pages.append(current); current = []; used = 0
                }
                current.append(Slice(index: index, y: 0, height: height))
                used += height
                continue
            }
            if !current.isEmpty { pages.append(current); current = []; used = 0 }
            var y: CGFloat = 0
            while y < height {
                let strip = min(maxHeight, height - y)
                if strip == maxHeight {
                    pages.append([Slice(index: index, y: y, height: strip)])
                } else {
                    current = [Slice(index: index, y: y, height: strip)]
                    used = strip
                }
                y += strip
            }
        }
        if !current.isEmpty { pages.append(current) }
        return pages
    }
}
