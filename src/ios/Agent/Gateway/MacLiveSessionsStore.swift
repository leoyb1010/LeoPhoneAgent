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

        static func == (a: Row, b: Row) -> Bool {
            a.id == b.id && a.session.status == b.session.status
                && a.session.seq == b.session.seq
                && a.session.waitingForApproval == b.session.waitingForApproval
                && a.session.name == b.session.name
                && a.session.pendingApprovalCommand == b.session.pendingApprovalCommand
        }
    }

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

    /// 轮询间隔:主界面可见时才跑。20 秒足够"知道有没有事",
    /// 又不会把电池和流量当消耗品。
    private let interval: TimeInterval = 20

    private init() {}

    func start() {
        guard pollTask == nil else { return }
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                await self?.refresh()
                try? await Task.sleep(nanoseconds: UInt64((self?.interval ?? 20) * 1_000_000_000))
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
            return
        }

        // 请求失败 ≠ 没有会话。网络抖动时保留该主机上一轮的行,
        // 否则整节一闪一闪;只有确认成功且为空才移除。
        var collected: [Row] = []
        var failedHosts: Set<String> = []
        /// 成功的主机列出的全部会话(任何状态):不再出现的,「已清理」记录随之删掉。
        var listed: Set<String> = []
        await withTaskGroup(of: (GatewayHost, [HarnessSessionSummary]?).self) { group in
            for host in hosts {
                guard let client = GatewayHostStore.shared.client(for: host) else { continue }
                group.addTask { (host, try? await client.harnessSessions()) }
            }
            for await (host, sessions) in group {
                guard let sessions else { failedHosts.insert(host.id); continue }
                for session in sessions {
                    let row = Row(hostId: host.id, hostName: host.name, session: session)
                    listed.insert(row.id)
                    if Self.liveStatuses.contains(session.status), !isDismissed(row) { collected.append(row) }
                }
            }
        }
        collected.append(contentsOf: rows.filter { failedHosts.contains($0.hostId) })
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
        if collected != rows { rows = collected }
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
