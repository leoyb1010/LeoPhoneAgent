//
//  BrainClient.swift
//  MinisApp
//
//  [T-brain] 资料库网关客户端 + 钥匙串。
//  · URLSession 用 ephemeral 配置:不落 cookie、不进 URL 缓存;请求超时 30 秒。
//  · 只跟同主机重定向;别的主机一律拦下(令牌不会被带到别处)。
//  · 令牌只在钥匙串(本机、首次解锁后可读、不同步),任何日志都不打印它。
//

import Foundation
import Security

// MARK: - Keychain

enum BrainKeychain {
    private static let service = "com.leoyuan.leophoneagent.brain"

    enum Item: String, CaseIterable {
        case token = "device-token"
        case accessClientId = "cf-access-client-id"
        case accessClientSecret = "cf-access-client-secret"
    }

    @discardableResult
    static func set(_ value: String, for item: Item) -> Bool {
        delete(item)
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: item.rawValue,
            kSecAttrSynchronizable as String: false,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
            kSecValueData as String: Data(value.utf8),
        ]
        return SecItemAdd(query as CFDictionary, nil) == errSecSuccess
    }

    static func get(_ item: Item) -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: item.rawValue,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var out: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &out) == errSecSuccess,
              let data = out as? Data, let s = String(data: data, encoding: .utf8), !s.isEmpty else { return nil }
        return s
    }

    static func delete(_ item: Item) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: item.rawValue,
        ]
        SecItemDelete(query as CFDictionary)
    }

    static func deleteAll() { Item.allCases.forEach(delete) }
}

// MARK: - Client

