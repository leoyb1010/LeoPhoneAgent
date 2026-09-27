import XCTest

final class SymlinkSafeDeleteTests: XCTestCase {
    private var root: URL!

    override func setUpWithError() throws {
        root = FileManager.default.temporaryDirectory
            .appendingPathComponent("SymlinkSafeDeleteTests-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: root)
    }

    private func makeLibrary() throws -> URL {
        let library = root.appendingPathComponent("Vault", isDirectory: true)
        try FileManager.default.createDirectory(at: library.appendingPathComponent("notes"), withIntermediateDirectories: true)
        try Data(repeating: 1, count: 100).write(to: library.appendingPathComponent("a.md"))
        try Data(repeating: 2, count: 50).write(to: library.appendingPathComponent("notes/b.md"))
        return library
    }

    func testUnlinkRemovesOnlyTheLink() throws {
        let library = try makeLibrary()
        let link = root.appendingPathComponent("mount-link")
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: library)

        XCTAssertTrue(SymlinkSafeDelete.isSymlink(link))
        try SymlinkSafeDelete.unlinkSymlink(at: link)

        XCTAssertFalse(FileManager.default.fileExists(atPath: link.path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: library.appendingPathComponent("a.md").path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: library.appendingPathComponent("notes/b.md").path))
    }

    func testUnlinkRefusesRealDirectory() throws {
        let library = try makeLibrary()
        XCTAssertFalse(SymlinkSafeDelete.isSymlink(library))
        XCTAssertThrowsError(try SymlinkSafeDelete.unlinkSymlink(at: library))
        XCTAssertTrue(FileManager.default.fileExists(atPath: library.appendingPathComponent("a.md").path))
    }

    func testDanglingLinkIsStillALink() throws {
        let link = root.appendingPathComponent("dangling")
        try FileManager.default.createSymbolicLink(atPath: link.path, withDestinationPath: "/nonexistent/\(UUID().uuidString)")
        XCTAssertTrue(SymlinkSafeDelete.isSymlink(link))
        try SymlinkSafeDelete.unlinkSymlink(at: link)
        XCTAssertFalse(SymlinkSafeDelete.isSymlink(link))
    }

    func testRecursiveSizeDoesNotFollowLinks() throws {
        let library = try makeLibrary()
        let size = SymlinkSafeDelete.recursiveSize(of: library)
        XCTAssertEqual(size.bytes, 150)
        XCTAssertEqual(size.files, 2)

        let link = root.appendingPathComponent("mount-link")
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: library)
        let linkSize = SymlinkSafeDelete.recursiveSize(of: link)
        XCTAssertEqual(linkSize.bytes, 0)
        XCTAssertEqual(linkSize.files, 1)

        let parent = root.appendingPathComponent("parent", isDirectory: true)
        try FileManager.default.createDirectory(at: parent, withIntermediateDirectories: true)
        try FileManager.default.createSymbolicLink(at: parent.appendingPathComponent("inner-link"), withDestinationURL: library)
        let parentSize = SymlinkSafeDelete.recursiveSize(of: parent)
        XCTAssertEqual(parentSize.bytes, 0, "a link inside a folder must not pull in its target's bytes")
        XCTAssertEqual(parentSize.files, 1)
    }
}

final class OffloadPlaceholderGuardTests: XCTestCase {
    /// Where an earlier `file_write` call's own content is offloaded.
    private let path = "/var/minis/offloads/tools/file_write_abc123def456.txt"

    private func stub(_ savedTo: String) -> String {
        "[CONTEXT OFFLOADED] Content (~1200 tokens, 4800 bytes) saved to: \(savedTo)\nUse file_read tool to retrieve if needed."
    }

    private var contentStub: String { stub(path) }

    func testCleanTextPassesThrough() {
        XCTAssertEqual(OffloadPlaceholderGuard.check("print(1)\n", field: "content", contents: [:]), .clean)
    }

    func testOwnWriteStubIsRestoredFromSavedFile() {
        let text = "header\n\(contentStub)\nfooter"
        XCTAssertEqual(OffloadPlaceholderGuard.referencedContentPaths(in: text), [path])
        XCTAssertEqual(
            OffloadPlaceholderGuard.check(text, field: "content", contents: [path: "REAL BODY"]),
            .resolved("header\nREAL BODY\nfooter"))
    }

    func testToolResultStubsAreRejectedNotRestored() {
        // A file_read result carries its "[path | … ]" header and minis_url /
        // next_offset trailers; shell and browser output are not file text.
        for savedTo in [
            "/var/minis/offloads/tools/file_read_abc123def456.txt",
            "/var/minis/offloads/tools/shell_execute_abc123def456.txt",
            "/var/minis/offloads/tools/result_file_write_abc123def456.txt",
            "/var/minis/offloads/shell_execute_1767000000_toolu_01.txt",
        ] {
            let saved = "[/root/main.py | 20 bytes | 1 lines | showing 1-1 of 1]\nprint(1)\nminis_url: leophoneagent://x"
            guard case .rejected(let message) = OffloadPlaceholderGuard.check(
                "\(stub(savedTo))\n", field: "content", contents: [savedTo: saved]) else {
                return XCTFail("a stub for \(savedTo) must not be written back into a file")
            }
            XCTAssertTrue(message.contains("file_read"), "the error must send the model back to the real file")
            XCTAssertTrue(message.contains("Nothing was written"))
        }
        XCTAssertFalse(OffloadPlaceholderGuard.isOwnWriteContent("/var/minis/offloads/tools/file_write_../../etc/passwd"))
        XCTAssertFalse(OffloadPlaceholderGuard.isOwnWriteContent("/var/minis/offloads/tools/file_write_x/y.txt"))
        XCTAssertTrue(OffloadPlaceholderGuard.isOwnWriteContent(path))
    }

