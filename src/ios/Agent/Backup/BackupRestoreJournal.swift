import Foundation

private let logger = AppLogger(category: "Backup")

/// Undo journal for one restore run (replaces upstream's whole-directory
/// copy-aside snapshots, which copied the ENTIRE shared/memory trees — GBs —
/// to undo a merge that usually touches a handful of files).
///
/// Every file a restore creates or replaces is journaled BEFORE it is
/// touched: a replaced file's previous bytes are cloned into the run's
/// `saved/` directory first. Rolling a category back replays its operations
/// in reverse. The journal is append-only JSONL on persistent storage, so a
/// restore killed mid-category (jetsam, crash) is undone at the next launch.
///
/// Paths are stored RELATIVE to a named root (`chats`, `shared`, `memory`),
/// because an app container's absolute path is not stable across updates.
final class BackupRestoreJournal: @unchecked Sendable {

    enum Root: String, Codable, Sendable {
        case chats, shared, memory
    }

    struct Op: Codable, Sendable {
        enum Kind: String, Codable, Sendable {
            case beginCategory, endCategory, create, replace, createDirectory
        }
        var kind: Kind
        var category: String
        var root: Root?
        var path: String?
        /// For `.replace`: file name of the saved copy under `saved/`.
        var saved: String?
    }

    struct Header: Codable, Sendable {
        var backupId: String
        var startedAt: Date
        var categories: [String]
    }

    let runDir: URL
    private let opsURL: URL
    private let savedDir: URL
    private let lock = NSLock()
    private var handle: FileHandle?
    private var ops: [Op] = []

    /// Every run lives in its own directory so two runs can never delete each
    /// other's undo state.
    static func runsRoot(in base: URL) -> URL {
        base.appendingPathComponent("BackupRestore", isDirectory: true)
    }

    static func begin(base: URL, header: Header) throws -> BackupRestoreJournal {
        let runDir = runsRoot(in: base).appendingPathComponent("run-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: runDir.appendingPathComponent("saved"),
                                                withIntermediateDirectories: true)
        try BackupDates.encoder().encode(header).write(to: runDir.appendingPathComponent("header.json"),
                                                      options: .atomic)
        return try BackupRestoreJournal(runDir: runDir)
    }

    private init(runDir: URL) throws {
        self.runDir = runDir
        self.opsURL = runDir.appendingPathComponent("ops.jsonl")
        self.savedDir = runDir.appendingPathComponent("saved", isDirectory: true)
        if !FileManager.default.fileExists(atPath: opsURL.path) {
            FileManager.default.createFile(atPath: opsURL.path, contents: nil)
        }
        handle = try FileHandle(forWritingTo: opsURL)
        try handle?.seekToEnd()
    }

    private func append(_ op: Op) throws {
        lock.lock(); defer { lock.unlock() }
        var line = try JSONEncoder().encode(op)
        line.append(0x0A)
        try handle?.write(contentsOf: line)
        // fsync only where losing the line could lose user data: a replaced
        // file's undo record. A lost `create` line merely leaves one extra
        // restored file behind, which a re-run treats as identical.
        if op.kind == .replace || op.kind == .beginCategory { try handle?.synchronize() }
        ops.append(op)
    }

    func beginCategory(_ c: BackupCategory) throws { try append(Op(kind: .beginCategory, category: c.rawValue)) }
    func endCategory(_ c: BackupCategory) throws { try append(Op(kind: .endCategory, category: c.rawValue)) }

    /// Record that `path` (relative to `root`) is about to be created.
    func willCreate(_ category: BackupCategory, root: Root, path: String) throws {
        try append(Op(kind: .create, category: category.rawValue, root: root, path: path))
    }

    func willCreateDirectory(_ category: BackupCategory, root: Root, path: String) throws {
        try append(Op(kind: .createDirectory, category: category.rawValue, root: root, path: path))
    }

