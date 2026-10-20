//
//  ShareMacTarget.swift
//  MinisApp / MinisShare
//
//  [WP-44] 分享扩展「发给 Mac 当前任务」:系统分享面板里把一段文字 / 网址直接塞进你在
//  手机上最近打开的那个 Mac 任务,不用先跳回 App。(交互参考 OpenClaw ShareExtension 的直发模式。)
//
//  - App 打开某个 Mac 任务的控制台时,把「发到哪」写进 App Group(`ShareMacTarget`,不含密钥),
//    密钥放进以 App Group 为访问组的钥匙串(主 App 与分享扩展都能读,别的 App 读不到)。
//  - 扩展按 `requests(…)` 给出的顺序发:直连优先(Mac 发的短期直连凭证还有效时,8 s),
//    不行再走中继(带 X-Leo-Queue:Mac 不在线就排队,上线按序投递)。两条路用同一个
//    X-Leo-Request-Id,Mac 按它去重,直连超时后再走中继也不会投递两次。总预算 25 s。
//

import Foundation
import os
import Security

private let shareTargetLog = Logger(subsystem: "com.leoyuan.leophoneagent", category: "ShareMacTarget")

struct ShareMacTarget: Codable, Equatable {
    var sessionId: String
    var title: String
    var hostName: String
    /// Leo Link 的 harness 根地址(中继或直连配置的那个),和 App 里 `LeoAgentClient.harnessBaseURL` 一致。
    var relayBase: String
    /// Mac 下发的直连端点(Tailscale 等),凭证过期就不用。
    var directBase: String?
    var directDeviceId: String?
    var directExpiresAt: TimeInterval?
    var updatedAt: Date
    /// [e2e] Mac 的中继加密公钥(公钥,不是秘密);有它时中继那条先发加密信封,Mac 不认再发明文。
    var relayE2EKey: String? = nil

    static let appGroup = "group.com.leoyuan.leophoneagent"
    static let defaultsKey = "leo.share.macTarget.v1"
    /// 太久没在手机上看过的任务不再出现在分享面板里。
    static let maxAge: TimeInterval = 12 * 3600
    static let totalBudget: TimeInterval = 25
    static let directTimeout: TimeInterval = 8

    func isFresh(now: Date = Date()) -> Bool {
        now.timeIntervalSince(updatedAt) < Self.maxAge && !sessionId.isEmpty
    }

    func directUsable(now: Date = Date()) -> Bool {
        guard let directBase, !directBase.isEmpty, directDeviceId?.isEmpty == false,
              let expires = directExpiresAt else { return false }
        return expires > now.timeIntervalSince1970 + 30
    }

    // MARK: Storage (App Group defaults + App Group keychain)

    static func load(from defaults: UserDefaults? = UserDefaults(suiteName: ShareMacTarget.appGroup)) -> ShareMacTarget? {
        guard let data = defaults?.data(forKey: defaultsKey) else { return nil }
        return try? JSONDecoder().decode(ShareMacTarget.self, from: data)
    }

    func save(to defaults: UserDefaults? = UserDefaults(suiteName: ShareMacTarget.appGroup)) {
        guard let data = try? JSONEncoder().encode(self) else { return }
        defaults?.set(data, forKey: Self.defaultsKey)
    }

    /// 解绑 / 删除 Mac 时调:清掉「发到哪」和 App Group 钥匙串里的中继主钥匙、直连凭证,
    /// 分享扩展就不会再拿旧钥匙往已经不要的 Mac 发。
    static func clear(defaults: UserDefaults? = UserDefaults(suiteName: ShareMacTarget.appGroup)) {
        defaults?.removeObject(forKey: defaultsKey)
        ShareMacTargetSecrets.clear()
    }

    // MARK: Requests

    struct Secrets: Equatable {
        var relayKey: String
        var directToken: String?
    }

