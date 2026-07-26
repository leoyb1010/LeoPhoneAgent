import Foundation
import XCTest

final class ArtifactRepositoryTests: XCTestCase {
    func testVersionTrashRestoreAndPurgeLifecycle() async throws {
        let baseURL = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: baseURL) }
        let repository = ArtifactRepository(baseURL: baseURL)

        let first = try await repository.create(
            data: Data("first".utf8),
            fileName: "report.txt",
            mimeType: "text/plain",
            sessionId: "session-1"
        )
        XCTAssertEqual(first.currentVersion?.versionNumber, 1)
        XCTAssertEqual(first.currentVersion?.byteCount, 5)
        XCTAssertEqual(first.artifact.kind, .document)

        let second = try await repository.appendVersion(
            artifactId: first.artifact.id,
            data: Data("second".utf8),
            fileName: "report.txt"
        )
        XCTAssertEqual(second.currentVersion?.versionNumber, 2)
        let versions = try await repository.versions(artifactId: first.artifact.id)
        XCTAssertEqual(versions.count, 2)

        try await repository.trash(id: first.artifact.id)
        let visibleAfterTrash = try await repository.list()
        let allAfterTrash = try await repository.list(includeTrashed: true)
        XCTAssertTrue(visibleAfterTrash.isEmpty)
        XCTAssertEqual(allAfterTrash.count, 1)

        try await repository.restore(id: first.artifact.id)
        let visibleAfterRestore = try await repository.list()
        XCTAssertEqual(visibleAfterRestore.count, 1)

        let fileURL = try await repository.fileURL(for: XCTUnwrap(second.currentVersion))
        XCTAssertEqual(try Data(contentsOf: fileURL), Data("second".utf8))

        try await repository.purge(id: first.artifact.id)
        let allAfterPurge = try await repository.list(includeTrashed: true)
        XCTAssertTrue(allAfterPurge.isEmpty)
        XCTAssertFalse(FileManager.default.fileExists(atPath: fileURL.deletingLastPathComponent().path))
    }

    func testSanitizesUntrustedFileNameInsideManagedDirectory() async throws {
        let baseURL = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: baseURL) }
        let repository = ArtifactRepository(baseURL: baseURL)

        let snapshot = try await repository.create(
            data: Data([1, 2, 3]),
            fileName: "../../private?.bin",
            mimeType: "application/octet-stream",
            sessionId: "session-2"
        )
        let version = try XCTUnwrap(snapshot.currentVersion)
        let url = try await repository.fileURL(for: version)

        XCTAssertTrue(url.path.hasPrefix(baseURL.appendingPathComponent("artifacts").path + "/"))
        XCTAssertFalse(version.relativePath.contains(".."))
    }

    func testCaptureTracksSourcePathVersionsAndSkipsDuplicateContent() async throws {
        let baseURL = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: baseURL) }
        try FileManager.default.createDirectory(at: baseURL, withIntermediateDirectories: true)
        let sourceURL = baseURL.appendingPathComponent("report.md")
        let repository = ArtifactRepository(baseURL: baseURL.appendingPathComponent("store", isDirectory: true))

        try Data("first".utf8).write(to: sourceURL)
        let first = try await repository.capture(
            fileURL: sourceURL,
            sourcePath: "/var/minis/workspace/report.md",
            sessionId: "session-3",
            sourceMessageId: "message-1"
        )
        XCTAssertEqual(first.artifact.sourcePath, "/var/minis/workspace/report.md")
        XCTAssertEqual(first.artifact.sourceMessageId, "message-1")
        XCTAssertEqual(first.currentVersion?.versionNumber, 1)

        let duplicate = try await repository.capture(
            fileURL: sourceURL,
            sourcePath: "/var/minis/workspace/report.md",
            sessionId: "session-3"
        )
        XCTAssertEqual(duplicate.artifact.id, first.artifact.id)
        let duplicateVersions = try await repository.versions(artifactId: first.artifact.id)
        XCTAssertEqual(duplicateVersions.count, 1)

        try Data("second".utf8).write(to: sourceURL)
        let second = try await repository.capture(
            fileURL: sourceURL,
            sourcePath: "/var/minis/workspace/report.md",
            sessionId: "session-3"
        )
        XCTAssertEqual(second.artifact.id, first.artifact.id)
        XCTAssertEqual(second.currentVersion?.versionNumber, 2)
        let updatedVersions = try await repository.versions(artifactId: first.artifact.id)
        XCTAssertEqual(updatedVersions.count, 2)
    }
}
