import XCTest

/// [T-kernel-lazy-boot] 内核按需启动的接线。启动管理器依赖 ISHKernel / RootfsManager 等逻辑 target 编不进来的
/// 类型,所以接线用源码守卫钉住(和 LaunchForegroundPerfTests 同一做法);纯逻辑部分见 KernelBootCoalescerTests。
final class KernelLazyBootWiringTests: XCTestCase {
    private var sourceRoot: URL {
        URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
    }

    private func source(_ relative: String) throws -> String {
        try String(contentsOf: sourceRoot.appendingPathComponent(relative), encoding: .utf8)
    }

    /// App 里所有 Swift 源文件(不含测试和 xcodeproj)。
    private func appSwiftFiles() -> [URL] {
        guard let walker = FileManager.default.enumerator(at: sourceRoot, includingPropertiesForKeys: nil) else { return [] }
        var files: [URL] = []
        for case let url as URL in walker {
            let path = url.path
            if path.contains("/MinisTests/") || path.contains("/MinisUITests/") || path.contains(".xcodeproj/") { continue }
            if url.pathExtension == "swift" { files.append(url) }
        }
        return files
    }

    // MARK: - 单一入口

    /// 只能有一处启动内核。iSH 的 init 进程(PID 1)绑定在「调用 boot 的那个线程」上:
    /// 多处各自 boot,就会有人又把启动搬回主线程,或者起第二个启动线程。
    func testOnlyTheBootManagerBootsTheKernel() throws {
        let callers = appSwiftFiles().filter {
            ((try? String(contentsOf: $0, encoding: .utf8)) ?? "").contains(".boot(withRootPath:")
        }.map(\.lastPathComponent)
        XCTAssertEqual(callers, ["KernelBootManager.swift"], "启动内核只走 KernelBootManager")
    }

    func testBootRunsOnTheDedicatedKernelThreadNotTheMainThread() throws {
        let manager = try source("iSH/KernelBootManager.swift")
        // 整个启动(rootfs → boot → 钩子 → overlay)交给常驻线程。
        XCTAssertTrue(manager.contains("kernelThread.perform { try Self.bootOnKernelThread("))
        XCTAssertTrue(manager.contains("thread.name = \"leo.kernel.boot\""))
        // 线程常驻:iSH 把启动线程句柄记进 init 进程,线程退出就悬空。
        XCTAssertTrue(manager.contains("while true {"))
        // 启动路径上不能回到主线程。
        XCTAssertFalse(manager.contains("DispatchQueue.main.sync"))
        XCTAssertFalse(manager.contains("MainActor.run"))
        // 失败不留痕、可重试,并发合并——都在 coalescer 里。
        XCTAssertTrue(manager.contains("coalescer.run"))
        // perf.jsonl 的 kernel.boot 记录带 reason / offMain。
        XCTAssertTrue(manager.contains("\"offMain\": true, \"reason\": reason"))
        // 启动完成后的状态发布不阻塞启动线程。
        XCTAssertTrue(manager.contains("Task { @MainActor in MirrorSpeedTestViewModel.shared.autoDetectOnceIfNeeded() }"))
    }

    func testBootOrderIsKeptInsideTheKernelThreadJob() throws {
        let manager = try source("iSH/KernelBootManager.swift")
        let body = try XCTUnwrap(manager.range(of: "private static func bootOnKernelThread("))
        let text = String(manager[body.lowerBound...])
        let install = try XCTUnwrap(text.range(of: "RootfsManager.shared.installIfNeeded()"))
        let boot = try XCTUnwrap(text.range(of: "ISHKernel.shared.boot(withRootPath:"))
        let tracker = try XCTUnwrap(text.range(of: "installSessionFileChangeTracker(kernel: ISHKernel.shared)"))
        let hook = try XCTUnwrap(text.range(of: "MinisFsRouter.shared.installHook()"))
        let overlay = try XCTUnwrap(text.range(of: "RootfsManager.shared.applyDefaultMountOverlay()"))
        XCTAssertLessThan(install.lowerBound, boot.lowerBound, "rootfs 先于 boot")
        XCTAssertLessThan(boot.lowerBound, tracker.lowerBound, "变更追踪要在 boot 之后(C 侧 dispatch source 由 boot 创建)")
        XCTAssertLessThan(tracker.lowerBound, hook.lowerBound)
        XCTAssertLessThan(hook.lowerBound, overlay.lowerBound, "覆盖层最后铺,「就绪」包含它")
    }

    // MARK: - 触发点

