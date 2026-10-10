import Foundation

/// One rule set for every way a session title is written: user rename, peer
/// sync, and model-generated titles (cloud or on-device). A title is a single
/// line; anything a model or a peer sends is collapsed and bounded before it
/// reaches SQLite, the list, Spotlight or the Live Activity.
enum SessionTitleSanitizer {
    /// Hard cap for any stored title (user-typed or synced).
    static let maxStoredLength = 256
    /// Generated titles are short labels.
    static let maxGeneratedLength = 60

    /// Categories the title model may assign; anything else is dropped.
    static let categories: Set<String> = [
        "code", "writing", "research", "analysis", "creative", "chat", "math", "translation",
        "health", "finance", "travel", "education", "design", "productivity", "support", "other",
    ]

    /// Single line, no control characters, at most `maxStoredLength` characters.
    static func stored(_ raw: String) -> String {
        truncate(singleLine(raw), to: maxStoredLength)
    }

    /// A model's title: markdown/quote noise removed, first meaningful line
    /// only, at most `maxGeneratedLength` characters. nil when nothing is left.
    static func generated(_ raw: String) -> String? {
        // Bound the work on pathological output before any scanning.
        let bounded = String(raw.prefix(4096))
        let firstLine = bounded
            .components(separatedBy: .newlines)
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .first { line in !line.isEmpty && !line.hasPrefix("```") } ?? ""
        var t = singleLine(firstLine)
        // Leading heading / list / quote markers.
        while let first = t.first, "#>*-•".contains(first) {
            t = String(t.dropFirst()).trimmingCharacters(in: .whitespaces)
        }
        if let colon = t.range(of: #"^(title|标题)\s*[:：]\s*"#, options: [.regularExpression, .caseInsensitive]) {
            t.removeSubrange(colon)
        }
        // Inline emphasis / code markers carry no meaning in a list row.
        t = t.replacingOccurrences(of: #"[*_`~]+"#, with: "", options: .regularExpression)
        t = t.trimmingCharacters(in: CharacterSet(charactersIn: "\"'“”‘’「」《》").union(.whitespaces))
        guard !t.isEmpty else { return nil }
        return truncate(t, to: maxGeneratedLength)
    }

    static func category(_ raw: String?) -> String? {
        guard let value = raw?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(),
              categories.contains(value) else { return nil }
        return value
    }

    private static func singleLine(_ raw: String) -> String {
        var out = String.UnicodeScalarView()
        var lastWasSpace = false
        for scalar in raw.unicodeScalars {
            let isSpace = CharacterSet.whitespacesAndNewlines.contains(scalar)
                || CharacterSet.controlCharacters.contains(scalar)
            if isSpace {
                if !lastWasSpace && !out.isEmpty { out.append(" ") }
                lastWasSpace = true
            } else {
                out.append(scalar)
                lastWasSpace = false
            }
        }
        return String(out).trimmingCharacters(in: .whitespaces)
    }

    private static func truncate(_ s: String, to limit: Int) -> String {
        guard s.count > limit else { return s }
        return String(s.prefix(limit - 1)).trimmingCharacters(in: .whitespaces) + "…"
    }
}
