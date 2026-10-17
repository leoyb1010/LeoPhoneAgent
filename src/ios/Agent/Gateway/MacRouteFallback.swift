import Foundation

// [fix-remote] 连接一台 Mac 的三条路：直连（tailnet，3s 探测）→ 中继（Cloudflare，Funnel 备用）→ SSH 兜底。
// 这里只放纯逻辑（路径状态机、SSH 目标、各 CLI 的无界面参数与输出解析、小火箭 fake-ip 提示），App 侧接线见
// LeoAgentRouting / GatewayHostStore / LeoAgentHarness。

/// 当前走哪条路。
enum MacRoute: String, Codable, CaseIterable, Sendable {
    case direct, relay, ssh

    var label: String {
        switch self {
        case .direct: return "直连"
        case .relay: return "中继"
        case .ssh: return "SSH"
        }
    }
}

/// 路径选择状态机：记住最近成功的路，失败的路冷却一段时间，冷却过了就按「更优」的顺序重探。
struct MacRouteSelector: Codable, Equatable, Sendable {
    /// 失败后多久内不再先试它（直连 30s 与 LeoAgentRouting 的冷却一致；中继 15s；SSH 60s）。
    static let cooldown: [MacRoute: TimeInterval] = [.direct: 30, .relay: 15, .ssh: 60]
    /// 走在次优路上多久后，在后台重探更优的路。
    static let reprobeInterval: TimeInterval = 60

    private(set) var current: MacRoute?
    private(set) var latencyMilliseconds: Int?
    private(set) var lastSuccess: [MacRoute: Date] = [:]
    private(set) var lastFailure: [MacRoute: Date] = [:]
    private(set) var lastProbe: Date?

    /// 这一轮请求按什么顺序试：冷却中的路排到最后（全都在冷却就按优先级全试，宁可慢不能没路）。
    func order(now: Date = Date(), sshAvailable: Bool) -> [MacRoute] {
        let candidates = MacRoute.allCases.filter { $0 != .ssh || sshAvailable }
        let cooling = { (route: MacRoute) -> Bool in
            guard let failed = lastFailure[route] else { return false }
            if let ok = lastSuccess[route], ok > failed { return false }
            return now.timeIntervalSince(failed) < (Self.cooldown[route] ?? 30)
        }
        let ready = candidates.filter { !cooling($0) }
        let later = candidates.filter(cooling)
        return ready + later
    }

    mutating func record(_ route: MacRoute, success: Bool, latencyMilliseconds: Int? = nil, now: Date = Date()) {
        if success {
            lastSuccess[route] = now
            // 只往更优（或同级）的路上换：中继成功不会把刚成功的直连顶掉。
            if current == nil || Self.rank(route) <= Self.rank(current!) {
                current = route
                self.latencyMilliseconds = latencyMilliseconds
            }
        } else {
            lastFailure[route] = now
            if current == route { current = nil }
        }
    }

    /// 正走在次优路上、且离上次重探够久：该在后台再探一次更优的路。
    func shouldReprobe(now: Date = Date()) -> Bool {
        guard let current, current != .direct else { return false }
        guard let lastProbe else { return true }
        return now.timeIntervalSince(lastProbe) >= Self.reprobeInterval
    }

    mutating func markProbed(now: Date = Date()) { lastProbe = now }

    static func rank(_ route: MacRoute) -> Int { MacRoute.allCases.firstIndex(of: route)! }
}

/// SSH 兜底连哪台、用哪个用户。Mac 在 capabilities 里广播的优先；其次设置里改过的；最后内置的默认映射。
struct MacSSHTarget: Codable, Hashable, Sendable {
    let host: String
    let user: String
    var fqdn: String? = nil

    /// 连的时候用的地址：有完整 MagicDNS 名就用它（不依赖手机的 search domain）。
    var address: String { fqdn?.isEmpty == false ? fqdn! : host }

    static func parse(_ raw: Any?) -> MacSSHTarget? {
        guard let obj = raw as? [String: Any],
              let host = obj["host"] as? String, let user = obj["user"] as? String,
              valid(host: host), valid(user: user) else { return nil }
        let fqdn = (obj["fqdn"] as? String).flatMap { valid(host: $0) ? $0 : nil }
        return MacSSHTarget(host: host, user: user, fqdn: fqdn)
    }

