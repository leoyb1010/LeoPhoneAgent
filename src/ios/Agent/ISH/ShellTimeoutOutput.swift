import Foundation

/// [T-ish-continuation-double-resume] One-shot claim for a continuation that up
/// to four paths (completion on main, completion from the stale-context sweeper
/// on a utility queue, synchronous pid < 0, timeout on killQueue) may race to
/// resume. Resuming a CheckedContinuation twice is a fatalError, so the
/// test-and-set must be atomic. Callers resume OUTSIDE the lock.
final class ShellResumeClaim: @unchecked Sendable {
    private let lock = NSLock()
    private var resumed = false

    /// True for exactly one caller, ever.
    func claim() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        if resumed { return false }
        resumed = true
        return true
    }
}

/// [T-ish-shell-timeout-preserve-output] Mirror of every line a command printed,
/// so a timeout can hand back the output instead of only announcing the kill.
/// The executor's own result is built by the completion callback, which never
/// runs for a killed command, but the line callback already delivered each line.
///
/// [T-ish-shell-timeout-keep-tail] Bounded by keeping the TAIL: the line that
/// explains a hang is printed right before it. Lines arrive on main while the
/// timeout body runs on killQueue, hence the lock.
final class ShellPartialOutputMirror: @unchecked Sendable {
    /// Caps only this in-memory mirror; the caller still applies its own
    /// head+tail truncation for the model.
    static let defaultMaxChars = 256_000

    private let maxChars: Int
    private let lock = NSLock()
    private var lines: [String] = []
    /// Index of the oldest kept line; compacted lazily so eviction stays O(1).
    private var head = 0
    private var chars = 0
    private var truncated = false

    init(maxChars: Int = ShellPartialOutputMirror.defaultMaxChars) {
        self.maxChars = maxChars
    }

    func record(_ line: String) {
        lock.lock()
        defer { lock.unlock() }
        lines.append(line)
        chars += line.count + 1
        // Evict the oldest lines, always keeping at least the newest one.
        while chars > maxChars, lines.count - head > 1 {
            chars -= lines[head].count + 1
            head += 1
            truncated = true
        }
        if head > 4096, head * 2 > lines.count {
            lines.removeFirst(head)
            head = 0
        }
    }

    func snapshot() -> (text: String, truncated: Bool) {
        lock.lock()
        defer { lock.unlock() }
        return (lines[head...].joined(separator: "\n"), truncated)
    }

    /// Output returned for a timed-out command: what it printed (newest part
    /// when over the cap, with the drop noted ABOVE it), then the timeout notice
    /// last so the model reads why the transcript stops.
    func timedOutOutput(afterSeconds seconds: Int) -> String {
        let snap = snapshot()
        let notice = "[Command timed out after \(seconds)s"
            + (snap.text.isEmpty
                ? " with no output captured]"
                : " — above is partial output captured before the timeout]")
        if snap.text.isEmpty { return notice }
        let kept = snap.truncated
            ? "[Earlier output beyond the last \(maxChars) chars was dropped]\n\n" + snap.text
            : snap.text
        return kept + "\n\n" + notice
    }
}
