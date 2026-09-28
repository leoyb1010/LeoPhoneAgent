import Foundation

/// 2026-09-28 真机复现：缺失类型查询触发的退避不能冒充整个服务的限流。
/// 时钟与抖动由调用方传入，测试无需等待；序列化后重启仍保留服务端要求。
struct SyncRetryPolicy: Codable {
    enum Scope {
        case send
        case changes
        case query(String)
        case record(String)

        fileprivate var key: String {
            switch self {
            case .send: return "send"
            case .changes: return "changes"
            case .query(let type): return "query:\(type)"
            case .record(let id): return "record:\(id)"
            }
        }
    }

    private struct Attempt: Codable {
        var failures: Int
        var notBefore: Date
    }

    private var attempts: [String: Attempt] = [:]
    private(set) var serviceNotBefore: Date?

    func deadline(for scope: Scope) -> Date? {
        [serviceNotBefore, attempts[scope.key]?.notBefore].compactMap { $0 }.max()
    }

    func isEligible(_ scope: Scope, at now: Date) -> Bool {
        guard let deadline = deadline(for: scope) else { return true }
        return now >= deadline
    }

    /// 每条记录独立等待。失败的 Skill 不应拖住同批新消息；服务端限流仍优先。
    func select(recordIDs: [String], at now: Date, serviceDeadline: Date? = nil)
        -> (eligible: Set<String>, nextRetryAt: Date?) {
        var eligible: Set<String> = []
        var nextRetryAt: Date?
        for id in recordIDs {
            let until = [deadline(for: .send), deadline(for: .record(id)), serviceDeadline]
                .compactMap { $0 }.max()
            if let until, until > now {
                nextRetryAt = min(nextRetryAt ?? .distantFuture, until)
            } else {
                eligible.insert(id)
            }
        }
        return (eligible, nextRetryAt)
    }

    mutating func observeServiceRetry(after seconds: TimeInterval, at now: Date) {
        guard seconds.isFinite, seconds > 0 else { return }
        let until = now.addingTimeInterval(seconds)
        serviceNotBefore = max(serviceNotBefore ?? .distantPast, until)
    }

    mutating func failed(_ scope: Scope, at now: Date, minimumDelay: TimeInterval = 0,
                         jitter: Double) {
        let failures = min((attempts[scope.key]?.failures ?? 0) + 1, 16)
        let schedule: [TimeInterval]
        switch scope {
        case .send, .record: schedule = [10, 20, 40, 80, 160, 300]
        case .changes, .query: schedule = [120, 300, 600, 1200, 1800]
        }
        let base = schedule[min(failures - 1, schedule.count - 1)]
        let fraction = jitter.isFinite ? min(max(jitter, 0), 1) : 0
        let floor = minimumDelay.isFinite ? max(minimumDelay, 0) : 0
        // 抖动只增加等待，不缩短服务端或记录返回的最短等待要求。
        let delay = max(min(base * (1 + fraction * 0.2), schedule.last!), floor)
        let until = max(now.addingTimeInterval(delay), attempts[scope.key]?.notBefore ?? .distantPast)
        attempts[scope.key] = Attempt(failures: failures, notBefore: until)
    }

    mutating func succeeded(_ scope: Scope) {
        attempts.removeValue(forKey: scope.key)
    }
}
