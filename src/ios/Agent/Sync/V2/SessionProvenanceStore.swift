import Foundation
import SQLite3

/// SQLite provenance is independent of transport and dirty/re-upload bookkeeping.
/// Nil is deliberate: legacy local rows do not prove where a session was created.
enum SessionProvenanceStore {
    struct Provenance {
        var origin: String?
        var writer: String?
    }

    enum MigrationError: Error { case sqlite(Int32) }

    static func migrate(_ db: OpaquePointer?) throws {
        var stmt: OpaquePointer?
        var columns = Set<String>()
        let prepared = sqlite3_prepare_v2(db, "PRAGMA table_info(sessions)", -1, &stmt, nil)
        guard prepared == SQLITE_OK else { throw MigrationError.sqlite(prepared) }
        while sqlite3_step(stmt) == SQLITE_ROW {
            if let value = sqlite3_column_text(stmt, 1) { columns.insert(String(cString: value)) }
        }
        sqlite3_finalize(stmt)
        for column in ["origin_device_id", "last_writer_device_id"] where !columns.contains(column) {
            let result = sqlite3_exec(db, "ALTER TABLE sessions ADD COLUMN \(column) TEXT", nil, nil, nil)
            guard result == SQLITE_OK else { throw MigrationError.sqlite(result) }
        }
        // Existing V1 remote ownership is actual evidence. Empty V2 sentinels are not.
        let result = sqlite3_exec(db, "UPDATE sessions SET origin_device_id = remote_origin_device_id WHERE origin_device_id IS NULL AND length(trim(remote_origin_device_id)) > 0", nil, nil, nil)
        guard result == SQLITE_OK else { throw MigrationError.sqlite(result) }
    }

    static func read(_ db: OpaquePointer?, id: String) -> Provenance {
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, "SELECT origin_device_id, last_writer_device_id FROM sessions WHERE id = ?", -1, &stmt, nil) == SQLITE_OK else { return Provenance() }
        defer { sqlite3_finalize(stmt) }
        bind(stmt, 1, id)
        guard sqlite3_step(stmt) == SQLITE_ROW else { return Provenance() }
        return Provenance(origin: sqlite3_column_text(stmt, 0).map { String(cString: $0) }, writer: sqlite3_column_text(stmt, 1).map { String(cString: $0) })
    }

    static func createdLocally(_ db: OpaquePointer?, id: String, deviceID: String) {
        merge(db, id: id, origin: deviceID, writer: deviceID, acceptsWriter: true)
    }

    static func editedLocally(_ db: OpaquePointer?, id: String, deviceID: String) {
        merge(db, id: id, origin: nil, writer: deviceID, acceptsWriter: true)
    }

    static func merge(_ db: OpaquePointer?, id: String, origin: String?, writer: String?, acceptsWriter: Bool) {
        var stmt: OpaquePointer?
        // Known creator survives later edits and unknown legacy peers. An accepted
        // newer legacy edit clears writer because its author cannot be established.
        let sql = "UPDATE sessions SET origin_device_id = COALESCE(NULLIF(origin_device_id, ''), ?), last_writer_device_id = CASE WHEN ? THEN ? ELSE last_writer_device_id END WHERE id = ?"
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return }
        defer { sqlite3_finalize(stmt) }
        bind(stmt, 1, normalized(origin))
        sqlite3_bind_int(stmt, 2, acceptsWriter ? 1 : 0)
        bind(stmt, 3, normalized(writer))
        bind(stmt, 4, id)
        sqlite3_step(stmt)
    }

    private static func normalized(_ value: String?) -> String? {
        guard let value, !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
        return value
    }

    private static func bind(_ stmt: OpaquePointer?, _ index: Int32, _ value: String?) {
        if let value {
            _ = value.withCString { sqlite3_bind_text(stmt, index, $0, -1, unsafeBitCast(-1, to: sqlite3_destructor_type.self)) }
        } else {
            sqlite3_bind_null(stmt, index)
        }
    }
}
