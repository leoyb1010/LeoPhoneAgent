//
//  BrainSpaceAPI.swift
//  LeoPhoneAgent
//
//  [brain-space] 第二大脑空间的网络层:设备令牌(钥匙串里那把)+ 网关 /v1/app,
//  走的是网页版同一套资料库 /api。业务逻辑全部留在 Mac mini,这里只取数和显示。
//  · URLSession 用 ephemeral:不落 cookie、不进系统 URL 缓存;跨主机重定向一律拦下。
//  · 缩略图、头像自己缓存在 Caches/BrainSpace(可随时被系统清掉)。
//

import CryptoKit
import Foundation
import UIKit

enum BrainSpaceError: LocalizedError, Equatable {
    case notConfigured
    case noAppScope
    case http(Int, String)
    case invalid
    /// A request built for one connection configuration met a different one (switched or disconnected meanwhile).
    case connectionChanged

    var errorDescription: String? {
        switch self {
        case .notConfigured: return "还没有连接第二大脑。连接后就能在手机上看照片、读资料、提问。"
        case .noAppScope: return "这台设备的钥匙还没开通第二大脑空间。请在资料库所在的 Mac 上为这台设备开通 app 权限。"
        case .http(let code, let msg): return msg.isEmpty ? "资料库返回 \(code)" : msg
        case .invalid: return "资料库返回的内容看不懂"
        case .connectionChanged: return "资料库连接已更换,请重新打开"
        }
    }

    /// Operator detail for the setup page's 「高级」 section (not shown by default).
    var advancedHint: String? {
        switch self {
        case .notConfigured: return "也可以在资料库所在的 Mac 上生成连接链接或配置文件,手机打开后在设置里确认。"
        case .noAppScope: return "在资料库所在的 Mac 上运行:brainctl token grant(为这台设备的钥匙加上 app 权限)。"
        default: return nil
        }
    }
}

