import Foundation
import XCTest

final class PaperclipContractTests: XCTestCase {
    func testBlockedExpectationRequiresExplicitBoundOwnerAction() throws {
        XCTAssertThrowsError(try PaperclipStatusExpectation(status: .blocked, userID: "human", unblockAction: "  "))
        XCTAssertThrowsError(try PaperclipStatusExpectation(status: .blocked, userID: "human", unblockAction: String(repeating: "😀", count: 1001)))
        let expected = try PaperclipStatusExpectation(status: .blocked, userID: "human", unblockAction: " 核对需求 ")
        let matching = #"{"id":"issue","companyId":"company","title":"任务","status":"blocked","priority":"medium","unblockDescriptor":{"owner":{"userId":"human"},"action":"核对需求"}}"#
        XCTAssertTrue(expected.matches(try JSONDecoder().decode(PaperclipIssue.self, from: Data(matching.utf8))))
        XCTAssertFalse(expected.matches(try JSONDecoder().decode(PaperclipIssue.self, from: Data(matching.replacingOccurrences(of: "human", with: "other").utf8))))
        XCTAssertFalse(expected.matches(try JSONDecoder().decode(PaperclipIssue.self, from: Data(matching.replacingOccurrences(of: "核对需求", with: "其他操作").utf8))))
    }

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
    func testBackgroundPollingStopsDuringStatusSheetReplyEditingOrBackground() {
        for active in [false, true] {
            for sheetOpen in [false, true] {
                for replyFocused in [false, true] {
                    let actual = PaperclipPollingPolicy.canRefresh(active: active, statusSheetOpen: sheetOpen, replyFocused: replyFocused)
                    XCTAssertEqual(actual, active && !sheetOpen && !replyFocused)
                }
            }
        }
    }

    func testReadPollingPreservesSavedDraftAndUnknownReceiptAcrossCompanyKeys() throws {
        let suite = "paperclip.polling-test.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let profile = try PaperclipProfile(name: "测试", address: "https://example.com")
        let firstKey = PaperclipDraft.key(profile: profile, companyID: "first", userID: "human", issueID: "issue")
        let otherKey = PaperclipDraft.key(profile: profile, companyID: "other", userID: "human", issueID: "issue")
        var draft = PaperclipDraft()
        draft.title = "保留标题"; draft.body = "保留回复"
        draft.markSubmitted(now: Date(timeIntervalSince1970: 1_800_000_000))
        draft.save(key: firstKey, defaults: defaults)
        let original = try XCTUnwrap(defaults.data(forKey: firstKey))
        XCTAssertTrue(PaperclipPollingPolicy.canRefresh(active: true, statusSheetOpen: false, replyFocused: false))
        XCTAssertEqual(defaults.data(forKey: firstKey), original)
        let restored = PaperclipDraft.load(key: firstKey, defaults: defaults)
        XCTAssertEqual(restored.requestID, draft.requestID)
        XCTAssertEqual(restored.body, draft.body)
        XCTAssertEqual(restored.firstSubmittedAt, draft.firstSubmittedAt)
        XCTAssertTrue(restored.submitted, "只读刷新不能解除未知写入或重新生成请求编号")
        XCTAssertFalse(PaperclipDraft.load(key: otherKey, defaults: defaults).submitted)
    }