    /// 按尝试顺序给出要发的请求(直连在前)。凭证缺了哪条就少哪条。
    func requests(text: String, secrets: Secrets, requestId: String = UUID().uuidString.lowercased(),
                  now: Date = Date()) -> [URLRequest] {
        let path = "/harness/sessions/\(sessionId)/send"
        let body = try? JSONSerialization.data(withJSONObject: ["text": text])
        var out: [URLRequest] = []
        func make(base: String, token: String, timeout: TimeInterval, extra: [String: String]) -> URLRequest? {
            let trimmed = base.hasSuffix("/") ? String(base.dropLast()) : base
            guard !token.isEmpty, let url = URL(string: trimmed + path) else { return nil }
            var req = URLRequest(url: url)
            req.httpMethod = "POST"
            req.timeoutInterval = timeout
            req.httpBody = body
            req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.setValue(requestId, forHTTPHeaderField: "X-Leo-Request-Id")
            req.setValue(requestId, forHTTPHeaderField: "X-Request-ID")
            for (k, v) in extra { req.setValue(v, forHTTPHeaderField: k) }
            return req
        }
        if directUsable(now: now), let directBase, let token = secrets.directToken,
           let req = make(base: directBase, token: token, timeout: Self.directTimeout,
                          extra: ["X-Leo-Device-ID": directDeviceId ?? ""]) {
            out.append(req)
        }
        if let req = make(base: relayBase, token: secrets.relayKey,
                          timeout: Self.totalBudget - (out.isEmpty ? 0 : Self.directTimeout),
                          extra: ["X-Leo-Queue": "1"]) {
            if let sealed = Self.sealed(req, path: path, requestId: requestId, macKey: relayE2EKey) { out.append(sealed) }
            out.append(req)
        }
        return out
    }

    /// 中继那条的加密版:同一个请求编号,封进 `<relayBase>/e2e`。
    static func sealed(_ plain: URLRequest, path: String, requestId: String, macKey: String?) -> URLRequest? {
        guard let key = RelayE2E.validKey(macKey), let url = plain.url?.absoluteString, url.hasSuffix(path),
              let target = URL(string: String(url.dropLast(path.count)) + "/e2e"),
              let inner = RelayE2E.inner(method: "POST", path: path, body: plain.httpBody, requestId: requestId),
              let envelope = try? RelayE2E.seal(inner: inner, macKey: key),
              let body = try? JSONSerialization.data(withJSONObject: envelope.body) else { return nil }
        var req = plain
        req.url = target
        req.httpBody = body
        return req
    }

    static func isSealed(_ request: URLRequest) -> Bool { request.url?.lastPathComponent == "e2e" }
}

/// 钥匙串里放 ShareMacTarget 的两把钥匙,访问组 = App Group(主 App 与分享扩展共用)。
enum ShareMacTargetSecrets {
    private static let service = "com.leoyuan.leophoneagent.share-mac-target"

    /// 钥匙串写失败返回 false(并记日志)。之前不看 SecItemAdd 的结果:写不进去时分享扩展
    /// 读到的是上一把旧钥匙,发到中继被 401,却查不出原因。
    @discardableResult
    static func save(_ secrets: ShareMacTarget.Secrets) -> Bool {
        let relayOK = set(secrets.relayKey, account: "relay")
        if let token = secrets.directToken { return set(token, account: "direct") && relayOK }
        delete(account: "direct")
        return relayOK
    }

    static func clear() {
        delete(account: "relay")
        delete(account: "direct")
    }

    static func load() -> ShareMacTarget.Secrets? {
        guard let relay = get(account: "relay") else { return nil }
        return .init(relayKey: relay, directToken: get(account: "direct"))
    }

    private static func base(account: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service,
         kSecAttrAccount as String: account,
         kSecAttrAccessGroup as String: ShareMacTarget.appGroup]
    }

    private static func set(_ value: String, account: String) -> Bool {
        let query = base(account: account)
        let attrs: [String: Any] = [kSecValueData as String: Data(value.utf8),
                                    kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
        var status = SecItemUpdate(query as CFDictionary, attrs as CFDictionary)
        if status == errSecItemNotFound {
            status = SecItemAdd(query.merging(attrs) { $1 } as CFDictionary, nil)
        }
        guard status == errSecSuccess else {
            shareTargetLog.error("keychain write \(account, privacy: .public) failed: \(status)")
            // 写不进新值时别留着旧值误导分享扩展。
            delete(account: account)
            return false
        }
        return true
    }

    private static func get(account: String) -> String? {
        var query = base(account: account)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &out) == errSecSuccess, let data = out as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    private static func delete(account: String) {
        SecItemDelete(base(account: account) as CFDictionary)
    }
}
