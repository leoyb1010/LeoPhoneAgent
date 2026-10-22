//
//  KernelBootManager.swift
//  MinisApp
//
//  iSH 内核启动的唯一入口:按需、单飞、不占主线程。
//

import Foundation

private let logger = AppLogger(category: "KernelBoot")

/// 内核启动失败。沿用原来 `AIChatViewModel.KernelBootError` 的文案:
/// 中文文案里保留 "kernel",`AgentActivityFailureClassifier` 才会把它归到「重试本机环境」。
struct KernelBootError: LocalizedError {
    let code: Int32
    var errorDescription: String? { String(localized: "Kernel boot failed: \(Int(code))") }
}

#if targetEnvironment(simulator)
/// iSH 静态库只有真机架构,模拟器构建换成 `ISHSimulatorStubs.m`,内核永远起不来。
struct SimulatorKernelUnavailableError: LocalizedError {
    /// 用 `let` 而不是直接 return/throw,免得后面的真机代码被报 "will never be executed"。
    static let applies = true
    var errorDescription: String? { "Local Linux shell kernel (iSH) is not available in the iOS Simulator." }
}
#endif

/// [T-kernel-lazy-boot] 内核生命周期的唯一入口。
///
/// 以前:聊天页每次 onAppear 都调一遍,`Task {}` 继承 @MainActor,`ISHKernel.boot` + 默认挂载覆盖层
/// 整段同步跑在主线程。真机 perf.jsonl(10-11→10-14,n=9):内核启动中位 180 ms(141–533),
/// 其中 boot 79–280 ms、overlay 63–253 ms,9 次里 3 次和 ≥250 ms 的主线程卡顿重叠;
/// 后台拉起(BGTask / 安静任务)也完整启动了一遍内核。
///
/// 现在:
///  1. 只有第一次真的需要内核时才起(发起一次 agent 运行、打开终端、能力自检……),
///     聊天页出现 / 冷启动 / 回前台 / 后台拉起都不再起。
///  2. 重活(rootfs 解包 + `ISHKernel.boot` + 默认挂载覆盖层)放在一条专用常驻线程上串行执行,
///     主线程只收到「完成」。
///  3. `ensureKernelBooted()` 是单一入口:并发调用合并成一次启动,已启动立即返回,失败可重试。
///
/// ## 为什么 `ISHKernel.boot` 可以离开主线程
/// 读过 `ISHKernel.m` 和 iSH 的 `kernel/init.c`、`task.c`、`signal.c`
/// (deps/ish 子模块没检出时,看 OpenMinis/ish-arm64 的钉住提交 e6521d9):
///  - boot 路径上没有任何 UIKit / 主线程要求;`ish_cpu_top_start` 本来就是 `dispatch_async(main)` 取主线程端口。
///  - `become_first_process()` 把调用线程的 `current`(`__thread`)设为 init,只有 boot 自己、`FsApplyOverlay`、
///    各 offload 的 `noff_ensure_guest_stub` 依赖它,而它们全在 boot 里、同一个线程上跑完。
///  - 之后所有用内核的地方(`ISHShellExecutor` → `become_new_init_child()`、`bindMountPath`、`sendInput`)
///    本来就在非主线程调用,不依赖「谁启动了内核」。
///  - 唯一的线程亲和性:`current->thread = pthread_self()` 记下的启动线程句柄,之后会被
///    `pthread_kill`(给 init 发非忽略信号)和 cputop 诊断采样使用 —— 所以启动线程必须一直活着。
///    GCD / Task 的 worker 空闲后会被回收,句柄就悬空了,因此用下面这条永不退出的专用线程。
final class KernelBootManager: @unchecked Sendable {
    static let shared = KernelBootManager()

    private let coalescer = KernelBootCoalescer()
    private let kernelThread = KernelThread()
    private let lock = NSLock()
    private var currentStatus: KernelStatus = .notBooted
    private var didPrewarmInstall = false

