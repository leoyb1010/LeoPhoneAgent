//
//  BrainStore.swift
//  MinisApp
//
//  [T-brain] 资料库连接状态(App 内唯一):服务地址、令牌是否就位、连接检测、
//  私密资料解锁、离线缓存、无输入配置(设备文件 / 深链)。
//

import Foundation
import LocalAuthentication
import UniformTypeIdentifiers

private let brainLog = AppLogger(category: "Brain")

@MainActor
final class BrainStore: ObservableObject {
    static let shared = BrainStore()

    static let baseURLKey = "leo.brain.baseURL"
    static let scopesKey = "leo.brain.scopes"

    @Published private(set) var isConfigured: Bool
    @Published var baseURLString: String
    @Published private(set) var health: BrainHealth?
    @Published private(set) var statusError: String?
    @Published private(set) var checking = false
    @Published private(set) var unlock = BrainUnlockState()
    /// 深链带来的令牌,等你在设置页确认后才写进钥匙串。
    @Published var pendingConnect: BrainConnectRequest?
    @Published private(set) var knownScopes: Set<String>?
    @Published private(set) var hasAccessCredentials: Bool

    let cache = BrainOfflineCache(root: BrainOfflineCache.defaultRoot())

    private init() {
        let defaults = UserDefaults.standard
        baseURLString = defaults.string(forKey: Self.baseURLKey) ?? BrainEndpoint.defaultBaseURL
        isConfigured = BrainKeychain.get(.token) != nil
        hasAccessCredentials = BrainKeychain.get(.accessClientId) != nil
        knownScopes = BrainToolGating.parseScopes(defaults.string(forKey: Self.scopesKey))
    }

    // MARK: Connection

    var endpoint: BrainEndpoint? { BrainEndpoint(baseString: baseURLString) }

    func client() -> BrainClient? {
        guard let endpoint, let token = BrainKeychain.get(.token) else { return nil }
        return BrainClient(endpoint: endpoint, credentials: BrainCredentials(
            token: token,
            accessClientId: BrainKeychain.get(.accessClientId),
            accessClientSecret: BrainKeychain.get(.accessClientSecret)))
    }

    func requireClient() throws -> BrainClient {
        guard isConfigured else { throw BrainError.notConfigured }
        guard endpoint != nil else { throw BrainError.invalidBaseURL }
        guard let c = client() else { throw BrainError.notConfigured }
        return c
    }

    @discardableResult
    func saveBaseURL(_ raw: String) -> Bool {
        guard let url = BrainEndpoint.normalizedBase(raw) else { return false }
        baseURLString = url.absoluteString
        UserDefaults.standard.set(baseURLString, forKey: Self.baseURLKey)
        health = nil
        return true
    }

    @discardableResult
    func connect(_ request: BrainConnectRequest) -> Bool {
        guard BrainTokenValidator.isValid(request.token), BrainKeychain.set(request.token, for: .token) else {
            brainLog.warning("brain connect: token rejected or keychain write failed")
            return false
        }
        knownScopes = request.scopes
        if let scopes = request.scopes {
            UserDefaults.standard.set(scopes.sorted().joined(separator: ","), forKey: Self.scopesKey)
        } else {
            UserDefaults.standard.removeObject(forKey: Self.scopesKey)
        }
        isConfigured = true
        pendingConnect = nil
        health = nil
        statusError = nil
        brainLog.info("brain connect: token stored in keychain")
        return true
    }

    func saveAccessCredentials(id: String, secret: String) {
        let id = id.trimmingCharacters(in: .whitespacesAndNewlines)
        let secret = secret.trimmingCharacters(in: .whitespacesAndNewlines)
        if id.isEmpty || secret.isEmpty {
            BrainKeychain.delete(.accessClientId)
            BrainKeychain.delete(.accessClientSecret)
        } else {
            BrainKeychain.set(id, for: .accessClientId)
            BrainKeychain.set(secret, for: .accessClientSecret)
        }
        hasAccessCredentials = BrainKeychain.get(.accessClientId) != nil
    }

    /// 断开:删钥匙串里的令牌与 Access 凭据,清离线缓存,锁回私密资料。
    func disconnect() {
        BrainKeychain.deleteAll()
        UserDefaults.standard.removeObject(forKey: Self.scopesKey)
        cache.clearAll()
        isConfigured = false
        hasAccessCredentials = false
        knownScopes = nil
        health = nil
        statusError = nil
        unlock = BrainUnlockState()
        brainLog.info("brain disconnected: token removed")
    }

    func refreshHealth() async {
        guard isConfigured else { health = nil; statusError = nil; return }
        checking = true
        defer { checking = false }
        do {
            let client = try requireClient()
            health = try await client.health().0
            statusError = nil
        } catch {
            health = nil
            statusError = (error as? BrainError)?.message ?? BrainError.network.message
        }
    }

    // MARK: Private unlock

    func isUnlockFresh(now: Date = Date()) -> Bool { unlock.isFresh(now: now) }

    /// Face ID / 设备密码。5 分钟内解锁过就不再问。
    func unlockPrivate() async -> Bool {
        if unlock.isFresh(now: Date()) { return true }
        let ctx = LAContext()
        var err: NSError?
        guard ctx.canEvaluatePolicy(.deviceOwnerAuthentication, error: &err) else { return false }
        let ok = (try? await ctx.evaluatePolicy(.deviceOwnerAuthentication,
                                                localizedReason: String(localized: "查看资料库里的私密资料"))) ?? false
        if ok { unlock.recordUnlock(at: Date()) }
        return ok
    }

    // MARK: Provisioning without typing

    static var provisionFileURL: URL? {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first?
            .appendingPathComponent(BrainProvisioning.directoryName, isDirectory: true)
            .appendingPathComponent(BrainProvisioning.tokenFileName)
    }

    /// 启动 / 回到前台 / 打开设置页时检查:有配置文件就导入钥匙串并删除文件。
    func importProvisionFileIfPresent() {
        guard let url = Self.provisionFileURL else { return }
        let outcome = BrainProvisioning.importTokenFile(at: url) { request in self.connect(request) }
        if outcome != .none { brainLog.info("\(outcome.logDescription)") }
    }

    /// 深链:只暂存,等你在设置页点确认。
    func receiveDeepLink(_ url: URL) -> Bool {
        switch BrainProvisioning.parse(url: url) {
        case .success(let request):
            pendingConnect = request
            brainLog.info("brain deep link: token received, awaiting confirmation")
            return true
        case .failure(let reason):
            brainLog.info("brain deep link rejected: \(String(describing: reason))")
            return false
        }
    }

    // MARK: Capture to inbox

    func captureText(_ text: String, filename: String) async throws -> BrainInboxReceipt {
        let client = try requireClient()
        return try await client.inbox(data: Data(text.utf8), filename: filename, contentType: "text/markdown; charset=utf-8")
    }

    func captureFile(_ url: URL, filename: String? = nil) async throws -> BrainInboxReceipt {
        let client = try requireClient()
        let type = UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
        return try await client.inbox(fileURL: url, filename: filename ?? url.lastPathComponent, contentType: type)
    }

    static func markdownFileName(_ title: String) -> String {
        let cleaned = title.trimmingCharacters(in: .whitespacesAndNewlines)
        return (cleaned.isEmpty ? "LeoBot" : String(cleaned.prefix(60))) + ".md"
    }
}
