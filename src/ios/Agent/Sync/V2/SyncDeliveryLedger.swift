import Foundation
import SQLite3

struct SyncDeliveryTicket: Codable, Equatable, Sendable {
    let destination: String
    let recordType: String
    let recordId: String
    let revision: Int64
    let changeId: String
    let operation: String
    let updatedAt: Date
    var recordName: String { "\(recordType):\(recordId)" }
}

/// Shares the business SQLite connection. Dirty triggers and delivery tickets
/// commit together even when a caller uses raw SQL rather than markDirty().
enum SyncDeliveryLedger {
    enum LedgerError: Error { case sqlite(Int32, String) }
    static func migrate(_ db: OpaquePointer?, recordTypes: [String]) throws {
        let types = recordTypes.map { "'" + $0.replacingOccurrences(of: "'", with: "''") + "'" }.joined(separator: ",")
        try transaction(db) {
            try exec(db, """
                CREATE TABLE IF NOT EXISTS sync_delivery_meta(key TEXT PRIMARY KEY);
                CREATE TABLE IF NOT EXISTS sync_delivery_destinations(id TEXT PRIMARY KEY, enabled INTEGER NOT NULL);
                INSERT OR IGNORE INTO sync_delivery_destinations VALUES ('iCloud',1);
                CREATE TABLE IF NOT EXISTS sync_delivery_heads(record_type TEXT NOT NULL,record_id TEXT NOT NULL,revision INTEGER NOT NULL,change_id TEXT NOT NULL,PRIMARY KEY(record_type,record_id));
                CREATE TABLE IF NOT EXISTS sync_delivery_tickets(destination TEXT NOT NULL,record_type TEXT NOT NULL,record_id TEXT NOT NULL,revision INTEGER NOT NULL,change_id TEXT NOT NULL,operation TEXT NOT NULL,updated_at REAL NOT NULL,priority INTEGER NOT NULL DEFAULT 0,failure TEXT,PRIMARY KEY(destination,record_type,record_id));
                CREATE TABLE IF NOT EXISTS sync_delivery_payloads(record_type TEXT NOT NULL,record_id TEXT NOT NULL,revision INTEGER NOT NULL,payload BLOB NOT NULL,PRIMARY KEY(record_type,record_id,revision));
                CREATE INDEX IF NOT EXISTS sync_delivery_ready ON sync_delivery_tickets(destination,failure,priority,updated_at);
                """)
            for event in ["INSERT", "UPDATE"] {
                try exec(db, """
                    CREATE TRIGGER IF NOT EXISTS sync_delivery_dirty_\(event.lowercased()) AFTER \(event) ON sync_dirty_records
                    WHEN NEW.record_type IN (\(types)) BEGIN
                      INSERT INTO sync_delivery_heads VALUES(NEW.record_type,NEW.record_id,1,lower(hex(randomblob(16))))
                        ON CONFLICT(record_type,record_id) DO UPDATE SET revision=revision+1,change_id=lower(hex(randomblob(16)));
                      INSERT INTO sync_delivery_tickets(destination,record_type,record_id,revision,change_id,operation,updated_at,priority,failure)
                        SELECT d.id,NEW.record_type,NEW.record_id,h.revision,h.change_id,NEW.operation,CASE WHEN NEW.created_at>0 THEN NEW.created_at ELSE CAST(strftime('%s','now') AS REAL) END,NEW.priority,NULL
                        FROM sync_delivery_destinations d JOIN sync_delivery_heads h ON h.record_type=NEW.record_type AND h.record_id=NEW.record_id WHERE 1
                        ON CONFLICT(destination,record_type,record_id) DO UPDATE SET revision=excluded.revision,change_id=excluded.change_id,operation=excluded.operation,updated_at=excluded.updated_at,priority=excluded.priority,failure=NULL;
                    END;
                    """)
            }
            try exec(db, """
                CREATE TRIGGER IF NOT EXISTS sync_delivery_dirty_cancel AFTER DELETE ON sync_dirty_records BEGIN
                  DELETE FROM sync_delivery_tickets WHERE record_type=OLD.record_type AND record_id=OLD.record_id;
                  DELETE FROM sync_delivery_payloads WHERE record_type=OLD.record_type AND record_id=OLD.record_id;
                END;
                INSERT OR IGNORE INTO sync_delivery_heads SELECT record_type,record_id,1,lower(hex(randomblob(16))) FROM sync_dirty_records WHERE record_type IN (\(types));
                INSERT OR IGNORE INTO sync_delivery_tickets(destination,record_type,record_id,revision,change_id,operation,updated_at,priority)
                  SELECT 'iCloud',r.record_type,r.record_id,h.revision,h.change_id,r.operation,CASE WHEN r.created_at>0 THEN r.created_at ELSE CAST(strftime('%s','now') AS REAL) END,r.priority
                  FROM sync_dirty_records r JOIN sync_delivery_heads h USING(record_type,record_id) WHERE NOT EXISTS(SELECT 1 FROM sync_delivery_meta WHERE key='legacy-seeded');
                INSERT OR IGNORE INTO sync_delivery_meta VALUES ('legacy-seeded');
                """)
        }
    }

