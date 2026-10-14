import Foundation

/// [T-kernel-lazy-boot] 把「并发的 N 次启动请求」合并成一次真实执行(single-flight)。
///
/// 内核改成按需启动之后,聊天、终端、能力自检、MCP 刷新……会从不同线程同时说「我要内核」。
/// 这里只负责一件事,不认识内核、不碰 UI,所以可以单测:
///   - 没人在跑 → 起一次;已经有人在跑 → 加入同一次,拿同一个结果(成功,或同一个错误);
///   - 成功之后 `run` 立即返回,工作闭包不会再跑;
///   - 失败不留痕:下一次 `run` 重新起一次(「重试本机环境」靠它);
///   - 某个等待者被取消,不会取消共享的那次启动 —— 别的等待者、以及之后的调用还要用它。
///
/// 工作闭包里不要再调用同一个 coalescer 的 `run`(会加入自己,永远等下去)。
final class KernelBootCoalescer: @unchecked Sendable {
    private let lock = NSLock()
    private var completed = false
    private var inFlight: Task<Void, Error>?
    private var runs = 0
    private var joins = 0

    init() {}

    /// 某次执行已经成功过。
    var isCompleted: Bool { lock.withLock { completed } }
    /// 此刻有一次执行在跑。
    var isRunning: Bool { lock.withLock { inFlight != nil } }
    /// 工作闭包真正被启动过几次(失败重试会累加)。测试 / 诊断用。
    var runCount: Int { lock.withLock { runs } }
    /// 有多少次调用没有自己执行、而是并进了已有的那一次。测试 / 诊断用。
    var joinCount: Int { lock.withLock { joins } }

    private enum Claim {
        case completed
        case join(Task<Void, Error>)
        case started(Task<Void, Error>)
    }

    /// 确保 `work` 至少成功执行过一次。并发调用共用同一次执行,拿到同一个结果。
    func run(_ work: @escaping @Sendable () async throws -> Void) async throws {
        // 加锁放进同步函数:NSLock.lock() 在 async 函数体里直接调用,Swift 6 模式下是编译错误。
        switch claim(work) {
        case .completed:
            return
        case .join(let flight), .started(let flight):
            // 等待者被取消时这里不会提前返回,也不会取消 flight:启动是进程级的,不属于某一个调用方。
            try await flight.value
        }
    }

    private func claim(_ work: @escaping @Sendable () async throws -> Void) -> Claim {
        lock.lock()
        defer { lock.unlock() }
        if completed { return .completed }
        if let running = inFlight {
            joins += 1
            return .join(running)
        }
        runs += 1
        // detached:不继承调用方的 actor / 取消状态。`inFlight` 在放开锁之前就位,
        // 而收尾 `finish` 也要拿同一把锁,所以收尾一定排在登记之后。
        let started = Task.detached(priority: .userInitiated) { [self] in
            do {
                try await work()
                finish(success: true)
            } catch {
                finish(success: false)
                throw error
            }
        }
        inFlight = started
        return .started(started)
    }

    /// 收尾由那一次执行自己做,而不是由等待者做:每次执行只收尾一回,
    /// 也就不会出现「慢等待者清掉了后来者新开的那次」。
    private func finish(success: Bool) {
        lock.lock()
        if success { completed = true }
        inFlight = nil
        lock.unlock()
    }
}
