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
    func testCommentAuthorUsesValidUserAgentOrUnknown() throws {
        let cases: [([String: String], String)] = [
            ([:], "未知作者"),
            (["authorUserId": "", "authorAgentId": "   "], "未知作者"),
            (["authorUserId": "human"], "用户回复"),
            (["authorAgentId": "agent"], "智能体回复"),
            (["authorUserId": "human", "authorAgentId": "agent"], "未知作者")
        ]
        for (authors, expected) in cases {
            var row = ["id": "comment", "companyId": "company", "issueId": "issue", "body": "内容"]
            row.merge(authors) { _, new in new }
            let comment = try JSONDecoder().decode(PaperclipComment.self, from: JSONSerialization.data(withJSONObject: row))
            XCTAssertEqual(comment.authorLabel, expected)
        }
    }

    func testChineseLabelsNeverExposeUnknownWireStatus() {
        XCTAssertEqual(IOSExecutionBackend.local.title, "本机")
        XCTAssertEqual(PaperclipLabels.status("future_status"), "未知状态")
        for status in PaperclipIssueStatus.allCases { XCTAssertNotEqual(status.title, status.rawValue) }
    }
    func testCreateRetryStopsBeforeServerSevenDayKeyExpiry() {
        let now = Date(timeIntervalSince1970: 2_000_000)
        var draft = PaperclipDraft()
        XCTAssertTrue(draft.canRetryCreate(now: now))
        draft.submitted = true
        XCTAssertFalse(draft.canRetryCreate(now: now))
        draft.firstSubmittedAt = now.addingTimeInterval(-60)
        XCTAssertTrue(draft.canRetryCreate(now: now))
        draft.firstSubmittedAt = now.addingTimeInterval(-6 * 24 * 60 * 60)
        XCTAssertFalse(draft.canRetryCreate(now: now))
        draft.firstSubmittedAt = now.addingTimeInterval(1)
        XCTAssertFalse(draft.canRetryCreate(now: now))
    }

    func testManualDraftReleaseKeepsDiagnosticRecordWithoutResending() throws {
        let suite = "paperclip.archive-test.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        var draft = PaperclipDraft()
        draft.title = "已核对任务"; draft.body = "原始内容"; draft.submitted = true
        draft.firstSubmittedAt = Date(timeIntervalSince1970: 1_000)
        draft.save(key: "fixture", defaults: defaults)
        draft.archive(key: "fixture", defaults: defaults)
        let archived = try XCTUnwrap(PaperclipDraft.lastChecked(key: "fixture", defaults: defaults))
        XCTAssertEqual(archived.requestID, draft.requestID)
        XCTAssertEqual(archived.body, draft.body)
        XCTAssertEqual(archived.firstSubmittedAt, draft.firstSubmittedAt)
        XCTAssertFalse(PaperclipDraft.load(key: "fixture", defaults: defaults).submitted)
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
}
