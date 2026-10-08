import Foundation
import SQLite3

/// Bound text is copied immediately (the bridged NSString buffer may die
/// before `sqlite3_step`) — same rule as ChatStore's own SQLITE_TRANSIENT.
private let SQLITE_TRANSIENT = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
private let logger = AppLogger(category: "Backup")

/// Backup export reads and restore writes for the chat database.
///
/// Kept in its own file (an additive extension) so it doesn't collide with
/// other work on ChatStore.swift. Restore semantics:
///   * restored rows are THIS device's data: `remote_origin_device_id` stays
///     NULL, nothing writes sync bookkeeping here; the caller re-marks the
///     changed sessions dirty afterwards so iCloud sync re-uploads them under
///     this device's identity;
///   * MERGE with last-writer-wins on `updated_at` (strictly newer wins, at
///     whole-second precision — packages carry ISO-8601 seconds);
///   * the whole chats restore runs in ONE `BEGIN IMMEDIATE` transaction with
///     no suspension point inside it (an actor-isolated synchronous call), so
///     no other ChatStore write can interleave and a failure rolls back
///     everything; message shards are streamed, never loaded whole.
extension ChatStore {

    enum BackupRestoreError: LocalizedError {
        case databaseUnavailable
        case sqlite(String)

        var errorDescription: String? {
            switch self {
            case .databaseUnavailable: return String(localized: "聊天数据库不可用")
            case .sqlite: return String(localized: "写入聊天数据库失败，已回滚")
            }
        }
    }

    // MARK: - Export

    /// Live sessions (soft-deleted ones are excluded: restoring them would
    /// resurrect what the user deleted).
    func backupSessionIds() -> [String] {
        var ids: [String] = []
        var stmt: OpaquePointer?
        defer { sqlite3_finalize(stmt) }
        guard sqlite3_prepare_v2(db, "SELECT id FROM sessions WHERE remote_tombstoned_at IS NULL ORDER BY updated_at DESC",
                                 -1, &stmt, nil) == SQLITE_OK else { return ids }
        while sqlite3_step(stmt) == SQLITE_ROW {
            if let c = sqlite3_column_text(stmt, 0) { ids.append(String(cString: c)) }
        }
        return ids
    }

