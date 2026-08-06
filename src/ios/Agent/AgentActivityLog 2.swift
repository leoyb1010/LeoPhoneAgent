import Foundation
import SQLite3

private let activityLogLogger = AppLogger(category: "AgentActivityLog")

/// Device-local, rolling execution history.
///
/// Privacy contract: this database never stores prompts, tool arguments,
/// provider responses or tool output. It is separate from the chat database,
/// is never marked sync-dirty, and can be cleared independently.
@MainActor
final class AgentActivityLog: ObservableObject {
    static let shared = AgentActivityLog()

    @Published private(set) var revision = 0

    private static let maxRows = 5000
    private var db: OpaquePointer?
    private let dbURL: URL

    init() {
        let library = FileManager.default.urls(for: .libraryDirectory, in: .userDomainMask).first!
        var base = library.appendingPathComponent("LeoPhoneAgent", isDirectory: true)
        try? FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
        var resourceValues = URLResourceValues()
        resourceValues.isExcludedFromBackup = true
        try? base.setResourceValues(resourceValues)
        dbURL = base.appendingPathComponent("agent-activity.db")
        openAndMigrate()
        recoverRunsInterruptedByPreviousProcess()
    }

    deinit {
        sqlite3_close(db)
    }

    private func openAndMigrate() {
        guard sqlite3_open(dbURL.path, &db) == SQLITE_OK else {
            activityLogLogger.error("Could not open device-local activity database")
            return
        }
        exec("PRAGMA journal_mode=WAL")
        exec("""
            CREATE TABLE IF NOT EXISTS activity_event (
                id          TEXT PRIMARY KEY,
                run_id      TEXT NOT NULL,
                session_id  TEXT NOT NULL,
                at          REAL NOT NULL,
                kind        TEXT NOT NULL,
                phase       TEXT NOT NULL,
                tool_name   TEXT,
                reason      TEXT
            )
        """)
        ensureColumn("reason", definition: "TEXT")
        exec("CREATE INDEX IF NOT EXISTS idx_activity_session_at ON activity_event(session_id, at DESC)")
        exec("CREATE INDEX IF NOT EXISTS idx_activity_run_at ON activity_event(run_id, at DESC)")
        exec("""
            CREATE TABLE IF NOT EXISTS agent_run_state (
                run_id      TEXT PRIMARY KEY,
                session_id  TEXT NOT NULL,
                started_at  REAL NOT NULL,
                updated_at  REAL NOT NULL,
                phase       TEXT NOT NULL,
                tool_name   TEXT,
                reason      TEXT
            )
        """)
        exec("CREATE INDEX IF NOT EXISTS idx_run_state_session_updated ON agent_run_state(session_id, updated_at DESC)")
        exec("CREATE INDEX IF NOT EXISTS idx_run_state_phase ON agent_run_state(phase)")
        // Backfill the latest privacy-safe event for databases created before
        // durable run state existed. This table is device-local and never
        // participates in the chat/iCloud schema.
        exec("""
            INSERT OR IGNORE INTO agent_run_state
                (run_id, session_id, started_at, updated_at, phase, tool_name, reason)
            SELECT latest.run_id,
                   latest.session_id,
                   first.started_at,
                   latest.at,
                   latest.phase,
                   latest.tool_name,
                   latest.reason
            FROM activity_event latest
            JOIN (
                SELECT run_id, MIN(at) AS started_at, MAX(at) AS updated_at
                FROM activity_event
                GROUP BY run_id
            ) first ON first.run_id = latest.run_id AND first.updated_at = latest.at
        """)
    }

    private func exec(_ sql: String) {
        var error: UnsafeMutablePointer<CChar>?
        if sqlite3_exec(db, sql, nil, nil, &error) != SQLITE_OK {
            let message = error.map { String(cString: $0) } ?? "unknown"
            activityLogLogger.error("SQLite error: \(message)")
            sqlite3_free(error)
        }
    }

