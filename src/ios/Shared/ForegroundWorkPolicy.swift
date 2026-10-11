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

/// [r7] Launch-second log compaction. The busiest launch second carried
/// ~90 lines, most of them per-item repeats (one line per provider, per
/// FileProvider root, per proxy key) that say "nothing unusual". These
/// helpers fold each group into one line; the per-item detail stays
/// available at `.verbose`.
enum LaunchLogCompaction {
    /// True when CFNetwork reports a direct connection: no HTTP/HTTPS/SOCKS/PAC
    /// proxy enabled and the per-URL probe only returns `kCFProxyTypeNone`.
    /// Only then is the full proxy dump noise.
    static func isDirectConnection(settings: [String: Any], probeTypes: [String]) -> Bool {
        for key in ["HTTPEnable", "HTTPSEnable", "SOCKSEnable", "ProxyAutoConfigEnable"] {
            if ((settings[key] as? Int) ?? 0) != 0 { return false }
        }
        return probeTypes.allSatisfy { $0 == "kCFProxyTypeNone" }
    }

    struct Credential: Equatable {
        let id: String
        let type: String
        let cred: String
        let enabled: Bool
        let hasApiKey: Bool
        let hasOAuthToken: Bool
        let hasManualOAuth: Bool

        var hasAny: Bool { hasApiKey || hasOAuthToken || hasManualOAuth }
    }

    /// One line for the whole provider list. Enabled instances without any
    /// credential are named first (the case worth reading); the rest are
    /// listed compactly as `id:type/cred`.
    static func credentialSummary(_ items: [Credential]) -> String {
        let missing = items.filter { $0.enabled && !$0.hasAny }
        let parts = items.map { item -> String in
            let state = !item.enabled ? "off" : (item.hasAny ? "ok" : "MISSING")
            return "\(item.id.prefix(8)):\(item.type)/\(item.cred)=\(state)"
        }
        return "appPhase=active credentials n=\(items.count) missing=\(missing.count) [\(parts.joined(separator: " "))]"
    }
}
