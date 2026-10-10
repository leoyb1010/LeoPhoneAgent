import Foundation
import FileProvider
import UIKit

/// Watches the App Group `MinisFileProvider/{shared,skills,memory}/` subtrees and
/// signals the FileProvider extension whenever directory contents change.
///
/// Why this exists: iSH shell commands and the in-app FileBrowserView both write
/// to these directories via plain POSIX I/O, bypassing the FileProvider create/move
/// APIs. iOS therefore never learns about the new files and the Files app keeps
/// displaying its stale enumerator cache (the "shared looks empty" bug).
///
/// Strategy: per-directory `DispatchSourceFileSystemObject` (kqueue VNODE) watches
/// across the entire subtree. New subdirs get a watch attached on the fly; deleted
/// ones get their watch dropped. Bursts coalesce within a short window so a `cp -r`
/// of 1000 files signals once per touched parent, not 1000 times.
///
/// [S2] Threading: every piece of mutable state below is owned by `queue`. The
/// class used to be `@MainActor` while its kqueue handlers and foreground
/// reconcile mutated `watches` on `queue` — a data race — and `start()` walked
/// the whole tree on the main thread during the first frame. `start()` now only
/// hops to `queue`; directory selection is `AppGroupWatchPlanner` (bounded,
/// breadth-first, roots reserved first).
final class AppGroupChangeWatcher: @unchecked Sendable {
    static let shared = AppGroupChangeWatcher()

    private let logger = AppLogger(category: "FPWatcher")
    private let queue = DispatchQueue(label: "com.leoyuan.leophoneagent.fpwatcher", qos: .utility)
    private let domainIdentifier = NSFileProviderDomainIdentifier("com.leoyuan.leophoneagent.files")

    /// Hard cap on simultaneous watched directories. Each watch holds an `O_EVTONLY`
    /// fd; iOS apps typically have a per-process limit around 256. We cap well below
    /// to leave room for the rest of the app.
    private let maxWatches = 180

    /// Foreground reconcile re-lists every watched directory; at most once a minute.
    private let foregroundReconcileInterval: TimeInterval = 60

    private struct Watch {
        let url: URL
        let rootKey: String           // "shared" | "skills" | "memory"
        let relativePath: String      // path inside the root, "" for root itself
        let source: DispatchSourceFileSystemObject
        var childNames: Set<String>   // baseline for new/deleted subdir detection
        var depth: Int { relativePath.isEmpty ? 0 : relativePath.split(separator: "/").count }
    }

    // queue-owned state
    private var watches: [URL: Watch] = [:]
    private var pendingSignals: [NSFileProviderItemIdentifier: DispatchWorkItem] = [:]
    private let signalCoalesceMs = 250
    private var started = false
    private var capLogged = false
    private var lastForegroundReconcile: Date = .distantPast
    private var foregroundObserver: NSObjectProtocol?

    private init() {}

    /// Start watching the three exposed roots. Idempotent. Returns immediately:
    /// the directory walk and every `open(O_EVTONLY)` run on `queue`.
    func start() {
        let roots: [AppGroupWatchPlanner.Root] = [
            .init(key: "shared", url: AIChatViewModel.minisSharedPersistentDir),
            .init(key: "skills", url: AIChatViewModel.minisSkillsPersistentDir),
            .init(key: "memory", url: AIChatViewModel.minisMemoryPersistentDir),
        ]
        queue.async { [self] in
            guard !started else { return }
            started = true
            for root in roots {
                // Make sure the root exists — otherwise kqueue can't open it.
                try? FileManager.default.createDirectory(at: root.url, withIntermediateDirectories: true)
            }
            let plan = AppGroupWatchPlanner.plan(roots: roots, cap: maxWatches,
                                                 listSubdirectories: AppGroupWatchPlanner.fileSystemSubdirectories)
            for entry in plan.entries {
                attachWatch(at: entry.url, rootKey: entry.rootKey, relativePath: entry.relativePath)
            }
            capLogged = plan.capReached
            // One line per root — never one per skipped directory.
            for line in plan.summaryLines { logger.info(line) }

            // When the app returns to foreground, kqueue events that fired while
            // suspended may have been dropped: reconcile (throttled) on `queue`.
            foregroundObserver = NotificationCenter.default.addObserver(
                forName: UIApplication.willEnterForegroundNotification, object: nil, queue: nil
            ) { [weak self] _ in
                self?.queue.async { self?.handleForeground() }
            }
        }
    }

    /// Runs on `queue`.
    private func handleForeground() {
        let now = Date()
        guard now.timeIntervalSince(lastForegroundReconcile) >= foregroundReconcileInterval else { return }
        lastForegroundReconcile = now
        // Walk the trees and add watches for any subdirs that appeared while
        // suspended. Drop watches whose target vanished.
        for (_, watch) in watches {
            reconcileChildren(watch: watch)
        }
        // Signal all three roots + the working set to nudge Files app
        // to re-enumerate after we missed events while suspended.
        for rootKey in ["shared", "skills", "memory"] {
            scheduleSignal(itemID: NSFileProviderItemIdentifier(rootKey))
        }
        scheduleSignal(itemID: .workingSet)
    }

