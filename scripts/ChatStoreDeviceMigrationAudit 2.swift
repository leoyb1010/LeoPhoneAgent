import Foundation
import SQLite3

private enum AuditFailure: Error, CustomStringConvertible {
    case usage
    case sqlite(String)
    case assertion(String)

    var description: String {
        switch self {
        case .usage:
            return "usage: ChatStoreDeviceMigrationAudit <path-to-private-database-copy>"
        case .sqlite(let message):
            return "SQLite error: \(message)"
        case .assertion(let message):
            return "migration audit failed: \(message)"
        }
    }
}

@main
enum ChatStoreDeviceMigrationAudit {
    static func main() throws {
        guard CommandLine.arguments.count == 2 else { throw AuditFailure.usage }
        let databasePath = CommandLine.arguments[1]

        var db: OpaquePointer?
        guard sqlite3_open_v2(databasePath, &db, SQLITE_OPEN_READWRITE, nil) == SQLITE_OK,
              let db
        else {
            defer { if db != nil { sqlite3_close(db) } }
            throw AuditFailure.sqlite(db.map { String(cString: sqlite3_errmsg($0)) } ?? "could not open database")
        }
        defer { sqlite3_close(db) }

        try expect(try text(db, "PRAGMA integrity_check") == "ok", "pre-migration integrity check")
        let before = try durableRowCounts(db)

        let report = try ChatStoreSchemaContract.migrate(db)
        try expect(ChatStoreSchemaContract.validate(db).isEmpty, "schema contract validation")
        try expect(try text(db, "PRAGMA integrity_check") == "ok", "post-migration integrity check")
        try expect(try scalar(db, "PRAGMA foreign_key_check") == nil, "foreign-key check")
        try expect(try durableRowCounts(db) == before, "durable row counts changed")

        let second = try ChatStoreSchemaContract.migrate(db)
        try expect(second.addedColumns.isEmpty, "second migration was not idempotent")
        try expect(try durableRowCounts(db) == before, "second migration changed durable row counts")

        let sessionCount = before["sessions"] ?? 0
        let messageCount = before["messages"] ?? 0
        let compactMarkerCount = before["compact_markers"] ?? 0
        print("ChatStoreDeviceMigrationAudit: passed")
        print("contract: \(report.previousVersion) -> \(report.currentVersion); repaired columns: \(report.addedColumns.count)")
        print("preserved rows: sessions=\(sessionCount), messages=\(messageCount), compact_markers=\(compactMarkerCount)")
    }

    private static func durableRowCounts(_ db: OpaquePointer) throws -> [String: Int] {
        var result: [String: Int] = [:]
        for table in ["sessions", "messages", "compact_markers"] {
            result[table] = try tableExists(db, table) ? (try scalar(db, "SELECT COUNT(*) FROM \(table)") ?? 0) : 0
        }
        return result
    }

    private static func tableExists(_ db: OpaquePointer, _ table: String) throws -> Bool {
        var statement: OpaquePointer?
        defer { sqlite3_finalize(statement) }
        let sql = "SELECT 1 FROM sqlite_master WHERE type='table' AND name='\(table)' LIMIT 1"
        guard sqlite3_prepare_v2(db, sql, -1, &statement, nil) == SQLITE_OK else {
            throw AuditFailure.sqlite(String(cString: sqlite3_errmsg(db)))
        }
        return sqlite3_step(statement) == SQLITE_ROW
    }

    private static func scalar(_ db: OpaquePointer, _ sql: String) throws -> Int? {
        var statement: OpaquePointer?
        defer { sqlite3_finalize(statement) }
        guard sqlite3_prepare_v2(db, sql, -1, &statement, nil) == SQLITE_OK else {
            throw AuditFailure.sqlite(String(cString: sqlite3_errmsg(db)))
        }
        let result = sqlite3_step(statement)
        if result == SQLITE_DONE { return nil }
        guard result == SQLITE_ROW else { throw AuditFailure.sqlite(String(cString: sqlite3_errmsg(db))) }
        return Int(sqlite3_column_int64(statement, 0))
    }

    private static func text(_ db: OpaquePointer, _ sql: String) throws -> String {
        var statement: OpaquePointer?
        defer { sqlite3_finalize(statement) }
        guard sqlite3_prepare_v2(db, sql, -1, &statement, nil) == SQLITE_OK,
              sqlite3_step(statement) == SQLITE_ROW,
              let value = sqlite3_column_text(statement, 0)
        else { throw AuditFailure.sqlite(String(cString: sqlite3_errmsg(db))) }
        return String(cString: value)
    }

    private static func expect(_ condition: @autoclosure () throws -> Bool, _ message: String) throws {
        guard try condition() else { throw AuditFailure.assertion(message) }
    }
}