    func testUnreadableStubIsRejected() {
        guard case .rejected(let message) = OffloadPlaceholderGuard.check(contentStub, field: "content", contents: [:]) else {
            return XCTFail("an unreadable stub must not be written")
        }
        XCTAssertTrue(message.contains("Nothing was written"))
    }

    func testImageStubIsRejected() {
        let stub = "[CONTEXT OFFLOADED] Image (~800 tokens, 90000 bytes) saved to: /var/minis/offloads/tools/img.png"
        guard case .rejected = OffloadPlaceholderGuard.check(stub, field: "new_string", contents: [:]) else {
            return XCTFail("image stubs can't be written as text")
        }
    }

    func testBareMarkerTextIsWritable() {
        // Docs, tests and the source that builds the notices mention the
        // markers without being a placeholder.
        for text in [
            "see [CONTEXT OFFLOADED] above",
            "let stub = \"[CONTEXT OFFLOADED] Content (~\\(tokens) tokens, \\(bytes) bytes) saved to: \\(path)\"",
            "+ \"\\n\\n[OUTPUT TRUNCATED] Full output (\\(toolOutput.count) chars) saved to: \\(offloadResult.linuxPath)\"",
            "Long output ends with [OUTPUT TRUNCATED] Showing first & last N chars.",
        ] {
            XCTAssertEqual(OffloadPlaceholderGuard.check(text, field: "content", contents: [:]), .clean, text)
        }
    }

    func testTruncatedOutputIsRejectedWithSourcePath() {
        let text = "line 1\n[OUTPUT TRUNCATED] Full output (40000 chars) saved to: /var/minis/offloads/out.txt"
        guard case .rejected(let message) = OffloadPlaceholderGuard.check(text, field: "content", contents: [:]) else {
            return XCTFail("truncated output must not be written")
        }
        XCTAssertTrue(message.contains("/var/minis/offloads/out.txt"))

        let shell = "a\n\n...\n\nz\n\n[OUTPUT TRUNCATED] Showing first & last 2000 of 90000 chars (1200 lines total).\nUse file_read tool to read specific sections."
        guard case .rejected = OffloadPlaceholderGuard.check(shell, field: "content", contents: [:]) else {
            return XCTFail("clipped shell output must not be written")
        }
    }

    func testStubRestoringToAnotherStubIsRejected() {
        let nested = "[CONTEXT OFFLOADED] Content (~10 tokens, 40 bytes) saved to: /var/minis/offloads/tools/other.txt"
        guard case .rejected = OffloadPlaceholderGuard.check(contentStub, field: "content", contents: [path: nested]) else {
            return XCTFail("a stub that restores to another stub would loop")
        }
    }

    func testOffloadSourcePathOnlyForWholeFileReads() {
        let dir = "/var/minis/offloads"
        let whole = "[\(path) | 4800 bytes | 120 lines | showing 1-120 of 120]\nbody"
        XCTAssertEqual(OffloadPlaceholderGuard.offloadSourcePath(ofFileReadResult: whole, offloadsDir: dir), path)

        let page = "[\(path) | 4800 bytes | 120 lines | showing 1-60 of 120]\nbody\nnext_offset: 61"
        XCTAssertNil(OffloadPlaceholderGuard.offloadSourcePath(ofFileReadResult: page, offloadsDir: dir))

        let clipped = "[\(path) | 4800 bytes | 120 lines | showing 1-120 of 120 (truncated at 15000 chars or requested max_length)]\nbody"
        XCTAssertNil(OffloadPlaceholderGuard.offloadSourcePath(ofFileReadResult: clipped, offloadsDir: dir))

        let elsewhere = "[/root/notes.md | 10 bytes | 1 lines | showing 1-1 of 1]\nhi"
        XCTAssertNil(OffloadPlaceholderGuard.offloadSourcePath(ofFileReadResult: elsewhere, offloadsDir: dir))
    }
}

final class CodexOffEffortClampTests: XCTestCase {
    func testOffEffortRaisedToModelFloor() {
        XCTAssertEqual(CodexReasoningCeiling.clampOffEffort("none", floor: "low"), "low")
        XCTAssertEqual(CodexReasoningCeiling.clampOffEffort("low", floor: "medium"), "medium")
    }

    func testOffEffortKeptWhenModelAcceptsIt() {
        XCTAssertEqual(CodexReasoningCeiling.clampOffEffort("none", floor: nil), "none")
        XCTAssertEqual(CodexReasoningCeiling.clampOffEffort("none", floor: "none"), "none")
        XCTAssertEqual(CodexReasoningCeiling.clampOffEffort("low", floor: "minimal"), "low")
    }

    func testLowestAcceptedEffort() {
        XCTAssertEqual(CodexReasoningCeiling.lowest(of: ["high", "low", "medium"]), "low")
        XCTAssertNil(CodexReasoningCeiling.lowest(of: []))
    }
}