    private func ensureColumn(_ name: String, definition: String) {
        guard db != nil else { return }
        var statement: OpaquePointer?
        var exists = false
        if sqlite3_prepare_v2(db, "PRAGMA table_info(activity_event)", -1, &statement, nil) == SQLITE_OK {
            while sqlite3_step(statement) == SQLITE_ROW {
                if let text = sqlite3_column_text(statement, 1), String(cString: text) == name {
                    exists = true
                    break
                }
            }
        }
        sqlite3_finalize(statement)
        if !exists {
            exec("ALTER TABLE activity_event ADD COLUMN \(name) \(definition)")
        }
    }

    func append(_ event: AgentActivityEvent) {
        guard db != nil else { return }
        exec("BEGIN IMMEDIATE")
        if event.kind == .runStarted {
            closeSupersededRuns(
                sessionId: event.sessionId,
                excluding: event.runId,
                at: event.at
            )
        }
        let sql = """
            INSERT OR REPLACE INTO activity_event
              (id, run_id, session_id, at, kind, phase, tool_name, reason)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """
        var statement: OpaquePointer?
        if sqlite3_prepare_v2(db, sql, -1, &statement, nil) == SQLITE_OK {
            bind(event.id, to: 1, in: statement)
            bind(event.runId, to: 2, in: statement)
            bind(event.sessionId, to: 3, in: statement)
            sqlite3_bind_double(statement, 4, event.at.timeIntervalSince1970)
            bind(event.kind.rawValue, to: 5, in: statement)
            bind(event.phase.rawValue, to: 6, in: statement)
            if let toolName = event.toolName, !toolName.isEmpty {
                bind(toolName, to: 7, in: statement)
            } else {
                sqlite3_bind_null(statement, 7)
            }
            if let reason = event.reason {
                bind(reason.rawValue, to: 8, in: statement)
            } else {
                sqlite3_bind_null(statement, 8)
            }
            if sqlite3_step(statement) != SQLITE_DONE {
                activityLogLogger.error("Could not append activity event")
            }
        }
        sqlite3_finalize(statement)
        upsertRunState(from: event)
        exec("""
            DELETE FROM activity_event
            WHERE id NOT IN (
                SELECT id FROM activity_event ORDER BY at DESC LIMIT \(Self.maxRows)
            )
        """)
        exec("""
            DELETE FROM agent_run_state
            WHERE run_id NOT IN (
                SELECT run_id FROM agent_run_state
                ORDER BY updated_at DESC LIMIT 1000
            )
        """)
        exec("COMMIT")
        revision &+= 1
    }

    /// A new turn supersedes any resumable/nonterminal run left for the same
    /// session. Close those records before inserting the new run so a stale
    /// interruption badge cannot reappear after the new turn finishes.
    private func closeSupersededRuns(sessionId: String, excluding runId: String, at: Date) {
        let insertSQL = """
            INSERT INTO activity_event
                (id, run_id, session_id, at, kind, phase, tool_name, reason)
            SELECT lower(hex(randomblob(16))), run_id, session_id, ?, ?, ?, NULL, ?
            FROM agent_run_state
            WHERE session_id = ? AND run_id != ?
              AND phase NOT IN ('completed', 'failed', 'cancelled')
        """
        var insertStatement: OpaquePointer?
        if sqlite3_prepare_v2(db, insertSQL, -1, &insertStatement, nil) == SQLITE_OK {
            sqlite3_bind_double(insertStatement, 1, at.timeIntervalSince1970)
            bind(AgentActivityEventKind.runFinished.rawValue, to: 2, in: insertStatement)
            bind(AgentActivityPhase.cancelled.rawValue, to: 3, in: insertStatement)
            bind(AgentActivityReason.unexpectedTermination.rawValue, to: 4, in: insertStatement)
            bind(sessionId, to: 5, in: insertStatement)
            bind(runId, to: 6, in: insertStatement)
            sqlite3_step(insertStatement)
        }
        sqlite3_finalize(insertStatement)

        let updateSQL = """
            UPDATE agent_run_state
            SET updated_at = ?, phase = ?, tool_name = NULL, reason = ?
            WHERE session_id = ? AND run_id != ?
              AND phase NOT IN ('completed', 'failed', 'cancelled')
        """
        var updateStatement: OpaquePointer?
        if sqlite3_prepare_v2(db, updateSQL, -1, &updateStatement, nil) == SQLITE_OK {
            sqlite3_bind_double(updateStatement, 1, at.timeIntervalSince1970)
            bind(AgentActivityPhase.cancelled.rawValue, to: 2, in: updateStatement)
            bind(AgentActivityReason.unexpectedTermination.rawValue, to: 3, in: updateStatement)
            bind(sessionId, to: 4, in: updateStatement)
            bind(runId, to: 5, in: updateStatement)
            sqlite3_step(updateStatement)
        }
        sqlite3_finalize(updateStatement)
    }

