import Foundation

/// [S2] Decides which directories `AppGroupChangeWatcher` attaches a kqueue
/// watch to. Pure (the directory lister is injected) so the selection rules are
/// unit-testable.
///
/// The previous walk recursed shared → skills → memory depth-first with no
/// budget: one skill's resource tree (358 dirs in `wechatpay-payment-integration`)
/// used up all 180 watches, the walk kept going anyway and logged a WARN for
/// every directory it skipped (~395 lines per launch), and `memory` — walked
/// last — got no watch at all. Rules now:
///   1. the three roots are always watched;
///   2. then their top-level children, round-robin across roots so no root
///      starves another;
///   3. then deeper levels breadth-first — except under `skills`, where only
///      depth ≤ 1 matters (the Files app shows skill folders, not their assets);
///   4. dependency / build / VCS directories are never watched;
///   5. at the cap the walk stops listing directories altogether;
///   6. one summary line per root.
struct AppGroupWatchPlanner {
    struct Root: Equatable {
        let key: String
        let url: URL
    }

    struct Entry: Equatable {
        let url: URL
        let rootKey: String
        let relativePath: String
        var depth: Int { relativePath.isEmpty ? 0 : relativePath.split(separator: "/").count }
    }

    struct RootStats: Equatable {
        var attached = 0
        var skippedAtCap = 0
        var excluded = 0
        var topLevelChildren = 0
    }

    struct Plan {
        var entries: [Entry] = []
        var stats: [String: RootStats] = [:]
        var capReached = false
        /// Exactly one line per root, in root order.
        var summaryLines: [String] = []
    }

    static let excludedDirectoryNames: Set<String> = [
        "node_modules", ".git", "__pycache__", "venv", ".venv", "dist", "build",
    ]

    static func isExcluded(_ name: String) -> Bool {
        excludedDirectoryNames.contains(name)
    }

    /// Deepest watched level under a root; nil = unlimited (cap still applies).
    static func maxDepth(forRoot key: String) -> Int? {
        key == "skills" ? 1 : nil
    }

    static func allowsDepth(_ depth: Int, rootKey: String) -> Bool {
        guard let limit = maxDepth(forRoot: rootKey) else { return true }
        return depth <= limit
    }

    /// Whether a directory discovered at runtime (`name` inside an existing
    /// watch at `parentDepth`) should get a watch, cap aside.
    static func shouldWatch(name: String, parentDepth: Int, rootKey: String) -> Bool {
        !isExcluded(name) && allowsDepth(parentDepth + 1, rootKey: rootKey)
    }

    /// - Parameter listSubdirectories: names of the immediate, non-hidden
    ///   subdirectories of a URL.
    static func plan(roots: [Root], cap: Int,
                     listSubdirectories: (URL) -> [String]) -> Plan {
        var plan = Plan()
        for root in roots { plan.stats[root.key] = RootStats() }

        func add(_ entry: Entry) -> Bool {
            guard plan.entries.count < cap else {
                plan.capReached = true
                plan.stats[entry.rootKey]?.skippedAtCap += 1
                return false
            }
            plan.entries.append(entry)
            plan.stats[entry.rootKey]?.attached += 1
            return true
        }

        func children(of entry: Entry) -> [Entry] {
            let names = listSubdirectories(entry.url).sorted()
            var out: [Entry] = []
            for name in names {
                if isExcluded(name) { plan.stats[entry.rootKey]?.excluded += 1; continue }
                let rel = entry.relativePath.isEmpty ? name : "\(entry.relativePath)/\(name)"
                out.append(Entry(url: entry.url.appendingPathComponent(name),
                                 rootKey: entry.rootKey, relativePath: rel))
            }
            return out
        }

        // 1. Roots.
        let rootEntries = roots.map { Entry(url: $0.url, rootKey: $0.key, relativePath: "") }
        for entry in rootEntries { _ = add(entry) }

        // 2. Top-level children, round-robin across roots.
        let perRoot: [[Entry]] = rootEntries.map { root in
            guard allowsDepth(1, rootKey: root.rootKey) else { return [] }
            let kids = children(of: root)
            plan.stats[root.rootKey]?.topLevelChildren = kids.count
            return kids
        }
        var level: [Entry] = []
        for index in 0..<(perRoot.map(\.count).max() ?? 0) {
            for kids in perRoot where index < kids.count {
                if add(kids[index]) { level.append(kids[index]) }
            }
        }

        // 3. Deeper levels, breadth-first; stop listing once the cap is hit.
        while !level.isEmpty, !plan.capReached {
            var next: [Entry] = []
            for parent in level {
                guard !plan.capReached else { break }
                guard allowsDepth(parent.depth + 1, rootKey: parent.rootKey) else { continue }
                for child in children(of: parent) where add(child) {
                    next.append(child)
                }
            }
            level = next
        }

        for root in roots {
            let s = plan.stats[root.key] ?? RootStats()
            let depth = maxDepth(forRoot: root.key).map(String.init) ?? "all"
            plan.summaryLines.append(
                "[FPSyncTrace] root=\(root.key) watchesAttached=\(s.attached) topLevelChildren=\(s.topLevelChildren) skippedAtCap=\(s.skippedAtCap) excluded=\(s.excluded) maxDepth=\(depth) capReached=\(plan.capReached) cap=\(cap)")
        }
        return plan
    }

    /// Production lister: immediate subdirectories, hidden entries skipped.
    static func fileSystemSubdirectories(of url: URL) -> [String] {
        guard let entries = try? FileManager.default.contentsOfDirectory(
            at: url, includingPropertiesForKeys: [.isDirectoryKey], options: [.skipsHiddenFiles]) else { return [] }
        return entries.compactMap { child in
            (try? child.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true ? child.lastPathComponent : nil
        }
    }
}
