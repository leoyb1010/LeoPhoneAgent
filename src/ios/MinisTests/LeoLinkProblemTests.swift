import XCTest

/// [T-link-problem] 真实错误 → 「谁的问题 + 一个主按钮」的映射表。
/// 每一行都对应 Agent/Gateway 里真会抛出的错误(或中继 / Mac 真会回的状态),
/// 状态码与文案取自 relay.py / bridge.ts 的实际回应。
final class LeoLinkProblemTests: XCTestCase {
    typealias Kind = LeoLinkProblem.Kind
    typealias Owner = LeoLinkProblem.Owner
    typealias Action = LeoLinkProblem.PrimaryAction
    typealias Ctx = LeoLinkProblem.Context

    private struct Row {
        let name: String
        let error: Error
        let context: Ctx
        let kind: Kind
        let owner: Owner
        let action: Action
        let retryable: Bool
        let pauses: Bool
    }

    private static let tailnet = "mac.tail1234.ts.net"
    private static let session = Ctx(.session)
    private static let tailnetSession = Ctx(.session, host: tailnet)
    private static let discovery = Ctx(.discovery)
    private static let pairing = Ctx(.pairing)

    /// 会话场景(默认)。
    private static func row(_ name: String, _ error: Error,
                            _ kind: Kind, _ owner: Owner, _ action: Action,
                            retryable: Bool, pauses: Bool) -> Row {
        Row(name: name, error: error, context: session, kind: kind, owner: owner, action: action,
            retryable: retryable, pauses: pauses)
    }

    /// 指定场景(发现 / 配对 / 带目标主机)。
    private static func row(_ name: String, _ error: Error, _ context: Ctx,
                            _ kind: Kind, _ owner: Owner, _ action: Action,
                            retryable: Bool, pauses: Bool) -> Row {
        Row(name: name, error: error, context: context, kind: kind, owner: owner, action: action,
            retryable: retryable, pauses: pauses)
    }

    private static func http(_ status: Int, _ message: String? = nil) -> GatewayError {
        .http(status: status, message: message)
    }

    // MARK: 映射表

