//
//  AutomationRule.swift
//  MinisApp
//
//  [T-automation-engine] 规则模型,从 AutomationEngine.swift 拆出来,只依赖 Foundation,
//  逻辑测试能直接编译。
//
//  [D1] 新增外部信号触发 `.signal(name:)`(「记下此刻」动作、专注过滤器写进来的情境信号),
//  和档位 `tier`:0 只记录、1 准备不说话、2 说一句。旧规则 JSON 没有 tier,解码为 2,行为不变。
//

import Foundation

struct AutomationRule: Codable, Identifiable, Hashable {
    enum Trigger: Codable, Hashable {
        case arriveLocation(lat: Double, lon: Double, radius: Double, name: String)
        case leaveLocation(lat: Double, lon: Double, radius: Double, name: String)
        case beforeEvent(minutes: Int)
        case nightCharging
        /// [D1] 外部情境信号(到家、上车、开始专注……),由 NoteContextIntent / 专注过滤器送进来。
        case signal(name: String)

        var title: String {
            switch self {
            case .arriveLocation(_, _, _, let name): return String(localized: "Arriving at \(name)")
            case .leaveLocation(_, _, _, let name): return String(localized: "Leaving \(name)")
            case .beforeEvent(let minutes): return String(localized: "\(minutes) min before events")
            case .nightCharging: return String(localized: "Charging at night")
            case .signal(let name): return "情境信号:\(name)"
            }
        }

        /// 信号名是否命中这条触发器(忽略首尾空白和大小写)。
        func matchesSignal(_ incoming: String) -> Bool {
            guard case .signal(let name) = self else { return false }
            let a = name.trimmingCharacters(in: .whitespacesAndNewlines)
            let b = incoming.trimmingCharacters(in: .whitespacesAndNewlines)
            return !a.isEmpty && a.caseInsensitiveCompare(b) == .orderedSame
        }
    }

    /// [D1] 档位。
    enum Tier {
        static let logOnly = 0
        static let prepare = 1
        static let speak = 2
    }

    var id: String = UUID().uuidString.lowercased()
    var name: String
    var trigger: Trigger
    /// Quick task to run; mutually exclusive with `prompt`.
    var quickTaskId: String?
    /// Free-form agent prompt (used when quickTaskId is nil).
    var prompt: String?
    var isEnabled: Bool = true
    /// 👍/👎 confidence; at −3 the rule auto-disables.
    var score: Int = 0
    var lastFiredAt: Date?
    /// [D1] 0 只记录、1 准备不说话(跑但不通知)、2 说一句(跑完通知,旧行为)。
    var tier: Int = Tier.speak

    /// Debounce: one fire per rule per 30 minutes.
    func canFire(now: Date) -> Bool {
        guard isEnabled else { return false }
        if let last = lastFiredAt, now.timeIntervalSince(last) < 30 * 60 { return false }
        return true
    }
}

extension AutomationRule {
    /// 在扩展里实现,保留成员初始化器;旧 JSON 缺 tier 时取 2。
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = try c.decode(String.self, forKey: .name)
        trigger = try c.decode(Trigger.self, forKey: .trigger)
        quickTaskId = try c.decodeIfPresent(String.self, forKey: .quickTaskId)
        prompt = try c.decodeIfPresent(String.self, forKey: .prompt)
        isEnabled = try c.decodeIfPresent(Bool.self, forKey: .isEnabled) ?? true
        score = try c.decodeIfPresent(Int.self, forKey: .score) ?? 0
        lastFiredAt = try c.decodeIfPresent(Date.self, forKey: .lastFiredAt)
        tier = min(max(try c.decodeIfPresent(Int.self, forKey: .tier) ?? Tier.speak, Tier.logOnly), Tier.speak)
    }
}
