//
//  LeoLinkProblem.swift
//  MinisApp
//
//  [T-link-problem] 手机远控 Mac(中继 / Tailscale 直连)失败时,界面只回答两件事:
//  「是谁的问题」和「现在点哪一个按钮」。以前失败只剩一行字符串,分不清是手机没网、
//  Tailscale 没开、Mac 睡着了,还是密钥被撤销,更不知道该重试还是该去 Mac 上处理,
//  不可重试的错误还会白白跑完整轮退避。
//
//  本文件只依赖 Foundation(编进 App 和 MinisTests):分类表是纯函数,表驱动测试直接覆盖。
//  「从现有错误类型映射」放在 LeoLinkProblem+Errors.swift。
//
//  结构借鉴 OpenClaw iOS 的 GatewayConnectionProblem(MIT):kind / owner / retryable /
//  pauseReconnect / technicalDetails。分类与文案按本仓库真实会抛出的错误重新实现,
//  没有复制其代码。
//

import Foundation

struct LeoLinkProblem: Equatable, Sendable {

    /// 只列真实会发生的失败(来源见 LeoLinkProblem+Errors 的映射表),不是错误码穷举。
    enum Kind: String, CaseIterable, Sendable {
        /// 本机没有可用的配对 / 密钥,或配对码已过期。
        case notPaired
        /// 地址不是合法 https、没填,或中继路径不对。
        case badAddress
        /// 这台 iPhone 自己没网。
        case phoneOffline
        /// 连不上中继,或中继自己返回 5xx。
        case relayUnreachable
        /// 中继限流(429):请求太频繁,或离线排队已满。
        case relayBusy
        /// 访问密钥被中继 / 直连拒绝(401),可能已过期或被撤销。
        case relayAuthFailed
        /// 中继在线,但这台 Mac 没连着中继(502)。
        case macOffline
        /// Mac 撤销了这台 iPhone 的授权,或认不出它(403 带原因)。
        case macPairingRevoked
        /// 目标是 tailnet 地址(*.ts.net / 100.64.0.0/10),但连不上。
        case tailscaleOffOrUnreachable
        /// 证书 / 安全握手失败。
        case tlsUntrusted
        /// Mac 或中继的回应对不上这个 App 的协议(版本太旧或不匹配)。
        case protocolMismatch
        /// 等不到回应。
        case timeout
        /// 直连已发出、中继也失败:结果未确认,不能盲目重发。
        case deliveryUnconfirmed
        case unknown
    }

    /// 「是谁的问题」:该去哪一边处理。
    enum Owner: String, CaseIterable, Sendable {
        case iPhone, mac, network, relay

        var title: String {
            switch self {
            case .iPhone: return "iPhone"
            case .mac: return "Mac"
            case .network: return AppLocalized("网络")
            case .relay: return AppLocalized("中继")
            }
        }

        /// 列表状态行用的一句话。
        var blame: String {
            switch self {
            case .iPhone: return AppLocalized("iPhone 的问题")
            case .mac: return AppLocalized("Mac 的问题")
            case .network: return AppLocalized("网络的问题")
            case .relay: return AppLocalized("中继的问题")
            }
        }
    }

    /// 每个问题只有一个主按钮。
    enum PrimaryAction: String, CaseIterable, Sendable {
        case retry
        case openTailscale
        /// 要先在 Mac 上处理(出示新的配对码 / 升级),再回手机扫码。
        case repairOnMac
        case rescan
        case checkRelayAddress
        case copyDiagnostics

        var title: String {
            switch self {
            case .retry: return AppLocalized("重试")
            case .openTailscale: return AppLocalized("打开 Tailscale")
            case .repairOnMac: return AppLocalized("去 Mac 重新配对")
            case .rescan: return AppLocalized("重新扫码")
            case .checkRelayAddress: return AppLocalized("检查中继地址")
            case .copyDiagnostics: return AppLocalized("复制诊断信息")
            }
        }
    }

    /// 这次请求在做什么,以及能确定的目标。同一个 HTTP 状态在不同场景里意思不同:
    /// 中继发现里的 404 是地址不对,会话里的 404 多半只是那个任务已经不在了。
    struct Context: Equatable, Sendable {
        enum Operation: Sendable {
            /// 向中继拉机器列表(GET /machines)。
            case discovery
            /// 用配对码向中继换密钥(POST /join)或直连配对。
            case pairing
            /// 对某台 Mac 的会话 / 健康检查 / 事件流 / 审批 …(经中继或直连)。
            case session
        }
        var operation: Operation
        /// 请求目标的主机名,只用来识别 Tailscale 地址;URLError 自带的失败地址优先。
        var host: String?
        /// 这台机器的显示名,用在「「MacBook」当前不在线」里;空则说「这台 Mac」。
        var machineName: String?