    /// 聊天页出现不再启动内核;全新安装时只在后台预解包 rootfs。
    func testChatAppearanceDoesNotStartTheKernel() throws {
        let chat = try source("Views/Chat/AIChatView.swift")
        XCTAssertFalse(chat.contains("vm.ensureKernelBooted()"), "onAppear 不再启动内核")
        XCTAssertTrue(chat.contains("KernelBootManager.shared.prewarmRootfsInstallIfNeeded()"))
    }

    /// 发送 / 重试 / 继续这些真要跑 agent 的入口仍然走 VM 的 ensureKernelBooted(),
    /// 它只把共享启动投影到 kernelStatus 上,不再自己 boot。
    func testViewModelKernelEntryOnlyProjectsTheSharedBoot() throws {
        let misc = try source("Agent/Chat/AIChatViewModel+Misc.swift")
        XCTAssertTrue(misc.contains("try await manager.ensureKernelBooted(reason: reason)"))
        XCTAssertTrue(misc.contains("KernelBootManager.shared.ensureKernelBootedBlocking("), "旧同步入口改成等共享启动")
        // 记下是谁触发的;后台触发带 -bg,验证「后台拉起不再起内核」时直接看 perf.jsonl。
        XCTAssertTrue(misc.contains("\"chat-run-bg\""))
        XCTAssertFalse(misc.contains("ISHKernel.shared.boot"))
        XCTAssertFalse(misc.contains("installRootfsOffMain"))
        XCTAssertFalse(misc.contains("applyDefaultMountOverlay"), "覆盖层跟着内核启动,不在 VM 里铺")
        // kernelStatus 的三个状态仍然发布。
        for state in ["kernelStatus = .booting", "kernelStatus = .booted", "kernelStatus = .failed("] {
            XCTAssertTrue(misc.contains(state), state)
        }
        let vm = try source("Agent/Chat/AIChatViewModel.swift")
        XCTAssertTrue(vm.contains("@Published var kernelStatus: KernelStatus = .notBooted"))
    }

    // MARK: - 终端

    /// 终端不再在主线程上同步装 rootfs / boot / 铺覆盖层,也不再 semaphore.wait() 等挂载。
    func testTerminalAwaitsTheKernelInsteadOfBlockingTheMainThread() throws {
        let terminal = try source("Views/Rootfs/ISHTerminalView.swift")
        XCTAssertTrue(terminal.contains("try await KernelBootManager.shared.ensureKernelBooted(reason: \"terminal\")"))
        XCTAssertTrue(terminal.contains("await ISHExecutionCoordinator.shared.mountForSession(sid)"))
        XCTAssertFalse(terminal.contains("DispatchSemaphore"))
        XCTAssertFalse(terminal.contains("semaphore.wait()"))
        XCTAssertFalse(terminal.contains("ISHKernel.shared.boot"))
        XCTAssertFalse(terminal.contains("installIfNeeded()"))
        XCTAssertFalse(terminal.contains("applyDefaultMountOverlay()"))
        // 启动中的状态:沿用「Booting Kernel」文案,慢于 300 ms 才出现。
        XCTAssertTrue(terminal.contains("String(localized: \"Booting Kernel\")"))
        XCTAssertTrue(terminal.contains("try? await Task.sleep(nanoseconds: 300_000_000)"))
        // 失败后下次出现可重试。
        XCTAssertTrue(terminal.contains("isShellStarted = false"))
    }

    /// shell 起来之前画布的 onResize 没有 PTY 可设:尺寸要先记着,shell 起来后补发。
    func testTerminalReappliesGridSizeOnceTheShellExists() throws {
        let terminal = try source("Views/Rootfs/ISHTerminalView.swift")
        XCTAssertTrue(terminal.contains("lastGridSize = (cols, rows)"))
        XCTAssertTrue(terminal.contains("guard isShellLaunched else { return }"))
        XCTAssertTrue(terminal.contains("self?.applyGridSizeToKernel()"))
    }

    // MARK: - rootfs 管理

    /// 解包可能同时从启动、预解包、设置页来;覆盖层的并发调用不能在铺了一半时就放行。
    func testRootfsManagerSerializesInstallAndOverlay() throws {
        let rootfs = try source("iSH/RootfsManager.swift")
        XCTAssertTrue(rootfs.contains("private let installLock = NSLock()"))
        XCTAssertTrue(rootfs.contains("private let overlayRunLock = NSLock()"))
        // 置位在函数结束时(defer),而不是进函数就置位。
        XCTAssertTrue(rootfs.contains("defer { markOverlayApplied() }"))
        XCTAssertFalse(rootfs.contains("isDefaultMountOverlayApplied = true"))
    }
}
