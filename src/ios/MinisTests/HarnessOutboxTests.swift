import Foundation
import XCTest

final class HarnessOutboxTests: XCTestCase {
    func testRestartRetainsOriginalIntentAndIsolatesHostAndSession() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let first = HarnessOutbox(directory: root)
        let entry = try first.record(id: UUID().uuidString, scope: "host-A/device-A", sessionId: "session-A", text: "original input", fullAuto: false)
        let restarted = HarnessOutbox(directory: root)
        XCTAssertEqual(try restarted.entries(scope: entry.scope, sessionId: entry.sessionId), [entry])
        XCTAssertTrue(try restarted.entries(scope: "host-B/device-A", sessionId: entry.sessionId).isEmpty)
        XCTAssertTrue(try restarted.entries(scope: entry.scope, sessionId: "session-B").isEmpty)
        XCTAssertThrowsError(try restarted.record(id: entry.id, scope: entry.scope, sessionId: entry.sessionId, text: "different", fullAuto: false))
        try restarted.markQueued(entry)
        let after202 = try HarnessOutbox(directory: root).entries(scope: entry.scope, sessionId: entry.sessionId)
        XCTAssertEqual(after202.first?.state, .queued)
        XCTAssertEqual(after202.first?.text, "original input")
        XCTAssertEqual(after202.first?.id, entry.id)
        XCTAssertTrue(try restarted.remove(entry))
        XCTAssertFalse(try restarted.remove(entry), "another console must not claim the same downgrade twice")
        XCTAssertTrue(try restarted.entries(scope: entry.scope, sessionId: entry.sessionId).isEmpty)
    }

    func testRemovalSyncFailureKeepsOriginalIntentForRestart() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = HarnessOutbox(directory: root, directorySync: { directory in
            // Fail the synchronization after unlink, while writes with the
            // original entry still present can complete normally.
            if try FileManager.default.contentsOfDirectory(atPath: directory.path).isEmpty {
                throw POSIXError(.EIO)
            }
        })
        let entry = try store.record(id: UUID().uuidString, scope: "A", sessionId: "A", text: "rejected original", fullAuto: true)
        XCTAssertThrowsError(try store.remove(entry))
        XCTAssertEqual(try HarnessOutbox(directory: root).entries(scope: "A", sessionId: "A"), [entry])
    }

    func testRejectedRemovalSyncFailureRecoversTextWithoutReplayState() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = HarnessOutbox(directory: root, directorySync: { directory in
            if try FileManager.default.contentsOfDirectory(atPath: directory.path).isEmpty {
                throw POSIXError(.EIO)
            }
        })
        let entry = try store.record(id: UUID().uuidString, scope: "A", sessionId: "A", text: "definitely refused", fullAuto: true)
        XCTAssertThrowsError(try store.remove(entry, rejected: true))
        let recovered = try HarnessOutbox(directory: root).entries(scope: "A", sessionId: "A")
        XCTAssertEqual(recovered.first?.text, entry.text)
        XCTAssertEqual(recovered.first?.id, entry.id)
        XCTAssertEqual(recovered.first?.state, .rejected)
        XCTAssertTrue(recovered.filter { $0.state != .rejected }.isEmpty, "refused input must be returned manually, not polled or downgraded automatically")
        XCTAssertTrue(try HarnessOutbox(directory: root).remove(entry, rejected: true))
        XCTAssertFalse(try HarnessOutbox(directory: root).remove(entry, rejected: true), "a second console cannot claim the same refusal")
    }

    func testUnknownAndExpiredResultsRequireReceiptAndNeverAuthorizeReplay() {
        for result: [String: Any] in [[:], ["status": "expired"], ["status": "failed"], ["status": "delivered"], ["status": "delivered", "http_status": 408], ["status": "delivered", "http_status": 409], ["status": "delivered", "http_status": 503]] {
            XCTAssertEqual(HarnessOutbox.relayResolution(result), .needsReceipt)
        }
        XCTAssertEqual(HarnessOutbox.relayResolution(["status": "queued"]), .pending)
        XCTAssertEqual(HarnessOutbox.relayResolution(["status": "delivered", "http_status": 200]), .completed(200))
        let id = UUID().uuidString
        XCTAssertEqual(HarnessOutbox.receiptResolution(["requestId": id, "state": "completed", "response": ["status": 200]], requestId: id), .completed(200))
        XCTAssertEqual(HarnessOutbox.receiptResolution(["requestId": id, "state": "uncertain"], requestId: id), .needsReceipt)
        XCTAssertEqual(HarnessOutbox.receiptResolution(["requestId": "another", "state": "completed", "response": ["status": 200]], requestId: id), .needsReceipt)
        XCTAssertEqual(HarnessOutbox.receiptResolution([:], requestId: id), .needsReceipt)
    }

    func testPersistenceFailureAndCorruptionAreNotSuccess() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        try Data("not a directory".utf8).write(to: root)
        let store = HarnessOutbox(directory: root)
        XCTAssertThrowsError(try store.record(id: UUID().uuidString, scope: "A", sessionId: "A", text: "must not send", fullAuto: nil))
        XCTAssertThrowsError(try store.record(id: "../../outside", scope: "A", sessionId: "A", text: "x", fullAuto: nil))
        try FileManager.default.removeItem(at: root)
        let entry = try store.record(id: UUID().uuidString, scope: "A", sessionId: "A", text: "keep", fullAuto: nil)
        let file = root.appendingPathComponent(entry.id.lowercased() + ".json")
        try Data("broken JSON".utf8).write(to: file)
        // One unreadable file is skipped (kept on disk), never hides the others.
        let healthy = try store.record(id: UUID().uuidString, scope: "A", sessionId: "A", text: "still visible", fullAuto: nil)
        XCTAssertEqual(try store.entries(scope: "A", sessionId: "A"), [healthy])
        XCTAssertTrue(FileManager.default.fileExists(atPath: file.path))
        XCTAssertThrowsError(try store.record(id: entry.id, scope: "A", sessionId: "A", text: "replacement", fullAuto: nil))
    }
}

