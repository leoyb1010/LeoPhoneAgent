import XCTest

/// [fix-remote] M / N：直连 → 中继 → SSH 的路径状态机、SSH 目标、各 CLI 的无界面参数与输出解析、fake-ip 提示。
final class MacRouteFallbackTests: XCTestCase {
    private let t0 = Date(timeIntervalSince1970: 1_000_000)

    func testOrderPrefersDirectThenRelayThenSSHAndCoolsDownFailures() {
        var selector = MacRouteSelector()
        XCTAssertEqual(selector.order(now: t0, sshAvailable: true), [.direct, .relay, .ssh])
        XCTAssertEqual(selector.order(now: t0, sshAvailable: false), [.direct, .relay])

        selector.record(.direct, success: false, now: t0)
        selector.record(.relay, success: true, latencyMilliseconds: 480, now: t0)
        XCTAssertEqual(selector.current, .relay)
        XCTAssertEqual(selector.latencyMilliseconds, 480)
        // 直连冷却中：先中继；冷却过了直连又排回第一。
        XCTAssertEqual(selector.order(now: t0.addingTimeInterval(5), sshAvailable: true), [.relay, .ssh, .direct])
        XCTAssertEqual(selector.order(now: t0.addingTimeInterval(31), sshAvailable: true), [.direct, .relay, .ssh])

        // 中继也坏了：SSH 先上；全都冷却时仍然全试（宁可慢不能没路）。
        selector.record(.relay, success: false, now: t0.addingTimeInterval(6))
        XCTAssertNil(selector.current)
        XCTAssertEqual(selector.order(now: t0.addingTimeInterval(7), sshAvailable: true), [.ssh, .direct, .relay])
        selector.record(.ssh, success: true, latencyMilliseconds: 900, now: t0.addingTimeInterval(8))
        XCTAssertEqual(selector.current, .ssh)
    }

    func testBetterRouteWinsAndWorseOneDoesNotStealIt() {
        var selector = MacRouteSelector()
        selector.record(.direct, success: true, latencyMilliseconds: 40, now: t0)
        selector.record(.relay, success: true, latencyMilliseconds: 500, now: t0)
        XCTAssertEqual(selector.current, .direct, "中继的成功不会顶掉直连")
        XCTAssertEqual(selector.latencyMilliseconds, 40)
    }

    func testReprobeOnlyWhileOnASecondBestRoute() {
        var selector = MacRouteSelector()
        selector.record(.direct, success: true, now: t0)
        XCTAssertFalse(selector.shouldReprobe(now: t0))
        selector.record(.direct, success: false, now: t0)
        selector.record(.relay, success: true, now: t0)
        XCTAssertTrue(selector.shouldReprobe(now: t0))
        selector.markProbed(now: t0)
        XCTAssertFalse(selector.shouldReprobe(now: t0.addingTimeInterval(30)))
        XCTAssertTrue(selector.shouldReprobe(now: t0.addingTimeInterval(61)))
    }

    func testSSHTargetPrefersAdvertisedThenOverrideThenBuiltInMap() {
        let advertised = MacSSHTarget.parse(["host": "leomac-studio", "user": "leoyuan", "fqdn": "leomac-studio.tail23de22.ts.net"])
        XCTAssertEqual(advertised?.address, "leomac-studio.tail23de22.ts.net")
        XCTAssertNil(MacSSHTarget.parse(["host": "bad host;rm", "user": "leo"]))
        XCTAssertNil(MacSSHTarget.parse(["host": "ok", "user": "-oProxyCommand"]))
        let override = MacSSHTarget(host: "custom", user: "me")
        XCTAssertEqual(MacSSHTarget.resolve(advertised: advertised, override: override, machine: "LeodeMac-mini-2"), advertised)
        XCTAssertEqual(MacSSHTarget.resolve(advertised: nil, override: override, machine: "LeodeMac-mini-2"), override)
        XCTAssertEqual(MacSSHTarget.resolve(advertised: nil, override: nil, machine: "LeodeMac-mini-2"),
                       MacSSHTarget(host: "mac-mini-cortex", user: "leo"))
        XCTAssertEqual(MacSSHTarget.defaults["LeoyuanAir"], MacSSHTarget(host: "leoyuanair", user: "admin"))
        XCTAssertNil(MacSSHTarget.resolve(advertised: nil, override: nil, machine: "unknown"))
    }

