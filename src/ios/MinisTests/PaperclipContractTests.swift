import Foundation
import XCTest

final class PaperclipContractTests: XCTestCase {
    func testOnlyHTTPSOriginIsAccepted() throws {
        let profile = try PaperclipProfile(name: "测试", address: " HTTPS://EXAMPLE.COM:443/ ")
        XCTAssertEqual(profile.origin.absoluteString, "https://example.com")
        XCTAssertEqual(try profile.url("/api/health").absoluteString, "https://example.com/api/health")
        for bad in ["http://example.com", "https://user:pass@example.com", "https://example.com/api", "https://example.com?key=x", "https://example.com#part", "file:///etc/passwd", "", "https://example.com:0"] {
            XCTAssertThrowsError(try PaperclipProfile(name: "测试", address: bad), bad)
        }
    }
    func testIdentifiersCannotEscapeAPIPath() {
        for bad in ["", "..", "a/b", "a?b", "a#b", "a%2Fb", "a\\b"] {
            XCTAssertThrowsError(try PaperclipProfile.component(bad))
        }
        XCTAssertEqual(try PaperclipProfile.component("ABC-123_uuid"), "ABC-123_uuid")
    }
    func testTaskIdentityPinsProfileOriginCompanyAndHumanUser() throws {
        let p = try PaperclipProfile(name: "甲", address: "https://a.example")
        let r = PaperclipTaskReference(profileID: p.id, origin: p.origin, companyID: "company", userID: "human", issueID: "issue")
        XCTAssertNoThrow(try r.validate(profile: p, companyID: "company", userID: "human"))
        XCTAssertThrowsError(try r.validate(profile: p, companyID: "other", userID: "human"))
        XCTAssertThrowsError(try r.validate(profile: p, companyID: "company", userID: "agent"))
        XCTAssertThrowsError(try r.validate(profile: PaperclipProfile(name: "甲", address: "https://a.example"), companyID: "company", userID: "human"))
        XCTAssertThrowsError(try r.validate(profile: PaperclipProfile(id: p.id, name: "甲", address: "https://b.example"), companyID: "company", userID: "human"))
    }
    func testHumanSessionRequiresMatchingUserAndSupportsEnvelope() throws {
        let session = #"{"session":{"id":"session","userId":"human"},"user":{"id":"human","name":"测试用户"}}"#
        XCTAssertEqual(try PaperclipSession.decode(Data(session.utf8)).user.id, "human")
        XCTAssertEqual(try PaperclipSession.decode(Data("{\"data\":\(session)}".utf8)).user.id, "human")
        for bad in ["null", "{}", #"{"actor":{"type":"agent"}}"#, session.replacingOccurrences(of: "\"userId\":\"human\"", with: "\"userId\":\"other\"")] {
            XCTAssertThrowsError(try PaperclipSession.decode(Data(bad.utf8)))
        }
    }
    func testPinnedHistoricalRunsUseRunIDNotLiveRunID() throws {
        let fixture = #"[{"runId":"run-1","status":"succeeded","agentId":"agent","startedAt":null,"finishedAt":null}]"#
        XCTAssertEqual(try JSONDecoder().decode([PaperclipRun].self, from: Data(fixture.utf8)).first?.id, "run-1")
        XCTAssertThrowsError(try JSONDecoder().decode([PaperclipRun].self, from: Data(fixture.replacingOccurrences(of: "runId", with: "id").utf8)))
    }
    func testChineseLabelsNeverExposeUnknownWireStatus() {
        XCTAssertEqual(IOSExecutionBackend.local.title, "本机")
        XCTAssertEqual(PaperclipLabels.status("future_status"), "未知状态")
        for status in PaperclipIssueStatus.allCases { XCTAssertNotEqual(status.title, status.rawValue) }
    }
    func testPendingDraftRetainsIdAcrossRestartAndIsIdentityScoped() throws {
        let suite = "paperclip.test.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let p = try PaperclipProfile(name: "测试", address: "https://example.com")
        let key = PaperclipDraft.key(profile: p, companyID: "c", userID: "u")
        var draft = PaperclipDraft(); draft.title = "测试任务"; draft.submitted = true
        draft.save(key: key, defaults: defaults)
        let reopened = PaperclipDraft.load(key: key, defaults: defaults)
        XCTAssertEqual(reopened.requestID, draft.requestID)
        XCTAssertTrue(reopened.submitted)
        XCTAssertNotEqual(key, PaperclipDraft.key(profile: p, companyID: "c", userID: "other"))
        XCTAssertNotEqual(key, PaperclipDraft.key(profile: p, companyID: "other", userID: "u"))
        PaperclipDraft.clear(key: key, defaults: defaults)
        XCTAssertFalse(PaperclipDraft.load(key: key, defaults: defaults).submitted)
    }

