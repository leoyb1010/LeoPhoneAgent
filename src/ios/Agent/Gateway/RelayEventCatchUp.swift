//
//  RelayEventCatchUp.swift
//  MinisApp
//
//  [T-leophone-push] 回到前台时补齐"我不在的时候 Mac 上发生了什么"。
//
//  为什么需要它:harness 的 SSE 是拉取式的——手机没连着的时候,那条流
//  根本不存在,事件只躺在 Mac 本地的 NDJSON 里。所以 app 被杀掉/切走
//  期间,Mac 上的审批请求对用户完全不可见,任务就那么挂着。
//
//  leocodebox 现在把关键事件(审批请求、任务终态)主动外推给中继,中继
//  留一份最近事件。这里在 app 回到前台时拉一次:有待审批就发本地通知
//  (复用现有可交互按钮),有任务结束就提示一声。
//
//  与推送(APNs)的关系:这是不依赖推送资格的第一层,现在就能用;
//  将来接上 APNs 后,那条路负责"app 没运行时也能响",这条路继续负责
//  "回到前台时对账",两者互补且都按 seq 幂等。
//

import Foundation
import UIKit
import UserNotifications

@MainActor
final class RelayEventCatchUp {
    static let shared = RelayEventCatchUp()

    private var lastSeenAt: Double {
        get { UserDefaults.standard.double(forKey: "leo.relay.events.lastSeenAt") }
        set { UserDefaults.standard.set(newValue, forKey: "leo.relay.events.lastSeenAt") }
    }

    /// 已经提示过的事件指纹,防止同一条重复打扰(中继可能重发)。
    private var notified = Set<String>()
    private var inFlight = false

    private init() {
        NotificationCenter.default.addObserver(
            forName: UIApplication.didBecomeActiveNotification,
            object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in await self?.catchUp() }
        }
    }

    /// 启动时调一次即可(注册前台观察者)。
    func activate() {}

    func catchUp() async {
        guard !inFlight else { return }
        guard let host = GatewayHostStore.shared.activeHosts.first,
              let client = GatewayHostStore.shared.client(for: host) else { return }
        inFlight = true
        defer { inFlight = false }

        guard let payload = try? await client.relayEvents(after: lastSeenAt) else { return }
        guard !payload.items.isEmpty else {
            lastSeenAt = max(lastSeenAt, payload.now)
            return
        }

        for item in payload.items {
            let fingerprint = item.fingerprint
            guard !notified.contains(fingerprint) else { continue }
            notified.insert(fingerprint)
            switch item.eventName {
            case "approval.request":
                postApproval(item, hostName: item.machine)
            case "run.failed":
                postSimple(title: "🖥 \(item.machine) 任务失败", body: item.text ?? "")
            case "run.completed":
                postSimple(title: "✅ \(item.machine) 任务完成", body: item.text ?? "")
            default:
                break
            }
        }
        lastSeenAt = max(lastSeenAt, payload.now)
        if notified.count > 400 { notified.removeAll() }
    }

    private func postApproval(_ item: RelayEventItem, hostName: String) {
        // 前台时 app 内的会话卡片已经会显示,不重复打扰
        guard UIApplication.shared.applicationState != .active else { return }
        guard let sessionId = item.sessionId, let approvalId = item.approvalId else { return }
        let hostId = GatewayHostStore.shared.activeHosts
            .first { $0.name == hostName }?.id
        let approval = GatewayApprovalRequest(
            approvalId: approvalId, runId: sessionId,
            choices: ["once", "deny"], command: item.command,
            tool: nil, reason: nil, extras: [:])
        HarnessApprovalNotifier.post(hostId: hostId, hostName: hostName,
                                     sessionId: sessionId, approval: approval)
    }

    private func postSimple(title: String, body: String) {
        guard UIApplication.shared.applicationState != .active else { return }
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = String(body.prefix(120))
        content.sound = .default
        UNUserNotificationCenter.current().add(
            UNNotificationRequest(identifier: "relay-\(UUID().uuidString)",
                                  content: content, trigger: nil))
    }
}

// MARK: - 中继事件模型

struct RelayEventItem {
    let machine: String
    let receivedAt: Double
    let raw: [String: Any]

    var eventName: String { raw["event"] as? String ?? "" }
    var sessionId: String? { raw["session_id"] as? String }
    var approvalId: String? { raw["approval_id"] as? String ?? raw["request_id"] as? String }
    var command: String? { raw["command"] as? String }
    var text: String? { raw["error"] as? String ?? raw["output"] as? String }
    var seq: Int { raw["seq"] as? Int ?? 0 }

    /// 幂等指纹:同一台机器同一会话同一 seq 只提示一次。
    var fingerprint: String { "\(machine)|\(sessionId ?? "")|\(eventName)|\(seq)" }
}

struct RelayEventPayload {
    let items: [RelayEventItem]
    let now: Double
}

extension LeoAgentClient {
    /// 中继事件端点的绝对地址。
    ///
    /// 主机地址形如 `https://host/leoagent-relay/relay/api/m/<机器名>`,
    /// 事件端点是同一中继下的 `/relay/api/events`。用字符串回退两级
    /// 不可靠(URL 不做 `..` 归一),所以按 "/m/" 切一刀取中继根。
    /// 不是中继模式(直连某台 Mac)时返回 nil —— 那种拓扑没有中继事件。
    nonisolated var relayEventsURL: URL? {
        guard let harnessBase = harnessBaseURLForRelay else { return nil }
        let full = harnessBase.absoluteString
        guard let range = full.range(of: "/m/", options: .backwards) else { return nil }
        return URL(string: String(full[full.startIndex..<range.lowerBound]) + "/events")
    }

    /// 取中继上暂存的关键事件。`after` 是上次看到的时间水位。
    func relayEvents(after: Double) async throws -> RelayEventPayload {
        guard let base = relayEventsURL,
              var parts = URLComponents(url: base, resolvingAgainstBaseURL: false) else {
            return RelayEventPayload(items: [], now: 0)
        }
        parts.queryItems = [URLQueryItem(name: "after", value: String(after))]
        guard let url = parts.url else { return RelayEventPayload(items: [], now: 0) }
        var req = URLRequest(url: url)
        req.setValue("Bearer \(apiKeyForRelay)", forHTTPHeaderField: "Authorization")
        req.timeoutInterval = 20
        let (data, response) = try await session.data(for: req)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            return RelayEventPayload(items: [], now: 0)
        }
        let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
        let rows = obj["events"] as? [[String: Any]] ?? []
        let items = rows.compactMap { row -> RelayEventItem? in
            guard let event = row["event"] as? [String: Any] else { return nil }
            return RelayEventItem(
                machine: row["machine"] as? String ?? "Mac",
                receivedAt: row["received_at"] as? Double ?? 0,
                raw: event)
        }
        return RelayEventPayload(items: items, now: obj["now"] as? Double ?? 0)
    }
}
