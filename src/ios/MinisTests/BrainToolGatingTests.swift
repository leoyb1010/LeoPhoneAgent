import XCTest

/// [T-brain] 资料库工具只给有人在看的顶层对话;写工具按令牌权限给。
final class BrainToolGatingTests: XCTestCase {

    private func offered(configured: Bool = true, child: Bool = false, blocks: Bool = false,
                         source: String? = nil, remote: Bool = false, scopes: Set<String>? = nil) -> [String] {
        BrainToolGating.offeredTools(configured: configured, isSubAgentChild: child, blocksSideEffectTools: blocks,
                                     sessionSource: source, isRemote: remote, knownScopes: scopes)
    }

    func testAllToolsForAttendedTopLevelChat() {
        XCTAssertEqual(offered(), ["brain_search", "brain_read", "brain_card_save", "brain_capture"])
        XCTAssertEqual(offered(source: "chat"), BrainToolGating.allTools)
    }

    func testNotOfferedWhenUnconfigured() {
        XCTAssertTrue(offered(configured: false).isEmpty)
    }

    func testNotOfferedToSubAgentsQuietOrAutomationTurns() {
        XCTAssertTrue(offered(child: true).isEmpty)
        XCTAssertTrue(offered(blocks: true).isEmpty)
        XCTAssertTrue(offered(remote: true).isEmpty)
        for source in ["quiet", "automation", "context", "subagent", "orchestration", "shortcut", "siri", "watch"] {
            XCTAssertTrue(offered(source: source).isEmpty, source)
        }
    }

    func testScopeChecks() {
        XCTAssertEqual(BrainToolGating.requiredScope(for: "brain_card_save"), "write:cards")
        XCTAssertEqual(BrainToolGating.requiredScope(for: "brain_capture"), "write:inbox")
        XCTAssertEqual(BrainToolGating.requiredScope(for: "brain_search"), "read")
        XCTAssertEqual(offered(scopes: ["read"]), ["brain_search", "brain_read"])
        XCTAssertEqual(offered(scopes: ["read", "write:cards"]), ["brain_search", "brain_read", "brain_card_save"])
        XCTAssertEqual(offered(scopes: ["read", "write:inbox"]), ["brain_search", "brain_read", "brain_capture"])
        XCTAssertTrue(BrainToolGating.scopeDeniedMessage(tool: "brain_capture").contains("write:inbox"))
    }

    func testParseScopes() {
        XCTAssertNil(BrainToolGating.parseScopes(nil))
        XCTAssertNil(BrainToolGating.parseScopes("admin"))
        XCTAssertEqual(BrainToolGating.parseScopes(" READ , write:inbox,x"), ["read", "write:inbox"])
    }

    func testCaptureKinds() {
        XCTAssertEqual(BrainCaptureKind.allCases.map(\.rawValue), ["chat", "artifact", "recording"])
    }

    func testBrowseScopes() {
        XCTAssertEqual(BrainBrowseScope.allCases.map(\.rawValue), ["all", "phone", "archive", "cards"])
        XCTAssertNil(BrainBrowseScope.phone.searchScope)
        XCTAssertEqual(BrainBrowseScope.archive.searchScope, .files)
        XCTAssertTrue(BrainBrowseScope.all.showsPhoneItems)
        XCTAssertFalse(BrainBrowseScope.cards.showsPhoneItems)
    }
}