    private func upsertRunState(from event: AgentActivityEvent) {
        let sql = """
            INSERT INTO agent_run_state
                (run_id, session_id, started_at, updated_at, phase, tool_name, reason)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(run_id) DO UPDATE SET
                session_id = excluded.session_id,
                updated_at = excluded.updated_at,
                phase = excluded.phase,
                tool_name = excluded.tool_name,
                reason = excluded.reason
        """
        var statement: OpaquePointer?
        if sqlite3_prepare_v2(db, sql, -1, &statement, nil) == SQLITE_OK {
            bind(event.runId, to: 1, in: statement)
            bind(event.sessionId, to: 2, in: statement)
            sqlite3_bind_double(statement, 3, event.at.timeIntervalSince1970)
            sqlite3_bind_double(statement, 4, event.at.timeIntervalSince1970)
            bind(event.phase.rawValue, to: 5, in: statement)
            if let toolName = event.toolName, !toolName.isEmpty {
                bind(toolName, to: 6, in: statement)
            } else {
                sqlite3_bind_null(statement, 6)
            }
            if let reason = event.reason {
                bind(reason.rawValue, to: 7, in: statement)
            } else {
                sqlite3_bind_null(statement, 7)
            }
            if sqlite3_step(statement) != SQLITE_DONE {
                activityLogLogger.error("Could not update durable run state")
            }
        }
        sqlite3_finalize(statement)
    }

    /// Re-keys the first run of a newly-created draft to its persisted session.
    func reassign(runId: String, from draftId: String, to sessionId: String) {
        guard db != nil, draftId != sessionId else { return }
        var statement: OpaquePointer?
        let sql = "UPDATE activity_event SET session_id = ? WHERE run_id = ? AND session_id = ?"
        if sqlite3_prepare_v2(db, sql, -1, &statement, nil) == SQLITE_OK {
            bind(sessionId, to: 1, in: statement)
            bind(runId, to: 2, in: statement)
            bind(draftId, to: 3, in: statement)
            sqlite3_step(statement)
        }
        sqlite3_finalize(statement)
        var stateStatement: OpaquePointer?
        let stateSQL = "UPDATE agent_run_state SET session_id = ? WHERE run_id = ? AND session_id = ?"
        if sqlite3_prepare_v2(db, stateSQL, -1, &stateStatement, nil) == SQLITE_OK {
            bind(sessionId, to: 1, in: stateStatement)
            bind(runId, to: 2, in: stateStatement)
            bind(draftId, to: 3, in: stateStatement)
            sqlite3_step(stateStatement)
        }
        sqlite3_finalize(stateStatement)
        revision &+= 1
    }

