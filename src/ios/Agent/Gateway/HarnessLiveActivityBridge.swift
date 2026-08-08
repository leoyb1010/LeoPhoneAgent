//
//  HarnessLiveActivityBridge.swift
//  MinisApp
//
//  [T-siri-fleet] Mac 任务上灵动岛/锁屏 Live Activity。
//
//  复用聊天任务的整套 Live Activity(AgentActivityAttributes +
//  AgentLiveActivityManager + 现成 widget UI)——只是把 harness 会话
//  合成为 LiveSessionSnapshot 喂进去。规则:
//  - app 退到后台且有 driver 正在跟随 Mac 会话 → start;
//  - 等审批时状态文案换成「等你审批:<命令>」(时效通知同时在响);
//  - 回到前台或没有活跃 driver → end(只结束我们自己拉起的,聊天任务
//    自己的 activity 由它原来的管理者负责——两边同时要,聊天优先)。
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
        let nc = NotificationCenter.default
        nc.addObserver(forName: UIApplication.didEnterBackgroundNotification,
                       object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.refresh() }
        }
        nc.addObserver(forName: UIApplication.willEnterForegroundNotification,
                       object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.endIfOurs() }
        }
    }

    func register(driver: HarnessSessionDriver, hostName: String?) {
        entries[ObjectIdentifier(driver)] = Entry(driver: driver, hostName: hostName ?? "Mac")
    }

    func unregister(driver: HarnessSessionDriver) {
        entries.removeValue(forKey: ObjectIdentifier(driver))
        refreshIfBackground()
    }

    /// driver 状态变化(审批到达/解决、回合结束)时喊一声。前台是 no-op。
    func refreshIfBackground() {
        guard UIApplication.shared.applicationState != .active else { return }
        refresh()
    }

    private func refresh() {
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
            endIfOurs()
            return
        }
        // 聊天任务的 activity 在跑就不抢——它的管理者会持续 update,
        // 我们插进去只会互相覆盖。
        if AgentLiveActivityManager.shared.hasLiveActivity && !startedByBridge { return }
        if startedByBridge {
            AgentLiveActivityManager.shared.updateActivity(sessions: snapshots)
        } else {
            AgentLiveActivityManager.shared.startActivity(sessions: snapshots)
            startedByBridge = true
        }
    }

    private func endIfOurs() {
        guard startedByBridge else { return }
        AgentLiveActivityManager.shared.endActivity()
        startedByBridge = false
    }
}