    func testCreationRetryExpiresWithServerIdempotencyWindowAndRejectsLegacyTime() throws {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        var draft = PaperclipDraft()
        XCTAssertTrue(draft.canRetryCreation(now: now))
        let firstSubmission = now.addingTimeInterval(-6 * 24 * 60 * 60)
        draft.markSubmitted(now: firstSubmission)
        draft.markSubmitted(now: now)
        XCTAssertEqual(draft.submittedAt, firstSubmission, "重试不能延长服务器的去重期限")
        draft.submittedAt = nil
        draft.submitted = true
        XCTAssertFalse(draft.canRetryCreation(now: now), "旧草稿没有可信提交时间，不能重发创建")
        draft.submittedAt = now.addingTimeInterval(-6 * 24 * 60 * 60)
        XCTAssertTrue(draft.canRetryCreation(now: now))
        draft.submittedAt = now.addingTimeInterval(-7 * 24 * 60 * 60)
        XCTAssertFalse(draft.canRetryCreation(now: now))
        draft.submittedAt = now.addingTimeInterval(60)
        XCTAssertFalse(draft.canRetryCreation(now: now), "时钟倒退不能扩大去重窗口")
        let legacy = #"{"requestID":"11111111-1111-1111-1111-111111111111","title":"待核对任务","body":"保留正文","agentID":"","submitted":true}"#
        let restored = try JSONDecoder().decode(PaperclipDraft.self, from: Data(legacy.utf8))
        XCTAssertFalse(restored.canRetryCreation(now: now))
        XCTAssertEqual(restored.body, "保留正文")
        draft.submittedAt = now
        let roundTrip = try JSONDecoder().decode(PaperclipDraft.self, from: JSONEncoder().encode(draft))
        XCTAssertEqual(roundTrip.submittedAt, now)
    }

    func testLoginNavigationPinsHTTPSHostAndPort() throws {
        let origin = try PaperclipProfile(name: "测试", address: "https://example.com:8443").origin
        XCTAssertTrue(PaperclipProfile.sameOrigin(URL(string: "https://example.com:8443/auth?next=/")!, origin))
        for url in ["https://other.example/auth", "https://example.com/auth", "http://example.com:8443/auth", "file:///tmp/auth"] {
            XCTAssertFalse(PaperclipProfile.sameOrigin(URL(string: url)!, origin))
        }
    }

    func testDefiniteMutationRejectionRestoresEditableDraftWithoutDiscardingText() {
        var draft = PaperclipDraft()
        draft.body = "需要修改的正文"
        draft.submitted = true
        draft.submittedAt = Date()
        draft.recordFailure(PaperclipError.http(422), wasPreviouslySubmitted: false)
        XCTAssertFalse(draft.submitted)
        XCTAssertNil(draft.submittedAt)
        XCTAssertEqual(draft.body, "需要修改的正文")
        draft.submitted = true
        draft.recordFailure(PaperclipError.uncertain, wasPreviouslySubmitted: false)
        XCTAssertTrue(draft.submitted)
        let originalTime = Date(timeIntervalSince1970: 1_800_000_000)
        draft.submittedAt = originalTime
        draft.recordFailure(PaperclipError.signedOut, wasPreviouslySubmitted: true)
        XCTAssertTrue(draft.submitted, "重试时登录失效不能证明原提交未被接收")
        XCTAssertEqual(draft.submittedAt, originalTime)
    }
}
