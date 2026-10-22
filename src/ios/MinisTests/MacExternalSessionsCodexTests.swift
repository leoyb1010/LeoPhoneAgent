import XCTest

/// [codex-sessions] Mac 列表里的 Codex 会话(agent "codex"):解析、接管请求体与回执(契约 src/mac/leophone/docs/specs/leo-link-takeover.md)。
final class MacExternalSessionsCodexTests: XCTestCase {
    typealias W = MacExternalSessionsWire

    private func json(_ raw: String) throws -> [String: Any] {
        try XCTUnwrap(JSONSerialization.jsonObject(with: Data(raw.utf8)) as? [String: Any])
    }

    func testCodexRowsParseBesideClaude() throws {
        let rows = W.parseList(try json("""
        {"sessions":[
          {"id":"01a1638d-f2b7-7fa2-8957-4335c0663a63","agent":"codex","cwd":"/Users/me/Documents/Codex/2026-10-22/cho",
           "title":"查询重置卡过期时间","updated_at":"2026-10-22T13:39:05.123Z","running":true,"busy":true},
          {"id":"11111111-1111-4111-8111-111111111111","agent":"claude","cwd":"/Users/me/code/app","title":"改按钮",
           "updated_at":"2026-10-22T10:00:00Z","running":false},
          {"id":"019a0000-0000-7000-8000-000000000001","agent":"codex","cwd":"/work/cli","title":"",
           "updated_at":"2026-10-21T08:00:00Z","running":false,"busy":false,"leobot_session_id":"task-3"}
        ]}
        """))
        XCTAssertEqual(rows.map(\.agent), ["codex", "claude", "codex"])
        XCTAssertEqual(rows[0].id, "01a1638d-f2b7-7fa2-8957-4335c0663a63")
        XCTAssertEqual(rows[0].displayTitle, "查询重置卡过期时间")
        XCTAssertEqual(rows[0].folderName, "cho")
        XCTAssertTrue(rows[0].running)
        XCTAssertNotNil(rows[0].updatedAt)
        XCTAssertEqual(rows[2].displayTitle, "cli", "没有标题时用目录名")
        XCTAssertEqual(rows[2].leobotSessionId, "task-3")
    }

    func testCodexTakeoverBodyAndResult() throws {
        let session = W.parseList(try json("""
        {"sessions":[{"id":"01a1638d-f2b7-7fa2-8957-4335c0663a63","agent":"codex","cwd":"/work/cho","title":"查过期","running":false}]}
        """))[0]
        let spec = try XCTUnwrap(W.takeoverBody(session)["resume_external"] as? [String: String])
        XCTAssertEqual(spec, ["agent": "codex", "session_id": "01a1638d-f2b7-7fa2-8957-4335c0663a63"])

        let result = try XCTUnwrap(W.parseTakeover(try json("""
        {"session_id":"task-1","harness":"codex","status":"idle","mode":"build","name":"Codex","cwd":"/work/cho",
         "title":"查过期","seq":9,"external_session_id":"01a1638d-f2b7-7fa2-8957-4335c0663a63"}
        """), fallback: session))
        XCTAssertEqual(result, MacTakeoverResult(sessionId: "task-1", harness: "codex", name: "Codex", cwd: "/work/cho",
                                                 title: "查过期", status: "idle", seq: 9, mode: "build",
                                                 terminalRunning: false, reused: false))
        // 回执缺 harness:用列表那一行的 agent,会话页按 codex 打开
        XCTAssertEqual(W.parseTakeover(["session_id": "task-1"], fallback: session)?.harness, "codex")
    }
}