    func recent(limit: Int = 200, sessionId: String? = nil) -> [AgentActivityEvent] {
        guard db != nil else { return [] }
        let cappedLimit = max(1, min(limit, Self.maxRows))
        var sql = "SELECT id, run_id, session_id, at, kind, phase, tool_name, reason FROM activity_event"
        if sessionId != nil { sql += " WHERE session_id = ?" }
        sql += " ORDER BY at DESC LIMIT ?"
        var statement: OpaquePointer?
        var events: [AgentActivityEvent] = []
        if sqlite3_prepare_v2(db, sql, -1, &statement, nil) == SQLITE_OK {
            var index: Int32 = 1
            if let sessionId {
                bind(sessionId, to: index, in: statement)
                index += 1
            }
            sqlite3_bind_int(statement, index, Int32(cappedLimit))
            while sqlite3_step(statement) == SQLITE_ROW {
                if let event = decode(statement) { events.append(event) }
            }
        }
        sqlite3_finalize(statement)
        return events
    }

    /// Runs whose durable current phase is not terminal. Used for recovery
    /// diagnostics after a crash or OS termination; it never auto-resumes work.
    func unfinishedRunIds() -> [String] {
        guard db != nil else { return [] }
        let sql = """
            SELECT run_id FROM agent_run_state
            WHERE phase NOT IN ('completed', 'failed', 'cancelled')
            ORDER BY updated_at DESC
        """
        var statement: OpaquePointer?
        var ids: [String] = []
        if sqlite3_prepare_v2(db, sql, -1, &statement, nil) == SQLITE_OK {
            while sqlite3_step(statement) == SQLITE_ROW,
                  let text = sqlite3_column_text(statement, 0) {
                ids.append(String(cString: text))
            }
        }
        sqlite3_finalize(statement)
        return ids
    }

    /// Sessions with a persisted interruption point that can be shown as
    /// resumable after launch. The current process never auto-runs these.
    func resumableSessionIds() -> Set<String> {
        guard db != nil else { return [] }
        let sql = """
            SELECT DISTINCT session_id FROM agent_run_state
            WHERE phase IN ('waiting_for_user', 'suspended')
        """
        var statement: OpaquePointer?
        var ids: Set<String> = []
        if sqlite3_prepare_v2(db, sql, -1, &statement, nil) == SQLITE_OK {
            while sqlite3_step(statement) == SQLITE_ROW,
                  let text = sqlite3_column_text(statement, 0) {
                ids.insert(String(cString: text))
            }
        }
        sqlite3_finalize(statement)
        return ids
    }

    func latestRunState(sessionId: String) -> AgentRunState? {
        guard db != nil else { return nil }
        let sql = """
            SELECT run_id, session_id, started_at, updated_at, phase, tool_name, reason
            FROM agent_run_state
            WHERE session_id = ?
            ORDER BY updated_at DESC
            LIMIT 1
        """
        var statement: OpaquePointer?
        var state: AgentRunState?
        if sqlite3_prepare_v2(db, sql, -1, &statement, nil) == SQLITE_OK {
            bind(sessionId, to: 1, in: statement)
            if sqlite3_step(statement) == SQLITE_ROW {
                state = decodeRunState(statement)
            }
        }
        sqlite3_finalize(statement)
        return state
    }