        init(_ operation: Operation = .session, host: String? = nil, machineName: String? = nil) {
            self.operation = operation
            self.host = host
            self.machineName = machineName
        }
    }

    /// 与具体错误类型无关的失败事实。LeoLinkProblem+Errors 把真实错误翻译成它,
    /// 分类表只认它——这样表驱动测试既能直接喂真实错误,也能脱离错误类型单测分类。
    enum Signal: Equatable, Sendable {
        case phoneOffline
        case timedOut
        case connectFailed
        case hostNotFound
        case tlsCertificate
        case tlsClock
        case tlsHandshake
        case badURL
        case addressMissing
        case notConfigured
        case unauthorized
        case http(status: Int, message: String?)
        case malformed
        case eventsExpired
        case deliveryUnconfirmed
        case cancelled
        case other
    }

    let kind: Kind
    let owner: Owner
    let primaryAction: PrimaryAction
    /// 原样再试一次有可能成功(瞬时故障);为 false 时重试没有意义,要先改点什么。
    let retryable: Bool
    /// 为 true 时自动重连 / 轮询必须停下,等用户点主按钮后才恢复——再退避也不会好,只会白白敲门。
    let pausesAutoReconnect: Bool
    /// 给人看的一行中文。
    let message: String
    /// 折叠显示的原始细节。已脱敏:不含密钥 / 配对码,URL 不含查询串。
    let technicalDetail: String

    init(kind: Kind, owner: Owner, primaryAction: PrimaryAction, retryable: Bool,
         pausesAutoReconnect: Bool, message: String, technicalDetail: String = "") {
        self.kind = kind
        self.owner = owner
        self.primaryAction = primaryAction
        self.retryable = retryable
        self.pausesAutoReconnect = pausesAutoReconnect
        self.message = message
        self.technicalDetail = Self.sanitize(technicalDetail)
    }

    /// 「复制诊断信息」的内容。只由已脱敏的字段拼成。
    var diagnosticsText: String {
        var lines = ["LeoBot 连接诊断", "问题: \(kind.rawValue)(\(owner.blame))", "说明: \(message)"]
        if !technicalDetail.isEmpty { lines.append("细节: \(technicalDetail)") }
        return lines.joined(separator: "\n")
    }

    // MARK: - 分类表

    static func from(signal: Signal, detail: String = "", context: Context = Context()) -> LeoLinkProblem {
        let tailnet = context.host.map(isTailnetHost) ?? false
        switch signal {
        case .phoneOffline:
            return make(.phoneOffline, .iPhone, .retry, retryable: true, pauses: false, detail,
                        AppLocalized("这台 iPhone 现在没有网络，联网后再试。"))
        case .timedOut:
            if tailnet { return tailscale(detail) }
            return make(.timeout, .network, .retry, retryable: true, pauses: false, detail,
                        AppLocalized("等了太久没有回应，网络可能不稳。"))
        case .connectFailed:
            if tailnet { return tailscale(detail) }
            return make(.relayUnreachable, .relay, .retry, retryable: true, pauses: false, detail,
                        AppLocalized("连不上中继，它可能暂时不可用。"))
        case .hostNotFound:
            if tailnet { return tailscale(detail) }
            return make(.relayUnreachable, .network, .retry, retryable: true, pauses: false, detail,
                        AppLocalized("找不到中继，请检查网络是否正常。"))
        case .tlsCertificate:
            return make(.tlsUntrusted, .network, .checkRelayAddress, retryable: false, pauses: true, detail,
                        AppLocalized("安全证书没通过校验，可能是代理在干扰，或地址不对。"))
        case .tlsClock:
            return make(.tlsUntrusted, .iPhone, .copyDiagnostics, retryable: false, pauses: true, detail,
                        AppLocalized("这台 iPhone 的日期时间可能不对，证书校验没通过。"))
        case .tlsHandshake:
            // 握手失败也可能只是瞬时:不暂停,沿用现有退避。
            return make(.tlsUntrusted, .network, .checkRelayAddress, retryable: true, pauses: false, detail,
                        AppLocalized("安全连接没建立起来，可能是代理或地址的问题。"))
        case .badURL:
            return make(.badAddress, .iPhone, .checkRelayAddress, retryable: false, pauses: true, detail,
                        AppLocalized("地址不对：请到「设置 → 我的设备」检查地址（必须是完整的 https 地址）。"))
        case .addressMissing:
            return make(.badAddress, .iPhone, .checkRelayAddress, retryable: false, pauses: true, detail,
                        AppLocalized("这台 Mac 还没填编码会话地址，请到「设置 → 我的设备」补上。"))
        case .notConfigured:
            return make(.notPaired, .iPhone, .rescan, retryable: false, pauses: true, detail,
                        AppLocalized("这台 iPhone 还没和这台 Mac 配对，请扫码配对。"))
        case .unauthorized:
            return unauthorized(context, detail)
        case .malformed:
            switch context.operation {
            case .discovery:
                return make(.badAddress, .relay, .checkRelayAddress, retryable: false, pauses: true, detail,
                            AppLocalized("中继返回的内容不对，请检查中继地址是否写对。"))
            case .pairing:
                return make(.notPaired, .iPhone, .rescan, retryable: false, pauses: true, detail,
                            AppLocalized("配对码无效，请让 Mac 重新出示。"))
            case .session:
                return make(.protocolMismatch, .mac, .copyDiagnostics, retryable: false, pauses: true, detail,
                            AppLocalized("收到的回应对不上这个 App，Mac 或中继的版本可能太旧或不匹配。"))
            }
        case .eventsExpired:
            return make(.unknown, .mac, .retry, retryable: true, pauses: false, detail,
                        AppLocalized("Mac 上较早的事件已过期，会从可用的位置继续。"))
        case .deliveryUnconfirmed:
            return make(.deliveryUnconfirmed, .network, .copyDiagnostics, retryable: false, pauses: false, detail,
                        AppLocalized("这条发出后没收到确认，结果未知。请先在 Mac 上核对，不要急着重发。"))
        case .cancelled:
            return make(.unknown, .iPhone, .retry, retryable: true, pauses: false, detail,
                        AppLocalized("已取消。"))
        case .other:
            return make(.unknown, .network, .retry, retryable: true, pauses: false, detail,
                        AppLocalized("连接出了点问题，可以重试。"))
        case .http(let status, let serverMessage):
            return fromHTTP(status: status, serverMessage: serverMessage, context: context, detail: detail)
        }
    }