final class HarnessOutboxIdentityTests: XCTestCase {
    func testLearningDeviceIdentityPreservesPendingOwner() {
        let initial = HarnessOutboxIdentity.initial(hostId: "host", endpoint: "https://relay/m/mac")
        let discovered = HarnessOutboxIdentity.next(existing: nil, hostId: "host",
            previousEndpoint: "https://relay/m/mac", previousDeviceId: nil,
            endpoint: "https://relay/m/mac", deviceId: "device-1", authenticatedDiscovery: true)
        XCTAssertEqual(initial, discovered)
        let restarted = HarnessOutboxIdentity.next(existing: discovered, hostId: "host",
            previousEndpoint: "https://relay/m/mac", previousDeviceId: "device-1",
            endpoint: "https://relay/m/mac", deviceId: "device-1")
        XCTAssertEqual(initial, restarted)
        XCTAssertNotEqual(initial, HarnessOutboxIdentity.initial(hostId: "other", endpoint: "https://relay/m/mac"))
    }

    func testExplicitRetargetSeparatesPendingOwner() {
        XCTAssertNotEqual(HarnessOutboxIdentity.newOwner(), HarnessOutboxIdentity.newOwner(),
                          "delete/re-add must not adopt retired input by target name")
        let initial = HarnessOutboxIdentity.initial(hostId: "host", endpoint: "https://relay/m/mac")
        let changedAddress = HarnessOutboxIdentity.next(existing: initial, hostId: "host",
            previousEndpoint: "https://relay/m/mac", previousDeviceId: "device-1",
            endpoint: "https://other/m/mac", deviceId: "device-1")
        XCTAssertNotEqual(initial, changedAddress)
        let changedDevice = HarnessOutboxIdentity.next(existing: initial, hostId: "host",
            previousEndpoint: "https://relay/m/mac", previousDeviceId: "device-1",
            endpoint: "https://relay/m/mac", deviceId: "device-2", authenticatedDiscovery: true)
        XCTAssertNotEqual(initial, changedDevice)
        let verifiedRouteUpdate = HarnessOutboxIdentity.next(existing: initial, hostId: "host",
            previousEndpoint: "https://relay/m/mac", previousDeviceId: "device-1",
            endpoint: "https://same-device-direct", deviceId: "device-1", authenticatedDiscovery: true)
        XCTAssertEqual(initial, verifiedRouteUpdate)
    }
}