    func testHeadlessCommandsAreQuotedAndUseEachCLIsOwnFlags() throws {
        let tricky = "说 'hi'; rm -rf ~"
        let claude = try XCTUnwrap(SSHFallbackCLI.command(key: "claude", prompt: tricky, cwd: "~/proj dir"))
        XCTAssertTrue(claude.hasPrefix("/bin/zsh -lc '"))
        XCTAssertTrue(claude.contains("--output-format stream-json --verbose"))
        XCTAssertTrue(claude.contains("claude-oauth-token"))
        // 按 sh 的单引号规则拆两层：外层是 zsh -lc 的脚本，脚本里 claude -p 的参数还原出来必须是原样的提示词。
        let script = try XCTUnwrap(Self.unquoteSingle(String(claude.dropFirst("/bin/zsh -lc ".count))))
        let afterP = try XCTUnwrap(script.range(of: "claude -p ")).upperBound
        let promptArg = String(script[afterP...]).components(separatedBy: " --output-format")[0]
        XCTAssertEqual(Self.unquoteSingle(promptArg), tricky)
        XCTAssertTrue(script.contains("cd \"$HOME\"/'proj dir'"))
        XCTAssertTrue(try XCTUnwrap(SSHFallbackCLI.command(key: "codex", prompt: "x", cwd: "~")).contains("codex exec --json --skip-git-repo-check"))
        XCTAssertTrue(try XCTUnwrap(SSHFallbackCLI.command(key: "gemini", prompt: "x", cwd: "~")).contains("gemini -p"))
        XCTAssertTrue(try XCTUnwrap(SSHFallbackCLI.command(key: "opencode", prompt: "x", cwd: "~")).contains("opencode run"))
        XCTAssertTrue(try XCTUnwrap(SSHFallbackCLI.command(key: "grok", prompt: "x", cwd: "/tmp")).contains("grok -p"))
        XCTAssertNil(SSHFallbackCLI.command(key: "zcode", prompt: "x", cwd: "~"))
        XCTAssertFalse(SSHFallbackCLI.supports("zcode"))
    }

    /// sh 单引号串（'…' 与 \' 拼接）还原成原文；不是这种形状返回 nil。
    static func unquoteSingle(_ raw: String) -> String? {
        var out = ""
        var index = raw.startIndex
        while index < raw.endIndex {
            if raw[index] == "'" {
                guard let close = raw[raw.index(after: index)...].firstIndex(of: "'") else { return nil }
                out += raw[raw.index(after: index)..<close]
                index = raw.index(after: close)
            } else if raw[index] == "\\", raw.index(after: index) < raw.endIndex {
                out.append(raw[raw.index(after: index)])
                index = raw.index(index, offsetBy: 2)
            } else {
                return nil
            }
        }
        return out
    }

    func testOutputParsingTurnsJSONStreamsIntoReplyText() {
        XCTAssertEqual(SSHFallbackCLI.text(key: "claude", line: #"{"type":"assistant","message":{"content":[{"type":"text","text":"OK"}]}}"#), "OK")
        XCTAssertNil(SSHFallbackCLI.text(key: "claude", line: #"{"type":"system","subtype":"init"}"#))
        XCTAssertEqual(SSHFallbackCLI.text(key: "claude", line: #"{"type":"result","is_error":true,"result":"Invalid API key"}"#), "（出错）Invalid API key")
        XCTAssertEqual(SSHFallbackCLI.text(key: "codex", line: #"{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"done"}}"#), "done")
        XCTAssertNil(SSHFallbackCLI.text(key: "codex", line: #"{"type":"turn.started"}"#))
        XCTAssertEqual(SSHFallbackCLI.text(key: "gemini", line: "\u{1B}[32mhello\u{1B}[0m"), "hello")
    }

    func testFakeIPDetectionAndRules() {
        XCTAssertTrue(FakeIPAdvisor.isFakeIP("198.18.0.12"))
        XCTAssertTrue(FakeIPAdvisor.isFakeIP("198.19.255.1"))
        XCTAssertFalse(FakeIPAdvisor.isFakeIP("198.20.0.1"))
        XCTAssertFalse(FakeIPAdvisor.isFakeIP("100.81.83.56"))
        XCTAssertFalse(FakeIPAdvisor.isFakeIP("not-an-ip"))
        XCTAssertTrue(FakeIPAdvisor.shadowrocketRules.contains("DOMAIN-SUFFIX,ts.net,DIRECT"))
        XCTAssertTrue(FakeIPAdvisor.shadowrocketRules.contains("IP-CIDR,100.64.0.0/10,DIRECT,no-resolve"))
        XCTAssertTrue(FakeIPAdvisor.shadowrocketRules.contains("tun-excluded-routes = 100.64.0.0/10"))
    }
}
