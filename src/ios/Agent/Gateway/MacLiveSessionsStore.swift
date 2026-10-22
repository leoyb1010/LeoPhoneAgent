//
//  MacLiveSessionsStore.swift
//  MinisApp
//
//  [T-mac-in-main-list] 把 Mac 上进行中的会话摆到主列表顶部。
//
//  在这之前,想看一眼「我刚才让 Mac 干的活怎么样了」要走四步:
//  进设置 → Mac 控制台 → 等它扫描这台机器装了哪些 CLI → 点进会话。
//  藏得太深,而这恰恰是每天要看好几次的东西。
//
//  这里在后台轻量轮询三台 Mac,主界面顶部直接列出"正在跑/等审批"的
//  会话,点一下就进对话。没有 Mac、或都空闲时整节不出现,不占地方。
//

import Foundation
import SwiftUI

@MainActor
final class MacLiveSessionsStore: ObservableObject {
    static let shared = MacLiveSessionsStore()

    struct Row: Identifiable, Equatable {
        let hostId: String
        let hostName: String
        let session: HarnessSessionSummary
        var id: String { hostId + session.id }

        var isWaiting: Bool { session.waitingForApproval }
        var statusText: String {
            if session.waitingForApproval { return "等你审批" }
            switch session.status {
            case "running", "starting": return "运行中"
            case "idle": return "已完成一轮,可继续"
            default: return session.status
            }
        }

        /// [remote-ctl-power] 关注(nil = 旧版 Mac,按关注处理)。
        var isFollowed: Bool { MacFollowLogic.isFollowed(session.following) }

        var facts: MacFollowLogic.Facts {
            MacFollowLogic.Facts(hostId: hostId, sessionId: session.id, status: session.status, seq: session.seq,
                                 waiting: session.waitingForApproval, following: session.following,
                                 title: session.displayTitle, pendingApprovalId: session.pendingApprovalId,
                                 pendingApprovalCommand: session.pendingApprovalCommand)
        }

        /// 比显示、轮询、手表要用的全部事实:以前比的是会话类型名,改了标题、关注都不刷新。
        static func == (a: Row, b: Row) -> Bool {
            a.hostName == b.hostName && a.facts == b.facts
        }
    }

    /// Mac 上全部「进行中」的行(不论关注与否;Siri、深链、实时活动按会话查)。首页只列 `followedRows`。
    @Published private(set) var rows: [Row] = []
    /// 点了「停止」、Mac 还没报停下来的行:显示「正在停止…」。
    @Published private(set) var stopping: Set<String> = []

    /// 算「进行中」的状态。Mac 1.3.1 起,跑完半小时没动的任务报 available,不在其中。
    private static let liveStatuses: Set<String> = ["starting", "running", "idle", "waiting_for_approval"]

    /// 在这台设备上「清理」掉的行:行 id → 清理时的 seq。老版 Mac 不认 /archive,只能靠它在本机藏起来;
    /// 之后有新动静(seq 变了)、要审批或又跑起来,就重新出现。
    private var dismissed: [String: Int] = UserDefaults.standard.dictionary(forKey: MacLiveSessionsStore.dismissedKey) as? [String: Int] ?? [:]
    private static let dismissedKey = "macLive.dismissed.v1"

    private var pollTask: Task<Void, Never>?

    /// [remote-ctl-power] 最近一次列表里 Mac 明说「不关注」的会话 id(任何状态)。
    /// 补拉通知、实时活动据此跳过;不在里面的(没拉到、旧版 Mac)按关注处理。
    private(set) var unfollowedSessionIds: Set<String> = []
    /// 首页轮询推到手表的审批 id(控制台没开时也让手表能答);审批不在了就收卡。
    private var watchArmedApprovals: Set<String> = []
    /// 手表直接答过的审批(ponytail: 进程内只增,一天也就几条)。
    private var answeredApprovals: Set<String> = []

    /// 首页「进行中」:关注的会话。
    var followedRows: [Row] { MacFollowLogic.partition(rows, facts: \.facts).followed }
    /// 不关注、但在跑 / 等审批的桌面任务:首页只显示数量,点开再列。
    var unfollowedBusyRows: [Row] { MacFollowLogic.partition(rows, facts: \.facts).unfollowedBusy }

    func isKnownUnfollowed(sessionId: String) -> Bool { unfollowedSessionIds.contains(sessionId) }

    /// 轮询间隔:只在 App 在前台时跑(进后台 stop)。[remote-ctl-power] 有关注的任务在跑 / 等审批
    /// 才 20 秒一轮,否则 60 秒 —— 桌面上没关注的活不让手机勤快醒。
    var interval: TimeInterval { MacFollowLogic.pollInterval(rows.map(\.facts)) }

    private init() {}