    /// 中继在线、但这台机器不在它的在线列表里(发现结果推出来的,不是某个请求失败)。
    static func macOffline(machineName: String? = nil, detail: String = "") -> LeoLinkProblem {
        make(.macOffline, .mac, .retry, retryable: true, pauses: false, detail,
             AppLocalized("\(who(machineName))当前不在线，它会自动重连，稍后再试。"))
    }

    // MARK: HTTP 状态

    /// 状态码的含义取自中继(src/mac/leoagent/relay.py)和 Mac 桥(.../host/leo/link/bridge.ts)的真实回应:
    /// 401 relay_auth_failed、403 设备授权已撤销 / 认不出是哪台设备、404 这个接口不对手机开放、
    /// 409 配对码过期、429 限流、502 这台 Mac 当前不在线、504 这台 Mac 没有按时响应。
    private static func fromHTTP(status: Int, serverMessage: String?, context: Context,
                                 detail: String) -> LeoLinkProblem {
        let message = serverMessage?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let subject = who(context.machineName)
        switch status {
        case 401:
            return unauthorized(context, detail)
        case 403:
            if context.operation == .pairing { return unauthorized(context, detail) }
            // 403 不带原因 = 钥匙本身不被接受;带原因 = 钥匙对、但这台 Mac 不认 / 已撤销这台设备。
            if message.isEmpty { return unauthorized(context, detail) }
            return make(.macPairingRevoked, .mac, .repairOnMac, retryable: false, pauses: true, detail,
                        AppLocalized("\(subject)不再认这台 iPhone，需要在 Mac 上重新配对。"))
        case 404:
            switch context.operation {
            case .discovery, .pairing:
                return make(.badAddress, .iPhone, .checkRelayAddress, retryable: false, pauses: true, detail,
                            AppLocalized("中继地址或路径不对：请到「设置 → 我的设备」检查。"))
            case .session:
                if message.contains("不对手机开放") { return protocolMismatch(detail) }
                return unknownHTTP(status: status, serverMessage: message, detail: detail)
            }
        case 405, 501:
            return protocolMismatch(detail)
        case 408:
            return make(.timeout, .network, .retry, retryable: true, pauses: false, detail,
                        AppLocalized("等了太久没有回应，网络可能不稳。"))
        case 409:
            if context.operation == .pairing { return unauthorized(context, detail) }
            return unknownHTTP(status: status, serverMessage: message, detail: detail)
        case 410:
            return from(signal: .eventsExpired, detail: detail, context: context)
        case 429:
            return make(.relayBusy, .relay, .retry, retryable: true, pauses: false, detail,
                        AppLocalized("请求太频繁，中继让稍等一会儿再试。"))
        case 300..<400:
            // 授权凭据绝不跟随跳转(GatewayNoRedirect),看到 3xx 说明地址指向了别处。
            return make(.badAddress, .iPhone, .checkRelayAddress, retryable: false, pauses: true, detail,
                        AppLocalized("这个地址被重定向到了别处：请到「设置 → 我的设备」检查地址。"))
        case 502:
            // 中继转发不到 Mac(这台 Mac 当前不在线 / 转发到这台 Mac 失败)。SSE 失败时没有正文,也按这个处理;
            // 带着别的原因的 502(例如审批没能送达任务)是 Mac 自己的回应,不是离线。
            if looksLikeMacOffline(message) {
                return macOffline(machineName: context.machineName, detail: detail)
            }
            return unknownHTTP(status: status, serverMessage: message, detail: detail)
        case 503:
            return make(.relayUnreachable, .relay, .retry, retryable: true, pauses: false, detail,
                        AppLocalized("中继暂时不可用，稍后再试。"))
        case 504:
            return make(.timeout, .mac, .retry, retryable: true, pauses: false, detail,
                        AppLocalized("\(subject)没有按时响应，它可能在休眠或忙不过来。"))
        case 500..<600:
            return make(.relayUnreachable, .relay, .retry, retryable: true, pauses: false, detail,
                        AppLocalized("中继暂时出了问题，稍后再试。"))
        default:
            return unknownHTTP(status: status, serverMessage: message, detail: detail)
        }
    }

