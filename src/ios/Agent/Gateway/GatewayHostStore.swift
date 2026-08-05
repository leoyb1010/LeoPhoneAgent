//
//  GatewayHostStore.swift
//  MinisApp
//
//  [T-leogateway] Where a gateway host lives on this device.
//
//  Mirrors RemoteHostStore's split deliberately: non-secret metadata in
//  UserDefaults so the Fleet UI can list hosts without a Keychain round-trip,
//  and the access key in the LOCAL Keychain only —
//  kSecAttrAccessibleAfterFirstUnlock and NOT synchronizable, so a gateway
//  key never rides iCloud to another device.
//

import Foundation
import Security

struct GatewayHost: Codable, Identifiable, Hashable {
    var id: String = UUID().uuidString.lowercased()
    /// Display name, e.g. "cortex".
    var name: String
    /// Full base URL including scheme and port, e.g.
    /// `https://mac-mini-cortex.tail23de22.ts.net:8645`.
    ///
    /// Must be reached by HOSTNAME: the gateway is fronted by Tailscale's TLS
    /// terminator, which selects its certificate by SNI — connecting to the
    /// bare tailnet IP fails the handshake outright.
    var baseURL: String
    var isEnabled: Bool = true
    /// Last successful contact, for the reachability dot.
    var lastSeenAt: Date?

    var url: URL? { URL(string: baseURL) }
}

@MainActor
final class GatewayHostStore: ObservableObject {
    static let shared = GatewayHostStore()
    static let storageKey = "leo.gatewayHosts.v1"
    /// nonisolated: the Keychain helpers below are callable from any
    /// context, so this constant must not inherit @MainActor isolation.
    nonisolated private static let keychainService = "com.leoyuan.leophoneagent.gateway"

    @Published private(set) var hosts: [GatewayHost]

    init() {
        if let data = UserDefaults.standard.data(forKey: Self.storageKey),
           let decoded = try? JSONDecoder().decode([GatewayHost].self, from: data) {
            hosts = decoded
        } else {
            hosts = []
        }
    }

    /// True when the feature should appear at all. Everything gateway-related
    /// stays invisible until the user adds a host — the same additive
    /// guarantee the remote-shell tools follow.
    var isConfigured: Bool { hosts.contains { $0.isEnabled } }

    var activeHosts: [GatewayHost] { hosts.filter(\.isEnabled) }

    func upsert(_ host: GatewayHost) {
        if let index = hosts.firstIndex(where: { $0.id == host.id }) {
            hosts[index] = host
        } else {
            hosts.append(host)
        }
        persist()
    }

    func delete(id: String) {
        hosts.removeAll { $0.id == id }
        Self.deleteKey(hostId: id)
        persist()
    }

    func markSeen(id: String) {
        guard let index = hosts.firstIndex(where: { $0.id == id }) else { return }
        hosts[index].lastSeenAt = Date()
        persist()
    }

    private func persist() {
        guard let data = try? JSONEncoder().encode(hosts) else { return }
        UserDefaults.standard.set(data, forKey: Self.storageKey)
    }

    /// Build a client for a host, or nil when its key is missing.
    func client(for host: GatewayHost) -> HermesGatewayClient? {
        guard let url = host.url, let key = Self.accessKey(hostId: host.id), !key.isEmpty else { return nil }
        return HermesGatewayClient(baseURL: url, apiKey: key)
    }

    // MARK: - Keychain (local only, never synchronized)

    nonisolated static func accessKey(hostId: String) -> String? {
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

    @discardableResult
    nonisolated static func saveAccessKey(_ key: String, hostId: String) -> Bool {
        let base: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecAttrAccount as String: hostId,
        ]
        var add = base
        add[kSecValueData as String] = Data(key.utf8)
        // AfterFirstUnlock so a background refresh after a reboot still works;
        // no kSecAttrSynchronizable, so this never leaves the device.
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock

        var status = SecItemAdd(add as CFDictionary, nil)
        if status == errSecDuplicateItem {
            status = SecItemUpdate(base as CFDictionary,
                                   [kSecValueData as String: Data(key.utf8)] as CFDictionary)
        }
        return status == errSecSuccess
    }

    nonisolated static func deleteKey(hostId: String) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecAttrAccount as String: hostId,
        ]
        SecItemDelete(query as CFDictionary)
    }

    // MARK: - Reachability

    /// Probe a host without touching its key: /health is unauthenticated, so a
    /// failure here means "unreachable", not "wrong key" — the two need
    /// different fixes and the UI should not conflate them.
    nonisolated static func probe(_ host: GatewayHost) async -> Bool {
        guard let base = host.url, let url = URL(string: "/health", relativeTo: base) else { return false }
        var req = URLRequest(url: url)
        req.timeoutInterval = 8
        guard let (data, response) = try? await URLSession.shared.data(for: req),
              let http = response as? HTTPURLResponse, http.statusCode == 200,
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return false }
        return (obj["status"] as? String) == "ok"
    }
}