    private static let table: [Row] = [
        // GatewayError —— 本机配置
        row("notConfigured", GatewayError.notConfigured, .notPaired, .iPhone, .rescan, retryable: false, pauses: true),
        row("harnessNotConfigured", GatewayError.harnessNotConfigured, .badAddress, .iPhone, .checkRelayAddress, retryable: false, pauses: true),
        row("badURL", GatewayError.badURL, .badAddress, .iPhone, .checkRelayAddress, retryable: false, pauses: true),

        // GatewayError —— 钥匙(401,或 403 不带原因)
        row("unauthorized", GatewayError.unauthorized, .relayAuthFailed, .relay, .rescan, retryable: false, pauses: true),
        row("unauthorized while pairing", GatewayError.unauthorized, pairing, .notPaired, .iPhone, .rescan, retryable: false, pauses: true),
        row("http 401", http(401), .relayAuthFailed, .relay, .rescan, retryable: false, pauses: true),
        row("http 403 without reason", http(403), .relayAuthFailed, .relay, .rescan, retryable: false, pauses: true),
        row("http 403 empty reason", http(403, "  "), .relayAuthFailed, .relay, .rescan, retryable: false, pauses: true),

        // GatewayError —— Mac 撤销 / 认不出这台 iPhone(bridge.ts 的 403 都带原因)
        row("403 device grant revoked", http(403, "设备授权已撤销"), .macPairingRevoked, .mac, .repairOnMac, retryable: false, pauses: true),
        row("403 device not recognized", http(403, "认不出是哪台设备，只能拒绝；请在 Mac 上批准，或把中继升级到 0.2"), .macPairingRevoked, .mac, .repairOnMac, retryable: false, pauses: true),
        row("403 pair first", http(403, "请先通过中继或本机配对授权"), .macPairingRevoked, .mac, .repairOnMac, retryable: false, pauses: true),
        row("403 replica not authorized", http(403, "设备尚未授权同步副本"), .macPairingRevoked, .mac, .repairOnMac, retryable: false, pauses: true),

        // GatewayError —— 404 / 405 / 501
        row("404 not open to phones", http(404, "这个接口不对手机开放"), .protocolMismatch, .mac, .copyDiagnostics, retryable: false, pauses: true),
        row("404 session gone is business, not link", http(404, nil), .unknown, .mac, .copyDiagnostics, retryable: false, pauses: false),
        row("404 on relay discovery", http(404), discovery, .badAddress, .iPhone, .checkRelayAddress, retryable: false, pauses: true),
        row("405", http(405, "Method not allowed"), .protocolMismatch, .mac, .copyDiagnostics, retryable: false, pauses: true),
        row("501", http(501), .protocolMismatch, .mac, .copyDiagnostics, retryable: false, pauses: true),

        // GatewayError —— 409 / 410 / 429 / 3xx
        row("409 conflict is business", http(409, "No such pending approval"), .unknown, .mac, .copyDiagnostics, retryable: false, pauses: false),
        row("409 join token expired", http(409, "join token expired or unknown"), pairing, .notPaired, .iPhone, .rescan, retryable: false, pauses: true),
        row("410 events expired", http(410), .unknown, .mac, .retry, retryable: true, pauses: false),
        row("resumeGap", GatewayError.resumeGap(minAfter: 41), .unknown, .mac, .retry, retryable: true, pauses: false),
        row("429 queue full", http(429, "排队的任务太多了,等 Mac 上线再发"), .relayBusy, .relay, .retry, retryable: true, pauses: false),
        row("302 redirect", http(302), .badAddress, .iPhone, .checkRelayAddress, retryable: false, pauses: true),

        // GatewayError —— 5xx(relay.py 的转发失败)
        row("502 mac offline", http(502, "这台 Mac 当前不在线(它会自动重连,稍后再试)"), .macOffline, .mac, .retry, retryable: true, pauses: false),
        row("502 without body (SSE)", http(502), .macOffline, .mac, .retry, retryable: true, pauses: false),
        row("502 forward failed", http(502, "转发到这台 Mac 失败:ConnectionResetError"), .macOffline, .mac, .retry, retryable: true, pauses: false),
        row("502 other reason is the Mac's own answer", http(502, "Approval could not be delivered to the task"), .unknown, .mac, .retry, retryable: true, pauses: false),
        row("503", http(503), .relayUnreachable, .relay, .retry, retryable: true, pauses: false),
        row("504 mac did not answer", http(504, "这台 Mac 没有按时响应"), .timeout, .mac, .retry, retryable: true, pauses: false),
        row("500", http(500), .relayUnreachable, .relay, .retry, retryable: true, pauses: false),
        row("507", http(507, "treasury persistence failed"), .relayUnreachable, .relay, .retry, retryable: true, pauses: false),
        row("408", http(408), .timeout, .network, .retry, retryable: true, pauses: false),
        row("400 invalid choice", http(400, "Invalid choice; expected one of: once, deny"), .unknown, .mac, .copyDiagnostics, retryable: false, pauses: false),
        row("422", http(422), .unknown, .mac, .copyDiagnostics, retryable: false, pauses: false),

        // GatewayError —— 回应形状不对 / 结果未确认
        row("malformed in session", GatewayError.malformedResponse("missing session_id"), .protocolMismatch, .mac, .copyDiagnostics, retryable: false, pauses: true),
        row("malformed in discovery", GatewayError.malformedResponse("not an HTTP response"), discovery, .badAddress, .relay, .checkRelayAddress, retryable: false, pauses: true),
        row("malformed in pairing", GatewayError.malformedResponse("x"), pairing, .notPaired, .iPhone, .rescan, retryable: false, pauses: true),
        row("uncertainAfterDirectAttempt", GatewayError.uncertainAfterDirectAttempt, .deliveryUnconfirmed, .network, .copyDiagnostics, retryable: false, pauses: false),

        // RelayDiscoveryError(RelayMachinesClient.list / join)
        row("discovery unauthorized", RelayDiscoveryError.unauthorized, discovery, .relayAuthFailed, .relay, .rescan, retryable: false, pauses: true),
        row("join unauthorized (code expired)", RelayDiscoveryError.unauthorized, pairing, .notPaired, .iPhone, .rescan, retryable: false, pauses: true),
        row("discovery badURL", RelayDiscoveryError.badURL, discovery, .badAddress, .iPhone, .checkRelayAddress, retryable: false, pauses: true),
        row("discovery malformed", RelayDiscoveryError.malformed, discovery, .badAddress, .relay, .checkRelayAddress, retryable: false, pauses: true),
        row("join malformed", RelayDiscoveryError.malformed, pairing, .notPaired, .iPhone, .rescan, retryable: false, pauses: true),
        row("discovery http 404", RelayDiscoveryError.http(404), discovery, .badAddress, .iPhone, .checkRelayAddress, retryable: false, pauses: true),
        row("join http 409", RelayDiscoveryError.http(409), pairing, .notPaired, .iPhone, .rescan, retryable: false, pauses: true),
        row("join http 429", RelayDiscoveryError.http(429), pairing, .relayBusy, .relay, .retry, retryable: true, pauses: false),
        row("discovery http 503", RelayDiscoveryError.http(503), discovery, .relayUnreachable, .relay, .retry, retryable: true, pauses: false),

        // URLError —— 手机自己没网
        row("notConnectedToInternet", URLError(.notConnectedToInternet), .phoneOffline, .iPhone, .retry, retryable: true, pauses: false),
        row("dataNotAllowed", URLError(.dataNotAllowed), .phoneOffline, .iPhone, .retry, retryable: true, pauses: false),
        row("internationalRoamingOff", URLError(.internationalRoamingOff), .phoneOffline, .iPhone, .retry, retryable: true, pauses: false),
        row("callIsActive", URLError(.callIsActive), .phoneOffline, .iPhone, .retry, retryable: true, pauses: false),

        // URLError —— 连不上(非 tailnet 地址 → 中继 / 网络)
        row("timedOut", URLError(.timedOut), .timeout, .network, .retry, retryable: true, pauses: false),
        row("cannotConnectToHost", URLError(.cannotConnectToHost), .relayUnreachable, .relay, .retry, retryable: true, pauses: false),
        row("networkConnectionLost", URLError(.networkConnectionLost), .relayUnreachable, .relay, .retry, retryable: true, pauses: false),
        row("cannotFindHost", URLError(.cannotFindHost), .relayUnreachable, .network, .retry, retryable: true, pauses: false),
        row("dnsLookupFailed", URLError(.dnsLookupFailed), .relayUnreachable, .network, .retry, retryable: true, pauses: false),

        // URLError —— 同样的失败,目标是 tailnet 地址 → 先看 Tailscale
        row("timedOut on tailnet", URLError(.timedOut), tailnetSession, .tailscaleOffOrUnreachable, .network, .openTailscale, retryable: true, pauses: false),
        row("cannotConnectToHost on tailnet", URLError(.cannotConnectToHost), tailnetSession, .tailscaleOffOrUnreachable, .network, .openTailscale, retryable: true, pauses: false),
        row("networkConnectionLost on tailnet", URLError(.networkConnectionLost), tailnetSession, .tailscaleOffOrUnreachable, .network, .openTailscale, retryable: true, pauses: false),
        row("cannotFindHost on tailnet", URLError(.cannotFindHost), tailnetSession, .tailscaleOffOrUnreachable, .network, .openTailscale, retryable: true, pauses: false),
        row("dnsLookupFailed on tailnet IP", URLError(.dnsLookupFailed), Ctx(.discovery, host: "100.101.102.103"), .tailscaleOffOrUnreachable, .network, .openTailscale, retryable: true, pauses: false),
        row("cannotConnectToHost on public host", URLError(.cannotConnectToHost), Ctx(.session, host: "relay.example.com"), .relayUnreachable, .relay, .retry, retryable: true, pauses: false),
        // 目标主机从 URLError 自带的失败地址里认出来(调用方没传 host 时)
        row("failingURL on tailnet", URLError(.timedOut, userInfo: [NSURLErrorFailingURLErrorKey: URL(string: "https://relay.tail1234.ts.net/leoagent-relay/relay/api/m/mac?after=1")!]),
            .tailscaleOffOrUnreachable, .network, .openTailscale, retryable: true, pauses: false),

        // URLError —— 证书 / 握手
        row("secureConnectionFailed", URLError(.secureConnectionFailed), .tlsUntrusted, .network, .checkRelayAddress, retryable: true, pauses: false),
        row("serverCertificateUntrusted", URLError(.serverCertificateUntrusted), .tlsUntrusted, .network, .checkRelayAddress, retryable: false, pauses: true),
        row("serverCertificateHasUnknownRoot", URLError(.serverCertificateHasUnknownRoot), .tlsUntrusted, .network, .checkRelayAddress, retryable: false, pauses: true),
        row("clientCertificateRejected", URLError(.clientCertificateRejected), .tlsUntrusted, .network, .checkRelayAddress, retryable: false, pauses: true),
        row("clientCertificateRequired", URLError(.clientCertificateRequired), .tlsUntrusted, .network, .checkRelayAddress, retryable: false, pauses: true),
        row("serverCertificateHasBadDate", URLError(.serverCertificateHasBadDate), .tlsUntrusted, .iPhone, .copyDiagnostics, retryable: false, pauses: true),
        row("serverCertificateNotYetValid", URLError(.serverCertificateNotYetValid), .tlsUntrusted, .iPhone, .copyDiagnostics, retryable: false, pauses: true),

        // URLError —— 地址 / 回应
        row("URLError badURL", URLError(.badURL), .badAddress, .iPhone, .checkRelayAddress, retryable: false, pauses: true),
        row("URLError unsupportedURL", URLError(.unsupportedURL), .badAddress, .iPhone, .checkRelayAddress, retryable: false, pauses: true),
        row("URLError ATS", URLError(.appTransportSecurityRequiresSecureConnection), .badAddress, .iPhone, .checkRelayAddress, retryable: false, pauses: true),
        // 传输层异常(-1011 / -1017,流被掐断、代理吐半截响应):瞬时居多,不能当协议不匹配而暂停重连。
        row("URLError badServerResponse", URLError(.badServerResponse), .unknown, .network, .retry, retryable: true, pauses: false),
        row("URLError cannotParseResponse", URLError(.cannotParseResponse), .unknown, .network, .retry, retryable: true, pauses: false),
        row("URLError cancelled", URLError(.cancelled), .unknown, .iPhone, .retry, retryable: true, pauses: false),
        row("CancellationError", CancellationError(), .unknown, .iPhone, .retry, retryable: true, pauses: false),

        // 其它 —— JSON 解析失败(中继地址指到了网页)、没见过的错误
        row("JSON parse error in discovery", NSError(domain: NSCocoaErrorDomain, code: 3840), discovery, .badAddress, .relay, .checkRelayAddress, retryable: false, pauses: true),
        row("JSON parse error in session", NSError(domain: NSCocoaErrorDomain, code: 3840), .protocolMismatch, .mac, .copyDiagnostics, retryable: false, pauses: true),
        row("anything else", NSError(domain: "Test", code: 7), .unknown, .network, .retry, retryable: true, pauses: false),
    ]

