import Foundation

private let logger = AppLogger(category: "Backup")

/// Walks a directory tree into the package: content into the blob store,
/// structure into `files.index.jsonl`. Shared by Chats' `<sid>/` trees,
/// Shared Files and Skills so the size cap, dedup, placeholder handling and
/// snapshot cut-off behave identically everywhere.
struct BackupFileTreeExporter {
    let blobStore: BackupBlobStore
    let fileIndex: BackupFileIndexWriter
    /// Files modified clearly AFTER this instant are not part of this backup.
    /// Asymmetric on purpose: anything ambiguous is INCLUDED (wrongly
    /// including costs bytes; wrongly excluding silently loses data).
    var snapshotAt: Date = .distantFuture
    /// Directory names skipped wholesale (e.g. a skill's `node_modules`).
    var isExcludedDirectory: @Sendable (String) -> Bool = { _ in false }
    /// How long to wait for one iCloud placeholder to download.
    var downloadTimeout: TimeInterval = 20
    /// [V-rec] Trees never packaged, wherever they turn up (a symlinked or
    /// mis-rooted walk included): recording audio stays on this device only.
    var excludedRoots: [URL] = [RecordingStore.defaultRoot]

    struct Result {
        var filesIncluded = 0
        var filesSkipped = 0
        var bytesIncluded: Int64 = 0
        var directories = 0
        var filesNotDownloaded = 0
        var filesAfterSnapshot = 0
    }

    @discardableResult
    func export(root: URL, logicalPrefix: String, category: BackupCategory,
                sessionId: String? = nil) throws -> Result {
        var result = Result()
        let fm = FileManager.default
        var isDir: ObjCBool = false
        guard fm.fileExists(atPath: root.path, isDirectory: &isDir), isDir.boolValue else { return result }
        guard !isExcludedRoot(root) else { return result }

        let keys: [URLResourceKey] = [.isRegularFileKey, .isDirectoryKey, .isSymbolicLinkKey,
                                      .fileSizeKey, .contentModificationDateKey]
        guard let enumerator = fm.enumerator(at: root, includingPropertiesForKeys: keys,
                                             options: [.skipsHiddenFiles]) else { return result }
        var scanned = 0
        for case let url as URL in enumerator {
            scanned += 1
            if scanned % 32 == 0 { try Task.checkCancellation() }

            guard let rel = BackupPaths.relativePath(of: url, under: root) else { continue }
            let logicalPath = "\(logicalPrefix)/\(rel)"
            let values = try? url.resourceValues(forKeys: Set(keys))

            // Never follow links out of the tree, never package a package.
            if values?.isSymbolicLink == true { continue }
            // Directories only: the excluded trees are directories, and one
            // check per directory keeps the per-file cost of a big backup flat.
            if values?.isDirectory == true, isExcludedRoot(url) {
                enumerator.skipDescendants()
                continue
            }
            if isBackupArtifact(rel) {
                if values?.isDirectory == true { enumerator.skipDescendants() }
                continue
            }
            if values?.isDirectory == true {
                if isExcludedDirectory(url.lastPathComponent) {
                    enumerator.skipDescendants()
                    continue
                }
                fileIndex.write(.directory(path: logicalPath, category: category))
                result.directories += 1
                continue
            }
            guard values?.isRegularFile == true else { continue }

            let mtime = values?.contentModificationDate
            if snapshotAt != .distantFuture, let mtime, mtime > snapshotAt {
                result.filesAfterSnapshot += 1
                continue
            }

            if case .notDownloaded(let size) = ensureLocallyAvailable(url) {
                fileIndex.write(.notDownloaded(path: logicalPath, size: size, category: category))
                result.filesSkipped += 1
                result.filesNotDownloaded += 1
                continue
            }

            BackupMemoryGovernor.shared.throttleIfNeeded()
            autoreleasepool {
                do {
                    switch try blobStore.addFile(at: url, logicalPath: logicalPath, sessionId: sessionId) {
                    case .stored(let sha, let size), .duplicate(let sha, let size):
                        fileIndex.write(.file(path: logicalPath, size: size, sha256: sha, category: category,
                                              mtime: mtime?.timeIntervalSince1970))
                        result.filesIncluded += 1
                        result.bytesIncluded += size
                    case .skippedTooLarge(let size):
                        fileIndex.write(.sizeSkipped(path: logicalPath, size: size, category: category))
                        result.filesSkipped += 1
                    }
                } catch {
                    // One unreadable file must not abort a multi-GB backup;
                    // the tombstone keeps the gap visible.
                    let size = Int64(values?.fileSize ?? 0)
                    fileIndex.write(.unreadable(path: logicalPath, size: size, category: category))
                    result.filesSkipped += 1
                }
            }
        }
        return result
    }

