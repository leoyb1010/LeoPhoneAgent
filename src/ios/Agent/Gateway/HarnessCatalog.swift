import Foundation

/// 一种可以在 Mac 上开的任务（LeoBot 自己，或经 ACP 跑的外部 CLI）。
///
/// [fix-remote] 列表完全以 Mac 的 `/v1/capabilities` 为准：不按已知 key 过滤（opencode、gemini、grok
/// 以及以后新增的都照单全收），装不上的也列出来，带 Mac 给的原因灰显。
struct HarnessKind: Sendable, Identifiable, Hashable, Codable {
    let key: String
    let name: String
    /// Mac 说这台机器上能不能开（旧版 Mac 不报 = 能）。
    var available: Bool = true
    var unavailableReason: String? = nil
    var version: String? = nil
    var cliPath: String? = nil
    /// [fix-remote] Mac 判断的登录状态（true / false / nil = 判断不了或旧版 Mac 不报）与登录方式。
    var loggedIn: Bool? = nil
    var loginKind: String? = nil
    var id: String { key }

    init(key: String, name: String, available: Bool = true, unavailableReason: String? = nil,
         version: String? = nil, cliPath: String? = nil, loggedIn: Bool? = nil, loginKind: String? = nil) {
        self.key = key
        self.name = name
        self.available = available
        self.unavailableReason = unavailableReason
        self.version = version
        self.cliPath = cliPath
        self.loggedIn = loggedIn
        self.loginKind = loginKind
    }

    /// 可以在手机上登录（Mac 支持远程登录、这个 agent 能用）。未登录时界面突出「登录」。
    var canLogin: Bool { available && loginKind != nil }

    /// 显示名：Mac 给了就用 Mac 的，常见的几个统一写法。
    var displayName: String { HarnessCatalog.displayName(key: key, fallback: name) }
    var symbol: String { HarnessCatalog.symbol(key: key) }

    /// 灰显时的说明（Mac 的原因原样给，太长截断）。
    var statusLine: String? {
        if !available { return unavailableReason ?? "这台 Mac 上用不了" }
        return version
    }
}

enum HarnessCatalog {
    private static let names: [String: String] = [
        "zcode": "LeoBot", "minis": "LeoBot",
        "claude": "Claude Code", "codex": "Codex", "gemini": "Gemini",
        "opencode": "opencode", "grok": "Grok",
    ]

    static func displayName(key: String, fallback: String) -> String {
        names[key] ?? (fallback.isEmpty ? key : fallback)
    }

    static func symbol(key: String) -> String {
        switch key {
        case "zcode", "minis": return "sparkles"
        case "claude": return "asterisk"
        case "codex": return "chevron.left.forwardslash.chevron.right"
        case "gemini": return "diamond"
        case "opencode": return "curlybraces"
        case "grok": return "bolt"
        default: return "terminal"
        }
    }

    /// `/v1/capabilities` 的 harnesses 数组 → 选项，顺序与 Mac 一致；key 原样保留（建会话时原样发回）。
    static func parse(_ rows: [[String: Any]]) -> [HarnessKind] {
        var seen = Set<String>()
        return rows.compactMap { row in
            guard let key = row["key"] as? String, !key.isEmpty, seen.insert(key).inserted else { return nil }
            let reason = (row["unavailable_reason"] as? String).flatMap { $0.isEmpty ? nil : $0 }
            return HarnessKind(
                key: key,
                name: (row["name"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? key,
                available: row["available"] as? Bool ?? true,
                unavailableReason: reason.map { String($0.prefix(300)) },
                version: (row["version"] as? String).flatMap { $0.isEmpty ? nil : String($0.prefix(80)) },
                cliPath: row["cli_path"] as? String,
                loggedIn: (row["auth"] as? [String: Any])?["logged_in"] as? Bool,
                loginKind: (row["auth"] as? [String: Any])?["login_kind"] as? String)
        }
    }

    /// 对话框「指挥 Mac」的菜单：有这台 Mac 上次报的列表就只列能用的（全部原样，不过滤 key）；
    /// 还没联系过时退回旧的默认几项，免得菜单是空的。
    static func menuOptions(known: [HarnessKind]?, runsLeoPhoneAgent: Bool, isAndroidBody: Bool) -> [(String, String)] {
        if isAndroidBody { return [("minis", "LeoBot")] }
        if let known, !known.isEmpty {
            return known.filter(\.available).map { ($0.key, $0.displayName) }
        }
        let clis = [("claude", "Claude Code"), ("codex", "Codex"), ("grok", "Grok")]
        return runsLeoPhoneAgent ? [("zcode", "LeoBot")] + clis : clis
    }
}

/// [fix-remote] Mac 上一个外部 agent 的登录流程（`/agents/<key>/login`）。
struct AgentLoginFlow: Equatable, Sendable {
    enum Status: String, Sendable {
        case starting, waitingForUser = "waiting_for_user", verifying, succeeded, failed, cancelled
    }
    let flowId: String
    let status: Status
    let url: URL?
    let userCode: String?
    let needsCode: Bool
    /// "auth_code"（Claude：网页给的授权码）或 "api_key"（Gemini / opencode）。
    let codeKind: String?
    let message: String?

    var isFinished: Bool { [.succeeded, .failed, .cancelled].contains(status) }

    static func parse(_ obj: [String: Any]) -> AgentLoginFlow? {
        guard let id = obj["flow_id"] as? String, !id.isEmpty,
              let status = Status(rawValue: obj["status"] as? String ?? "") else { return nil }
        // 只打开 https 网址（授权页 / 设备码页 / 取 API key 的页面）。
        let url = (obj["url"] as? String).flatMap(URL.init(string:)).flatMap { $0.scheme == "https" ? $0 : nil }
        return AgentLoginFlow(
            flowId: id, status: status, url: url,
            userCode: (obj["user_code"] as? String).flatMap { $0.isEmpty ? nil : $0 },
            needsCode: obj["needs_code"] as? Bool ?? false,
            codeKind: obj["code_kind"] as? String,
            message: obj["message"] as? String)
    }

    /// 外部 agent 的失败是不是「没登录」（Mac 给的 run.failed 文本），是就给「去登录」。
    static func failureNeedsLogin(_ message: String?) -> Bool {
        guard let message else { return false }
        return message.contains("未登录或读不到登录态") || message.contains("卡在登录（authenticate）")
            || message.contains("没有任何输出就结束了") && message.contains("API_KEY")
    }
}