    func testEveryRealErrorMapsToItsOwnerActionAndPausePolicy() {
        for row in Self.table {
            let problem = LeoLinkProblem.from(error: row.error, context: row.context)
            XCTAssertEqual(problem.kind, row.kind, "kind: \(row.name)")
            XCTAssertEqual(problem.owner, row.owner, "owner: \(row.name)")
            XCTAssertEqual(problem.primaryAction, row.action, "primaryAction: \(row.name)")
            XCTAssertEqual(problem.retryable, row.retryable, "retryable: \(row.name)")
            XCTAssertEqual(problem.pausesAutoReconnect, row.pauses, "pausesAutoReconnect: \(row.name)")
            XCTAssertFalse(problem.message.isEmpty, "message: \(row.name)")
            XCTAssertFalse(problem.technicalDetail.isEmpty, "technicalDetail: \(row.name)")
        }
    }

    /// 暂停和「重试」不能同时成立:要用户处理的问题,原样再试一次没有意义;
    /// 主按钮是「重试」的问题必须真的可以重试。
    func testPausePolicyInvariants() {
        for row in Self.table {
            let problem = LeoLinkProblem.from(error: row.error, context: row.context)
            if problem.pausesAutoReconnect {
                XCTAssertFalse(problem.retryable, "paused problems are not retryable: \(row.name)")
                XCTAssertNotEqual(problem.primaryAction, .retry, "paused problems need a real action: \(row.name)")
            }
            if problem.primaryAction == .retry {
                XCTAssertTrue(problem.retryable, "retry button needs a retryable problem: \(row.name)")
            }
        }
    }

