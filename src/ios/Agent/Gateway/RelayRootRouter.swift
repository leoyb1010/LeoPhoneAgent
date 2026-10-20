import Foundation

/// [fix-remote] 同一个中继的多个公网入口（Cloudflare 隧道 `…/relay/api`、Tailscale Funnel `…/leoagent-relay/relay/api`）。
///
/// 手机不在 tailnet 时只能走中继，而两个入口速度差三倍：
/// - 请求按「最近成功、更快」的入口发；连接错误 / 超时 / 5xx 时换同组的另一个入口重发一次；
/// - 偏好缓存 10 分钟（持久化），过期后仍先用它，同时在后台测一次各入口的 `/relay/health`，取最快的；
/// - 只在「同一组」里互换：配置里的主 / 备入口是一组，某台 Mac 的设备描述符里列出的中继入口是一组，
///   别的中继的地址绝不会被当成替身。
///
/// 写请求（POST 等）只有带 `X-Leo-Request-Id` 时才重发：Mac 按操作编号去重（operation receipts），
/// 重发不会执行两次；没有编号的写请求只在「连都没连上」时换入口。
final class RelayRootRouter: @unchecked Sendable {
    static let shared = RelayRootRouter(configured: LeoRelayConfig.apiRoots)
    static let cacheLifetime: TimeInterval = 10 * 60
    private static let defaultsKey = "leo.relay.preferredRoot.v1"

    private let lock = NSLock()
    private var groups: [[String]] = []
    private var preferred: [String: (root: String, at: Date)] = [:]
    private var probing = Set<String>()
    private let defaults: UserDefaults?
    private let now: () -> Date
    private let probe: @Sendable (String) async -> TimeInterval?

    init(configured: [String], defaults: UserDefaults? = .standard, now: @escaping () -> Date = Date.init,
         probe: (@Sendable (String) async -> TimeInterval?)? = nil) {
        self.defaults = defaults
        self.now = now
        self.probe = probe ?? Self.healthLatency
        learn(roots: configured)
        if let saved = defaults?.dictionary(forKey: Self.defaultsKey) as? [String: [String: Any]] {
            for (key, value) in saved {
                if let root = value["root"] as? String, let at = value["at"] as? TimeInterval {
                    preferred[key] = (root, Date(timeIntervalSince1970: at))
                }
            }
        }
    }

    // MARK: Groups

    static func normalize(_ root: String) -> String { RelayMachinesClient.normalizeApiRoot(root) }

    /// 记下一组可以互换的入口（与已有组有交集就合并）。只收 https。
    func learn(roots: [String]) {
        let cleaned = roots.map(Self.normalize).filter { LeoDeviceDescriptor.validEndpoint($0) }
        guard cleaned.count >= 1 else { return }
        lock.lock(); defer { lock.unlock() }
        var merged = cleaned
        groups.removeAll { group in
            let overlaps = group.contains { existing in merged.contains { $0.lowercased() == existing.lowercased() } }
            if overlaps {
                for root in group where !merged.contains(where: { $0.lowercased() == root.lowercased() }) { merged.append(root) }
            }
            return overlaps
        }
        var unique: [String] = []
        for root in merged where !unique.contains(where: { $0.lowercased() == root.lowercased() }) { unique.append(root) }
        groups.append(unique)
    }

    /// 设备描述符里的中继入口（`…/relay/api/m/<机器名>`）：只有包含这台主机当前入口时才学成一组。
    func learn(device: LeoDeviceDescriptor?, currentHarnessURL: String?) {
        guard let device, let current = RelayMachinesClient.apiRoot(fromHarnessURL: currentHarnessURL) else { return }
        let roots = device.endpoints.filter { $0.kind == "relay" }
            .compactMap { RelayMachinesClient.apiRoot(fromHarnessURL: $0.baseURL) }
        guard roots.contains(where: { RelayMachinesClient.sameApiRoot($0, current) }) else { return }
        learn(roots: roots)
    }

    /// 地址所属的组：命中的入口与整组入口（组键 = 组里第一个入口的小写）。
    func group(for url: String) -> (key: String, matched: String, roots: [String])? {
        let lower = url.lowercased()
        lock.lock(); defer { lock.unlock() }
        for group in groups {
            if let matched = group.first(where: { lower == $0.lowercased() || lower.hasPrefix($0.lowercased() + "/") }) {
                return (group[0].lowercased(), matched, group)
            }
        }
        return nil
    }