    private static func unauthorized(_ context: Context, _ detail: String) -> LeoLinkProblem {
        if context.operation == .pairing {
            return make(.notPaired, .iPhone, .rescan, retryable: false, pauses: true, detail,
                        AppLocalized("配对码已过期或无效，请让 Mac 重新出示。"))
        }
        return make(.relayAuthFailed, .relay, .rescan, retryable: false, pauses: true, detail,
                    AppLocalized("访问密钥被拒绝，可能已过期或被撤销，需要重新配对。"))
    }

    private static func protocolMismatch(_ detail: String) -> LeoLinkProblem {
        make(.protocolMismatch, .mac, .copyDiagnostics, retryable: false, pauses: true, detail,
             AppLocalized("Mac 或中继不认这个请求，版本可能太旧或不匹配。"))
    }

    /// 业务类的错误(400/404/409/422 …):原样再试没有意义,也不该停下整条链路,把服务端的话带出来。
    private static func unknownHTTP(status: Int, serverMessage: String, detail: String) -> LeoLinkProblem {
        let clientError = (400..<500).contains(status)
        let shown = sanitize(serverMessage, limit: 60)
        let text = shown.isEmpty
            ? AppLocalized("Mac 返回了错误（HTTP \(status)），详情见技术细节。")
            : AppLocalized("Mac 返回了错误（HTTP \(status)）：\(shown)")
        return make(.unknown, .mac, clientError ? .copyDiagnostics : .retry,
                    retryable: !clientError, pauses: false, detail, text)
    }

    private static func looksLikeMacOffline(_ message: String) -> Bool {
        message.isEmpty || message.contains("不在线") || message.contains("转发到这台 Mac 失败")
            || message.lowercased().contains("offline")
    }

    private static func tailscale(_ detail: String) -> LeoLinkProblem {
        make(.tailscaleOffOrUnreachable, .network, .openTailscale, retryable: true, pauses: false, detail,
             AppLocalized("连不上：这台 iPhone 的 Tailscale 可能没开，或 Mac 不在同一个 tailnet。"))
    }

    private static func make(_ kind: Kind, _ owner: Owner, _ action: PrimaryAction,
                             retryable: Bool, pauses: Bool, _ detail: String,
                             _ message: String) -> LeoLinkProblem {
        LeoLinkProblem(kind: kind, owner: owner, primaryAction: action, retryable: retryable,
                       pausesAutoReconnect: pauses, message: message, technicalDetail: detail)
    }

    private static func who(_ machineName: String?) -> String {
        let name = machineName?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return name.isEmpty ? AppLocalized("这台 Mac") : "「\(name)」"
    }

    // MARK: Tailscale 地址

