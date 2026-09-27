import Foundation
import UIKit
import UserNotifications

private let importLog = AppLogger(category: "Share")

/// Ingests a `file://` URL that arrived via "Open in LeoPhoneAgent" / "Copy to LeoPhoneAgent"
/// from the Files app (or any document provider) into the SAME PendingShare
/// pipeline the Share Extension uses. The file is copied into the App Group
/// shared transfer directory and surfaced as a `.attachment` item, so it flows
/// through AIChatView.injectPendingShareIfNeeded — which already detects a
/// Provider-export JSON and prompts import-vs-attach (#678). No separate
/// detection path. [T-ios-json-open-provider-import-prompt]
enum ExternalFileImporter {

    /// True if `url` is a local file we should ingest (vs a `leophoneagent://` deep link).
    static func canIngest(_ url: URL) -> Bool {
        url.isFileURL
    }

    /// Copy the incoming file into the shared transfer dir and raise a pending
    /// share so the normal consume → detect → prompt flow runs. Returns true if
    /// the file was staged. Files-app URLs are typically security-scoped, so we
    /// bracket the read with start/stopAccessingSecurityScopedResource and copy
    /// into our sandbox before the scope is released.
    @discardableResult
    static func ingest(_ url: URL, into coordinator: ShareCoordinator) -> Bool {
        guard url.isFileURL else { return false }
        guard let dir = SharedContainerStore.sharedFileDirectory else {
            importLog.error("[Share] ingest: sharedFileDirectory is nil — cannot stage \(url.lastPathComponent)")
            return false
        }

        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }

        // [T-skill-share] A .skillmd is a portable skill — install it instead
        // of attaching it to a chat. Only this explicit extension short-circuits;
        // plain .md files keep their existing attach behaviour. A skill steers
        // every later run, so a file from outside is previewed and confirmed
        // first, and replacing a same-name skill is its own explicit choice.
        if url.pathExtension.lowercased() == "skillmd",
           let content = try? String(contentsOf: url, encoding: .utf8) {
            Task { @MainActor in confirmSkillInstall(content: content) }
            return true
        }

        let fm = FileManager.default
        try? fm.createDirectory(at: dir, withIntermediateDirectories: true)

        // Use a unique on-disk name to avoid colliding with a concurrent share,
        // but keep the original extension so downstream type checks (e.g. the
        // .json gate in providerExportJSON) still work.
        let ext = url.pathExtension
        let stagedName = "open-\(UUID().uuidString)" + (ext.isEmpty ? "" : ".\(ext)")
        let dest = dir.appendingPathComponent(stagedName)
        do {
            // NSFileCoordinator gives the document provider a chance to
            // materialize a not-yet-downloaded iCloud file before we copy.
            var coordErr: NSError?
            var copyErr: Error?
            NSFileCoordinator().coordinate(readingItemAt: url, options: [], error: &coordErr) { readURL in
                do {
                    if fm.fileExists(atPath: dest.path) { try fm.removeItem(at: dest) }
                    try fm.copyItem(at: readURL, to: dest)
                } catch { copyErr = error }
            }
            if let coordErr { throw coordErr }
            if let copyErr { throw copyErr }
        } catch {
            importLog.error("[Share] ingest: failed to copy \(url.lastPathComponent): \(error.localizedDescription)")
            return false
        }

        let share = PendingShare(
            items: [PendingShare.Item(kind: .attachment, value: stagedName)],
            timestamp: Date()
        )
        SharedContainerStore.savePendingShare(share)
        importLog.info("[Share] ingest: staged \(url.lastPathComponent) as \(stagedName) and raising pending share")
        Task { @MainActor in coordinator.raisePendingShare() }
        return true
    }

    @MainActor
    private static func confirmSkillInstall(content: String) {
        let parsed = SkillStore.parse(skillMD: content)
        let replacing = SkillStore.shared.skills.contains { $0.id == SkillStore.slugify(parsed.name) }
        let preview = String(parsed.body.trimmingCharacters(in: .whitespacesAndNewlines).prefix(400))
        let message = [parsed.description, preview]
            .filter { !$0.isEmpty }
            .joined(separator: "\n\n")

        let alert = UIAlertController(
            title: replacing
                ? String(localized: "Replace skill “\(parsed.name)”?")
                : String(localized: "Install skill “\(parsed.name)”?"),
            message: replacing
                ? String(localized: "A skill with this name is already installed. Replacing it overwrites its instructions.") + "\n\n" + message
                : message,
            preferredStyle: .alert
        )
        alert.addAction(UIAlertAction(title: String(localized: "Cancel"), style: .cancel))
        alert.addAction(UIAlertAction(
            title: replacing ? String(localized: "Replace") : String(localized: "Install"),
            style: replacing ? .destructive : .default
        ) { _ in
            install(content: content)
        })

        guard let presenter = topViewController() else {
            importLog.error("[Share] shared skill: no window to confirm install — dropped")
            return
        }
        presenter.present(alert, animated: true)
    }

    @MainActor
    private static func install(content: String) {
        do {
            let skill = try SkillStore.shared.importSkill(content: content, source: .file)
            importLog.info("[Share] installed shared skill '\(skill.name)'")
            let note = UNMutableNotificationContent()
            note.title = String(localized: "Skill installed")
            note.body = skill.name
            Task {
                try? await UNUserNotificationCenter.current().add(
                    UNNotificationRequest(identifier: "skill-import-\(UUID().uuidString)",
                                          content: note, trigger: nil))
            }
        } catch {
            importLog.error("[Share] shared skill install failed: \(error.localizedDescription)")
        }
    }

    /// The app's own window, never the app-lock window stacked above it.
    @MainActor
    private static func topViewController() -> UIViewController? {
        guard let scene = UIApplication.shared.connectedScenes
            .compactMap({ $0 as? UIWindowScene }).activeFirst,
              let root = scene.windows.first(where: { $0.windowLevel == .normal && !$0.isHidden })?.rootViewController
        else { return nil }
        var top = root
        while let presented = top.presentedViewController { top = presented }
        return top
    }
}