    func testCommentAuthorUsesValidUserAgentOrUnknown() throws {
        let cases: [([String: String], String)] = [
            ([:], "未知作者"),
            (["authorUserId": "", "authorAgentId": "   "], "未知作者"),
            (["authorUserId": "human"], "用户消息"),
            (["authorAgentId": "agent"], "智能体消息"),
            (["authorUserId": "human", "authorAgentId": "agent"], "未知作者")
        ]
        for (authors, expected) in cases {
            var row = ["id": "comment", "companyId": "company", "issueId": "issue", "body": "内容"]
            row.merge(authors) { _, new in new }
            let comment = try JSONDecoder().decode(PaperclipComment.self, from: JSONSerialization.data(withJSONObject: row))
            XCTAssertEqual(comment.authorLabel(currentUserID: "other"), expected)
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

    func testCreationRetryExpiresWithServerIdempotencyWindowAndRejectsLegacyTime() throws {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        var draft = PaperclipDraft()
        XCTAssertTrue(draft.canRetryCreate(now: now))
        let firstSubmission = now.addingTimeInterval(-6 * 24 * 60 * 60)
        draft.markSubmitted(now: firstSubmission)
        draft.markSubmitted(now: now)
        XCTAssertEqual(draft.firstSubmittedAt, firstSubmission, "重试不能延长服务器的去重期限")
        draft.firstSubmittedAt = nil
        draft.submitted = true
        XCTAssertFalse(draft.canRetryCreate(now: now), "旧草稿没有可信提交时间，不能重发创建")
        draft.firstSubmittedAt = now.addingTimeInterval(-5 * 24 * 60 * 60)
        XCTAssertTrue(draft.canRetryCreate(now: now))
        draft.firstSubmittedAt = now.addingTimeInterval(-7 * 24 * 60 * 60)
        XCTAssertFalse(draft.canRetryCreate(now: now))
        draft.firstSubmittedAt = now.addingTimeInterval(60)
        XCTAssertFalse(draft.canRetryCreate(now: now), "时钟倒退不能扩大去重窗口")
        let legacy = #"{"requestID":"11111111-1111-1111-1111-111111111111","title":"待核对任务","body":"保留正文","agentID":"","submitted":true}"#
        let restored = try JSONDecoder().decode(PaperclipDraft.self, from: Data(legacy.utf8))
        XCTAssertFalse(restored.canRetryCreate(now: now))
        XCTAssertEqual(restored.body, "保留正文")
        draft.firstSubmittedAt = now
        let roundTrip = try JSONDecoder().decode(PaperclipDraft.self, from: JSONEncoder().encode(draft))
        XCTAssertEqual(roundTrip.firstSubmittedAt, now)
    }

    func testLoginNavigationPinsHTTPSHostAndPort() throws {
        let origin = try PaperclipProfile(name: "测试", address: "https://example.com:8443").origin
        XCTAssertTrue(PaperclipProfile.sameOrigin(URL(string: "https://example.com:8443/auth?next=/")!, origin))
        for url in ["https://other.example/auth", "https://example.com/auth", "http://example.com:8443/auth", "file:///tmp/auth"] {
            XCTAssertFalse(PaperclipProfile.sameOrigin(URL(string: url)!, origin))
        }
    }

    func testDraftTimeMigrationKeepsOneCanonicalEarliestTimestamp() throws {
        let legacy = #"{"requestID":"11111111-1111-1111-1111-111111111111","title":"待核对","body":"保留正文","agentID":"","submitted":true,"submittedAt":100}"#
        let migrated = try JSONDecoder().decode(PaperclipDraft.self, from: Data(legacy.utf8))
        XCTAssertEqual(migrated.firstSubmittedAt, Date(timeIntervalSinceReferenceDate: 100))
        let encoded = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(migrated)) as? [String: Any])
        XCTAssertNotNil(encoded["firstSubmittedAt"])
        XCTAssertNil(encoded["submittedAt"], "旧键只能用于迁移读取，不能成为第二份持久状态")
        let both = legacy.replacingOccurrences(of: #""submittedAt":100"#, with: #""submittedAt":100,"firstSubmittedAt":200"#)
        let conservative = try JSONDecoder().decode(PaperclipDraft.self, from: Data(both.utf8))
        XCTAssertEqual(conservative.firstSubmittedAt, migrated.firstSubmittedAt)
    }

    func testDefiniteMutationRejectionRestoresEditableDraftWithoutDiscardingText() {
        var draft = PaperclipDraft()
        draft.body = "需要修改的正文"
        draft.submitted = true
        draft.firstSubmittedAt = Date()
        draft.recordFailure(PaperclipError.http(422), wasPreviouslySubmitted: false)
        XCTAssertFalse(draft.submitted)
        XCTAssertNil(draft.firstSubmittedAt)
        XCTAssertEqual(draft.body, "需要修改的正文")
        draft.submitted = true
        draft.recordFailure(PaperclipError.uncertain, wasPreviouslySubmitted: false)
        XCTAssertTrue(draft.submitted)
        let originalTime = Date(timeIntervalSince1970: 1_800_000_000)
        draft.firstSubmittedAt = originalTime
        draft.recordFailure(PaperclipError.signedOut, wasPreviouslySubmitted: true)
        XCTAssertTrue(draft.submitted, "重试时登录失效不能证明原提交未被接收")
        XCTAssertEqual(draft.firstSubmittedAt, originalTime)
    }
}
