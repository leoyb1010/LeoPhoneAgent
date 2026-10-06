import ActivityKit
import Foundation
import UIKit
import UserNotifications

/// 关注工单运行变化时，系统界面需要的工单信息（来自工作区已加载的列表）。
struct PaperclipRunContext: Equatable, Sendable {
    let reference: PaperclipTaskReference
    let identifier: String
    let title: String
    let agentName: String
}

/// [G2/G5/G8] 工作区驱动的系统界面：灵动岛、完成通知、Spotlight 与后台保活窗口。
/// 工作区只经此协议调用，测试注入记录实现，不触碰 ActivityKit / 通知中心。
@MainActor
protocol PaperclipSystemSurfaces: AnyObject {
    func runChanged(_ change: PaperclipRunWatch.Change, context: PaperclipRunContext)
    /// 上次留下、仍显示为运行中的活动（App 重启后接回跟踪）。
    func activeRuns(profileID: UUID, companyID: String) -> [PaperclipRunWatch.Run]
    func index(_ issues: [PaperclipIssue], profileID: UUID)
    /// 退出登录 / 删除配置：清空该配置的 Spotlight 索引并结束它的实时活动。
    func clear(profileID: UUID)
    /// 关注的工单仍在运行时进入后台：申请系统允许的后台时间保持实时通道，到期回调后断开。
    func holdBackground(onExpire: @escaping @MainActor () -> Void)
    func releaseBackground()
}

@MainActor
final class PaperclipDeviceSurfaces: PaperclipSystemSurfaces {
    static let shared = PaperclipDeviceSurfaces()

    /// 与本机任务实时活动、任务通知同一组设置键，Paperclip 边界内只读。
    static var privacyMode: Bool { UserDefaults.standard.object(forKey: "liveActivityPrivacyMode") as? Bool ?? true }
    static var activitiesEnabled: Bool { UserDefaults.standard.object(forKey: "liveActivityEnabled") as? Bool ?? true }
    static var notificationsEnabled: Bool { UserDefaults.standard.object(forKey: "backgroundNotificationsEnabled") as? Bool ?? true }
    /// 同一工单阶段文字的推送间隔：灵动岛更新有系统预算，进度事件每秒可达数条。
    static let stageUpdateInterval: TimeInterval = 10

    private var lastStageUpdate: [String: Date] = [:]
    private var indexSignatures: [UUID: Int] = [:]
    private var clearedWhileDisabled: Set<UUID> = []
    private var backgroundTask: UIBackgroundTaskIdentifier = .invalid

    func runChanged(_ change: PaperclipRunWatch.Change, context: PaperclipRunContext) {
        updateActivity(change, context: context)
        if case .finished(let run) = change { notifyFinished(run, context: context) }
    }

    // MARK: 实时活动

    private func updateActivity(_ change: PaperclipRunWatch.Change, context: PaperclipRunContext) {
        guard Self.activitiesEnabled, ActivityAuthorizationInfo().areActivitiesEnabled else { return }
        let run = change.run
        let reference = context.reference
        let key = PaperclipActivityAttributes.issueKey(profileID: reference.profileID, companyID: reference.companyID, issueID: run.issueID)
        let all = Activity<PaperclipActivityAttributes>.activities
        let plan = PaperclipActivityDedupe.plan(existing: all.map {
            .init(id: $0.id, issueKey: $0.attributes.issueKey, isLive: $0.activityState == .active || $0.activityState == .stale)
        }, issueKey: key)
        let phase = PaperclipActivityAttributes.ContentState.Phase(runStatus: run.status)
        let reuse = plan.reuse.flatMap { id in all.first { $0.id == id } }
        // 终态但已没有可更新的活动：不新建，也不移除仍在保留期的旧卡片。
        if phase.isTerminal && reuse == nil { return }
        for id in plan.dismiss { Self.end(id, content: nil, policy: .immediate) }
        let privacy = Self.privacyMode
        let state = PaperclipActivityAttributes.ContentState(
            phase: phase, runID: run.runID, agentName: context.agentName,
            stage: privacy ? "" : (run.stage ?? ""), title: privacy ? "" : context.title,
            startedAt: run.startedAt ?? reuse?.content.state.startedAt ?? Date(),
            finishedAt: phase.isTerminal ? Date() : nil)
        if let reuse {
            if phase.isTerminal {
                lastStageUpdate[key] = nil
                let content = ActivityContent(state: state, staleDate: nil)
                let dismissal = Date().addingTimeInterval(PaperclipActivityAttributes.lingerAfterTerminal)
                Self.end(reuse.id, content: content, policy: .after(dismissal))
                return
            }
            let previous = reuse.content.state
            if previous.phase == state.phase, previous.runID == state.runID,
               let last = lastStageUpdate[key], Date().timeIntervalSince(last) < Self.stageUpdateInterval { return }
            lastStageUpdate[key] = Date()
            let content = ActivityContent(state: state, staleDate: Date().addingTimeInterval(PaperclipActivityAttributes.runningStaleAfter))
            let id = reuse.id
            Task.detached { await Self.activity(id)?.update(content) }
            return
        }
        guard let link = PaperclipDeepLink.url(issueID: run.issueID, companyID: reference.companyID) else { return }
        let attributes = PaperclipActivityAttributes(issueKey: key, issueID: run.issueID, identifier: context.identifier,
                                                     link: link.absoluteString)
        lastStageUpdate[key] = Date()
        _ = try? Activity.request(attributes: attributes,
                                  content: ActivityContent(state: state, staleDate: Date().addingTimeInterval(PaperclipActivityAttributes.runningStaleAfter)),
                                  pushType: nil)
    }

