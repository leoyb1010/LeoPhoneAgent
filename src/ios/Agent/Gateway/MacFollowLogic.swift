//
//  MacFollowLogic.swift
//  MinisApp
//
//  [remote-ctl-power] 「关注」省电的纯逻辑(App 与逻辑测试目标共用,只依赖 Foundation)。
//
//  契约见 src/mac/leophone/docs/specs/leo-link-remote-controls.md「关注（省电）」:
//  - Mac 只为关注的会话推送;iOS 首页「进行中」只列关注的,其余折成一行数量;
//  - 有关注的任务在跑 / 等审批才每 20 s 轮询,否则 60 s;
//  - 只给关注的会话起实时活动、要推送令牌;不关注的会话不发本地通知;
//  - 补拉的本地通知用和中继 APNs 相同的标识,同一件事只留一条。
//  旧版 Mac 不报 following(nil):一律按关注处理,行为与以前一致。
//

import Foundation

enum MacFollowLogic {
    /// 一行会话里与显示、轮询、推送有关的事实。`MacLiveSessionsStore.Row` 的相等也按它比。
    struct Facts: Equatable {
        var hostId: String
        var sessionId: String
        var status: String
        var seq: Int
        var waiting: Bool
        var following: Bool?
        /// 显示标题(有任务标题用标题,否则会话类型名)。
        var title: String
        var pendingApprovalId: String?
        var pendingApprovalCommand: String?

        var isFollowed: Bool { MacFollowLogic.isFollowed(following) }
        var isRunning: Bool { ["running", "starting"].contains(status) }
        /// 在跑或等审批:要人关心的状态。
        var isBusy: Bool { waiting || isRunning }
    }

    /// nil = 旧版 Mac 不报 → 按关注处理。
    static func isFollowed(_ following: Bool?) -> Bool { following != false }

    // MARK: 首页「进行中」

    /// 关注的全部列出;不关注的只留在跑 / 等审批的(桌面上闲着的任务不打扰),折成一行数量。
    static func partition<T>(_ items: [T], facts: (T) -> Facts) -> (followed: [T], unfollowedBusy: [T]) {
        var followed: [T] = []
        var unfollowed: [T] = []
        for item in items {
            let f = facts(item)
            if f.isFollowed { followed.append(item) } else if f.isBusy { unfollowed.append(item) }
        }
        return (followed, unfollowed)
    }

    // MARK: 自适应轮询

    static let activePollInterval: TimeInterval = 20
    static let quietPollInterval: TimeInterval = 60

    /// 有关注的任务在跑或等审批:20 s;否则 60 s(桌面上别人的活不让手机勤快醒)。
    static func pollInterval(_ facts: [Facts]) -> TimeInterval {
        facts.contains { $0.isFollowed && $0.isBusy } ? activePollInterval : quietPollInterval
    }

    // MARK: 补拉通知

    /// APNs 的 apns-collapse-id 最多 64 字节,中继按 `collapse_id[:64]` 截断;本地通知标识跟着截,才对得上。
    static let collapseIdLimit = 64

    /// 补拉本地通知的标识,与中继 `_push_apns` 的 collapse id 同形:
    /// `run.completed-<sid>`、`approval.request-<approval_id 或 sid>`。run.failed 中继不推,同法给个稳定 id。
    /// 定时任务用 `MacAutomationLogic.runNotificationId`。不认识的事件返回 nil。
    static func catchUpNotificationId(event: String, sessionId: String?, approvalId: String?) -> String? {
        let sid = sessionId ?? ""
        let raw: String
        switch event {
        case "run.completed", "run.failed":
            raw = "\(event)-\(sid)"
        case "approval.request":
            let key = (approvalId?.isEmpty == false ? approvalId : nil) ?? sid
            raw = "\(event)-\(key)"
        default:
            return nil
        }
        return String(raw.prefix(collapseIdLimit))
    }

    /// 已知不关注的会话的补拉事件不发通知(Mac 本就不为它推送;这里兜住切换前排进中继的旧事件)。
    /// 不认识的会话(列表还没拉到、旧版 Mac)照常提示。
    static func skipsCatchUp(sessionId: String?, unfollowed: Set<String>) -> Bool {
        guard let sessionId, !sessionId.isEmpty else { return false }
        return unfollowed.contains(sessionId)
    }

    // MARK: push-to-start

    static let liveActivityEnabledKey = "liveActivityEnabled"

    /// 设置里的「Live Activity」开关(默认开,与 AgentLiveActivityManager 同一口径)。
    static func liveActivityEnabled(_ defaults: UserDefaults = .standard) -> Bool {
        (defaults.object(forKey: liveActivityEnabledKey) as? Bool) ?? true
    }

    /// 开关关着就不把 push-to-start token 交给中继:否则中继照样为每个任务远程拉起卡片、叫醒手机。
    static func shouldRegisterPushToStart(liveActivityEnabled: Bool, supported: Bool) -> Bool {
        liveActivityEnabled && supported
    }

    // MARK: 手表

    struct WatchItem: Equatable {
        var id: String
        var title: String
        var status: String
        var waiting: Bool
        var running: Bool
        /// 等审批的行带上审批 id 与命令,手表点这一行就能重开审批卡。
        var approvalId: String?
        var detail: String?
    }

    /// 只给手表关注的会话;标题用任务标题,不用会话类型名。
    static func watchItems(_ rows: [(facts: Facts, statusText: String)]) -> [WatchItem] {
        rows.filter { $0.facts.isFollowed }.map { row in
            let f = row.facts
            return WatchItem(id: f.hostId + f.sessionId, title: f.title, status: row.statusText,
                             waiting: f.waiting, running: f.isRunning,
                             approvalId: f.waiting ? f.pendingApprovalId : nil,
                             detail: f.waiting ? f.pendingApprovalCommand : nil)
        }
    }

    /// 首页轮询给手表推的审批:关注的、等审批且带审批 id 的会话。
    static func watchApprovals(_ facts: [Facts]) -> [Facts] {
        facts.filter { $0.isFollowed && $0.waiting && ($0.pendingApprovalId?.isEmpty == false) }
    }
}