final class BrainSpaceAPI: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    static let shared = BrainSpaceAPI()

    private lazy var session: URLSession = {
        let cfg = URLSessionConfiguration.ephemeral
        cfg.timeoutIntervalForRequest = 40
        cfg.timeoutIntervalForResource = 30 * 60
        cfg.urlCache = nil
        cfg.httpCookieStorage = nil
        cfg.httpShouldSetCookies = false
        cfg.httpMaximumConnectionsPerHost = 6
        return URLSession(configuration: cfg, delegate: self, delegateQueue: nil)
    }()
    private let lock = NSLock()
    /// Archive page token, memory only, bound to the exact configuration (endpoint + auth headers) that fetched it.
    private var leoToken: (config: Config, token: String)?

    static var decoder: JSONDecoder { BrainSpaceJSON.decoder }

    // MARK: Config

    /// One snapshot of the connection. A request captures it once and uses it for URL, headers and page-token
    /// refreshes, so switching connections mid-request can never send an old request to a new endpoint (or the reverse).
    struct Config: Equatable, Sendable {
        let endpoint: BrainEndpoint
        let headers: [String: String]
    }

    func config() throws -> Config {
        guard let token = BrainKeychain.get(.token) else { throw BrainSpaceError.notConfigured }
        // Same key as BrainStore.baseURLKey (that one is main-actor isolated; this runs off the main actor).
        let raw = UserDefaults.standard.string(forKey: "leo.brain.baseURL") ?? BrainEndpoint.defaultBaseURL
        guard let endpoint = BrainEndpoint(baseString: raw) else { throw BrainSpaceError.notConfigured }
        let creds = BrainCredentials(token: token,
                                     accessClientId: BrainKeychain.get(.accessClientId),
                                     accessClientSecret: BrainKeychain.get(.accessClientSecret))
        return Config(endpoint: endpoint, headers: creds.headers())
    }

    var webBase: URL? { try? config().endpoint.base }

    func apiURL(_ path: String, query: [(String, String)] = []) throws -> URL {
        try config().endpoint.url("/v1/app/api" + path, query: query)
    }

    // MARK: Requests

    func get<T: Decodable>(_ path: String, query: [(String, String)] = [], as type: T.Type = T.self) async throws -> T {
        try await get(path, query: query, config: try config(), as: type)
    }

    /// GET with an already captured configuration (URL and headers from the same snapshot).
    func get<T: Decodable>(_ path: String, query: [(String, String)] = [], config cfg: Config, as type: T.Type = T.self) async throws -> T {
        let data = try await send(request(cfg, cfg.endpoint.url("/v1/app/api" + path, query: query)))
        do { return try Self.decoder.decode(T.self, from: data) } catch { throw BrainSpaceError.invalid }
    }

    func manifest() async throws -> BrainSpaceManifest {
        let cfg = try config()
        let data = try await send(request(cfg, cfg.endpoint.url("/v1/app/manifest")))
        do { return try Self.decoder.decode(BrainSpaceManifest.self, from: data) } catch { throw BrainSpaceError.invalid }
    }

    func webSession() async throws -> BrainWebSession { try await webSession(config: try config()) }

    /// Web-session cookie for the in-app web UI, fetched with the same snapshot the sheet will load pages from.
    func webSession(config cfg: Config) async throws -> BrainWebSession {
        let data = try await send(request(cfg, cfg.endpoint.url("/v1/app/web-session"), method: "POST"))
        do { return try Self.decoder.decode(BrainWebSession.self, from: data) } catch { throw BrainSpaceError.invalid }
    }

    /// POST JSON to the archive. Writes need the archive's page token (same as the web UI); refetched once if it rotated.
    func post<T: Decodable>(_ path: String, _ body: [String: Any], as type: T.Type = T.self) async throws -> T {
        try await post(path, body, config: try config(), as: type)
    }

    /// POST with an already captured configuration: the caller froze it together with the identity it acts for.
    func post<T: Decodable>(_ path: String, _ body: [String: Any], config cfg: Config, as type: T.Type = T.self) async throws -> T {
        let payload = try JSONSerialization.data(withJSONObject: body)
        let data = try await postData(path, query: [], body: payload, contentType: "application/json", extra: [:], config: cfg)
        do { return try Self.decoder.decode(T.self, from: data) } catch { throw BrainSpaceError.invalid }
    }

    func postData(_ path: String, query: [(String, String)], body: Data, contentType: String,
                  extra: [String: String]) async throws -> Data {
        try await postData(path, query: query, body: body, contentType: contentType, extra: extra, config: try config())
    }

    /// Every attempt (and the page-token fetch / refresh between them) uses the one captured `cfg`.
    func postData(_ path: String, query: [(String, String)], body: Data, contentType: String,
                  extra: [String: String], config cfg: Config) async throws -> Data {
        let url = cfg.endpoint.url("/v1/app/api" + path, query: query)
        for attempt in 0..<2 {
            let token = try await pageToken(refresh: attempt > 0, config: cfg)
            var req = request(cfg, url, method: "POST")
            req.setValue(token, forHTTPHeaderField: "X-Leo-Token")
            req.setValue(contentType, forHTTPHeaderField: "Content-Type")
            extra.forEach { req.setValue($1, forHTTPHeaderField: $0) }
            req.httpBody = body
            do { return try await send(req) } catch BrainSpaceError.http(403, let msg) where attempt == 0 && msg.contains("会话") {
                continue
            }
        }
        throw BrainSpaceError.invalid
    }

    private func pageToken(refresh: Bool, config cfg: Config) async throws -> String {
        if !refresh, let t = lock.withLock({ leoToken.flatMap { $0.config == cfg ? $0.token : nil } }) { return t }
        let s: BrainArchiveSession = try await get("/session", config: cfg)
        lock.withLock { leoToken = (cfg, s.token) }
        return s.token
    }

    /// For URLs built earlier with `apiURL` (image cache). Current credentials are attached only if the URL still
    /// points at the current endpoint's origin; a URL from a previous connection is refused, never re-authorized.
    func raw(_ url: URL) async throws -> Data {
        let cfg = try config()
        guard BrainEndpoint.allowsRedirect(from: cfg.endpoint.base, to: url) else { throw BrainSpaceError.connectionChanged }
        return try await send(request(cfg, url))
    }

    /// Authorized request for media players (AVURLAsset needs the same headers).
    func authorizedHeaders() -> [String: String] { (try? config().headers) ?? [:] }

    private func request(_ cfg: Config, _ url: URL, method: String = "GET") -> URLRequest {
        var req = URLRequest(url: url)
        req.httpMethod = method
        cfg.headers.forEach { req.setValue($1, forHTTPHeaderField: $0) }
        return req
    }

    private func send(_ req: URLRequest) async throws -> Data {
        let (data, response): (Data, URLResponse)
        do { (data, response) = try await session.data(for: req) } catch let e as URLError {
            throw BrainSpaceError.http(0, e.code == .notConnectedToInternet ? "没有网络" : "连不上资料库(\(e.code.rawValue))")
        }
        guard let http = response as? HTTPURLResponse else { throw BrainSpaceError.invalid }
        guard (200..<300).contains(http.statusCode) else {
            let msg = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["error"] as? String ?? ""
            if http.statusCode == 403, msg.contains("app 权限") { throw BrainSpaceError.noAppScope }
            if http.statusCode == 401 { throw BrainSpaceError.http(401, "设备钥匙无效或已吊销") }
            throw BrainSpaceError.http(http.statusCode, msg)
        }
        return data
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        // Judge against the origin this task was created for, not whatever the connection is now.
        guard let base = task.originalRequest?.url, let target = request.url, BrainEndpoint.allowsRedirect(from: base, to: target) else {
            completionHandler(nil); return
        }
        completionHandler(request)
    }
}

