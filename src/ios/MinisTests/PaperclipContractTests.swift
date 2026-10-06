import Foundation
import XCTest

final class PaperclipContractTests: XCTestCase {
    func testBlockedExpectationRequiresExplicitBoundOwnerAction() throws {
        // [A5] 解除条件改为可选:空着时默认「等我处理」;超长仍拒绝。
        XCTAssertEqual(try PaperclipStatusExpectation(status: .blocked, userID: "human", unblockAction: "  ").unblockAction,
                       PaperclipUnblockAction.defaultAction)
        XCTAssertEqual(try PaperclipStatusExpectation(status: .blocked, userID: "human", unblockAction: nil).unblockAction, "等我处理")
        XCTAssertThrowsError(try PaperclipStatusExpectation(status: .blocked, userID: "human", unblockAction: String(repeating: "😀", count: 1001)))
        let expected = try PaperclipStatusExpectation(status: .blocked, userID: "human", unblockAction: " 核对需求 ")
        let matching = #"{"id":"issue","companyId":"company","title":"任务","status":"blocked","priority":"medium","unblockDescriptor":{"owner":{"userId":"human"},"action":"核对需求"}}"#
        XCTAssertTrue(expected.matches(try JSONDecoder().decode(PaperclipIssue.self, from: Data(matching.utf8))))
        XCTAssertFalse(expected.matches(try JSONDecoder().decode(PaperclipIssue.self, from: Data(matching.replacingOccurrences(of: "human", with: "other").utf8))))
        XCTAssertFalse(expected.matches(try JSONDecoder().decode(PaperclipIssue.self, from: Data(matching.replacingOccurrences(of: "核对需求", with: "其他操作").utf8))))
    }

    /// [A5] 全自动下审批一点即提交,不再二次确认;全自动关着时照旧确认。
    func testFullAutoSkipsDecisionConfirmation() {
        XCTAssertFalse(PaperclipFullAuto.needsDecisionConfirmation(fullAuto: true))
        XCTAssertTrue(PaperclipFullAuto.needsDecisionConfirmation(fullAuto: false))
    }

