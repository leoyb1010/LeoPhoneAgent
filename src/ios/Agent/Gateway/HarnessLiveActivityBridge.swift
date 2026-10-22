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
//  - [la-foreground] App 在前台(任一 LeoBot 窗口 active)时不起卡:人就在对话里,卡只会挡内容
//    (iPad 顶部横幅)。离开前台的那一刻(AgentLiveActivityManager.leaveForeground → refresh)
//    为关注且在跑的会话 start;以前是 driver 注册(打开控制台)就 start。
//  - 状态变化(审批到达/解决、回合结束)→ update,后台也合法;
//  - 回到前台 → 卡全部立即结束(含中继拉起的),update token 向中继注销;
//  - 没有活跃 driver → end。
//  [up-home] 离开控制台(driver detach)时任务还在 Mac 上跑:卡片不撤,改由
//  MacLiveSessionsStore 的轮询驱动(审批、运行中),Mac 报这一轮结束 / 会话不在了才结束卡片。
//  后台时轮询停了,卡片靠中继的 Live Activity 推送更新(WP-41)。
//  聊天任务的 activity 在跑时不抢——它的管理者持续 update,插队只会互相
//  覆盖;聊天优先,Mac 任务等它结束后的下一次状态变化再上。
//  [remote-ctl-power] 只给关注的会话上卡、要推送令牌(following == nil 的旧版 Mac 按关注);
//  打开一个没关注的桌面任务看看不起卡,在手机上发消息后 Mac 改成关注,卡随列表刷新补上。
//