    /// Save the current bytes of `live` and record the replacement.
    func willReplace(_ category: BackupCategory, root: Root, path: String, live: URL) throws {
        let savedName = UUID().uuidString
        try FileManager.default.copyItem(at: live, to: savedDir.appendingPathComponent(savedName))
        try append(Op(kind: .replace, category: category.rawValue, root: root, path: path, saved: savedName))
    }

    /// Undo every file operation of `category`, newest first.
    func rollback(_ category: BackupCategory, roots: [Root: URL]) {
        lock.lock()
        let mine = ops.filter { $0.category == category.rawValue }
        lock.unlock()
        Self.undo(mine, savedDir: savedDir, roots: roots)
    }

    func close() {
        try? handle?.close()
        handle = nil
    }

    /// Clean finish: the undo state is no longer needed.
    func finish() {
        close()
        try? FileManager.default.removeItem(at: runDir)
    }

    // MARK: - Undo

    private static func undo(_ ops: [Op], savedDir: URL, roots: [Root: URL]) {
        let fm = FileManager.default
        var undone = 0
        for op in ops.reversed() {
            guard let rootKind = op.root, let rootURL = roots[rootKind], let rel = op.path,
                  let comps = BackupPaths.safeComponents(rel) else { continue }
            let live = comps.reduce(rootURL) { $0.appendingPathComponent($1) }
            guard BackupPaths.isContained(live, within: rootURL) else { continue }
            switch op.kind {
            case .create:
                if (try? fm.removeItem(at: live)) != nil { undone += 1 }
            case .createDirectory:
                // Only remove if we left it empty; anything else in it isn't ours.
                if (try? fm.contentsOfDirectory(atPath: live.path))?.isEmpty == true {
                    try? fm.removeItem(at: live)
                }
            case .replace:
                guard let savedName = op.saved else { continue }
                let saved = savedDir.appendingPathComponent(savedName)
                guard fm.fileExists(atPath: saved.path) else { continue }
                if fm.fileExists(atPath: live.path) {
                    if (try? fm.replaceItemAt(live, withItemAt: saved)) != nil { undone += 1 }
                } else if (try? fm.moveItem(at: saved, to: live)) != nil {
                    undone += 1
                }
            case .beginCategory, .endCategory:
                continue
            }
        }
        if undone > 0 { logger.info("[Restore] rolled back \(undone) file operation(s)") }
    }

    // MARK: - Launch reconcile

    struct Reconciled: Sendable {
        var backupId: String
        var interruptedCategories: [String]
    }

    /// Undo the file operations of any category that began but never ended in
    /// a run that never finished, then delete the run. Completed categories
    /// are kept (a failed later category does not undo earlier ones).
    @discardableResult
    static func reconcileAtLaunch(base: URL, roots: [Root: URL]) -> [Reconciled] {
        let fm = FileManager.default
        let runsDir = runsRoot(in: base)
        var out: [Reconciled] = []
        for name in (try? fm.contentsOfDirectory(atPath: runsDir.path)) ?? [] where name.hasPrefix("run-") {
            let runDir = runsDir.appendingPathComponent(name, isDirectory: true)
            let header = (try? Data(contentsOf: runDir.appendingPathComponent("header.json")))
                .flatMap { try? BackupDates.decoder().decode(Header.self, from: $0) }
            var ops: [Op] = []
            if let data = try? Data(contentsOf: runDir.appendingPathComponent("ops.jsonl")) {
                for line in data.split(separator: 0x0A) where !line.isEmpty {
                    if let op = try? JSONDecoder().decode(Op.self, from: Data(line)) { ops.append(op) }
                }
            }
            let begun = Set(ops.filter { $0.kind == .beginCategory }.map(\.category))
            let ended = Set(ops.filter { $0.kind == .endCategory }.map(\.category))
            let open = begun.subtracting(ended)
            undo(ops.filter { open.contains($0.category) },
                 savedDir: runDir.appendingPathComponent("saved"), roots: roots)
            try? fm.removeItem(at: runDir)
            out.append(Reconciled(backupId: header?.backupId ?? "?", interruptedCategories: open.sorted()))
            logger.error("[Restore] previous restore did not finish; undid \(open.count) open categor(ies)")
        }
        return out
    }
}
