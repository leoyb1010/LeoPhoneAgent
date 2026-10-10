import Foundation

// [T-ios-listsessions-perf] The pure, SQLite-facing parts of the session-list
// pipeline, kept out of ChatStore so the logic-test target can compile and
// exercise the exact SQL text and rules production uses.
//
// Three upstream phases live here:
//   * persisted preview — `sessions.preview_text` / `preview_sort_order`,
//     computed when a message is written instead of re-deriving every
//     session's preview (JSON decode + markdown pipeline) on every refresh;
//   * the session-list SELECT shared by the full rebuild and the incremental
//     patch, decoded by ONE column map (LeoBot layout: 14-16 are provenance);
//   * the incremental patch: only dirty rows are re-queried and spliced into
//     the cached array, untouched rows keep their existing values.

/// Column map + SQL text of the session-list query.
enum SessionListQuery {
    /// Must match `ChatStore.partFlagHasText` / `partFlagHasToolUse`.
    static let partFlagHasText = 1
    static let partFlagHasToolUse = 2

    /// Column indices of `sql(whereClause:)`. LeoBot's layout differs from
    /// upstream's: 14-16 are the device-provenance columns, and the preview
    /// pair is appended after them. Every decode goes through these names.
    enum Column {
        static let id: Int32 = 0
        static let title: Int32 = 1
        static let modelId: Int32 = 2
        static let createdAt: Int32 = 3
        static let updatedAt: Int32 = 4
        static let category: Int32 = 5
        /// parts_json of the latest qualifying assistant row — NULL unless
        /// the stored preview is NULL (pre-upgrade row needing backfill).
        static let assistantParts: Int32 = 6
        static let userParts: Int32 = 7
        static let source: Int32 = 8
        static let lastSyncedAt: Int32 = 9
        static let remoteOriginDeviceId: Int32 = 10
        static let pinnedAt: Int32 = 11
        static let assistantSortOrder: Int32 = 12
        static let userSortOrder: Int32 = 13
        static let originDeviceId: Int32 = 14
        static let lastWriterDeviceId: Int32 = 15
        static let originDeviceName: Int32 = 16
        static let previewText: Int32 = 17
        static let previewSortOrder: Int32 = 18
        static let count = 19
    }

    /// The session-list SELECT. `whereClause` is "" for the full rebuild and
    /// " AND s.id IN (?,…)" for the incremental patch, so the two paths can
    /// never decode different layouts. Hidden sub-agent child sessions
    /// (`parent_session_id` set) are excluded on both paths. [T-subagent]
    ///
    /// The four candidate subqueries only run for rows whose stored preview is
    /// NULL (written before the column existed): SQLite evaluates a CASE
    /// branch only when it is taken, so a backfilled list no longer reads two
    /// parts_json blobs per session per refresh — upstream still selected
    /// them and only skipped the decode.
    ///
    /// `s.id DESC` breaks `updated_at` ties so the full rebuild and the
    /// patch's in-memory re-sort agree on one total order.
    static func sql(whereClause: String) -> String {
        let asstMask = partFlagHasText | partFlagHasToolUse   // 3
        let userMask = partFlagHasText                        // 1
        return """
            SELECT s.id, s.title, s.model_id, s.created_at, s.updated_at, s.category,
                   CASE WHEN s.preview_text IS NULL THEN
                   (SELECT m.parts_json FROM messages m
                     WHERE m.session_id = s.id
                       AND m.role = 'assistant'
                       AND (m.part_flags & \(asstMask)) != 0
                     ORDER BY m.sort_order DESC LIMIT 1) END,
                   CASE WHEN s.preview_text IS NULL THEN
                   (SELECT m.parts_json FROM messages m
                     WHERE m.session_id = s.id
                       AND m.role = 'user'
                       AND (m.part_flags & \(userMask)) != 0
                     ORDER BY m.sort_order DESC LIMIT 1) END,
                   s.source, s.last_synced_at,
                   s.remote_origin_device_id, s.pinned_at,
                   CASE WHEN s.preview_text IS NULL THEN
                   (SELECT m.sort_order FROM messages m
                     WHERE m.session_id = s.id
                       AND m.role = 'assistant'
                       AND (m.part_flags & \(asstMask)) != 0
                     ORDER BY m.sort_order DESC LIMIT 1) END,
                   CASE WHEN s.preview_text IS NULL THEN
                   (SELECT m.sort_order FROM messages m
                     WHERE m.session_id = s.id
                       AND m.role = 'user'
                       AND (m.part_flags & \(userMask)) != 0
                     ORDER BY m.sort_order DESC LIMIT 1) END,
                   s.origin_device_id, s.last_writer_device_id,
                   (SELECT d.device_name FROM sync_devices d WHERE d.device_id = s.origin_device_id),
                   s.preview_text, s.preview_sort_order
            FROM sessions s WHERE s.parent_session_id IS NULL\(whereClause)
            ORDER BY s.updated_at DESC, s.id DESC
            """
    }

    /// " AND s.id IN (?,?,…)" for `count` ids.
    static func idFilter(count: Int) -> String {
        " AND s.id IN (\(Array(repeating: "?", count: max(1, count)).joined(separator: ",")))"
    }
}