    /// Disable pauses delivery, not collection: known destinations retain new
    /// revisions while offline/disabled. A newly added destination seeds dirty
    /// records only; the caller separately requests historical snapshot staging.
    static func configure(_ db: OpaquePointer?, enabled: Set<String>) throws {
        try transaction(db) {
            try exec(db, "UPDATE sync_delivery_destinations SET enabled=0")
            for id in enabled.sorted() {
                try run(db, "INSERT OR IGNORE INTO sync_delivery_destinations VALUES (?,1)", [id])
                let isNew = sqlite3_changes(db) > 0
                try run(db, "UPDATE sync_delivery_destinations SET enabled=1 WHERE id=?", [id])
                guard isNew else { continue }
                try run(db, """
                    INSERT OR IGNORE INTO sync_delivery_tickets(destination,record_type,record_id,revision,change_id,operation,updated_at,priority)
                    SELECT ?,r.record_type,r.record_id,h.revision,h.change_id,r.operation,CASE WHEN r.created_at>0 THEN r.created_at ELSE CAST(strftime('%s','now') AS REAL) END,r.priority
                    FROM sync_dirty_records r JOIN sync_delivery_heads h USING(record_type,record_id)
                    """, [id])
            }
        }
    }

    /// Forget replica destinations the user turned off or replaced: their tickets
    /// would otherwise pin every dirty row forever. Returns the purged names so
    /// the caller can reset their seed state (a later re-enable reseeds).
    @discardableResult
    static func purge(_ db: OpaquePointer?, prefix: String, keeping: Set<String>) throws -> [String] {
        var purged: [String] = []
        try transaction(db) {
            let stmt = try prepare(db, "SELECT id FROM sync_delivery_destinations WHERE substr(id,1,?)=?")
            defer { sqlite3_finalize(stmt) }
            sqlite3_bind_int(stmt, 1, Int32(prefix.utf8.count)); bind(stmt, 2, prefix)
            while sqlite3_step(stmt) == SQLITE_ROW {
                let id = text(stmt, 0)
                if !keeping.contains(id) { purged.append(id) }
            }
            guard !purged.isEmpty else { return }
            for id in purged {
                try run(db, "DELETE FROM sync_delivery_tickets WHERE destination=?", [id])
                try run(db, "DELETE FROM sync_delivery_destinations WHERE id=?", [id])
            }
            // Rows every remaining destination already acknowledged.
            try exec(db, """
                DELETE FROM sync_dirty_records WHERE EXISTS(SELECT 1 FROM sync_delivery_heads h WHERE h.record_type=sync_dirty_records.record_type AND h.record_id=sync_dirty_records.record_id)
                  AND NOT EXISTS(SELECT 1 FROM sync_delivery_tickets t WHERE t.record_type=sync_dirty_records.record_type AND t.record_id=sync_dirty_records.record_id);
                DELETE FROM sync_delivery_payloads WHERE NOT EXISTS(SELECT 1 FROM sync_delivery_tickets t WHERE t.record_type=sync_delivery_payloads.record_type
                  AND t.record_id=sync_delivery_payloads.record_id AND t.revision=sync_delivery_payloads.revision);
                """)
        }
        return purged
    }