    /// 活动对象不是 Sendable：不跨隔离域传递，按编号在后台任务里重新取出再结束 / 更新。
    nonisolated private static func activity(_ id: String) -> Activity<PaperclipActivityAttributes>? {
        Activity<PaperclipActivityAttributes>.activities.first { $0.id == id }
    }

    nonisolated private static func end(_ id: String, content: ActivityContent<PaperclipActivityAttributes.ContentState>?,
                                        policy: ActivityUIDismissalPolicy) {
        Task.detached { await activity(id)?.end(content, dismissalPolicy: policy) }
    }

    func activeRuns(profileID: UUID, companyID: String) -> [PaperclipRunWatch.Run] {
        let prefix = PaperclipActivityAttributes.issueKey(profileID: profileID, companyID: companyID, issueID: "")
        return Activity<PaperclipActivityAttributes>.activities.compactMap { activity in
            let state = activity.content.state
            guard activity.activityState == .active || activity.activityState == .stale,
                  activity.attributes.issueKey.hasPrefix(prefix), !state.phase.isTerminal else { return nil }
            return PaperclipRunWatch.Run(issueID: activity.attributes.issueID, runID: state.runID,
                                         status: state.phase.rawValue, startedAt: state.startedAt)
        }
    }

    // MARK: 完成通知

    /// [G5] 本地通知：完成或失败（取消多半是你自己点的，不打扰）。点开走 G7 深链。
    private func notifyFinished(_ run: PaperclipRunWatch.Run, context: PaperclipRunContext) {
        let phase = PaperclipActivityAttributes.ContentState.Phase(runStatus: run.status)
        guard phase == .succeeded || phase == .failed, Self.notificationsEnabled,
              let link = PaperclipDeepLink.url(issueID: run.issueID, companyID: context.reference.companyID) else { return }
        let content = UNMutableNotificationContent()
        let name = context.identifier.isEmpty ? "服务器任务" : context.identifier
        content.title = "\(name) \(phase.label)"
        // 与本机任务通知同一隐私开关：开着时不显示工单标题。
        content.body = Self.privacyMode || context.title.isEmpty ? "打开 App 查看" : "「\(context.title)」\(context.agentName)\(phase == .succeeded ? "已完成这一轮处理" : "运行失败")"
        content.sound = .default
        content.threadIdentifier = "paperclip"
        content.userInfo = ["paperclipURL": link.absoluteString]
        let request = UNNotificationRequest(identifier: "paperclip.run." + run.runID, content: content, trigger: nil)
        UNUserNotificationCenter.current().add(request) { _ in }
    }

    // MARK: Spotlight

    func index(_ issues: [PaperclipIssue], profileID: UUID) {
        guard PaperclipSpotlightIndexer.isEnabled else {
            // 上次启动时索引过的条目也要清:indexSignatures 只记本次进程,不能拿它判断「有没有索引过」。
            if indexSignatures.removeValue(forKey: profileID) != nil || !clearedWhileDisabled.contains(profileID) {
                clearedWhileDisabled.insert(profileID)
                PaperclipSpotlightIndexer.clear(profileID: profileID)
            }
            return
        }
        clearedWhileDisabled.remove(profileID)
        let signature = PaperclipSpotlightIndexer.signature(issues)
        guard indexSignatures[profileID] != signature else { return }
        indexSignatures[profileID] = signature
        PaperclipSpotlightIndexer.index(issues, profileID: profileID)
    }

    func clear(profileID: UUID) {
        indexSignatures[profileID] = nil
        PaperclipSpotlightIndexer.clear(profileID: profileID)
        let prefix = PaperclipActivityAttributes.profilePrefix(profileID)
        for activity in Activity<PaperclipActivityAttributes>.activities where activity.attributes.issueKey.hasPrefix(prefix) {
            Self.end(activity.id, content: nil, policy: .immediate)
        }
    }

    // MARK: 后台时间

    func holdBackground(onExpire: @escaping @MainActor () -> Void) {
        guard backgroundTask == .invalid else { return }
        backgroundTask = UIApplication.shared.beginBackgroundTask(withName: "PaperclipLive") { [weak self] in
            MainActor.assumeIsolated {
                onExpire()
                self?.releaseBackground()
            }
        }
    }

    func releaseBackground() {
        guard backgroundTask != .invalid else { return }
        UIApplication.shared.endBackgroundTask(backgroundTask)
        backgroundTask = .invalid
    }
}
