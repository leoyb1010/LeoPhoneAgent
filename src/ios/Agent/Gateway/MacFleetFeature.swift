//
//  MacFleetFeature.swift
//  MinisApp
//
//  [F-mac-fleet-advanced] Mac 舰队改为高级功能，默认关闭。
//
//  有了 Paperclip 服务器任务后，Mac 舰队很少用到：首页「Mac 进行中」、Mac 控制台入口、
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

    /// 默认 false：没打开过就是关。
    static func isEnabled(_ defaults: UserDefaults = .standard) -> Bool {
        defaults.bool(forKey: defaultsKey)
    }
}
