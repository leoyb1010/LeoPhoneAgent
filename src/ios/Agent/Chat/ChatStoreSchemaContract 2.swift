import Foundation
import SQLite3

/// Versioned, independently testable contract for the durable chat database.
///
/// `ChatStore` still owns its complete operational schema. This contract is the
/// safety gate shared by production and the hostless logic-test target: it
/// repairs the core tables older builds may lack, records the applied contract
/// version, and can prove that a database is safe before future Artifact tables
/// are introduced.
enum ChatStoreSchemaContract {
    static let currentVersion = 3

    struct Report: Equatable, Sendable {
        var previousVersion: Int
        var currentVersion: Int
        var addedColumns: [String]
    }

    enum MigrationError: Error, Equatable, CustomStringConvertible {
        case databaseUnavailable
        case sql(String)
        case invalidSchema([String])

        var description: String {
            switch self {
            case .databaseUnavailable:
                return "Chat database is unavailable."
            case .sql(let message):
                return "SQLite migration failed: \(message)"
            case .invalidSchema(let issues):
                return "Chat database schema is invalid: \(issues.joined(separator: ", "))"
            }
        }
    }

    private struct Column {
        let name: String
        let definition: String
    }

    private static let requiredColumns: [String: [Column]] = [
        "sessions": [
            Column(name: "id", definition: "TEXT PRIMARY KEY"),
            Column(name: "title", definition: "TEXT"),
            Column(name: "model_id", definition: "TEXT NOT NULL DEFAULT ''"),
            Column(name: "created_at", definition: "REAL NOT NULL DEFAULT 0"),
            Column(name: "updated_at", definition: "REAL NOT NULL DEFAULT 0"),
            Column(name: "category", definition: "TEXT"),
            Column(name: "model_binding", definition: "TEXT"),
            Column(name: "source", definition: "TEXT"),
            Column(name: "memory_enabled", definition: "INTEGER NOT NULL DEFAULT 1"),
            Column(name: "last_synced_at", definition: "REAL"),
            Column(name: "remote_origin_device_id", definition: "TEXT"),
            Column(name: "pinned_at", definition: "REAL"),
            Column(name: "remote_tombstoned_at", definition: "REAL"),
        ],
        "messages": [
            Column(name: "id", definition: "TEXT PRIMARY KEY"),
            Column(name: "session_id", definition: "TEXT NOT NULL"),
            Column(name: "role", definition: "TEXT NOT NULL DEFAULT 'user'"),
            Column(name: "parts_json", definition: "TEXT NOT NULL DEFAULT '[]'"),
            Column(name: "created_at", definition: "REAL NOT NULL DEFAULT 0"),
            Column(name: "token_usage", definition: "TEXT"),
            Column(name: "sort_order", definition: "INTEGER NOT NULL DEFAULT 0"),
            Column(name: "reasoning_content", definition: "TEXT"),
            Column(name: "stream_interrupt_count", definition: "INTEGER NOT NULL DEFAULT 0"),
            Column(name: "updated_at", definition: "REAL"),
            Column(name: "error_info", definition: "TEXT"),
            Column(name: "part_flags", definition: "INTEGER NOT NULL DEFAULT 0"),
        ],
        "compact_markers": [
            Column(name: "id", definition: "TEXT PRIMARY KEY"),
            Column(name: "session_id", definition: "TEXT NOT NULL"),
            Column(name: "summary", definition: "TEXT NOT NULL DEFAULT ''"),
            Column(name: "first_kept_sort_order", definition: "INTEGER NOT NULL DEFAULT 0"),
            Column(name: "compacted_count", definition: "INTEGER NOT NULL DEFAULT 0"),
            Column(name: "created_at", definition: "REAL NOT NULL DEFAULT 0"),
            Column(name: "ui_boundary_sort_order", definition: "INTEGER"),
            Column(name: "boundary_message_id", definition: "TEXT"),
            Column(name: "first_kept_message_id", definition: "TEXT"),
            Column(name: "last_compacted_message_id", definition: "TEXT"),
            Column(name: "version", definition: "INTEGER NOT NULL DEFAULT 1"),
        ],
        "artifacts": [
            Column(name: "id", definition: "TEXT PRIMARY KEY"),
            Column(name: "session_id", definition: "TEXT NOT NULL"),
            Column(name: "source_message_id", definition: "TEXT"),
            Column(name: "source_path", definition: "TEXT"),
            Column(name: "title", definition: "TEXT NOT NULL DEFAULT ''"),
            Column(name: "kind", definition: "TEXT NOT NULL DEFAULT 'file'"),
            Column(name: "mime_type", definition: "TEXT NOT NULL DEFAULT 'application/octet-stream'"),
            Column(name: "current_version_id", definition: "TEXT"),
            Column(name: "created_at", definition: "REAL NOT NULL DEFAULT 0"),
            Column(name: "updated_at", definition: "REAL NOT NULL DEFAULT 0"),
            Column(name: "trashed_at", definition: "REAL"),
        ],
        "artifact_versions": [
            Column(name: "id", definition: "TEXT PRIMARY KEY"),
            Column(name: "artifact_id", definition: "TEXT NOT NULL"),
            Column(name: "version_number", definition: "INTEGER NOT NULL DEFAULT 1"),
            Column(name: "original_file_name", definition: "TEXT NOT NULL DEFAULT ''"),
            Column(name: "relative_path", definition: "TEXT NOT NULL DEFAULT ''"),
            Column(name: "byte_count", definition: "INTEGER NOT NULL DEFAULT 0"),
            Column(name: "sha256", definition: "TEXT NOT NULL DEFAULT ''"),
            Column(name: "created_at", definition: "REAL NOT NULL DEFAULT 0"),
        ],
    ]

