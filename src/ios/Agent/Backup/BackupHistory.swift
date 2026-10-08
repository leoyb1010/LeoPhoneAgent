import Combine
import Foundation

private let logger = AppLogger(category: "Backup")

/// Every backup / restore run, kept 30 days (pruned by age, not count).
/// One JSON file in Application Support; decoding is hand-written so a field
/// added later never discards the user's whole history.
@MainActor
final class BackupHistory: ObservableObject {
    static let shared = BackupHistory(storeURL: BackupHistory.defaultStoreURL)

    static let retention: TimeInterval = 30 * 24 * 60 * 60
    static let maxStoredSkippedPaths = 300
    static let maxLogLines = 200

    enum Kind: String, Codable, Sendable { case export, restore }

    enum Status: String, Codable, Sendable {
        case running, succeeded, completedWithIssues, failed, cancelled
    }

    struct LogEntry: Codable, Identifiable, Sendable {
        var id: UUID = UUID()
        var at: Date
        var message: String
        var isProblem: Bool = false
        /// Replaced by the next transient line instead of stacking under it.
        var isTransient: Bool = false

        init(at: Date, message: String, isProblem: Bool = false, isTransient: Bool = false) {
            self.at = at; self.message = message; self.isProblem = isProblem; self.isTransient = isTransient
        }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            id = try c.decodeIfPresent(UUID.self, forKey: .id) ?? UUID()
            at = try c.decodeIfPresent(Date.self, forKey: .at) ?? Date(timeIntervalSince1970: 0)
            message = try c.decodeIfPresent(String.self, forKey: .message) ?? ""
            isProblem = try c.decodeIfPresent(Bool.self, forKey: .isProblem) ?? false
            isTransient = try c.decodeIfPresent(Bool.self, forKey: .isTransient) ?? false
        }
    }

    struct SkippedEntry: Codable, Identifiable, Sendable {
        var id: String { path }
        var path: String
        var size: Int64
        var fileName: String { (path as NSString).lastPathComponent }
    }

    /// Per-category outcome line for the detail view.
    struct CategoryLine: Codable, Identifiable, Sendable {
        var id: String { category }
        var category: String
        var summary: String
        var failed: Bool = false
    }

    struct Record: Codable, Identifiable, Sendable {
        var id: UUID = UUID()
        var kind: Kind = .export
        var backupId: String
        var startedAt: Date
        var finishedAt: Date?
        var status: Status
        var categories: [String]
        var encrypted: Bool
        var totalBytes: Int64 = 0
        var skippedFiles: Int = 0
        var skippedEntries: [SkippedEntry] = []
        var packageName: String?
        /// Where the package was delivered ("文件 App › LeoBot › Backups" etc.).
        var destinations: [String] = []
        var categoryLines: [CategoryLine] = []
        var log: [LogEntry] = []
        var errorMessage: String?

        var duration: TimeInterval? { finishedAt.map { $0.timeIntervalSince(startedAt) } }

        init(kind: Kind, backupId: String, startedAt: Date, status: Status,
             categories: [String], encrypted: Bool) {
            self.kind = kind; self.backupId = backupId; self.startedAt = startedAt
            self.status = status; self.categories = categories; self.encrypted = encrypted
        }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            id = try c.decodeIfPresent(UUID.self, forKey: .id) ?? UUID()
            kind = try c.decodeIfPresent(Kind.self, forKey: .kind) ?? .export
            backupId = try c.decodeIfPresent(String.self, forKey: .backupId) ?? ""
            startedAt = try c.decodeIfPresent(Date.self, forKey: .startedAt) ?? Date(timeIntervalSince1970: 0)
            finishedAt = try c.decodeIfPresent(Date.self, forKey: .finishedAt)
            status = (try? c.decodeIfPresent(Status.self, forKey: .status)) ?? .failed
            categories = try c.decodeIfPresent([String].self, forKey: .categories) ?? []
            encrypted = try c.decodeIfPresent(Bool.self, forKey: .encrypted) ?? false
            totalBytes = try c.decodeIfPresent(Int64.self, forKey: .totalBytes) ?? 0
            skippedFiles = try c.decodeIfPresent(Int.self, forKey: .skippedFiles) ?? 0
            skippedEntries = (try? c.decodeIfPresent([SkippedEntry].self, forKey: .skippedEntries)) ?? []
            packageName = try c.decodeIfPresent(String.self, forKey: .packageName)
            destinations = (try? c.decodeIfPresent([String].self, forKey: .destinations)) ?? []
            categoryLines = (try? c.decodeIfPresent([CategoryLine].self, forKey: .categoryLines)) ?? []
            log = (try? c.decodeIfPresent([LogEntry].self, forKey: .log)) ?? []
            errorMessage = try c.decodeIfPresent(String.self, forKey: .errorMessage)
        }
    }

    @Published private(set) var records: [Record] = []
    private let storeURL: URL

    static var defaultStoreURL: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("BackupHistory", isDirectory: true)
            .appendingPathComponent("history.json")
    }

    init(storeURL: URL) {
        self.storeURL = storeURL
        load()
        pruneExpired()
    }

    private func load() {
        guard let data = try? Data(contentsOf: storeURL) else { return }
        records = (try? BackupDates.decoder().decode([Record].self, from: data)) ?? []
    }

    private func save() {
        do {
            try FileManager.default.createDirectory(at: storeURL.deletingLastPathComponent(),
                                                    withIntermediateDirectories: true)
            try BackupDates.encoder().encode(records).write(to: storeURL, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        } catch {
            logger.warning("[Backup] couldn't save history")
        }
    }

    func pruneExpired(now: Date = Date()) {
        let cutoff = now.addingTimeInterval(-Self.retention)
        let before = records.count
        records.removeAll { ($0.finishedAt ?? $0.startedAt) < cutoff }
        if records.count != before { save() }
    }

    @discardableResult
    func begin(kind: Kind, backupId: String, categories: [String], encrypted: Bool) -> UUID {
        pruneExpired()
        let r = Record(kind: kind, backupId: backupId, startedAt: Date(), status: .running,
                       categories: categories, encrypted: encrypted)
        records.insert(r, at: 0)
        save()
        return r.id
    }

    func setBackupId(_ id: UUID, _ backupId: String) {
        mutate(id) { $0.backupId = backupId }
    }

    func log(_ id: UUID, _ message: String, isProblem: Bool = false, isTransient: Bool = false) {
        mutate(id) { r in
            if r.log.last?.message == message { return }
            if r.log.last?.isTransient == true { r.log.removeLast() }
            r.log.append(LogEntry(at: Date(), message: message, isProblem: isProblem, isTransient: isTransient))
            if r.log.count > Self.maxLogLines { r.log.removeFirst(r.log.count - Self.maxLogLines) }
        }
    }

    func finish(_ id: UUID, status: Status = .succeeded, totalBytes: Int64 = 0, skippedFiles: Int = 0,
                skippedEntries: [SkippedEntry] = [], packageName: String? = nil,
                destinations: [String] = [], categoryLines: [CategoryLine] = []) {
        mutate(id) { r in
            r.finishedAt = Date()
            r.status = status
            r.totalBytes = totalBytes
            r.skippedFiles = skippedFiles
            r.skippedEntries = Array(skippedEntries.sorted { $0.size > $1.size }.prefix(Self.maxStoredSkippedPaths))
            r.packageName = packageName
            r.destinations = destinations
            r.categoryLines = categoryLines
            if r.log.last?.isTransient == true { r.log.removeLast() }
        }
    }

    func fail(_ id: UUID, message: String, cancelled: Bool = false) {
        mutate(id) { r in
            r.finishedAt = Date()
            r.status = cancelled ? .cancelled : .failed
            r.errorMessage = message
            if r.log.last?.isTransient == true { r.log.removeLast() }
            r.log.append(LogEntry(at: Date(), message: message, isProblem: !cancelled))
        }
    }

    /// Runs left `.running` by a killed process.
    func reconcileInterrupted() {
        var changed = false
        for i in records.indices where records[i].status == .running {
            records[i].status = .failed
            records[i].finishedAt = records[i].finishedAt ?? Date()
            records[i].errorMessage = records[i].kind == .export
                ? String(localized: "已中断：App 在备份完成前被关闭，请重新备份")
                : String(localized: "已中断：App 在恢复完成前被关闭，未完成的部分已撤销，可重新恢复")
            changed = true
        }
        if changed { save() }
    }

    func remove(_ id: UUID) {
        records.removeAll { $0.id == id }
        save()
    }

    func record(_ id: UUID) -> Record? { records.first { $0.id == id } }

    private func mutate(_ id: UUID, _ change: (inout Record) -> Void) {
        guard let i = records.firstIndex(where: { $0.id == id }) else { return }
        change(&records[i])
        save()
    }
}
