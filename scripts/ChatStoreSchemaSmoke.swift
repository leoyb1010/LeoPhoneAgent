import Foundation
import SQLite3

private enum SmokeFailure: Error, CustomStringConvertible {
    case assertion(String)

    var description: String {
        switch self {
        case .assertion(let message): return message
        }
    }
}

@main
enum ChatStoreSchemaSmoke {
    static func main() throws {
        try freshDatabase()
        try legacyMigration()
        try idempotentMigration()
        try incompleteSchemaDetection()
        print("ChatStoreSchemaSmoke: 4/4 passed")
    }

    private static func freshDatabase() throws {
        try withDatabase { db in
            let report = try ChatStoreSchemaContract.migrate(db)
            try expect(report.previousVersion == 0, "fresh previous version")
            try expect(report.currentVersion == 1, "fresh current version")
            try expect(ChatStoreSchemaContract.validate(db).isEmpty, "fresh validation")
        }
    }

    private static func legacyMigration() throws {
        try withDatabase { db in
            try execute(db, "CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT, model_id TEXT NOT NULL, created_at REAL NOT NULL, updated_at REAL NOT NULL)")
            try execute(db, "CREATE TABLE messages (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, role TEXT NOT NULL, parts_json TEXT NOT NULL, created_at REAL NOT NULL, token_usage TEXT, sort_order INTEGER NOT NULL)")
            try execute(db, "CREATE TABLE compact_markers (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, summary TEXT NOT NULL, first_kept_sort_order INTEGER NOT NULL, compacted_count INTEGER NOT NULL, created_at REAL NOT NULL)")
            try execute(db, "INSERT INTO sessions VALUES ('s1', 'Legacy', 'model', 10, 11)")
            try execute(db, "INSERT INTO messages VALUES ('m1', 's1', 'user', '[{\"type\":\"text\",\"value\":\"hello\"}]', 12, NULL, 0)")

            let report = try ChatStoreSchemaContract.migrate(db)
            try expect(report.addedColumns.contains("sessions.memory_enabled"), "legacy session column repair")
            try expect(report.addedColumns.contains("messages.part_flags"), "legacy message column repair")
            try expect(try scalar(db, "SELECT COUNT(*) FROM sessions WHERE id='s1'") == 1, "legacy row preserved")
            try expect(try scalar(db, "SELECT part_flags FROM messages WHERE id='m1'") == 1, "part flags backfilled")
            try expect(try scalar(db, "SELECT CAST(updated_at AS INTEGER) FROM messages WHERE id='m1'") == 12, "updated_at backfilled")
        }
    }

    private static func idempotentMigration() throws {
        try withDatabase { db in
            _ = try ChatStoreSchemaContract.migrate(db)
            let second = try ChatStoreSchemaContract.migrate(db)
            try expect(second.previousVersion == 1, "idempotent version")
            try expect(second.addedColumns.isEmpty, "idempotent no-op")
        }
    }

    private static func incompleteSchemaDetection() throws {
        try withDatabase { db in
            try execute(db, "CREATE TABLE sessions (id TEXT PRIMARY KEY)")
            let issues = ChatStoreSchemaContract.validate(db)
            try expect(issues.contains("missing table messages"), "missing table detection")
            try expect(issues.contains("missing column sessions.model_id"), "missing column detection")
        }
    }

    private static func withDatabase(_ body: (OpaquePointer) throws -> Void) throws {
        var db: OpaquePointer?
        guard sqlite3_open(":memory:", &db) == SQLITE_OK, let db else {
            throw SmokeFailure.assertion("could not open in-memory SQLite")
        }
        defer { sqlite3_close(db) }
        try body(db)
    }

    private static func execute(_ db: OpaquePointer, _ sql: String) throws {
        guard sqlite3_exec(db, sql, nil, nil, nil) == SQLITE_OK else {
            throw SmokeFailure.assertion(String(cString: sqlite3_errmsg(db)))
        }
    }

    private static func scalar(_ db: OpaquePointer, _ sql: String) throws -> Int {
        var statement: OpaquePointer?
        defer { sqlite3_finalize(statement) }
        guard sqlite3_prepare_v2(db, sql, -1, &statement, nil) == SQLITE_OK,
              sqlite3_step(statement) == SQLITE_ROW
        else { throw SmokeFailure.assertion(String(cString: sqlite3_errmsg(db))) }
        return Int(sqlite3_column_int64(statement, 0))
    }

    private static func expect(_ condition: @autoclosure () throws -> Bool, _ message: String) throws {
        guard try condition() else { throw SmokeFailure.assertion("failed: \(message)") }
    }
}
