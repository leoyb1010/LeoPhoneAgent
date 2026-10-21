//
//  RemoteSSHExecutor.swift
//  MinisApp
//
//  [T-remote-exec] Native SSH execution via Citadel (swift-nio-ssh).
//
//  Native rather than routed through the iSH guest so it works with the
//  kernel cold and without emulator latency — the same design call
//  NativeMCPClient made for HTTP MCP.
//
//  Scope:
//    • password, or the default key (imported ed25519/rsa, else the device
//      Ed25519 key) — all Keychain-held
//    • explicit host-key pinning, bound to the configured address and port
//    • one command per connection; timeout / Stop close the client
//    • openClient() is shared with the interactive terminal and port forwarding
//

import Foundation
import Citadel
import Network
import NIOCore
import NIOSSH

private let logger = AppLogger(category: "RemoteSSH")

actor RemoteSSHExecutor {
    static let shared = RemoteSSHExecutor()

    struct ExecResult {
        let output: String
        let succeeded: Bool
        /// 命令的退出码（拿到 `[leo-exit:N]` 尾巴时才有）。
        var exitCode: String? = nil
        /// 连接 / 认证阶段就失败了：命令一定没跑，换网关重试是安全的。
        var connectFailed = false
    }

    /// 和 ToolArgNumbers.remoteAgentTimeoutRange 一致（claude -p 跑一整个任务常常超过 10 分钟）。
    static let maxTimeout: TimeInterval = 1800

    /// Runs one command on `host`. Never throws credentials or the resolved
    /// command into the error text.
    func run(host: RemoteHost, command: String, timeout: TimeInterval) async -> ExecResult {
        let clampedTimeout = min(max(timeout, 5), Self.maxTimeout)
        let client: SSHClient
        do {
            client = try await Self.openClient(host: host)
        } catch {
            return ExecResult(output: Self.describe(error, host: host), succeeded: false, connectFailed: true)
        }
        defer { Task { try? await client.close() } }
        do {
            // [T-remote-exit-wrapper] Citadel throws on a non-zero exit and
            // keeps stderr on a separate stream — a failing command would lose
            // BOTH its output and its stderr. Force exit 0 and merge streams
            // in shell, carry the real status as a trailer we parse off.
            let wrapped = "{ \(command)\n} 2>&1; printf '\\n[leo-exit:%d]' \"$?\""
            // 边收边解码边裁：按字符边界解码（汉字不被切坏），只留头 4000 + 尾 16000，不把全部输出攒进内存。
            let clipped = try await Self.withTimeout(clampedTimeout, client: client) {
                var decoder = SSHUTF8Decoder()
                var clip = SSHOutputClip()
                for try await chunk in try await client.executeCommandStream(wrapped) {
                    switch chunk {
                    case .stdout(let buffer), .stderr(let buffer):
                        clip.append(decoder.decode(buffer.readableBytesView))
                    }
                }
                clip.append(decoder.flush())
                return clip.text
            }
            var (text, code) = RemoteSSHText.splitExitTrailer(clipped)
            let exitOK = code == nil || code == "0"
            if let code, !exitOK { text += "\n[exit code \(code)]" }
            if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                text = "(command produced no output)"
            }
            return ExecResult(output: text, succeeded: exitOK, exitCode: code)
        } catch RemoteSSHError.timeout {
            return ExecResult(
                output: "Remote command timed out after \(Int(clampedTimeout))s on '\(host.name)'. The connection was closed; the remote process may still be running.",
                succeeded: false)
        } catch {
            // Deliberately generic: no host password, no expanded command.
            logger.error("remote exec failed host=\(host.name): \(error.localizedDescription)")
            return ExecResult(output: Self.describe(error, host: host), succeeded: false)
        }
    }

    /// [fix-remote] 流式执行一条命令（SSH 兜底跑 CLI 的一轮回复）：按行回调 stdout，stderr 留最后几行做失败说明。
    /// 只认显式固定的主机公钥；凭据与命令都不进错误文字。
    func stream(host: RemoteHost, command: String, timeout: TimeInterval,
                onStderr: (@Sendable (String) async -> Void)? = nil,
                onLine: @escaping @Sendable (String) async -> Void) async -> ExecResult {
        let clamped = min(max(timeout, 10), Self.maxTimeout)
        let client: SSHClient
        do {
            client = try await Self.openClient(host: host)
        } catch {
            logger.error("ssh fallback connect failed host=\(host.name): \(error.localizedDescription)")
            return ExecResult(output: Self.describe(error, host: host), succeeded: false, connectFailed: true)
        }
        defer { Task { try? await client.close() } }
        do {
            let wrapped = "{ \(command)\n}; printf '\\n[leo-exit:%d]\\n' \"$?\""
            let (exitCode, stderrTail) = try await Self.withTimeout(clamped, client: client) { () -> (String?, [String]) in
                // 按字节缓冲到换行再整行解码：一个汉字被分包切开时不会变成 �。
                var stdout = SSHLineBuffer()
                var stderr = SSHLineBuffer()
                var exitCode: String?
                var stderrTail: [String] = []
                func handle(_ line: String) async {
                    if line.hasPrefix("[leo-exit:"), line.hasSuffix("]") {
                        exitCode = String(line.dropFirst(10).dropLast())
                    } else {
                        await onLine(line)
                    }
                }
                for try await chunk in try await client.executeCommandStream(wrapped) {
                    switch chunk {
                    case .stdout(let buffer):
                        for line in stdout.append(buffer.readableBytesView) { await handle(line) }
                    case .stderr(let buffer):
                        for line in stderr.append(buffer.readableBytesView) where !line.isEmpty {
                            stderrTail.append(String(line.prefix(300)))
                            await onStderr?(String(line.prefix(300)))
                        }
                        if stderrTail.count > 6 { stderrTail.removeFirst(stderrTail.count - 6) }
                    }
                }
                if let rest = stdout.flush() { await handle(rest) }
                if let rest = stderr.flush(), !rest.isEmpty { stderrTail.append(String(rest.prefix(300))) }
                return (exitCode, stderrTail)
            }
            let ok = exitCode == "0"
            return ExecResult(output: ok ? "" : (stderrTail.joined(separator: "\n").isEmpty ? "退出码 \(exitCode ?? "?")" : stderrTail.joined(separator: "\n")),
                              succeeded: ok, exitCode: exitCode)
        } catch RemoteSSHError.timeout {
            return ExecResult(output: "SSH 上的命令 \(Int(clamped)) 秒没跑完，已断开。", succeeded: false)
        } catch {
            logger.error("ssh fallback failed host=\(host.name): \(error.localizedDescription)")
            return ExecResult(output: Self.describe(error, host: host), succeeded: false)
        }
    }

    // MARK: - 连接（执行器、交互终端、端口转发共用）

    /// 校验固定的主机公钥 → 选凭据 → 连上。密码被服务器拒绝时只标记失效（不删），有钥匙就用钥匙再试一次。
    nonisolated static func openClient(host: RemoteHost, connectTimeout: TimeInterval = 15) async throws -> SSHClient {
        // 在读取凭据/建立认证之前要求显式可信 pin，旧配置安全迁移为未受信。
        guard let keyLine = RemoteSSHTrust.pinnedKey(host: host.host, port: host.port,
                key: host.trustedHostKey, trustedEndpoint: host.trustedHostKeyEndpoint),
              let hostKey = try? NIOSSHPublicKey(openSSHPublicKey: keyLine) else {
            throw RemoteSSHError.untrustedHostKey
        }
        guard RemoteSSHTrust.directPublicKey(keyLine) != nil else { throw RemoteSSHError.directNeedsEd25519 }

        func connect(_ auth: SSHAuthenticationMethod) async throws -> SSHClient {
            try await SSHClient.connect(
                host: host.host, port: host.port, authenticationMethod: auth,
                hostKeyValidator: .trustedKeys([hostKey]), reconnect: .never,
                connectTimeout: .milliseconds(Int64(connectTimeout * 1000)))
        }
        let key = RemoteHostStore.keyAuthentication(username: host.username)
        // [T-ssh-key-auth] 有已存密码就先用（被拒过且有钥匙时跳过），否则用钥匙。
        if let password = RemoteHostStore.password(hostId: host.id), !password.isEmpty,
           !(RemoteHostStore.isPasswordRejected(hostId: host.id) && key != nil) {
            do {
                let client = try await connect(.passwordBased(username: host.username, password: password))
                RemoteHostStore.setPasswordRejected(false, hostId: host.id)
                return client
            } catch SSHClientError.allAuthenticationOptionsFailed {
                // [T-ssh-auth-fallback] 只有服务器明确拒绝密码才走这里；网络断、Stop 等别的错误不碰密码。
                // 以前直接删掉已存密码 —— 服务器临时改策略时用户的密码就丢了。现在只标记、在设置里提示。
                RemoteHostStore.setPasswordRejected(true, hostId: host.id)
                guard let key else { throw RemoteSSHError.passwordRejected }
                logger.info("password auth failed for \(host.name) — retrying with key")
                return try await connect(key)
            }
        }
        guard let key else { throw RemoteSSHError.noCredential }
        return try await connect(key)
    }

    /// 超时先关连接再等任务组：executeCommandStream 不响应任务取消，不关的话任务组要等命令自己跑完才会退出，
    /// 「超时」就形同虚设。外层任务被取消（用户点停止）时同样关连接。
    nonisolated static func withTimeout<T: Sendable>(_ seconds: TimeInterval, client: SSHClient,
                                                     _ body: @escaping @Sendable () async throws -> T) async throws -> T {
        let timedOut = TimeoutFlag()
        do {
            return try await withTaskCancellationHandler {
                try await withThrowingTaskGroup(of: T.self) { group in
                    group.addTask { try await body() }
                    group.addTask {
                        try await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
                        timedOut.set()
                        try? await client.close()
                        throw RemoteSSHError.timeout
                    }
                    guard let first = try await group.next() else { throw RemoteSSHError.timeout }
                    group.cancelAll()
                    return first
                }
            } onCancel: {
                Task { try? await client.close() }
            }
        } catch {
            // 关连接后命令流可能先以「通道关闭」报错，抢在计时任务前面；按超时算。
            if timedOut.value { throw RemoteSSHError.timeout }
            throw error
        }
    }

    /// 给人看的错误说明（不含密码与命令）。
    nonisolated static func describe(_ error: Error, host: RemoteHost) -> String {
        var message: String
        switch error {
        case RemoteSSHError.untrustedHostKey:
            message = "SSH host key is not trusted for this address and port. In Settings → Remote Hosts, verify the server public host key (or tap 重新读取指纹) before connecting."
        case RemoteSSHError.directNeedsEd25519:
            message = "Direct SSH currently requires a verified ssh-ed25519 server host key: the bundled SSH library cannot select another pinned host-key algorithm. From the server's trusted console, read /etc/ssh/ssh_host_ed25519_key.pub and verify that key in Settings → Remote Hosts. The existing pin has not been changed; gateway OpenSSH still supports it."
        case RemoteSSHError.noCredential:
            message = "No credential for host '\(host.name)': store a password, or generate/import a key in Settings → Remote Hosts and add its public key to the host's ~/.ssh/authorized_keys."
        case RemoteSSHError.passwordRejected:
            message = "SSH 密码被 \(host.username)@\(host.host) 拒绝（已存的密码保留，只标记为失效）。到 设置 → 远程主机 重新填密码，或改用钥匙登录。"
        case is InvalidHostKey:
            message = "SSH 主机指纹变了：\(host.host):\(host.port) 出示的主机公钥和已固定的不一致（可能重装了系统、换了机器，或网络被劫持），已拒绝连接。确认是你自己的机器后，到 设置 → 远程主机 → \(host.name) 点「重新读取指纹」核对并更新。"
        case SSHClientError.allAuthenticationOptionsFailed:
            message = "SSH 认证被 \(host.username)@\(host.host) 拒绝：确认这台 iPhone 的公钥已加进对方的 ~/.ssh/authorized_keys，或在设置里填密码。"
            if RemoteHostStore.isPasswordRejected(hostId: host.id) { message += "（已存的密码也被拒绝过。）" }
        default:
            message = "SSH to '\(host.name)' (\(host.username)@\(host.host):\(host.port)) failed: \(error.localizedDescription)"
        }
        if host.host.hasPrefix("100."), !(error is InvalidHostKey) {
            message += "\nThis looks like a Tailscale address — make sure the Tailscale app on THIS device is connected (it shows offline peers as unreachable)."
        }
        return message
    }

    /// 「重新读取指纹」：连上去只看服务器出示的主机公钥，立刻断开（不发送任何凭据）。由用户确认后才固定。
    nonisolated static func fetchHostKey(host: String, port: Int, username: String) async throws -> String {
        let capture = HostKeyCapture()
        do {
            let client = try await SSHClient.connect(
                host: host, port: port, authenticationMethod: .passwordBased(username: username, password: ""),
                hostKeyValidator: .custom(capture), reconnect: .never, connectTimeout: .seconds(10))
            try? await client.close()
        } catch {
            guard capture.key == nil else { return capture.key! }
            throw error
        }
        guard let key = capture.key else { throw RemoteSSHError.untrustedHostKey }
        return key
    }

    /// [T-remote-gateway] Cindy-style relay, automated: try the target
    /// directly; if its TCP is unreachable but ANOTHER configured host is
    /// reachable, run the command THERE wrapped in `ssh target`. One reachable
    /// machine (e.g. the Studio over LAN) makes every machine on its tailnet
    /// usable — no phone-side VPN required. Requires the gateway to hold ssh
    /// keys for the target (set up 2026-07-29 for the user's three machines).
    func runSmart(target: RemoteHost, allHosts: [RemoteHost], command: String, timeout: TimeInterval) async -> ExecResult {
        guard let targetKey = RemoteSSHTrust.pinnedKey(host: target.host, port: target.port,
                key: target.trustedHostKey, trustedEndpoint: target.trustedHostKeyEndpoint),
              Self.isValidHostKey(targetKey) else {
            return ExecResult(output: "The target SSH host key must be verified in Settings → Remote Hosts before direct or gateway execution.", succeeded: false)
        }
        // Direct needs an Ed25519 pin (library limit); any other pinned algorithm
        // goes through a gateway's OpenSSH instead of failing here.
        if RemoteSSHTrust.directPublicKey(targetKey) != nil,
           await Self.tcpProbe(host: target.host, port: target.port, timeout: 4) {
            return await run(host: target, command: command, timeout: timeout)
        }
        var lastRelayFailure: String?
        for gateway in allHosts where gateway.id != target.id {
            guard let gatewayKey = RemoteSSHTrust.pinnedKey(host: gateway.host, port: gateway.port,
                    key: gateway.trustedHostKey, trustedEndpoint: gateway.trustedHostKeyEndpoint),
                  Self.isValidHostKey(gatewayKey) else { continue }
            guard await Self.tcpProbe(host: gateway.host, port: gateway.port, timeout: 4) else { continue }
            guard let relayed = RemoteSSHTrust.relayCommand(host: target.host, port: target.port,
                    username: target.username, publicKey: targetKey, command: command) else {
                return ExecResult(output: "Invalid SSH target address, port or verified public key.", succeeded: false)
            }
            let result = await run(host: gateway, command: relayed, timeout: timeout)
            let output = RemoteSSHText.stripRelayMarker(result.output)
            if result.succeeded {
                return ExecResult(
                    output: "[via \(gateway.name) — target not directly reachable from this device]\n" + output,
                    succeeded: true)
            }
            // 只有连接/认证阶段的失败才换下一个网关：连不上这个网关本身，或网关上的 ssh 没连上目标
            // （255 且目标从没打出开始标记）。命令自己 exit 255 时标记已经打出 —— 命令已经在目标上跑过，
            // 换网关重跑会把副作用执行两遍。
            if !result.connectFailed && !RemoteSSHText.relayMayRetry(output: result.output, exitCode: result.exitCode) {
                return ExecResult(output: "[via \(gateway.name)] " + output, succeeded: false, exitCode: result.exitCode)
            }
            lastRelayFailure = "[via \(gateway.name)] " + output
        }
        if let lastRelayFailure {
            return ExecResult(output: lastRelayFailure, succeeded: false)
        }
        if RemoteSSHTrust.directPublicKey(targetKey) == nil {
            return ExecResult(output: "Direct SSH needs a verified ssh-ed25519 host key for this target (the bundled SSH library cannot pin other algorithms), and no other verified, reachable host is available to relay through. Pin the ed25519 key from /etc/ssh/ssh_host_ed25519_key.pub, or verify a gateway host.", succeeded: false)
        }
        return ExecResult(
            output: "TCP \(target.host):\(target.port) unreachable, and no other configured host is reachable to relay through. Tip: while on the same Wi-Fi as one of your machines, add its LAN address (192.168.x) as a host — everything else is then reached through it automatically.",
            succeeded: false)
    }

    /// Settings-page connectivity test — layered so the result names WHICH
    /// layer failed: raw TCP reachability first (a VPN/Tailscale problem shows
    /// up here), then the full SSH + auth + exec path.
    func test(host: RemoteHost) async -> ExecResult {
        let tcp = await Self.tcpProbe(host: host.host, port: host.port, timeout: 4)
        guard tcp else {
            var message = "TCP \(host.host):\(host.port) UNREACHABLE — this is a network problem, not SSH."
            if host.host.hasPrefix("100.") {
                message += " 100.x is a Tailscale address: a third-party Tailscale client connected only inside its own app does NOT route other apps' traffic — it must run in system VPN/TUN mode (iOS Settings → VPN shows Connected), or use the machine's LAN IP (192.168.x) instead while on the same Wi-Fi."
            } else if host.host.hasPrefix("192.168.") || host.host.hasPrefix("10.") {
                message += " For LAN addresses iOS asks for Local Network permission on first use — if no prompt appeared, check Settings → Privacy & Security → Local Network → LeoBot."
            }
            return ExecResult(output: message, succeeded: false)
        }
        let result = await run(host: host, command: "echo LEO_OK && uname -a", timeout: 15)
        return ExecResult(output: "TCP \(host.host):\(host.port) reachable ✓\n" + result.output,
                          succeeded: result.succeeded)
    }

    nonisolated static func isValidHostKey(_ value: String) -> Bool {
        guard let normalized = RemoteSSHTrust.normalizedPublicKey(value) else { return false }
        return (try? NIOSSHPublicKey(openSSHPublicKey: normalized)) != nil
    }

    /// Plain TCP connect probe via Network.framework.
    /// Public reachability probe for the fleet view.
    nonisolated static func probe(host: RemoteHost) async -> Bool {
        await tcpProbe(host: host.host, port: host.port, timeout: 4)
    }

    private static func tcpProbe(host: String, port: Int, timeout: TimeInterval) async -> Bool {
        await withCheckedContinuation { continuation in
            let connection = NWConnection(
                host: NWEndpoint.Host(host),
                port: NWEndpoint.Port(integerLiteral: UInt16(clamping: port)),
                using: .tcp)
            let lock = NSLock()
            var finished = false
            func finish(_ ok: Bool) {
                lock.lock(); defer { lock.unlock() }
                guard !finished else { return }
                finished = true
                connection.cancel()
                continuation.resume(returning: ok)
            }
            connection.stateUpdateHandler = { state in
                if case .waiting = state { finish(false); return }
                switch state {
                case .ready: finish(true)
                case .failed, .cancelled: finish(false)
                default: break
                }
            }
            connection.start(queue: .global(qos: .userInitiated))
            DispatchQueue.global().asyncAfter(deadline: .now() + timeout) { finish(false) }
        }
    }
}

