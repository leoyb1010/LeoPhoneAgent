//
//  RemoteHostStore.swift
//  MinisApp
//
//  [T-remote-exec] Configured SSH hosts for remote execution (absorbed from
//  Cindy's maker-remote-ssh: heavy work runs on a real computer, the phone
//  stays the control surface).
//
//  Host metadata lives in UserDefaults; the PASSWORD lives only in the local
//  Keychain (kSecAttrAccessibleAfterFirstUnlock, non-synchronizable) — the
//  same rule the MCP OAuth secrets follow: credentials never ride iCloud and
//  never appear in logs or error text.
//
//  Additive guarantee: zero hosts configured → the remote tools are not even
//  registered, so prompts, cache prefixes and behaviour are unchanged.
//

import CryptoKit
import Foundation
import Security

struct RemoteHost: Codable, Identifiable, Hashable {
    var id: String = UUID().uuidString.lowercased()
    var name: String
    var host: String
    var port: Int = 22
    var username: String
}

@MainActor
final class RemoteHostStore: ObservableObject {
    static let shared = RemoteHostStore()
    static let storageKey = "leo.remoteHosts.v1"
    nonisolated private static let keychainService = "com.leoyuan.leophoneagent.remotehost"

    @Published private(set) var hosts: [RemoteHost]

    init() {
        if let data = UserDefaults.standard.data(forKey: Self.storageKey),
           let decoded = try? JSONDecoder().decode([RemoteHost].self, from: data) {
            hosts = decoded
        } else {
            hosts = []
        }
    }

    /// nonisolated so ToolDefinitions (built off-main during prompt assembly)
    /// can check availability without a hop.
    nonisolated static func configuredHosts() -> [RemoteHost] {
        guard let data = UserDefaults.standard.data(forKey: storageKey),
              let decoded = try? JSONDecoder().decode([RemoteHost].self, from: data) else { return [] }
        return decoded
    }

    func upsert(_ host: RemoteHost, password: String?) {
        if let index = hosts.firstIndex(where: { $0.id == host.id }) {
            hosts[index] = host
        } else {
            hosts.append(host)
        }
        if let password, !password.isEmpty {
            Self.setPassword(password, hostId: host.id)
        }
        persist()
    }

    func delete(id: String) {
        hosts.removeAll { $0.id == id }
        Self.deletePassword(hostId: id)
        persist()
    }

    private func persist() {
        guard let data = try? JSONEncoder().encode(hosts) else { return }
        UserDefaults.standard.set(data, forKey: Self.storageKey)
    }

    // MARK: - Keychain (local only)

    nonisolated static func password(hostId: String) -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecAttrAccount as String: hostId,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var result: AnyObject?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    nonisolated static func setPassword(_ password: String, hostId: String) {
        let match: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecAttrAccount as String: hostId,
        ]
        let attrs: [String: Any] = [
            kSecValueData as String: Data(password.utf8),
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlock,
        ]
        var status = SecItemUpdate(match as CFDictionary, attrs as CFDictionary)
        if status == errSecItemNotFound {
            var add = match
            add.merge(attrs) { _, new in new }
            status = SecItemAdd(add as CFDictionary, nil)
        }
    }

    nonisolated static func deletePassword(hostId: String) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecAttrAccount as String: hostId,
        ]
        SecItemDelete(query as CFDictionary)
    }
}

// MARK: - Device SSH key (Ed25519)

/// [T-ssh-key-auth] One Ed25519 identity per device, generated on demand and
/// held only in the local Keychain. The public key is what the user appends
/// to a host's ~/.ssh/authorized_keys — this is the path for machines that
/// (correctly) have password auth disabled.
extension RemoteHostStore {
    nonisolated static let deviceKeyAccount = "device-ssh-ed25519"

    nonisolated static func devicePrivateKey() -> Curve25519.Signing.PrivateKey? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecAttrAccount as String: deviceKeyAccount,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var result: AnyObject?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data else { return nil }
        return try? Curve25519.Signing.PrivateKey(rawRepresentation: data)
    }

    @discardableResult
    nonisolated static func ensureDeviceKey() -> Curve25519.Signing.PrivateKey {
        if let existing = devicePrivateKey() { return existing }
        let key = Curve25519.Signing.PrivateKey()
        let match: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecAttrAccount as String: deviceKeyAccount,
        ]
        let attrs: [String: Any] = [
            kSecValueData as String: key.rawRepresentation,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlock,
        ]
        var add = match
        add.merge(attrs) { _, new in new }
        var status = SecItemAdd(add as CFDictionary, nil)
        if status == errSecDuplicateItem {
            status = SecItemUpdate(match as CFDictionary, attrs as CFDictionary)
        }
        if status != errSecSuccess {
            // Surface instead of silently minting a new identity every call.
            AppLogger(category: "RemoteHost").error("device key store failed: \(status)")
        }
        return key
    }

    /// "ssh-ed25519 AAAA… leophoneagent" — the standard authorized_keys line.
    nonisolated static func devicePublicKeyLine() -> String? {
        guard let key = devicePrivateKey() else { return nil }
        let raw = key.publicKey.rawRepresentation
        var blob = Data()
        func sshString(_ d: Data) {
            var len = UInt32(d.count).bigEndian
            blob.append(Data(bytes: &len, count: 4)); blob.append(d)
        }
        sshString(Data("ssh-ed25519".utf8))
        sshString(raw)
        return "ssh-ed25519 \(blob.base64EncodedString()) leophoneagent"
    }
}
