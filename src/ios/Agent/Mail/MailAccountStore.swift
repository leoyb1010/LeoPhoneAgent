//
//  MailAccountStore.swift
//  MinisApp
//
//  [T-mail] 用户授权给 Agent 读的邮箱账户。账户信息(地址、服务器)存 Application Support
//  下的 JSON;密码 / 授权码只进本机钥匙串,不走 iCloud 同步、不进任何日志。
//  常见邮箱按预设填好 IMAP 服务器,用户只填地址和授权码;其他邮箱手填服务器。
//

import Foundation
import Security

struct MailProviderPreset: Identifiable, Equatable {
    let id: String
    let name: String
    let host: String
    let port: UInt16
    /// 密码框的名字:授权码 / 应用专用密码 / 密码。
    let passwordLabel: String
    /// 怎么拿到这个密码,一句话。
    let help: String
    let helpURL: URL?
    /// 用户名是否就是完整邮箱地址(iCloud 是 Apple ID 邮箱,也算)。
    let usernameIsEmail: Bool

    static let gmail = MailProviderPreset(
        id: "gmail", name: "Gmail", host: "imap.gmail.com", port: 993,
        passwordLabel: "应用专用密码",
        help: "Google 账号需要先开两步验证,再在「安全性 → 应用专用密码」生成一个 16 位密码填在这里。",
        helpURL: URL(string: "https://myaccount.google.com/apppasswords"), usernameIsEmail: true)
    static let qq = MailProviderPreset(
        id: "qq", name: "QQ 邮箱", host: "imap.qq.com", port: 993,
        passwordLabel: "IMAP 授权码",
        help: "QQ 邮箱网页版 → 设置 → 账号 → 开启 IMAP/SMTP 服务,生成授权码填在这里(不是 QQ 密码)。",
        helpURL: URL(string: "https://mail.qq.com"), usernameIsEmail: true)
    static let netease163 = MailProviderPreset(
        id: "163", name: "163 邮箱", host: "imap.163.com", port: 993,
        passwordLabel: "IMAP 授权码",
        help: "163 邮箱网页版 → 设置 → POP3/SMTP/IMAP → 开启 IMAP 服务并新增授权密码,填在这里。",
        helpURL: URL(string: "https://mail.163.com"), usernameIsEmail: true)
    static let netease126 = MailProviderPreset(
        id: "126", name: "126 邮箱", host: "imap.126.com", port: 993,
        passwordLabel: "IMAP 授权码",
        help: "126 邮箱网页版 → 设置 → POP3/SMTP/IMAP → 开启 IMAP 服务并新增授权密码,填在这里。",
        helpURL: URL(string: "https://mail.126.com"), usernameIsEmail: true)
    static let icloud = MailProviderPreset(
        id: "icloud", name: "iCloud 邮箱", host: "imap.mail.me.com", port: 993,
        passwordLabel: "App 专用密码",
        help: "在 appleid.apple.com → 登录与安全 → App 专用密码 生成一个,填在这里。",
        helpURL: URL(string: "https://appleid.apple.com/account/manage"), usernameIsEmail: true)
    static let outlook = MailProviderPreset(
        id: "outlook", name: "Outlook / Hotmail", host: "outlook.office365.com", port: 993,
        passwordLabel: "密码",
        help: "微软个人账户多数已关闭密码登录 IMAP,可能连不上;企业邮箱请向管理员确认是否允许 IMAP。",
        helpURL: nil, usernameIsEmail: true)
    static let custom = MailProviderPreset(
        id: "custom", name: "其他 IMAP 邮箱", host: "", port: 993,
        passwordLabel: "密码 / 授权码",
        help: "填服务商给的 IMAP 服务器地址(一般是 imap.xxx.com,端口 993,SSL)。",
        helpURL: nil, usernameIsEmail: true)

    static let all: [MailProviderPreset] = [gmail, qq, netease163, netease126, icloud, outlook, custom]

    static func preset(id: String) -> MailProviderPreset {
        all.first { $0.id == id } ?? custom
    }

    /// 按邮箱域名猜预设。
    static func guess(forEmail email: String) -> MailProviderPreset? {
        guard let at = email.lastIndex(of: "@") else { return nil }
        let domain = email[email.index(after: at)...].lowercased()
        switch domain {
        case "gmail.com", "googlemail.com": return gmail
        case "qq.com", "foxmail.com", "vip.qq.com": return qq
        case "163.com", "vip.163.com", "yeah.net": return netease163
        case "126.com", "vip.126.com": return netease126
        case "icloud.com", "me.com", "mac.com": return icloud
        case "outlook.com", "hotmail.com", "live.com", "msn.com": return outlook
        default: return nil
        }
    }
}