    @discardableResult
    static func migrate(_ db: OpaquePointer?) throws -> Report {
        guard let db else { throw MigrationError.databaseUnavailable }
        try execute(db, "BEGIN IMMEDIATE TRANSACTION")
        do {
            try execute(db, """
                CREATE TABLE IF NOT EXISTS chat_store_schema_meta (
                    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
                    contract_version INTEGER NOT NULL,
                    updated_at REAL NOT NULL
                )
            """)

            let previousVersion = readContractVersion(db)
            try createCoreTables(db)
            try createArtifactTables(db)

            var addedColumns: [String] = []
            for table in requiredColumns.keys.sorted() {
                for column in requiredColumns[table] ?? [] where !columnExists(db, table: table, column: column.name) {
                    try execute(db, "ALTER TABLE \(quoted(table)) ADD COLUMN \(quoted(column.name)) \(column.definition)")
                    addedColumns.append("\(table).\(column.name)")
                }
            }

            try execute(db, "CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, sort_order)")
            try execute(db, "CREATE INDEX IF NOT EXISTS idx_msg_sess_role_sort ON messages(session_id, role, sort_order DESC)")
            try execute(db, "CREATE INDEX IF NOT EXISTS idx_compact_markers_session ON compact_markers(session_id, created_at)")
            try execute(db, "CREATE INDEX IF NOT EXISTS idx_compact_markers_first_kept ON compact_markers(session_id, first_kept_message_id)")
            try execute(db, "CREATE INDEX IF NOT EXISTS idx_artifacts_session_updated ON artifacts(session_id, trashed_at, updated_at DESC)")
            try execute(db, "CREATE UNIQUE INDEX IF NOT EXISTS idx_artifacts_source_path ON artifacts(session_id, source_path) WHERE source_path IS NOT NULL")
            try execute(db, "CREATE UNIQUE INDEX IF NOT EXISTS idx_artifact_versions_number ON artifact_versions(artifact_id, version_number)")

            // Preserve legacy timestamps and derive the local preview flags.
            try execute(db, "UPDATE messages SET updated_at = created_at WHERE updated_at IS NULL")
            try execute(db, """
                UPDATE messages
                   SET part_flags =
                       (CASE WHEN parts_json LIKE '%"type":"text"%' THEN 1 ELSE 0 END) |
                       (CASE WHEN parts_json LIKE '%"type":"toolUse"%' THEN 2 ELSE 0 END)
                 WHERE part_flags = 0
            """)

            let issues = validate(db)
            guard issues.isEmpty else { throw MigrationError.invalidSchema(issues) }

            let now = Date().timeIntervalSince1970
            try execute(db, """
                INSERT INTO chat_store_schema_meta (singleton, contract_version, updated_at)
                VALUES (1, \(currentVersion), \(now))
                ON CONFLICT(singleton) DO UPDATE SET
                    contract_version = excluded.contract_version,
                    updated_at = excluded.updated_at
            """)
            try execute(db, "COMMIT")
            return Report(
                previousVersion: previousVersion,
                currentVersion: currentVersion,
                addedColumns: addedColumns
            )
        } catch {
            _ = sqlite3_exec(db, "ROLLBACK", nil, nil, nil)
            throw error
        }
    }

