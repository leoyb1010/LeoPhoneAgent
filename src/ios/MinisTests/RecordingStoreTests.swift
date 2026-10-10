import XCTest

/// [V-rec] 录音存储:路径、id 校验、不备份标记、删除、App 备份包跳过录音目录。
final class RecordingStoreTests: XCTestCase {
    private var dir: URL!
    private var store: RecordingStore!

    override func setUpWithError() throws {
        try super.setUpWithError()
        dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("recording-store-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        store = RecordingStore(root: dir.appendingPathComponent("recordings", isDirectory: true))
    }

    override func tearDownWithError() throws {
        if let dir { try? FileManager.default.removeItem(at: dir) }
        try super.tearDownWithError()
    }

    func testDefaultRootIsLibraryMinisChatRecordings() {
        let path = RecordingStore.defaultRoot.path
        XCTAssertTrue(path.hasSuffix("/Library/MinisChat/recordings"), path)
        // Never inside Documents (Files app / iCloud Drive) or the chats tree that backups walk.
        XCTAssertFalse(path.contains("/Documents/"))
        XCTAssertFalse(path.contains("/MinisChat/minis/"))
    }

    func testPathsAreDerivedFromValidatedIds() throws {
        let id = UUID().uuidString
        XCTAssertEqual(try store.directory(for: id).lastPathComponent, id)
        XCTAssertEqual(try store.metadataURL(for: id).lastPathComponent, "meta.json")
        XCTAssertEqual(try store.transcriptURL(for: id).lastPathComponent, "transcript.json")
        XCTAssertEqual(try store.audioURL(for: id, fileName: "chunk-007.m4a").lastPathComponent, "chunk-007.m4a")
        XCTAssertEqual(try store.audioURL(for: id, fileName: "imported.mp3").lastPathComponent, "imported.mp3")
    }

    func testTraversalIdsAndFileNamesAreRejected() {
        for bad in ["../../Documents", "..", "", "abc", "x/y", UUID().uuidString + "/..", " " + UUID().uuidString] {
            XCTAssertThrowsError(try store.directory(for: bad), bad)
            XCTAssertFalse(RecordingStore.isValidId(bad), bad)
        }
        let id = UUID().uuidString
        for bad in ["../meta.json", "chunk-1.m4a", "chunk-0001.m4a", "chunk-000.m4a/..", "imported.", "imported.MP3/x", "meta.json"] {
            XCTAssertThrowsError(try store.audioURL(for: id, fileName: bad), bad)
        }
        XCTAssertThrowsError(try store.outputURL(for: id, outputId: "../x"))
        XCTAssertNil(store.load(id: "../../etc"))
    }

    func testCreateSaveLoadListRoundTrip() throws {
        var older = RecordingMetadata(title: "周会", createdAt: Date(timeIntervalSince1970: 1_000))
        older.state = .finished
        older.chunks = [RecordingChunk(index: 0, fileName: "chunk-000.m4a", startOffset: 0, sampleRate: 48_000,
                                       frameCount: 48_000 * 90, isOpen: false)]
        let newer = RecordingMetadata(title: "客户电话", createdAt: Date(timeIntervalSince1970: 2_000))
        try store.create(older)
        try store.create(newer)
        let list = store.list()
        XCTAssertEqual(list.map(\.id), [newer.id, older.id], "newest first")
        XCTAssertEqual(store.load(id: older.id)?.duration ?? 0, 90, accuracy: 0.001)
        XCTAssertEqual(store.load(id: older.id)?.title, "周会")

        // Junk next to the recordings is ignored, not crashed on.
        try FileManager.default.createDirectory(at: store.root.appendingPathComponent("not-a-uuid"), withIntermediateDirectories: true)
        try Data("{".utf8).write(to: store.root.appendingPathComponent(UUID().uuidString))
        XCTAssertEqual(store.list().count, 2)
    }

    func testCorruptOrMismatchedMetadataIsSkipped() throws {
        let meta = RecordingMetadata(title: "a")
        try store.create(meta)
        try Data("not json".utf8).write(to: try store.metadataURL(for: meta.id))
        XCTAssertNil(store.load(id: meta.id))
        // A meta.json whose id doesn't match its folder is not trusted.
        let other = RecordingMetadata(title: "b")
        try store.create(other)
        let data = try RecordingStore.encoder.encode(meta)
        try data.write(to: try store.metadataURL(for: other.id))
        XCTAssertNil(store.load(id: other.id))
    }

    func testMetadataDecodingToleratesMissingFields() throws {
        let id = UUID().uuidString
        let json = #"{"id":"\#(id)","title":"旧版本\n录音"}"#
        let meta = try RecordingStore.decoder.decode(RecordingMetadata.self, from: Data(json.utf8))
        XCTAssertEqual(meta.id, id)
        XCTAssertEqual(meta.title, "旧版本 录音", "titles are single-line")
        XCTAssertEqual(meta.state, .finished)
        XCTAssertFalse(meta.cloudTranscriptionEnabled, "cloud transcription is off unless chosen")
        XCTAssertEqual(meta.transcription.phase, .none)
    }

    func testEverythingIsExcludedFromBackup() throws {
        let meta = RecordingMetadata(title: "x")
        try store.create(meta)
        let chunk = try store.audioURL(for: meta.id, fileName: "chunk-000.m4a")
        try Data(repeating: 1, count: 64).write(to: chunk)
        try store.saveTranscript(RecordingTranscript(segments: [TranscriptSegment(start: 0, end: 1, text: "你好", unit: 0)]), id: meta.id)
        try store.saveOutputText("## 摘要", id: meta.id, outputId: UUID().uuidString)
        store.applyBackupExclusion(id: meta.id)
        XCTAssertTrue(RecordingStore.isExcludedFromBackup(store.root))
        XCTAssertTrue(RecordingStore.isExcludedFromBackup(try store.directory(for: meta.id)))
        XCTAssertTrue(RecordingStore.isExcludedFromBackup(chunk))
        XCTAssertTrue(RecordingStore.isExcludedFromBackup(try store.metadataURL(for: meta.id)))
        XCTAssertTrue(RecordingStore.isExcludedFromBackup(try store.transcriptURL(for: meta.id)))
    }

    func testDeleteRemovesTheWholeFolder() throws {
        let meta = RecordingMetadata(title: "x")
        try store.create(meta)
        try Data([1, 2, 3]).write(to: try store.audioURL(for: meta.id, fileName: "chunk-000.m4a"))
        try store.delete(id: meta.id)
        XCTAssertFalse(FileManager.default.fileExists(atPath: try store.directory(for: meta.id).path))
        XCTAssertNil(store.load(id: meta.id))
        XCTAssertNoThrow(try store.delete(id: meta.id), "deleting twice is fine")
        XCTAssertThrowsError(try store.delete(id: "../.."))
    }

    func testTranscriptAndOutputRoundTrip() throws {
        let meta = RecordingMetadata(title: "x")
        try store.create(meta)
        let t = RecordingTranscript(segments: [TranscriptSegment(start: 1, end: 2, text: "好的", speaker: 2, unit: 0)])
        try store.saveTranscript(t, id: meta.id)
        XCTAssertEqual(store.loadTranscript(id: meta.id)?.segments, t.segments)
        let oid = UUID().uuidString
        try store.saveOutputText("## 摘要\n内容", id: meta.id, outputId: oid)
        XCTAssertEqual(store.loadOutputText(id: meta.id, outputId: oid), "## 摘要\n内容")
    }

    func testContainsResolvesPrefixesSafely() {
        XCTAssertTrue(store.contains(store.root.appendingPathComponent(UUID().uuidString)))
        XCTAssertTrue(store.contains(store.root))
        XCTAssertFalse(store.contains(dir.appendingPathComponent("recordings-evil")))
        XCTAssertFalse(store.contains(dir))
    }

    /// The App's own backup package must never pick up recording audio — even if
    /// a walk reaches the recordings folder.
    func testBackupTreeExporterSkipsRecordingsRoot() throws {
        let tree = dir.appendingPathComponent("tree", isDirectory: true)
        let recordings = tree.appendingPathComponent("recordings", isDirectory: true)
        let rec = recordings.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: rec, withIntermediateDirectories: true)
        try Data(repeating: 7, count: 128).write(to: rec.appendingPathComponent("chunk-000.m4a"))
        try Data("keep".utf8).write(to: tree.appendingPathComponent("notes.txt"))

        let sink = try BackupZipWriter(url: dir.appendingPathComponent("sink.zip"))
        let blobs = BackupBlobStore(workDir: dir.appendingPathComponent("work", isDirectory: true),
                                    maxFileBytes: nil, sink: sink, encryptionKey: nil)
        let index = BackupFileIndexWriter(url: dir.appendingPathComponent("files.index.jsonl"))
        var exporter = BackupFileTreeExporter(blobStore: blobs, fileIndex: index)
        exporter.excludedRoots = [recordings]
        let result = try exporter.export(root: tree, logicalPrefix: "shared", category: .sharedFiles)
        XCTAssertEqual(result.filesIncluded, 1, "only notes.txt")

        // Pointing the walk straight at the recordings root exports nothing.
        let direct = try exporter.export(root: recordings, logicalPrefix: "shared", category: .sharedFiles)
        XCTAssertEqual(direct.filesIncluded, 0)
        index.close()
        try? sink.close()
    }

    func testDefaultExporterExcludesTheRealRecordingsRoot() throws {
        let sink = try BackupZipWriter(url: dir.appendingPathComponent("sink2.zip"))
        let blobs = BackupBlobStore(workDir: dir.appendingPathComponent("work2", isDirectory: true),
                                    maxFileBytes: nil, sink: sink, encryptionKey: nil)
        let exporter = BackupFileTreeExporter(blobStore: blobs,
                                              fileIndex: BackupFileIndexWriter(url: dir.appendingPathComponent("i.jsonl")))
        XCTAssertEqual(exporter.excludedRoots.map(\.path), [RecordingStore.defaultRoot.path])
        try? sink.close()
    }
}