    /// 表里每一种 kind / owner / 主按钮都至少出现过一次,新增 case 忘了补测试会红。
    func testTableCoversEveryKindOwnerAndAction() {
        let problems = Self.table.map { LeoLinkProblem.from(error: $0.error, context: $0.context) }
        for kind in Kind.allCases {
            XCTAssertTrue(problems.contains { $0.kind == kind }, "kind not covered: \(kind)")
        }
        for owner in Owner.allCases {
            XCTAssertTrue(problems.contains { $0.owner == owner }, "owner not covered: \(owner)")
        }
        for action in Action.allCases {
            XCTAssertTrue(problems.contains { $0.primaryAction == action }, "action not covered: \(action)")
        }
    }

    // MARK: Signal 层

    func testSignalLayerMatchesErrorLayer() {
        let viaError = LeoLinkProblem.from(error: URLError(.notConnectedToInternet))
        let viaSignal = LeoLinkProblem.from(signal: .phoneOffline)
        XCTAssertEqual(viaError.kind, viaSignal.kind)
        XCTAssertEqual(viaError.owner, viaSignal.owner)
        XCTAssertEqual(viaError.primaryAction, viaSignal.primaryAction)
    }

    func testCancellationIsRecognisedSoCallersCanSkipIt() {
        XCTAssertTrue(LeoLinkProblem.isCancellation(CancellationError()))
        XCTAssertTrue(LeoLinkProblem.isCancellation(URLError(.cancelled)))
        XCTAssertFalse(LeoLinkProblem.isCancellation(URLError(.timedOut)))
        XCTAssertFalse(LeoLinkProblem.isCancellation(GatewayError.unauthorized))
    }

