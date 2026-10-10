import Foundation

/// Same pagination contract as Android `FileReadPaging` / Harmony `fileReadPage`.
/// Length is UTF-16 so `next_offset` stays aligned across the three runtimes.
enum FileReadPaging {
    static let hardCap = 80_000

    struct Page {
        let showStart: Int
        let showEnd: Int
        let totalLines: Int
        let content: String
        let truncated: Bool
        let nextOffset: Int?
    }

    static func intValue(_ dict: [String: Any], _ key: String) -> Int? {
        ToolArgNumbers.clampedInt(dict[key], to: Int.min...Int.max)
    }

    static func page(
        allLines: [String],
        offset: Int,
        requestedLines: Int?,
        maxLength: Int,
        direction: String
    ) -> Page {
        let total = allLines.count
        let cap = max(1, min(maxLength, hardCap))
        if total == 0 {
            return Page(showStart: 1, showEnd: 0, totalLines: 0, content: "", truncated: false, nextOffset: nil)
        }
        let isTail = direction.lowercased() == "tail"
        let selected: [String]
        let showStart: Int
        // [T-r3-tool-arg-clamp] Clamp before subtracting/adding: `total - Int.min`
        // and `start + Int.max` both overflow and trap.
        if isTail {
            let count = min(max(requestedLines ?? total, 0), total)
            let start = total - count
            selected = Array(allLines[start..<total])
            showStart = start + 1
        } else {
            let safeOffset = max(offset, 1)
            let start = min(safeOffset - 1, total)
            let end: Int
            if let requestedLines {
                end = start + min(max(requestedLines, 0), total - start)
            } else {
                end = total
            }
            selected = Array(allLines[start..<end])
            showStart = selected.isEmpty ? safeOffset : start + 1
        }
        return clip(selected, showStart: showStart, total: total, cap: cap, isTail: isTail)
    }

    private static func clip(
        _ selected: [String],
        showStart: Int,
        total: Int,
        cap: Int,
        isTail: Bool
    ) -> Page {
        if selected.isEmpty {
            return Page(showStart: showStart, showEnd: showStart - 1, totalLines: total, content: "", truncated: false, nextOffset: nil)
        }
        let joined = selected.joined(separator: "\n")
        let joinedLen = (joined as NSString).length
        if joinedLen <= cap {
            let showEnd = showStart + selected.count - 1
            let next = (!isTail && showEnd < total) ? showEnd + 1 : nil
            return Page(showStart: showStart, showEnd: showEnd, totalLines: total, content: joined, truncated: false, nextOffset: next)
        }
        var used = 0
        var complete = 0
        for line in selected {
            let extra = complete == 0 ? 0 : 1
            let lineLen = (line as NSString).length
            if used + extra + lineLen > cap { break }
            used += extra + lineLen
            complete += 1
        }
        if complete == 0 {
            let showEnd = showStart
            let next = isTail ? nil : showStart + 1
            let clipped = (selected[0] as NSString).substring(to: min(cap, (selected[0] as NSString).length))
            return Page(showStart: showStart, showEnd: showEnd, totalLines: total, content: clipped, truncated: true, nextOffset: next)
        }
        let showEnd = showStart + complete - 1
        let content = selected[0..<complete].joined(separator: "\n")
        let next = (!isTail && showEnd < total) ? showEnd + 1 : nil
        return Page(showStart: showStart, showEnd: showEnd, totalLines: total, content: content, truncated: true, nextOffset: next)
    }

    static func formatOutput(path: String, size: Int, page: Page) -> String {
        let range: String
        if page.totalLines == 0 || page.showEnd < page.showStart {
            range = "showing 0-0 of 0"
        } else {
            range = "showing \(page.showStart)-\(page.showEnd) of \(page.totalLines)"
        }
        let trunc = page.truncated ? " (truncated at \(hardCap) chars or requested max_length)" : ""
        let header = "[\(path) | \(size) bytes | \(page.totalLines) lines | \(range)\(trunc)]"
        let next = page.nextOffset.map { "\nnext_offset: \($0)" } ?? ""
        return "\(header)\n\(page.content)\(next)"
    }
}