    private func isExcludedRoot(_ url: URL) -> Bool {
        excludedRoots.contains { RecordingStore(root: $0).contains(url) }
    }

    private func isBackupArtifact(_ rel: String) -> Bool {
        if rel.lowercased().hasSuffix("." + BackupFormat.fileExtension) { return true }
        return rel.split(separator: "/").first.map(String.init) == BackupFormat.backupsDirectoryName
    }

    enum DownloadOutcome {
        case ready
        case notDownloaded(size: Int64)
    }

    /// An undownloaded iCloud placeholder reads back as a 0-byte regular file;
    /// packaging it would later overwrite the user's real file with nothing.
    /// Ask for the download, wait a bounded time, else tombstone it.
    private func ensureLocallyAvailable(_ url: URL) -> DownloadOutcome {
        let keys: Set<URLResourceKey> = [.isUbiquitousItemKey, .ubiquitousItemDownloadingStatusKey, .fileSizeKey]
        guard let values = try? url.resourceValues(forKeys: keys), values.isUbiquitousItem == true else {
            return .ready
        }
        if values.ubiquitousItemDownloadingStatus == .current { return .ready }
        let logicalSize = Int64(values.fileSize ?? 0)
        guard !Thread.isMainThread else { return .notDownloaded(size: logicalSize) }
        try? FileManager.default.startDownloadingUbiquitousItem(at: url)
        let deadline = Date().addingTimeInterval(downloadTimeout)
        while Date() < deadline {
            var fresh = url
            fresh.removeAllCachedResourceValues()
            if (try? fresh.resourceValues(forKeys: keys))?.ubiquitousItemDownloadingStatus == .current {
                return .ready
            }
            Thread.sleep(forTimeInterval: 0.2)
        }
        logger.warning("[Backup] a file is still not downloaded from iCloud — recorded as missing")
        return .notDownloaded(size: logicalSize)
    }
}

/// Buffered writer for `files.index.jsonl` (bare entries, not envelopes).
final class BackupFileIndexWriter {
    private let url: URL
    private var handle: FileHandle?
    private let encoder: JSONEncoder = {
        let e = JSONEncoder()
        e.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return e
    }()
    private(set) var count = 0
    private(set) var writeFailures = 0

    init(url: URL) { self.url = url }

    func write(_ entry: BackupFileIndexEntry) {
        do {
            if handle == nil {
                try FileManager.default.createDirectory(at: url.deletingLastPathComponent(),
                                                        withIntermediateDirectories: true)
                if !FileManager.default.fileExists(atPath: url.path) {
                    FileManager.default.createFile(atPath: url.path, contents: nil)
                }
                handle = try FileHandle(forWritingTo: url)
                try handle?.seekToEnd()
            }
            var line = try encoder.encode(entry)
            line.append(0x0A)
            try handle?.write(contentsOf: line)
            count += 1
        } catch {
            writeFailures += 1
        }
    }

    func close() {
        try? handle?.close()
        handle = nil
    }

    /// Bounded, tolerant read of a package's file index.
    static func read(_ url: URL) -> [BackupFileIndexEntry] {
        guard let data = BackupJSONFile.read(url) else { return [] }
        let decoder = JSONDecoder()
        var out: [BackupFileIndexEntry] = []
        for line in data.split(separator: 0x0A) where !line.isEmpty {
            if let e = try? decoder.decode(BackupFileIndexEntry.self, from: Data(line)) { out.append(e) }
        }
        return out
    }
}
