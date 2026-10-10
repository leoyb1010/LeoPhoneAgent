import SwiftUI
import UIKit
import UniformTypeIdentifiers

private let logger = AppLogger(category: "Backup")

/// Hands a finished package to the user.
///
/// 1. Always: moved into `<App Group>/MinisFileProvider/Backups/` — visible in
///    the Files app under LeoBot, NOT inside `shared/` (that is bind-mounted
///    into the agent's sandbox and is itself a backup category).
/// 2. Optional: copied into folders the user mounted (WebDAV / SMB / cloud
///    providers via Files) using the existing coordinated-write helper.
/// 3. On demand: share sheet / "Save to Files".
enum BackupDelivery {

    static var contentType: UTType {
        UTType(BackupFormat.contentTypeIdentifier)
            ?? UTType(filenameExtension: BackupFormat.fileExtension)
            ?? .data
    }

    nonisolated static var backupsDirectory: URL {
        AIChatViewModel.minisAppGroupRoot.appendingPathComponent(BackupFormat.backupsDirectoryName, isDirectory: true)
    }

    /// Where unfinished exports, previews and staged packages live (tmp).
    static var workRoot: URL {
        FileManager.default.temporaryDirectory.appendingPathComponent("LeoBackup", isDirectory: true)
    }

    /// Persistent home of restore undo journals.
    static var journalBase: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
    }

    @discardableResult
    nonisolated static func moveToVisibleStorage(_ packageURL: URL) throws -> URL {
        let fm = FileManager.default
        try fm.createDirectory(at: backupsDirectory, withIntermediateDirectories: true)
        let dest = backupsDirectory.appendingPathComponent(packageURL.lastPathComponent)
        try? fm.removeItem(at: dest)
        try fm.moveItem(at: packageURL, to: dest)
        return dest
    }

    /// Packages already on this device, newest first.
    static func localPackages() -> [URL] {
        let fm = FileManager.default
        let urls = (try? fm.contentsOfDirectory(at: backupsDirectory,
                                                includingPropertiesForKeys: [.contentModificationDateKey, .fileSizeKey],
                                                options: [.skipsHiddenFiles])) ?? []
        return urls.filter { $0.pathExtension.lowercased() == BackupFormat.fileExtension }
            .sorted {
                let a = (try? $0.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast
                let b = (try? $1.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast
                return a > b
            }
    }

    /// Copy into a user-mounted folder via a `.partial` sibling, verify the
    /// size, then rename — a truncated transfer never appears under a valid
    /// `.minisbak` name. Off the main thread (coordinated I/O can block).
    nonisolated static func copyToMountedFolder(_ packageURL: URL, into root: URL) throws -> URL {
        let fm = FileManager.default
        try MountedFolderCoordinator.requireWritable(root)
        let dest = root.appendingPathComponent(packageURL.lastPathComponent)
        let partial = root.appendingPathComponent(".\(packageURL.lastPathComponent).partial")
        try? fm.removeItem(at: partial)
        do {
            try MountedFolderCoordinator.copy(from: packageURL, to: partial)
            let want = (try? fm.attributesOfItem(atPath: packageURL.path)[.size] as? Int64) ?? -1
            let got = (try? fm.attributesOfItem(atPath: partial.path)[.size] as? Int64) ?? -2
            guard want == got else {
                throw NSError(domain: "Backup", code: 1, userInfo: [
                    NSLocalizedDescriptionKey: String(localized: "复制校验失败：目标文件大小与备份不一致"),
                ])
            }
        } catch {
            try? fm.removeItem(at: partial)
            throw error
        }
        try? fm.removeItem(at: dest)
        try fm.moveItem(at: partial, to: dest)
        return dest
    }
}

// MARK: - Share sheet / Save to Files

/// Declares the concrete UTI so "Save to Files" copies the real bytes (a bare
/// tmp URL can save an empty file on iPad).
final class BackupActivityItemSource: NSObject, UIActivityItemSource {
    private let fileURL: URL

    init(fileURL: URL) {
        self.fileURL = fileURL
        super.init()
    }

    func activityViewControllerPlaceholderItem(_ controller: UIActivityViewController) -> Any { fileURL }

    func activityViewController(_ controller: UIActivityViewController,
                                itemForActivityType activityType: UIActivity.ActivityType?) -> Any? { fileURL }

    func activityViewController(_ controller: UIActivityViewController,
                                dataTypeIdentifierForActivityType activityType: UIActivity.ActivityType?) -> String {
        BackupFormat.contentTypeIdentifier
    }

    func activityViewController(_ controller: UIActivityViewController,
                                subjectForActivityType activityType: UIActivity.ActivityType?) -> String {
        fileURL.lastPathComponent
    }
}

struct BackupShareSheet: UIViewControllerRepresentable {
    let url: URL
    var onDismiss: (() -> Void)?

    func makeUIViewController(context: Context) -> UIActivityViewController {
        let controller = UIActivityViewController(activityItems: [BackupActivityItemSource(fileURL: url)],
                                                  applicationActivities: nil)
        controller.completionWithItemsHandler = { _, _, _, _ in onDismiss?() }
        return controller
    }

    func updateUIViewController(_ uiViewController: UIActivityViewController, context: Context) {}
}

struct BackupDocumentExportPicker: UIViewControllerRepresentable {
    let url: URL
    var onDismiss: (() -> Void)?

    func makeUIViewController(context: Context) -> UIDocumentPickerViewController {
        let picker = UIDocumentPickerViewController(forExporting: [url], asCopy: true)
        picker.shouldShowFileExtensions = true
        picker.delegate = context.coordinator
        return picker
    }

    func updateUIViewController(_ uiViewController: UIDocumentPickerViewController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(onDismiss: onDismiss) }

    final class Coordinator: NSObject, UIDocumentPickerDelegate {
        private let onDismiss: (() -> Void)?
        init(onDismiss: (() -> Void)?) { self.onDismiss = onDismiss }
        func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) { onDismiss?() }
        func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) { onDismiss?() }
    }
}