    private init() {}

    /// 当前状态(线程安全)。各个聊天 VM 的 `kernelStatus` 是各自对「我在等它」的 UI 投影,
    /// 真正的状态以这里为准。
    var status: KernelStatus { lock.withLock { currentStatus } }

    /// 内核已经起来、默认挂载覆盖层也铺过了。
    var isBooted: Bool { coalescer.isCompleted }

    /// 确保内核已启动。并发调用合并成一次启动;已启动立即返回;失败会抛出,下一次调用重新试。
    ///
    /// 所有「要用内核」的地方都该走这里,而不是自己判断 `ISHKernel.shared.isBooted`:
    /// shell 工具、终端、minis-* 命令、需要挂载 / offload 的工具。
    ///
    /// `reason`:谁触发的。只有真正起头的那次调用的 reason 会被记下(并进来的忽略),写进日志和 perf.jsonl 的
    /// `kernel.boot` 记录 —— 下次拉数据时可以直接看到「后台拉起(带 `-bg`)还有没有人在起内核」。
    func ensureKernelBooted(reason: String = "unspecified") async throws {
        if coalescer.isCompleted { return }
        try await coalescer.run { [self] in try await bootFlight(reason: reason) }
    }

    /// 全新安装时,在后台把 rootfs 解包做掉(只解包,不启动内核)。
    ///
    /// 内核改成按需之后,第一次发送消息才会解包,那要好几秒,会卡在整屏「Booting Kernel」上。
    /// 解包只在第一次安装(或重置后)才有活干,平时只是后台一次 `isInstalled` 检查。
    /// 和真正的启动并发时由 `RootfsManager.installIfNeeded()` 的锁串行,不会解两遍。
    func prewarmRootfsInstallIfNeeded() {
        let alreadyRequested = lock.withLock { () -> Bool in
            let was = didPrewarmInstall
            didPrewarmInstall = true
            return was
        }
        guard !alreadyRequested else { return }
        #if targetEnvironment(simulator)
        if SimulatorKernelUnavailableError.applies { return }
        #endif
        Self.installQueue.async {
            guard !RootfsManager.shared.isInstalled else { return }
            let start = CFAbsoluteTimeGetCurrent()
            do {
                try RootfsManager.shared.installIfNeeded()
                logger.info("[KernelBoot] rootfs prewarm: \(String(format: "%.1f", (CFAbsoluteTimeGetCurrent() - start) * 1000))ms")
            } catch {
                // 不在这里报错:真正要用内核时,启动流程会再试一次并把错误亮出来。
                logger.error("[KernelBoot] rootfs prewarm failed: \(error.localizedDescription)")
            }
        }
    }

    // MARK: - 启动流程

    private static let installQueue = DispatchQueue(label: "leo.rootfs.prewarm", qos: .userInitiated)

    private struct Timing: Sendable {
        let bootMs: Double
        let overlayMs: Double
    }

    private func bootFlight(reason: String) async throws {
        let start = CFAbsoluteTimeGetCurrent()
        setStatus(.booting)
        logger.info("[KernelBoot] boot requested by \(reason)")
        do {
            let timing = try await kernelThread.perform { try Self.bootOnKernelThread(startedAt: start) }
            setStatus(.booted)
            let totalMs = (CFAbsoluteTimeGetCurrent() - start) * 1000
            logger.info("[KernelBoot] TOTAL: \(String(format: "%.1f", totalMs))ms (off main)")
            LeoPerf.record("kernel.boot", ms: totalMs,
                           extra: ["bootMs": timing.bootMs.rounded(), "overlayMs": timing.overlayMs.rounded(),
                                   "offMain": true, "reason": reason])
            Task { @MainActor in
                MirrorSpeedTestViewModel.shared.autoDetectOnceIfNeeded()
                // 后台起的内核也要有 CPU 调速器(BKA 进后台时内核还没起,当时没装)。
                BackgroundKeepAliveManager.shared.kernelDidBoot()
            }
        } catch {
            setStatus(.failed(error.localizedDescription))
            logger.error("[KernelBoot] error: \(error.localizedDescription)")
            throw error
        }
    }