    static func rewrite(_ url: String, from matched: String, to root: String) -> String {
        root + String(url.dropFirst(matched.count))
    }

    /// 某组的首选入口；没有偏好时给组里第一个；偏好过期时仍给它，同时后台测速。
    func preferredRoot(groupKey: String, roots: [String]) -> String {
        lock.lock()
        let entry = preferred[groupKey]
        let stale = entry.map { now().timeIntervalSince($0.at) > Self.cacheLifetime } ?? true
        let start = stale && roots.count > 1 && probing.insert(groupKey).inserted
        lock.unlock()
        if start { Task.detached { [weak self] in await self?.refresh(groupKey: groupKey, roots: roots) } }
        // [up-home] 过期的偏好照样先用：它是最近一次真走通的入口；回到主入口的话，主入口坏着时
        // 每 10 分钟就要先撞一次超时再回落。后台测速结果回来再换。
        if let entry, roots.contains(where: { $0.lowercased() == entry.root.lowercased() }) { return entry.root }
        return roots[0]
    }

    /// 尝试顺序：首选在前，其余按配置顺序。不属于任何组的地址原样一个。
    func candidates(for url: URL) -> [URL] {
        let raw = url.absoluteString
        guard let group = group(for: raw), group.roots.count > 1 else { return [url] }
        let first = preferredRoot(groupKey: group.key, roots: group.roots)
        let ordered = [first] + group.roots.filter { $0.lowercased() != first.lowercased() }
        return ordered.compactMap { URL(string: Self.rewrite(raw, from: group.matched, to: $0)) }
    }

    func recordSuccess(_ url: URL) {
        guard let group = group(for: url.absoluteString) else { return }
        setPreferred(group.key, root: group.matched, onlyIfDifferent: true)
    }

    func recordFailure(_ url: URL) {
        guard let group = group(for: url.absoluteString), group.roots.count > 1 else { return }
        let other = group.roots.first { $0.lowercased() != group.matched.lowercased() } ?? group.roots[0]
        setPreferred(group.key, root: other, onlyIfDifferent: false)
    }

    private func setPreferred(_ key: String, root: String, onlyIfDifferent: Bool) {
        lock.lock()
        if onlyIfDifferent, let current = preferred[key], current.root.lowercased() == root.lowercased(),
           now().timeIntervalSince(current.at) <= Self.cacheLifetime {
            lock.unlock(); return
        }
        preferred[key] = (root, now())
        let snapshot = preferred.mapValues { ["root": $0.root, "at": $0.at.timeIntervalSince1970] as [String: Any] }
        lock.unlock()
        defaults?.set(snapshot, forKey: Self.defaultsKey)
    }

    /// 测一次各入口的 /relay/health，取最快的（都不通就不改）。
    func refresh(groupKey: String, roots: [String]) async {
        let startedAt = now()
        let results = await withTaskGroup(of: (String, TimeInterval?).self) { group in
            for root in roots { group.addTask { [probe] in (root, await probe(root)) } }
            var out: [(String, TimeInterval?)] = []
            for await item in group { out.append(item) }
            return out
        }
        let fastest = results.compactMap { root, latency in latency.map { (root, $0) } }
            .min { lhs, rhs in lhs.1 < rhs.1 || (lhs.1 == rhs.1 && roots.firstIndex(of: lhs.0)! < roots.firstIndex(of: rhs.0)!) }
        finishProbe(groupKey)
        // 都不通也记一笔，10 分钟内不再反复测；[up-home] 记的是原来的偏好（没有才按配置顺序），
        // 测不通不等于原来那条坏了，别退回可能已失效的主入口。测速期间真实请求刚记下的结论（回落 / 成功）更新，不覆盖。
        if fresherThan(startedAt, key: groupKey) { return }
        setPreferred(groupKey, root: fastest?.0 ?? currentPreferred(groupKey, roots: roots) ?? roots[0], onlyIfDifferent: false)
    }

    private func currentPreferred(_ key: String, roots: [String]) -> String? {
        lock.lock(); defer { lock.unlock() }
        guard let root = preferred[key]?.root, roots.contains(where: { $0.lowercased() == root.lowercased() }) else { return nil }
        return root
    }

    private func fresherThan(_ date: Date, key: String) -> Bool {
        lock.lock(); defer { lock.unlock() }
        return (preferred[key]?.at).map { $0 >= date } ?? false
    }

