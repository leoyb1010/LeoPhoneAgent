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
    var id: String { key }

    init(key: String, name: String, available: Bool = true, unavailableReason: String? = nil,
         version: String? = nil, cliPath: String? = nil) {
        self.key = key
        self.name = name
        self.available = available
        self.unavailableReason = unavailableReason
        self.version = version
        self.cliPath = cliPath
    }

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
                cliPath: row["cli_path"] as? String)
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