import Combine
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

    /// 控制台已关、任务还在 Mac 上跑的会话(按会话 id)。
    private struct Detached {
        let hostId: String
        let hostName: String
        let harnessName: String
        /// 状态:running / waiting_for_approval / idle …,随 MacLiveSessionsStore 更新。
        var status: String
        var approvalCommand: String?
        /// 离开后至少看到一轮新的轮询才判断结束,免得拿离开前的旧行(还是 idle)当成已结束。
        var confirmed = false
    }
    private var detached: [String: Detached] = [:]
    private var rowsWatch: AnyCancellable?
    /// Mac sessions with a console on screen (a driver registers on appear and
    /// leaves on disappear). Read by the notification delegate, which isn't
    /// main-actor isolated; written on main only.
    nonisolated(unsafe) static var onScreenSessionIds: Set<String> = []
    /// 所有登记过的 Mac 会话(不论是否在跑)。它们进 SessionActivityTracker 只为了灵动岛;
    /// 本机保活(静音音频 / 定位)不该因为「屏幕上开着一个 Mac 控制台」而一直开着 ——
    /// 活在 Mac 上跑,审批靠中继推送。写只在主线程。
    nonisolated(unsafe) static var registeredSessionIds: Set<String> = []
    /// 只有这里拉起的 activity 才由这里结束,不碰聊天任务的。
    private var startedByBridge = false
    /// [remote-ctl-power] 这里登记进 tracker(会上卡、会要推送令牌)的会话:只有关注的。
    private var carded: Set<String> = []
    /// 上次为「不关注但在跑的控制台」补刷列表的时间(在手机上发了消息,Mac 会把它改成关注)。
    private var followProbeAt: Date = .distantPast

    /// [remote-ctl-power] 只给关注的会话上卡(nil / 列表里还没有 = 关注:手机上新建的、旧版 Mac 都照旧)。
    private func isFollowed(_ sid: String) -> Bool {
        !MacLiveSessionsStore.shared.isKnownUnfollowed(sessionId: sid)
    }

    /// 关注的进 tracker(灵动岛只认 tracker 里的会话);变成不关注就撤卡。
    private func setCarded(_ sid: String, _ on: Bool) {
        if on {
            guard carded.insert(sid).inserted else { return }
            SessionActivityTracker.shared.setActive(sid, source: "HarnessLiveActivityBridge")
        } else {
            guard carded.remove(sid) != nil else { return }
            SessionActivityTracker.shared.setInactive(sid, finalPhase: .suspended, haptic: false,
                                                      source: "HarnessLiveActivityBridge")
            AgentLiveActivityManager.shared.dropSession(sid)
        }
    }

    private init() {
        // 回到前台后补一次刷新:离开控制台的会话靠它重新对一次 Mac 的列表。
        // [la-foreground] 前台不起卡(refresh 里会跳过),卡在离开前台时起。
        NotificationCenter.default.addObserver(
            forName: UIApplication.didBecomeActiveNotification,
            object: nil, queue: .main) { [weak self] _ in
            // [up-perf-ios] 首帧之后再刷 Live Activity:didBecomeActive 里起的 Task 会排在回前台那一帧前面。
            LeoPerf.afterNextFrame {
                Task { @MainActor in
                    guard let self else { return }
                    self.refresh()
                    if !self.detached.isEmpty { await self.pollDetached() }
                }
            }
        }
        rowsWatch = MacLiveSessionsStore.shared.$rows
            .receive(on: RunLoop.main)
            .sink { [weak self] rows in
                Task { @MainActor in
                    guard let self else { return }
                    self.reconcileDetached(rows: rows, fresh: false)
                    // [remote-ctl-power] 关注变了(在手机上发了消息、点了「关注」)要跟着上卡 / 撤卡。
                    if !self.entries.isEmpty { self.refresh() }
                }
            }
    }

    /// 离开控制台后由谁继续盯:轮询照常的话(首页开着舰队)直接用它;否则自己补一次刷新。
    private func pollDetached() async {
        await MacLiveSessionsStore.shared.refresh()
        reconcileDetached(rows: MacLiveSessionsStore.shared.rows, fresh: true)
    }

    /// 按 Mac 的最新列表更新 / 结束已离开控制台的会话卡片。
    /// `fresh`:这份列表是离开之后拉的(sink 的第一次回调可能还是离开前的旧值)。
    private func reconcileDetached(rows: [MacLiveSessionsStore.Row], fresh: Bool) {
        guard !detached.isEmpty else { return }
        var changed = false
        for (sid, var item) in detached {
            let row = rows.first { $0.hostId == item.hostId && $0.session.id == sid }
            if fresh { item.confirmed = true }
            // [remote-ctl-power] 在桌面上取消了关注:Mac 不再推它,卡片也不留。
            if row?.isFollowed == false {
                detached.removeValue(forKey: sid)
                setCarded(sid, false)
                changed = true
                continue
            }
            if let row {
                item.status = row.isWaiting ? "waiting_for_approval" : row.session.status
                item.approvalCommand = row.session.pendingApprovalCommand
            }
            let ended = row == nil || (row?.session.status == "idle" && row?.isWaiting == false)
            if ended && item.confirmed {
                detached.removeValue(forKey: sid)
                carded.remove(sid)
                // 列表里没了:可能是跑完很久(available)、被停或失败,这里分不清,不给结论,只撤卡。
                if row == nil {
                    SessionActivityTracker.shared.setInactive(sid, finalPhase: .suspended, haptic: false,
                                                              source: "HarnessLiveActivityBridge")
                    AgentLiveActivityManager.shared.dropSession(sid)
                } else {
                    SessionActivityTracker.shared.setInactive(sid, finalPhase: .completed, haptic: false,
                                                              source: "HarnessLiveActivityBridge")
                }
            } else {
                detached[sid] = item
            }
            changed = true
        }
        if changed { refresh() }
    }

    /// 某个 Mac 会话属于哪台主机(深链只带会话 id 时用)。
    func hostId(forSessionId sid: String) -> String? {
        if let item = detached[sid] { return item.hostId }
        return entries.values.compactMap(\.driver).first { $0.sessionId == sid }?.macScreenClient.hostId
    }

    /// Live Activity "stop" for a Mac session: these have no view model, so
    /// the stop has to go to the Mac. Returns false if `sessionId` isn't one.
    /// Returns once the request has been made: an intent that returned first
    /// could have its process suspended before the request went out.
    @discardableResult
    func stop(sessionId: String) async -> Bool {
        guard let driver = entries.values.compactMap(\.driver).first(where: { $0.sessionId == sessionId }) else {
            // 控制台已关、卡片还在:直接让那台 Mac 停。
            guard let item = detached[sessionId],
                  let host = GatewayHostStore.shared.hosts.first(where: { $0.id == item.hostId }),
                  let client = GatewayHostStore.shared.client(for: host) else { return false }
            try? await client.stopHarness(sessionId: sessionId)
            detached.removeValue(forKey: sessionId)
            carded.remove(sessionId)
            SessionActivityTracker.shared.setInactive(sessionId, finalPhase: .cancelled, haptic: false,
                                                      source: "HarnessLiveActivityBridge")
            refresh()
            return true
        }
        await driver.stopAndWait()
        return true
    }

    func register(driver: HarnessSessionDriver, hostName: String?) {
        entries[ObjectIdentifier(driver)] = Entry(driver: driver, hostName: hostName ?? "Mac")
        // 重新打开了控制台:交回 driver 驱动。
        if let sid = driver.sessionId { detached.removeValue(forKey: sid) }
        // [T-liveactivity-filter] 关键:AgentLiveActivityManager 的
        // _startActivity/_updateActivity 都会按 SessionActivityTracker
        // .activeSessions 过滤传入的 snapshot。Mac 会话从不进那个集合,
        // 所以不登记的话喂进去的全被丢掉,灵动岛永远是空的。
        // [remote-ctl-power] 只登记关注的:打开一个没关注的桌面任务看看,不起卡、不要推送令牌。
        if let sid = driver.sessionId {
            if isFollowed(sid) {
                carded.insert(sid)
                SessionActivityTracker.shared.setActive(sid, source: "HarnessLiveActivityBridge")
            } else {
                setCarded(sid, false)
            }
        }
        // [WP-44] Most recently opened Mac task = the share sheet's "发给 Mac 当前任务".
        driver.publishShareTarget(hostName: hostName ?? "Mac")
        refresh()
    }

    func unregister(driver: HarnessSessionDriver) {
        if let sid = driver.sessionId {
            // [T-la-honest-outcome] A round the Mac finished rests as done, a stop
            // as stopped; leaving the screen mid-run is "paused here", not stopped —
            // the Mac keeps going and reopening picks it back up.
            let phase: AgentActivityPhase
            switch driver.status {
            case "idle": phase = driver.lastTurnFailed ? .failed : .completed
            case "completed": phase = .completed
            case "cancelled": phase = .cancelled
            case "failed": phase = .failed
            default: phase = .suspended
            }
            // [up-home] 还在 Mac 上跑(包括等审批):卡片留着,交给 MacLiveSessionsStore 驱动,
            // 跑完才结束(见 reconcileDetached)。以前一离开控制台卡片就没了。
            // [remote-ctl-power] 没关注的没上过卡,离开就离开,不留卡。
            if phase == .suspended, driver.isRunning, carded.contains(sid), let hostId = driver.macScreenClient.hostId {
                let entry = entries[ObjectIdentifier(driver)]
                detached[sid] = Detached(hostId: hostId, hostName: entry?.hostName ?? "Mac",
                                         harnessName: driver.harness.name, status: driver.status,
                                         approvalCommand: driver.pendingApproval?.command)
                entries.removeValue(forKey: ObjectIdentifier(driver))
                refresh()
                Task { await pollDetached() }
                return
            }
            carded.remove(sid)
            SessionActivityTracker.shared.setInactive(sid, finalPhase: phase, haptic: false,
                                                      source: "HarnessLiveActivityBridge")
            // [T-la-false-failure] Still running on the Mac; only this phone stopped
            // following. No resting verdict (it rested as "needs attention"): the
            // session just leaves the card. Reopening the console registers it again.
            if phase == .suspended { AgentLiveActivityManager.shared.dropSession(sid) }
        }
        entries.removeValue(forKey: ObjectIdentifier(driver))
        refresh()
    }

    /// driver 状态变化时喊一声(update 在后台也合法;start 只在离开前台的那一刻发生 [la-foreground])。
    func refresh() {
        entries = entries.filter { $0.value.driver != nil }
        Self.registeredSessionIds = Set(entries.values.compactMap { $0.driver?.sessionId })
            .union(detached.keys)
        // Only consoles still following: one that gave up reconnecting shows no
        // card, so its approvals must still banner.
        Self.onScreenSessionIds = Set(entries.values.compactMap { entry in
            entry.driver.flatMap { $0.isRunning ? $0.sessionId : nil }
        })
        // [remote-ctl-power] 关注随列表变:变成关注就上卡,变成不关注就撤卡。
        var watchingUnfollowedRun = false
        for entry in entries.values {
            guard let d = entry.driver, let sid = d.sessionId else { continue }
            let followed = isFollowed(sid)
            setCarded(sid, followed)
            if !followed, d.status == "running" { watchingUnfollowedRun = true }
        }
        // 开着一个没关注的桌面任务、它跑起来了:多半是在手机上发了消息(Mac 随即把它改成关注)。
        // 补刷一次列表,卡片不用等下一轮 60 s 的轮询;最多 15 s 一次。
        if watchingUnfollowedRun, Date().timeIntervalSince(followProbeAt) > 15 {
            followProbeAt = Date()
            Task { await MacLiveSessionsStore.shared.refresh() }
        }
        let detachedSnapshots: [LiveSessionSnapshot] = detached.map { sid, item in
            let waiting = item.status == "waiting_for_approval"
            return snapshot(sid: sid, title: "🖥 \(item.hostName) · \(item.harnessName)", waiting: waiting,
                            command: item.approvalCommand, idle: item.status == "idle")
        }
        let snapshots: [LiveSessionSnapshot] = detachedSnapshots + entries.values.compactMap { entry in
            guard let d = entry.driver, d.isRunning, let sid = d.sessionId, carded.contains(sid) else { return nil }
            let waiting = d.pendingApproval
            return snapshot(sid: sid, title: "🖥 \(entry.hostName) · \(d.harness.name)", waiting: waiting != nil,
                            command: waiting?.command, idle: d.status == "idle")
        }
        if snapshots.isEmpty {
            if startedByBridge {
                AgentLiveActivityManager.shared.endActivity()
                startedByBridge = false
            }
            return
        }
        let manager = AgentLiveActivityManager.shared
        // [la-foreground] 前台不要卡:管理者在场景激活时已把所有卡收掉,这里只交还所有权。
        // 离开前台时 leaveForeground 再调 refresh,那时 start。
        let presence = LiveActivityPresencePolicy.decide(
            appActive: manager.isAppInForeground, taskRunning: true, followed: true,
            enabled: MacFollowLogic.liveActivityEnabled(), existingActivity: startedByBridge && manager.hasLiveActivity)
        if presence == .none || presence == .endImmediately {
            if presence == .endImmediately { manager.endActivity() }
            startedByBridge = false
            return
        }
        // 聊天任务在跑(tracker 里有不是 Mac 会话的):它的卡优先,不插队。
        let chatRunning = !SessionActivityTracker.shared.activeSessions.subtracting(Self.registeredSessionIds).isEmpty
        if startedByBridge && manager.hasLiveActivity {
            // hasLiveActivity 也算中继拉起的卡:我们的本地卡没了、只剩中继卡时 update 会重起本地卡并
            // 收掉中继卡(_startActivity 清旧卡)——同一个会话只留一张。
            manager.updateActivity(sessions: snapshots)
        } else if startedByBridge {
            // 我们起的那个已经被别人(聊天任务)结束并接管了 —— 交还所有权,
            // 绝不能继续往它的卡上写,更不能在结束时把它掐掉。
            startedByBridge = false
        } else if !chatRunning, !snapshots.contains(where: { manager.hasActivity(forSessionId: $0.sessionId) }) {
            // 按会话判断:中继已为这个会话拉起卡就不再另起一张(以前看 hasLiveActivity,
            // 中继卡在屏时 App 回前台会再起一张本地卡,锁屏上两张)。
            // start 仅在离开前台的那一刻合法(还没进后台);后台时跳过,中继的 push-to-start 兜底。
            guard UIApplication.shared.applicationState != .background else { return }
            // [WP-41] Mac 任务卡带 update token:App 被挂起/杀掉后,中继照样能推审批与完成。
            manager.startActivity(sessions: snapshots, remotePush: true)
            startedByBridge = true
        }
        // 聊天 activity 在跑:什么都不做,让它先走。
    }

    private func snapshot(sid: String, title: String, waiting: Bool, command: String?, idle: Bool) -> LiveSessionSnapshot {
        // The keep-alive timer rebuilds the card from the tracker every 10 s: give
        // it the same title and "waiting for you", or it paints over the approval
        // (and the next push here would buzz for the same approval again).
        SessionActivityTracker.shared.updateSessionTitle(sid, title: title)
        SessionActivityTracker.shared.updateActivityPhase(sid, phase: waiting ? .waitingForPermission : .usingTool)
        let status: String
        let icon: String
        if waiting {
            status = "等你审批:\(String((command ?? "").prefix(40)))"
            icon = LiveSessionSnapshot.approvalIcon
        } else if idle {
            status = "已完成一轮,可继续下指令"
            icon = "checkmark.circle"
        } else {
            status = "运行中…"
            icon = "terminal.fill"
        }
        return LiveSessionSnapshot(sessionId: sid, title: title, toolIcon: icon, toolStatus: status, loopIteration: 0)
    }
}
