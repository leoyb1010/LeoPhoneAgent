//
//  SSHTerminalSession.swift
//  MinisApp
//
//  交互 SSH 终端的连接层：Citadel 的 PTY 交互 shell ⇄ SwiftTerm。
//  - 连上后（默认）attach 到 tmux 会话 leobot，断线 / 回前台重连后回到原来的窗口；
//  - 键盘输入和窗口尺寸变化走同一条有序队列，按键不会乱序；
//  - 前台掉线自动重连（指数退避 3 次），退到后台久了回来直接重连（有 tmux 时无感）。
//

import Citadel
import Foundation
import NIOCore
import NIOSSH
import UIKit

private let logger = AppLogger(category: "SSHTerminal")

@MainActor
final class SSHTerminalSession: ObservableObject {
    enum Status: Equatable {
        case connecting
        case connected
        case reconnecting(attempt: Int)
        /// message 为 nil = 远端 shell 正常退出。
        case disconnected(message: String?)
    }

    let host: RemoteHost
    @Published private(set) var status: Status = .connecting
    @Published private(set) var title: String = ""
    /// 主机没有 tmux：顶部提示一次「装 tmux 可断线续接」。
    @Published var showTmuxHint = false

    /// 输出写到这里（SwiftTerm 视图）。
    weak var sink: SSHTerminalSink?

    private enum Input {
        case bytes([UInt8])
        case resize(cols: Int, rows: Int)
    }

    private var client: SSHClient?
    private var task: Task<Void, Never>?
    private var input: AsyncStream<Input>.Continuation?
    private var size = (cols: 80, rows: 24)
    private var pendingResize: Task<Void, Never>?
    private var backgroundedAt: Date?
    private var hasTmux = true
    private var everConnected = false
    private var closedByUser = false
    private var observers: [NSObjectProtocol] = []

    init(host: RemoteHost) {
        self.host = host
        let center = NotificationCenter.default
        observers.append(center.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.backgroundedAt = Date() }
        })
        observers.append(center.addObserver(forName: UIApplication.willEnterForegroundNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.returnedToForeground() }
        })
    }

    deinit {
        observers.forEach(NotificationCenter.default.removeObserver)
    }

    // MARK: - 对外

    func start(cols: Int, rows: Int) {
        size = (max(cols, 20), max(rows, 5))
        guard task == nil else { return }
        connect(attempt: 0)
    }

    func send(_ bytes: [UInt8]) {
        guard !bytes.isEmpty else { return }
        input?.yield(.bytes(bytes))
    }

    /// 旋转、键盘弹出、捏合改字号都会连续触发；合并 120ms 再发 window-change。
    func resize(cols: Int, rows: Int) {
        guard cols > 0, rows > 0, (cols, rows) != size else { return }
        size = (cols, rows)
        pendingResize?.cancel()
        pendingResize = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(120))
            guard !Task.isCancelled, let self else { return }
            self.input?.yield(.resize(cols: self.size.cols, rows: self.size.rows))
        }
    }

    func reconnectNow() {
        guard !closedByUser else { return }
        connect(attempt: 0)
    }

    func close() {
        closedByUser = true
        teardown()
    }

    // MARK: - 连接

    private func connect(attempt: Int) {
        teardown()
        status = everConnected || attempt > 0 ? .reconnecting(attempt: attempt + 1) : .connecting
        task = Task { [weak self] in
            await self?.runSession(attempt: attempt)
        }
    }

    private func teardown() {
        task?.cancel()
        task = nil
        input?.finish()
        input = nil
        if let client { Task { try? await client.close() } }
        client = nil
    }

    private func runSession(attempt: Int) async {
        let (stream, continuation) = AsyncStream<Input>.makeStream(bufferingPolicy: .unbounded)
        input = continuation
        do {
            let client = try await RemoteSSHExecutor.openClient(host: host)
            guard !Task.isCancelled else { try? await client.close(); return }
            self.client = client
            let request = SSHChannelRequestEvent.PseudoTerminalRequest(
                wantReply: true, term: "xterm-256color",
                terminalCharacterWidth: size.cols, terminalRowHeight: size.rows,
                terminalPixelWidth: 0, terminalPixelHeight: 0,
                terminalModes: SSHTerminalModes([:]))
            let bootstrap = SSHTerminalBootstrap.command(autoTmux: RemoteHostStore.autoTmux)
            try await client.withPTY(request) { inbound, outbound in
                await MainActor.run {
                    self.status = .connected
                    self.everConnected = true
                }
                if let bootstrap { try await outbound.write(ByteBuffer(string: bootstrap)) }
                try await withThrowingTaskGroup(of: Void.self) { group in
                    // 输入：按到达顺序逐条写，按键和 window-change 不会乱序。
                    group.addTask {
                        for await item in stream {
                            switch item {
                            case .bytes(let bytes):
                                try await outbound.write(ByteBuffer(bytes: bytes))
                            case .resize(let cols, let rows):
                                try await outbound.changeSize(cols: cols, rows: rows, pixelWidth: 0, pixelHeight: 0)
                            }
                        }
                    }
                    // 输出：远端 shell 退出或连接断开时这个循环结束。
                    group.addTask {
                        for try await chunk in inbound {
                            switch chunk {
                            case .stdout(let buffer), .stderr(let buffer):
                                let bytes = Array(buffer.readableBytesView)
                                await MainActor.run { self.sink?.feed(bytes) }
                            }
                        }
                    }
                    _ = try await group.next()
                    group.cancelAll()
                }
            }
            guard !Task.isCancelled else { return }
            status = .disconnected(message: nil)
        } catch {
            guard !Task.isCancelled, !closedByUser else { return }
            logger.info("terminal session ended host=\(host.name): \(error.localizedDescription)")
            // 认证 / 指纹 / 未固定公钥这类错误重试也没用，直接给出说明。
            if !Self.isFatal(error), attempt < 3, UIApplication.shared.applicationState != .background {
                status = .reconnecting(attempt: attempt + 1)
                try? await Task.sleep(for: .seconds(pow(2, Double(attempt))))
                guard !Task.isCancelled, !closedByUser else { return }
                connect(attempt: attempt + 1)
                return
            }
            status = .disconnected(message: RemoteSSHExecutor.describe(error, host: host))
        }
    }

    private static func isFatal(_ error: Error) -> Bool {
        if error is InvalidHostKey || error is RemoteSSHError { return true }
        if case SSHClientError.allAuthenticationOptionsFailed = error { return true }
        return false
    }

    private func returnedToForeground() {
        guard !closedByUser else { return }
        let away = backgroundedAt.map { Date().timeIntervalSince($0) } ?? 0
        backgroundedAt = nil
        switch status {
        case .connected:
            // 后台久了 iOS 多半已经掐掉了套接字但 NIO 还没发现；有 tmux 时直接重连，回到的还是原来的窗口。
            if client?.isConnected != true || (away > 20 && hasTmux && RemoteHostStore.autoTmux) {
                connect(attempt: 0)
            }
        case .disconnected(let message) where message != nil:
            connect(attempt: 0)
        default:
            break
        }
    }

    // MARK: - 来自终端视图

    func titleChanged(_ newTitle: String) {
        if newTitle == SSHTerminalBootstrap.noTmuxTitle {
            hasTmux = false
            let key = "leo.sshTerminal.tmuxHintShown"
            var shown = Set(UserDefaults.standard.stringArray(forKey: key) ?? [])
            if !shown.contains(host.id) {
                shown.insert(host.id)
                UserDefaults.standard.set(Array(shown), forKey: key)
                showTmuxHint = true
            }
            return
        }
        title = newTitle
    }
}