    // MARK: 文案

    func testMessageNamesTheMachineWhenKnown() {
        let named = Ctx(.session, machineName: "MacBook Pro")
        XCTAssertTrue(LeoLinkProblem.from(error: GatewayError.http(status: 502, message: nil), context: named)
            .message.contains("MacBook Pro"))
        XCTAssertTrue(LeoLinkProblem.from(error: GatewayError.http(status: 403, message: "设备授权已撤销"), context: named)
            .message.contains("MacBook Pro"))
        XCTAssertTrue(LeoLinkProblem.macOffline(machineName: "Mac mini").message.contains("Mac mini"))
        XCTAssertFalse(LeoLinkProblem.macOffline(machineName: nil).message.isEmpty)
        let unnamed = LeoLinkProblem.from(error: GatewayError.http(status: 502, message: nil))
        XCTAssertFalse(unnamed.message.contains("「"))
    }

    func testMacOfflineFromDiscoveryIsTransient() {
        let problem = LeoLinkProblem.macOffline(machineName: "MacBook Pro")
        XCTAssertEqual(problem.kind, .macOffline)
        XCTAssertEqual(problem.owner, .mac)
        XCTAssertEqual(problem.primaryAction, .retry)
        XCTAssertTrue(problem.retryable)
        XCTAssertFalse(problem.pausesAutoReconnect)
    }

    func testPrimaryActionsHaveDistinctTitles() {
        let titles = Action.allCases.map(\.title)
        XCTAssertEqual(Set(titles).count, titles.count)
        XCTAssertTrue(titles.allSatisfy { !$0.isEmpty })
        XCTAssertEqual(Owner.allCases.map(\.blame).count, Set(Owner.allCases.map(\.blame)).count)
    }

    // MARK: Tailscale 地址