    /// Queue one record for ONE destination without touching the shared dirty
    /// table: seeding a new or rebuilt replica must never re-push history to iCloud.
    /// Uses the record's current head revision; a later local edit supersedes it.
    static func seed(_ db: OpaquePointer?, destination: String, recordType: String, recordId: String) throws {
        try transaction(db) {
            try run(db, "INSERT OR IGNORE INTO sync_delivery_heads VALUES(?,?,1,lower(hex(randomblob(16))))", [recordType, recordId])
            try run(db, """
                INSERT OR IGNORE INTO sync_delivery_tickets(destination,record_type,record_id,revision,change_id,operation,updated_at,priority)
                SELECT ?,h.record_type,h.record_id,h.revision,h.change_id,'upsert',CAST(strftime('%s','now') AS REAL),1
                FROM sync_delivery_heads h WHERE h.record_type=? AND h.record_id=?
                """, [destination, recordType, recordId])
        }
    }

    static func load(_ db: OpaquePointer?, destination: String, limit: Int = 100, excludingTypes: Set<String> = []) throws -> [SyncDeliveryTicket] {
        let excluded = excludingTypes.sorted()
        let clause = excluded.isEmpty ? "" : " AND t.record_type NOT IN (" + Array(repeating: "?", count: excluded.count).joined(separator: ",") + ")"
        let stmt = try prepare(db, """
            SELECT t.destination,t.record_type,t.record_id,t.revision,t.change_id,t.operation,t.updated_at
            FROM sync_delivery_tickets t JOIN sync_delivery_destinations d ON d.id=t.destination
            WHERE t.destination=? AND d.enabled=1 AND t.failure IS NULL\(clause)
            ORDER BY t.priority,CASE t.record_type WHEN 'SessionV2' THEN 0 WHEN 'MessageV2' THEN 1 ELSE 2 END,t.updated_at DESC LIMIT ?
            """)
        defer { sqlite3_finalize(stmt) }
        bind(stmt, 1, destination)
        for (index, type) in excluded.enumerated() { bind(stmt, Int32(index + 2), type) }
        sqlite3_bind_int(stmt, Int32(excluded.count + 2), Int32(max(1, min(limit, 100))))
        var result: [SyncDeliveryTicket] = []
        while sqlite3_step(stmt) == SQLITE_ROW {
            result.append(SyncDeliveryTicket(destination: text(stmt, 0), recordType: text(stmt, 1), recordId: text(stmt, 2), revision: sqlite3_column_int64(stmt, 3), changeId: text(stmt, 4), operation: text(stmt, 5), updatedAt: Date(timeIntervalSince1970: sqlite3_column_double(stmt, 6))))
        }
        return result
    }

    static func acknowledge(_ db: OpaquePointer?, ticket: SyncDeliveryTicket) throws {
        try transaction(db) {
            try ticketRun(db, "DELETE FROM sync_delivery_tickets WHERE destination=? AND record_type=? AND record_id=? AND revision=? AND change_id=?", ticket)
            guard sqlite3_changes(db) > 0 else { return }
            // 旧 revision 回执不能清除新编辑；其他目的地未确认时保留兼容 dirty 行。
            let stmt = try prepare(db, """
                DELETE FROM sync_dirty_records WHERE record_type=? AND record_id=?
                AND EXISTS(SELECT 1 FROM sync_delivery_heads h WHERE h.record_type=sync_dirty_records.record_type AND h.record_id=sync_dirty_records.record_id AND h.revision=?)
                AND NOT EXISTS(SELECT 1 FROM sync_delivery_tickets t WHERE t.record_type=sync_dirty_records.record_type AND t.record_id=sync_dirty_records.record_id)
                """)
            defer { sqlite3_finalize(stmt) }
            bind(stmt, 1, ticket.recordType); bind(stmt, 2, ticket.recordId); sqlite3_bind_int64(stmt, 3, ticket.revision)
            try step(db, stmt)
            // Frozen bytes no ticket references any more. Seeded tickets have no
            // dirty row, so the dirty-delete trigger would never reclaim them.
            try run(db, """
                DELETE FROM sync_delivery_payloads WHERE record_type=? AND record_id=?
                AND NOT EXISTS(SELECT 1 FROM sync_delivery_tickets t WHERE t.record_type=sync_delivery_payloads.record_type
                  AND t.record_id=sync_delivery_payloads.record_id AND t.revision=sync_delivery_payloads.revision)
                """, [ticket.recordType, ticket.recordId])
        }
    }

