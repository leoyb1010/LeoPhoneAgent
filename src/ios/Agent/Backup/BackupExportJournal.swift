import Foundation

private let logger = AppLogger(category: "Backup")

/// In-flight marker + sweeper for exports.
///
/// Exports stream straight into a package in `tmp/`, so an interrupted run
/// (cancel, crash, jetsam, OS suspension) can never leave a half-written
/// package at a user-visible destination: delivery only happens after the
/// package is complete and verified. What CAN leak is the partial package and
/// its small staging directory — this marker names them, and the launch sweep
/// removes anything left behind. Re-running the export produces a fresh,
/// consistent snapshot (deliberately no "resume into an old snapshot").
enum BackupExportJournal {

    struct Marker: Codable, Sendable {
        var backupId: String
        var startedAt: Date
        var categories: [String]
        var encrypted: Bool
    }

    static func markerURL(in root: URL) -> URL {
        root.appendingPathComponent("export-in-progress.json")
    }

    static func begin(_ marker: Marker, in root: URL) {
        do {
            try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
            try BackupDates.encoder().encode(marker).write(to: markerURL(in: root), options: .atomic)
        } catch {
            logger.warning("[Backup] couldn't write export marker")
        }
    }

    static func interrupted(in root: URL) -> Marker? {
        guard let data = try? Data(contentsOf: markerURL(in: root)) else { return nil }
        return try? BackupDates.decoder().decode(Marker.self, from: data)
    }

    static func finish(in root: URL) {
        try? FileManager.default.removeItem(at: markerURL(in: root))
    }

    /// Delete leftovers of interrupted exports / previews in `workRoot`:
    /// staging trees, partial packages and import work directories. Called at
    /// launch, when nothing can be running. Returns the number of items removed.
    @discardableResult
    static func sweepAbandoned(workRoot: URL) -> Int {
        let fm = FileManager.default
        var removed = 0
        let prefixes = ["minisbak-", "restore-work-", "opened-"]
        for name in (try? fm.contentsOfDirectory(atPath: workRoot.path)) ?? []
        where prefixes.contains(where: name.hasPrefix)
            || name.hasSuffix("." + BackupFormat.fileExtension)
            || name.hasSuffix(".partial") {
            try? fm.removeItem(at: workRoot.appendingPathComponent(name))
            removed += 1
        }
        finish(in: workRoot)
        if removed > 0 { logger.info("[Backup] swept \(removed) leftover backup item(s)") }
        return removed
    }
}
