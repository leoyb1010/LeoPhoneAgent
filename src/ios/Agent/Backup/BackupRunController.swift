import Foundation
import UIKit

private let logger = AppLogger(category: "Backup")

/// Owns the one backup or restore that may be running, so any screen can
/// observe or stop it and a dismissed view can't orphan a running job.
///
/// Long runs hold a UIKit background-task assertion plus the app's existing
/// iOS 26 continued-processing grant (`AgentContinuedProcessingManager`, the
/// already-registered `processing` mode — no new background mode, no audio
/// keep-alive). If iOS takes the grant away the run is CANCELLED cleanly:
/// an export leaves no package behind, a restore rolls back the category in
/// flight; re-running converges because restore is a merge.
@MainActor
final class BackupRunController: ObservableObject {
    static let shared = BackupRunController()

    enum Activity: Equatable { case idle, exporting, restoring }

    struct ExportRequest {
        var categories: Set<BackupCategory>
        var passphrase: String?
        var maxFileBytes: Int64?
        var mountedFolderIds: [UUID] = []
    }

    struct ExportOutcome: Identifiable {
        var id: UUID { recordId }
        var recordId: UUID
        var packageURL: URL
        var summary: BackupExporter.Summary
        var deliveryFailures: [String]
    }

    @Published private(set) var activity: Activity = .idle
    @Published private(set) var statusText = ""
    @Published private(set) var lastExport: ExportOutcome?
    @Published private(set) var lastError: String?

    private var task: Task<Void, Never>?
    private var continuedKey: String?

    var isRunning: Bool { activity != .idle }

    private init() {}

    // MARK: - Export

    @discardableResult
    func startExport(_ request: ExportRequest) -> Bool {
        guard activity == .idle else { return false }
        let history = BackupHistory.shared
        let categories = BackupCategory.backupable.filter(request.categories.contains)
        let encrypted = !(request.passphrase ?? "").isEmpty
        let recordId = history.begin(kind: .export, backupId: "", categories: categories.map(\.rawValue),
                                     encrypted: encrypted)
        activity = .exporting
        lastError = nil
        statusText = String(localized: "准备备份…")

        let progress = progressSink(recordId: recordId)
        task = Task { [weak self] in
            guard let self else { return }
            let bg = self.beginBackground(name: "LeoBot backup", title: String(localized: "LeoBot 备份"))
            defer { self.endBackground(bg, success: self.lastError == nil) }
            do {
                let exporter = BackupExporter(source: LiveBackupStores(), workRoot: BackupDelivery.workRoot)
                let summary = try await exporter.export(
                    options: .init(categories: Set(categories), maxFileBytes: request.maxFileBytes,
                                   passphrase: request.passphrase),
                    progress: progress)
                history.setBackupId(recordId, summary.backupId)
                // File move (may be a copy across containers): off the main actor.
                let packageURL = summary.packageURL
                let delivered = try await Task.detached(priority: .utility) {
                    try BackupDelivery.moveToVisibleStorage(packageURL)
                }.value
                var destinations = [String(localized: "文件 App › 我的 iPhone › LeoBot › Backups")]
                var failures: [String] = []
                for folderId in request.mountedFolderIds {
                    guard let root = MountedFoldersManager.shared.resolvedURL(for: folderId) else {
                        failures.append(String(localized: "挂载的文件夹不可用"))
                        continue
                    }
                    let name = MountedFoldersManager.shared.entries.first { $0.id == folderId }?.name ?? root.lastPathComponent
                    history.log(recordId, String(localized: "正在复制到「\(name)」…"))
                    do {
                        _ = try await Task.detached(priority: .utility) {
                            try BackupDelivery.copyToMountedFolder(delivered, into: root)
                        }.value
                        destinations.append(String(localized: "挂载文件夹「\(name)」"))
                    } catch {
                        failures.append(String(localized: "复制到「\(name)」失败：\(error.localizedDescription)"))
                        history.log(recordId, failures.last ?? "", isProblem: true)
                    }
                }
                let lines = categories.map { c -> BackupHistory.CategoryLine in
                    let s = summary.categories[c.rawValue]
                    return .init(category: c.rawValue, summary: Self.exportLine(c, s))
                }
                history.finish(recordId, status: failures.isEmpty ? .succeeded : .completedWithIssues,
                               totalBytes: summary.totalBytes, skippedFiles: summary.skippedFiles,
                               skippedEntries: summary.skippedPaths, packageName: delivered.lastPathComponent,
                               destinations: destinations, categoryLines: lines)
                self.lastExport = ExportOutcome(recordId: recordId, packageURL: delivered,
                                                summary: summary, deliveryFailures: failures)
            } catch {
                let cancelled = error is CancellationError || Task.isCancelled
                let message = cancelled ? String(localized: "已取消，未生成备份包") : error.localizedDescription
                history.fail(recordId, message: message, cancelled: cancelled)
                self.lastError = message
            }
            self.activity = .idle
            self.statusText = ""
            self.task = nil
        }
        return true
    }

    private static func exportLine(_ c: BackupCategory, _ s: BackupManifest.CategoryStat?) -> String {
        guard let s else { return String(localized: "无数据") }
        let size = ByteCountFormatter.string(fromByteCount: s.bytes, countStyle: .file)
        switch c {
        case .chats: return String(localized: "\(s.messages ?? 0) 条消息、\(s.files ?? 0) 个文件，\(size)")
        case .skills: return String(localized: "\(s.entries) 个技能、\(s.files ?? 0) 个文件，\(size)")
        case .providers:
            return s.includesCredentials == true
                ? String(localized: "\(s.entries) 个服务商（含加密密钥）")
                : String(localized: "\(s.entries) 个服务商（不含密钥）")
        default: return String(localized: "\(s.entries) 项，\(size)")
        }
    }

