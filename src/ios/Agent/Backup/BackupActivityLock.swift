import Foundation

/// Process-wide exclusion for backup operations: one export OR one restore at
/// a time. Refuses rather than queues — a second tap should be told a run is
/// already in progress, not silently start another multi-GB job.
actor BackupActivityLock {
    static let shared = BackupActivityLock()

    enum Activity: String, Sendable {
        case export
        case restore
    }

    struct Busy: LocalizedError {
        let current: Activity
        var errorDescription: String? {
            switch current {
            case .export: return String(localized: "正在备份中，请等待完成后再试")
            case .restore: return String(localized: "正在恢复中，请等待完成后再试")
            }
        }
    }

    private var current: Activity?

    func withLock<T: Sendable>(_ activity: Activity,
                               _ body: @Sendable () async throws -> T) async throws -> T {
        if let current { throw Busy(current: current) }
        current = activity
        defer { current = nil }
        return try await body()
    }

    var isBusy: Bool { current != nil }
}
