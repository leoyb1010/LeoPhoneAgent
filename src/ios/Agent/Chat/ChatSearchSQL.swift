import Foundation

/// SQL fragments for searching chats. Every user/model query is a literal:
/// `%` and `_` are escaped, and the sidebar searches what the user wrote (the
/// text parts of a message), not the JSON envelope around it — so `"` or
/// `type` no longer match every conversation.
enum ChatSearchSQL {
    /// Longest query the sidebar or the sessions tool will run.
    static let maxQueryLength = 512

    /// Trimmed and bounded; nil when nothing searchable is left.
    static func normalizedQuery(_ raw: String) -> String? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        return String(trimmed.prefix(maxQueryLength))
    }

    /// LIKE literal for `ESCAPE '\'`.
    static func likeEscape(_ s: String) -> String {
        s.replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "%", with: "\\%")
            .replacingOccurrences(of: "_", with: "\\_")
    }

    /// `%literal%` pattern for `LIKE ? ESCAPE '\'`.
    static func containsPattern(_ s: String) -> String { "%\(likeEscape(s))%" }

    /// JSONEncoder escapes these inside string values (and `/` as `\/`), so a
    /// raw `parts_json LIKE` prefilter would miss a real match containing them.
    static func canPrefilterRaw(_ query: String) -> Bool {
        !query.unicodeScalars.contains { $0 == "\"" || $0 == "\\" || $0 == "/" || $0.value < 0x20 }
    }

    /// Predicate true when a text part of `alias`'s parts_json contains the
    /// pattern. Binds: one `?` (pattern) or two when `prefilter` (the cheap raw
    /// LIKE that skips most rows before JSON is parsed).
    static func textPartPredicate(alias: String, prefilter: Bool) -> String {
        let raw = prefilter ? "\(alias).parts_json LIKE ? ESCAPE '\\' AND " : ""
        return """
            (\(raw)EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(\(alias).parts_json) \
            THEN \(alias).parts_json ELSE '[]' END) jp \
            WHERE jp.type = 'object' \
            AND json_extract(CASE WHEN jp.type = 'object' THEN jp.value ELSE '{}' END, '$.type') = 'text' \
            AND json_extract(CASE WHEN jp.type = 'object' THEN jp.value ELSE '{}' END, '$.value') LIKE ? ESCAPE '\\'))
            """
    }

    /// The sidebar search: sessions whose title or message text contains the
    /// query, newest first, with the latest matching message's parts for a
    /// snippet. Column order: id, title, model_id, created_at, updated_at,
    /// category, snippet parts_json. Binds are returned in order.
    static func sessionSearch(query raw: String) -> (sql: String, bindings: [String])? {
        guard let query = normalizedQuery(raw) else { return nil }
        let pattern = containsPattern(query)
        let prefilter = canPrefilterRaw(query)
        let predicateBinds = prefilter ? [pattern, pattern] : [pattern]
        let sql = """
            SELECT s.id, s.title, s.model_id, s.created_at, s.updated_at, s.category,
                   (SELECT m2.parts_json FROM messages m2
                    WHERE m2.session_id = s.id AND \(textPartPredicate(alias: "m2", prefilter: prefilter))
                    ORDER BY m2.sort_order DESC LIMIT 1)
            FROM sessions s
            WHERE s.parent_session_id IS NULL
              AND (s.title LIKE ? ESCAPE '\\'
                   OR EXISTS (SELECT 1 FROM messages m
                              WHERE m.session_id = s.id AND \(textPartPredicate(alias: "m", prefilter: prefilter))))
            ORDER BY s.updated_at DESC
            """
        return (sql, predicateBinds + [pattern] + predicateBinds)
    }
}
