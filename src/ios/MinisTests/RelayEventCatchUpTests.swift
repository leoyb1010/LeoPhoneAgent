import Foundation
import XCTest

/// Relay catch-up: one future-dated event must not push the cursor to year
/// 3000, and one catch-up must stay small however much the relay returns.
final class RelayEventCatchUpTests: XCTestCase {

    private let now: Double = 2_000_000_000

    private func item(_ at: Double, seq: Int? = nil, approval: String? = nil, event: String = "run.completed") -> RelayEventItem {
        var raw: [String: Any] = ["event": event, "session_id": "s1"]
        if let seq { raw["seq"] = seq }
        if let approval { raw["approval_id"] = approval }
        return RelayEventItem(machine: "Mac", receivedAt: at, raw: raw)
    }

    func testFutureReceivedAtDoesNotAdvanceCursor() {
        let year3000 = now + 1000 * 365 * 86_400
        let plan = RelayCatchUpPolicy.plan([item(now - 10, seq: 1), item(year3000, seq: 2)], lastSeenAt: now - 100, now: now)
        XCTAssertEqual(plan.highWater, now + RelayCatchUpPolicy.maxFutureSkew)
        XCTAssertLessThanOrEqual(plan.highWater, now + 60)
        // A cursor an older build already pushed into the future is repaired.
        XCTAssertEqual(RelayCatchUpPolicy.repairedCursor(year3000, now: now), now)
        XCTAssertEqual(RelayCatchUpPolicy.repairedCursor(now - 5, now: now), now - 5)
        XCTAssertEqual(RelayCatchUpPolicy.repairedCursor(.infinity, now: now), 0)
        // An ordinary batch moves the cursor to what was seen.
        XCTAssertEqual(RelayCatchUpPolicy.plan([item(now - 10, seq: 1)], lastSeenAt: now - 100, now: now).highWater, now - 10)
    }

    func testCatchUpCapsItemsAndBytes() throws {
        let many = (0..<5_000).map { item(now - Double(5_000 - $0), seq: $0) }
        let plan = RelayCatchUpPolicy.plan(many.shuffled(), lastSeenAt: 0, now: now)
        XCTAssertEqual(plan.items.count, RelayCatchUpPolicy.maxItems)
        XCTAssertEqual(plan.items.last?.seq, 4_999, "the newest are kept")
        XCTAssertEqual(plan.items.first?.seq, 4_800)
        XCTAssertEqual(plan.droppedOlder, 4_800)
        XCTAssertEqual(plan.highWater, now - 1)

        let small = try JSONSerialization.data(withJSONObject: [
            "now": now, "events": [["machine": "Mac", "received_at": now - 1, "event": ["event": "run.failed", "seq": 3]]],
        ])
        let decoded = try RelayCatchUpPolicy.decode(small)
        XCTAssertEqual(decoded.items.count, 1)
        XCTAssertEqual(decoded.items.first?.eventName, "run.failed")

        let huge = Data(repeating: 0x20, count: RelayCatchUpPolicy.maxResponseBytes + 1)
        XCTAssertThrowsError(try RelayCatchUpPolicy.decode(huge)) {
            XCTAssertTrue($0 is RelayCatchUpPolicy.ResponseTooLarge)
        }
    }

    func testFingerprintWithoutSeqKeepsDistinctApprovals() {
        let a = item(now - 2, approval: "ap-1", event: "approval.request")
        let b = item(now - 1, approval: "ap-2", event: "approval.request")
        XCTAssertNotEqual(a.fingerprint, b.fingerprint, "two approvals without seq are two prompts")
        XCTAssertEqual(item(now, seq: 7).fingerprint, item(now + 5, seq: 7).fingerprint, "seq stays the identity when present")
    }

    // MARK: 补拉审批的元数据(按中继暂存的原始事件恢复)

    private func approvalItem(_ json: String) throws -> RelayEventItem {
        let body = #"{"now": 2000000000, "events": [{"machine": "Studio", "received_at": 1999999990, "event": "# + json + #"}]}"#
        return try XCTUnwrap(RelayCatchUpPolicy.decode(Data(body.utf8)).items.first)
    }

