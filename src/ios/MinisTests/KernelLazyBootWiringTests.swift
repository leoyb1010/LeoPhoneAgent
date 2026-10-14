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
        XCTAssertTrue(manager.contains("Task { @MainActor in\n                MirrorSpeedTestViewModel.shared.autoDetectOnceIfNeeded()"))
        // 后台起的内核补装 CPU 调速器。
        XCTAssertTrue(manager.contains("BackgroundKeepAliveManager.shared.kernelDidBoot()"))
        // 同步阻塞入口已删:没有调用方,留着就会有人在主线程上用。
        XCTAssertFalse(manager.contains("ensureKernelBootedBlocking"))
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

    /// VM 的 ensureKernelBooted() 只把共享启动投影到 kernelStatus 上,不再自己 boot;
    /// 现在只剩启动失败界面的「重试」在用。
    func testViewModelKernelEntryOnlyProjectsTheSharedBoot() throws {
        let misc = try source("Agent/Chat/AIChatViewModel+Misc.swift")
        XCTAssertTrue(misc.contains("try await manager.ensureKernelBooted(reason: reason)"))
        XCTAssertFalse(misc.contains("bootKernelIfNeeded"), "同步入口已删")
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

    /// [1.70] 发送 / 重试 / 继续不再起内核:纯对话一轮不碰内核,真要用的工具各自按需启动。
    func testSendingAMessageDoesNotStartTheKernel() throws {
        let vm = try source("Agent/Chat/AIChatViewModel.swift")
        XCTAssertFalse(vm.contains("ensureKernelBooted()"), "发送路径不再调用 ensureKernelBooted()")
        let coordinator = try source("Agent/ISH/ISHExecutionCoordinator.swift")
        XCTAssertTrue(coordinator.contains("ensureKernelBooted(reason: \"shell-tool\")"), "shell 工具自己按需启动")
        XCTAssertTrue(coordinator.contains("ensureKernelBooted(reason: \"mount\")"), "挂载按需启动")
    }

    /// 内核没起时挂载表是空的:读用户挂载目录前要先铺挂载,否则落到会话回退路径读到假位置。
    func testReadingAMountedFolderPrimesTheMountTableFirst() throws {
        let files = try source("Agent/Chat/AIChatViewModel+FileTools.swift")
        let body = try XCTUnwrap(files.range(of: "func resolvePathForDirectRead("))
        let text = String(files[body.lowerBound...])
        let prime = try XCTUnwrap(text.range(of: "await ISHExecutionCoordinator.shared.ensureMounted(for: sid)"))
        let lookup = try XCTUnwrap(text.range(of: "await ISHExecutionCoordinator.shared.hostURL(for: linuxPath)"))
        XCTAssertLessThan(prime.lowerBound, lookup.lowerBound)
        XCTAssertTrue(text.contains("linuxPath.hasPrefix(\"/var/minis/mounts/\"), let sid = self.subAgentFSSessionId"))
    }

    /// 能力自检在主 actor 上:不能同步阻塞等内核。
    func testCapabilitySelfTestAwaitsTheKernel() throws {
        let view = try source("Views/Settings/CapabilitySelfTestView.swift")
        XCTAssertTrue(view.contains("try await KernelBootManager.shared.ensureKernelBooted(reason: \"capability-self-test\")"))
    }

    /// 后台 CPU 调速器(10 Hz)只在内核真起来时装;内核在后台才起时补装。
    func testBackgroundCPUGovernorOnlyArmsWithABootedKernel() throws {
        let bka = try source("Agent/Background/BackgroundKeepAliveManager.swift")
        let begins = bka.components(separatedBy: "ISHKernel.shared.beginBackgroundCPUGovernor()").count - 1
        XCTAssertEqual(begins, 1, "只有 armCPUGovernorIfKernelBooted 一处装调速器")
        let helper = try XCTUnwrap(bka.range(of: "private func armCPUGovernorIfKernelBooted("))
        let after = String(bka[helper.lowerBound...])
        let guardRange = try XCTUnwrap(after.range(of: "guard ISHKernel.shared.isBooted else"))
        let begin = try XCTUnwrap(after.range(of: "ISHKernel.shared.beginBackgroundCPUGovernor()"))
        XCTAssertLessThan(guardRange.lowerBound, begin.lowerBound)
        XCTAssertTrue(bka.contains("func kernelDidBoot()"))
        XCTAssertTrue(bka.contains("armCPUGovernorIfKernelBooted(caller: \"didEnterBackground\")"))
        XCTAssertTrue(bka.contains("armCPUGovernorIfKernelBooted(caller: \"setup.launchedInBackground\")"))
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