    private func finishProbe(_ key: String) {
        lock.lock(); defer { lock.unlock() }
        probing.remove(key)
    }

    /// `…/relay/api` → `…/relay/health`（中继的健康检查不要钥匙）。
    static func healthURL(apiRoot: String) -> URL? {
        var root = normalize(apiRoot)
        if root.lowercased().hasSuffix("/api") { root = String(root.dropLast(4)) }
        return URL(string: root + "/health")
    }

    private static let probeSession: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 3
        config.timeoutIntervalForResource = 3
        config.waitsForConnectivity = false
        return URLSession(configuration: config)
    }()

    @Sendable private static func healthLatency(_ apiRoot: String) async -> TimeInterval? {
        guard let url = healthURL(apiRoot: apiRoot) else { return nil }
        let start = Date()
        guard let (_, response) = try? await probeSession.data(from: url),
              (response as? HTTPURLResponse)?.statusCode == 200 else { return nil }
        return Date().timeIntervalSince(start)
    }

    // MARK: Fallback

    /// 换入口能救的失败：连不上、超时、TLS / 连接中断；手机没网不算（换哪个都一样）。
    static func isRouteFailure(_ error: Error) -> Bool {
        guard let error = error as? URLError else { return false }
        return [.cannotConnectToHost, .cannotFindHost, .dnsLookupFailed, .timedOut, .networkConnectionLost,
                .secureConnectionFailed, .badServerResponse, .cannotLoadFromNetwork, .resourceUnavailable]
            .contains(error.code)
    }

    /// 请求肯定没送出去的连接错误（写请求没有操作编号时只在这种情况下换入口）。
    static func neverSent(_ error: Error) -> Bool {
        guard let error = error as? URLError else { return false }
        return [.cannotConnectToHost, .cannotFindHost, .dnsLookupFailed, .secureConnectionFailed].contains(error.code)
    }

    /// 入口坏了的状态码：网关错误与 Cloudflare 的 52x / 530。中继自己的 502「Mac 不在线」带正文，换入口也一样，
    /// 但重发一次无害（GET 或带操作编号）。
    static func isRouteFailure(status: Int) -> Bool {
        [502, 503, 504, 520, 521, 522, 523, 524, 525, 526, 530].contains(status)
    }

    /// 按顺序在同组入口间尝试；成功（或非入口类错误）即返回并记住这个入口。
    func perform<T>(_ original: URLRequest,
                    discard: (T) -> Void = { _ in },
                    send: (URLRequest) async throws -> (T, URLResponse)) async throws -> (T, URLResponse) {
        guard let url = original.url else { return try await send(original) }
        let urls = candidates(for: url)
        guard urls.count > 1 else { return try await send(original) }
        let method = (original.httpMethod ?? "GET").uppercased()
        let idempotent = method == "GET" || method == "HEAD" || original.value(forHTTPHeaderField: "X-Leo-Request-Id") != nil
        for (index, candidate) in urls.enumerated() {
            var request = original
            request.url = candidate
            let last = index == urls.count - 1
            do {
                let result = try await send(request)
                if let http = result.1 as? HTTPURLResponse, Self.isRouteFailure(status: http.statusCode), idempotent, !last {
                    discard(result.0)
                    recordFailure(candidate)
                    continue
                }
                recordSuccess(candidate)
                return result
            } catch {
                if Task.isCancelled || last || !Self.isRouteFailure(error) || !(idempotent || Self.neverSent(error)) { throw error }
                recordFailure(candidate)
            }
        }
        return try await send(original)
    }

    // MARK: Migration

    /// 已保存的主机地址（`<入口>/m/<机器名>`）若用的是同组的其他入口，改到主入口。不是中继地址 / 不在组里返回 nil。
    static func migratedHarnessURL(_ harnessURL: String?, primaryRoot: String?, group: [String]) -> String? {
        guard let harnessURL, let primaryRoot,
              let root = RelayMachinesClient.apiRoot(fromHarnessURL: harnessURL),
              !RelayMachinesClient.sameApiRoot(root, primaryRoot),
              group.contains(where: { RelayMachinesClient.sameApiRoot($0, root) }),
              let range = harnessURL.range(of: "/m/", options: .backwards) else { return nil }
        return normalize(primaryRoot) + harnessURL[range.lowerBound...]
    }
}
