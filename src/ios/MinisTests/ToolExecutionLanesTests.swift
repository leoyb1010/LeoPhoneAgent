import XCTest

final class ToolExecutionLanesTests: XCTestCase {
    private func call(_ name: String, _ args: [String: Any] = [:]) -> ToolExecutionLanes.Call {
        .init(name: name, args: args)
    }

    func testIndependentCallsStayParallel() {
        let lanes = ToolExecutionLanes.plan([
            call("shell_execute", ["command": "ls"]),
            call("file_read", ["path": "/a"]),
            call("file_read", ["path": "/a"]),
            call("browser_use", ["action": "screenshot"]),
        ])
        XCTAssertEqual(lanes, [[0], [1], [2], [3]])
    }

    func testEditsToSameFileShareOneLaneInModelOrder() {
        let lanes = ToolExecutionLanes.plan([
            call("file_edit", ["path": "/w/a.txt"]),
            call("file_read", ["path": "/w/b.txt"]),
            call("file_edit", ["path": "/w/./a.txt"]),
            call("file_read", ["path": "/w/a.txt"]),
        ])
        XCTAssertEqual(lanes, [[0, 2, 3], [1]])
    }

    func testWritesToDifferentFilesStayParallel() {
        let lanes = ToolExecutionLanes.plan([
            call("file_write", ["path": "/a"]),
            call("file_write", ["path": "/b"]),
        ])
        XCTAssertEqual(lanes, [[0], [1]])
    }

    func testReadBeforeWriteOfSamePathIsOrdered() {
        let lanes = ToolExecutionLanes.plan([
            call("file_read", ["path": "/a"]),
            call("file_write", ["path": "/a"]),
        ])
        XCTAssertEqual(lanes, [[0, 1]])
    }

    func testCursorCallsOnSameAgentSerializeOnlyWhenOneMutates() {
        XCTAssertEqual(ToolExecutionLanes.plan([
            call("cursor_agent_status", ["agent_id": "bc-1"]),
            call("cursor_agent_status", ["agent_id": "bc-1"]),
        ]), [[0], [1]])
        XCTAssertEqual(ToolExecutionLanes.plan([
            call("cursor_agent_followup", ["agent_id": "bc-1"]),
            call("cursor_agent_status", ["agent_id": "bc-2"]),
            call("cursor_agent_status", ["agent_id": "bc-1"]),
        ]), [[0, 2], [1]])
    }

    func testMissingPathNeverMerges() {
        let lanes = ToolExecutionLanes.plan([
            call("file_write"),
            call("file_write", ["path": "  "]),
        ])
        XCTAssertEqual(lanes, [[0], [1]])
    }

    func testEveryIndexAppearsExactlyOnce() {
        let calls = (0..<12).map { i in call(i % 3 == 0 ? "file_edit" : "file_read", ["path": "/p\(i % 4)"]) }
        let flat = ToolExecutionLanes.plan(calls).flatMap { $0 }
        XCTAssertEqual(flat.sorted(), Array(0..<12))
    }
}