/// Which message's preview the sidebar shows, and how a stored preview is
/// folded forward as messages land.
enum SessionPreviewRule {
    struct Candidate: Equatable {
        let text: String
        let sortOrder: Int?
    }

    /// The read-time rule listSessions has always applied: the latest
    /// assistant message with text or a tool_use wins, unless the latest user
    /// text message is strictly newer. Ties go to the assistant.
    static func winner(assistant: Candidate?, user: Candidate?) -> Candidate? {
        switch (assistant, user) {
        case let (a?, u?):
            if let ao = a.sortOrder, let uo = u.sortOrder, uo > ao { return u }
            return a
        case let (a?, nil): return a
        case let (nil, u?): return u
        default: return nil
        }
    }

    /// Assistant rows qualify on text OR tool_use, user rows on text only —
    /// which is what keeps tool_result-only rows (neither bit) out.
    static func qualifies(isAssistant: Bool, partFlags: Int) -> Bool {
        isAssistant
            ? (partFlags & (SessionListQuery.partFlagHasText | SessionListQuery.partFlagHasToolUse)) != 0
            : (partFlags & SessionListQuery.partFlagHasText) != 0
    }

    /// Fold one freshly written message into the stored preview. An assistant
    /// row overwrites at `>=` (it wins ties), a user row only when strictly
    /// newer. Messages arriving now carry the highest sort_order, so the
    /// common case is a plain overwrite; the comparison guards out-of-order
    /// inbound merges.
    static func foldSQL(isAssistant: Bool) -> String {
        let comparison = isAssistant ? ">=" : ">"
        return """
            UPDATE sessions
               SET preview_text = ?, preview_sort_order = ?
             WHERE id = ?
               AND (preview_sort_order IS NULL OR ? \(comparison) preview_sort_order)
            """
    }

    /// Unconditional write used by the recompute / backfill paths. An empty
    /// text is the "computed, nothing displayable" sentinel: NULL would mean
    /// "never computed" and send the row back through the slow path forever.
    static let storeSQL = "UPDATE sessions SET preview_text = ?, preview_sort_order = ? WHERE id = ?"

    /// The four candidate columns a recompute reads for one session.
    static var recomputeSQL: String {
        let asstMask = SessionListQuery.partFlagHasText | SessionListQuery.partFlagHasToolUse
        let userMask = SessionListQuery.partFlagHasText
        return """
            SELECT
              (SELECT m.parts_json FROM messages m
                WHERE m.session_id = ?1 AND m.role = 'assistant'
                  AND (m.part_flags & \(asstMask)) != 0
                ORDER BY m.sort_order DESC LIMIT 1),
              (SELECT m.parts_json FROM messages m
                WHERE m.session_id = ?1 AND m.role = 'user'
                  AND (m.part_flags & \(userMask)) != 0
                ORDER BY m.sort_order DESC LIMIT 1),
              (SELECT m.sort_order FROM messages m
                WHERE m.session_id = ?1 AND m.role = 'assistant'
                  AND (m.part_flags & \(asstMask)) != 0
                ORDER BY m.sort_order DESC LIMIT 1),
              (SELECT m.sort_order FROM messages m
                WHERE m.session_id = ?1 AND m.role = 'user'
                  AND (m.part_flags & \(userMask)) != 0
                ORDER BY m.sort_order DESC LIMIT 1)
            """
    }

    /// Stored text → display value: the empty sentinel renders as "no preview".
    static func display(_ stored: String?) -> String? {
        guard let stored, !stored.isEmpty else { return nil }
        return stored
    }
}

/// A row the incremental patch can splice and re-sort.
protocol SessionListRow {
    var id: String { get }
    var updatedAt: Date { get }
}

enum SessionListPatch {
    /// Splice `refreshed` rows (the re-query of `dirtyIds`) into `cached`.
    ///  * Untouched rows keep their existing values, so SwiftUI's diff sees
    ///    them as identical and only changed rows re-render.
    ///  * A dirty id with no refreshed row was deleted underneath us: drop it.
    ///  * The result is re-sorted like the SQL (`updated_at DESC, id DESC`),
    ///    because a new message bumping updated_at is the common case.
    ///  * [P2] A refreshed row unknown to the cache is a creation (createSession
    ///    now invalidates per session instead of forcing a full rebuild): it is
    ///    inserted, and the re-sort puts it where the SQL would. Only rows the
    ///    caller asked for (`dirtyIds`) are accepted; anything else returns nil
    ///    and the caller rebuilds fully.
    static func apply<Row: SessionListRow>(
        cached: [Row], dirtyIds: Set<String>, refreshed: [String: Row]
    ) -> [Row]? {
        var out: [Row] = []
        out.reserveCapacity(cached.count + 1)
        var seen = Set<String>()
        for row in cached {
            guard dirtyIds.contains(row.id) else {
                out.append(row)
                continue
            }
            seen.insert(row.id)
            if let fresh = refreshed[row.id] { out.append(fresh) }
        }
        for (id, row) in refreshed where !seen.contains(id) {
            guard dirtyIds.contains(id) else { return nil }
            out.append(row)
        }
        sort(&out)
        return out
    }

    static func sort<Row: SessionListRow>(_ rows: inout [Row]) {
        rows.sort { $0.updatedAt == $1.updatedAt ? $0.id > $1.id : $0.updatedAt > $1.updatedAt }
    }
}
