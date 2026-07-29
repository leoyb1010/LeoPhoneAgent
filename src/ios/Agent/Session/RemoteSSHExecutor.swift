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
    func run(host: RemoteHost, command: String, timeout: TimeInterval) async -> ExecResult {
        // [T-ssh-key-auth] Password when stored, else the device Ed25519 key —
        // key-only hosts (the recommended setup) no longer require a password.
        let auth: SSHAuthenticationMethod
        if let password = RemoteHostStore.password(hostId: host.id), !password.isEmpty {
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
            // Deliberately generic: no host password, no expanded command.
            logger.error("remote exec failed host=\(host.name): \(error.localizedDescription)")
            var message = "SSH to '\(host.name)' (\(host.username)@\(host.host):\(host.port)) failed: \(error.localizedDescription)"
            if host.host.hasPrefix("100.") {
                message += "\nThis looks like a Tailscale address — make sure the Tailscale app on THIS device is connected (it shows offline peers as unreachable)."
            }
            return ExecResult(output: message, succeeded: false)
        }
    }

    /// Settings-page connectivity test.
    func test(host: RemoteHost) async -> ExecResult {
        await run(host: host, command: "echo LEO_OK && uname -a", timeout: 15)
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
