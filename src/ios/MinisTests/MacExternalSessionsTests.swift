import XCTest

/// [takeover] 接管 Mac 终端里的 Claude Code 会话:列表与回执的线格式(契约 src/mac/leophone/docs/specs/leo-link-takeover.md)。
final class MacExternalSessionsTests: XCTestCase {
    typealias W = MacExternalSessionsWire

    private func json(_ raw: String) throws -> [String: Any] {
        try XCTUnwrap(JSONSerialization.jsonObject(with: Data(raw.utf8)) as? [String: Any])
    }

    func testParseListKeepsOrderAndFields() throws {
        let rows = W.parseList(try json("""
        {"sessions":[
          {"id":"11111111-1111-4111-8111-111111111111","agent":"claude","cwd":"/Users/me/code/app","title":"把登录页按钮改蓝",
           "updated_at":"2026-10-20T03:30:00.123Z","running":true},
          {"id":"22222222-2222-4222-8222-222222222222","agent":"claude","cwd":"/Users/me","title":"",
           "updated_at":"2026-10-20T02:00:00Z","running":false,"leobot_session_id":"sess_9"},
          {"agent":"claude","cwd":"/x"},
          {"id":"","cwd":"/y"}
        ]}
        """))
        XCTAssertEqual(rows.map(\.id), ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"])
        XCTAssertEqual(rows[0].folderName, "app")
        XCTAssertEqual(rows[0].displayTitle, "把登录页按钮改蓝")
        XCTAssertTrue(rows[0].running)
        XCTAssertNil(rows[0].leobotSessionId)
        XCTAssertEqual(rows[0].updatedAt?.timeIntervalSince1970 ?? 0, 1792467000.123, accuracy: 0.01)
        XCTAssertEqual(rows[1].folderName, "~", "主目录显示 ~")
        XCTAssertEqual(rows[1].displayTitle, "~", "没有标题时用目录名")
        XCTAssertEqual(rows[1].leobotSessionId, "sess_9")
        XCTAssertNotNil(rows[1].updatedAt, "不带小数秒的时间也认")
        XCTAssertEqual(W.parseList([:]).count, 0)
    }

    func testTakeoverBodyAndResult() throws {
        let session = W.parseList(try json("""
        {"sessions":[{"id":"11111111-1111-4111-8111-111111111111","agent":"claude","cwd":"/Users/me/code/app","title":"改按钮","running":true}]}
        """))[0]
        let body = W.takeoverBody(session)
        let spec = try XCTUnwrap(body["resume_external"] as? [String: String])
        XCTAssertEqual(spec, ["agent": "claude", "session_id": "11111111-1111-4111-8111-111111111111"])

        let created = try XCTUnwrap(W.parseTakeover(try json("""
        {"session_id":"sess_1","harness":"claude","status":"idle","full_auto":false,"mode":"build","name":"Claude Code",
         "cwd":"/Users/me/code/app","title":"改按钮","seq":12,"external_session_id":"11111111-1111-4111-8111-111111111111",
         "warning":"terminal_running"}
        """), fallback: session))
        XCTAssertEqual(created, MacTakeoverResult(sessionId: "sess_1", harness: "claude", name: "Claude Code",
                                                  cwd: "/Users/me/code/app", title: "改按钮", status: "idle", seq: 12,
                                                  mode: "build", terminalRunning: true, reused: false))

        // 回执字段不全:用列表那一行补;reused 照实
        let reused = try XCTUnwrap(W.parseTakeover(["session_id": "sess_1", "reused": true], fallback: session))
        XCTAssertEqual(reused.harness, "claude")
        XCTAssertEqual(reused.cwd, "/Users/me/code/app")
        XCTAssertEqual(reused.title, "改按钮")
        XCTAssertEqual(reused.status, "idle")
        XCTAssertTrue(reused.reused)
        XCTAssertFalse(reused.terminalRunning)
        XCTAssertNil(W.parseTakeover(["error": ["message": "x"]], fallback: session), "没有 session_id 不算接上")
    }

    func testResumeFailedNoteIsProminent() {
        // Mac 发 {"event":"session.note","kind":"resume_failed","text":…};事件解析把字段摊平成字符串字典
        XCTAssertTrue(W.isProminentNote(["event": "session.note", "kind": "resume_failed", "text": "没能接上终端里的那个会话"]))
        XCTAssertFalse(W.isProminentNote(["event": "session.note", "text": "手机暂时答不了的提问已跳过"]), "普通说明照旧灰色小字")
    }
}