/// SSHTerminalSession 往视图里写输出用（避免连接层直接依赖 SwiftTerm）。
@MainActor
protocol SSHTerminalSink: AnyObject {
    func feed(_ bytes: [UInt8])
    /// 整段文本（全屏输入）：远端开了 bracketed paste 时包起来，多行不会被逐行执行。
    func paste(text: String)
    func focus()
}

/// 对外入口：远程主机列表、Mac 控制台机器卡片都调这里，全屏打开交互终端。
@MainActor
enum SSHTerminalLauncher {
    /// 打开一台已配置的 SSH 主机（设置 → 远程主机里的）。
    static func open(host: RemoteHost) {
        guard let presenter = BackupOpenRouter.topViewController() else { return }
        let controller = SSHTerminalHostingController(host: host)
        presenter.present(controller, animated: true)
    }

    /// 打开一台已配对的 Mac：优先用「远程主机」里绑定到这台设备的配置（端口、密码、指纹都按用户填的），
    /// 否则用 Mac 广播的 SSH 目标 + 经配对通道读到的主机公钥。都没有时返回说明文字，由调用方提示。
    @discardableResult
    static func open(mac: GatewayHost) -> String? {
        if let deviceId = mac.device?.deviceId,
           let configured = RemoteHostStore.shared.hosts.first(where: { $0.deviceId == deviceId && $0.trustedHostKey != nil }) {
            open(host: configured)
            return nil
        }
        guard let target = mac.resolvedSSHTarget else { return AppLocalized("不知道这台 Mac 的 SSH 地址：在 设置 → 远程机器 里填。") }
        guard let key = mac.sshHostKey else { return AppLocalized("还没固定这台 Mac 的 SSH 主机公钥：先经直连或中继连上一次。") }
        guard RemoteHostStore.hasAnyKey else { return AppLocalized("这台 iPhone 还没有 SSH 钥匙：到 设置 → 远程主机 生成或导入。") }
        // ponytail: 端口跟 MacSSHFallback 一样先用 22；Mac 广播端口后改成同一个来源。
        let address = target.address
        open(host: RemoteHost(
            id: "leo-ssh-terminal-" + mac.id, name: mac.name, host: address, port: 22, username: target.user,
            deviceId: mac.device?.deviceId, trustedHostKey: key,
            trustedHostKeyEndpoint: RemoteSSHTrust.endpoint(host: address, port: 22)))
        return nil
    }
}
