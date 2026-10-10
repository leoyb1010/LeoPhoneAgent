//
//  MemoryWriteUndo.swift
//  MinisApp
//
//  [F2-memory-undo] Long-press a memory_write capsule →「撤销这条记忆」removes
//  exactly the entry that call wrote: the matching entry in the named daily
//  log (newest first, as the log is prepended), or the matching correction
//  line (newest last, as corrections are appended). Nothing else in the file
//  changes byte-for-byte.
//
//  Pure logic (no UIKit / view model) so the logic-test target compiles it.
//

import Foundation

enum MemoryWriteUndo {
    enum Target: Equatable {
        case daily(fileName: String, content: String)
        case correction(content: String)
    }

    /// Entries this long are matched by prefix too, so a write the store
    /// capped (size limits) can still be found.
    static let prefixMatchLength = 256

    /// What a finished memory_write call wrote, from its input JSON and output
    /// text. nil = not an undoable write (failed, another tool, unknown shape).
    static func target(toolName: String, inputArgs: String?, output: String) -> Target? {
        guard toolName == "memory_write",
              let data = inputArgs?.data(using: .utf8),
              let dict = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let content = dict["content"] as? String,
              !content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
        if (dict["kind"] as? String) == "correction" {
            return output.hasPrefix("Correction recorded") ? .correction(content: content) : nil
        }
        guard let fileName = savedFileName(in: output) else { return nil }
        return .daily(fileName: fileName, content: content)
    }

    /// "Memory saved to 2026-10-06.md (42 chars)" → "2026-10-06.md". Only a
    /// plain yyyy-MM-dd.md name is accepted, never a path.
    static func savedFileName(in output: String) -> String? {
        let prefix = "Memory saved to "
        guard output.hasPrefix(prefix) else { return nil }
        let rest = output.dropFirst(prefix.count)
        let name = String(rest.prefix { !$0.isWhitespace })
        let pattern = #"^\d{4}-\d{2}-\d{2}\.md$"#
        guard name.range(of: pattern, options: .regularExpression) != nil else { return nil }
        return name
    }

    private static func matches(_ stored: String, _ content: String) -> Bool {
        let stored = stored.trimmingCharacters(in: .whitespacesAndNewlines)
        let content = content.trimmingCharacters(in: .whitespacesAndNewlines)
        if stored == content { return true }
        guard stored.count >= prefixMatchLength, content.count >= prefixMatchLength else { return false }
        return content.hasPrefix(String(stored.prefix(prefixMatchLength)))
    }

    /// The daily-log text without the newest entry whose body is `content`;
    /// nil when no entry matches.
    static func removingDailyEntry(from text: String, content: String) -> String? {
        // Entry = "<!-- timestamp -->\n<body>\n\n", newest first.
        let lines = text.components(separatedBy: "\n")
        var headerIndices: [Int] = []
        for (index, line) in lines.enumerated() where isHeader(line) {
            headerIndices.append(index)
        }
        for (n, start) in headerIndices.enumerated() {
            let end = n + 1 < headerIndices.count ? headerIndices[n + 1] : lines.count
            let body = lines[(start + 1)..<end].joined(separator: "\n")
            guard matches(body, content) else { continue }
            var kept = Array(lines[..<start])
            kept.append(contentsOf: lines[end...])
            return kept.joined(separator: "\n")
        }
        return nil
    }

    private static func isHeader(_ line: String) -> Bool {
        line.hasPrefix("<!-- ") && line.hasSuffix(" -->")
    }

    /// Correction lines without the newest one recording `content`; nil when none matches.
    static func removingCorrection(from lines: [String], content: String) -> [String]? {
        let oneLine = content.trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: "\n", with: " ")
        for index in lines.indices.reversed() {
            let line = lines[index]
            guard line.hasPrefix("- ["), let close = line.range(of: "] ") else { continue }
            let text = String(line[close.upperBound...])
            if matches(text, oneLine) {
                var kept = lines
                kept.remove(at: index)
                return kept
            }
        }
        return nil
    }
}
