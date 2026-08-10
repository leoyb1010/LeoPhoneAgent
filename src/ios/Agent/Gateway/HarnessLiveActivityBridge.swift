//
//  HarnessLiveActivityBridge.swift
//  MinisApp
//
//  [T-siri-fleet] Mac 任务上灵动岛/锁屏 Live Activity。
//
//  复用聊天任务的整套 Live Activity(AgentActivityAttributes +
//  AgentLiveActivityManager + 现成 widget UI)——把 harness 会话合成为
//  LiveSessionSnapshot 喂进去。
//
//  生命周期(ActivityKit 铁律:活动只能在前台创建,更新随时可以):
//  - driver 注册(此时必在前台)→ 立刻 start——锁屏/灵动岛马上有;
//  - 状态变化(审批到达/解决、回合结束)→ update,后台也合法;
//  - 没有活跃 driver → end。
//  聊天任务的 activity 在跑时不抢——它的管理者持续 update,插队只会互相
//  覆盖;聊天优先,Mac 任务等它结束后的下一次状态变化再上。
//

import Foundation
import UIKit

@MainActor
final class HarnessLiveActivityBridge {
    static let shared = HarnessLiveActivityBridge()

    private struct Entry {
        weak var driver: HarnessSessionDriver?
        let hostName: String
    }

    private var entries: [ObjectIdentifier: Entry] = [:]
    /// 只有这里拉起的 activity 才由这里结束,不碰聊天任务的。
    private var startedByBridge = false

    private init() {
        // 回到前台后补一次刷新:后台期间 end 掉聊天活动的话,Mac 任务
        // 需要一个前台时机才能 start(后台 start 会被系统拒)。
        NotificationCenter.default.addObserver(
            forName: UIApplication.didBecomeActiveNotification,
            object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.refresh() }
        }
    }

    func register(driver: HarnessSessionDriver, hostName: String?) {
        entries[ObjectIdentifier(driver)] = Entry(driver: driver, hostName: hostName ?? "Mac")
        // [T-liveactivity-filter] 关键:AgentLiveActivityManager 的
        // _startActivity/_updateActivity 都会按 SessionActivityTracker
        // .activeSessions 过滤传入的 snapshot。Mac 会话从不进那个集合,
        // 所以不登记的话喂进去的全被丢掉,灵动岛永远是空的。
        if let sid = driver.sessionId {
            SessionActivityTracker.shared.setActive(sid, source: "HarnessLiveActivityBridge")
        }
        refresh()
    }

    func unregister(driver: HarnessSessionDriver) {
        if let sid = driver.sessionId {
            SessionActivityTracker.shared.setInactive(sid, source: "HarnessLiveActivityBridge")
        }
        entries.removeValue(forKey: ObjectIdentifier(driver))
        refresh()
    }

    /// driver 状态变化时喊一声(update 在后台也合法,start 只在前台发生)。
    func refresh() {
        entries = entries.filter { $0.value.driver != nil }
        let snapshots: [LiveSessionSnapshot] = entries.values.compactMap { entry in
            guard let d = entry.driver, d.isRunning, let sid = d.sessionId else { return nil }
            let waiting = d.pendingApproval
            let status: String
            let icon: String
            if let waiting {
                status = "等你审批:\(String((waiting.command ?? "").prefix(40)))"
                icon = "hand.raised.fill"
            } else if d.status == "idle" {
                status = "已完成一轮,可继续下指令"
                icon = "checkmark.circle"
            } else {
                status = "运行中…"
                icon = "terminal.fill"
            }
            return LiveSessionSnapshot(
                sessionId: sid,
                title: "🖥 \(entry.hostName) · \(d.harness.name)",
                toolIcon: icon,
                toolStatus: status,
                loopIteration: 0)
        }
        if snapshots.isEmpty {
            if startedByBridge {
                AgentLiveActivityManager.shared.endActivity()
                startedByBridge = false
            }
            return
        }
        if startedByBridge && AgentLiveActivityManager.shared.hasLiveActivity {
            AgentLiveActivityManager.shared.updateActivity(sessions: snapshots)
        } else if startedByBridge {
            // 我们起的那个已经被别人(聊天任务)结束并接管了 —— 交还所有权,
            // 绝不能继续往它的卡上写,更不能在结束时把它掐掉。
            startedByBridge = false
        } else if !AgentLiveActivityManager.shared.hasLiveActivity {
            // start 仅前台合法;后台时跳过,didBecomeActive 会补。
            guard UIApplication.shared.applicationState != .background else { return }
            AgentLiveActivityManager.shared.startActivity(sessions: snapshots)
            startedByBridge = true
        }
        // 聊天 activity 在跑:什么都不做,让它先走。
    }
}
