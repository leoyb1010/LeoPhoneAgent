import Foundation
import SQLite3
import XCTest

@MainActor
final class AgentRunReceiptTests: XCTestCase {
    private func databaseURL() throws -> URL {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: folder) }
        return folder.appendingPathComponent("receipts.sqlite")
    }

    func testLateProgressCannotReopenFinishedRun() throws {
        let log = AgentActivityLog(databaseURL: try databaseURL())
        XCTAssertTrue(log.append(.init(runId: "run", sessionId: "s", kind: .runStarted, phase: .preparing)))
        XCTAssertTrue(log.append(.init(runId: "run", sessionId: "s", kind: .runFinished, phase: .failed)))
        XCTAssertFalse(log.append(.init(runId: "run", sessionId: "s", kind: .toolChanged, phase: .thinking)))
        XCTAssertEqual(log.runState(runId: "run")?.phase, .failed)
    }

    func testReceiptIsReadByRunEvenAfterAnotherRunStarts() throws {
        let log = AgentActivityLog(databaseURL: try databaseURL())
        log.append(.init(runId: "first", sessionId: "s", kind: .runStarted, phase: .preparing))
        log.append(.init(runId: "first", sessionId: "s", kind: .runFinished, phase: .completed,
                         resultMessageId: "first-result"))
        log.append(.init(runId: "second", sessionId: "s", kind: .runStarted, phase: .preparing))
        XCTAssertEqual(log.runState(runId: "first")?.phase, .completed)
        XCTAssertEqual(log.runState(runId: "first")?.resultMessageId, "first-result")
        XCTAssertEqual(log.latestRunState(sessionId: "s")?.runId, "second")
    }

    func testRunStateWriteFailureRollsBackEventAndNeverReportsDurableSuccess() throws {
        let url = try databaseURL()
        let log = AgentActivityLog(databaseURL: url)
        log.append(.init(runId: "run", sessionId: "s", kind: .runStarted, phase: .preparing))
        var db: OpaquePointer?
        XCTAssertEqual(sqlite3_open(url.path, &db), SQLITE_OK)
        defer { sqlite3_close(db) }
        XCTAssertEqual(sqlite3_exec(db, "CREATE TRIGGER refuse_finish BEFORE UPDATE ON agent_run_state BEGIN SELECT RAISE(ABORT, 'injected write failure'); END", nil, nil, nil), SQLITE_OK)
        XCTAssertFalse(log.append(.init(runId: "run", sessionId: "s", kind: .runFinished, phase: .completed)))
        XCTAssertEqual(log.runState(runId: "run")?.phase, .preparing)
        XCTAssertEqual(log.recent(sessionId: "s").count, 1)
        XCTAssertFalse(log.persistenceAvailable)
    }
}