    /// The singleton is created once per process. At that moment, any durable
    /// nonterminal run necessarily belonged to the previous process and cannot
    /// still be executing. Convert it to an explicit resumable interruption so
    /// even a hard kill during plain text streaming is visible after relaunch.
    private func recoverRunsInterruptedByPreviousProcess() {
        guard db != nil else { return }
        let sql = """
            SELECT run_id, session_id, started_at, updated_at, phase, tool_name, reason
            FROM agent_run_state
            WHERE phase NOT IN ('completed', 'failed', 'cancelled', 'waiting_for_user')
            ORDER BY updated_at DESC
        """
        var statement: OpaquePointer?
        var states: [AgentRunState] = []
        if sqlite3_prepare_v2(db, sql, -1, &statement, nil) == SQLITE_OK {
            while sqlite3_step(statement) == SQLITE_ROW {
                if let state = decodeRunState(statement) { states.append(state) }
            }
        }
        sqlite3_finalize(statement)

        guard !states.isEmpty else { return }
        let recoveredAt = Date()
        for state in states {
            let recovered = state.recoveringAfterUnexpectedTermination(at: recoveredAt)
            append(AgentActivityEvent(
                runId: recovered.runId,
                sessionId: recovered.sessionId,
                at: recovered.updatedAt,
                kind: .phaseChanged,
                phase: recovered.phase,
                toolName: recovered.toolName,
                reason: recovered.reason
            ))
        }
        activityLogLogger.info("Recovered \(states.count) interrupted run state record(s)")
    }

    func clearAll() {
        guard db != nil else { return }
        exec("BEGIN IMMEDIATE")
        exec("DELETE FROM activity_event")
        exec("DELETE FROM agent_run_state")
        exec("COMMIT")
        revision &+= 1
    }

    func usage() -> (count: Int, capacity: Int) {
        guard db != nil else { return (0, Self.maxRows) }
        var statement: OpaquePointer?
        var count = 0
        if sqlite3_prepare_v2(db, "SELECT COUNT(*) FROM activity_event", -1, &statement, nil) == SQLITE_OK,
           sqlite3_step(statement) == SQLITE_ROW {
            count = Int(sqlite3_column_int(statement, 0))
        }
        sqlite3_finalize(statement)
        return (count, Self.maxRows)
    }

    private func bind(_ value: String, to index: Int32, in statement: OpaquePointer?) {
        sqlite3_bind_text(statement, index, (value as NSString).utf8String, -1, nil)
    }

    private func decode(_ statement: OpaquePointer?) -> AgentActivityEvent? {
        guard let statement,
              let idText = sqlite3_column_text(statement, 0),
              let runText = sqlite3_column_text(statement, 1),
              let sessionText = sqlite3_column_text(statement, 2),
              let kindText = sqlite3_column_text(statement, 4),
              let phaseText = sqlite3_column_text(statement, 5),
              let kind = AgentActivityEventKind(rawValue: String(cString: kindText)),
              let phase = AgentActivityPhase(rawValue: String(cString: phaseText)) else { return nil }
        let toolName = sqlite3_column_text(statement, 6).map(String.init(cString:))
        let reason = sqlite3_column_text(statement, 7)
            .map(String.init(cString:))
            .flatMap { AgentActivityReason(rawValue: $0) }
        return AgentActivityEvent(
            id: String(cString: idText),
            runId: String(cString: runText),
            sessionId: String(cString: sessionText),
            at: Date(timeIntervalSince1970: sqlite3_column_double(statement, 3)),
            kind: kind,
            phase: phase,
            toolName: toolName,
            reason: reason
        )
    }

    private func decodeRunState(_ statement: OpaquePointer?) -> AgentRunState? {
        guard let statement,
              let runText = sqlite3_column_text(statement, 0),
              let sessionText = sqlite3_column_text(statement, 1),
              let phaseText = sqlite3_column_text(statement, 4),
              let phase = AgentActivityPhase(rawValue: String(cString: phaseText)) else { return nil }
        let toolName = sqlite3_column_text(statement, 5).map(String.init(cString:))
        let reason = sqlite3_column_text(statement, 6)
            .map(String.init(cString:))
            .flatMap { AgentActivityReason(rawValue: $0) }
        return AgentRunState(
            runId: String(cString: runText),
            sessionId: String(cString: sessionText),
            startedAt: Date(timeIntervalSince1970: sqlite3_column_double(statement, 2)),
            updatedAt: Date(timeIntervalSince1970: sqlite3_column_double(statement, 3)),
            phase: phase,
            toolName: toolName,
            reason: reason
        )
    }
}