enum RemoteSSHError: Error {
    case timeout
    case untrustedHostKey
    case directNeedsEd25519
    case noCredential
    case passwordRejected
    case hostKeyCaptured
}

/// 超时标记（计时任务和外层 catch 之间共享）。
private final class TimeoutFlag: @unchecked Sendable {
    private let lock = NSLock()
    private var flag = false
    var value: Bool { lock.lock(); defer { lock.unlock() }; return flag }
    func set() { lock.lock(); flag = true; lock.unlock() }
}

/// 只记下服务器出示的主机公钥然后拒绝握手，不会走到认证（不发送任何凭据）。
private final class HostKeyCapture: NIOSSHClientServerAuthenticationDelegate, @unchecked Sendable {
    private let lock = NSLock()
    private var captured: String?
    var key: String? { lock.lock(); defer { lock.unlock() }; return captured }

    func validateHostKey(hostKey: NIOSSHPublicKey, validationCompletePromise: EventLoopPromise<Void>) {
        lock.lock(); captured = String(openSSHPublicKey: hostKey); lock.unlock()
        validationCompletePromise.fail(RemoteSSHError.hostKeyCaptured)
    }
}

/// Shell-single-quote escaping shared by the remote tools.
enum RemoteShellQuoting {
    static func singleQuoted(_ s: String) -> String {
        RemoteSSHTrust.singleQuoted(s)
    }
}
