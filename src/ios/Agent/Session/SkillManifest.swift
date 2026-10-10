//
//  SkillManifest.swift
//  MinisApp
//
//  [B18] Pure SKILL.md rules shared by SkillStore and MinisTests: frontmatter
//  parsing, the id policy, the head-only read used at load time, and the
//  per-skill entry of the system-prompt fragment. Skill files come from the
//  web, archives, other devices and the agent's own shell, so everything that
//  reaches the prompt is bounded, single-line and escaped here.
//

import Foundation

enum SkillManifest {
    static let defaultName = "Untitled Skill"
    /// Only this much of a SKILL.md is read to list a skill (frontmatter +
    /// preview); the full file is read on demand.
    static let headBytes = 64 * 1024
    static let maxPromptNameLength = 80
    static let maxPromptDescriptionLength = 200
    static let maxIdLength = 128
    static let maxBodyPreviewLength = 2_000

    struct Parsed {
        var name: String = SkillManifest.defaultName
        var description: String = ""
        var version: String = "1.0.0"
        var body: String = ""
        /// The file opens a `---` frontmatter block that never closes. Import
        /// refuses such a file instead of filing it as "Untitled Skill".
        var frontmatterUnterminated = false
    }

    // MARK: - Id policy

    /// A skill id is a directory name under /var/minis/skills and appears in
    /// the system prompt: one path component of letters, digits, `-`, `_`, `.`
    /// (no leading dot), at most `maxIdLength` characters.
    static func isValidId(_ id: String) -> Bool {
        guard !id.isEmpty, id.count <= maxIdLength, !id.hasPrefix(".") else { return false }
        let extra = CharacterSet(charactersIn: "-_.")
        return id.unicodeScalars.allSatisfy { CharacterSet.alphanumerics.contains($0) || extra.contains($0) }
    }

    // MARK: - Prompt entry

    /// One line, control characters and newlines folded to spaces, capped.
    static func singleLine(_ text: String, limit: Int) -> String {
        var out = ""
        var lastWasSpace = false
        for scalar in text.unicodeScalars {
            let isSpace = CharacterSet.whitespacesAndNewlines.contains(scalar)
                || CharacterSet.controlCharacters.contains(scalar)
            if isSpace {
                if !lastWasSpace, !out.isEmpty { out.unicodeScalars.append(" ") }
                lastWasSpace = true
            } else {
                out.unicodeScalars.append(scalar)
                lastWasSpace = false
            }
        }
        out = out.trimmingCharacters(in: .whitespaces)
        guard out.count > limit else { return out }
        return String(out.prefix(limit)) + "…"
    }

    static func xmlEscaped(_ text: String) -> String {
        text.replacingOccurrences(of: "&", with: "&amp;")
            .replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;")
            .replacingOccurrences(of: "\"", with: "&quot;")
    }

    /// The `<skill>` element for one skill, or nil when its id is not a safe
    /// path component (such a skill is left out of the prompt entirely).
    static func promptEntry(id: String, name: String, description: String) -> String? {
        guard isValidId(id) else { return nil }
        let shownName = xmlEscaped(singleLine(name, limit: maxPromptNameLength))
        let shownDesc = xmlEscaped(singleLine(description, limit: maxPromptDescriptionLength))
        return "  <skill>\n"
            + "    <name>\(shownName)</name>\n"
            + "    <description>\(shownDesc)</description>\n"
            + "    <path>/var/minis/skills/\(xmlEscaped(id))/SKILL.md</path>\n"
            + "  </skill>\n"
    }

    // MARK: - Reading

    /// The first `maxBytes` of a file as UTF-8 text (a multi-byte character
    /// cut at the boundary is dropped). nil when the file can't be opened.
    static func readHead(of url: URL, maxBytes: Int = headBytes) -> String? {
        guard let handle = try? FileHandle(forReadingFrom: url) else { return nil }
        defer { try? handle.close() }
        let data: Data
        do { data = try handle.read(upToCount: maxBytes) ?? Data() } catch { return nil }
        if data.isEmpty { return "" }
        // Back off at most three trailing bytes to a whole UTF-8 sequence.
        for drop in 0...min(3, data.count - 1) {
            if let text = String(data: data.dropLast(drop), encoding: .utf8) { return text }
        }
        return String(decoding: data, as: UTF8.self)
    }

    static func bodyPreview(_ body: String) -> String {
        body.count > maxBodyPreviewLength ? String(body.prefix(maxBodyPreviewLength)) : body
    }

    // MARK: - Parsing

