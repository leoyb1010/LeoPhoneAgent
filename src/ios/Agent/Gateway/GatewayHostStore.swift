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
    /// Full base URL of the agent ENGINE including scheme and port, e.g.
    /// `https://mac-mini-cortex.tail23de22.ts.net:8645`.
    ///
    /// Must be reached by HOSTNAME: the gateway is fronted by Tailscale's TLS
    /// terminator, which selects its certificate by SNI — connecting to the
    /// bare tailnet IP fails the handshake outright.
    var baseURL: String
    /// Where the LeoAgent HARNESS service lives, e.g. `…ts.net:8647`. A
    /// separate process on a separate port from the engine; one URL cannot
    /// serve both. Optional so hosts saved before this field decode cleanly —
    /// harness features then surface a named setup error instead of
    /// misrouting to the engine.
    var harnessURL: String? = nil
    var isEnabled: Bool = true
    /// Last successful contact, for the reachability dot.
    var lastSeenAt: Date?
    /// From relay `/machines` `info.platform` (android / leoagent).
    var platform: String? = nil
    /// From relay `/machines` `info.server` (minis / leocodebox).
    var server: String? = nil

    var isAndroidBody: Bool { platform == "android" || server == "minis" }

    var url: URL? { URL(string: baseURL) }
    var harnessBase: URL? {
        guard let harnessURL, !harnessURL.isEmpty else { return nil }
        return URL(string: harnessURL)
    }
}

@MainActor
final class GatewayHostStore: ObservableObject {
    static let shared = GatewayHostStore()
    static let storageKey = "leo.gatewayHosts.v1"
    /// nonisolated: the Keychain helpers below are callable from any
    /// context, so this constant must not inherit @MainActor isolation.
    nonisolated private static let keychainService = "com.leoyuan.leophoneagent.gateway"

    @Published private(set) var hosts: [GatewayHost]
    /// Built clients live here, not in a view body: `client(for:)` does a
    /// synchronous Keychain read and spins up a URLSession, and SwiftUI would
    /// re-run both on every redraw of the host list.
    private var clients: [String: LeoAgentClient] = [:]

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

    func upsertDiscovered(_ machines: [RelayDiscoveredMachine], key: String, apiRoot: String = RelayMachinesClient.defaultApiRoot) {
        var changed = false
        for machine in machines {
            guard let name = RelayMachinesClient.sanitizeMachine(machine.name) else { continue }
            let id = name.lowercased()
            let harness = RelayMachinesClient.harnessURL(for: name, apiRoot: apiRoot)
            // [T-relay-keychain-churn] 只在密钥真的变了时才写 Keychain。
            // 原来每台机器无条件写一次:下拉刷新一下就把每台主机的
            // Keychain 项重写一遍(SecItemUpdate/Add 是同步系统调用),
            // 机器多时下拉手感直接被拖住,而绝大多数刷新密钥根本没变。
            if Self.accessKey(hostId: id) != Self.normalizedAccessKey(key) {
                Self.saveAccessKey(key, hostId: id)
            }
            if let index = hosts.firstIndex(where: { $0.id == id }) {
                let before = hosts[index]
                if before.harnessURL != harness {
                    hosts[index].harnessURL = harness
                    clients.removeValue(forKey: id)
                    changed = true
                }
                if let platform = machine.platform, hosts[index].platform != platform {
                    hosts[index].platform = platform
                    changed = true
                }
                if let server = machine.server, hosts[index].server != server {
                    hosts[index].server = server
                    changed = true
                }
                // Keep isEnabled, display name, and engine URL — refresh must
                // not turn a disabled machine back on or wipe a rename.
            } else {
                hosts.append(GatewayHost(
                    id: id,
                    name: machine.isAndroidBody ? name : RelayMachinesClient.displayName(for: name),
                    baseURL: "",
                    harnessURL: harness,
                    platform: machine.platform,
                    server: machine.server
                ))
                changed = true
            }
        }
        if changed {
            persist()
            PushRegistrar.shared.reregisterIfPossible()
        }
    }

