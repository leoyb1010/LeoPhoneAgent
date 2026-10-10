import Foundation

/// [S1] Non-blocking log line delivery.
///
/// `AppLogger` used to `NSLog` every line, which formatted it, went through the
/// system logging stack and then wrote it to stderr — and stderr is a 64 KB pipe
/// drained by a reader thread whenever file logging is on. During launch that
/// reader was starved and every logging thread, the main thread included,
/// blocked in `write(2)` (647 lines in the first second, a 667 ms main-thread
/// hang right after). The pipeline here keeps the caller's cost to one lock,
/// one token-bucket check and one `async`:
///
/// * the caller captures the time and hands the raw parts over; formatting,
///   redaction and file I/O all run on `queue` (the log writer's queue);
/// * a per-category token bucket (default 50 lines/s, burst 100) stops one
///   chatty subsystem from flooding the file; suppressed lines become one
///   "[cat] suppressed N lines" summary per episode;
/// * the in-flight backlog is bounded, so a writer that stalls drops lines
///   (and says so once) instead of growing memory.
///
/// Errors and faults are never rate-limited.
final class LogLinePipeline: @unchecked Sendable {
    /// Writes one fully formatted line (with trailing newline). Runs on `queue`.
    typealias Writer = (String) -> Void

    let queue: DispatchQueue
    private let writer: Writer
    private let lock = NSLock()
    private var limiter: LogRateLimiter
    private var enabled = true
    private var pending = 0
    private var dropped = 0
    private var summaryScheduled = false
    private let maxPending: Int
    private let summaryDelay: TimeInterval
    private let now: () -> Date

    /// One formatter, created once. `DateFormatter` is thread-safe for
    /// formatting; it is only ever used on `queue` anyway.
    private let timeFormatter: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "HH:mm:ss"
        f.locale = Locale(identifier: "en_US_POSIX")
        return f
    }()

    init(queue: DispatchQueue,
         ratePerSecond: Double = 50,
         burst: Double = 100,
         maxPending: Int = 20_000,
         summaryDelay: TimeInterval = 1.0,
         now: @escaping () -> Date = Date.init,
         writer: @escaping Writer) {
        self.queue = queue
        self.writer = writer
        self.limiter = LogRateLimiter(ratePerSecond: ratePerSecond, burst: burst)
        self.maxPending = maxPending
        self.summaryDelay = summaryDelay
        self.now = now
    }

    var isEnabled: Bool {
        get { lock.lock(); defer { lock.unlock() }; return enabled }
        set { lock.lock(); enabled = newValue; lock.unlock() }
    }

    /// Levels that bypass the token bucket.
    static func isUnlimited(_ level: String) -> Bool {
        level == "ERROR" || level == "CRIT" || level == "FAULT"
    }

    /// Hand a line to the writer. Never blocks on I/O; returns whether the line
    /// was accepted (false when disabled, rate-limited or the backlog is full).
    @discardableResult
    func submit(category: String, level: String, message: String) -> Bool {
        let at = now()
        lock.lock()
        guard enabled else { lock.unlock(); return false }
        var summary: Int = 0
        if !Self.isUnlimited(level) {
            switch limiter.admit(category: category, at: at) {
            case .suppress:
                let schedule = !summaryScheduled
                summaryScheduled = true
                lock.unlock()
                if schedule { scheduleSummaryFlush() }
                return false
            case .emit(let suppressedBefore):
                summary = suppressedBefore
            }
        }
        if pending >= maxPending {
            dropped += 1
            lock.unlock()
            return false
        }
        pending += 1
        let droppedSoFar = dropped
        dropped = 0
        lock.unlock()

        queue.async { [self] in
            let ts = timeFormatter.string(from: at)
            if droppedSoFar > 0 {
                writer("[\(ts)] [LoggingManager] [WARN] dropped \(droppedSoFar) log lines (writer backlog full)\n")
            }
            if summary > 0 {
                writer(Self.summaryLine(ts: ts, category: category, count: summary))
            }
            writer("[\(ts)] [\(category)] [\(level)] \(message)\n")
            lock.lock(); pending -= 1; lock.unlock()
        }
        return true
    }

    static func summaryLine(ts: String, category: String, count: Int) -> String {
        "[\(ts)] [\(category)] [WARN] suppressed \(count) lines (rate limit)\n"
    }

    private func scheduleSummaryFlush() {
        queue.asyncAfter(deadline: .now() + summaryDelay) { [self] in
            flushSummaries()
        }
    }

    /// Writes one summary line per category that has suppressed lines pending.
    /// Runs on `queue`; exposed for tests (call through `queue.sync`).
    func flushSummaries() {
        lock.lock()
        summaryScheduled = false
        let drained = limiter.drainSuppressed()
        lock.unlock()
        guard !drained.isEmpty else { return }
        let ts = timeFormatter.string(from: now())
        for (category, count) in drained {
            writer(Self.summaryLine(ts: ts, category: category, count: count))
        }
    }
}

/// Per-category token bucket. Pure value type: the caller supplies the clock.
struct LogRateLimiter {
    enum Decision: Equatable {
        /// Emit the line; `suppressedBefore` lines were dropped since the last
        /// emitted one and deserve a summary line first.
        case emit(suppressedBefore: Int)
        case suppress
    }

    private struct Bucket {
        var tokens: Double
        var last: Date
        var suppressed: Int
    }

    let ratePerSecond: Double
    let burst: Double
    private var buckets: [String: Bucket] = [:]

    init(ratePerSecond: Double, burst: Double) {
        self.ratePerSecond = ratePerSecond
        self.burst = burst
    }

    mutating func admit(category: String, at now: Date) -> Decision {
        var bucket = buckets[category] ?? Bucket(tokens: burst, last: now, suppressed: 0)
        let elapsed = max(0, now.timeIntervalSince(bucket.last))
        bucket.tokens = min(burst, bucket.tokens + elapsed * ratePerSecond)
        bucket.last = now
        if bucket.tokens >= 1 {
            bucket.tokens -= 1
            let suppressed = bucket.suppressed
            bucket.suppressed = 0
            buckets[category] = bucket
            return .emit(suppressedBefore: suppressed)
        }
        bucket.suppressed += 1
        buckets[category] = bucket
        return .suppress
    }

    /// Categories with suppressed lines not yet summarized; resets their counts.
    mutating func drainSuppressed() -> [(String, Int)] {
        var out: [(String, Int)] = []
        for (category, bucket) in buckets where bucket.suppressed > 0 {
            out.append((category, bucket.suppressed))
            buckets[category]?.suppressed = 0
        }
        return out.sorted { $0.0 < $1.0 }
    }
}
