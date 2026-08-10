//
//  HarnessApprovalNotifier.swift
//  MinisApp
//
//  [T-siri-approval-notify] Mac 任务审批 → 可交互本地通知。
//
//  以前审批只活在 app 内的卡片和手表上;app 一旦退到后台,审批请求
//  对用户是不可见的(任务就此挂住)。现在:
//  - app 非前台时收到 approval.request → 发时效性通知,带「批准一次/拒绝」
//    按钮,锁屏/横幅/CarPlay/AirPods 播报直达;
//  - 按钮回调不开 app,直接经中继把决定送回那台 Mac;
//  - 审批被任何端解决(手机/手表/桌面)→ 撤回对应通知,不留死卡。
//
//  安全:批准按钮要求设备已解锁(authenticationRequired)——审批放行的
//  是 shell 命令,锁屏上任何人可按是不可接受的。拒绝不受限。
//

import Foundation
import UIKit
import UserNotifications

enum HarnessApprovalNotifier {
    static let categoryId = "HARNESS_APPROVAL"
    static let approveAction = "HARNESS_APPROVE_ONCE"
    static let denyAction = "HARNESS_DENY"

    /// 与 BACKGROUND_TASK 一起注册(setNotificationCategories 是整体替换,
    /// 谁单独 set 谁就把别人的按钮抹掉——两处调用都必须用这份并集)。
    static var category: UNNotificationCategory {
        let approve = UNNotificationAction(
            identifier: approveAction,
            title: String(localized: "批准一次"),
            options: [.authenticationRequired])
        let deny = UNNotificationAction(
            identifier: denyAction,
            title: String(localized: "拒绝"),
            options: [.destructive])
        return UNNotificationCategory(
            identifier: categoryId,
            actions: [approve, deny],
            intentIdentifiers: [])
    }

    /// app 非前台时为一条审批请求发通知。前台不发(app 内卡片已在最前)。
    @MainActor
    static func post(hostId: String?, hostName: String?, sessionId: String,
                     approval: GatewayApprovalRequest) {
        guard UIApplication.shared.applicationState != .active else { return }
        let content = UNMutableNotificationContent()
        content.title = "🖥 \(hostName ?? "Mac") 等你审批"
        content.body = String((approval.command ?? "").prefix(120))
        content.sound = .default
        content.categoryIdentifier = categoryId
        if #available(iOS 15.0, *) {
            // 时效性:锁屏置顶 + AirPods「Siri 播报通知」可念出来
            content.interruptionLevel = .timeSensitive
        }
        content.userInfo = [
            "harnessApproval": true,
            "hostId": hostId ?? "",
            "harnessSessionId": sessionId,
            "approvalId": approval.approvalId,
        ]
        let request = UNNotificationRequest(
            identifier: notificationId(sessionId: sessionId, approvalId: approval.approvalId),
            content: content,
            trigger: nil)
        UNUserNotificationCenter.current().add(request)
    }

    /// 审批已被任何一端解决:撤掉横幅与通知中心里的卡。
    static func clear(sessionId: String, approvalId: String) {
        let id = notificationId(sessionId: sessionId, approvalId: approvalId)
        let center = UNUserNotificationCenter.current()
        center.removeDeliveredNotifications(withIdentifiers: [id])
        center.removePendingNotificationRequests(withIdentifiers: [id])
    }

    private static func notificationId(sessionId: String, approvalId: String) -> String {
        "harness-approval-\(sessionId)-\(approvalId)"
    }

    /// 通知按钮回调:重建 client,把决定送回中继。返回是否已处理该响应。
    /// 在 ShortcutNotificationDelegate.didReceive 里调用。
    static func handle(response: UNNotificationResponse,
                       completion: @escaping () -> Void) -> Bool {
        let info = response.notification.request.content.userInfo
        guard info["harnessApproval"] as? Bool == true,
              let sessionId = info["harnessSessionId"] as? String,
              let approvalId = info["approvalId"] as? String else { return false }
        let hostId = info["hostId"] as? String ?? ""

        let choice: String?
        switch response.actionIdentifier {
        case approveAction: choice = "once"
        case denyAction: choice = "deny"
        default: choice = nil   // 点通知本体 → 只打开 app,不代作决定
        }
        guard let choice else { return false }

        // APNs 路径的推送里只有 machine(机器名),没有 hostId ——
        // 只按 id 精确匹配的话,锁屏按「批准一次」什么都不会发生,
        // Mac 上的任务永远挂着。逐级回退:id → 名字全等 → 名字包含 →
        // 唯一主机兜底(与 catch-up 路径同一套解析)。
        let machine = info["machine"] as? String ?? ""
        Task { @MainActor in
            defer { completion() }
            let hosts = GatewayHostStore.shared.hosts
            let host = hosts.first { $0.id == hostId }
                ?? hosts.first { !machine.isEmpty && $0.name == machine }
                ?? hosts.first { !machine.isEmpty
                    && (machine.contains($0.name) || $0.name.contains(machine)) }
                ?? (hosts.count == 1 ? hosts.first : nil)
            guard let host, let client = GatewayHostStore.shared.client(for: host) else { return }
            try? await client.approveHarness(sessionId: sessionId, choice: choice,
                                             approvalId: approvalId)
        }
        return true
    }
}
