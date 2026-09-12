import Foundation
import XCTest

final class WidgetRunReceiptTests: XCTestCase {
    func testOldObserverCannotReplaceNewRunBadge() {
        var item = WidgetQuickTaskItem(id: "task", name: "Task", symbolName: "bolt")
        item.lastRunRequestId = "new-request"
        item.lastRunId = "new-run"
        item.lastRunState = .running
        XCTAssertFalse(item.updateRun(state: .succeeded, requestId: "old-request", runId: "old-run"))
        XCTAssertEqual(item.lastRunState, .running)
        XCTAssertTrue(item.updateRun(state: .cancelled, requestId: "new-request", runId: "new-run"))
        XCTAssertEqual(item.lastRunState, .cancelled)
    }

    func testLegacySnapshotRemainsDecodableWithoutRunIdentifiers() throws {
        let data = Data(#"{"id":"task","name":"Task","symbolName":"bolt","lastRunState":"succeeded"}"#.utf8)
        let item = try JSONDecoder().decode(WidgetQuickTaskItem.self, from: data)
        XCTAssertEqual(item.lastRunState, .succeeded)
        XCTAssertNil(item.lastRunId)
        XCTAssertNil(item.lastRunRequestId)
    }
}
