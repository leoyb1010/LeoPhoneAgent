import XCTest

/// [fix-remote] harness 列表完全以 Mac 返回为准：不过滤 opencode / gemini / grok，不可用的带原因。
final class HarnessCatalogTests: XCTestCase {
    func testParseKeepsEveryHarnessTheMacReportsInOrder() {
        let kinds = HarnessCatalog.parse([
            ["key": "zcode", "name": "LeoBot", "available": true],
            ["key": "claude", "name": "Claude Code", "available": true, "version": "2.1.301 (Claude Code)"],
            ["key": "opencode", "name": "opencode", "available": true, "cli_path": "/Users/me/.opencode/bin/opencode"],
            ["key": "gemini", "name": "Gemini", "available": false, "unavailable_reason": "本机没有找到 gemini 命令"],
            ["key": "grok", "name": "Grok", "available": true],
            ["key": "newagent", "name": "Some New Agent"],
            ["key": "grok", "name": "dup"],
            ["name": "no key"],
        ])
        XCTAssertEqual(kinds.map(\.key), ["zcode", "claude", "opencode", "gemini", "grok", "newagent"])
        XCTAssertEqual(kinds[3].available, false)
        XCTAssertEqual(kinds[3].statusLine, "本机没有找到 gemini 命令")
        XCTAssertEqual(kinds[1].statusLine, "2.1.301 (Claude Code)")
        XCTAssertTrue(kinds[5].available, "旧版 Mac 不报 available = 能用")
        XCTAssertEqual(kinds[5].displayName, "Some New Agent")
        XCTAssertEqual(kinds[0].displayName, "LeoBot")
        XCTAssertEqual(kinds[4].symbol, "bolt")
    }

    func testComposerMenuUsesTheMacsListAndHidesUnavailable() {
        let known = HarnessCatalog.parse([
            ["key": "zcode", "name": "LeoBot", "available": false, "unavailable_reason": "还没配置模型"],
            ["key": "opencode", "name": "opencode"],
            ["key": "grok", "name": "Grok"],
        ])
        XCTAssertEqual(HarnessCatalog.menuOptions(known: known, runsLeoPhoneAgent: true, isAndroidBody: false).map(\.0),
                       ["opencode", "grok"])
        XCTAssertEqual(HarnessCatalog.menuOptions(known: nil, runsLeoPhoneAgent: true, isAndroidBody: false).map(\.0),
                       ["zcode", "claude", "codex", "grok"])
        XCTAssertEqual(HarnessCatalog.menuOptions(known: known, runsLeoPhoneAgent: true, isAndroidBody: true).map(\.0),
                       ["minis"])
    }

    func testHarnessKindRoundTripsThroughHostStorage() throws {
        let kind = HarnessKind(key: "grok", name: "Grok", available: false, unavailableReason: "x", version: "1.0", cliPath: "/p")
        let decoded = try JSONDecoder().decode(HarnessKind.self, from: JSONEncoder().encode(kind))
        XCTAssertEqual(decoded, kind)
    }

    func testAuthStateAndLoginFlowParsing() {
        let kinds = HarnessCatalog.parse([
            ["key": "grok", "name": "Grok", "auth": ["logged_in": false, "login_kind": "device"]],
            ["key": "claude", "name": "Claude Code", "auth": ["logged_in": NSNull(), "login_kind": "auth_code"]],
            ["key": "codex", "name": "Codex"],
        ])
        XCTAssertEqual(kinds[0].loggedIn, false)
        XCTAssertTrue(kinds[0].canLogin)
        XCTAssertNil(kinds[1].loggedIn)
        XCTAssertFalse(kinds[2].canLogin, "旧版 Mac 不报 auth：不显示登录")

        let device = AgentLoginFlow.parse([
            "flow_id": "f1", "status": "waiting_for_user", "url": "https://accounts.x.ai/oauth2/device?user_code=FARH-KCGZ",
            "user_code": "FARH-KCGZ", "needs_code": false,
        ])
        XCTAssertEqual(device?.userCode, "FARH-KCGZ")
        XCTAssertEqual(device?.url?.host, "accounts.x.ai")
        XCTAssertEqual(device?.isFinished, false)
        let claude = AgentLoginFlow.parse(["flow_id": "f2", "status": "verifying", "needs_code": true, "code_kind": "auth_code",
                                           "url": "javascript:alert(1)"])
        XCTAssertNil(claude?.url, "只打开 https")
        XCTAssertEqual(claude?.needsCode, true)
        XCTAssertNil(AgentLoginFlow.parse(["flow_id": "x", "status": "weird"]))
        XCTAssertTrue(AgentLoginFlow.failureNeedsLogin("Grok 在这台 Mac 上未登录或读不到登录态：在这台 Mac 的终端运行 grok login --device-auth"))
        XCTAssertFalse(AgentLoginFlow.failureNeedsLogin("Codex 出错：rate limited"))
    }
}
