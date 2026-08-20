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
        let approvalId = (info["approvalId"] as? String) ?? (info["approval_id"] as? String)
        let hintedSession = (info["harnessSessionId"] as? String)
            ?? (info["session_id"] as? String)
            ?? (info["sessionId"] as? String)
        let hostId = info["hostId"] as? String ?? ""
        let machine = (info["machine"] as? String) ?? ""
        let isHarness = (info["harnessApproval"] as? Bool) == true
            || approvalId != nil && !machine.isEmpty
        guard isHarness, let approvalId, !approvalId.isEmpty else { return false }

        let choice: String?
        switch response.actionIdentifier {
        case approveAction: choice = "once"
        case denyAction: choice = "deny"
        default: choice = nil   // 点通知本体 → 只打开 app,不代作决定
        }
        guard let choice else { return false }

        // APNs 路径的推送里往往只有 machine + approval_id,没有 session_id。
        // 逐级补齐,顺序刻意如此:
        //   1. payload 里带了就直接用(中继以后补上 session_id 时零成本生效);
        //   2. 内存里的 MacLiveSessionsStore —— 只有 app 已经在跑并拉过列表时才有;
        //   3. **现场向该主机拉一次 /harness/sessions** 。
        //
        // 第 3 步是这条路径能不能用的关键。APNs 审批要覆盖的场景恰恰是「app 没在
        // 运行」:锁屏点「批准一次」时进程是被系统冷起来处理这一次 action 的,
        // MacLiveSessionsStore 必然是空的。只查内存 store 的写法在冷启动下会直接
        // 走 `guard let sessionId else { return }` 静默返回 —— 看起来修了、实际
        // 和没修一样。这里用一次真实网络查询把 approvalId 反查成 sessionId;
        // 通知 action 的后台执行窗口(~30s)足够跑完一个 JSON 请求。
        Task { @MainActor in
            defer { completion() }
            let host = GatewayHostStore.shared.hostMatching(hostId: hostId, machine: machine)
                ?? (GatewayHostStore.shared.hosts.count == 1 ? GatewayHostStore.shared.hosts.first : nil)
            guard let host, let client = GatewayHostStore.shared.client(for: host) else { return }
            var sessionId = hintedSession.flatMap { $0.isEmpty ? nil : $0 }
                ?? MacLiveSessionsStore.shared.rows.first(where: {
                    $0.hostId == host.id && $0.session.pendingApprovalId == approvalId
                })?.session.id
            if sessionId == nil, let live = try? await client.harnessSessions() {
                sessionId = live.first(where: { $0.pendingApprovalId == approvalId })?.id
                    // 中继只报「有一条在等」而没给 approval_id 时的兜底:
                    // 全机只有一个 waiting 会话就按它寻址,多于一个则宁可不猜。
                    ?? {
                        let waiting = live.filter(\.waitingForApproval)
                        return waiting.count == 1 ? waiting[0].id : nil
                    }()
            }
            guard let sessionId else { return }
            try? await client.approveHarness(sessionId: sessionId, choice: choice,
                                             approvalId: approvalId)
            HarnessApprovalNotifier.clear(sessionId: sessionId, approvalId: approvalId)
        }
        return true
    }
}
