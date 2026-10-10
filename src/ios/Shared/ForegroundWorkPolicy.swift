import Foundation

/// [S4] What a scenePhase → .active transition is allowed to do.
///
/// The `.active` handler used to run its whole block (≈20 subsystems) on every
/// activation — including the inactive↔active churn iOS emits for banners,
/// Control Center and the notification shade, which never left the
/// foreground, and sub-2-second background blips. Those now only resume
/// streaming UI and re-evaluate the app lock; the full pass runs on the first
/// activation of the process and after a real background stay.
enum ForegroundWorkPolicy {
    enum Plan: Equatable {
        /// Resume streaming UI + app lock / privacy screen only.
        case resumeOnly
        /// The full foreground pass (first frame first, the rest after it).
        case full
    }

    /// Background stays shorter than this are treated as a blip.
    static let blipThreshold: TimeInterval = 2

    /// - Parameters:
    ///   - isFirstActivation: first `.active` of this process (cold launch).
    ///   - backgroundedFor: seconds since `.background`, nil when the app never
    ///     reached `.background` since the last activation.
    static func plan(isFirstActivation: Bool, backgroundedFor: TimeInterval?) -> Plan {
        if isFirstActivation { return .full }
        guard let away = backgroundedFor else { return .resumeOnly }
        return away < blipThreshold ? .resumeOnly : .full
    }
}

/// Admits an action at most once per `interval`.
struct IntervalGate {
    let interval: TimeInterval
    private(set) var last: Date?

    init(interval: TimeInterval, last: Date? = nil) {
        self.interval = interval
        self.last = last
    }

    mutating func admit(now: Date = Date()) -> Bool {
        if let last, now.timeIntervalSince(last) < interval { return false }
        last = now
        return true
    }
}

/// [S6] Cheap change detector for the skills directory: the directory's own
/// mtime (entries added / removed / renamed) plus each skill's SKILL.md mtime.
/// One `contentsOfDirectory` and one `stat` per skill instead of reading and
/// parsing every SKILL.md, so the foreground path can ask "did anything
/// change?" off the main thread and skip the reload when nothing did.
enum SkillDiskFingerprint {
    static func compute(skillsDir: URL, fileManager fm: FileManager = .default) -> Int {
        var hasher = Hasher()
        let dirAttrs = try? fm.attributesOfItem(atPath: skillsDir.path)
        hasher.combine((dirAttrs?[.modificationDate] as? Date)?.timeIntervalSince1970 ?? 0)
        let names = ((try? fm.contentsOfDirectory(atPath: skillsDir.path)) ?? []).sorted()
        for name in names where !name.hasPrefix(".") {
            hasher.combine(name)
            let file = skillsDir.appendingPathComponent(name).appendingPathComponent("SKILL.md").path
            let attrs = try? fm.attributesOfItem(atPath: file)
            hasher.combine((attrs?[.modificationDate] as? Date)?.timeIntervalSince1970 ?? -1)
            hasher.combine((attrs?[.size] as? NSNumber)?.int64Value ?? -1)
        }
        return hasher.finalize()
    }
}
