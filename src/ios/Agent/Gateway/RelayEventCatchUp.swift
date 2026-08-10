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
final class RelayEventCatchUp: ObservableObject {
    static let shared = RelayEventCatchUp()

    private var lastSeenAt: Double {
        get { UserDefaults.standard.double(forKey: "leo.relay.events.lastSeenAt") }
        set { UserDefaults.standard.set(newValue, forKey: "leo.relay.events.lastSeenAt") }
    }

    /// 已经提示过的事件指纹,防止同一条重复打扰(中继可能重发)。
    /// 用数组保序,超限淘汰最旧的(全清会瞬间失去去重记忆)。
    private var notified: [String] = []
    private var notifiedSet = Set<String>()
    private var inFlight = false

    /// [T-catchup-surface] 前台时错过的待审批。app 在最前时发系统通知是
    /// 无效动作(用户正看着 app),所以前台走这个已发布属性,由界面显示
    /// 横幅;后台/非活跃才发通知。
    @Published private(set) var missedApprovals: [RelayEventItem] = []

    func clearMissedApprovals() { missedApprovals = [] }

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
        // 首台可能是直连 Mac(没有中继地址),不能只看它 —— 取第一台
        // 真正能解析出中继地址的主机。
        let client = GatewayHostStore.shared.activeHosts
            .compactMap { GatewayHostStore.shared.client(for: $0) }
            .first { $0.relayEventsURL != nil }
        guard let client else { return }
        inFlight = true
        defer { inFlight = false }

        guard let payload = try? await client.relayEvents(after: lastSeenAt) else { return }
        guard !payload.items.isEmpty else {
            // 空结果也推进水位,但只推进到"本批已看到的最大时间",
            // 不用服务端的 now —— 查询快照与读 now 之间写入的事件
            // 会被永久跳过。
            return
        }

        var approvals: [RelayEventItem] = []
        var highWater = lastSeenAt
        for item in payload.items {
            highWater = max(highWater, item.receivedAt)
            let fingerprint = item.fingerprint
            guard !notifiedSet.contains(fingerprint) else { continue }
            remember(fingerprint)
            switch item.eventName {
            case "approval.request":
                approvals.append(item)
                postApproval(item, hostName: item.machine)
            case "run.failed":
                postSimple(title: "🖥 \(item.machine) 任务失败", body: item.text ?? "")
            case "run.completed":
                postSimple(title: "✅ \(item.machine) 任务完成", body: item.text ?? "")
            default:
                break
            }
        }
        // 前台时通知发不出去(系统会压掉),改由界面显示这批待审批。
        if !approvals.isEmpty {
            missedApprovals = approvals
        }
        lastSeenAt = highWater
    }

    private func remember(_ fingerprint: String) {
        notified.append(fingerprint)
        notifiedSet.insert(fingerprint)
        while notified.count > 400 {
            notifiedSet.remove(notified.removeFirst())
        }
    }

    private func postApproval(_ item: RelayEventItem, hostName: String) {
        guard let sessionId = item.sessionId, let approvalId = item.approvalId else { return }
        // [T-catchup-hostid] 中继报的 machine 名与用户在「我的 Mac」里自取的
        // 名字未必一致;精确匹配失败就退到"唯一一台中继主机",再退到首台。
        // 匹配不上会导致通知按钮回调找不到 host,批准静默失败。
        let hosts = GatewayHostStore.shared.activeHosts
        let hostId = (hosts.first { $0.name == hostName }
            ?? hosts.first { hostName.contains($0.name) || $0.name.contains(hostName) }
            ?? hosts.first)?.id
        let approval = GatewayApprovalRequest(
            approvalId: approvalId, runId: sessionId,
            choices: ["once", "deny"], command: item.command,
            tool: nil, reason: nil, extras: [:])
        HarnessApprovalNotifier.post(hostId: hostId, hostName: hostName,
                                     sessionId: sessionId, approval: approval)
    }

    private func postSimple(title: String, body: String) {
        // 前台不发终态提示(用户正看着 app),审批则不受此限——它要人拍板。
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
    /// [T-collections-fleet] 把收藏索引上传到中继,好让 Mac 端能查。
    ///
    /// 只传"给人看的"字段:标题、链接、来源、摘要、标签、时间。附件与
    /// 正文留在手机沙盒里不外传 —— Mac 上要的是"我收藏过什么",
    /// 不是把手机的私有文件复制一份出去。
    func uploadCollections(_ items: [CollectedItem]) async {
        guard let eventsURL = relayEventsURL,
              let url = URL(string: eventsURL.absoluteString
                  .replacingOccurrences(of: "/events", with: "/collections")) else { return }
        let payload: [String: Any] = [
            "items": items.prefix(500).map { item in
                [
                    "id": item.id,
                    "kind": item.kind.rawValue,
                    "title": item.title ?? "",
                    "url": item.kind == .link ? (item.resolvedURL ?? item.value) : "",
                    "source": item.sourceLabel,
                    "summary": item.summary ?? "",
                    "tags": item.tags,
                    "created_at": item.createdAt.timeIntervalSince1970,
                ] as [String: Any]
            },
        ]
        var req = URLRequest(url: url)
        req.httpMethod = "PUT"
        req.setValue("Bearer \(apiKeyForRelay)", forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try? JSONSerialization.data(withJSONObject: payload)
        req.timeoutInterval = 25
        _ = try? await session.data(for: req)
    }

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
        guard let http = response as? HTTPURLResponse else {
            throw GatewayError.malformedResponse("not an HTTP response")
        }
        if http.statusCode == 401 || http.statusCode == 403 { throw GatewayError.unauthorized }
        guard (200..<300).contains(http.statusCode) else {
            throw GatewayError.http(status: http.statusCode, message: nil)
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
