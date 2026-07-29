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
//  MVP scope (deliberate):
//    • password auth only (Keychain-held; key auth is a later add)
//    • host-key validation accepts on first use (personal, LAN-first tool;
//      pinning is a follow-up)
//    • one command per connection; a per-call timeout closes the client,
//      which is also the cancellation story for now
//

import Foundation
import Citadel
import Network
import NIOCore

private let logger = AppLogger(category: "RemoteSSH")

actor RemoteSSHExecutor {
    static let shared = RemoteSSHExecutor()

    struct ExecResult {
        let output: String
        let succeeded: Bool
    }

    private static let maxOutputChars = 20000

    /// Runs one command on `host`. Never throws credentials or the resolved
    /// command into the error text.
    func run(host: RemoteHost, command: String, timeout: TimeInterval, isKeyRetry: Bool = false) async -> ExecResult {
        // [T-ssh-key-auth] Password when stored, else the device Ed25519 key —
        // key-only hosts (the recommended setup) no longer require a password.
        let auth: SSHAuthenticationMethod
        var usedPassword = false
        if let password = RemoteHostStore.password(hostId: host.id), !password.isEmpty {
            usedPassword = true
            auth = .passwordBased(username: host.username, password: password)
        } else if let key = RemoteHostStore.devicePrivateKey() {
            auth = .ed25519(username: host.username, privateKey: key)
        } else {
            return ExecResult(
                output: "No credential for host '\(host.name)': store a password, or generate the device key in Settings → Remote Hosts and add its public key to the host's ~/.ssh/authorized_keys.",
                succeeded: false)
        }
        let clampedTimeout = min(max(timeout, 5), 600)

        do {
            let client = try await SSHClient.connect(
                host: host.host,
                port: host.port,
                authenticationMethod: auth,
                // [T-ssh-tofu-followup] Accept-any host key is a KNOWN
                // limitation (personal LAN tool, password never echoed).
                // Trust-on-first-use pinning is the planned follow-up before
                // this is used across untrusted networks.
                hostKeyValidator: .acceptAnything(),
                reconnect: .never
            )
            defer { Task { try? await client.close() } }

            // [T-remote-exit-wrapper] Citadel throws on a non-zero exit and
            // keeps stderr on a separate stream — a failing command would lose
            // BOTH its output and its stderr. Force exit 0 and merge streams
            // in shell, carry the real status as a trailer we parse off.
            let wrapped = "{ \(command)\n} 2>&1; printf '\\n[leo-exit:%d]' \"$?\""
            let buffer = try await withThrowingTaskGroup(of: ByteBuffer.self) { group in
                group.addTask {
                    try await client.executeCommand(wrapped)
                }
                group.addTask {
                    try await Task.sleep(nanoseconds: UInt64(clampedTimeout * 1_000_000_000))
                    throw RemoteSSHError.timeout
                }
                guard let first = try await group.next() else { throw RemoteSSHError.timeout }
                group.cancelAll()
                return first
            }

            var text = String(buffer: buffer)
            var exitOK = true
            if let range = text.range(of: "[leo-exit:", options: .backwards),
               let close = text[range.upperBound...].firstIndex(of: "]") {
                let code = text[range.upperBound..<close]
                exitOK = (code == "0")
                text = String(text[..<range.lowerBound])
                    .trimmingCharacters(in: .newlines)
                if !exitOK { text += "\n[exit code \(code)]" }
            }
            if text.count > Self.maxOutputChars {
                text = String(text.prefix(Self.maxOutputChars)) + "\n… output truncated at \(Self.maxOutputChars) chars"
            }
            if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                text = "(command produced no output)"
            }
            return ExecResult(output: text, succeeded: exitOK)
        } catch RemoteSSHError.timeout {
            return ExecResult(
                output: "Remote command timed out after \(Int(clampedTimeout))s on '\(host.name)'. The connection is being torn down; the remote process may still be running.",
                succeeded: false)
        } catch {
            // [T-ssh-auth-fallback] A stale stored password must not permanently
            // shadow working key auth: retry once with the device key.
            if usedPassword, RemoteHostStore.devicePrivateKey() != nil, !isKeyRetry {
                logger.info("password auth failed for \(host.name) — retrying with device key")
                RemoteHostStore.deletePassword(hostId: host.id)
                return await run(host: host, command: command, timeout: timeout, isKeyRetry: true)
            }
            // Deliberately generic: no host password, no expanded command.
            logger.error("remote exec failed host=\(host.name): \(error.localizedDescription)")
            var message = "SSH to '\(host.name)' (\(host.username)@\(host.host):\(host.port)) failed: \(error.localizedDescription)"
            if host.host.hasPrefix("100.") {
                message += "\nThis looks like a Tailscale address — make sure the Tailscale app on THIS device is connected (it shows offline peers as unreachable)."
            }
            return ExecResult(output: message, succeeded: false)
        }
    }

    /// [T-remote-gateway] Cindy-style relay, automated: try the target
    /// directly; if its TCP is unreachable but ANOTHER configured host is
    /// reachable, run the command THERE wrapped in `ssh target`. One reachable
    /// machine (e.g. the Studio over LAN) makes every machine on its tailnet
    /// usable — no phone-side VPN required. Requires the gateway to hold ssh
    /// keys for the target (set up 2026-07-29 for the user's three machines).
    func runSmart(target: RemoteHost, allHosts: [RemoteHost], command: String, timeout: TimeInterval) async -> ExecResult {
        if await Self.tcpProbe(host: target.host, port: target.port, timeout: 4) {
            return await run(host: target, command: command, timeout: timeout)
        }
        var lastRelayFailure: String?
        for gateway in allHosts where gateway.id != target.id {
            guard await Self.tcpProbe(host: gateway.host, port: gateway.port, timeout: 4) else { continue }
            let relayed = "ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=8 -p \(target.port) "
                + "\(target.username)@\(target.host) \(RemoteShellQuoting.singleQuoted(command))"
            let result = await run(host: gateway, command: relayed, timeout: timeout)
            if result.succeeded {
                return ExecResult(
                    output: "[via \(gateway.name) — target not directly reachable from this device]\n" + result.output,
                    succeeded: true)
            }
            // This gateway can't reach the target (no key / route) — try the
            // next reachable one instead of giving up on the first.
            lastRelayFailure = "[via \(gateway.name)] " + result.output
        }
        if let lastRelayFailure {
            return ExecResult(output: lastRelayFailure, succeeded: false)
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
                message += " For LAN addresses iOS asks for Local Network permission on first use — if no prompt appeared, check Settings → Privacy & Security → Local Network → LeoPhoneAgent."
            }
            return ExecResult(output: message, succeeded: false)
        }
        let result = await run(host: host, command: "echo LEO_OK && uname -a", timeout: 15)
        return ExecResult(output: "TCP \(host.host):\(host.port) reachable ✓\n" + result.output,
                          succeeded: result.succeeded)
    }

    /// Plain TCP connect probe via Network.framework.
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
}

/// Shell-single-quote escaping shared by the remote tools.
enum RemoteShellQuoting {
    static func singleQuoted(_ s: String) -> String {
        "'" + s.replacingOccurrences(of: "'", with: "'\\''") + "'"
    }
}