    /// [A6] 超时 → 恢复 → 服务器已有该评论:草稿自动解锁;服务器没有:保持锁定。
    func testUncertainReplyIsConfirmedByReadOnlyCheckAfterRecovery() throws {
        var draft = PaperclipDraft()
        draft.body = "补充一下需求"
        draft.markSubmitted()
        draft.recordFailure(PaperclipError.uncertain, wasPreviouslySubmitted: false)
        XCTAssertTrue(draft.submitted)
        func comment(_ requestID: String, author: String = "human", body: String = "补充一下需求") throws -> PaperclipComment {
            let json = #"{"id":"c1","companyId":"co","issueId":"i","body":"\#(body)","authorUserId":"\#(author)","clientRequestId":"\#(requestID)"}"#
            return try JSONDecoder().decode(PaperclipComment.self, from: Data(json.utf8))
        }
        XCTAssertEqual(PaperclipReplyCheck.check(draft, comments: [], userID: "human"), .notFound)
        XCTAssertEqual(PaperclipReplyCheck.check(draft, comments: [try comment(UUID().uuidString)], userID: "human"), .notFound)
        XCTAssertEqual(PaperclipReplyCheck.check(draft, comments: [try comment(draft.requestID.uuidString, author: "other")], userID: "human"), .notFound)
        XCTAssertEqual(PaperclipReplyCheck.check(draft, comments: [try comment(draft.requestID.uuidString, body: "别的")], userID: "human"), .notFound)
        XCTAssertEqual(PaperclipReplyCheck.check(draft, comments: [try comment(draft.requestID.uuidString)], userID: "human"), .confirmed)
        XCTAssertEqual(PaperclipReplyCheck.check(PaperclipDraft(), comments: [], userID: "human"), .notPending)
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
    func testSessionDecodeSeparatesSignedOutFromIncompatibleResponse() {
        func error(_ body: String) -> PaperclipError? {
            do { _ = try PaperclipSession.decode(Data(body.utf8)); return nil } catch { return error as? PaperclipError }
        }
        // 未登录：空会话。
        for signedOut in ["null", "{}", #"{"data":null}"#, #"{"session":null,"user":null}"#,
                          #"{"session":{"id":"","userId":"human"},"user":{"id":"human"}}"#] {
            XCTAssertEqual(error(signedOut), .signedOut, signedOut)
        }
        // HTTP 200 但结构不兼容：不能误报为登录过期。
        for incompatible in ["<html>", "[]", "\"text\"", #"{"session":{"sessionId":"s"},"user":{"uid":"human"}}"#,
                             #"{"session":"s","user":"human"}"#, #"{"data":{"session":1,"user":2}}"#] {
            XCTAssertEqual(error(incompatible), .invalidResponse, incompatible)
        }
    }
    func testPinnedHistoricalRunsUseRunIDNotLiveRunID() throws {
        let fixture = #"[{"runId":"run-1","status":"succeeded","agentId":"agent","startedAt":null,"finishedAt":null}]"#
        XCTAssertEqual(try JSONDecoder().decode([PaperclipRun].self, from: Data(fixture.utf8)).first?.id, "run-1")
        XCTAssertThrowsError(try JSONDecoder().decode([PaperclipRun].self, from: Data(fixture.replacingOccurrences(of: "runId", with: "id").utf8)))
    }
    func testReadPollingPausesOnlyForWritesNotFocusOrPanels() {
        // 新语义：只读刷新只在写请求进行中暂停；输入框聚焦、面板打开不再暂停（以前键盘不收起就永远不刷新）。
        for active in [false, true] {
            for mutating in [false, true] {
                XCTAssertEqual(PaperclipPollingPolicy.canRefresh(active: active, mutating: mutating), active && !mutating)
            }
        }
        XCTAssertEqual(PaperclipPollingPolicy.detailInterval(liveOpen: true, runActive: true), 60)
        XCTAssertEqual(PaperclipPollingPolicy.detailInterval(liveOpen: false, runActive: true), 3)
        XCTAssertEqual(PaperclipPollingPolicy.detailInterval(liveOpen: false, runActive: false), 15)
    }

    func testSendReleasesComposerFocusUnlessDraftIsEditableAgain() {
        // 发送成功收起键盘；结果未知（草稿锁定待核对）也收起；明确拒绝、草稿已解锁时保留焦点方便修改。
        XCTAssertFalse(PaperclipSendOutcome.sent.keepsComposerFocus)
        var draft = PaperclipDraft()
        draft.body = "补充要求"
        draft.markSubmitted()
        draft.recordFailure(PaperclipError.preflightFailed(.unavailable), wasPreviouslySubmitted: false)
        XCTAssertEqual(PaperclipSendOutcome.failure(draftAfterFailure: draft), .rejectedEditable)
        XCTAssertTrue(PaperclipSendOutcome.failure(draftAfterFailure: draft).keepsComposerFocus)
        draft.markSubmitted()
        draft.recordFailure(PaperclipError.uncertain, wasPreviouslySubmitted: false)
        XCTAssertEqual(PaperclipSendOutcome.failure(draftAfterFailure: draft), .uncertain)
        XCTAssertFalse(PaperclipSendOutcome.failure(draftAfterFailure: draft).keepsComposerFocus)
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
        XCTAssertTrue(PaperclipPollingPolicy.canRefresh(active: true, mutating: false))
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
    func testCreateRetryWindowStaysInsideServerSevenDayRetention() {
        // 服务端 ISSUE_CREATE_IDEMPOTENCY_KEY_RETENTION_DAYS = 7；客户端必须更短。
        XCTAssertEqual(PaperclipDraft.createRetryWindow, 6 * 24 * 60 * 60)
        XCTAssertLessThan(PaperclipDraft.createRetryWindow, 7 * 24 * 60 * 60)
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

/// [G1/G7/G8] 结果读取、深链、关注列表与 Spotlight 条目。
final class PaperclipUpgradeContractTests: XCTestCase {
    private func issue(_ status: String) throws -> PaperclipIssue {
        try JSONDecoder().decode(PaperclipIssue.self, from: Data(#"{"id":"issue","companyId":"company","identifier":"PAP-12","title":"整理周报","status":"\#(status)","priority":"medium"}"#.utf8))
    }
    private func comment(_ id: String, body: String, agent: Bool) -> PaperclipComment {
        PaperclipComment(id: id, companyId: "company", issueId: "issue", body: body, authorUserId: agent ? nil : "human",
                         authorAgentId: agent ? "agent" : nil, clientRequestId: nil, createdAt: nil)
    }

    func testIssueResultReturnsLatestAgentReplyInFull() throws {
        let long = String(repeating: "结", count: 400)
        let comments = [comment("1", body: "旧结果", agent: true), comment("2", body: long, agent: true), comment("3", body: "谢谢", agent: false)]
        let done = PaperclipIssueResult.compose(issue: try issue("done"), comments: comments)
        XCTAssertEqual(done.value, long, "输出是最近一条智能体回复全文，人类评论不算结果")
        XCTAssertTrue(done.dialog.hasPrefix("「整理周报」已完成。结果："))
        XCTAssertLessThan(done.dialog.count, long.count, "Siri 只念开头")
        let running = PaperclipIssueResult.compose(issue: try issue("in_progress"), comments: comments)
        XCTAssertEqual(running.value, long)
        XCTAssertTrue(running.dialog.contains("当前状态为进行中"))
        let empty = PaperclipIssueResult.compose(issue: try issue("todo"), comments: [comment("3", body: "请处理", agent: false)])
        XCTAssertEqual(empty.value, "")
        XCTAssertEqual(empty.dialog, "「整理周报」待处理，还没有智能体给出结果。")
    }

    func testPaperclipDeepLinkRoundTripAndRejectsInvalidLinks() throws {
        let url = try XCTUnwrap(PaperclipDeepLink.url(issueID: "issue-1", companyID: "company_a"))
        XCTAssertEqual(url.absoluteString, "leophoneagent://paperclip/issue/issue-1?company=company_a")
        XCTAssertEqual(PaperclipDeepLink.parse(url), .init(issueID: "issue-1", companyID: "company_a"))
        XCTAssertEqual(PaperclipDeepLink.parse(URL(string: "leophoneagent://paperclip/issue/PAP-12")!), .init(issueID: "PAP-12", companyID: nil))
        XCTAssertEqual(PaperclipDeepLink.parse(URL(string: "leophoneagent://paperclip/issue/x?company=../evil")!), .init(issueID: "x", companyID: nil),
                       "非法公司编号丢弃，不跳到别的公司")
        for bad in ["leophoneagent://paperclip/issue/", "leophoneagent://paperclip/issue/a/b", "leophoneagent://paperclip/agent/a",
                    "leophoneagent://paperclip", "leophoneagent://sessions/issue", "https://paperclip/issue/a", "leophoneagent://paperclip/issue/a%20b"] {
            XCTAssertNil(PaperclipDeepLink.parse(URL(string: bad)!), bad)
        }
        XCTAssertNil(PaperclipDeepLink.url(issueID: "a/b", companyID: nil))
        XCTAssertEqual(PaperclipSpotlightIndexer.identifierPrefix, "leophoneagent://paperclip/")
        XCTAssertTrue(url.absoluteString.hasPrefix(PaperclipSpotlightIndexer.identifierPrefix))
    }

    func testWatchListKeepsRecentCreatedIssuesPerIdentity() {
        let suite = "paperclip.watch.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let profile = UUID()
        let key = PaperclipWatchList.key(profileID: profile, companyID: "company", userID: "human")
        XCTAssertTrue(key.hasPrefix("leo.paperclip.") && key.contains(profile.uuidString), "删除配置时按前缀与配置编号清除")
        for index in 0..<55 { PaperclipWatchList.add("issue-\(index)", key: key, defaults: defaults) }
        PaperclipWatchList.add("issue-10", key: key, defaults: defaults)
        let list = PaperclipWatchList.load(key: key, defaults: defaults)
        XCTAssertEqual(list.count, PaperclipWatchList.limit)
        XCTAssertEqual(list.last, "issue-10")
        XCTAssertFalse(list.contains("issue-0"))
        XCTAssertEqual(Set(list).count, list.count)
    }

    func testSpotlightItemHoldsOnlyTitleAndIdentifier() throws {
        let profile = UUID()
        let raw = try JSONDecoder().decode(PaperclipIssue.self, from: Data(#"{"id":"issue","companyId":"company","identifier":"PAP-12","title":"整理周报","description":"机密描述","status":"done","priority":"medium"}"#.utf8))
        let item = try XCTUnwrap(PaperclipSpotlightIndexer.item(for: raw, profileID: profile))
        XCTAssertEqual(item.uniqueIdentifier, "leophoneagent://paperclip/issue/issue?company=company", "点击走 G7 深链")
        XCTAssertEqual(item.domainIdentifier, PaperclipSpotlightIndexer.domain(profileID: profile))
        XCTAssertEqual(item.attributeSet.title, "PAP-12 整理周报")
        XCTAssertNil(item.attributeSet.contentDescription, "不索引描述")
        XCTAssertEqual(item.attributeSet.keywords, ["PAP-12", "Paperclip"])
    }
}