    func testTailnetHostDetection() {
        for host in ["mac.tail1234.ts.net", "MAC.TAIL1234.TS.NET.", "a.ts.net", "100.64.0.1", "100.101.102.103",
                     "100.127.255.255", "fd7a:115c:a1e0::1", "[fd7a:115c:a1e0:ab12::7]"] {
            XCTAssertTrue(LeoLinkProblem.isTailnetHost(host), host)
        }
        for host in ["", "ts.net", ".ts.net", "evilts.net", "ts.net.example.com", "example.com", "100.63.255.255",
                     "100.128.0.1", "100.64.0", "100.64.0.1.5", "100.64.0.999", "192.168.1.5", "10.0.0.1", "::1",
                     "fd00::1"] {
            XCTAssertFalse(LeoLinkProblem.isTailnetHost(host), host)
        }
    }

    // MARK: 脱敏

    func testTechnicalDetailNeverCarriesKeysPairingCodesOrQueryStrings() {
        let key = "k3y9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c3d2e1f0a9b8c7d6e5f4a3b2c1d0e9"
        let message = "bad key \(key) at https://user:pw@relay.example.ts.net/leoagent-relay/relay/api/m/mac?token=SECRETSECRET1234567890&join=PAIRCODE#frag Bearer \(key)"
        let problem = LeoLinkProblem.from(error: GatewayError.http(status: 500, message: message))
        let shown = problem.technicalDetail + problem.message + problem.diagnosticsText
        XCTAssertFalse(shown.contains(key), "key must not leak")
        XCTAssertFalse(shown.contains("SECRETSECRET"), "query secrets must not leak")
        XCTAssertFalse(shown.contains("PAIRCODE"), "pairing code must not leak")
        XCTAssertFalse(shown.contains("token="), "query string must be dropped")
        XCTAssertFalse(shown.contains("user:pw"), "userinfo must be dropped")
        XCTAssertFalse(shown.contains("#frag"))
        XCTAssertTrue(problem.technicalDetail.contains("relay.example.ts.net/leoagent-relay/relay/api/m/mac"),
                      "host and path are kept for diagnosis")
        XCTAssertTrue(problem.technicalDetail.contains("HTTP 500"))
    }

    func testSanitizeKeepsRequestIdsAndShortWordsAndCapsLength() {
        let uuid = "3F2504E0-4F89-41D3-9A0C-0305E82C3301"
        XCTAssertEqual(LeoLinkProblem.sanitize("request \(uuid) failed"), "request \(uuid) failed")
        XCTAssertEqual(LeoLinkProblem.sanitize("dataLengthExceedsMaximumNoDigits"), "dataLengthExceedsMaximumNoDigits")
        XCTAssertEqual(LeoLinkProblem.sanitize("0123456789abcdef0123456789"), "0123…")
        XCTAssertEqual(LeoLinkProblem.sanitize("short12345"), "short12345")
        let long = LeoLinkProblem.sanitize(String(repeating: "x ", count: 500))
        XCTAssertLessThanOrEqual(long.count, 401)
        XCTAssertTrue(long.hasSuffix("…"))
    }

    func testURLErrorDetailKeepsOnlyTheHostOfTheFailingURL() {
        let url = URL(string: "https://relay.tail1234.ts.net/leoagent-relay/relay/api/events?after=1&limit=200")!
        let problem = LeoLinkProblem.from(error: URLError(.timedOut, userInfo: [NSURLErrorFailingURLErrorKey: url]))
        XCTAssertTrue(problem.technicalDetail.contains("-1001"))
        XCTAssertTrue(problem.technicalDetail.contains("relay.tail1234.ts.net"))
        XCTAssertFalse(problem.technicalDetail.contains("after=1"))
    }

    func testDiagnosticsTextCarriesKindOwnerMessageAndDetail() {
        let problem = LeoLinkProblem.from(error: GatewayError.http(status: 502, message: nil))
        XCTAssertTrue(problem.diagnosticsText.contains(problem.kind.rawValue))
        XCTAssertTrue(problem.diagnosticsText.contains(problem.owner.blame))
        XCTAssertTrue(problem.diagnosticsText.contains(problem.message))
        XCTAssertTrue(problem.diagnosticsText.contains("HTTP 502"))
    }