final class BrainClient: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    let endpoint: BrainEndpoint
    private let credentials: BrainCredentials
    private lazy var session: URLSession = {
        let cfg = URLSessionConfiguration.ephemeral
        cfg.timeoutIntervalForRequest = 30
        cfg.timeoutIntervalForResource = 15 * 60   // 下载 / 上传原件可以更久;单次空闲仍是 30 秒
        cfg.urlCache = nil
        cfg.requestCachePolicy = .reloadIgnoringLocalCacheData
        cfg.httpCookieStorage = nil
        cfg.httpShouldSetCookies = false
        cfg.waitsForConnectivity = false
        return URLSession(configuration: cfg, delegate: self, delegateQueue: nil)
    }()

    init(endpoint: BrainEndpoint, credentials: BrainCredentials) {
        self.endpoint = endpoint
        self.credentials = credentials
    }

    deinit { session.invalidateAndCancel() }

    // MARK: Endpoints

    func health() async throws -> (BrainHealth, Data) { try await getDecoded(endpoint.health()) }

    func search(_ query: String, scope: BrainSearchScope, limit: Int = 20, offset: Int = 0,
                includePrivate: Bool) async throws -> BrainSearchResponse {
        try await getDecoded(endpoint.search(query: query, scope: scope, limit: limit, offset: offset,
                                             includePrivate: includePrivate)).0
    }

    func file(_ id: String) async throws -> (BrainFileMeta, Data) { try await getDecoded(endpoint.file(id)) }

    func chunks(_ id: String, offset: Int, locator: String? = nil) async throws -> (BrainChunkPage, Data) {
        try await getDecoded(endpoint.chunks(id, offset: offset, locator: locator))
    }

    func cards(offset: Int = 0, limit: Int = 50) async throws -> (BrainCardList, Data) {
        try await getDecoded(endpoint.cards(offset: offset, limit: limit))
    }

    func card(_ id: String, version: Int? = nil) async throws -> (BrainCard, Data) {
        try await getDecoded(endpoint.card(id, version: version))
    }

    func saveCard(_ draft: BrainCardDraft) async throws -> (BrainCard, Data) {
        var req = request(endpoint.saveCard(), method: "POST")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = draft.jsonBody()
        let data = try await send(req)
        return (try BrainJSON.decode(BrainCard.self, from: data), data)
    }

    func audit(limit: Int = 30) async throws -> BrainAuditList {
        try await getDecoded(endpoint.audit(limit: limit)).0
    }

    /// 送进资料库收件箱。文本走内存,文件走 upload(fromFile:),不把大文件读进内存。
    func inbox(data: Data, filename: String, contentType: String) async throws -> BrainInboxReceipt {
        var req = request(endpoint.inbox(), method: "POST")
        req.setValue(BrainInboxNaming.headerValue(for: filename), forHTTPHeaderField: "X-Filename")
        req.setValue(contentType, forHTTPHeaderField: "Content-Type")
        let (body, response) = try await perform { try await self.session.upload(for: req, from: data) }
        return try BrainJSON.decode(BrainInboxReceipt.self, from: try validate(body, response))
    }

    func inbox(fileURL: URL, filename: String, contentType: String) async throws -> BrainInboxReceipt {
        let size = (try? fileURL.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
        guard size <= 256 * 1024 * 1024 else { throw BrainError.payloadTooLarge }
        var req = request(endpoint.inbox(), method: "POST")
        req.setValue(BrainInboxNaming.headerValue(for: filename), forHTTPHeaderField: "X-Filename")
        req.setValue(contentType, forHTTPHeaderField: "Content-Type")
        let (body, response) = try await perform { try await self.session.upload(for: req, fromFile: fileURL) }
        return try BrainJSON.decode(BrainInboxReceipt.self, from: try validate(body, response))
    }

    /// 申请 5 分钟签名链接,下载到临时目录(文件名取网关给的,去掉路径)。
    func downloadOriginal(_ id: String) async throws -> URL {
        let data = try await send(request(endpoint.link(id), method: "POST"))
        let link = try BrainJSON.decode(BrainDownloadLink.self, from: data)
        guard let url = endpoint.download(link.url) else { throw BrainError.invalidResponse }
        var req = URLRequest(url: url)
        for (k, v) in credentials.headers(bearer: false) { req.setValue(v, forHTTPHeaderField: k) }
        let (tmp, response) = try await perform { try await self.session.download(for: req) }
        guard let http = response as? HTTPURLResponse else { throw BrainError.invalidResponse }
        guard (200..<300).contains(http.statusCode) else {
            throw BrainError.from(status: http.statusCode, body: nil, retryAfter: http.value(forHTTPHeaderField: "Retry-After"))
        }
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("BrainDownloads", isDirectory: true)
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        var name = (link.filename as NSString).lastPathComponent
        if name.isEmpty || name == "." || name == ".." { name = "download" }
        let dest = dir.appendingPathComponent(name)
        try FileManager.default.moveItem(at: tmp, to: dest)
        return dest
    }

    // MARK: Plumbing

    private func request(_ url: URL, method: String = "GET") -> URLRequest {
        var req = URLRequest(url: url)
        req.httpMethod = method
        req.timeoutInterval = 30
        for (k, v) in credentials.headers() { req.setValue(v, forHTTPHeaderField: k) }
        return req
    }

    private func getDecoded<T: Decodable>(_ url: URL) async throws -> (T, Data) {
        let data = try await send(request(url))
        return (try BrainJSON.decode(T.self, from: data), data)
    }

    private func send(_ req: URLRequest) async throws -> Data {
        let (data, response) = try await perform { try await self.session.data(for: req) }
        return try validate(data, response)
    }

    private func validate(_ data: Data, _ response: URLResponse) throws -> Data {
        guard let http = response as? HTTPURLResponse else { throw BrainError.invalidResponse }
        // 被拦下的跨主机重定向会以 3xx 原样回来。
        if (300..<400).contains(http.statusCode) { throw BrainError.redirectBlocked }
        guard (200..<300).contains(http.statusCode) else {
            throw BrainError.from(status: http.statusCode, body: data,
                                  retryAfter: http.value(forHTTPHeaderField: "Retry-After"))
        }
        return data
    }

    private func perform<T>(_ op: () async throws -> T) async throws -> T {
        do { return try await op() }
        catch let e as BrainError { throw e }
        catch let e as URLError { throw BrainError.from(urlErrorCode: e.errorCode) }
        catch is CancellationError { throw CancellationError() }
        catch { throw BrainError.network }
    }

    // MARK: URLSessionTaskDelegate

    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        guard let target = request.url,
              BrainEndpoint.allowsRedirect(from: endpoint.base, to: target) else {
            completionHandler(nil)
            return
        }
        completionHandler(request)
    }
}
