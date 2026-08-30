import Foundation

/// Reads and writes PendingShare data to the App Group shared container.
/// Compiled into both the main app target and the Share Extension target.
enum SharedContainerStore {
    static let appGroupID = "group.com.leoyuan.leophoneagent"

    private static let pendingShareKey = "pendingShare"

    static var sharedDefaults: UserDefaults? {
        UserDefaults(suiteName: appGroupID)
    }

    /// Directory in the shared container for transferring attachment files.
    static var sharedFileDirectory: URL? {
        FileManager.default
            .containerURL(forSecurityApplicationGroupIdentifier: appGroupID)?
            .appendingPathComponent("ShareExtension", isDirectory: true)
    }

    /// Shared transfer records must always name a single file inside the App
    /// Group staging directory. Treat decoded PendingShare values as untrusted:
    /// a legacy/corrupt record must not be able to escape with `../` or a slash.
    static func isSafeFileName(_ name: String) -> Bool {
        !name.isEmpty
            && name == (name as NSString).lastPathComponent
            && !name.contains("/")
            && !name.contains("\\")
            && name != "."
            && name != ".."
    }

    static func sharedFileURL(named name: String) -> URL? {
        guard isSafeFileName(name), let directory = sharedFileDirectory else { return nil }
        return directory.appendingPathComponent(name, isDirectory: false)
    }

    /// Stage original bytes for the main app. A pending attachment may only be
    /// published after this returns true; failures clean up any partial target.
    static func stageFile(from source: URL, to directory: URL, named name: String) -> Bool {
        guard source.isFileURL, isSafeFileName(name) else { return false }
        let destination = directory.appendingPathComponent(name, isDirectory: false)
        do {
            try FileManager.default.createDirectory(at: directory,
                                                    withIntermediateDirectories: true)
            try FileManager.default.copyItem(at: source, to: destination)
            return true
        } catch {
            try? FileManager.default.removeItem(at: destination)
            return false
        }
    }

    static func stageData(_ data: Data, to directory: URL, named name: String) -> Bool {
        guard isSafeFileName(name) else { return false }
        let destination = directory.appendingPathComponent(name, isDirectory: false)
        do {
            try FileManager.default.createDirectory(at: directory,
                                                    withIntermediateDirectories: true)
            try data.write(to: destination, options: .atomic)
            return true
        } catch {
            try? FileManager.default.removeItem(at: destination)
            return false
        }
    }

    // MARK: - Write (called by Share Extension)

    static func savePendingShare(_ share: PendingShare) {
        guard let defaults = sharedDefaults else { return }
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        if let data = try? encoder.encode(share) {
            defaults.set(data, forKey: pendingShareKey)
            defaults.synchronize()
        }
    }

    // MARK: - Read & Consume (called by main app)

    static func loadPendingShare() -> PendingShare? {
        guard let defaults = sharedDefaults,
              let data = defaults.data(forKey: pendingShareKey) else { return nil }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return try? decoder.decode(PendingShare.self, from: data)
    }

    static func clearPendingShare() {
        sharedDefaults?.removeObject(forKey: pendingShareKey)
        sharedDefaults?.synchronize()
    }

    /// Remove all files from the shared transfer directory.
    static func cleanSharedFiles() {
        guard let dir = sharedFileDirectory else { return }
        let fm = FileManager.default
        if let files = try? fm.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil) {
            for file in files {
                try? fm.removeItem(at: file)
            }
        }
    }
}