    static func valid(host: String) -> Bool {
        host.range(of: #"^[A-Za-z0-9]([A-Za-z0-9.-]{0,250}[A-Za-z0-9])?$"#, options: .regularExpression) != nil
    }

    static func valid(user: String) -> Bool {
        user.range(of: #"^[A-Za-z_][A-Za-z0-9_.-]{0,63}$"#, options: .regularExpression) != nil
    }

    /// 内置默认：中继里的机器名 → tailnet 名 / 用户（可在设置里改）。
    static let defaults: [String: MacSSHTarget] = [
        "LeoyuandeMacBook-Pro-2": MacSSHTarget(host: "leoyuanmacbook-pro", user: "leoyuan"),
        "LeoMac-Studio-2": MacSSHTarget(host: "leomac-studio", user: "leoyuan"),
        "LeodeMac-mini-2": MacSSHTarget(host: "mac-mini-cortex", user: "leo"),
        "LeoyuanAir": MacSSHTarget(host: "leoyuanair", user: "admin"),
    ]

    static func resolve(advertised: MacSSHTarget?, override: MacSSHTarget?, machine: String?) -> MacSSHTarget? {
        advertised ?? override ?? machine.flatMap { defaults[$0] }
    }
}

/// SSH 兜底时在 Mac 上无界面跑所选 CLI 的命令行，以及把它的输出变成一轮回复的文字。
enum SSHFallbackCLI {
    /// 能走 SSH 兜底的 CLI（LeoBot 自己的内核没有命令行入口）。
    static func supports(_ key: String) -> Bool { ["claude", "codex", "gemini", "opencode", "grok"].contains(key) }

    /// 在登录 shell 里跑（拿到用户的 PATH 与代理），先 cd 到工作目录。claude 带上数据根里的长期令牌（若有）。
    static func command(key: String, prompt: String, cwd: String) -> String? {
        let q = RemoteSSHTrust.singleQuoted
        let p = q(prompt)
        let cli: String
        switch key {
        case "claude":
            cli = "T=\"${ZCODE_HOME:-$HOME/.leophoneagent}/acp/claude-oauth-token\"; "
                + "[ -s \"$T\" ] && export CLAUDE_CODE_OAUTH_TOKEN=\"$(cat \"$T\")\"; "
                + "claude -p \(p) --output-format stream-json --verbose"
        case "codex": cli = "codex exec --json --skip-git-repo-check \(p)"
        case "gemini": cli = "gemini -p \(p)"
        case "opencode": cli = "opencode run \(p)"
        case "grok": cli = "grok -p \(p)"
        default: return nil
        }
        let dir = cwd.isEmpty || cwd == "~" ? "$HOME" : (cwd.hasPrefix("~/") ? "\"$HOME\"/" + q(String(cwd.dropFirst(2))) : q(cwd))
        let script = "cd \(dir) 2>/dev/null || cd \"$HOME\"; \(cli) </dev/null"
        return "/bin/zsh -lc \(q(script))"
    }

    /// 一行输出 → 要显示的文字（JSON 模式只取回复正文；文本模式原样，去终端控制符）。nil = 这行不显示。
    static func text(key: String, line raw: String) -> String? {
        let line = raw.replacingOccurrences(of: "\u{1B}\\[[0-9;?]*[ -/]*[@-~]", with: "", options: .regularExpression)
        switch key {
        case "claude":
            guard let obj = json(line) else { return line.isEmpty ? nil : line }
            if obj["type"] as? String == "assistant",
               let content = (obj["message"] as? [String: Any])?["content"] as? [[String: Any]] {
                let text = content.compactMap { $0["type"] as? String == "text" ? $0["text"] as? String : nil }.joined()
                return text.isEmpty ? nil : text
            }
            if obj["type"] as? String == "result", obj["is_error"] as? Bool == true {
                return "（出错）" + ((obj["result"] as? String) ?? "")
            }
            return nil
        case "codex":
            guard let obj = json(line) else { return line.isEmpty ? nil : line }
            if obj["type"] as? String == "item.completed", let item = obj["item"] as? [String: Any],
               item["type"] as? String == "agent_message" {
                return item["text"] as? String
            }
            if obj["type"] as? String == "error" || obj["type"] as? String == "turn.failed" {
                let message = (obj["message"] as? String) ?? ((obj["error"] as? [String: Any])?["message"] as? String) ?? "失败"
                return "（出错）" + message
            }
            return nil
        default:
            return line
        }
    }

    private static func json(_ line: String) -> [String: Any]? {
        guard line.hasPrefix("{"), let data = line.data(using: .utf8) else { return nil }
        return try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    }
}

/// 小火箭（Shadowrocket）等对 *.ts.net 做 fake-ip 时，直连地址被解析到 198.18.0.0/15，TLS 直接失败。
enum FakeIPAdvisor {
    static func isFakeIP(_ address: String) -> Bool {
        let parts = address.split(separator: ".").compactMap { Int($0) }
        guard parts.count == 4, parts.allSatisfy({ (0...255).contains($0) }) else { return false }
        return parts[0] == 198 && (parts[1] == 18 || parts[1] == 19)
    }

    /// 一键复制的规则：ts.net 与 tailnet 网段直连，并从小火箭的接管里排除。
    static let shadowrocketRules = """
    [Rule]
    DOMAIN-SUFFIX,ts.net,DIRECT
    IP-CIDR,100.64.0.0/10,DIRECT,no-resolve

    [General]
    skip-proxy = 100.64.0.0/10, *.ts.net
    tun-excluded-routes = 100.64.0.0/10
    """
}