// MARK: - Image cache

actor BrainImageCache {
    static let shared = BrainImageCache()
    private let memory = NSCache<NSString, UIImage>()
    private let dir: URL
    private var inflight: [String: Task<UIImage?, Never>] = [:]

    init() {
        memory.countLimit = 600
        dir = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("BrainSpace", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let root = dir
        Task.detached(priority: .background) { Self.prune(root) }
    }

    /// Keep the disk cache under ~400 MB (34k thumbnails would otherwise grow without bound); oldest first.
    nonisolated static func prune(_ dir: URL, limit: Int = 400 * 1024 * 1024) {
        let keys: Set<URLResourceKey> = [.contentModificationDateKey, .fileSizeKey]
        guard let files = try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: Array(keys)) else { return }
        var entries = files.compactMap { url -> (URL, Date, Int)? in
            guard let v = try? url.resourceValues(forKeys: keys) else { return nil }
            return (url, v.contentModificationDate ?? .distantPast, v.fileSize ?? 0)
        }
        var total = entries.reduce(0) { $0 + $1.2 }
        guard total > limit else { return }
        entries.sort { $0.1 < $1.1 }
        for (url, _, size) in entries where total > limit * 3 / 4 {
            try? FileManager.default.removeItem(at: url); total -= size
        }
    }

    /// path: an archive API path such as /api/media/<id>/thumbnail (the /api prefix is optional).
    func image(_ path: String) async -> UIImage? {
        let key = path.hasPrefix("/api") ? String(path.dropFirst(4)) : path
        if let hit = memory.object(forKey: key as NSString) { return hit }
        if let running = inflight[key] { return await running.value }
        let file = dir.appendingPathComponent(SHA256.hash(data: Data(key.utf8)).map { String(format: "%02x", $0) }.joined())
        let task = Task<UIImage?, Never> {
            if let data = try? Data(contentsOf: file), let img = UIImage(data: data) { return img }
            let parts = key.split(separator: "?", maxSplits: 1)
            let query = parts.count > 1 ? URLComponents(string: "?" + parts[1])?.queryItems?.map { ($0.name, $0.value ?? "") } ?? [] : []
            guard let url = try? BrainSpaceAPI.shared.apiURL(String(parts[0]), query: query) else { return nil }
            var data: Data?
            for attempt in 0..<3 {
                do { data = try await BrainSpaceAPI.shared.raw(url); break }
                catch BrainSpaceError.http(let code, _) where code == 429 || code == 503 || code == 0 {
                    // Fast scrolling can hit the gateway's per-minute limit; wait and try again instead of leaving a blank tile.
                    try? await Task.sleep(for: .seconds(2 << attempt))
                } catch { return nil }
            }
            guard let data, let img = UIImage(data: data) else { return nil }
            try? data.write(to: file, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
            return img
        }
        inflight[key] = task
        let img = await task.value
        inflight[key] = nil
        if let img { memory.setObject(img, forKey: key as NSString) }
        return img
    }
}
