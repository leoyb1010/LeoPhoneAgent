//
//  LiveActivityRemotePush.swift
//  MinisApp
//
//  WP-41:Live Activity 远程推送的 App 侧纯逻辑(App 与逻辑测试共用)。
//
//  - `SingleFlightCoalescer`:ActivityKit 更新「单飞 + 可替换下一值」。同一时刻只有一个
//    `activity.update` 在路上;期间来的新状态不排队,只替换「下一个」—— 每次都是完整
//    content-state,中间态丢了无所谓,最后一个一定落地,也不会出现旧状态晚到覆盖新状态。
//    (写法参考 OpenClaw ActivityWidget 的节流;原来的 Task 链会把每一帧都排队补发。)
//  - `LiveActivityTokenRegistration`:把一张卡的 update token 连同卡上的会话登记到中继
//    (kind = activity_update),中继据此对这张卡发 update / end。
//

import Foundation

@MainActor
final class SingleFlightCoalescer<Value> {
    private var inFlight = false
    private var pending: Value?
    private var idleWaiters: [CheckedContinuation<Void, Never>] = []
    private let merge: @MainActor (Value, Value) -> Value
    private let perform: @MainActor (Value) async -> Void

    /// - Parameter merge: 把被替换掉的待发值并进新值(例如保留旧值里的提醒)。默认新值直接覆盖。
    init(merge: @escaping @MainActor (Value, Value) -> Value = { _, new in new },
         perform: @escaping @MainActor (Value) async -> Void) {
        self.merge = merge
        self.perform = perform
    }

    /// 没有在路上的更新就立刻发;否则只记下「下一个」,覆盖之前没来得及发的那个。
    func submit(_ value: Value) {
        if inFlight {
            pending = pending.map { merge($0, value) } ?? value
            return
        }
        inFlight = true
        Task { await drain(value) }
    }

    var isIdle: Bool { !inFlight }

    /// 等在路上的和排着的都发完(收尾的「已完成」状态必须排在它们后面)。
    func waitUntilIdle() async {
        guard inFlight else { return }
        await withCheckedContinuation { idleWaiters.append($0) }
    }

    private func drain(_ first: Value) async {
        var next: Value? = first
        while let current = next {
            await perform(current)
            next = pending
            pending = nil
        }
        inFlight = false
        let waiters = idleWaiters
        idleWaiters = []
        waiters.forEach { $0.resume() }
    }
}

enum LiveActivityTokenRegistration {
    /// 一个 update token 最多带多少个会话(与中继 MAX_SESSIONS_PER_TOKEN 一致)。
    static let maxSessions = 8
    /// Mac 任务卡的标题前缀(`HarnessLiveActivityBridge`):只有这类标题会发给中继。
    static let macTitlePrefix = "🖥 "

    /// 中继 `/relay/api/device` 的登记载荷;卡上没有会话时返回 nil(没法路由,登记也没用)。
    /// 隐私:聊天会话的标题来自用户内容,只发 id;Mac 任务标题是「🖥 主机 · harness」,
    /// 隐私模式下也不发。
    static func payload(token: String, sessions: [LiveSessionSnapshot], privacyMode: Bool,
                        bundleId: String, environment: String) -> [String: Any]? {
        var seen = Set<String>()
        let rows = sessions.filter { !$0.sessionId.isEmpty && seen.insert($0.sessionId).inserted }
            .prefix(maxSessions)
        guard !rows.isEmpty, !token.isEmpty else { return nil }
        let described: [[String: String]] = rows.map { row in
            var item = ["session_id": row.sessionId]
            if !privacyMode, row.title.hasPrefix(macTitlePrefix) { item["title"] = row.title }
            return item
        }
        return [
            "kind": "activity_update",
            "token": token,
            "bundle_id": bundleId,
            "environment": environment,
            "session_ids": rows.map(\.sessionId),
            "sessions": described,
        ]
    }

    /// 卡上的会话集合变了才需要重新登记(同一个 token)。
    static func sessionKey(_ sessions: [LiveSessionSnapshot]) -> Set<String> {
        Set(sessions.prefix(maxSessions).map(\.sessionId).filter { !$0.isEmpty })
    }

    static func hex(_ data: Data) -> String {
        data.map { String(format: "%02x", $0) }.joined()
    }
}
