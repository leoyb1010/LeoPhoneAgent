import Foundation
import CryptoKit

private enum ArtifactSmokeFailure: Error {
    case assertion(String)
}

@main
enum ArtifactRepositorySmoke {
    static func main() async throws {
        let baseURL = FileManager.default.temporaryDirectory.appendingPathComponent("LeoArtifactSmoke-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: baseURL) }
        let repository = ArtifactRepository(baseURL: baseURL)

        let first = try await repository.create(
            data: Data("first".utf8),
            fileName: "../../report.txt",
            mimeType: "text/plain",
            sessionId: "session-smoke"
        )
        try expect(first.currentVersion?.versionNumber == 1, "create v1")
        try expect(first.currentVersion?.relativePath.contains("..") == false, "sanitize path")

        let second = try await repository.appendVersion(
            artifactId: first.artifact.id,
            data: Data("second".utf8),
            fileName: "report.txt"
        )
        try expect(second.currentVersion?.versionNumber == 2, "append v2")
        let versionCount = try await repository.versions(artifactId: first.artifact.id).count
        try expect(versionCount == 2, "version history")

        try await repository.trash(id: first.artifact.id)
        let visibleAfterTrash = try await repository.list()
        let allAfterTrash = try await repository.list(includeTrashed: true)
        try expect(visibleAfterTrash.isEmpty, "trash hides artifact")
        try expect(allAfterTrash.count == 1, "trash retains artifact")

        try await repository.restore(id: first.artifact.id)
        let version = try unwrap(second.currentVersion)
        let fileURL = try await repository.fileURL(for: version)
        let currentData = try Data(contentsOf: fileURL)
        try expect(currentData == Data("second".utf8), "current version file")

        let sourceURL = baseURL.appendingPathComponent("source.md")
        try Data("captured-v1".utf8).write(to: sourceURL)
        let captured = try await repository.capture(
            fileURL: sourceURL,
            sourcePath: "/var/minis/workspace/source.md",
            sessionId: "session-smoke",
            sourceMessageId: "message-smoke"
        )
        _ = try await repository.capture(
            fileURL: sourceURL,
            sourcePath: "/var/minis/workspace/source.md",
            sessionId: "session-smoke"
        )
        let deduplicatedCount = try await repository.versions(artifactId: captured.artifact.id).count
        try expect(deduplicatedCount == 1, "capture duplicate content")
        try Data("captured-v2".utf8).write(to: sourceURL)
        let recaptured = try await repository.capture(
            fileURL: sourceURL,
            sourcePath: "/var/minis/workspace/source.md",
            sessionId: "session-smoke"
        )
        try expect(recaptured.currentVersion?.versionNumber == 2, "capture version update")

        try await repository.purge(id: first.artifact.id)
        let allAfterPurge = try await repository.list(includeTrashed: true)
        try expect(allAfterPurge.count == 1, "purge selected metadata")
        try expect(!FileManager.default.fileExists(atPath: fileURL.deletingLastPathComponent().path), "purge files")

        let remoteData = Data("remote-asset".utf8)
        let remoteAssetURL = baseURL.appendingPathComponent("remote.tmp")
        try remoteData.write(to: remoteAssetURL)
        let remoteChecksum = SHA256.hash(data: remoteData).map { String(format: "%02x", $0) }.joined()
        let remoteDate = Date()
        let remoteArtifact = ArtifactRecord(
            id: "artifact-remote",
            sessionId: "session-smoke",
            sourceMessageId: "message-remote",
            sourcePath: "/var/minis/workspace/remote.txt",
            title: "Remote",
            kind: .document,
            mimeType: "text/plain",
            currentVersionId: "version-remote",
            createdAt: remoteDate,
            updatedAt: remoteDate,
            trashedAt: nil
        )
        let remoteVersion = ArtifactVersion(
            id: "version-remote",
            artifactId: remoteArtifact.id,
            versionNumber: 1,
            originalFileName: "remote.txt",
            relativePath: "",
            byteCount: Int64(remoteData.count),
            sha256: remoteChecksum,
            createdAt: remoteDate
        )
        try await repository.mergeRemoteArtifact(remoteArtifact)
        try await repository.mergeRemoteVersion(
            remoteVersion,
            sessionId: remoteArtifact.sessionId,
            mimeType: remoteArtifact.mimeType,
            assetURL: remoteAssetURL
        )
        let imported = try unwrap(try await repository.version(id: remoteVersion.id))
        let importedURL = try await repository.fileURL(for: imported)
        let importedData = try Data(contentsOf: importedURL)
        try expect(importedData == remoteData, "remote CKAsset integrity")
        try expect(FileManager.default.fileExists(atPath: remoteAssetURL.path), "remote source retained")
        print("ArtifactRepositorySmoke: lifecycle passed")
    }

    private static func expect(_ condition: @autoclosure () -> Bool, _ message: String) throws {
        guard condition() else { throw ArtifactSmokeFailure.assertion(message) }
    }

    private static func unwrap<T>(_ value: T?) throws -> T {
        guard let value else { throw ArtifactSmokeFailure.assertion("missing value") }
        return value
    }
}