    func backupSessionRecord(_ id: String) -> BackupSessionRecord? {
        let sql = """
            SELECT id, title, category, model_id, created_at, updated_at, source, pinned_at,
                   memory_enabled, model_binding
            FROM sessions WHERE id = ?
            """
        var stmt: OpaquePointer?
        defer { sqlite3_finalize(stmt) }
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return nil }
        sqlite3_bind_text(stmt, 1, (id as NSString).utf8String, -1, SQLITE_TRANSIENT)
        guard sqlite3_step(stmt) == SQLITE_ROW else { return nil }
        let session = BackupSessionRecord.Session(
            id: Self.backupText(stmt, 0) ?? id,
            title: Self.backupText(stmt, 1),
            category: Self.backupText(stmt, 2),
            modelId: Self.backupText(stmt, 3) ?? "unknown",
            createdAt: Date(timeIntervalSince1970: sqlite3_column_double(stmt, 4)),
            updatedAt: Date(timeIntervalSince1970: sqlite3_column_double(stmt, 5)),
            source: Self.backupText(stmt, 6),
            pinnedAt: sqlite3_column_type(stmt, 7) == SQLITE_NULL
                ? nil : Date(timeIntervalSince1970: sqlite3_column_double(stmt, 7)))
        return BackupSessionRecord(session: session,
                                   memoryEnabled: sqlite3_column_int(stmt, 8) != 0,
                                   modelBinding: Self.backupText(stmt, 9))
    }

    func backupMessages(sessionId: String) -> [BackupMessageRecord] {
        let sql = """
            SELECT id, session_id, role, parts_json, created_at, token_usage, sort_order,
                   reasoning_content, stream_interrupt_count, updated_at, error_info
            FROM messages WHERE session_id = ? ORDER BY sort_order ASC
            """
        var stmt: OpaquePointer?
        defer { sqlite3_finalize(stmt) }
        var out: [BackupMessageRecord] = []
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return out }
        sqlite3_bind_text(stmt, 1, (sessionId as NSString).utf8String, -1, SQLITE_TRANSIENT)
        while sqlite3_step(stmt) == SQLITE_ROW {
            guard let id = Self.backupText(stmt, 0), let partsJSON = Self.backupText(stmt, 3),
                  let parts = BackupJSONValue.parse(partsJSON) else { continue }
            out.append(BackupMessageRecord(
                id: id, sessionId: Self.backupText(stmt, 1) ?? sessionId,
                role: Self.backupText(stmt, 2) ?? "user", parts: parts,
                createdAt: Date(timeIntervalSince1970: sqlite3_column_double(stmt, 4)),
                tokenUsage: Self.backupText(stmt, 5).flatMap(BackupJSONValue.parse),
                reasoningContent: Self.backupText(stmt, 7),
                streamInterruptCount: Int(sqlite3_column_int64(stmt, 8)),
                sortOrder: Int(sqlite3_column_int64(stmt, 6)),
                errorInfo: Self.backupText(stmt, 10),
                updatedAt: sqlite3_column_type(stmt, 9) == SQLITE_NULL
                    ? nil : Date(timeIntervalSince1970: sqlite3_column_double(stmt, 9))))
        }
        return out
    }

    func backupCompactMarkers(sessionId: String) -> [BackupCompactMarkerRecord] {
        compactMarkers(sessionId: sessionId).map {
            BackupCompactMarkerRecord(
                id: $0.id, sessionId: $0.sessionId, summary: $0.summary,
                firstKeptSortOrder: $0.firstKeptSortOrder, compactedCount: $0.compactedCount,
                createdAt: $0.createdAt, uiBoundarySortOrder: $0.uiBoundarySortOrder,
                boundaryMessageId: $0.boundaryMessageId, firstKeptMessageId: $0.firstKeptMessageId,
                lastCompactedMessageId: $0.lastCompactedMessageId, version: $0.version)
        }
    }

    // MARK: - Restore

    func backupSessionStamps(_ ids: [String]) -> [String: Date] {
        var out: [String: Date] = [:]
        var stmt: OpaquePointer?
        defer { sqlite3_finalize(stmt) }
        guard sqlite3_prepare_v2(db, "SELECT updated_at FROM sessions WHERE id = ?", -1, &stmt, nil) == SQLITE_OK else {
            return out
        }
        for id in ids {
            sqlite3_reset(stmt)
            sqlite3_clear_bindings(stmt)
            sqlite3_bind_text(stmt, 1, (id as NSString).utf8String, -1, SQLITE_TRANSIENT)
            if sqlite3_step(stmt) == SQLITE_ROW {
                out[id] = Date(timeIntervalSince1970: sqlite3_column_double(stmt, 0))
            }
        }
        return out
    }

    /// Merge sessions, then stream their messages and compact markers, in one
    /// transaction. `sessions` are the ones the importer decided to merge;
    /// the LWW decision is re-checked here inside the write lock.
    func restoreChatsFromBackup(sessions: [BackupSessionRecord], dataDir: URL) throws -> BackupChatApplyResult {
        guard let db else { throw BackupRestoreError.databaseUnavailable }
        invalidateSessionListCache()
        guard sqlite3_exec(db, "BEGIN IMMEDIATE", nil, nil, nil) == SQLITE_OK else {
            throw BackupRestoreError.sqlite("begin")
        }
        do {
            let result = try restoreChatsInTransaction(db, sessions: sessions, dataDir: dataDir)
            guard sqlite3_exec(db, "COMMIT", nil, nil, nil) == SQLITE_OK else {
                throw BackupRestoreError.sqlite("commit")
            }
            invalidateSessionListCache()
            return result
        } catch {
            sqlite3_exec(db, "ROLLBACK", nil, nil, nil)
            invalidateSessionListCache()
            logger.error("[Restore] chats transaction rolled back")
            throw error
        }
    }

    private func restoreChatsInTransaction(_ db: OpaquePointer, sessions: [BackupSessionRecord],
                                           dataDir: URL) throws -> BackupChatApplyResult {
        var result = BackupChatApplyResult()
        var applied = Set<String>()
        let stamps = backupSessionStamps(sessions.map(\.session.id))

        for rec in sessions {
            let s = rec.session
            // Defensive: the importer refuses up front, but never write under
            // a running agent loop.
            if SessionActivityTracker.isActiveThreadSafe(s.id) { result.sessionsKeptLocal += 1; continue }
            switch BackupMerge.decide(local: stamps[s.id], incoming: s.updatedAt) {
            case .keepLocal:
                result.sessionsKeptLocal += 1
                continue
            case .insert:
                try run(db, """
                    INSERT INTO sessions (id, title, category, model_id, created_at, updated_at, source,
                                          memory_enabled, model_binding, pinned_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """) { st in
                    Self.bind(st, 1, s.id); Self.bind(st, 2, s.title); Self.bind(st, 3, s.category)
                    Self.bind(st, 4, s.modelId)
                    sqlite3_bind_double(st, 5, s.createdAt.timeIntervalSince1970)
                    sqlite3_bind_double(st, 6, s.updatedAt.timeIntervalSince1970)
                    Self.bind(st, 7, s.source)
                    sqlite3_bind_int(st, 8, rec.memoryEnabled ? 1 : 0)
                    Self.bind(st, 9, rec.modelBinding)
                    Self.bind(st, 10, s.pinnedAt?.timeIntervalSince1970)
                }
                result.sessionsInserted += 1
            case .update:
                try run(db, """
                    UPDATE sessions SET title = ?, category = ?, updated_at = ?, memory_enabled = ?,
                                        model_binding = ?, pinned_at = ?, remote_tombstoned_at = NULL
                    WHERE id = ?
                    """) { st in
                    Self.bind(st, 1, s.title); Self.bind(st, 2, s.category)
                    sqlite3_bind_double(st, 3, s.updatedAt.timeIntervalSince1970)
                    sqlite3_bind_int(st, 4, rec.memoryEnabled ? 1 : 0)
                    Self.bind(st, 5, rec.modelBinding)
                    Self.bind(st, 6, s.pinnedAt?.timeIntervalSince1970)
                    Self.bind(st, 7, s.id)
                }
                result.sessionsUpdated += 1
            }
            // An explicit restore outranks the resurrection guards: clear the
            // local delete tombstones so the rows aren't dropped as stale echoes.
            try run(db, "DELETE FROM deleted_session_tombstones WHERE session_id = ?") { Self.bind($0, 1, s.id) }
            try run(db, "DELETE FROM deleted_record_tombstones WHERE record_id = ?") { Self.bind($0, 1, s.id) }
            applied.insert(s.id)
            result.changedSessionIds.append(s.id)
        }
        guard !applied.isEmpty else { return result }

        // Messages: LWW per row, original id and sort_order preserved.
        var lookup: OpaquePointer?
        var upsert: OpaquePointer?
        defer { sqlite3_finalize(lookup); sqlite3_finalize(upsert) }
        guard sqlite3_prepare_v2(db, "SELECT session_id, COALESCE(updated_at, created_at) FROM messages WHERE id = ?",
                                 -1, &lookup, nil) == SQLITE_OK,
              sqlite3_prepare_v2(db, """
                INSERT OR REPLACE INTO messages (id, session_id, role, parts_json, created_at, token_usage,
                    sort_order, reasoning_content, stream_interrupt_count, updated_at, error_info, part_flags)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """, -1, &upsert, nil) == SQLITE_OK else {
            throw BackupRestoreError.sqlite("prepare")
        }
        var stepError: Error?
        let stats = BackupJSONLReader.forEach(in: dataDir, base: "messages", as: BackupMessageRecord.self) { m in
            guard stepError == nil, applied.contains(m.sessionId) else { return }
            guard m.role == "user" || m.role == "assistant",
                  let partsJSON = m.parts.jsonString(),
                  (try? JSONDecoder().decode([ContentPart].self, from: Data(partsJSON.utf8))) != nil else {
                result.unreadable += 1
                return
            }
            sqlite3_reset(lookup); sqlite3_clear_bindings(lookup)
            Self.bind(lookup, 1, m.id)
            var localUpdated: Date?
            if sqlite3_step(lookup) == SQLITE_ROW {
                // Same id under a different session: never move rows across sessions.
                guard Self.backupText(lookup, 0) == m.sessionId else { result.messagesKeptLocal += 1; return }
                localUpdated = Date(timeIntervalSince1970: sqlite3_column_double(lookup, 1))
            }
            let decision = BackupMerge.decide(local: localUpdated, incoming: m.effectiveUpdatedAt)
            if decision == .keepLocal { result.messagesKeptLocal += 1; return }
            sqlite3_reset(upsert); sqlite3_clear_bindings(upsert)
            Self.bind(upsert, 1, m.id); Self.bind(upsert, 2, m.sessionId); Self.bind(upsert, 3, m.role)
            Self.bind(upsert, 4, partsJSON)
            sqlite3_bind_double(upsert, 5, m.createdAt.timeIntervalSince1970)
            Self.bind(upsert, 6, m.tokenUsage?.jsonString())
            sqlite3_bind_int64(upsert, 7, Int64(m.sortOrder))
            Self.bind(upsert, 8, m.reasoningContent)
            sqlite3_bind_int64(upsert, 9, Int64(m.streamInterruptCount))
            sqlite3_bind_double(upsert, 10, m.effectiveUpdatedAt.timeIntervalSince1970)
            Self.bind(upsert, 11, m.errorInfo)
            sqlite3_bind_int64(upsert, 12, Int64(Self.partFlags(fromPartsJSON: partsJSON)))
            guard sqlite3_step(upsert) == SQLITE_DONE else {
                stepError = BackupRestoreError.sqlite("message")
                return
            }
            if decision == .insert { result.messagesInserted += 1 } else { result.messagesUpdated += 1 }
        }
        if let stepError { throw stepError }
        result.unreadable += stats.unreadable
        // The stored sidebar preview only folds forward on ChatStore's own
        // writes; restored rows bypass that, so recompute it for every touched
        // session (same connection, inside this transaction).
        for id in applied { recomputeStoredPreview(sessionId: id) }

        // Compact markers are immutable: presence decides.
        var markerError: Error?
        let markerStats = BackupJSONLReader.forEach(in: dataDir, base: "compact_markers",
                                                    as: BackupCompactMarkerRecord.self) { mk in
            guard markerError == nil, applied.contains(mk.sessionId) else { return }
            do {
                var exists = false
                try run(db, "SELECT 1 FROM compact_markers WHERE id = ?",
                        bind: { Self.bind($0, 1, mk.id) }, row: { _ in exists = true })
                if exists { result.markersKept += 1; return }
                try run(db, """
                    INSERT INTO compact_markers (id, session_id, summary, first_kept_sort_order, compacted_count,
                        created_at, ui_boundary_sort_order, boundary_message_id, first_kept_message_id,
                        last_compacted_message_id, version)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """) { st in
                    Self.bind(st, 1, mk.id); Self.bind(st, 2, mk.sessionId); Self.bind(st, 3, mk.summary)
                    sqlite3_bind_int64(st, 4, Int64(mk.firstKeptSortOrder))
                    sqlite3_bind_int64(st, 5, Int64(mk.compactedCount))
                    sqlite3_bind_double(st, 6, mk.createdAt.timeIntervalSince1970)
                    if let v = mk.uiBoundarySortOrder { sqlite3_bind_int64(st, 7, Int64(v)) } else { sqlite3_bind_null(st, 7) }
                    Self.bind(st, 8, mk.boundaryMessageId); Self.bind(st, 9, mk.firstKeptMessageId)
                    Self.bind(st, 10, mk.lastCompactedMessageId)
                    sqlite3_bind_int64(st, 11, Int64(mk.version))
                }
                result.markersInserted += 1
            } catch {
                markerError = error
            }
        }
        if let markerError { throw markerError }
        result.unreadable += markerStats.unreadable
        return result
    }

    // MARK: - SQLite helpers

    private func run(_ db: OpaquePointer, _ sql: String,
                     bind: (OpaquePointer?) -> Void, row: ((OpaquePointer?) -> Void)? = nil) throws {
        var stmt: OpaquePointer?
        defer { sqlite3_finalize(stmt) }
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { throw BackupRestoreError.sqlite("prepare") }
        bind(stmt)
        let rc = sqlite3_step(stmt)
        if rc == SQLITE_ROW { row?(stmt); return }
        guard rc == SQLITE_DONE else { throw BackupRestoreError.sqlite("step") }
    }

    private static func bind(_ stmt: OpaquePointer?, _ idx: Int32, _ value: String?) {
        if let value { sqlite3_bind_text(stmt, idx, (value as NSString).utf8String, -1, SQLITE_TRANSIENT) }
        else { sqlite3_bind_null(stmt, idx) }
    }

    private static func bind(_ stmt: OpaquePointer?, _ idx: Int32, _ value: Double?) {
        if let value { sqlite3_bind_double(stmt, idx, value) } else { sqlite3_bind_null(stmt, idx) }
    }

    private static func backupText(_ stmt: OpaquePointer?, _ col: Int32) -> String? {
        guard sqlite3_column_type(stmt, col) != SQLITE_NULL, let c = sqlite3_column_text(stmt, col) else { return nil }
        return String(cString: c)
    }
}
