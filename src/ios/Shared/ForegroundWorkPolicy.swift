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

/// [up-perf-ios] 回前台之后的非界面工作(同步拉取 / 入站 apply、角标对账、小组件与 Spotlight、技能重载……)
/// 什么时候跑。
///
/// 真机 perf.jsonl:回前台(或冷启动)5 s 内开始的滚动 hitch 均值 36.5 ms/s、p90 81.6(n=47),
/// 其余时段均值 12–17、p90 34–52;同一份日志里回前台 1 s 内就有 75 条入站记录在主 actor 上 apply。
/// 这些工作首帧不需要,用户回来的第一下滑动也不需要:首帧之后再等 `settleDelay`,
/// 用户正在滑就继续等(最多 `maxScrollWait`),然后照常跑。只推迟,不丢:回到后台就立刻跑。
enum ForegroundSettlePolicy {
    static let settleDelay: TimeInterval = 1.5
    static let maxScrollWait: TimeInterval = 3
    static let pollInterval: TimeInterval = 0.25
    /// 兜底:首帧回调没来(首帧之前又回了后台,display link 不会再触发)也一定跑。
    static var fallbackDelay: TimeInterval { settleDelay + maxScrollWait + 0.5 }

    enum Decision: Equatable {
        case run
        case wait(TimeInterval)
    }

    /// - Parameters:
    ///   - sinceAnchor: 距首帧(或回前台)过了多少秒;nil = 不在回前台的窗口里。
    ///   - scrolling: 用户正在拖动 / 列表在减速。
    ///   - inForeground: App 还在前台。
    static func decide(sinceAnchor: TimeInterval?, scrolling: Bool, inForeground: Bool) -> Decision {
        guard inForeground, let since = sinceAnchor, since >= 0 else { return .run }
        if since < settleDelay { return .wait(settleDelay - since) }
        let deadline = settleDelay + maxScrollWait
        if scrolling, since < deadline { return .wait(min(pollInterval, deadline - since)) }
        return .run
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
