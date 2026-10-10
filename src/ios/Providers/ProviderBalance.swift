import Foundation

/// 服务商余额:只查官方文档里有、并且就在用户已配置的同一主机上的余额接口。
/// 纯逻辑(端点判定、解析、低余额判断、缓存新鲜度),网络与钥匙串在 ProviderBalanceStore。
///
/// 端点来源(官方 API 文档,2026-10 核对):
///   DeepSeek    GET https://api.deepseek.com/user/balance              → balance_infos[].total_balance
///   OpenRouter  GET https://openrouter.ai/api/v1/key                    → data.limit_remaining(USD,无上限时为 null)
///   Moonshot    GET https://api.moonshot.cn|ai/v1/users/me/balance      → data.available_balance
///   SiliconFlow GET https://api.siliconflow.cn|com/v1/user/info         → data.totalBalance
enum ProviderBalanceService: String, Codable, Sendable, CaseIterable {
    case deepSeek, openRouter, moonshot, siliconFlow
}

struct ProviderBalanceEndpoint: Equatable, Sendable {
    let service: ProviderBalanceService
    let url: URL
    /// 接口不返回币种时用的币种(DeepSeek 的响应自带币种)。
    let currency: String
}

struct ProviderBalance: Equatable, Sendable, Codable {
    let amount: Double
    let currency: String
    let fetchedAt: Date
}

enum ProviderBalanceRules {
    /// 缓存有效期:至少 10 分钟,这里取 15 分钟。失败的请求同样按这个间隔再试。
    static let ttl: TimeInterval = 15 * 60
    /// 响应体上限:余额接口只回几百字节,超过就是不对劲。
    static let maxResponseBytes = 64 * 1024

    enum Kind: Sendable { case openRouter, openAICompatible, other }

    /// `baseURL` 是实例实际在用的 API 地址(nil = 服务商默认地址)。只认官方主机,且必须 https。
    static func endpoint(kind: Kind, baseURL: String?) -> ProviderBalanceEndpoint? {
        switch kind {
        case .other:
            return nil
        case .openRouter:
            if let baseURL {
                guard let host = httpsHost(baseURL), host == "openrouter.ai" else { return nil }
            }
            return ProviderBalanceEndpoint(service: .openRouter,
                                           url: URL(string: "https://openrouter.ai/api/v1/key")!, currency: "USD")
        case .openAICompatible:
            guard let baseURL, let host = httpsHost(baseURL) else { return nil }
            switch host {
            case "api.deepseek.com":
                return ProviderBalanceEndpoint(service: .deepSeek,
                                               url: URL(string: "https://api.deepseek.com/user/balance")!, currency: "CNY")
            case "api.moonshot.cn":
                return ProviderBalanceEndpoint(service: .moonshot,
                                               url: URL(string: "https://api.moonshot.cn/v1/users/me/balance")!, currency: "CNY")
            case "api.moonshot.ai":
                return ProviderBalanceEndpoint(service: .moonshot,
                                               url: URL(string: "https://api.moonshot.ai/v1/users/me/balance")!, currency: "USD")
            case "api.siliconflow.cn":
                return ProviderBalanceEndpoint(service: .siliconFlow,
                                               url: URL(string: "https://api.siliconflow.cn/v1/user/info")!, currency: "CNY")
            case "api.siliconflow.com":
                return ProviderBalanceEndpoint(service: .siliconFlow,
                                               url: URL(string: "https://api.siliconflow.com/v1/user/info")!, currency: "USD")
            default:
                return nil
            }
        }
    }

    private static func httpsHost(_ raw: String) -> String? {
        guard let url = URL(string: raw.trimmingCharacters(in: .whitespacesAndNewlines)),
              url.scheme?.lowercased() == "https", let host = url.host?.lowercased(), !host.isEmpty else { return nil }
        return host
    }

    /// 解析失败、字段缺失、数值不是有限数 → nil(静默失败,界面不显示余额)。
    static func parse(_ endpoint: ProviderBalanceEndpoint, data: Data, now: Date = Date()) -> ProviderBalance? {
        guard data.count <= maxResponseBytes,
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        let amount: Double?
        var currency = endpoint.currency
        switch endpoint.service {
        case .deepSeek:
            guard let infos = json["balance_infos"] as? [[String: Any]], !infos.isEmpty else { return nil }
            // 有多个币种时优先端点默认币种,否则取第一条。
            let info = infos.first { ($0["currency"] as? String)?.uppercased() == endpoint.currency } ?? infos[0]
            amount = number(info["total_balance"])
            if let c = info["currency"] as? String, !c.isEmpty { currency = c.uppercased() }
        case .openRouter:
            amount = number((json["data"] as? [String: Any])?["limit_remaining"])
        case .moonshot:
            amount = number((json["data"] as? [String: Any])?["available_balance"])
        case .siliconFlow:
            amount = number((json["data"] as? [String: Any])?["totalBalance"])
        }
        guard let amount, amount.isFinite, abs(amount) < 1e12 else { return nil }
        return ProviderBalance(amount: amount, currency: currency, fetchedAt: now)
    }

    private static func number(_ value: Any?) -> Double? {
        switch value {
        case let n as NSNumber where CFGetTypeID(n) != CFBooleanGetTypeID():
            return n.doubleValue
        case let s as String:
            return Double(s.trimmingCharacters(in: .whitespaces))
        default:
            return nil
        }
    }

    static func isFresh(fetchedAt: Date?, now: Date = Date()) -> Bool {
        guard let fetchedAt else { return false }
        let age = now.timeIntervalSince(fetchedAt)
        return age >= 0 && age < ttl
    }

    // MARK: - 低余额阈值(按币种,可在服务商详情页改)

    static func thresholdKey(currency: String) -> String { "leo.balance.lowThreshold.\(currency.uppercased())" }

    static func defaultThreshold(currency: String) -> Double {
        switch currency.uppercased() {
        case "CNY": return 10
        case "USD": return 2
        default: return 2
        }
    }

    static func threshold(currency: String, defaults: UserDefaults = .standard) -> Double {
        if let v = defaults.object(forKey: thresholdKey(currency: currency)) as? Double, v.isFinite, v >= 0 { return v }
        return defaultThreshold(currency: currency)
    }

    static func setThreshold(_ value: Double?, currency: String, defaults: UserDefaults = .standard) {
        let key = thresholdKey(currency: currency)
        if let value, value.isFinite, value >= 0 {
            defaults.set(min(value, 1_000_000), forKey: key)
        } else {
            defaults.removeObject(forKey: key)
        }
    }

    static func isLow(_ balance: ProviderBalance, threshold: Double) -> Bool {
        balance.amount < threshold
    }

    static func display(_ balance: ProviderBalance) -> String {
        let symbol: String
        switch balance.currency.uppercased() {
        case "CNY": symbol = "¥"
        case "USD": symbol = "$"
        default: symbol = balance.currency.uppercased() + " "
        }
        return symbol + String(format: "%.2f", balance.amount)
    }
}
