import SQLite3
import XCTest

final class ChatStoreSchemaContractTests: XCTestCase {
    func testFreshDatabaseCreatesValidatedContract() throws {
        let db = try openTemporaryDatabase()
        defer { sqlite3_close(db) }

        let report = try ChatStoreSchemaContract.migrate(db)

        XCTAssertEqual(report.previousVersion, 0)
        XCTAssertEqual(report.currentVersion, ChatStoreSchemaContract.currentVersion)
        XCTAssertTrue(report.addedColumns.contains("sessions.memory_enabled"))
        XCTAssertTrue(report.addedColumns.contains("messages.part_flags"))
        XCTAssertEqual(ChatStoreSchemaContract.readContractVersion(db), 1)
        XCTAssertEqual(ChatStoreSchemaContract.validate(db), [])
    }

    func testLegacyDatabaseMigrationPreservesRowsAndBackfillsDerivedFields() throws {
        let db = try openTemporaryDatabase()
        defer { sqlite3_close(db) }
        try execute(db, "CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT, model_id TEXT NOT NULL, created_at REAL NOT NULL, updated_at REAL NOT NULL)")
        try execute(db, "CREATE TABLE messages (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, role TEXT NOT NULL, parts_json TEXT NOT NULL, created_at REAL NOT NULL, token_usage TEXT, sort_order INTEGER NOT NULL)")
        try execute(db, "CREATE TABLE compact_markers (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, summary TEXT NOT NULL, first_kept_sort_order INTEGER NOT NULL, compacted_count INTEGER NOT NULL, created_at REAL NOT NULL)")
        try execute(db, "INSERT INTO sessions VALUES ('s1', 'Legacy', 'model', 10, 11)")
        try execute(db, "INSERT INTO messages VALUES ('m1', 's1', 'user', '[{\"type\":\"text\",\"value\":\"hello\"}]', 12, NULL, 0)")

        let report = try ChatStoreSchemaContract.migrate(db)

        XCTAssertTrue(report.addedColumns.contains("sessions.memory_enabled"))
        XCTAssertTrue(report.addedColumns.contains("messages.part_flags"))
        XCTAssertEqual(try scalarInt(db, "SELECT COUNT(*) FROM sessions WHERE id='s1'"), 1)
        XCTAssertEqual(try scalarInt(db, "SELECT part_flags FROM messages WHERE id='m1'"), 1)
        XCTAssertEqual(try scalarInt(db, "SELECT CAST(updated_at AS INTEGER) FROM messages WHERE id='m1'"), 12)
        XCTAssertEqual(ChatStoreSchemaContract.validate(db), [])
    }

    func testMigrationIsIdempotent() throws {
        let db = try openTemporaryDatabase()
        defer { sqlite3_close(db) }

        _ = try ChatStoreSchemaContract.migrate(db)
        let second = try ChatStoreSchemaContract.migrate(db)

        XCTAssertEqual(second.previousVersion, ChatStoreSchemaContract.currentVersion)
        XCTAssertTrue(second.addedColumns.isEmpty)
        XCTAssertEqual(ChatStoreSchemaContract.validate(db), [])
    }

    func testValidationReportsIncompleteSchemaBeforeMigration() throws {
        let db = try openTemporaryDatabase()
        defer { sqlite3_close(db) }
        try execute(db, "CREATE TABLE sessions (id TEXT PRIMARY KEY)")

        let issues = ChatStoreSchemaContract.validate(db)

        XCTAssertTrue(issues.contains("missing table messages"))
        XCTAssertTrue(issues.contains("missing column sessions.model_id"))
    }

    private func openTemporaryDatabase() throws -> OpaquePointer {
        var db: OpaquePointer?
        XCTAssertEqual(sqlite3_open(":memory:", &db), SQLITE_OK)
        guard let db else { throw ChatStoreSchemaContract.MigrationError.databaseUnavailable }
        return db
    }

    private func execute(_ db: OpaquePointer, _ sql: String) throws {
        guard sqlite3_exec(db, sql, nil, nil, nil) == SQLITE_OK else {
            throw ChatStoreSchemaContract.MigrationError.sql(String(cString: sqlite3_errmsg(db)))
        }
    }

    private func scalarInt(_ db: OpaquePointer, _ sql: String) throws -> Int {
        var statement: OpaquePointer?
        defer { sqlite3_finalize(statement) }
        guard sqlite3_prepare_v2(db, sql, -1, &statement, nil) == SQLITE_OK,
              sqlite3_step(statement) == SQLITE_ROW
        else {
            throw ChatStoreSchemaContract.MigrationError.sql(String(cString: sqlite3_errmsg(db)))
        }
        return Int(sqlite3_column_int64(statement, 0))
    }
}
