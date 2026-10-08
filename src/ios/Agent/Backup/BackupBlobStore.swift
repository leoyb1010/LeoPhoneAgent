import CryptoKit
import Foundation

private let logger = AppLogger(category: "Backup")

/// Content-addressed blob writer streaming straight into the package.
///
/// * Dedup: identical bytes referenced from several places are stored once
///   under their SHA-256 (`blobs/<2 hex>/<sha>`).
/// * Size cap: over-limit files are refused before any read and become
///   tombstones in `files.index.jsonl`.
/// * Snapshot per file: the source is first CLONED (APFS clonefile via
///   `copyItem`, O(1) on the same volume) and the clone is hashed and
///   packaged, so a file the app keeps writing during export can no longer
///   make the shipped bytes disagree with the recorded hash.
/// * Encryption: with a data key, each blob is sealed to `<path>.enc` before
///   it enters the package, so encrypted exports also stream (no second full
///   staging copy). Integrity records the hash of the bytes actually shipped.
final class BackupBlobStore {
    private let workDir: URL
    private let fm = FileManager.default
    private let maxFileBytes: Int64?
    private let sink: BackupZipWriter
    private let encryptionKey: SymmetricKey?

    var maxFileBytesForManifest: Int64? { maxFileBytes }

    private var seen = Set<String>()
    private(set) var blobIndex: [BackupBlobIndexEntry] = []
    /// Shipped member name → SHA-256 of the shipped bytes.
    private(set) var integrity: [String: String] = [:]
    private(set) var totalBytesStored: Int64 = 0
    private(set) var skippedFiles = 0
    private(set) var skippedBytes: Int64 = 0
    private(set) var skippedPaths: [(path: String, size: Int64)] = []

    init(workDir: URL, maxFileBytes: Int64?, sink: BackupZipWriter, encryptionKey: SymmetricKey?) {
        self.workDir = workDir
        self.maxFileBytes = maxFileBytes
        self.sink = sink
        self.encryptionKey = encryptionKey
        try? fm.createDirectory(at: workDir, withIntermediateDirectories: true)
    }

    static func packagePath(for digest: String) -> String {
        "blobs/\(digest.prefix(2))/\(digest)"
    }

    enum Outcome {
        case stored(sha256: String, size: Int64)
        case duplicate(sha256: String, size: Int64)
        case skippedTooLarge(size: Int64)
    }

    @discardableResult
    func addFile(at url: URL, logicalPath: String, sessionId: String? = nil) throws -> Outcome {
        let declared = (try? fm.attributesOfItem(atPath: url.path)[.size] as? Int64) ?? 0
        if let maxFileBytes, declared > maxFileBytes {
            return recordSkip(logicalPath, size: declared)
        }

        let clone = workDir.appendingPathComponent("clone-\(UUID().uuidString)")
        defer { try? fm.removeItem(at: clone) }
        try fm.copyItem(at: url, to: clone)
        let size = (try? fm.attributesOfItem(atPath: clone.path)[.size] as? Int64) ?? declared
        if let maxFileBytes, size > maxFileBytes {
            return recordSkip(logicalPath, size: size)
        }
        let digest = try Self.sha256OfFile(at: clone)
        if seen.contains(digest) { return .duplicate(sha256: digest, size: size) }
        try ship(clone, digest: digest)
        register(digest: digest, size: size, logicalPath: logicalPath, sessionId: sessionId, ext: url.pathExtension)
        return .stored(sha256: digest, size: size)
    }

    @discardableResult
    func addData(_ data: Data, logicalPath: String, sessionId: String? = nil) throws -> Outcome {
        let size = Int64(data.count)
        if let maxFileBytes, size > maxFileBytes { return recordSkip(logicalPath, size: size) }
        let digest = Self.sha256(data)
        if seen.contains(digest) { return .duplicate(sha256: digest, size: size) }
        let tmp = workDir.appendingPathComponent("data-\(UUID().uuidString)")
        defer { try? fm.removeItem(at: tmp) }
        try data.write(to: tmp)
        try ship(tmp, digest: digest)
        register(digest: digest, size: size, logicalPath: logicalPath, sessionId: sessionId,
                 ext: (logicalPath as NSString).pathExtension)
        return .stored(sha256: digest, size: size)
    }

