import Foundation

/// 每个服务商实例的「响应超时」:模型多久没有任何输出就判定为卡住。
/// 没设置时与原来完全一样(停滞检测 120 秒,请求空闲超时 600 秒)。
/// 设置后同时作用于流式停滞检测和该实例的请求超时。只存在本机(UserDefaults),不随 iCloud 同步。
enum ProviderResponseTimeout {
    static let defaultStallSeconds: TimeInterval = 120
    static let defaultRequestSeconds: TimeInterval = 600
    /// 上限 600:不超过各 URLSession 的 600 秒空闲上限,设置值总能真正生效。
    static let allowedRange: ClosedRange<Int> = 30...600

    static func key(instanceId: String) -> String { "leo.provider.responseTimeout.\(instanceId)" }

    /// 已保存的秒数(夹到允许范围);没设置返回 nil。
    static func stored(instanceId: String, defaults: UserDefaults = .standard) -> Int? {
        guard !instanceId.isEmpty, let v = defaults.object(forKey: key(instanceId: instanceId)) as? Int, v > 0 else { return nil }
        return clamp(v)
    }

    static func set(_ seconds: Int?, instanceId: String, defaults: UserDefaults = .standard) {
        guard !instanceId.isEmpty else { return }
        if let seconds, seconds > 0 {
            defaults.set(clamp(seconds), forKey: key(instanceId: instanceId))
        } else {
            defaults.removeObject(forKey: key(instanceId: instanceId))
        }
    }

    /// 用户输入的文字 → 秒数。空、非数字、0 → nil(恢复默认)。
    static func parse(_ text: String) -> Int? {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let v = Int(t), v > 0 else { return nil }
        return clamp(v)
    }

    static func clamp(_ v: Int) -> Int { min(max(v, allowedRange.lowerBound), allowedRange.upperBound) }

    static func stallSeconds(override: Int?) -> TimeInterval {
        override.map { TimeInterval(clamp($0)) } ?? defaultStallSeconds
    }

    static func requestSeconds(override: Int?) -> TimeInterval {
        override.map { TimeInterval(clamp($0)) } ?? defaultRequestSeconds
    }

    static func stallSeconds(instanceId: String?, defaults: UserDefaults = .standard) -> TimeInterval {
        stallSeconds(override: instanceId.flatMap { stored(instanceId: $0, defaults: defaults) })
    }

    static func requestSeconds(instanceId: String?, defaults: UserDefaults = .standard) -> TimeInterval {
        requestSeconds(override: instanceId.flatMap { stored(instanceId: $0, defaults: defaults) })
    }
}
