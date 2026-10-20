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

import Citadel
import CryptoKit
import Foundation
import Security

struct RemoteHost: Codable, Identifiable, Hashable {
    var id: String = UUID().uuidString.lowercased()
    var name: String
    var host: String
    var port: Int = 22
    var username: String
    /// Explicit user association; never inferred from an IP address or display name.
    var deviceId: String? = nil
    /// 用户从目标主机可信控制台取得的 OpenSSH 公钥；旧配置默认未受信。
    var trustedHostKey: String? = nil
    var trustedHostKeyEndpoint: String? = nil
    /// 端口转发规则（本地端口 ← 远程 host:port）。旧配置没有这个字段，解码为 nil。
    var portForwards: [SSHPortForwardRule]? = nil
}

struct SSHPortForwardRule: Codable, Identifiable, Hashable {
    var id: String = UUID().uuidString.lowercased()
    var localPort: Int
    var remoteHost: String = "127.0.0.1"
    var remotePort: Int
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
            Self.setPasswordRejected(false, hostId: host.id)
        }
        persist()
    }

    func delete(id: String) {
        hosts.removeAll { $0.id == id }
        Self.deletePassword(hostId: id)
        persist()
    }

    func setPortForwards(_ rules: [SSHPortForwardRule], hostId: String) {
        guard let index = hosts.firstIndex(where: { $0.id == hostId }) else { return }
        hosts[index].portForwards = rules.isEmpty ? nil : rules
        persist()
    }

    /// 「重新读取指纹」确认后只换公钥，其它配置不动。
    func updateTrustedHostKey(_ key: String, hostId: String) {
        guard let index = hosts.firstIndex(where: { $0.id == hostId }),
              let normalized = RemoteSSHTrust.normalizedPublicKey(key) else { return }
        hosts[index].trustedHostKey = normalized
        hosts[index].trustedHostKeyEndpoint = RemoteSSHTrust.endpoint(host: hosts[index].host, port: hosts[index].port)
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
        setPasswordRejected(false, hostId: hostId)
    }

    // MARK: - 被服务器拒绝的已存密码

    /// 密码被拒只做标记、不删：可能只是服务器临时改了策略，用户也能在设置里看到并重填。
    /// 有钥匙时被标记的密码不再先试（省一次必然失败的认证）；没有钥匙仍照常试。
    nonisolated private static let rejectedKey = "leo.remoteHosts.passwordRejected.v1"

    nonisolated static func isPasswordRejected(hostId: String) -> Bool {
        (UserDefaults.standard.stringArray(forKey: rejectedKey) ?? []).contains(hostId)
    }

    nonisolated static func setPasswordRejected(_ rejected: Bool, hostId: String) {
        var ids = Set(UserDefaults.standard.stringArray(forKey: rejectedKey) ?? [])
        guard ids.contains(hostId) != rejected else { return }
        if rejected { ids.insert(hostId) } else { ids.remove(hostId) }
        UserDefaults.standard.set(Array(ids).sorted(), forKey: rejectedKey)
    }

    // MARK: - 终端偏好

    nonisolated static let autoTmuxKey = "leo.sshTerminal.autoTmux"
    nonisolated static let terminalFontSizeKey = "leo.sshTerminal.fontSize"

    /// 默认开：连上后自动 attach 到 tmux 会话 leobot，断线重连回到原来的窗口。
    nonisolated static var autoTmux: Bool {
        UserDefaults.standard.object(forKey: autoTmuxKey) as? Bool ?? true
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

// MARK: - 导入的私钥

/// 用户粘贴导入的 OpenSSH 私钥（ed25519 / rsa）。私钥原文和口令只进本机 Keychain；
/// 列表元数据（名字、类型、公钥）放 UserDefaults。默认钥匙 = nil 时用设备钥匙，老配置不受影响。
struct SSHIdentity: Codable, Identifiable, Hashable {
    var id: String = UUID().uuidString.lowercased()
    var name: String
    var kind: SSHPrivateKeyInfo.Kind
    var publicKeyLine: String
}

enum SSHIdentityImportError: LocalizedError, Equatable {
    case notOpenSSH, unsupported(String), needsPassphrase, wrongPassphrase

    var errorDescription: String? {
        switch self {
        case .notOpenSSH: return AppLocalized("不是 OpenSSH 私钥：需要以 -----BEGIN OPENSSH PRIVATE KEY----- 开头的整段文本。")
        case .unsupported(let type): return AppLocalized("暂不支持 \(type) 类型的钥匙，请用 ed25519 或 rsa。")
        case .needsPassphrase: return AppLocalized("这把钥匙设了口令，请输入口令。")
        case .wrongPassphrase: return AppLocalized("口令不对，或钥匙内容不完整。")
        }
    }
}

extension RemoteHostStore {
    nonisolated private static let identitiesKey = "leo.sshIdentities.v1"
    nonisolated private static let defaultIdentityKey = "leo.sshIdentities.default"

    nonisolated static func identities() -> [SSHIdentity] {
        guard let data = UserDefaults.standard.data(forKey: identitiesKey),
              let list = try? JSONDecoder().decode([SSHIdentity].self, from: data) else { return [] }
        return list
    }

    /// nil = 设备钥匙。
    nonisolated static var defaultIdentityId: String? {
        get {
            let id = UserDefaults.standard.string(forKey: defaultIdentityKey)
            return identities().contains { $0.id == id } ? id : nil
        }
        set { UserDefaults.standard.set(newValue, forKey: defaultIdentityKey) }
    }

    /// 解析并试解一次（口令错在这里就报，不等到连接时）；成功才存。
    @discardableResult
    nonisolated static func importIdentity(name: String, pem: String, passphrase: String) throws -> SSHIdentity {
        let info: SSHPrivateKeyInfo.Parsed
        do { info = try SSHPrivateKeyInfo.parse(pem) } catch SSHPrivateKeyInfo.ParseError.unsupported(let type) {
            throw SSHIdentityImportError.unsupported(type)
        } catch { throw SSHIdentityImportError.notOpenSSH }
        if info.encrypted && passphrase.isEmpty { throw SSHIdentityImportError.needsPassphrase }
        let trimmed = pem.trimmingCharacters(in: .whitespacesAndNewlines)
        guard authentication(kind: info.kind, pem: trimmed, passphrase: info.encrypted ? passphrase : nil, username: "probe") != nil else {
            throw SSHIdentityImportError.wrongPassphrase
        }
        let identity = SSHIdentity(name: name.isEmpty ? info.kind.rawValue : name, kind: info.kind,
                                   publicKeyLine: info.publicKeyLine)
        setPassword(trimmed, hostId: "identity-" + identity.id)
        if info.encrypted { setPassword(passphrase, hostId: "identity-pass-" + identity.id) }
        var list = identities()
        list.append(identity)
        if let data = try? JSONEncoder().encode(list) { UserDefaults.standard.set(data, forKey: identitiesKey) }
        return identity
    }

    nonisolated static func deleteIdentity(id: String) {
        let list = identities().filter { $0.id != id }
        if let data = try? JSONEncoder().encode(list) { UserDefaults.standard.set(data, forKey: identitiesKey) }
        deletePassword(hostId: "identity-" + id)
        deletePassword(hostId: "identity-pass-" + id)
        if UserDefaults.standard.string(forKey: defaultIdentityKey) == id {
            UserDefaults.standard.removeObject(forKey: defaultIdentityKey)
        }
    }

    /// 钥匙认证：默认钥匙（导入的）→ 设备钥匙。都没有返回 nil。
    nonisolated static func keyAuthentication(username: String) -> SSHAuthenticationMethod? {
        if let id = defaultIdentityId, let identity = identities().first(where: { $0.id == id }),
           let pem = password(hostId: "identity-" + id),
           let method = authentication(kind: identity.kind, pem: pem,
                                       passphrase: password(hostId: "identity-pass-" + id), username: username) {
            return method
        }
        return devicePrivateKey().map { .ed25519(username: username, privateKey: $0) }
    }

    nonisolated static var hasAnyKey: Bool {
        devicePrivateKey() != nil || defaultIdentityId != nil
    }

    nonisolated private static func authentication(kind: SSHPrivateKeyInfo.Kind, pem: String, passphrase: String?,
                                                   username: String) -> SSHAuthenticationMethod? {
        let decryption = passphrase.flatMap { $0.isEmpty ? nil : Data($0.utf8) }
        switch kind {
        case .ed25519:
            return (try? Curve25519.Signing.PrivateKey(sshEd25519: pem, decryptionKey: decryption))
                .map { .ed25519(username: username, privateKey: $0) }
        case .rsa:
            return (try? Insecure.RSA.PrivateKey(sshRsa: pem, decryptionKey: decryption))
                .map { .rsa(username: username, privateKey: $0) }
        }
    }
}
