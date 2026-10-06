import Foundation

/// [A2] 全自动对所有 Mac CLI 任务生效:Claude Code、Codex、Grok、LeoPhoneAgent 一视同仁。
/// 纯函数(编进 App 和 MinisTests):建任务请求体与后续消息里的 full_auto 怎么带、
/// Mac 不认这台 iPhone 时会话里说什么。
enum HarnessFullAuto {
    /// 是否请求全自动:开关开着,且这台 Mac 在本会话里没拒过。与 CLI 种类无关。
    static func wanted(gateOn: Bool, refused: Bool) -> Bool { gateOn && !refused }

    /// 建任务的请求体。全自动关着时不带 full_auto(Mac 默认就是「先问我」)。
    static func createPayload(harness: String, cwd: String, prompt: String?, thinking: String?,
                              fullAuto: Bool, phoneSessionId: String? = nil) -> [String: Any] {
        var payload: [String: Any] = ["harness": harness, "cwd": cwd]
        if let prompt, !prompt.isEmpty { payload["prompt"] = prompt }
        if let thinking, !thinking.isEmpty { payload["thinking"] = thinking }
        if fullAuto { payload["full_auto"] = true }
        if let phone = phoneSessionValue(phoneSessionId) { payload["phone_session_id"] = phone }
        return payload
    }

    /// [E5] 从手机对话里派的 Mac 任务带上那个对话的 id(中继只当不透明标签,≤200 字),
    /// 完成推送带回 `phoneSessionId`,点通知直达那个对话。不是从对话派的不带。
    static func phoneSessionValue(_ id: String?) -> String? {
        guard let trimmed = id?.trimmingCharacters(in: .whitespacesAndNewlines), !trimmed.isEmpty else { return nil }
        return String(trimmed.prefix(200))
    }

    /// 后续消息里的 full_auto。LeoPhoneAgent 任务照旧带 true/false;Claude Code / Codex / Grok 只在
    /// 请求全自动时带 true,否则不带 —— 旧版 Mac 桌面端对这三种 CLI 见到 full_auto 会回 400。
    /// 全自动中途关掉由 `POST /harness/full-auto {"enabled":false}` 统一切回。
    static func steerValue(harnessKey: String, gateOn: Bool, refused: Bool) -> Bool? {
        let want = wanted(gateOn: gateOn, refused: refused)
        if harnessKey == "zcode" { return want }
        return want ? true : nil
    }

    /// Mac 明确拒绝了全自动(可以去掉 full_auto 用新编号重发):403(认不出这台 iPhone),
    /// 或旧版 Mac 桌面端对 Claude Code / Codex / Grok 带 full_auto 回的 400。
    static func isRefusal(status: Int, harnessKey: String, requestedFullAuto: Bool) -> Bool {
        guard requestedFullAuto else { return false }
        return status == 403 || (status == 400 && harnessKey != "zcode")
    }

    /// [A1] `approval.responded` 带 `auto: true` 时的时间线摘要(工具 / 命令);不是自动应答返回 nil。
    static func autoApprovalSummary(_ event: [String: Any]) -> String? {
        guard event["auto"] as? Bool == true else { return nil }
        let parts = [event["tool"] as? String, event["command"] as? String]
            .compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
        return parts.isEmpty ? (event["choice"] as? String ?? "session") : String(parts.joined(separator: " · ").prefix(160))
    }

    /// [A3] 中继 0.2 之前认不出这台 iPhone 时的修复步骤;新中继会在 403 里自己带步骤。
    static let fallbackSteps = [
        "在运行中继的那台 Mac 上,把中继(relay.py)更新到 0.2 或更新版本并重启中继。",
        "在这台 Mac 上把 LeoBot(或 leoagent)更新到最新版,确认它重新连上了中继。",
        "回到手机点「恢复全自动」,或重发这个任务。",
    ]

    /// [A3] 403 回退时写进会话的说明:优先用 Mac 给的原因与步骤,没给就用本机的具体步骤。
    static func refusedNote(serverMessage: String?, status: Int = 403) -> String {
        if status == 400 {
            return "这台 Mac 上的 LeoBot 桌面端版本较旧,还不支持这个 CLI 的全自动,这次改为逐项审批。"
                + "把 Mac 上的 LeoBot 更新到最新版后,点「恢复全自动」或重发任务即可。"
        }
        let head = "这台 Mac 没认出这台 iPhone,全自动这次没生效,改为逐项审批。按下面做完即可恢复:"
        let server = serverMessage?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        // 新中继的 message 后面已附上编号步骤(见 LeoAgentClient.errorMessage)。
        if server.contains("\n1. ") { return head + "\n" + server }
        let steps = fallbackSteps.enumerated().map { "\($0.offset + 1). \($0.element)" }.joined(separator: "\n")
        return head + "\n" + steps
    }

    /// 网关错误信封里的 message,附上 Mac 给的修复步骤(有的话)。
    static func errorMessage(from envelope: [String: Any]) -> String? {
        guard let err = envelope["error"] as? [String: Any], let message = err["message"] as? String else {
            return envelope["message"] as? String
        }
        let steps = (err["steps"] as? [String] ?? []).filter { !$0.isEmpty }
        guard !steps.isEmpty else { return message }
        return message + "\n" + steps.enumerated().map { "\($0.offset + 1). \($0.element)" }.joined(separator: "\n")
    }
}
