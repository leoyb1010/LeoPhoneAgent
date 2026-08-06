//
//  FilesOffloadBridge.swift
//  MinisApp
//
//  Swift bridge for apple-files — mounted-folder management + document pickers.
//
//  规格书 B·P0「文件与文档」:现有 MountedFolders(security-scoped bookmark)
//  只能人肉去设置页挂载;这个桥让 Agent 能主动说"给我一个文件夹"——
//  request 弹系统文件夹选择器,pick 弹文件选择器把文件拷进 offloads 目录,
//  reauth 处理失效 bookmark。所有授权都由用户在系统 UI 里亲手完成,
//  Agent 只能拿到用户明确选择的内容。
//

import Foundation
import SwiftUI
import UIKit
import UniformTypeIdentifiers

private let logger = AppLogger(category: "FilesOffloadBridge")

@MainActor @objc public class FilesOffloadBridge: NSObject {

    // Strong references keep picker delegates alive while the sheet is up.
    private static var activeFolderDelegate: FolderPickerDelegate?
    private static var activeFilePickerDelegate: FilePickerDelegate?

    // MARK: - list

    private static func stateString(for entry: MountedFolderEntry) -> String {
        switch MountedFoldersManager.shared.activationStates[entry.id] {
        case .active: return "active"
        case .stale: return "stale"
        case .permissionDenied: return "permission_denied"
        case .contentsUnavailable: return "contents_unavailable"
        case .failed(let msg): return "failed: \(msg)"
        case nil: return "inactive"
        }
    }

    @objc(listMounts)
    public static func listMounts() -> NSArray {
        let manager = MountedFoldersManager.shared
        return manager.entries.map { entry -> NSDictionary in
            [
                "name": entry.name,
                "source": entry.sourceDisplayName,
                "linux_path": "\(AIChatViewModel.minisMountsLinuxDir)/\(entry.name)",
                "writable": entry.effectiveWritable,
                "state": stateString(for: entry),
                "added_at": ISO8601DateFormatter().string(from: entry.createdAt),
            ] as NSDictionary
        } as NSArray
    }

    // MARK: - request (folder picker → new mount)

