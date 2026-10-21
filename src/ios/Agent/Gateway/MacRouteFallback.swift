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

/// SSH 兜底连哪台、用哪个用户、哪个端口。设置里用户填的优先；其次 Mac 在 capabilities 里广播的；最后内置的默认映射。
struct MacSSHTarget: Codable, Hashable, Sendable {
    let host: String
    let user: String
    var fqdn: String? = nil
    /// sshd 端口；nil = 没说（用远程主机里配的，再不行 22）。
    var port: Int? = nil

    /// 连的时候用的地址：有完整 MagicDNS 名就用它（不依赖手机的 search domain）。
    var address: String { fqdn?.isEmpty == false ? fqdn! : host }

    static func parse(_ raw: Any?) -> MacSSHTarget? {
        guard let obj = raw as? [String: Any],
              let host = obj["host"] as? String, let user = obj["user"] as? String,
              valid(host: host), valid(user: user) else { return nil }
        let fqdn = (obj["fqdn"] as? String).flatMap { valid(host: $0) ? $0 : nil }
        return MacSSHTarget(host: host, user: user, fqdn: fqdn, port: (obj["port"] as? Int).flatMap(validPort))
    }

    static func valid(host: String) -> Bool {
        host.range(of: #"^[A-Za-z0-9]([A-Za-z0-9.-]{0,250}[A-Za-z0-9])?$"#, options: .regularExpression) != nil
    }

    static func valid(user: String) -> Bool {
        user.range(of: #"^[A-Za-z_][A-Za-z0-9_.-]{0,63}$"#, options: .regularExpression) != nil
    }

    static func validPort(_ port: Int) -> Int? { (1...65535).contains(port) ? port : nil }

    /// 内置默认：中继里的机器名 → tailnet 名 / 用户（可在设置里改）。
    static let defaults: [String: MacSSHTarget] = [
        "LeoyuandeMacBook-Pro-2": MacSSHTarget(host: "leoyuanmacbook-pro", user: "leoyuan"),
        "LeoMac-Studio-2": MacSSHTarget(host: "leomac-studio", user: "leoyuan"),
        "LeodeMac-mini-2": MacSSHTarget(host: "mac-mini-cortex", user: "leo"),
        "LeoyuanAir": MacSSHTarget(host: "leoyuanair", user: "admin"),
    ]

    /// 设置页写的是「留空就用 Mac 自己报的地址或内置默认」：用户填了就用用户的。
    /// 以前广播的排在前面，用户改了也不生效。用户没填端口时沿用广播的端口（同一台 Mac 的 sshd）。
    static func resolve(advertised: MacSSHTarget?, override: MacSSHTarget?, machine: String?) -> MacSSHTarget? {
        if var override {
            if override.port == nil { override.port = advertised?.port }
            return override
        }
        return advertised ?? machine.flatMap { defaults[$0] }
    }

    /// 端口：目标里有就用；否则用「远程主机」里关联到这台 Mac 的那条的端口；都没有才 22。
    static func port(target: MacSSHTarget, configured: Int?) -> Int {
        target.port ?? configured.flatMap(validPort) ?? 22
    }
}

/// SSH 兜底一轮里，CLI 输出的一行变成的东西：正文、工具开始 / 结束、可以续上的会话号。
enum SSHFallbackEvent: Equatable, Sendable {
    case text(String)
    /// 进展提示（CLI 已启动、正在生成、Mac 端 stderr）：显示成灰色说明行，同时证明这一轮还活着。
    case progress(String)
    case toolStarted(id: String, name: String, input: String)
    case toolFinished(id: String, output: String, isError: Bool)
    case session(String)
}

/// SSH 兜底时在 Mac 上无界面跑所选 CLI 的命令行，以及把它的输出变成一轮回复。
enum SSHFallbackCLI {
    /// 能走 SSH 兜底的 CLI（LeoBot 自己的内核没有命令行入口）。
    static func supports(_ key: String) -> Bool { ["claude", "codex", "gemini", "opencode", "grok"].contains(key) }

    /// 只有 claude / codex 能续上一轮（stream-json / --json 里带会话号）。
    static func canResume(_ key: String) -> Bool { key == "claude" || key == "codex" }

    /// 会话号要拼进命令行：只收这种形状，其余一律当没有。
    static func validSessionId(_ id: String?) -> String? {
        guard let id, id.range(of: #"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$"#, options: .regularExpression) != nil else { return nil }
        return id
    }

    /// 在登录 shell 里跑（拿到用户的 PATH 与代理），先 cd 到工作目录。claude 带上数据根里的长期令牌（若有）。
    /// `fullAuto`：全自动开着时用各 CLI 自己的免审批参数（无界面跑没人能点允许，不开就只能读不能改）。
    /// `resumeId`：上一轮 CLI 报的会话号，这一轮接着那个上下文聊。
    static func command(key: String, prompt: String, cwd: String, fullAuto: Bool = false, resumeId: String? = nil) -> String? {
        let q = RemoteSSHTrust.singleQuoted
        let p = q(prompt)
        let resume = validSessionId(resumeId)
        let cli: String
        switch key {
        case "claude":
            cli = "T=\"${ZCODE_HOME:-$HOME/.leophoneagent}/acp/claude-oauth-token\"; "
                + "[ -s \"$T\" ] && export CLAUDE_CODE_OAUTH_TOKEN=\"$(cat \"$T\")\"; "
                + "claude -p \(p) --output-format stream-json --verbose --include-partial-messages"
                + (fullAuto ? " --dangerously-skip-permissions" : "")
                + (resume.map { " --resume \(q($0))" } ?? "")
        case "codex":
            // ponytail: `codex exec [选项] resume <id> <提示>`，选项放在子命令前面；codex 改了子命令语法再跟着改。
            cli = "codex exec --json --skip-git-repo-check" + (fullAuto ? " --full-auto" : "")
                + (resume.map { " resume \(q($0))" } ?? "") + " \(p)"
        case "gemini": cli = "gemini -p \(p)" + (fullAuto ? " --yolo" : "")
        case "opencode": cli = "opencode run \(p)"
        case "grok": cli = "grok -p \(p)"
        default: return nil
        }
        let dir = cwd.isEmpty || cwd == "~" ? "$HOME" : (cwd.hasPrefix("~/") ? "\"$HOME\"/" + q(String(cwd.dropFirst(2))) : q(cwd))
        let script = "cd \(dir) 2>/dev/null || cd \"$HOME\"; \(cli) </dev/null"
        return "/bin/zsh -lc \(q(script))"
    }

    /// 工具输出在会话里最多留这么多字（只是给人看，完整的在 Mac 上）。
    static let outputLimit = 16_000

    /// 一行输出 → 要显示的东西（JSON 模式取正文、工具与会话号；文本模式原样，去终端控制符）。
    static func events(key: String, line raw: String) -> [SSHFallbackEvent] {
        let line = raw.replacingOccurrences(of: "\u{1B}\\[[0-9;?]*[ -/]*[@-~]", with: "", options: .regularExpression)
        switch key {
        case "claude":
            guard let obj = json(line) else { return line.isEmpty ? [] : [.text(line)] }
            return claudeEvents(obj)
        case "codex":
            guard let obj = json(line) else { return line.isEmpty ? [] : [.text(line)] }
            return codexEvents(obj)
        default:
            return [.text(line)]
        }
    }

    /// 只要正文（旧调用方 / 测试用）。
    static func text(key: String, line: String) -> String? {
        let texts = events(key: key, line: line).compactMap { if case .text(let t) = $0 { return t }; return nil }
        return texts.isEmpty ? nil : texts.joined()
    }

    private static func claudeEvents(_ obj: [String: Any]) -> [SSHFallbackEvent] {
        let type = obj["type"] as? String
        var out: [SSHFallbackEvent] = []
        if type == "system", let id = validSessionId(obj["session_id"] as? String) {
            out.append(.session(id))
            if obj["subtype"] as? String == "init" { out.append(.progress("Claude Code 已在 Mac 上启动")) }
        }
        // [up-link] Claude Code 请求失败会安静地重试最多 10 次（指数退避，前后近 10 分钟），以前手机上只看到「处理中」。
        // 401/403 基本就是那台 Mac 上 Claude Code 的 Key / 登录失效（例如 ANTHROPIC_BASE_URL 指向的第三方接口 Key 过期）。
        if type == "system", obj["subtype"] as? String == "api_retry" {
            let status = obj["error_status"] as? Int
            let attempt = obj["attempt"] as? Int ?? 0
            let maxRetries = obj["max_retries"] as? Int ?? 0
            let reason = (obj["error"] as? String) ?? "请求失败"
            let hint = (status == 401 || status == 403)
                ? "：这台 Mac 上 Claude Code 的 API Key 或登录无效，去那台 Mac 检查 ~/.claude/settings.json 或重新登录"
                : ""
            out.append(.progress("Claude Code 请求失败（\(status.map(String.init) ?? "?") \(reason)），第 \(attempt)/\(maxRetries) 次重试\(hint)"))
        }
        // --include-partial-messages 的增量：正文仍以完整的 assistant 消息为准（避免重复），这里只报「还活着」。
        if type == "stream_event", let event = obj["event"] as? [String: Any] {
            switch event["type"] as? String {
            case "message_start": out.append(.progress("正在生成回复…"))
            case "content_block_start":
                if (event["content_block"] as? [String: Any])?["type"] as? String == "thinking" { out.append(.progress("正在思考…")) }
            default: break
            }
        }
        let content = (obj["message"] as? [String: Any])?["content"] as? [[String: Any]] ?? []
        if type == "assistant" {
            let text = content.compactMap { $0["type"] as? String == "text" ? $0["text"] as? String : nil }.joined()
            if !text.isEmpty { out.append(.text(text)) }
            for block in content where block["type"] as? String == "tool_use" {
                guard let id = block["id"] as? String else { continue }
                out.append(.toolStarted(id: id, name: block["name"] as? String ?? "tool", input: describe(input: block["input"])))
            }
        }
        if type == "user" {
            for block in content where block["type"] as? String == "tool_result" {
                guard let id = block["tool_use_id"] as? String else { continue }
                out.append(.toolFinished(id: id, output: clip(flatten(block["content"])), isError: block["is_error"] as? Bool ?? false))
            }
        }
        if type == "result" {
            if let id = validSessionId(obj["session_id"] as? String) { out.append(.session(id)) }
            if obj["is_error"] as? Bool == true { out.append(.text("（出错）" + ((obj["result"] as? String) ?? ""))) }
        }
        return out
    }

    private static func codexEvents(_ obj: [String: Any]) -> [SSHFallbackEvent] {
        let type = obj["type"] as? String
        if type == "thread.started", let id = validSessionId(obj["thread_id"] as? String) { return [.session(id)] }
        if type == "error" || type == "turn.failed" {
            let message = (obj["message"] as? String) ?? ((obj["error"] as? [String: Any])?["message"] as? String) ?? "失败"
            return [.text("（出错）" + message)]
        }
        guard let item = obj["item"] as? [String: Any], let itemType = item["type"] as? String else { return [] }
        let id = item["id"] as? String ?? UUID().uuidString
        switch (type, itemType) {
        case ("item.completed", "agent_message"):
            return (item["text"] as? String).map { [.text($0)] } ?? []
        case ("item.started", "command_execution"):
            return [.toolStarted(id: id, name: "shell", input: item["command"] as? String ?? "")]
        case ("item.completed", "command_execution"):
            let failed = (item["exit_code"] as? Int).map { $0 != 0 } ?? (item["status"] as? String == "failed")
            return [.toolFinished(id: id, output: clip(item["aggregated_output"] as? String ?? ""), isError: failed)]
        case ("item.completed", "file_change"):
            let paths = (item["changes"] as? [[String: Any]] ?? []).compactMap { $0["path"] as? String }
            return [.toolStarted(id: id, name: "edit", input: paths.joined(separator: "\n")),
                    .toolFinished(id: id, output: "", isError: item["status"] as? String == "failed")]
        default:
            return []
        }
    }

    /// 工具输入：命令 / 路径这类一眼能看懂的优先，其余整段 JSON。
    static func describe(input: Any?) -> String {
        guard let obj = input as? [String: Any] else { return (input as? String) ?? "" }
        for key in ["command", "file_path", "path", "url", "pattern", "query"] {
            if let value = obj[key] as? String, !value.isEmpty {
                let rest = obj.filter { $0.key != key && $0.key != "description" }
                return rest.isEmpty ? value : value + "\n" + prettyJSON(rest)
            }
        }
        return prettyJSON(obj)
    }

    private static func prettyJSON(_ obj: Any) -> String {
        guard JSONSerialization.isValidJSONObject(obj),
              let data = try? JSONSerialization.data(withJSONObject: obj, options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes])
        else { return String(describing: obj) }
        return clip(String(decoding: data, as: UTF8.self))
    }

    private static func flatten(_ content: Any?) -> String {
        if let text = content as? String { return text }
        let blocks = content as? [[String: Any]] ?? []
        return blocks.compactMap { $0["text"] as? String }.joined(separator: "\n")
    }

    static func clip(_ text: String) -> String {
        text.count <= outputLimit ? text : String(text.prefix(outputLimit)) + "\n…（已截断）"
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