    // MARK: - Restore

    @discardableResult
    func startRestore(importer: BackupImporter, prepared: BackupImporter.Prepared,
                      categories: Set<BackupCategory>,
                      completion: @escaping @MainActor (Result<BackupImporter.Report, Error>) -> Void) -> Bool {
        guard activity == .idle else { return false }
        let history = BackupHistory.shared
        let selected = BackupCategory.restoreOrder.filter(categories.contains)
        let recordId = history.begin(kind: .restore, backupId: prepared.manifest.backupId,
                                     categories: selected.map(\.rawValue), encrypted: prepared.wasEncrypted)
        history.log(recordId, String(localized: "来源：\(prepared.packageName)"))
        activity = .restoring
        lastError = nil
        statusText = String(localized: "准备恢复…")
        let progress = progressSink(recordId: recordId)
        task = Task { [weak self] in
            guard let self else { return }
            let bg = self.beginBackground(name: "LeoBot restore", title: String(localized: "LeoBot 恢复"))
            var ok = false
            defer { self.endBackground(bg, success: ok) }
            do {
                let report = try await importer.apply(prepared, categories: Set(selected), progress: progress)
                let lines = report.categories.map {
                    BackupHistory.CategoryLine(category: $0.category.rawValue, summary: $0.summary,
                                               failed: $0.failed != nil)
                }
                for w in report.warnings { history.log(recordId, w, isProblem: true) }
                for c in report.categories { for n in c.needsAttention { history.log(recordId, "\(c.category.displayName)：\(n)", isProblem: true) } }
                let status: BackupHistory.Status = report.cancelled ? .cancelled
                    : (report.hasIssues ? .completedWithIssues : .succeeded)
                history.finish(recordId, status: status, categoryLines: lines)
                ok = !report.hasFailures
                completion(.success(report))
            } catch {
                let cancelled = error is CancellationError
                history.fail(recordId, message: cancelled ? String(localized: "已取消") : error.localizedDescription,
                             cancelled: cancelled)
                self.lastError = error.localizedDescription
                completion(.failure(error))
            }
            self.activity = .idle
            self.statusText = ""
            self.task = nil
        }
        return true
    }

    /// Stop at the next checkpoint (per file / per session / per category).
    func stop() {
        task?.cancel()
        statusText = String(localized: "正在停止…")
    }

    // MARK: - Plumbing

    private func progressSink(recordId: UUID) -> @Sendable (String, Bool) -> Void {
        { text, transient in
            Task { @MainActor in
                BackupHistory.shared.log(recordId, text, isTransient: transient)
                BackupRunController.shared.statusText = text
                BackupRunController.shared.noteContinuedProgress(text)
            }
        }
    }

    private struct BackgroundGrant {
        var taskId: UIBackgroundTaskIdentifier
        var continuedKey: String
    }

    private func beginBackground(name: String, title: String) -> BackgroundGrant {
        let id = UIApplication.shared.beginBackgroundTask(withName: name) { [weak self] in
            // Expiry: stop cleanly rather than be frozen mid-write.
            Task { @MainActor in self?.stop() }
        }
        let key = "backup-\(UUID().uuidString)"
        continuedKey = key
        AgentContinuedProcessingManager.shared.begin(sessionKey: key, title: title,
                                                     subtitle: String(localized: "正在处理…"),
                                                     onExpiration: { [weak self] in self?.stop() })
        return BackgroundGrant(taskId: id, continuedKey: key)
    }

    private func endBackground(_ grant: BackgroundGrant, success: Bool) {
        AgentContinuedProcessingManager.shared.finish(sessionKey: grant.continuedKey, success: success,
                                                      subtitle: success ? String(localized: "已完成") : String(localized: "未完成"))
        continuedKey = nil
        if grant.taskId != .invalid { UIApplication.shared.endBackgroundTask(grant.taskId) }
    }

    fileprivate func noteContinuedProgress(_ text: String) {
        guard let continuedKey else { return }
        AgentContinuedProcessingManager.shared.noteProgress(sessionKey: continuedKey, subtitle: text)
    }
}

/// Launch-time housekeeping: undo any restore category a killed process left
/// half-applied, sweep abandoned export/preview leftovers, close history rows
/// stuck in "running".
enum BackupLaunchMaintenance {
    static func run() {
        let roots: [BackupRestoreJournal.Root: URL] = [
            .chats: AIChatViewModel.minisPersistentBase,
            .shared: AIChatViewModel.minisSharedPersistentDir,
            .memory: AIChatViewModel.minisMemoryPersistentDir,
        ]
        let base = BackupDelivery.journalBase
        let workRoot = BackupDelivery.workRoot
        Task.detached(priority: .utility) {
            let reconciled = BackupRestoreJournal.reconcileAtLaunch(base: base, roots: roots)
            BackupExportJournal.sweepAbandoned(workRoot: workRoot)
            await MainActor.run {
                guard !BackupRunController.shared.isRunning else { return }
                BackupHistory.shared.reconcileInterrupted()
                if !reconciled.isEmpty { logger.warning("[Restore] reconciled \(reconciled.count) interrupted restore run(s)") }
            }
        }
    }
}
