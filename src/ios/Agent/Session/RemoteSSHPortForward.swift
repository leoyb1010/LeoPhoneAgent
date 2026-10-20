//
//  RemoteSSHPortForward.swift
//  MinisApp
//
//  本地端口转发：iPhone 上 127.0.0.1:<本地端口> ← SSH direct-tcpip → 远程 host:port。
//  用来在 App 内的 Safari 页里预览 Mac 上跑着的 dev server（App 内打开才不会把 App 推到后台）。只在 App 前台期间有效：
//  退到后台时关掉监听（iOS 反正会挂起套接字），回到前台自动重新打开之前开着的规则。
//

@preconcurrency import Citadel
import Foundation
import NIOCore
import NIOPosix
import NIOSSH
import UIKit

private let logger = AppLogger(category: "SSHPortForward")

@MainActor
final class SSHPortForwardManager: ObservableObject {
    static let shared = SSHPortForwardManager()

    enum State: Equatable {
        case starting
        case active
        case failed(String)
    }

    /// ruleId → 状态。没有条目 = 关着。
    @Published private(set) var states: [String: State] = [:]

    private struct Running {
        let client: SSHClient
        let listener: Channel
    }

    private var running: [String: Running] = [:]
    /// 退到后台时开着的规则，回前台重开。
    private var resumeOnForeground: [(RemoteHost, SSHPortForwardRule)] = []
    private var observers: [NSObjectProtocol] = []

    private init() {
        let center = NotificationCenter.default
        observers.append(center.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.suspendAll() }
        })
        observers.append(center.addObserver(forName: UIApplication.willEnterForegroundNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.resumeAll() }
        })
    }

    var activeCount: Int { states.values.filter { $0 == .active }.count }

    func start(host: RemoteHost, rule: SSHPortForwardRule) {
        guard running[rule.id] == nil, states[rule.id] != .starting else { return }
        states[rule.id] = .starting
        Task {
            do {
                let started = try await Self.open(host: host, rule: rule)
                // 等连接期间用户可能已经点了关闭。
                guard states[rule.id] == .starting, running[rule.id] == nil else {
                    Self.close(started)
                    return
                }
                running[rule.id] = started
                states[rule.id] = .active
                started.client.onDisconnect {
                    Task { @MainActor in SSHPortForwardManager.shared.connectionDropped(ruleId: rule.id) }
                }
            } catch {
                logger.error("port forward \(rule.localPort) failed: \(error.localizedDescription)")
                states[rule.id] = .failed(Self.describe(error, host: host, rule: rule))
            }
        }
    }

    func stop(_ ruleId: String) {
        if let entry = running.removeValue(forKey: ruleId) { Self.close(entry) }
        states[ruleId] = nil
    }

    private func connectionDropped(ruleId: String) {
        guard let entry = running.removeValue(forKey: ruleId) else { return }
        Self.close(entry)
        states[ruleId] = .failed(AppLocalized("SSH 连接断开了，点开关重连。"))
    }

    private func suspendAll() {
        let hosts = RemoteHostStore.shared.hosts
        resumeOnForeground = running.keys.compactMap { ruleId in
            for host in hosts {
                if let rule = host.portForwards?.first(where: { $0.id == ruleId }) { return (host, rule) }
            }
            return nil
        }
        for ruleId in Array(running.keys) { stop(ruleId) }
    }

    private func resumeAll() {
        let pending = resumeOnForeground
        resumeOnForeground = []
        for (host, rule) in pending { start(host: host, rule: rule) }
    }

    // MARK: - NIO

    private nonisolated static func open(host: RemoteHost, rule: SSHPortForwardRule) async throws -> Running {
        let client = try await RemoteSSHExecutor.openClient(host: host)
        do {
            let target = rule.remoteHost
            let targetPort = rule.remotePort
            // 每个本地连接开一条 direct-tcpip 通道，两边互相转发字节。
            // 本地连接先不读（autoRead 关），通道建好才开始读，避免第一包请求丢掉。
            let listener = try await ServerBootstrap(group: MultiThreadedEventLoopGroup.singleton)
                .serverChannelOption(ChannelOptions.socketOption(.so_reuseaddr), value: 1)
                .childChannelOption(ChannelOptions.autoRead, value: false)
                .childChannelInitializer { local in
                    let originator = local.remoteAddress ?? (try! SocketAddress(ipAddress: "127.0.0.1", port: 0))
                    let settings = SSHChannelType.DirectTCPIP(targetHost: target, targetPort: targetPort,
                                                             originatorAddress: originator)
                    return local.eventLoop.makeFutureWithTask {
                        let remote = try await client.createDirectTCPIPChannel(using: settings) { remote in
                            remote.pipeline.addHandler(ByteRelay(partner: local))
                        }
                        try await local.pipeline.addHandler(ByteRelay(partner: remote)).get()
                        try await local.setOption(ChannelOptions.autoRead, value: true).get()
                    }
                }
                .bind(host: "127.0.0.1", port: rule.localPort)
                .get()
            return Running(client: client, listener: listener)
        } catch {
            try? await client.close()
            throw error
        }
    }

    private nonisolated static func close(_ entry: Running) {
        entry.listener.close(promise: nil)
        Task { try? await entry.client.close() }
    }

    private nonisolated static func describe(_ error: Error, host: RemoteHost, rule: SSHPortForwardRule) -> String {
        if let io = error as? IOError, io.errnoCode == EADDRINUSE {
            return AppLocalized("本地端口 \(String(rule.localPort)) 已被占用，换一个端口。")
        }
        return RemoteSSHExecutor.describe(error, host: host)
    }
}

/// 把收到的字节原样写给对端；一边关了，等已经发出的写完再关另一边（不截断最后一段响应）。
/// ponytail: 没做背压（对端写缓冲不限），预览 dev server 足够；要传大文件再按 NIO GlueHandler 加 writability 控制。
private final class ByteRelay: ChannelInboundHandler, @unchecked Sendable {
    typealias InboundIn = ByteBuffer

    private let partner: Channel
    private var lastWrite: EventLoopFuture<Void>?

    init(partner: Channel) { self.partner = partner }

    func channelRead(context: ChannelHandlerContext, data: NIOAny) {
        lastWrite = partner.writeAndFlush(unwrapInboundIn(data))
    }

    func channelInactive(context: ChannelHandlerContext) {
        closePartnerAfterWrites()
        context.fireChannelInactive()
    }

    func userInboundEventTriggered(context: ChannelHandlerContext, event: Any) {
        // SSH 通道开了半关：对端发 EOF 时这里收到 inputClosed，整条连接收尾。
        if let channelEvent = event as? ChannelEvent, case .inputClosed = channelEvent {
            closePartnerAfterWrites()
            context.close(promise: nil)
        }
        context.fireUserInboundEventTriggered(event)
    }

    func errorCaught(context: ChannelHandlerContext, error: Error) {
        context.close(promise: nil)
        partner.close(promise: nil)
    }

    private func closePartnerAfterWrites() {
        let partner = self.partner
        guard let lastWrite else { partner.close(promise: nil); return }
        lastWrite.whenComplete { _ in partner.close(promise: nil) }
    }
}