    /// 只是「看起来像 tailnet」的地址:*.ts.net、100.64.0.0/10(CGNAT,Tailscale 用它)、fd7a:115c:a1e0::/48。
    /// 不证明 VPN 状态——所以文案说「可能没开」。
    static func isTailnetHost(_ raw: String) -> Bool {
        var host = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if host.hasSuffix(".") { host.removeLast() }
        if host.hasPrefix("["), host.hasSuffix("]") { host = String(host.dropFirst().dropLast()) }
        guard !host.isEmpty else { return false }
        if host.hasSuffix(".ts.net") { return host.count > ".ts.net".count }
        let parts = host.split(separator: ".", omittingEmptySubsequences: false)
        if parts.count == 4 {
            let octets = parts.compactMap { UInt8($0) }
            guard octets.count == 4 else { return false }
            return octets[0] == 100 && (64...127).contains(octets[1])
        }
        return host.hasPrefix("fd7a:115c:a1e0:")
    }

    // MARK: 脱敏

    /// 技术细节会被折叠显示、也会被复制出去:去掉 URL 的查询串 / 片段 / 用户信息,
    /// 并把形如密钥的长串(≥20 位字母数字,且含数字)缩成前 4 位。UUID(请求编号)保留,排查要用。
    static func sanitize(_ text: String, limit: Int = 400) -> String {
        var out = text.trimmingCharacters(in: .whitespacesAndNewlines)
        out = strippingURLQueries(out)
        out = redactingTokens(out)
        if out.count > limit { out = String(out.prefix(limit)) + "…" }
        return out
    }

    private static func strippingURLQueries(_ text: String) -> String {
        guard let regex = try? NSRegularExpression(pattern: #"https?://[^\s"'<>)\]]+"#) else { return text }
        let source = text as NSString
        var result = source
        for match in regex.matches(in: text, range: NSRange(location: 0, length: source.length)).reversed() {
            let cleaned = cleanedURL(source.substring(with: match.range))
            result = result.replacingCharacters(in: match.range, with: cleaned) as NSString
        }
        return result as String
    }

    private static func cleanedURL(_ raw: String) -> String {
        if var parts = URLComponents(string: raw) {
            parts.user = nil
            parts.password = nil
            parts.query = nil
            parts.fragment = nil
            if let cleaned = parts.string { return cleaned }
        }
        let cut = raw.firstIndex(where: { $0 == "?" || $0 == "#" }) ?? raw.endIndex
        return String(raw[..<cut])
    }

    private static func redactingTokens(_ text: String) -> String {
        guard let regex = try? NSRegularExpression(pattern: #"[A-Za-z0-9_\-+=]{20,}"#) else { return text }
        let source = text as NSString
        var result = source
        for match in regex.matches(in: text, range: NSRange(location: 0, length: source.length)).reversed() {
            let token = source.substring(with: match.range)
            guard token.contains(where: { $0.isNumber }), UUID(uuidString: token) == nil else { continue }
            result = result.replacingCharacters(in: match.range, with: String(token.prefix(4)) + "…") as NSString
        }
        return result as String
    }
}

/// 每台主机当前的连接问题,以及哪些主机的自动重连 / 轮询已暂停(等用户点主按钮)。
/// 纯值类型:GatewayHostStore 持有它,暂停 / 恢复的语义由单测钉住。
struct LeoLinkProblemBook: Equatable, Sendable {
    private(set) var problems: [String: LeoLinkProblem] = [:]
    private(set) var paused: Set<String> = []

    func problem(for hostId: String) -> LeoLinkProblem? { problems[hostId] }
    func isPaused(_ hostId: String) -> Bool { paused.contains(hostId) }

    /// 记下这台主机最新的问题。需要用户处理的问题(pausesAutoReconnect)同时暂停自动重连;
    /// 瞬时问题只显示、不暂停,沿用现有退避;传 nil = 已经连上,问题和暂停一并清掉。
    mutating func record(_ problem: LeoLinkProblem?, for hostId: String) {
        guard let problem else {
            problems[hostId] = nil
            paused.remove(hostId)
            return
        }
        problems[hostId] = problem
        if problem.pausesAutoReconnect { paused.insert(hostId) } else { paused.remove(hostId) }
    }

    /// 用户点了主按钮:解除暂停,自动重连 / 轮询重新开始。问题继续显示,直到下一次探测给出结论
    /// (还不行就会再次 record 出同样的问题并重新暂停)。
    mutating func resume(_ hostId: String) { paused.remove(hostId) }

    /// 回到前台:用户回来了,所有主机的暂停一并解除。网络造成的误判(酒店 Wi-Fi 的证书页、代理吐出的 HTML)
    /// 不会让轮询永远停着;真有问题的主机会在第一次请求失败时重新暂停,代价是每次回前台多一次请求。
    mutating func resumeAll() { paused.removeAll() }
}
