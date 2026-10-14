import Foundation

/// [T-mount-backoff] 失效的 security-scoped 书签,多久之后才值得再自动试一次。
///
/// 真机日志(4 天 31 次启动):两个早已失效的书签(`File Provider Storage`、`com~apple~CloudDocs`)
/// 每次启动都各解析一遍,每遍都白等约 5 秒(XPC 超时)才报「没有权限」,而且在同一轮激活里串行,
/// 后面健康的挂载要等它们。失败几乎不会因为「再试一次」而好转,所以按连续失败次数递增退避:
/// 1 小时 → 6 小时 → 24 小时,封顶 24 小时。用户手动重试会把计数清零(见 MountedFoldersManager)。
///
/// 只有纯函数,没有状态:输入是「连续失败次数、上次失败时间、现在」,便于单测。
enum MountActivationBackoff {
    /// 第 1、2、3(及以后)次连续失败之后,自动重试前要等的时间。
    static let delays: [TimeInterval] = [3_600, 6 * 3_600, 24 * 3_600]

    /// 自动重试间隔的上限。
    static var maxDelay: TimeInterval { delays[delays.count - 1] }

    /// 连续失败 `failures` 次之后的等待时间;没失败过(≤ 0)没有等待。
    static func delay(afterConsecutiveFailures failures: Int) -> TimeInterval? {
        guard failures > 0 else { return nil }
        return delays[min(failures, delays.count) - 1]
    }

    /// 最早允许下一次自动尝试的时刻;没有失败记录时为 nil(随时可以试)。
    static func nextAttemptAt(consecutiveFailures failures: Int, lastFailureAt: Date?) -> Date? {
        guard let lastFailureAt, let wait = delay(afterConsecutiveFailures: failures) else { return nil }
        return lastFailureAt.addingTimeInterval(wait)
    }

    /// 现在该不该自动尝试一次。
    ///
    /// 上次失败的时刻比「现在」还晚,说明系统时钟被往回拨过:这时算出来的退避没有意义
    /// (可能把书签冻结到很久以后),放行这一次;再失败就按新的时钟重新记。
    static func shouldAttempt(consecutiveFailures failures: Int, lastFailureAt: Date?, now: Date) -> Bool {
        guard let lastFailureAt, failures > 0 else { return true }
        if lastFailureAt > now { return true }
        guard let next = nextAttemptAt(consecutiveFailures: failures, lastFailureAt: lastFailureAt) else { return true }
        return now >= next
    }
}