    /// Returns concrete missing-table / missing-column issues. An empty result
    /// is the release gate used before Artifact migrations are allowed.
    static func validate(_ db: OpaquePointer?) -> [String] {
        guard let db else { return ["database unavailable"] }
        var issues: [String] = []
        for table in requiredColumns.keys.sorted() {
            guard tableExists(db, table: table) else {
                issues.append("missing table \(table)")
                continue
            }
            for column in requiredColumns[table] ?? [] where !columnExists(db, table: table, column: column.name) {
                issues.append("missing column \(table).\(column.name)")
            }
        }
        return issues
    }

    static func readContractVersion(_ db: OpaquePointer?) -> Int {
        guard let db, tableExists(db, table: "chat_store_schema_meta") else { return 0 }
        var statement: OpaquePointer?
        defer { sqlite3_finalize(statement) }
        guard sqlite3_prepare_v2(db, "SELECT contract_version FROM chat_store_schema_meta WHERE singleton = 1", -1, &statement, nil) == SQLITE_OK,
              sqlite3_step(statement) == SQLITE_ROW
        else { return 0 }
        return Int(sqlite3_column_int64(statement, 0))
    }

    private static func createCoreTables(_ db: OpaquePointer) throws {
        try execute(db, """
            CREATE TABLE IF NOT EXISTS sessions (
                id TEXT PRIMARY KEY,
                title TEXT,
                model_id TEXT NOT NULL,
                created_at REAL NOT NULL,
                updated_at REAL NOT NULL
            )
        """)
        try execute(db, """
            CREATE TABLE IF NOT EXISTS messages (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL REFERENCES sessions(id),
                role TEXT NOT NULL,
                parts_json TEXT NOT NULL,
                created_at REAL NOT NULL,
                token_usage TEXT,
                sort_order INTEGER NOT NULL
            )
        """)
        try execute(db, """
            CREATE TABLE IF NOT EXISTS compact_markers (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL REFERENCES sessions(id),
                summary TEXT NOT NULL,
                first_kept_sort_order INTEGER NOT NULL,
                compacted_count INTEGER NOT NULL,
                created_at REAL NOT NULL,
                ui_boundary_sort_order INTEGER
            )
        """)
    }

    private static func createArtifactTables(_ db: OpaquePointer) throws {
        try execute(db, """
            CREATE TABLE IF NOT EXISTS artifacts (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                source_message_id TEXT,
                source_path TEXT,
                title TEXT NOT NULL,
                kind TEXT NOT NULL,
                mime_type TEXT NOT NULL,
                current_version_id TEXT,
                created_at REAL NOT NULL,
                updated_at REAL NOT NULL,
                trashed_at REAL
            )
        """)
        try execute(db, """
            CREATE TABLE IF NOT EXISTS artifact_versions (
                id TEXT PRIMARY KEY,
                artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
                version_number INTEGER NOT NULL,
                original_file_name TEXT NOT NULL,
                relative_path TEXT NOT NULL,
                byte_count INTEGER NOT NULL,
                sha256 TEXT NOT NULL,
                created_at REAL NOT NULL
            )
        """)
    }

    private static func execute(_ db: OpaquePointer, _ sql: String) throws {
        var errorMessage: UnsafeMutablePointer<CChar>?
        let result = sqlite3_exec(db, sql, nil, nil, &errorMessage)
        guard result == SQLITE_OK else {
            let message = errorMessage.map { String(cString: $0) } ?? String(cString: sqlite3_errmsg(db))
            sqlite3_free(errorMessage)
            throw MigrationError.sql(message)
        }
    }

    private static func tableExists(_ db: OpaquePointer, table: String) -> Bool {
        var statement: OpaquePointer?
        defer { sqlite3_finalize(statement) }
        guard sqlite3_prepare_v2(db, "SELECT 1 FROM sqlite_master WHERE type='table' AND name=? LIMIT 1", -1, &statement, nil) == SQLITE_OK else { return false }
        sqlite3_bind_text(statement, 1, (table as NSString).utf8String, -1, nil)
        return sqlite3_step(statement) == SQLITE_ROW
    }

    private static func columnExists(_ db: OpaquePointer, table: String, column: String) -> Bool {
        var statement: OpaquePointer?
        defer { sqlite3_finalize(statement) }
        guard sqlite3_prepare_v2(db, "PRAGMA table_info(\(quoted(table)))", -1, &statement, nil) == SQLITE_OK else { return false }
        while sqlite3_step(statement) == SQLITE_ROW {
            if let name = sqlite3_column_text(statement, 1), String(cString: name) == column {
                return true
            }
        }
        return false
    }

    private static func quoted(_ identifier: String) -> String {
        "\"\(identifier.replacingOccurrences(of: "\"", with: "\"\""))\""
    }
}
