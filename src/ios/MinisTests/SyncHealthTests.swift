import XCTest

final class SyncHealthTests: XCTestCase {
    func testRunningDispatcherDoesNotImplyCloudHealth() {
        var health = SyncTransportHealth()
        XCTAssertEqual(health.state, .starting)
        health.failed("initialize", error: NSError(domain: "CKErrorDomain", code: 15))
        XCTAssertEqual(health.state, .unavailable)
        health.succeeded("send")
        XCTAssertEqual(health.state, .healthy)
    }

    func testProbeSuccessDoesNotHideUploadFailure() {
        var health = SyncTransportHealth()
        health.failed("send", error: NSError(domain: "CKErrorDomain", code: 15))
        health.succeeded("probe")
        XCTAssertEqual(health.state, .degraded)
        XCTAssertNotNil(health.issues["send"])
        XCTAssertNil(health.lastSendAt)
    }

    func testTypeRecoveryClearsOnlyItsOwnFailure() {
        var health = SyncTransportHealth()
        health.succeeded("fetch")
        health.failed("query:SkillV2", error: NSError(domain: "CKErrorDomain", code: 11))
        health.failed("query:ArtifactV2", error: NSError(domain: "CKErrorDomain", code: 11))
        health.succeeded("query:SkillV2")
        XCTAssertEqual(health.state, .degraded)
        XCTAssertEqual(Set(health.issues.keys), ["query:ArtifactV2"])
        health.succeeded("query:ArtifactV2")
        XCTAssertEqual(health.state, .healthy)
    }

    func testDiagnosticDoesNotCopyRawErrorInfo() {
        let id = "19b8f52a-dbec-4b3d-a7cb-479d56b221e4"
        let inner = NSError(domain: "CKInternalErrorDomain", code: 2000)
        let error = NSError(domain: "CKErrorDomain", code: 15, userInfo: [
            NSLocalizedDescriptionKey: "Bearer private-token /private/user/path",
            "ServerErrorDescription": "private chat message",
            "RequestUUID": id,
            "CKHTTPStatus": 500,
            NSUnderlyingErrorKey: inner,
        ])
        let issue = SyncFailure(operation: "send", error: error)
        XCTAssertEqual(issue.requestID?.lowercased(), id)
        XCTAssertEqual(issue.httpStatus, 500)
        XCTAssertEqual(issue.underlyingCode, 2000)
        XCTAssertFalse(issue.diagnostic.contains("private"))
        XCTAssertFalse(issue.diagnostic.contains("Bearer"))
    }
}
