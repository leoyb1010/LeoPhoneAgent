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
}