    static func parse(_ content: String) -> Parsed {
        var result = Parsed()
        let trimmed = content.trimmingCharacters(in: .whitespacesAndNewlines)

        let lines = content.components(separatedBy: "\n")
        let hasOpeningFence = trimmed.hasPrefix("---")

        // Locate the closing `---` fence. When the file starts with `---` we
        // skip the opening line; otherwise we accept a "headless" frontmatter
        // (a leading run of `key: value` lines followed by a `---` separator)
        // so files generated by tools that omit the opening fence still parse
        // — observed in the wild on user-imported SKILL.md files where the
        // opening `---` was stripped during copy/paste, leaving the entire
        // frontmatter to fall through into `body` and the skill to land as
        // "Untitled Skill" with the raw YAML rendered as the description.
        var frontmatterEnd: Int?
        let scanStart = hasOpeningFence ? 1 : 0
        if scanStart < lines.count {
            for i in scanStart..<lines.count {
                if lines[i].trimmingCharacters(in: .whitespaces) == "---" {
                    frontmatterEnd = i
                    break
                }
            }
        }

        guard let endIdx = frontmatterEnd else {
            result.body = content
            result.frontmatterUnterminated = hasOpeningFence
            return result
        }

        // For the headless variant, only treat the leading block as
        // frontmatter when it actually looks like one — every non-blank line
        // before the fence must start with `key:`, AND at least one of those
        // keys must be a recognized frontmatter field (name / description /
        // version). The recognized-key gate keeps a regular markdown file
        // that just happens to open with a `Author: foo\n\n---` style intro
        // from being silently swallowed as frontmatter.
        if !hasOpeningFence {
            var sawRecognizedKey = false
            let looksLikeFrontmatter = (scanStart..<endIdx).allSatisfy { idx in
                let line = lines[idx]
                let stripped = line.trimmingCharacters(in: .whitespaces)
                if stripped.isEmpty { return true }
                if line.first?.isWhitespace == true { return true } // continuation of a previous block scalar
                guard let colon = line.firstIndex(of: ":") else { return false }
                let key = line[line.startIndex..<colon].trimmingCharacters(in: .whitespaces)
                guard !key.isEmpty,
                      key.allSatisfy({ $0.isLetter || $0.isNumber || $0 == "_" || $0 == "-" }) else {
                    return false
                }
                let lowered = key.lowercased()
                if lowered == "name" || lowered == "description" || lowered == "version" {
                    sawRecognizedKey = true
                }
                return true
            }
            guard looksLikeFrontmatter, sawRecognizedKey else {
                result.body = content
                return result
            }
        }

        var i = scanStart
        while i < endIdx {
            let line = lines[i]
            guard let colonIdx = line.firstIndex(of: ":") else { i += 1; continue }
            let key = line[line.startIndex..<colonIdx].trimmingCharacters(in: .whitespaces).lowercased()
            let value = line[line.index(after: colonIdx)...].trimmingCharacters(in: .whitespaces)

            // Handle YAML block scalars. Indicator is a leading `|` or `>`,
            // optionally followed by a chomping suffix (`-` strip, `+` keep)
            // and/or a 1-9 indentation digit, e.g. `|`, `|-`, `>-`, `>2`,
            // `|+`, `>-2`. All of these were previously falling through as
            // literal values, surfacing tokens like ">-" in skill picker
            // descriptions when authors wrote `description: >-`.
            let resolvedValue: String
            let isBlockScalar: Bool = {
                guard let first = value.first, first == "|" || first == ">" else { return false }
                let rest = value.dropFirst()
                // Each remaining char must be a chomping indicator or digit.
                return rest.allSatisfy { $0 == "-" || $0 == "+" || $0.isNumber }
            }()
            if isBlockScalar, i + 1 < endIdx {
                let fold = (value.first == ">")
                var blockLines: [String] = []
                var j = i + 1
                while j < endIdx {
                    let next = lines[j]
                    // Block continues while line is indented (starts with whitespace) or is empty
                    if next.isEmpty || next.first?.isWhitespace == true {
                        blockLines.append(next.trimmingCharacters(in: .whitespaces))
                    } else {
                        break
                    }
                    j += 1
                }
                if fold {
                    // > folds newlines into spaces
                    resolvedValue = blockLines.joined(separator: " ").trimmingCharacters(in: .whitespaces)
                } else {
                    // | preserves newlines
                    resolvedValue = blockLines.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
                }
                i = j
            } else {
                resolvedValue = String(value)
                i += 1
            }

            switch key {
            case "name": result.name = resolvedValue
            case "description": result.description = resolvedValue
            case "version": result.version = resolvedValue
            default: break
            }
        }

        let bodyLines = Array(lines[(endIdx + 1)...])
        result.body = bodyLines.joined(separator: "\n").trimmingCharacters(in: .newlines)

        return result
    }
}