    // MARK: - Watch lifecycle

    /// Attach a watch to `url` and, within the planner's rules, to its existing
    /// subdirectories (a directory that appeared at runtime). Runs on `queue`.
    private func attachRecursive(at url: URL, rootKey: String, relativePath: String) {
        guard attachWatch(at: url, rootKey: rootKey, relativePath: relativePath) else { return }
        let depth = relativePath.isEmpty ? 0 : relativePath.split(separator: "/").count
        for name in AppGroupWatchPlanner.fileSystemSubdirectories(of: url).sorted() {
            guard AppGroupWatchPlanner.shouldWatch(name: name, parentDepth: depth, rootKey: rootKey) else { continue }
            guard watches.count < maxWatches else { noteCapReached(); return }
            let childRel = relativePath.isEmpty ? name : "\(relativePath)/\(name)"
            attachRecursive(at: url.appendingPathComponent(name),
                            rootKey: rootKey, relativePath: childRel)
        }
    }

    /// One WARN per cap episode (reset once a watch is released).
    private func noteCapReached() {
        guard !capLogged else { return }
        capLogged = true
        logger.warning("watch cap reached (\(self.maxWatches)); new directories are not watched until some are removed")
    }

    @discardableResult
    private func attachWatch(at url: URL, rootKey: String, relativePath: String) -> Bool {
        guard watches[url] == nil else { return false }
        guard watches.count < maxWatches else {
            noteCapReached()
            return false
        }
        let fd = open(url.path, O_EVTONLY)
        guard fd >= 0 else {
            logger.warning("open(O_EVTONLY) failed root=\(rootKey) errno=\(errno)")
            return false
        }
        let source = DispatchSource.makeFileSystemObjectSource(
            fileDescriptor: fd,
            eventMask: [.write, .delete, .rename, .extend, .attrib],
            queue: queue)

        source.setEventHandler { [weak self] in
            guard let self else { return }
            let mask = source.data
            self.handleEvent(url: url, rootKey: rootKey,
                             relativePath: relativePath, mask: mask)
        }
        source.setCancelHandler { close(fd) }
        source.resume()

        let initialChildren = listImmediateChildren(at: url)
        watches[url] = Watch(
            url: url, rootKey: rootKey, relativePath: relativePath,
            source: source, childNames: initialChildren)
        return true
    }

    private func detachWatch(at url: URL) {
        guard let watch = watches.removeValue(forKey: url) else { return }
        watch.source.cancel()
        if watches.count < maxWatches { capLogged = false }
    }

    /// Detach watches for `url` and all its descendants. Used when a directory
    /// is removed/renamed.
    private func detachSubtree(at url: URL) {
        let prefix = url.path
        let toRemove = watches.keys.filter {
            $0.path == prefix || $0.path.hasPrefix(prefix + "/")
        }
        for key in toRemove {
            detachWatch(at: key)
        }
    }

    // MARK: - Event handling

    private func handleEvent(url: URL, rootKey: String,
                             relativePath: String,
                             mask: DispatchSource.FileSystemEvent) {
        // Directory itself was deleted/renamed — drop the entire subtree.
        if mask.contains(.delete) || mask.contains(.rename) {
            // The deleted directory's parent will get its own .write event,
            // which signals the parent. We just clean up watches here.
            detachSubtree(at: url)
            // Best-effort signal of this directory's parent.
            scheduleSignalForParent(rootKey: rootKey, relativePath: relativePath)
            return
        }

        // Contents changed: signal this directory's enumerator and reconcile
        // children so newly-created subdirs get a watch attached.
        scheduleSignalFor(rootKey: rootKey, relativePath: relativePath)
        if let watch = watches[url] {
            reconcileChildren(watch: watch)
        }
    }

