import Foundation

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
    var seq: Int { (raw["seq"] as? NSNumber)?.intValue ?? 0 }
    private var hasSeq: Bool { raw["seq"] is NSNumber }

    /// 幂等指纹:同一台机器同一会话同一 seq 只提示一次。没有 seq 的事件
    /// 用审批 id + 中继收到时间区分,否则同一会话的两条无 seq 事件会被
    /// 当成一条吞掉。
    var fingerprint: String {
        if hasSeq { return "\(machine)|\(sessionId ?? "")|\(eventName)|\(seq)" }
        return "\(machine)|\(sessionId ?? "")|\(eventName)|\(approvalId ?? "")|\(receivedAt)"
    }
}

/// [catch-up 审批元数据] 补拉审批通知要的字段,按中继暂存的原始 `approval.request` 恢复,
/// 与实时流 `GatewayEvent.parse` 同一口径(tool / description / 未建模字段进 extras,计划正文在 extras["plan"])。
/// 以前补拉一律写死 once/deny、tool/reason/extras 为空:计划审批会出成普通审批,只给 deny 的也多出「允许」。
struct RelayApprovalFields: Equatable {
    /// choices 从哪来:事件里给了(哪怕是空数组)、旧协议没有这个字段、字段在但不是数组。
    enum ChoicesSource: Equatable { case event, legacyDefault, malformed }

    let approvalId: String
    let sessionId: String
    /// 只含服务端原样给出的动作(拒绝首尾空白、去空、去重、保序)。显式空数组 / 坏格式 = 空,绝不补「允许」。
    let choices: [String]
    let choicesSource: ChoicesSource
    let command: String?
    let tool: String?
    let reason: String?
    let extras: [String: String]

    /// 仅为缺 choices 的旧协议保留实时流默认;不覆盖服务端显式提供的集合。
    static let legacyChoices = ["once", "deny"]

    /// 与 `GatewayEvent.parse` 的 `approval.request` 分支一致:这些键单独建模,其余原样进 extras。
    static let modelledKeys: Set<String> = ["event", "run_id", "timestamp", "choices", "command",
                                            "description", "approval_id", "seq", "session_id"]

    static func choices(from raw: Any?) -> (choices: [String], source: ChoicesSource) {
        guard let raw, !(raw is NSNull) else { return (legacyChoices, .legacyDefault) }
        guard let list = raw as? [Any] else { return ([], .malformed) }
        var seen = Set<String>()
        let cleaned = list.compactMap { $0 as? String }
            .filter { !$0.isEmpty && $0 == $0.trimmingCharacters(in: .whitespacesAndNewlines) && seen.insert($0).inserted }
        return (cleaned, .event)
    }
}

extension RelayEventItem {
    /// 不是审批请求、或缺会话 / 审批 id(通知按钮无从寻址)时为 nil。
    var approvalFields: RelayApprovalFields? {
        guard eventName == "approval.request",
              let sessionId, !sessionId.isEmpty,
              let approvalId, !approvalId.isEmpty else { return nil }
        let parsed = RelayApprovalFields.choices(from: raw["choices"])
        var extras: [String: String] = [:]
        for (key, value) in raw where !RelayApprovalFields.modelledKeys.contains(key) {
            extras[key] = String(describing: value)
        }
        return RelayApprovalFields(
            approvalId: approvalId, sessionId: sessionId,
            choices: parsed.choices, choicesSource: parsed.source,
            command: command,
            tool: (raw["tool"] as? String).flatMap { $0.isEmpty ? nil : $0 },
            reason: raw["description"] as? String,
            extras: extras)
    }
}

struct RelayEventPayload {
    let items: [RelayEventItem]
    let now: Double
}

/// 补拉的边界:一条时间写在未来的事件不能把游标推到年 3000(之后全部漏接),
/// 一次补拉不能把 10 万条 / 50 MB 全量解析再逐条发通知。
enum RelayCatchUpPolicy {
    /// 游标最多领先本机时钟这么多(容忍中继与手机的小幅时钟差)。
    static let maxFutureSkew: TimeInterval = 60
    /// 请求的条数上限,也是一次最多处理的条数(取最新的)。
    static let maxItems = 200
    /// 响应体上限。
    static let maxResponseBytes = 1_048_576
    /// 超过这么多条终态事件就合并成一条通知。
    static let maxIndividualNotices = 3

    struct ResponseTooLarge: Error {}

    /// 已被旧版本推到未来的游标先拉回现在,否则永远收不到新事件。
    static func repairedCursor(_ lastSeenAt: Double, now: Double) -> Double {
        guard lastSeenAt.isFinite, lastSeenAt >= 0 else { return 0 }
        return lastSeenAt > now + maxFutureSkew ? now : lastSeenAt
    }

    static func decode(_ data: Data) throws -> RelayEventPayload {
        guard data.count <= maxResponseBytes else { throw ResponseTooLarge() }
        let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
        let rows = obj["events"] as? [[String: Any]] ?? []
        let items = rows.compactMap { row -> RelayEventItem? in
            guard let event = row["event"] as? [String: Any] else { return nil }
            let received = (row["received_at"] as? NSNumber)?.doubleValue ?? 0
            return RelayEventItem(
                machine: String((row["machine"] as? String ?? "Mac").prefix(128)),
                receivedAt: received.isFinite ? received : 0,
                raw: event)
        }
        return RelayEventPayload(items: items, now: (obj["now"] as? NSNumber)?.doubleValue ?? 0)
    }

    struct Plan {
        /// 最新的至多 `maxItems` 条,按时间从旧到新。
        let items: [RelayEventItem]
        /// 新游标:看到的最大时间,但不超过 now + maxFutureSkew。
        let highWater: Double
        let droppedOlder: Int
    }

    static func plan(_ items: [RelayEventItem], lastSeenAt: Double, now: Double) -> Plan {
        let sorted = items.sorted { $0.receivedAt < $1.receivedAt }
        let kept = Array(sorted.suffix(maxItems))
        let seen = sorted.last.map { max(lastSeenAt, $0.receivedAt) } ?? lastSeenAt
        return Plan(items: kept,
                    highWater: min(seen, now + maxFutureSkew),
                    droppedOlder: sorted.count - kept.count)
    }
}
