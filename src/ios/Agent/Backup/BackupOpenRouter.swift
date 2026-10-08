import SwiftUI
import UIKit

private let logger = AppLogger(category: "Backup")

/// Routes a `.minisbak` opened from outside the app (Files, AirDrop, share
/// sheet) into the restore flow instead of attaching it to a chat.
///
/// The incoming URL is security-scoped and only valid inside start/stop, so
/// the package is copied (coordinated, so an iCloud placeholder downloads)
/// into the app's own tmp first. The restore screen is presented from the
/// top-most view controller — deliberately NOT another `.sheet` on the
/// WindowGroup root, whose modifier chain is already at the generic-depth
/// limit that crashes launch.
@MainActor
enum BackupOpenRouter {

    nonisolated static func isBackupPackage(_ url: URL) -> Bool {
        url.isFileURL && url.pathExtension.lowercased() == BackupFormat.fileExtension
    }

    /// Present the restore flow for a package `stage(_:)` already copied in
    /// (nil = staging failed). Called from `ExternalFileImporter.ingest`,
    /// which stages synchronously while the security scope is still held.
    static func presentStaged(_ staged: URL?) {
        guard let staged else {
            presentAlert(String(localized: "无法读取这个备份文件"))
            return
        }
        // Give a dismissing sheet a beat so the presentation isn't dropped.
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 350_000_000)
            present(packageURL: staged, ownsFile: true)
        }
    }

    /// Copy into `<tmp>/LeoBackup/opened-<uuid>.minisbak`.
    nonisolated static func stage(_ url: URL) -> URL? {
        let fm = FileManager.default
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        try? fm.createDirectory(at: BackupDelivery.workRoot, withIntermediateDirectories: true)
        let dest = BackupDelivery.workRoot.appendingPathComponent("opened-\(UUID().uuidString).\(BackupFormat.fileExtension)")
        var coordErr: NSError?
        var copyErr: Error?
        NSFileCoordinator().coordinate(readingItemAt: url, options: [], error: &coordErr) { readURL in
            do { try fm.copyItem(at: readURL, to: dest) } catch { copyErr = error }
        }
        guard coordErr == nil, copyErr == nil else {
            try? fm.removeItem(at: dest)
            logger.error("[Restore] couldn't stage an opened package")
            return nil
        }
        return dest
    }

    static func present(packageURL: URL, ownsFile: Bool) {
        guard let top = topViewController() else {
            logger.error("[Restore] no window to present restore")
            if ownsFile { try? FileManager.default.removeItem(at: packageURL) }
            return
        }
        weak var presented: UIViewController?
        let host = UIHostingController(rootView: NavigationStack {
            BackupRestoreView(initialPackage: packageURL, ownsInitialPackage: ownsFile,
                              onClose: { presented?.dismiss(animated: true) })
        })
        presented = host
        host.modalPresentationStyle = .formSheet
        host.isModalInPresentation = true
        top.present(host, animated: true)
    }

    private static func presentAlert(_ message: String) {
        let alert = UIAlertController(title: String(localized: "备份与恢复"), message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: String(localized: "好"), style: .default))
        topViewController()?.present(alert, animated: true)
    }

    static func topViewController() -> UIViewController? {
        let scene = UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .first { $0.activationState == .foregroundActive } ?? UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }.first
        var top = scene?.windows.first { $0.isKeyWindow }?.rootViewController
            ?? scene?.windows.first?.rootViewController
        while let presented = top?.presentedViewController { top = presented }
        return top
    }
}