    func testServerMessageIsShownForBusinessErrorsButSanitized() {
        let problem = LeoLinkProblem.from(error: GatewayError.http(status: 400, message: "Invalid choice; expected one of: once, deny"))
        XCTAssertEqual(problem.kind, .unknown)
        XCTAssertTrue(problem.message.contains("400"))
        XCTAssertTrue(problem.message.contains("Invalid choice"))
        let capped = LeoLinkProblem.from(error: GatewayError.http(status: 409, message: String(repeating: "很长的服务端说明", count: 30)))
        XCTAssertLessThan(capped.message.count, 120)
    }

    // MARK: 暂停 / 恢复

    private func problem(_ status: Int, _ message: String? = nil) -> LeoLinkProblem {
        LeoLinkProblem.from(error: GatewayError.http(status: status, message: message))
    }

    func testBookPausesOnUserActionProblemsAndResumesOnUserAction() {
        var book = LeoLinkProblemBook()
        XCTAssertFalse(book.isPaused("mac"))
        // 密钥被拒:要用户处理 → 暂停自动重连 / 轮询
        book.record(problem(401), for: "mac")
        XCTAssertTrue(book.isPaused("mac"))
        XCTAssertEqual(book.problem(for: "mac")?.kind, .relayAuthFailed)
        // 别的主机不受影响
        XCTAssertFalse(book.isPaused("other"))
        // 用户点了主按钮:恢复轮询,但问题继续显示,直到下一次探测给出结论
        book.resume("mac")
        XCTAssertFalse(book.isPaused("mac"))
        XCTAssertEqual(book.problem(for: "mac")?.kind, .relayAuthFailed)
        // 还是不行:同样的问题再次出现 → 再次暂停
        book.record(problem(401), for: "mac")
        XCTAssertTrue(book.isPaused("mac"))
        // 连上了:问题和暂停一并清掉
        book.record(nil, for: "mac")
        XCTAssertFalse(book.isPaused("mac"))
        XCTAssertNil(book.problem(for: "mac"))
    }

    func testBookKeepsBackoffForTransientProblems() {
        var book = LeoLinkProblemBook()
        for transient in [problem(502), problem(503), problem(504),
                          LeoLinkProblem.from(error: URLError(.timedOut)),
                          LeoLinkProblem.from(error: URLError(.notConnectedToInternet))] {
            book.record(transient, for: "mac")
            XCTAssertFalse(book.isPaused("mac"), "\(transient.kind) must keep the normal backoff")
            XCTAssertNotNil(book.problem(for: "mac"), "\(transient.kind) is still shown")
        }
        // 暂停中的主机换成瞬时问题(例如重新配对后 Mac 又睡着了):不再暂停
        book.record(problem(403, "设备授权已撤销"), for: "mac")
        XCTAssertTrue(book.isPaused("mac"))
        book.record(problem(502), for: "mac")
        XCTAssertFalse(book.isPaused("mac"))
    }

    func testBookResumesEverythingWhenTheUserComesBack() {
        var book = LeoLinkProblemBook()
        book.record(problem(401), for: "a")
        book.record(problem(403, "设备授权已撤销"), for: "b")
        book.record(problem(502), for: "c")
        XCTAssertTrue(book.isPaused("a"))
        XCTAssertTrue(book.isPaused("b"))
        XCTAssertFalse(book.isPaused("c"))
        book.resumeAll()
        XCTAssertFalse(book.isPaused("a"))
        XCTAssertFalse(book.isPaused("b"))
        // 问题本身继续显示;下一次失败会重新暂停
        XCTAssertNotNil(book.problem(for: "a"))
        book.record(problem(401), for: "a")
        XCTAssertTrue(book.isPaused("a"))
    }

    func testBookEqualityLetsStoreSkipRedundantPublishes() {
        var a = LeoLinkProblemBook()
        var b = LeoLinkProblemBook()
        a.record(problem(502), for: "mac")
        b.record(problem(502), for: "mac")
        XCTAssertEqual(a, b)
        b.record(problem(401), for: "mac")
        XCTAssertNotEqual(a, b)
    }
}