    func start() {
        guard pollTask == nil else { return }
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                await self?.refresh()
                let seconds = self?.interval ?? MacFollowLogic.quietPollInterval
                try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
            }
        }
    }

    func stop() {
        pollTask?.cancel()
        pollTask = nil
    }

    /// Returns once `rows` is fresh. A caller that arrives mid-refresh waits for
    /// that one (it used to return at once, with the rows from before).
    func refresh() async {
        if let inFlight { return await inFlight.value }
        let load = Task { await self.load() }
        inFlight = load
        await load.value
        inFlight = nil
    }

    private var inFlight: Task<Void, Never>?

    private func load() async {
        let hosts = GatewayHostStore.shared.activeHosts
        guard !hosts.isEmpty else {
            if !rows.isEmpty { rows = [] }
            unfollowedSessionIds = []
            return
        }

        // 请求失败 ≠ 没有会话。网络抖动时保留该主机上一轮的行,
        // 否则整节一闪一闪;只有确认成功且为空才移除。
        var collected: [Row] = []
        var failedHosts: Set<String> = []
        /// 成功的主机列出的全部会话(任何状态):不再出现的,「已清理」记录随之删掉。
        var listed: Set<String> = []
        /// 成功的主机这次报的会话,以及其中明说不关注的。
        var fetchedSessionIds: Set<String> = []
        var unfollowedListed: Set<String> = []
        let store = GatewayHostStore.shared
        await withTaskGroup(of: (GatewayHost, Result<[HarnessSessionSummary], Error>).self) { group in
            for host in hosts {
                // [T-link-problem] 已确认要用户处理的问题(密钥被拒、Mac 撤销授权…):在用户点主按钮之前
                // 不再每 20 秒敲一次门。上一轮的行照旧保留(同下面的「请求失败 ≠ 没有会话」)。
                if store.isLinkPaused(host.id) { failedHosts.insert(host.id); continue }
                guard let client = store.client(for: host) else { continue }
                group.addTask {
                    do { return (host, .success(try await client.harnessSessions())) }
                    catch { return (host, .failure(error)) }
                }
            }
            for await (host, result) in group {
                let sessions: [HarnessSessionSummary]
                switch result {
                case .success(let fetched):
                    sessions = fetched
                    store.recordLinkProblem(nil, for: host.id)
                case .failure(let error):
                    failedHosts.insert(host.id)
                    // 只有「要用户处理」的问题才记下并暂停;瞬时失败沿用 20 秒一轮的节奏。
                    guard !LeoLinkProblem.isCancellation(error) else { continue }
                    let problem = LeoLinkProblem.from(
                        error: error, context: .init(.session, host: host.harnessBase?.host, machineName: host.name))
                    if problem.pausesAutoReconnect { store.recordLinkProblem(problem, for: host.id) }
                    continue
                }
                for session in sessions {
                    fetchedSessionIds.insert(session.id)
                    if session.following == false { unfollowedListed.insert(session.id) }
                    let row = Row(hostId: host.id, hostName: host.name, session: session)
                    listed.insert(row.id)
                    if Self.liveStatuses.contains(session.status), !isDismissed(row) { collected.append(row) }
                }
            }
        }
        collected.append(contentsOf: rows.filter { failedHosts.contains($0.hostId) })
        // 有主机没拉到:它的会话沿用上一轮的关注记录;都拉到了就以这一轮为准。
        unfollowedSessionIds = failedHosts.isEmpty ? unfollowedListed
            : unfollowedSessionIds.subtracting(fetchedSessionIds).union(unfollowedListed)
        if failedHosts.isEmpty, dismissed.keys.contains(where: { !listed.contains($0) }) {
            dismissed = dismissed.filter { listed.contains($0.key) }
            UserDefaults.standard.set(dismissed, forKey: Self.dismissedKey)
        }
        let busy = Set(collected.filter { $0.isWaiting || ["running", "starting"].contains($0.session.status) }.map(\.id))
        if !stopping.isSubset(of: busy) { stopping.formIntersection(busy) }
        // 等审批的排最前(要人拍板的最要紧),其余按 seq 新的在前
        collected.sort { a, b in
            if a.isWaiting != b.isWaiting { return a.isWaiting }
            return a.session.seq > b.session.seq
        }
        if collected != rows {
            let watchBefore = watchStatus.signature
            rows = collected
            // [WP-44] Mirror to the watch's Mac page / complications — [remote-ctl-power] only
            // when what the watch shows changed (unfollowed rows never reach it).
            if watchStatus.signature != watchBefore { WatchBridge.shared.pushStatus() }
        }
        syncWatchApprovals()
    }

    /// [WP-44] What the watch shows: counts plus the first few rows, waiting first.
    /// [remote-ctl-power] Followed sessions only, titled by the task title; waiting rows carry
    /// their approval so a tap on the wrist re-opens the card.
    var watchStatus: WatchMacStatus {
        let items = MacFollowLogic.watchItems(rows.map { (facts: $0.facts, statusText: $0.statusText) })
        return WatchMacStatus.summarize(approvals: items.map { item in
            (id: item.id, title: item.title, status: item.status, waiting: item.waiting, running: item.running,
             approvalId: item.approvalId, detail: item.detail,
             risk: item.detail.map { CommandRisk.assess($0).rawValue })
        })
    }

    /// [remote-ctl-power] 关注的会话等审批时,控制台没开也把审批卡推到手表(控制台开着时 driver 已推、
    /// 已登记处理者的不重复推);审批不在了就收卡。只在前台轮询时发生。
    private func syncWatchApprovals() {
        let pending = MacFollowLogic.watchApprovals(rows.map(\.facts))
        let current = Set(pending.compactMap(\.pendingApprovalId))
        for facts in pending {
            guard let approvalId = facts.pendingApprovalId, !watchArmedApprovals.contains(approvalId) else { continue }
            watchArmedApprovals.insert(approvalId)
            guard !WatchBridge.shared.hasApprovalHandler(approvalId: approvalId) else { continue }
            WatchBridge.shared.sendApprovalRequest(approvalId: approvalId, command: facts.pendingApprovalCommand,
                                                   reason: nil, choices: ["once", "deny"])
        }
        for gone in watchArmedApprovals.subtracting(current) {
            watchArmedApprovals.remove(gone)
            WatchBridge.shared.clearApprovalRequest(approvalId: gone)
        }
    }

    /// [remote-ctl-power] 手表答了一个审批、却没有控制台 driver 接:直接 POST 到那台 Mac
    /// (`/harness/sessions/:id/approval`)。冷启动时列表还是空的,先刷一次再找。返回是否送到。
    @discardableResult
    func answerApproval(approvalId: String, choice: String) async -> Bool {
        // 手表的回答可能从实时消息和排队通道各到一次:只送一次。
        guard answeredApprovals.insert(approvalId).inserted else { return false }
        if !rows.contains(where: { $0.session.pendingApprovalId == approvalId }) { await refresh() }
        // 列表里已经没有这条审批:别处答过了(或 Mac 已不在等),什么都不发。
        guard let row = rows.first(where: { $0.session.pendingApprovalId == approvalId }),
              let client = client(for: row.hostId) else { return false }
        do {
            try await client.approveHarness(sessionId: row.session.id, choice: choice, approvalId: approvalId)
        } catch {
            answeredApprovals.remove(approvalId)   // 没送到:下一次(排队通道)还能再试
            return false
        }
        HarnessApprovalNotifier.clear(sessionId: row.session.id, approvalId: approvalId)
        Task { await refresh() }
        return true
    }

    /// [remote-ctl-power] 「关注」一个桌面任务:之后它进「进行中」,推送、实时活动照常。
    /// 要 Mac 报 `follow` 能力;旧版 Mac 给一句原因。
    func follow(_ row: Row) async throws {
        guard let client = client(for: row.hostId) else { throw GatewayError.notConfigured }
        guard await client.harnessSupportsFollow() else {
            throw GatewayError.http(status: 404, message: AppLocalized("这台 Mac 还不支持关注，请先更新 Mac 端"))
        }
        try await client.setHarnessFollowing(sessionId: row.session.id, following: true)
        await refresh()
    }

    private func isDismissed(_ row: Row) -> Bool {
        row.session.status == "idle" && !row.isWaiting && dismissed[row.id] == row.session.seq
    }

    private func client(for hostId: String) -> LeoAgentClient? {
        guard let host = GatewayHostStore.shared.activeHosts.first(where: { $0.id == hostId }) else { return nil }
        return GatewayHostStore.shared.client(for: host)
    }

    /// 「清理」:先在这台设备上藏起来(立刻生效),再请 Mac 把它从列表里拿掉 ——
    /// Mac 1.3.1 起照做,iPad 上也跟着消失;老版 Mac 不认,就只在这台设备上藏着。
    func dismiss(_ row: Row) {
        dismissed[row.id] = row.session.seq
        UserDefaults.standard.set(dismissed, forKey: Self.dismissedKey)
        rows.removeAll { $0.id == row.id }
        guard let client = client(for: row.hostId) else { return }
        Task { try? await client.archiveHarness(sessionId: row.session.id) }
    }

    /// 「停止」:让 Mac 停下这一轮。停下后它不再算进行中;Mac 最迟 5 秒兜底报停,之后再刷一次。
    func stop(_ row: Row) async throws {
        guard let client = client(for: row.hostId) else { throw GatewayError.notConfigured }
        try await client.stopHarness(sessionId: row.session.id)
        stopping.insert(row.id)
        Task {
            for delay in [1.5, 5.0] {
                try? await Task.sleep(for: .seconds(delay))
                await refresh()
            }
        }
    }
}