    private func ship(_ plain: URL, digest: String) throws {
        let name = Self.packagePath(for: digest)
        if let encryptionKey {
            let sealed = workDir.appendingPathComponent("sealed-\(UUID().uuidString)")
            defer { try? fm.removeItem(at: sealed) }
            let shippedName = name + ".enc"
            try BackupCrypto.encryptFile(at: plain, to: sealed, key: encryptionKey, path: shippedName)
            integrity[shippedName] = try Self.sha256OfFile(at: sealed)
            try sink.addFile(at: sealed, name: shippedName)
        } else {
            integrity[name] = digest
            try sink.addFile(at: plain, name: name)
        }
    }

    private func register(digest: String, size: Int64, logicalPath: String, sessionId: String?, ext: String) {
        seen.insert(digest)
        totalBytesStored += size
        blobIndex.append(BackupBlobIndexEntry(sha256: digest, size: size, path: logicalPath,
                                              sessionId: sessionId, mime: Self.mimeType(forExtension: ext)))
    }

    private func recordSkip(_ path: String, size: Int64) -> Outcome {
        skippedFiles += 1
        skippedBytes += size
        skippedPaths.append((path, size))
        return .skippedTooLarge(size: size)
    }

    // MARK: - Hashing

    /// Streaming SHA-256 with a per-chunk autorelease pool (an un-drained
    /// "streaming" read still accumulates the whole file — upstream's jetsam).
    static func sha256OfFile(at url: URL) throws -> String {
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        var hasher = SHA256()
        while true {
            let done = try autoreleasepool { () -> Bool in
                let chunk = try handle.read(upToCount: 1024 * 1024) ?? Data()
                if chunk.isEmpty { return true }
                hasher.update(data: chunk)
                return false
            }
            if done { break }
        }
        return hasher.finalize().map { String(format: "%02x", $0) }.joined()
    }

    static func sha256(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    static func mimeType(forExtension ext: String) -> String? {
        switch ext.lowercased() {
        case "png": return "image/png"
        case "jpg", "jpeg": return "image/jpeg"
        case "gif": return "image/gif"
        case "webp": return "image/webp"
        case "heic": return "image/heic"
        case "pdf": return "application/pdf"
        case "txt", "log": return "text/plain"
        case "md": return "text/markdown"
        case "json": return "application/json"
        case "zip": return "application/zip"
        case "mp4", "m4v": return "video/mp4"
        case "mov": return "video/quicktime"
        case "mp3": return "audio/mpeg"
        case "m4a": return "audio/mp4"
        case "wav": return "audio/wav"
        default: return nil
        }
    }
}

// MARK: - Memory-pressure governor

/// Lets long scans brake under system memory pressure instead of charging
/// through CRITICAL until jetsam (upstream incident). Warning → 50 ms pause
/// per unit; critical → hold in 250 ms slices for up to 10 s.
final class BackupMemoryGovernor: @unchecked Sendable {
    static let shared = BackupMemoryGovernor()

    private enum Level { case normal, warning, critical }
    private let lock = NSLock()
    private var level: Level = .normal
    private let source: DispatchSourceMemoryPressure

    private init() {
        source = DispatchSource.makeMemoryPressureSource(eventMask: [.normal, .warning, .critical],
                                                         queue: DispatchQueue.global(qos: .utility))
        source.setEventHandler { [weak self] in
            guard let self else { return }
            let event = self.source.data
            let next: Level = event.contains(.critical) ? .critical : event.contains(.warning) ? .warning : .normal
            self.lock.lock()
            self.level = next
            self.lock.unlock()
        }
        source.activate()
    }

    private var currentLevel: Level {
        lock.lock(); defer { lock.unlock() }
        return level
    }

    func throttleIfNeeded() {
        switch currentLevel {
        case .normal: return
        case .warning: Thread.sleep(forTimeInterval: 0.05)
        case .critical:
            let start = Date()
            logger.warning("[Backup] memory pressure critical — pausing scan")
            while currentLevel == .critical, Date().timeIntervalSince(start) < 10 {
                Thread.sleep(forTimeInterval: 0.25)
            }
        }
    }
}