    static func fail(_ db: OpaquePointer?, ticket: SyncDeliveryTicket, reason: String) throws {
        let stmt = try prepare(db, "UPDATE sync_delivery_tickets SET failure=? WHERE destination=? AND record_type=? AND record_id=? AND revision=? AND change_id=?")
        defer { sqlite3_finalize(stmt) }
        bind(stmt, 1, String(reason.prefix(512))); bindTicket(stmt, ticket, start: 2); try step(db, stmt)
    }
    static func activeChangeIDs(_ db: OpaquePointer?) throws -> Set<String> {
        let stmt = try prepare(db, "SELECT DISTINCT change_id FROM sync_delivery_tickets")
        defer { sqlite3_finalize(stmt) }; var result = Set<String>()
        while sqlite3_step(stmt) == SQLITE_ROW { result.insert(text(stmt, 0)) }
        return result
    }
    static func failures(_ db: OpaquePointer?, limit: Int = 100) throws -> [(destination: String, recordType: String, recordId: String, reason: String)] {
        let stmt = try prepare(db, "SELECT destination,record_type,record_id,failure FROM sync_delivery_tickets WHERE failure IS NOT NULL ORDER BY updated_at DESC LIMIT ?")
        defer { sqlite3_finalize(stmt) }; sqlite3_bind_int(stmt, 1, Int32(max(1, min(limit, 100))))
        var result: [(destination: String, recordType: String, recordId: String, reason: String)] = []
        while sqlite3_step(stmt) == SQLITE_ROW { result.append((text(stmt, 0), text(stmt, 1), text(stmt, 2), text(stmt, 3))) }
        return result
    }
    static func retryFailures(_ db: OpaquePointer?) throws { try exec(db, "UPDATE sync_delivery_tickets SET failure=NULL") }
    static func count(_ db: OpaquePointer?, enabledOnly: Bool = true, includeBlocked: Bool = false) throws -> Int {
        let stmt = try prepare(db, "SELECT COUNT(*) FROM sync_delivery_tickets t JOIN sync_delivery_destinations d ON d.id=t.destination WHERE \(enabledOnly ? "d.enabled=1" : "1") AND \(includeBlocked ? "1" : "t.failure IS NULL")")
        defer { sqlite3_finalize(stmt) }
        guard sqlite3_step(stmt) == SQLITE_ROW else { return 0 }
        return Int(sqlite3_column_int64(stmt, 0))
    }
    static func isCurrent(_ db: OpaquePointer?, ticket: SyncDeliveryTicket) throws -> Bool {
        let stmt = try prepare(db, "SELECT 1 FROM sync_delivery_tickets WHERE destination=? AND record_type=? AND record_id=? AND revision=? AND change_id=?")
        defer { sqlite3_finalize(stmt) }; bindTicket(stmt, ticket)
        return sqlite3_step(stmt) == SQLITE_ROW
    }
    static func payload(_ db: OpaquePointer?, ticket: SyncDeliveryTicket) throws -> Data? {
        let stmt = try prepare(db, "SELECT payload FROM sync_delivery_payloads WHERE record_type=? AND record_id=? AND revision=?")
        defer { sqlite3_finalize(stmt) }; bind(stmt, 1, ticket.recordType); bind(stmt, 2, ticket.recordId); sqlite3_bind_int64(stmt, 3, ticket.revision)
        guard sqlite3_step(stmt) == SQLITE_ROW, let bytes = sqlite3_column_blob(stmt, 0) else { return nil }
        return Data(bytes: bytes, count: Int(sqlite3_column_bytes(stmt, 0)))
    }
    static func freeze(_ db: OpaquePointer?, ticket: SyncDeliveryTicket, payload: Data) throws -> Bool {
        try transaction(db) {
            guard try isCurrent(db, ticket: ticket) else { return false }
            let stmt = try prepare(db, "INSERT OR IGNORE INTO sync_delivery_payloads VALUES (?,?,?,?)")
            defer { sqlite3_finalize(stmt) }; bind(stmt, 1, ticket.recordType); bind(stmt, 2, ticket.recordId); sqlite3_bind_int64(stmt, 3, ticket.revision)
            _ = payload.withUnsafeBytes { sqlite3_bind_blob(stmt, 4, $0.baseAddress, Int32($0.count), unsafeBitCast(-1, to: sqlite3_destructor_type.self)) }
            try step(db, stmt); return true
        }
    }

