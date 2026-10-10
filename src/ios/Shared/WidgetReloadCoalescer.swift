import Foundation

/// [S4] Widget timeline reloads requested while the app is returning to the
/// foreground are merged into ONE pass, `window` seconds after the foreground
/// began. Every `reloadTimelines` wakes the widget extension process, and the
/// foreground path used to fire up to ~10 of them inside the very window that
/// draws the first frame. Outside that window requests pass straight through
/// (a background run that finishes must not wait on a timer the system may
/// never let fire).
///
/// Pure: clock, scheduler and the actual reload are injected; the app wires
/// `WidgetCenter` in `WidgetReloads`.
final class WidgetReloadCoalescer: @unchecked Sendable {
    typealias Scheduler = (_ delay: TimeInterval, _ work: @escaping () -> Void) -> Void

    private let lock = NSLock()
    private let window: TimeInterval
    private let now: () -> Date
    private let schedule: Scheduler
    private let reload: (String) -> Void
    private var foregroundAt: Date?
    private var pending: [String] = []
    private var flushScheduled = false

    init(window: TimeInterval = 2.0,
         now: @escaping () -> Date = Date.init,
         schedule: @escaping Scheduler,
         reload: @escaping (String) -> Void) {
        self.window = window
        self.now = now
        self.schedule = schedule
        self.reload = reload
    }

    /// The app is coming back to the foreground: start the coalescing window.
    func noteForeground() {
        lock.lock(); foregroundAt = now(); lock.unlock()
    }

    func request(_ kind: String) {
        lock.lock()
        let current = now()
        guard let start = foregroundAt, current < start.addingTimeInterval(window) else {
            lock.unlock()
            reload(kind)
            return
        }
        if !pending.contains(kind) { pending.append(kind) }
        let needsSchedule = !flushScheduled
        flushScheduled = true
        let delay = start.addingTimeInterval(window).timeIntervalSince(current)
        lock.unlock()
        if needsSchedule { schedule(max(0, delay)) { [weak self] in self?.flush() } }
    }

    /// Reloads each requested kind once, in request order.
    func flush() {
        lock.lock()
        let kinds = pending
        pending = []
        flushScheduled = false
        foregroundAt = nil
        lock.unlock()
        for kind in kinds { reload(kind) }
    }
}

/// Signature of the recent-sessions widget's content: ids, titles and order
/// of the first `limit` rows. The widget timeline is reloaded only when this
/// changes — not on every `sessions` mutation (15–20 per minute mid-run).
struct RecentSessionsWidgetSignature: Equatable {
    let rows: [String]

    init(ids: [String], titles: [String], limit: Int = 8) {
        rows = zip(ids, titles).prefix(limit).map { "\($0)\u{1F}\($1)" }
    }
}