    @objc(requestFolderWithName:readOnly:completion:)
    public static func requestFolder(
        name: String?,
        readOnly: Bool,
        completion: @escaping (NSDictionary?, NSString?) -> Void
    ) {
        guard UIApplication.shared.applicationState == .active else {
            completion(nil, "LeoPhoneAgent is not in the foreground. Ask the user to open the app, then retry.")
            return
        }
        guard activeFolderDelegate == nil, activeFilePickerDelegate == nil else {
            completion(nil, "Another picker is already open. Finish or cancel it first.")
            return
        }
        guard let topVC = topViewController() else {
            completion(nil, "No view controller available to present the folder picker.")
            return
        }

        let delegate = FolderPickerDelegate(requestedName: name, readOnly: readOnly) { data, error in
            activeFolderDelegate = nil
            completion(data, error)
        }
        activeFolderDelegate = delegate

        let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.folder])
        picker.delegate = delegate
        picker.allowsMultipleSelection = false
        topVC.present(picker, animated: true)
        logger.info("[apple-files] folder picker presented (name=\(name ?? "auto"), readOnly=\(readOnly))")
    }

    @MainActor
    private final class FolderPickerDelegate: NSObject, UIDocumentPickerDelegate {
        let requestedName: String?
        let readOnly: Bool
        let completion: (NSDictionary?, NSString?) -> Void

        init(requestedName: String?, readOnly: Bool, completion: @escaping (NSDictionary?, NSString?) -> Void) {
            self.requestedName = requestedName
            self.readOnly = readOnly
            self.completion = completion
        }

        func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
            guard let url = urls.first else {
                completion(nil, "No folder selected.")
                return
            }
            let manager = MountedFoldersManager.shared
            // Name: explicit request, else the folder's own name; dedupe with -2, -3…
            var base = requestedName?.trimmingCharacters(in: .whitespaces) ?? ""
            if base.isEmpty { base = url.lastPathComponent }
            base = base.replacingOccurrences(of: "/", with: "-")
            if !MountedFolderEntry.isValidMountName(base) { base = "folder" }
            var candidate = base
            var suffix = 2
            while !manager.isNameAvailable(candidate) {
                candidate = "\(base)-\(suffix)"
                suffix += 1
            }
            do {
                let entry = try manager.add(pickedURL: url, customName: candidate, userAllowWrite: !readOnly)
                completion([
                    "name": entry.name,
                    "source": entry.sourceDisplayName,
                    "linux_path": "\(AIChatViewModel.minisMountsLinuxDir)/\(entry.name)",
                    "writable": entry.effectiveWritable,
                    "state": "active",
                ] as NSDictionary, nil)
            } catch {
                completion(nil, "Mount failed: \(error.localizedDescription)" as NSString)
            }
        }

        func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
            completion(nil, "The user cancelled the folder picker.")
        }
    }

    // MARK: - pick (file picker → copies into /var/minis/offloads)

    @objc(pickFilesWithMultiple:hostDir:guestDir:completion:)
    public static func pickFiles(
        multiple: Bool,
        hostDir: String,
        guestDir: String,
        completion: @escaping (NSDictionary?, NSString?) -> Void
    ) {
        guard UIApplication.shared.applicationState == .active else {
            completion(nil, "LeoPhoneAgent is not in the foreground. Ask the user to open the app, then retry.")
            return
        }
        guard activeFolderDelegate == nil, activeFilePickerDelegate == nil else {
            completion(nil, "Another picker is already open. Finish or cancel it first.")
            return
        }
        guard let topVC = topViewController() else {
            completion(nil, "No view controller available to present the file picker.")
            return
        }

        let delegate = FilePickerDelegate(hostDir: hostDir, guestDir: guestDir) { data, error in
            activeFilePickerDelegate = nil
            completion(data, error)
        }
        activeFilePickerDelegate = delegate

        // asCopy: the picker itself copies into our tmp — no security scope
        // to manage afterwards; we then move into the offloads dir.
        let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.item], asCopy: true)
        picker.delegate = delegate
        picker.allowsMultipleSelection = multiple
        topVC.present(picker, animated: true)
        logger.info("[apple-files] file picker presented (multiple=\(multiple))")
    }

    @MainActor
    private final class FilePickerDelegate: NSObject, UIDocumentPickerDelegate {
        let hostDir: String
        let guestDir: String
        let completion: (NSDictionary?, NSString?) -> Void

        init(hostDir: String, guestDir: String, completion: @escaping (NSDictionary?, NSString?) -> Void) {
            self.hostDir = hostDir
            self.guestDir = guestDir
            self.completion = completion
        }

        func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
            let fm = FileManager.default
            try? fm.createDirectory(atPath: hostDir, withIntermediateDirectories: true)
            var files: [[String: Any]] = []
            for url in urls {
                var destName = url.lastPathComponent
                if fm.fileExists(atPath: (hostDir as NSString).appendingPathComponent(destName)) {
                    destName = "\(UUID().uuidString.prefix(6))-\(destName)"
                }
                let destPath = (hostDir as NSString).appendingPathComponent(destName)
                do {
                    try fm.moveItem(atPath: url.path, toPath: destPath)
                } catch {
                    do {
                        try fm.copyItem(atPath: url.path, toPath: destPath)
                    } catch {
                        logger.warning("[apple-files] pick: failed to stage \(url.lastPathComponent): \(error.localizedDescription)")
                        continue
                    }
                }
                let size = (try? fm.attributesOfItem(atPath: destPath))?[.size] as? Int ?? 0
                files.append([
                    "name": destName,
                    "guest_path": "\(guestDir)/\(destName)",
                    "size": size,
                ])
            }
            if files.isEmpty {
                completion(nil, "No files could be staged.")
            } else {
                completion(["files": files, "count": files.count] as NSDictionary, nil)
            }
        }

        func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
            completion(nil, "The user cancelled the file picker.")
        }
    }

    // MARK: - reauth / remove

    @objc(reauthMount:)
    public static func reauthMount(_ name: String) -> NSDictionary {
        let manager = MountedFoldersManager.shared
        guard let entry = manager.entries.first(where: { $0.name == name }) else {
            return ["error": "No mount named '\(name)'. Use `apple-files list` to see mounts."]
        }
        let state = manager.activate(entry: entry)
        manager.pushExternalMountSnapshot()
        switch state {
        case .active(let url):
            return ["name": name, "state": "active", "resolved": url.lastPathComponent]
        case .stale, .permissionDenied:
            return ["name": name, "state": stateString(for: entry),
                    "hint": "The saved grant is no longer valid. Run `apple-files request --name \(name)` so the user can re-pick the folder."]
        case .contentsUnavailable:
            return ["name": name, "state": "contents_unavailable",
                    "hint": "The cloud provider hasn't materialized this folder. Ask the user to open it once in the Files app."]
        case .failed(let msg):
            return ["name": name, "state": "failed", "error": msg]
        }
    }

    @objc(removeMount:)
    public static func removeMount(_ name: String) -> NSDictionary {
        let manager = MountedFoldersManager.shared
        guard let entry = manager.entries.first(where: { $0.name == name }) else {
            return ["error": "No mount named '\(name)'."]
        }
        manager.remove(id: entry.id)
        return ["removed": name, "remaining": manager.entries.count]
    }

    // MARK: - Helpers

    private static func topViewController() -> UIViewController? {
        guard let windowScene = UIApplication.shared.connectedScenes
            .compactMap({ $0 as? UIWindowScene }).activeFirst,
              let rootVC = windowScene.windows.first(where: { $0.isKeyWindow })?.rootViewController else {
            return nil
        }
        var topVC = rootVC
        while let presented = topVC.presentedViewController {
            topVC = presented
        }
        return topVC
    }
}