struct MailAccount: Codable, Identifiable, Equatable {
    var id: String = UUID().uuidString
    var presetId: String
    var label: String
    var email: String
    var username: String
    var host: String
    var port: UInt16
    var isEnabled: Bool = true
    var createdAt: Date = Date()
    var lastVerifiedAt: Date?
    /// 上次测试 / 读取失败的原因,给设置页看;成功后清空。
    var lastError: String?

    var preset: MailProviderPreset { MailProviderPreset.preset(id: presetId) }
    var displayName: String { label.isEmpty ? email : label }
}

@MainActor
final class MailAccountStore: ObservableObject {
    static let shared = MailAccountStore()

    @Published private(set) var accounts: [MailAccount] = []

    private let fileURL: URL

    private init() {
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        try? FileManager.default.createDirectory(at: support, withIntermediateDirectories: true)
        fileURL = support.appendingPathComponent("mail-accounts.json")
        load()
    }

    var enabledAccounts: [MailAccount] { accounts.filter(\.isEnabled) }
    var hasEnabledAccounts: Bool { !enabledAccounts.isEmpty }

    /// 按 id、邮箱地址或名字找(大小写不敏感;也接受地址的前缀,比如 "leo@" 或用户名)。
    func account(matching query: String) -> MailAccount? {
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !q.isEmpty else { return nil }
        let enabled = enabledAccounts
        return enabled.first { $0.id.lowercased() == q }
            ?? enabled.first { $0.email.lowercased() == q }
            ?? enabled.first { $0.label.lowercased() == q }
            ?? enabled.first { $0.email.lowercased().hasPrefix(q) || $0.label.lowercased().contains(q) || $0.preset.name.lowercased().contains(q) }
    }

    func add(_ account: MailAccount) {
        accounts.removeAll { $0.id == account.id }
        accounts.append(account)
        save()
    }

    func update(_ account: MailAccount) {
        guard let idx = accounts.firstIndex(where: { $0.id == account.id }) else { return add(account) }
        accounts[idx] = account
        save()
    }

    func remove(_ account: MailAccount) {
        accounts.removeAll { $0.id == account.id }
        deletePassword(accountId: account.id)
        save()
    }

    func setEnabled(_ enabled: Bool, for account: MailAccount) {
        guard let idx = accounts.firstIndex(where: { $0.id == account.id }) else { return }
        accounts[idx].isEnabled = enabled
        save()
    }

    /// 读取失败时记一笔,设置页能看到;成功时清掉。不会记密码或邮件内容。
    func recordResult(accountId: String, error: String?) {
        guard let idx = accounts.firstIndex(where: { $0.id == accountId }) else { return }
        accounts[idx].lastError = error
        if error == nil { accounts[idx].lastVerifiedAt = Date() }
        save()
    }

    // MARK: - Persistence

    private func load() {
        guard let data = try? Data(contentsOf: fileURL) else { return }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        accounts = (try? decoder.decode([MailAccount].self, from: data)) ?? []
    }

    private func save() {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        guard let data = try? encoder.encode(accounts) else { return }
        try? data.write(to: fileURL, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }

    // MARK: - Keychain (本机,不同步)

    nonisolated func setPassword(_ password: String, accountId: String) { MailKeychain.set(password, accountId: accountId) }
    nonisolated func password(accountId: String) -> String? { MailKeychain.password(accountId: accountId) }
    nonisolated func deletePassword(accountId: String) { MailKeychain.delete(accountId: accountId) }
}

/// 授权码的钥匙串读写:本机项,不进 iCloud 钥匙串同步。放在 actor 外面,工具执行(非主线程)也能取。
enum MailKeychain {
    private static let service = "com.leoyuan.leophoneagent.mail"

    static func set(_ password: String, accountId: String) {
        delete(accountId: accountId)
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: accountId,
            kSecAttrSynchronizable as String: false,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlock,
            kSecValueData as String: Data(password.utf8),
        ]
        SecItemAdd(query as CFDictionary, nil)
    }

    static func password(accountId: String) -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: accountId,
            kSecAttrSynchronizable as String: kSecAttrSynchronizableAny,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var result: AnyObject?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess, let data = result as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    static func delete(accountId: String) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: accountId,
            kSecAttrSynchronizable as String: kSecAttrSynchronizableAny,
        ]
        SecItemDelete(query as CFDictionary)
    }
}
