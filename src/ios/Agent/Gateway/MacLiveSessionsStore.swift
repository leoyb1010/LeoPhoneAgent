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
        }
    }

    @Published private(set) var rows: [Row] = []

    private var pollTask: Task<Void, Never>?
    private var refreshing = false

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

    func refresh() async {
        guard !refreshing else { return }
        let hosts = GatewayHostStore.shared.activeHosts
        guard !hosts.isEmpty else {
            if !rows.isEmpty { rows = [] }
            return
        }
        refreshing = true
        defer { refreshing = false }

        var collected: [Row] = []
        await withTaskGroup(of: [Row].self) { group in
            for host in hosts {
                guard let client = GatewayHostStore.shared.client(for: host) else { continue }
                group.addTask {
                    guard let sessions = try? await client.harnessSessions() else { return [] }
                    return sessions
                        .filter { ["starting", "running", "idle", "waiting_for_approval"].contains($0.status) }
                        .map { Row(hostId: host.id, hostName: host.name, session: $0) }
                }
            }
            for await batch in group { collected.append(contentsOf: batch) }
        }
        // 等审批的排最前(要人拍板的最要紧),其余按 seq 新的在前
        collected.sort { a, b in
            if a.isWaiting != b.isWaiting { return a.isWaiting }
            return a.session.seq > b.session.seq
        }
        if collected != rows { rows = collected }
    }
}
