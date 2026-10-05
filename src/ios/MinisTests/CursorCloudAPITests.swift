import XCTest

final class CursorCloudAPITests: XCTestCase {
    private let connected = [
        "https://github.com/leoyb1010/LeoPhoneAgent",
        "https://github.com/leoyb1010/leonote",
        "https://github.com/other/leonote",
    ]

    func testAuthorizationIsBasicWithEmptyPassword() {
        let header = CursorCloudAPI.authorizationHeader(apiKey: "crsr_abc")
        XCTAssertEqual(header, "Basic " + Data("crsr_abc:".utf8).base64EncodedString())
    }

    func testFullURLPassesThroughWithoutGitSuffix() {
        XCTAssertEqual(CursorCloudAPI.resolveRepo("https://gitlab.example.com/g/r.git/", connected: []),
                       .resolved("https://gitlab.example.com/g/r"))
    }

    func testHostPrefixedPathGetsScheme() {
        XCTAssertEqual(CursorCloudAPI.resolveRepo("github.com/a/b", connected: []),
                       .resolved("https://github.com/a/b"))
    }

    func testOwnerRepoPrefersConnectedSpelling() {
        XCTAssertEqual(CursorCloudAPI.resolveRepo("leoyb1010/leophoneagent", connected: connected),
                       .resolved("https://github.com/leoyb1010/LeoPhoneAgent"))
    }

    func testOwnerRepoNotConnectedFallsBackToGitHub() {
        XCTAssertEqual(CursorCloudAPI.resolveRepo("someone/tool", connected: connected),
                       .resolved("https://github.com/someone/tool"))
    }

    func testBareNameMustMatchExactlyOneConnectedRepo() {
        XCTAssertEqual(CursorCloudAPI.resolveRepo("LeoPhoneAgent", connected: connected),
                       .resolved("https://github.com/leoyb1010/LeoPhoneAgent"))
        XCTAssertEqual(CursorCloudAPI.resolveRepo("leonote", connected: connected),
                       .ambiguous(["https://github.com/leoyb1010/leonote", "https://github.com/other/leonote"]))
        XCTAssertEqual(CursorCloudAPI.resolveRepo("missing", connected: connected), .notFound("missing"))
    }

    func testBareNameDoesNotMatchSuffixOfLongerName() {
        XCTAssertEqual(CursorCloudAPI.resolveRepo("note", connected: connected), .notFound("note"))
    }

    func testCreateBodyWithRepo() {
        let body = CursorCloudAPI.createAgentBody(
            prompt: "fix it", repoURL: "https://github.com/a/b", startingRef: " main ",
            modelId: "composer-2.5", autoCreatePR: true, mode: .plan)
        XCTAssertEqual((body["prompt"] as? [String: Any])?["text"] as? String, "fix it")
        let repos = body["repos"] as? [[String: Any]]
        XCTAssertEqual(repos?.first?["url"] as? String, "https://github.com/a/b")
        XCTAssertEqual(repos?.first?["startingRef"] as? String, "main")
        XCTAssertEqual(body["autoCreatePR"] as? Bool, true)
        XCTAssertEqual((body["model"] as? [String: Any])?["id"] as? String, "composer-2.5")
        XCTAssertEqual(body["mode"] as? String, "plan")
        XCTAssertNoThrow(try JSONSerialization.data(withJSONObject: body))
    }

    func testCreateBodyWithoutRepoOmitsRepoFieldsAndDefaultModel() {
        let body = CursorCloudAPI.createAgentBody(
            prompt: "hi", repoURL: nil, startingRef: "main", modelId: "auto", autoCreatePR: true, mode: .agent)
        XCTAssertNil(body["repos"])
        XCTAssertNil(body["autoCreatePR"])
        XCTAssertNil(body["model"])
        XCTAssertNil(body["mode"])
    }

    func testFollowUpBody() {
        XCTAssertNil(CursorCloudAPI.followUpBody(prompt: "more", mode: nil)["mode"])
        XCTAssertEqual(CursorCloudAPI.followUpBody(prompt: "more", mode: .agent)["mode"] as? String, "agent")
    }

    func testTerminalStatuses() {
        XCTAssertTrue(CursorCloudAPI.isTerminal(runStatus: "FINISHED"))
        XCTAssertTrue(CursorCloudAPI.isTerminal(runStatus: "error"))
        XCTAssertFalse(CursorCloudAPI.isTerminal(runStatus: "RUNNING"))
        XCTAssertFalse(CursorCloudAPI.isTerminal(runStatus: nil))
    }

    func testSummaryCarriesIdsBranchesAndTruncatedResult() {
        let agent: [String: Any] = [
            "id": "bc-1", "name": "Fix", "status": "IDLE", "url": "https://cursor.com/agents/bc-1",
            "repos": [["url": "https://github.com/a/b", "startingRef": "main"]],
        ]
        let run: [String: Any] = [
            "id": "run-1", "status": "FINISHED", "durationMs": 12_345,
            "git": ["branches": [["repoUrl": "github.com/a/b", "branch": "cursor/x", "prUrl": "https://github.com/a/b/pull/1"]]],
            "result": String(repeating: "r", count: CursorCloudAPI.maxResultChars + 10),
        ]
        let text = CursorCloudAPI.summarize(agent: agent, run: run)
        XCTAssertTrue(text.contains("agent_id: bc-1"))
        XCTAssertTrue(text.contains("run_id: run-1"))
        XCTAssertTrue(text.contains("run_status: FINISHED (terminal)"))
        XCTAssertTrue(text.contains("duration: 12.3s"))
        XCTAssertTrue(text.contains("branch: github.com/a/b → cursor/x (PR: https://github.com/a/b/pull/1)"))
        XCTAssertTrue(text.contains("repo: https://github.com/a/b @ main"))
        XCTAssertTrue(text.contains("…(truncated"))
    }

    func testSummaryWithoutRunPointsAtLatestRun() {
        let text = CursorCloudAPI.summarize(agent: ["id": "bc-1", "latestRunId": "run-9"], run: nil)
        XCTAssertTrue(text.contains("latest_run_id: run-9"))
    }

    func testListSummary() {
        XCTAssertEqual(CursorCloudAPI.summarize(list: []), "No Cursor cloud agents yet.")
        let text = CursorCloudAPI.summarize(list: [["id": "bc-1", "status": "IDLE", "name": "A", "updatedAt": "t"]])
        XCTAssertEqual(text, "- bc-1 [IDLE] A (updated t)")
    }

    func testErrorMessagesReadBothWireShapes() {
        let nested = Data(#"{"error":{"code":"agent_not_found","message":"Agent not found"}}"#.utf8)
        XCTAssertEqual(CursorCloudAPI.errorMessage(status: 404, body: nested),
                       "Cursor API 返回 HTTP 404 agent_not_found:Agent not found")
        let flat = Data(#"{"code":"error","message":"Invalid User API Key"}"#.utf8)
        XCTAssertTrue(CursorCloudAPI.errorMessage(status: 401, body: flat).contains("HTTP 401"))
        let busy = Data(#"{"error":{"code":"agent_busy","message":"busy"}}"#.utf8)
        XCTAssertTrue(CursorCloudAPI.errorMessage(status: 409, body: busy).contains("cursor_agent_status"))
    }
}