    func testCatchUpApprovalRestoresPlanToolChoicesReasonAndExtras() throws {
        let item = try approvalItem(#"""
        {"event": "approval.request", "session_id": "hs_1", "approval_id": "ap_9", "seq": 12,
         "tool": "ExitPlanMode", "command": "批准计划并开始执行", "description": "计划等你批准",
         "choices": ["once", "deny"], "plan": "1. 改 A\n2. 跑测试", "run_id": "r1"}
        """#)
        let fields = try XCTUnwrap(item.approvalFields)
        XCTAssertEqual(fields.approvalId, "ap_9")
        XCTAssertEqual(fields.sessionId, "hs_1")
        XCTAssertEqual(fields.tool, "ExitPlanMode")
        XCTAssertTrue(HarnessApprovalPresentation.isPlan(tool: fields.tool), "补拉的计划审批要认得出是计划")
        XCTAssertEqual(fields.reason, "计划等你批准")
        XCTAssertEqual(fields.command, "批准计划并开始执行")
        XCTAssertEqual(fields.choices, ["once", "deny"])
        XCTAssertEqual(fields.choicesSource, .event)
        XCTAssertEqual(fields.extras["plan"], "1. 改 A\n2. 跑测试", "计划正文和实时流一样放在 extras[plan]")
        XCTAssertEqual(fields.extras["tool"], "ExitPlanMode")
        XCTAssertNil(fields.extras["choices"])
        XCTAssertNil(fields.extras["seq"])
        XCTAssertEqual(HarnessApprovalPresentation.planText(plan: fields.extras["plan"], description: fields.reason),
                       "1. 改 A\n2. 跑测试")
        // 去重仍按中继 APNs 的 collapse id。
        XCTAssertEqual(MacFollowLogic.catchUpNotificationId(event: item.eventName, sessionId: fields.sessionId,
                                                            approvalId: fields.approvalId),
                       "approval.request-ap_9")
    }

    func testCatchUpApprovalKeepsServerNarrowedChoices() throws {
        let denyOnly = try XCTUnwrap(try approvalItem(#"""
        {"event": "approval.request", "session_id": "hs_1", "approval_id": "a", "command": "rm -rf /", "choices": ["deny"]}
        """#).approvalFields)
        XCTAssertEqual(denyOnly.choices, ["deny"], "服务端只给 deny 时不能多出允许")
        let rich = try XCTUnwrap(try approvalItem(#"""
        {"event": "approval.request", "session_id": "hs_1", "approval_id": "b",
         "choices": ["once", "session", "", "once", 3, "always", "deny"]}
        """#).approvalFields)
        XCTAssertEqual(rich.choices, ["once", "session", "always", "deny"], "去空、去重、丢非字符串,保序")
        XCTAssertNil(rich.tool)
        XCTAssertNil(rich.reason)
    }

    func testExplicitEmptyChoicesNeverInventsApproval() throws {
        let empty = try XCTUnwrap(try approvalItem(#"""
        {"event": "approval.request", "session_id": "hs_1", "approval_id": "a", "choices": []}
        """#).approvalFields)
        XCTAssertEqual(empty.choices, [])
        XCTAssertEqual(empty.choicesSource, .event)
        XCTAssertNil(category(empty), "显式空 choices 不发带按钮的审批通知")

        let junk = try XCTUnwrap(try approvalItem(#"""
        {"event": "approval.request", "session_id": "hs_1", "approval_id": "b", "choices": "once"}
        """#).approvalFields)
        XCTAssertEqual(junk.choices, [])
        XCTAssertEqual(junk.choicesSource, .malformed)
        XCTAssertNil(category(junk))

        let blanks = try XCTUnwrap(try approvalItem(#"""
        {"event": "approval.request", "session_id": "hs_1", "approval_id": "c", "choices": ["", 1]}
        """#).approvalFields)
        XCTAssertNil(category(blanks), "清洗后为空也不补")
    }

    func testLegacyEventWithoutChoicesKeepsOnceDenyCompatibility() throws {
        let legacy = try XCTUnwrap(try approvalItem(#"""
        {"event": "approval.request", "session_id": "hs_1", "request_id": "old-1", "command": "ls"}
        """#).approvalFields)
        XCTAssertEqual(legacy.approvalId, "old-1")
        XCTAssertEqual(legacy.choices, ["once", "deny"])
        XCTAssertEqual(legacy.choicesSource, .legacyDefault)
        XCTAssertNil(category(legacy), "兼容的 once/deny 不含 session:不能用带「本次会话允许」的类别")
        let null = try XCTUnwrap(try approvalItem(#"""
        {"event": "approval.request", "session_id": "hs_1", "approval_id": "n", "choices": null}
        """#).approvalFields)
        XCTAssertEqual(null.choicesSource, .legacyDefault, "null 按缺字段处理")
    }

    func testCatchUpApprovalNeedsAddressableIds() throws {
        XCTAssertNil(try approvalItem(#"{"event": "approval.request", "approval_id": "a"}"#).approvalFields)
        XCTAssertNil(try approvalItem(#"{"event": "approval.request", "session_id": "hs_1"}"#).approvalFields)
        XCTAssertNil(try approvalItem(#"{"event": "approval.request", "session_id": "", "approval_id": "a"}"#).approvalFields)
        XCTAssertNil(try approvalItem(#"{"event": "run.completed", "session_id": "hs_1", "approval_id": "a"}"#).approvalFields)
    }

    // MARK: 补拉审批 → 最终通知的类别与按钮(生产代码 HarnessApprovalNotifier 调的同一份决策)

    private func category(_ fields: RelayApprovalFields, highRisk: Bool = false, registered: Bool = true) -> String? {
        HarnessApprovalNotificationSpec.categoryIdentifier(choices: fields.choices, highRisk: highRisk,
                                                          highRiskRegistered: registered)
    }

    private func finalChoices(_ fields: RelayApprovalFields, highRisk: Bool = false) -> [String] {
        HarnessApprovalNotificationSpec.actions(forCategory: category(fields, highRisk: highRisk)).map(\.choice)
    }

    private func fields(choices: String?) throws -> RelayApprovalFields {
        let tail = choices.map { #", "choices": "# + $0 } ?? ""
        return try XCTUnwrap(try approvalItem(#"{"event": "approval.request", "session_id": "hs_1", "approval_id": "a", "command": "rm -rf build""# + tail + "}").approvalFields)
    }

    func testCatchUpNotificationActionsAreAlwaysASubsetOfServerChoices() throws {
        let cases: [(String?, String)] = [
            (#"["deny"]"#, "deny-only"), (#"["once", "deny"]"#, "once/deny"), (#"["bogus"]"#, "unknown"),
            (#"["", " "]"#, "blank"), (nil, "missing"), ("null", "null"), ("[]", "empty"), (#""once""#, "malformed"),
            (#"["once", "session", "deny"]"#, "full"), (#"["once", "session", "always", "deny", "bogus"]"#, "superset"),
            (#"[" once ", "session", "deny"]"#, "noncanonical-token"),
        ]
        for (raw, name) in cases {
            let f = try fields(choices: raw)
            for highRisk in [false, true] {
                let offered = Set(finalChoices(f, highRisk: highRisk))
                let rawChoices = raw.flatMap { $0.data(using: .utf8) }
                    .flatMap { try? JSONSerialization.jsonObject(with: $0) as? [Any] }
                    .map { Set($0.compactMap { $0 as? String }) } ?? Set(RelayApprovalFields.legacyChoices)
                XCTAssertTrue(offered.isSubset(of: rawChoices), "\(name): 通知按钮必须是原始服务端 choices 的子集")
                XCTAssertFalse(offered.contains("always"), "\(name): 通知从不给始终允许")
            }
        }
    }

    func testNarrowOrInvalidChoicesFallBackToButtonlessReminder() throws {
        for raw in [#"["deny"]"#, #"["once", "deny"]"#, #"["bogus"]"#, #"["", " "]"#, "[]", #""once""#, "null", nil] as [String?] {
            let f = try fields(choices: raw)
            XCTAssertNil(category(f), "\(raw ?? "missing"): 无按钮提醒")
            XCTAssertNil(category(f, highRisk: true))
            XCTAssertEqual(HarnessApprovalNotificationSpec.actions(forCategory: category(f)), [], "提醒上没有任何动作")
        }
        XCTAssertEqual(try fields(choices: nil).choices, ["once", "deny"], "缺字段仍按旧协议兼容 once/deny")
        XCTAssertEqual(try fields(choices: #"["", " "]"#).choices, [], "空白不是可提交的选择")
    }

    func testWhitespaceCannotCreateAnApprovalToken() throws {
        let f = try fields(choices: #"[" once ", "session", "deny"]"#)
        XCTAssertNil(category(f))
        XCTAssertNil(category(f, highRisk: true))
        XCTAssertTrue(HarnessApprovalNotificationSpec.actions(forCategory: category(f)).isEmpty)
    }

    func testFullChoiceSetUsesExistingCategoriesWithTheirRealActions() throws {
        let f = try fields(choices: #"["once", "session", "always", "deny"]"#)
        XCTAssertEqual(category(f), HarnessApprovalNotificationSpec.categoryId)
        XCTAssertEqual(category(f, highRisk: true), HarnessApprovalNotificationSpec.highRiskCategoryId)
        XCTAssertEqual(category(f, highRisk: true, registered: false), HarnessApprovalNotificationSpec.categoryId,
                       "高危类别没登记退回普通类别(按钮相同)")
        let actions = HarnessApprovalNotificationSpec.actions(forCategory: category(f, highRisk: true))
        XCTAssertEqual(actions.map(\.identifier), [HarnessApprovalNotificationSpec.approveAction,
                                                  HarnessApprovalNotificationSpec.approveSessionAction,
                                                  HarnessApprovalNotificationSpec.denyAction,
                                                  HarnessApprovalNotificationSpec.denyAndStopAction])
        XCTAssertEqual(actions.map(\.choice), ["once", "session", "deny", "deny"])
        XCTAssertEqual(actions.filter(\.allows).map(\.choice), ["once", "session"], "高危类别上这两个要解锁")
        XCTAssertEqual(actions.filter(\.stopsAfter).map(\.identifier), [HarnessApprovalNotificationSpec.denyAndStopAction])
        // 按钮回调解析(handle 用的同一张表):不认识的动作 = 点通知本体,不代作决定。
        XCTAssertEqual(HarnessApprovalNotificationSpec.action(identifier: HarnessApprovalNotificationSpec.denyAndStopAction)?.choice, "deny")
        XCTAssertNil(HarnessApprovalNotificationSpec.action(identifier: "com.apple.UNNotificationDefaultActionIdentifier"))
        XCTAssertEqual(HarnessApprovalNotificationSpec.actions(forCategory: "BACKGROUND_TASK"), [])
    }
}