    /// Compare the watched directory's current entries to the cached child
    /// snapshot; attach watches for new subdirs, detach for removed ones.
    private func reconcileChildren(watch: Watch) {
        let current = listImmediateChildren(at: watch.url)
        let added = current.subtracting(watch.childNames)
        let removed = watch.childNames.subtracting(current)

        if !added.isEmpty || !removed.isEmpty {
            // Counts only — entry names can include user-chosen filenames.
            logger.info("[FPSyncTrace] reconcile rootKey=\(watch.rootKey) depth=\(watch.relativePath.isEmpty ? 0 : watch.relativePath.split(separator: "/").count) added=\(added.count) removed=\(removed.count)")
        }

        for name in added {
            guard AppGroupWatchPlanner.shouldWatch(name: name, parentDepth: watch.depth, rootKey: watch.rootKey)
            else { continue }
            let childURL = watch.url.appendingPathComponent(name)
            let isDir = (try? childURL.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) ?? false
            guard isDir else { continue }
            let childRel = watch.relativePath.isEmpty
                ? name
                : "\(watch.relativePath)/\(name)"
            attachRecursive(at: childURL, rootKey: watch.rootKey, relativePath: childRel)
        }
        for name in removed {
            let childURL = watch.url.appendingPathComponent(name)
            detachSubtree(at: childURL)
        }

        if !added.isEmpty || !removed.isEmpty {
            // Mutate the watch's cached children. `watches` values are by-value
            // structs so we have to write back.
            if var stored = watches[watch.url] {
                stored.childNames = current
                watches[watch.url] = stored
            }
        }
    }

    private func listImmediateChildren(at url: URL) -> Set<String> {
        guard let entries = try? FileManager.default.contentsOfDirectory(
            atPath: url.path) else { return [] }
        return Set(entries)
    }

    // MARK: - Signal coalescing

    private func itemIdentifier(rootKey: String, relativePath: String) -> NSFileProviderItemIdentifier {
        if relativePath.isEmpty {
            return NSFileProviderItemIdentifier(rootKey)
        }
        return NSFileProviderItemIdentifier("\(rootKey)/\(relativePath)")
    }

    /// Fan-out the signal up the ancestor chain and to the working set.
    ///
    /// iOS Files may be currently displaying any ancestor of the changed
    /// directory (e.g. user is at `shared/` while a write happens in
    /// `shared/foo/bar/baz.txt`). Whichever level the user is at, that
    /// container's enumerator must be poked so it reports the new mtime
    /// and re-fetches children if the user opens deeper. Also signal
    /// `.workingSet` so spotlight / global search indexes update.
    private func scheduleSignalFor(rootKey: String, relativePath: String) {
        // The directory where the change happened.
        scheduleSignal(itemID: itemIdentifier(rootKey: rootKey, relativePath: relativePath))
        // Each ancestor up to and including the rootKey itself ("shared",
        // "skills", "memory"). We do NOT signal `.rootContainer` here —
        // its listing is just the three fixed top-level dirs and is
        // unaffected by writes inside them.
        var rel = relativePath
        while !rel.isEmpty {
            rel = (rel as NSString).deletingLastPathComponent
            if rel.isEmpty {
                scheduleSignal(itemID: NSFileProviderItemIdentifier(rootKey))
            } else {
                scheduleSignal(itemID: NSFileProviderItemIdentifier("\(rootKey)/\(rel)"))
            }
        }
        // Working set covers Spotlight + recent / unified search.
        scheduleSignal(itemID: .workingSet)
    }

    private func scheduleSignalForParent(rootKey: String, relativePath: String) {
        let parentRel = (relativePath as NSString).deletingLastPathComponent
        scheduleSignalFor(rootKey: rootKey, relativePath: parentRel)
    }

    /// Coalesce repeated requests for the same enumerator into a single signal
    /// fired after `signalCoalesceMs`. A burst of writes (e.g. `cp -r` of many
    /// files into the same folder) becomes one signal.
    private func scheduleSignal(itemID: NSFileProviderItemIdentifier) {
        // Cancel any previously-scheduled work for the same id.
        pendingSignals[itemID]?.cancel()
        let work = DispatchWorkItem { [weak self] in
            self?.deliverSignal(itemID: itemID)
        }
        pendingSignals[itemID] = work
        queue.asyncAfter(deadline: .now() + .milliseconds(signalCoalesceMs), execute: work)
    }

    private func deliverSignal(itemID: NSFileProviderItemIdentifier) {
        pendingSignals.removeValue(forKey: itemID)
        let domainID = domainIdentifier
        NSFileProviderManager.getDomainsWithCompletionHandler { [logger] domains, error in
            if let error {
                logger.warning("[FPSyncTrace] getDomains failed: \(error.localizedDescription)")
                return
            }
            guard let domain = domains.first(where: { $0.identifier == domainID }) else {
                logger.warning("[FPSyncTrace] domain \(domainID.rawValue) not registered — skipping signal id=\(itemID.rawValue)")
                return
            }
            NSFileProviderManager(for: domain)?.signalEnumerator(for: itemID) { signalErr in
                if let signalErr {
                    logger.warning("[FPSyncTrace] signalEnumerator(\(itemID.rawValue)) failed: \(signalErr.localizedDescription)")
                } else {
                    // [T-ios-log-noise-reduction] INFO→DEBUG: fires every ~2 min
                    // per watched root; no production value. The failure branch
                    // above stays WARN.
                    logger.debug("[FPSyncTrace] signalled id=\(itemID.rawValue)")
                }
            }
        }
    }
}
