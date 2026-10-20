//
//  MacFleetFeature.swift
//  MinisApp
//
//  [F-mac-fleet-advanced] Mac 舰队改为高级功能，默认关闭。
//  [up-home] 没设过开关时：配对过 Mac 就算开（见 isEnabled）。
//
//  Mac 舰队是默认关闭的高级功能：首页「Mac 进行中」、Mac 控制台入口、
//  /mac、回复下一步「发到 Mac」、Siri 的 Mac 说法都跟着这个开关隐藏。什么都不删，
//  到 设置 → 远程机器 打开后一切照旧。
//
//  不受影响（不要往这些地方加判断）：审批推送与通知、中继补拉、手表审批、灵动岛、
//  配对、藏宝阁、Grok 登录、Sync V2 tailnet、remote_agent、全自动关 Mac。
//  单独成文件：MacLiveSessionsStore 不在逻辑测试目标里，这里要能被测到。
//

import Foundation

enum MacFleetFeature {
    static let defaultsKey = "macFleet.enabled"

    /// 关闭时 Siri / 快捷指令里 Mac 动作的回复。
    static let disabledMessage = "Mac 舰队已关闭，到 设置 → 远程机器 打开"

    /// 用户显式设过（开或关）就按用户的；从没设过时，配对过任何一台 Mac 就算开，否则关。
    /// [up-home] 以前一律默认关：配好了 Mac 首页却什么都不显示，要去设置里再找开关。
    /// 判定为开时顺手写回 true：各处 `@AppStorage(defaultsKey)` 读的是存储值，不写回它们仍显示关。
    @discardableResult
    static func isEnabled(_ defaults: UserDefaults = .standard) -> Bool {
        if let explicit = defaults.object(forKey: defaultsKey) as? Bool { return explicit }
        guard hasPairedMac(defaults) else { return false }
        defaults.set(true, forKey: defaultsKey)
        return true
    }

    /// GatewayHostStore 存的主机里有没有 Mac（Android 机身不算）。直接读 UserDefaults：
    /// 这里可能在非主线程（Siri 意图）被调用，不能碰 @MainActor 的 GatewayHostStore。
    static func hasPairedMac(_ defaults: UserDefaults = .standard) -> Bool {
        guard let data = defaults.data(forKey: hostsKey),
              let rows = (try? JSONSerialization.jsonObject(with: data)) as? [[String: Any]] else { return false }
        return rows.contains { $0["platform"] as? String != "android" && $0["server"] as? String != "minis" }
    }

    /// 与 GatewayHostStore.storageKey 相同（那边是 @MainActor，这里取不到它的静态常量）。
    static let hostsKey = "leo.gatewayHosts.v1"
}

/// [up-home] 首页「在哪里执行」的记忆：冷启动恢复上次选的机器 + CLI + 目录。
struct HomeMacDispatchTarget: Codable, Equatable {
    var hostId: String
    var cliKey: String
    var cliName: String
    /// nil = Mac 上的主目录（~）。
    var cwd: String? = nil

    static let defaultsKey = "home.executionTarget.v1"

    static func load(_ defaults: UserDefaults = .standard) -> HomeMacDispatchTarget? {
        defaults.data(forKey: defaultsKey).flatMap { try? JSONDecoder().decode(Self.self, from: $0) }
    }

    /// nil = 此 iPhone（清掉记忆）。
    static func save(_ target: HomeMacDispatchTarget?, _ defaults: UserDefaults = .standard) {
        if let target, let data = try? JSONEncoder().encode(target) {
            defaults.set(data, forKey: defaultsKey)
        } else {
            defaults.removeObject(forKey: defaultsKey)
        }
    }

    /// 记住的机器已删掉 / 停用：回落「此 iPhone」（返回 nil）。
    static func restore(_ saved: HomeMacDispatchTarget?, availableHostIds: [String]) -> HomeMacDispatchTarget? {
        guard let saved, availableHostIds.contains(saved.hostId) else { return nil }
        return saved
    }

    /// 「最近目录」：按给定顺序（新的在前）去重，丢掉空串和主目录，最多 6 个。
    static func recentDirectories(_ cwds: [String], limit: Int = 6) -> [String] {
        var seen = Set<String>()
        var out: [String] = []
        for raw in cwds {
            let cwd = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !cwd.isEmpty, cwd != "~", cwd != "~/", seen.insert(cwd).inserted else { continue }
            out.append(cwd)
            if out.count == limit { break }
        }
        return out
    }

    /// 目录的短名（胶囊上显示）：最后一段。
    static func shortName(_ cwd: String) -> String {
        let trimmed = cwd.hasSuffix("/") ? String(cwd.dropLast()) : cwd
        return trimmed.split(separator: "/").last.map(String.init) ?? cwd
    }
}