    private static func ticketRun(_ db: OpaquePointer?, _ sql: String, _ ticket: SyncDeliveryTicket) throws {
        let stmt = try prepare(db, sql); defer { sqlite3_finalize(stmt) }; bindTicket(stmt, ticket); try step(db, stmt)
    }
    private static func bindTicket(_ stmt: OpaquePointer?, _ ticket: SyncDeliveryTicket, start: Int32 = 1) {
        bind(stmt, start, ticket.destination); bind(stmt, start+1, ticket.recordType); bind(stmt, start+2, ticket.recordId); sqlite3_bind_int64(stmt, start+3, ticket.revision); bind(stmt, start+4, ticket.changeId)
    }
    private static func run(_ db: OpaquePointer?, _ sql: String, _ values: [String]) throws {
        let stmt = try prepare(db, sql); defer { sqlite3_finalize(stmt) }
        for (index, value) in values.enumerated() { bind(stmt, Int32(index + 1), value) }; try step(db, stmt)
    }
    private static func prepare(_ db: OpaquePointer?, _ sql: String) throws -> OpaquePointer? {
        var stmt: OpaquePointer?; let code = sqlite3_prepare_v2(db, sql, -1, &stmt, nil)
        guard code == SQLITE_OK else { throw LedgerError.sqlite(code, String(cString: sqlite3_errmsg(db))) }; return stmt
    }
    private static func step(_ db: OpaquePointer?, _ stmt: OpaquePointer?) throws { let code = sqlite3_step(stmt); guard code == SQLITE_DONE else { throw LedgerError.sqlite(code, String(cString: sqlite3_errmsg(db))) } }
    private static func exec(_ db: OpaquePointer?, _ sql: String) throws { let code = sqlite3_exec(db, sql, nil, nil, nil); guard code == SQLITE_OK else { throw LedgerError.sqlite(code, String(cString: sqlite3_errmsg(db))) } }
    private static func transaction<T>(_ db: OpaquePointer?, _ body: () throws -> T) throws -> T {
        try exec(db, "SAVEPOINT sync_delivery")
        do { let value = try body(); try exec(db, "RELEASE sync_delivery"); return value }
        catch { try? exec(db, "ROLLBACK TO sync_delivery"); try? exec(db, "RELEASE sync_delivery"); throw error }
    }
    private static func text(_ stmt: OpaquePointer?, _ index: Int32) -> String { String(cString: sqlite3_column_text(stmt, index)) }
    private static func bind(_ stmt: OpaquePointer?, _ index: Int32, _ value: String) { _ = value.withCString { sqlite3_bind_text(stmt, index, $0, -1, unsafeBitCast(-1, to: sqlite3_destructor_type.self)) } }
}
