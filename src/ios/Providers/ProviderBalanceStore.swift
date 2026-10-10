import Foundation

private let logger = AppLogger(category: "ProviderBalance")

/// 服务商余额的内存缓存 + 后台刷新。规则见 `ProviderBalanceRules`。
///
/// - 只请求用户已配置的同一主机上的官方余额接口,用的就是该实例自己的密钥。
/// - 每个实例至少 15 分钟才查一次(失败也算一次),同一实例不并发。
/// - 钥匙串读取和网络都在后台;任何失败都静默,不阻塞模型选择器,也不弹错。
@MainActor
final class ProviderBalanceStore: ObservableObject {
    static let shared = ProviderBalanceStore()

    @Published private(set) var balances: [String: ProviderBalance] = [:]
    private var lastAttempt: [String: Date] = [:]
    private var inFlight: Set<String> = []

    private init() {}

    func balance(for instanceId: String) -> ProviderBalance? { balances[instanceId] }

    func isLow(instanceId: String) -> Bool {
        guard let b = balances[instanceId] else { return false }
        return ProviderBalanceRules.isLow(b, threshold: ProviderBalanceRules.threshold(currency: b.currency))
    }

    /// 这个实例有没有可查的余额接口(只看类型和地址,不读钥匙串)。
    static func supportsBalance(_ instance: ProviderInstance) -> Bool {
        endpointKind(instance) != .other
    }

    /// 显示提醒值时用的币种(还没查到余额时):按端点推断,不读钥匙串。
    static func expectedCurrency(_ instance: ProviderInstance) -> String {
        let kind = endpointKind(instance)
        if kind == .openRouter { return "USD" }
        return ProviderBalanceRules.endpoint(kind: kind, baseURL: instance.customBaseURL)?.currency ?? "CNY"
    }

    private static func endpointKind(_ instance: ProviderInstance) -> ProviderBalanceRules.Kind {
        guard instance.isEnabled, !instance.azureMode else { return .other }
        switch instance.providerType {
        case .openRouter: return .openRouter
        case .openAI, .openAIResponses: return instance.credentialType == .apiKey ? .openAICompatible : .other
        default: return .other
        }
    }

    /// 对过期(或从没查过)的实例在后台查一次余额。`force` 跳过 TTL(详情页的手动刷新)。
    func refreshIfStale(_ instances: [ProviderInstance], force: Bool = false) {
        let now = Date()
        for instance in instances {
            let kind = Self.endpointKind(instance)
            guard kind != .other, !inFlight.contains(instance.id) else { continue }
            if !force, ProviderBalanceRules.isFresh(fetchedAt: lastAttempt[instance.id], now: now) { continue }
            inFlight.insert(instance.id)
            lastAttempt[instance.id] = now
            let snapshot = instance
            Task.detached(priority: .utility) {
                let result = await Self.fetch(snapshot, kind: kind)
                await MainActor.run {
                    let store = ProviderBalanceStore.shared
                    store.inFlight.remove(snapshot.id)
                    if let result {
                        store.balances[snapshot.id] = result
                    }
                }
            }
        }
    }

    /// 后台执行:读钥匙串、解析地址、请求、解析。任何一步失败 → nil。
    nonisolated private static func fetch(_ instance: ProviderInstance, kind: ProviderBalanceRules.Kind) async -> ProviderBalance? {
        let manualToken = instance.storedManualToken()
        let base = instance.effectiveCustomBaseURL(manualToken: manualToken)
        guard let endpoint = ProviderBalanceRules.endpoint(kind: kind, baseURL: base) else { return nil }
        guard let key = (manualToken ?? ProviderKeychainHelper.loadAPIKey(instanceId: instance.id, caller: "balance"))?
                .trimmingCharacters(in: .whitespacesAndNewlines), !key.isEmpty else { return nil }
        var request = URLRequest(url: endpoint.url)
        request.httpMethod = "GET"
        request.timeoutInterval = 10
        request.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue(MinisUserAgent.default, forHTTPHeaderField: "User-Agent")
        do {
            let (data, response) = try await session.data(for: request)
            let status = (response as? HTTPURLResponse)?.statusCode ?? -1
            guard status == 200 else {
                logger.info("[Balance] service=\(endpoint.service.rawValue) status=\(status)")
                return nil
            }
            let parsed = ProviderBalanceRules.parse(endpoint, data: data)
            logger.info("[Balance] service=\(endpoint.service.rawValue) ok=\(parsed != nil)")
            return parsed
        } catch {
            logger.info("[Balance] service=\(endpoint.service.rawValue) failed")
            return nil
        }
    }

    nonisolated private static let session: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 10
        config.timeoutIntervalForResource = 20
        config.httpCookieStorage = nil
        config.urlCache = nil
        config.waitsForConnectivity = false
        return URLSession(configuration: config, delegate: StrictNoRedirectDelegate(), delegateQueue: nil)
    }()
}

/// 不跟随任何重定向:余额请求和 MCP 授权发现都带着凭据或只信任对方声明的端点,只能落在请求的主机本身。
final class StrictNoRedirectDelegate: NSObject, URLSessionTaskDelegate, Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest,
                    completionHandler: @escaping @Sendable (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}