    func upsert(_ host: GatewayHost) {
        if let index = hosts.firstIndex(where: { $0.id == host.id }) {
            hosts[index] = host
        } else {
            hosts.append(host)
        }
        clients.removeValue(forKey: host.id)   // address or key may have changed
        persist()
        PushRegistrar.shared.reregisterIfPossible()
    }

    func delete(id: String) {
        hosts.removeAll { $0.id == id }
        clients.removeValue(forKey: id)
        Self.deleteKey(hostId: id)
        persist()
    }

    func hostMatching(hostId: String = "", machine: String) -> GatewayHost? {
        guard let index = RelayMachinesClient.pickHostIndex(
            hostIds: hosts.map(\.id),
            displayNames: hosts.map(\.name),
            hostId: hostId,
            machine: machine
        ) else { return nil }
        return hosts[index]
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
    func client(for host: GatewayHost) -> LeoAgentClient? {
        if let cached = clients[host.id] { return cached }
        guard let key = Self.accessKey(hostId: host.id), !key.isEmpty else { return nil }
        // Second line of defence behind the editor's validation: hand-edited
        // UserDefaults or an older record must not get a cleartext client.
        // https-only on both addresses; a cleartext one is dropped here rather
        // than allowed to carry the key.
        var engine = host.url
        if engine?.scheme?.lowercased() != "https" || engine?.host == nil { engine = nil }
        var harnessBase = host.harnessBase
        if harnessBase?.scheme?.lowercased() != "https" || harnessBase?.host == nil { harnessBase = nil }
        // 只控编码 CLI 的主机可以不配引擎地址;engine 调用会打到 harness 服务
        // 并返回明确错误,而不是让整台主机在 UI 里消失。
        guard let base = engine ?? harnessBase else { return nil }
        let built = LeoAgentClient(baseURL: base, apiKey: key, harnessBaseURL: harnessBase,
                                   hostId: host.id, hostName: host.name)
        clients[host.id] = built
        return built
    }

    /// One shared entry point for Treasury sync/read-through. Providers and
    /// views must not each invent their own relay selection or key handling.
    func treasuryRelayClient() -> LeoAgentClient? {
        activeHosts
            .compactMap { client(for: $0) }
            .first { $0.relayEventsURL != nil }
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

    /// 清洗复制残渣:终端复制常带上 zsh 行尾标记 % 或换行,密钥本身
    /// 不含这些字符。中继侧同样容错,这里洗干净是双保险。
    /// 抽成函数是为了让「要不要写 Keychain」的比较用的是同一套规范化,
    /// 否则每次刷新都会因为 raw 与已存值差一个空白字符而重复落盘。
    nonisolated static func normalizedAccessKey(_ rawKey: String) -> String {
        rawKey.trimmingCharacters(in: .whitespacesAndNewlines)
            .trimmingCharacters(in: CharacterSet(charactersIn: "%"))
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    @discardableResult
    nonisolated static func saveAccessKey(_ rawKey: String, hostId: String) -> Bool {
        let key = normalizedAccessKey(rawKey)
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
        // 引擎地址可留空(只控编码 CLI 的主机):/health 两个服务都有,
        // 用哪个可用的地址探测都成立。
        let engineValid = host.url.flatMap { $0.host != nil ? $0 : nil }
        guard let base = engineValid ?? host.harnessBase else { return false }
        // relay 地址自带路径前缀,绝对路径 resolve 会把它吞掉——拼接。
        var parts = URLComponents(url: base, resolvingAgainstBaseURL: false)
        let basePath = base.path.hasSuffix("/") ? String(base.path.dropLast()) : base.path
        parts?.path = basePath + "/health"
        guard let url = parts?.url else { return false }
        var req = URLRequest(url: url)
        req.timeoutInterval = 8
        guard let (data, response) = try? await URLSession.shared.data(for: req),
              let http = response as? HTTPURLResponse else { return false }
        // 401/403 = 服务在、只是这条路径要钥匙(relay 的机器路径就是这样)。
        // 可达性问的是"那头有没有人",不是"钥匙对不对"。
        if http.statusCode == 401 || http.statusCode == 403 { return true }
        guard http.statusCode == 200,
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return false }
        return (obj["status"] as? String) == "ok"
    }
}
