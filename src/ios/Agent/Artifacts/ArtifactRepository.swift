import CryptoKit
import Foundation
import SQLite3

private final class ArtifactSQLiteHandle: @unchecked Sendable {
    let pointer: OpaquePointer?

    init(_ pointer: OpaquePointer?) {
        self.pointer = pointer
    }

    deinit {
        if let pointer { sqlite3_close(pointer) }
    }
}

actor ArtifactRepository {
    static let shared = ArtifactRepository()

    enum RepositoryError: Error, Equatable, CustomStringConvertible {
        case databaseUnavailable
        case artifactNotFound
        case unsafePath
        case sql(String)

        var description: String {
            switch self {
            case .databaseUnavailable: return "Artifact database is unavailable."
            case .artifactNotFound: return "Artifact was not found."
            case .unsafePath: return "Artifact path is outside the managed directory."
            case .sql(let message): return "Artifact database error: \(message)"
            }
        }
    }

    private let databaseHandle: ArtifactSQLiteHandle
    private var db: OpaquePointer? { databaseHandle.pointer }
    private let rootURL: URL
    private let artifactsURL: URL
    private let stagingURL: URL

    init() {
        let library = FileManager.default.urls(for: .libraryDirectory, in: .userDomainMask)[0]
        let baseURL = library.appendingPathComponent("MinisChat", isDirectory: true)
        self.rootURL = baseURL
        self.artifactsURL = baseURL.appendingPathComponent("artifacts", isDirectory: true)
        self.stagingURL = baseURL.appendingPathComponent("artifacts/.staging", isDirectory: true)
        self.databaseHandle = ArtifactSQLiteHandle(
            Self.openDatabase(rootURL: rootURL, artifactsURL: artifactsURL, stagingURL: stagingURL)
        )
    }

    init(baseURL: URL) {
        self.rootURL = baseURL
        self.artifactsURL = baseURL.appendingPathComponent("artifacts", isDirectory: true)
        self.stagingURL = baseURL.appendingPathComponent("artifacts/.staging", isDirectory: true)
        self.databaseHandle = ArtifactSQLiteHandle(
            Self.openDatabase(rootURL: rootURL, artifactsURL: artifactsURL, stagingURL: stagingURL)
        )
    }

    @discardableResult
    func create(
        data: Data,
        fileName: String,
        mimeType: String,
        sessionId: String,
        sourceMessageId: String? = nil,
        title: String? = nil
    ) throws -> ArtifactSnapshot {
        let artifactId = UUID().uuidString
        let now = Date()
        let artifact = ArtifactRecord(
            id: artifactId,
            sessionId: sessionId,
            sourceMessageId: sourceMessageId,
            title: normalizedTitle(title ?? fileName),
            kind: ArtifactKind.infer(mimeType: mimeType, fileName: fileName),
            mimeType: mimeType,
            currentVersionId: nil,
            createdAt: now,
            updatedAt: now,
            trashedAt: nil
        )
        return try persistVersion(artifact: artifact, data: data, fileName: fileName, mimeType: mimeType, isNew: true)
    }

    @discardableResult
    func appendVersion(
        artifactId: String,
        data: Data,
        fileName: String,
        mimeType: String? = nil
    ) throws -> ArtifactSnapshot {
        guard var artifact = try artifact(id: artifactId) else { throw RepositoryError.artifactNotFound }
        artifact.updatedAt = Date()
        artifact.trashedAt = nil
        if let mimeType {
            artifact.mimeType = mimeType
            artifact.kind = ArtifactKind.infer(mimeType: mimeType, fileName: fileName)
        }
        return try persistVersion(artifact: artifact, data: data, fileName: fileName, mimeType: artifact.mimeType, isNew: false)
    }

    func list(sessionId: String? = nil, includeTrashed: Bool = false) throws -> [ArtifactSnapshot] {
        var clauses: [String] = []
        if sessionId != nil { clauses.append("a.session_id = ?") }
        if !includeTrashed { clauses.append("a.trashed_at IS NULL") }
        let whereSQL = clauses.isEmpty ? "" : "WHERE " + clauses.joined(separator: " AND ")
        let sql = """
            SELECT a.id, a.session_id, a.source_message_id, a.title, a.kind, a.mime_type,
                   a.current_version_id, a.created_at, a.updated_at, a.trashed_at,
                   v.id, v.artifact_id, v.version_number, v.original_file_name,
                   v.relative_path, v.byte_count, v.sha256, v.created_at
              FROM artifacts a
              LEFT JOIN artifact_versions v ON v.id = a.current_version_id
              \(whereSQL)
             ORDER BY a.updated_at DESC
        """
        let statement = try prepare(sql)
        defer { sqlite3_finalize(statement) }
        if let sessionId { bindText(statement, 1, sessionId) }
        var results: [ArtifactSnapshot] = []
        while sqlite3_step(statement) == SQLITE_ROW {
            results.append(decodeSnapshot(statement))
        }
        return results
    }

    func artifact(id: String) throws -> ArtifactRecord? {
        let statement = try prepare("SELECT id, session_id, source_message_id, title, kind, mime_type, current_version_id, created_at, updated_at, trashed_at FROM artifacts WHERE id = ?")
        defer { sqlite3_finalize(statement) }
        bindText(statement, 1, id)
        guard sqlite3_step(statement) == SQLITE_ROW else { return nil }
        return decodeArtifact(statement, offset: 0)
    }

    func versions(artifactId: String) throws -> [ArtifactVersion] {
        let statement = try prepare("SELECT id, artifact_id, version_number, original_file_name, relative_path, byte_count, sha256, created_at FROM artifact_versions WHERE artifact_id = ? ORDER BY version_number DESC")
        defer { sqlite3_finalize(statement) }
        bindText(statement, 1, artifactId)
        var results: [ArtifactVersion] = []
        while sqlite3_step(statement) == SQLITE_ROW { results.append(decodeVersion(statement, offset: 0)) }
        return results
    }

    func fileURL(for version: ArtifactVersion) throws -> URL {
        let candidate = artifactsURL.appendingPathComponent(version.relativePath).standardizedFileURL
        let root = artifactsURL.standardizedFileURL.path + "/"
        guard candidate.path.hasPrefix(root) else { throw RepositoryError.unsafePath }
        return candidate
    }

    func trash(id: String, at date: Date = Date()) throws {
        try updateTimestamp(sql: "UPDATE artifacts SET trashed_at = ?, updated_at = ? WHERE id = ?", id: id, date: date)
    }

    func restore(id: String, at date: Date = Date()) throws {
        let statement = try prepare("UPDATE artifacts SET trashed_at = NULL, updated_at = ? WHERE id = ?")
        defer { sqlite3_finalize(statement) }
        sqlite3_bind_double(statement, 1, date.timeIntervalSince1970)
        bindText(statement, 2, id)
        try stepDone(statement)
    }

    func purge(id: String) throws {
        let directory = artifactsURL.appendingPathComponent(id, isDirectory: true).standardizedFileURL
        let root = artifactsURL.standardizedFileURL.path + "/"
        guard directory.path.hasPrefix(root) else { throw RepositoryError.unsafePath }
        try execute("BEGIN IMMEDIATE TRANSACTION")
        do {
            let statement = try prepare("DELETE FROM artifacts WHERE id = ?")
            bindText(statement, 1, id)
            do {
                try stepDone(statement)
                sqlite3_finalize(statement)
            } catch {
                sqlite3_finalize(statement)
                throw error
            }
            try execute("COMMIT")
            try? FileManager.default.removeItem(at: directory)
        } catch {
            _ = sqlite3_exec(db, "ROLLBACK", nil, nil, nil)
            throw error
        }
    }

    private static func openDatabase(rootURL: URL, artifactsURL: URL, stagingURL: URL) -> OpaquePointer? {
        try? FileManager.default.createDirectory(at: artifactsURL, withIntermediateDirectories: true)
        try? FileManager.default.createDirectory(at: stagingURL, withIntermediateDirectories: true)
        let databaseURL = rootURL.appendingPathComponent("minis.db")
        var database: OpaquePointer?
        guard sqlite3_open(databaseURL.path, &database) == SQLITE_OK else { return nil }
        sqlite3_busy_timeout(database, 5_000)
        _ = sqlite3_exec(database, "PRAGMA journal_mode=WAL", nil, nil, nil)
        _ = sqlite3_exec(database, "PRAGMA foreign_keys=ON", nil, nil, nil)
        _ = try? ChatStoreSchemaContract.migrate(database)
        return database
    }

    private func persistVersion(artifact: ArtifactRecord, data: Data, fileName: String, mimeType: String, isNew: Bool) throws -> ArtifactSnapshot {
        guard db != nil else { throw RepositoryError.databaseUnavailable }
        let nextVersion = isNew ? 1 : ((try versions(artifactId: artifact.id).first?.versionNumber ?? 0) + 1)
        let versionId = UUID().uuidString
        let safeName = sanitizedFileName(fileName)
        let relativePath = "\(artifact.id)/v\(nextVersion)-\(versionId.prefix(8))-\(safeName)"
        let finalURL = artifactsURL.appendingPathComponent(relativePath)
        let stagedURL = stagingURL.appendingPathComponent(versionId)
        try data.write(to: stagedURL, options: .atomic)
        let checksum = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
        try FileManager.default.createDirectory(at: finalURL.deletingLastPathComponent(), withIntermediateDirectories: true)

        try execute("BEGIN IMMEDIATE TRANSACTION")
        do {
            try FileManager.default.moveItem(at: stagedURL, to: finalURL)
            if isNew {
                let insert = try prepare("INSERT INTO artifacts (id, session_id, source_message_id, title, kind, mime_type, current_version_id, created_at, updated_at, trashed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)")
                bindText(insert, 1, artifact.id)
                bindText(insert, 2, artifact.sessionId)
                bindOptionalText(insert, 3, artifact.sourceMessageId)
                bindText(insert, 4, artifact.title)
                bindText(insert, 5, artifact.kind.rawValue)
                bindText(insert, 6, mimeType)
                bindText(insert, 7, versionId)
                sqlite3_bind_double(insert, 8, artifact.createdAt.timeIntervalSince1970)
                sqlite3_bind_double(insert, 9, artifact.updatedAt.timeIntervalSince1970)
                try stepDone(insert)
                sqlite3_finalize(insert)
            }

            let versionInsert = try prepare("INSERT INTO artifact_versions (id, artifact_id, version_number, original_file_name, relative_path, byte_count, sha256, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
            bindText(versionInsert, 1, versionId)
            bindText(versionInsert, 2, artifact.id)
            sqlite3_bind_int64(versionInsert, 3, Int64(nextVersion))
            bindText(versionInsert, 4, safeName)
            bindText(versionInsert, 5, relativePath)
            sqlite3_bind_int64(versionInsert, 6, Int64(data.count))
            bindText(versionInsert, 7, checksum)
            sqlite3_bind_double(versionInsert, 8, artifact.updatedAt.timeIntervalSince1970)
            try stepDone(versionInsert)
            sqlite3_finalize(versionInsert)

            if !isNew {
                let update = try prepare("UPDATE artifacts SET title = ?, kind = ?, mime_type = ?, current_version_id = ?, updated_at = ?, trashed_at = NULL WHERE id = ?")
                bindText(update, 1, artifact.title)
                bindText(update, 2, artifact.kind.rawValue)
                bindText(update, 3, mimeType)
                bindText(update, 4, versionId)
                sqlite3_bind_double(update, 5, artifact.updatedAt.timeIntervalSince1970)
                bindText(update, 6, artifact.id)
                try stepDone(update)
                sqlite3_finalize(update)
            }
            try execute("COMMIT")
        } catch {
            _ = sqlite3_exec(db, "ROLLBACK", nil, nil, nil)
            try? FileManager.default.removeItem(at: stagedURL)
            try? FileManager.default.removeItem(at: finalURL)
            throw error
        }

        guard let stored = try self.artifact(id: artifact.id),
              let current = try versions(artifactId: artifact.id).first
        else { throw RepositoryError.artifactNotFound }
        return ArtifactSnapshot(artifact: stored, currentVersion: current)
    }

    private func updateTimestamp(sql: String, id: String, date: Date) throws {
        let statement = try prepare(sql)
        defer { sqlite3_finalize(statement) }
        sqlite3_bind_double(statement, 1, date.timeIntervalSince1970)
        sqlite3_bind_double(statement, 2, date.timeIntervalSince1970)
        bindText(statement, 3, id)
        try stepDone(statement)
    }

    private func decodeSnapshot(_ statement: OpaquePointer?) -> ArtifactSnapshot {
        ArtifactSnapshot(
            artifact: decodeArtifact(statement, offset: 0),
            currentVersion: sqlite3_column_type(statement, 10) == SQLITE_NULL ? nil : decodeVersion(statement, offset: 10)
        )
    }

    private func decodeArtifact(_ statement: OpaquePointer?, offset: Int32) -> ArtifactRecord {
        ArtifactRecord(
            id: text(statement, offset),
            sessionId: text(statement, offset + 1),
            sourceMessageId: optionalText(statement, offset + 2),
            title: text(statement, offset + 3),
            kind: ArtifactKind(rawValue: text(statement, offset + 4)) ?? .file,
            mimeType: text(statement, offset + 5),
            currentVersionId: optionalText(statement, offset + 6),
            createdAt: Date(timeIntervalSince1970: sqlite3_column_double(statement, offset + 7)),
            updatedAt: Date(timeIntervalSince1970: sqlite3_column_double(statement, offset + 8)),
            trashedAt: sqlite3_column_type(statement, offset + 9) == SQLITE_NULL ? nil : Date(timeIntervalSince1970: sqlite3_column_double(statement, offset + 9))
        )
    }

    private func decodeVersion(_ statement: OpaquePointer?, offset: Int32) -> ArtifactVersion {
        ArtifactVersion(
            id: text(statement, offset),
            artifactId: text(statement, offset + 1),
            versionNumber: Int(sqlite3_column_int64(statement, offset + 2)),
            originalFileName: text(statement, offset + 3),
            relativePath: text(statement, offset + 4),
            byteCount: sqlite3_column_int64(statement, offset + 5),
            sha256: text(statement, offset + 6),
            createdAt: Date(timeIntervalSince1970: sqlite3_column_double(statement, offset + 7))
        )
    }

    private func prepare(_ sql: String) throws -> OpaquePointer? {
        guard let db else { throw RepositoryError.databaseUnavailable }
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &statement, nil) == SQLITE_OK else {
            throw RepositoryError.sql(String(cString: sqlite3_errmsg(db)))
        }
        return statement
    }

    private func execute(_ sql: String) throws {
        guard let db else { throw RepositoryError.databaseUnavailable }
        guard sqlite3_exec(db, sql, nil, nil, nil) == SQLITE_OK else {
            throw RepositoryError.sql(String(cString: sqlite3_errmsg(db)))
        }
    }

    private func stepDone(_ statement: OpaquePointer?) throws {
        guard sqlite3_step(statement) == SQLITE_DONE else {
            throw RepositoryError.sql(db.map { String(cString: sqlite3_errmsg($0)) } ?? "database unavailable")
        }
    }

    private func bindText(_ statement: OpaquePointer?, _ index: Int32, _ value: String) {
        sqlite3_bind_text(statement, index, (value as NSString).utf8String, -1, nil)
    }

    private func bindOptionalText(_ statement: OpaquePointer?, _ index: Int32, _ value: String?) {
        if let value { bindText(statement, index, value) } else { sqlite3_bind_null(statement, index) }
    }

    private func text(_ statement: OpaquePointer?, _ index: Int32) -> String {
        sqlite3_column_text(statement, index).map { String(cString: $0) } ?? ""
    }

    private func optionalText(_ statement: OpaquePointer?, _ index: Int32) -> String? {
        sqlite3_column_type(statement, index) == SQLITE_NULL ? nil : text(statement, index)
    }

    private func sanitizedFileName(_ value: String) -> String {
        let leaf = URL(fileURLWithPath: value).lastPathComponent
        let cleaned = leaf.unicodeScalars.map { scalar -> Character in
            CharacterSet.alphanumerics.union(CharacterSet(charactersIn: ".-_ ")).contains(scalar) ? Character(String(scalar)) : "_"
        }
        let result = String(cleaned).trimmingCharacters(in: .whitespacesAndNewlines)
        return String((result.isEmpty ? "artifact.bin" : result).prefix(120))
    }

    private func normalizedTitle(_ value: String) -> String {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return String((trimmed.isEmpty ? "Untitled Artifact" : trimmed).prefix(160))
    }
}