    /// 在内核线程上跑完整个启动:rootfs → 内核 → 钩子 → 默认挂载覆盖层。
    /// 顺序和以前一致:fakefs 变更追踪、路径钩子必须在 boot 之后、任何会话任务之前装好。
    private static func bootOnKernelThread(startedAt: CFAbsoluteTime) throws -> Timing {
        #if targetEnvironment(simulator)
        if SimulatorKernelUnavailableError.applies { throw SimulatorKernelUnavailableError() }
        #endif
        let installStart = CFAbsoluteTimeGetCurrent()
        try RootfsManager.shared.installIfNeeded()
        logger.info("[KernelBoot] installIfNeeded: \(String(format: "%.1f", (CFAbsoluteTimeGetCurrent() - installStart) * 1000))ms")

        if !ISHKernel.shared.isBooted {
            let kernelStart = CFAbsoluteTimeGetCurrent()
            let err = ISHKernel.shared.boot(withRootPath: RootfsManager.shared.rootfsPath.path)
            logger.info("[KernelBoot] kernel boot call: \(String(format: "%.1f", (CFAbsoluteTimeGetCurrent() - kernelStart) * 1000))ms")
            if err < 0 { throw KernelBootError(code: err) }
            // Wire fakefs change events into the iCloud Sync v2 SessionFile dirty pipeline.
            // Must be done after boot (the C-side dispatch source is created by that call)
            // and before any bind mount, so the first realfs op already has a consumer.
            installSessionFileChangeTracker(kernel: ISHKernel.shared)
            // Per-session path-translate hook. Must run before any session task is spawned
            // so the first /var/minis/* access already routes correctly.
            MinisFsRouter.shared.installHook()
        }
        let bootMs = (CFAbsoluteTimeGetCurrent() - startedAt) * 1000

        let overlayStart = CFAbsoluteTimeGetCurrent()
        RootfsManager.shared.applyDefaultMountOverlay()
        return Timing(bootMs: bootMs, overlayMs: (CFAbsoluteTimeGetCurrent() - overlayStart) * 1000)
    }

    private func setStatus(_ new: KernelStatus) {
        lock.withLock { currentStatus = new }
    }
}

// MARK: - 内核专用线程

/// 内核启动专用的常驻线程:懒创建(第一次要启动内核时才建),之后永不退出、睡在条件变量上。
///
/// 常驻的原因见 `KernelBootManager` 注释:iSH 把启动线程的 pthread 句柄记在 init 进程里。
/// 线程栈给 1 MB(和主线程一样):boot 里有 sqlite、plist 解析、DNS 解析,512 KB 的默认值不留余量。
private final class KernelThread: @unchecked Sendable {
    private let condition = NSCondition()
    private var jobs: [@Sendable () -> Void] = []
    private var started = false

    func perform<T: Sendable>(_ body: @escaping @Sendable () throws -> T) async throws -> T {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<T, Error>) in
            submit {
                do {
                    continuation.resume(returning: try body())
                } catch {
                    continuation.resume(throwing: error)
                }
            }
        }
    }

    private func submit(_ job: @escaping @Sendable () -> Void) {
        condition.lock()
        jobs.append(job)
        if !started {
            started = true
            let thread = Thread { [self] in loop() }
            thread.name = "leo.kernel.boot"
            thread.stackSize = 1 << 20
            thread.qualityOfService = .userInitiated
            thread.start()
        }
        condition.signal()
        condition.unlock()
    }

    private func loop() {
        while true {
            condition.lock()
            while jobs.isEmpty { condition.wait() }
            let job = jobs.removeFirst()
            condition.unlock()
            job()
        }
    }
}
