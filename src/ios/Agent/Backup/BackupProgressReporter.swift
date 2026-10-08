import Foundation

/// Turns "正在导出对话…" into a line that moves: `n/total` plus a crude linear
/// time estimate, at most once a second, so a slow backup can be told apart
/// from a stuck one.
struct BackupProgressReporter {
    private let noun: String
    private let total: Int
    private let started = Date()
    /// `transient` marks a line the next one REPLACES (see BackupHistory).
    private let emit: (String, _ transient: Bool) -> Void
    private var lastEmit: Date?
    private var done = 0

    private static let interval: TimeInterval = 1.0

    init(noun: String, total: Int, emit: @escaping (String, _ transient: Bool) -> Void) {
        self.noun = noun
        self.total = total
        self.emit = emit
    }

    func begin(_ label: String) {
        emit(total > 0 ? "\(label)（共 \(total) \(noun)）" : label, false)
    }

    mutating func step() {
        done += 1
        guard total > 0 else { return }
        let now = Date()
        if let last = lastEmit, now.timeIntervalSince(last) < Self.interval { return }
        // One sample makes a wild extrapolation; skip it.
        guard done > 1 else { lastEmit = now; return }
        lastEmit = now
        let perItem = now.timeIntervalSince(started) / Double(done)
        let remaining = perItem * Double(max(0, total - done))
        emit(String(localized: "\(done)/\(total) \(noun) · 约剩 \(Self.durationText(remaining))"), true)
    }

    func finish(_ label: String, detail: String) {
        emit("\(label)：\(detail)，用时 \(Self.durationText(Date().timeIntervalSince(started)))", false)
    }

    static func durationText(_ seconds: TimeInterval) -> String {
        if seconds < 1 { return String(localized: "不到 1 秒") }
        if seconds < 60 { return String(localized: "\(Int(seconds.rounded())) 秒") }
        return String(localized: "\(Int((seconds / 60).rounded())) 分钟")
    }
}
