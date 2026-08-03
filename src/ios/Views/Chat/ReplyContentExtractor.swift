//
//  ReplyContentExtractor.swift
//  MinisApp
//
//  [T-smart-copy] Pure-string analysis of a reply's markdown for the reply
//  action bar: detect a lone code block (smart copy copies just the code),
//  enumerate code blocks for "Save as File", and convert pipe tables to CSV.
//
//  Deliberately NOT part of the renderer — the renderer's attachment caches
//  are a hang-history hot path; these run once per button tap on plain text.
//

import Foundation

enum ReplyContentExtractor {

    struct CodeBlock {
        let code: String
        let language: String?

        /// A sensible file extension for the fence language tag.
        var fileExtension: String {
            switch language?.lowercased() {
            case "swift": return "swift"
            case "python", "py": return "py"
            case "javascript", "js": return "js"
            case "typescript", "ts": return "ts"
            case "shell", "bash", "sh", "zsh": return "sh"
            case "json": return "json"
            case "yaml", "yml": return "yml"
            case "html": return "html"
            case "css": return "css"
            case "sql": return "sql"
            case "ruby", "rb": return "rb"
            case "go": return "go"
            case "rust", "rs": return "rs"
            case "c": return "c"
            case "cpp", "c++": return "cpp"
            case "java": return "java"
            case "kotlin", "kt": return "kt"
            case "xml": return "xml"
            case "markdown", "md": return "md"
            case "csv": return "csv"
            default: return "txt"
            }
        }
    }

    /// All fenced code blocks in `markdown`, in order. Tolerates ``` and ~~~
    /// fences with an optional language tag; an unterminated fence is ignored.
    static func codeBlocks(in markdown: String) -> [CodeBlock] {
        var blocks: [CodeBlock] = []
        var insideFence = false
        var fenceMarker = ""
        var language: String?
        var current: [Substring] = []
        for line in markdown.split(separator: "\n", omittingEmptySubsequences: false) {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if !insideFence {
                if trimmed.hasPrefix("```") || trimmed.hasPrefix("~~~") {
                    insideFence = true
                    fenceMarker = String(trimmed.prefix(3))
                    let tag = trimmed.dropFirst(3).trimmingCharacters(in: .whitespaces)
                    language = tag.isEmpty ? nil : String(tag.prefix(while: { !$0.isWhitespace }))
                    current = []
                }
            } else if trimmed == fenceMarker || trimmed.hasPrefix(fenceMarker + " ") {
                insideFence = false
                let code = current.joined(separator: "\n")
                if !code.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    blocks.append(CodeBlock(code: code, language: language))
                }
            } else {
                current.append(line)
            }
        }
        return blocks
    }

    /// When the ENTIRE reply (ignoring surrounding whitespace) is one fenced
    /// code block, return it — the smart-copy payload is then just the code.
    static func loneCodeBlock(in markdown: String) -> CodeBlock? {
        let trimmed = markdown.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.hasPrefix("```") || trimmed.hasPrefix("~~~") else { return nil }
        let marker = String(trimmed.prefix(3))
        guard trimmed.hasSuffix(marker) else { return nil }
        let blocks = codeBlocks(in: trimmed)
        // Exactly one fence and nothing outside it (prefix+suffix check above
        // plus a single parsed block is sufficient for LLM-shaped output).
        return blocks.count == 1 ? blocks[0] : nil
    }

    /// Every markdown pipe table converted to RFC-4180-ish CSV (quotes doubled,
    /// fields with commas/quotes/newlines wrapped). Separator rows dropped.
    static func tablesAsCSV(in markdown: String) -> [String] {
        var tables: [String] = []
        var currentRows: [[String]] = []

        func flush() {
            // A real table needs a header + at least one data row.
            if currentRows.count >= 2 {
                let csv = currentRows.map { row in
                    row.map { field -> String in
                        if field.contains(",") || field.contains("\"") || field.contains("\n") {
                            return "\"" + field.replacingOccurrences(of: "\"", with: "\"\"") + "\""
                        }
                        return field
                    }.joined(separator: ",")
                }.joined(separator: "\n")
                tables.append(csv)
            }
            currentRows = []
        }

        for line in markdown.split(separator: "\n", omittingEmptySubsequences: false) {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            guard trimmed.hasPrefix("|"), trimmed.hasSuffix("|"), trimmed.count > 2 else {
                flush()
                continue
            }
            // Separator row (|---|:--:|) — structural, not data.
            let inner = trimmed.dropFirst().dropLast()
            let isSeparator = inner.allSatisfy { "-:| ".contains($0) }
            if isSeparator { continue }
            let cells = inner
                .split(separator: "|", omittingEmptySubsequences: false)
                .map { cell in
                    cell.trimmingCharacters(in: .whitespaces)
                        // Unescape the markdown table pipe escape.
                        .replacingOccurrences(of: "\\|", with: "|")
                }
            currentRows.append(cells)
        }
        flush()
        return tables
    }
}
