import XCTest

/// [remote-ctl-power] 「关注」省电:首页过滤、自适应轮询、行相等、补拉通知 id、push-to-start 闸门、手表行。
final class MacFollowLogicTests: XCTestCase {
    private func facts(_ sid: String, status: String = "running", waiting: Bool = false, following: Bool? = nil,
                       title: String = "任务", approvalId: String? = nil, command: String? = nil,
                       seq: Int = 1) -> MacFollowLogic.Facts {
        MacFollowLogic.Facts(hostId: "h", sessionId: sid, status: status, seq: seq, waiting: waiting,
                             following: following, title: title, pendingApprovalId: approvalId,
                             pendingApprovalCommand: command)
    }

    // MARK: 首页过滤

    func testNilFollowingCountsAsFollowedForOldMacs() {
        XCTAssertTrue(MacFollowLogic.isFollowed(nil))
        XCTAssertTrue(MacFollowLogic.isFollowed(true))
        XCTAssertFalse(MacFollowLogic.isFollowed(false))
    }

    func testPartitionListsFollowedAndCollapsesUnfollowedBusy() {
        let items = [
            facts("phone", following: true),
            facts("old-mac", status: "idle", following: nil),
            facts("desk-run", following: false),
            facts("desk-wait", status: "waiting_for_approval", waiting: true, following: false),
            facts("desk-start", status: "starting", following: false),
            facts("desk-idle", status: "idle", following: false),
        ]
        let parts = MacFollowLogic.partition(items) { $0 }
        XCTAssertEqual(parts.followed.map(\.sessionId), ["phone", "old-mac"])
        XCTAssertEqual(parts.unfollowedBusy.map(\.sessionId), ["desk-run", "desk-wait", "desk-start"],
                       "桌面上闲着的未关注任务不进折叠计数")
        XCTAssertEqual(parts.unfollowedBusy.count, 3)
    }

    // MARK: 自适应轮询

    func testPollIntervalFastOnlyWhileFollowedWorkIsBusy() {
        XCTAssertEqual(MacFollowLogic.pollInterval([]), 60)
        XCTAssertEqual(MacFollowLogic.pollInterval([facts("a", following: false)]), 60,
                       "只有没关注的在跑:慢轮询")
        XCTAssertEqual(MacFollowLogic.pollInterval([facts("a", status: "idle", following: true)]), 60)
        XCTAssertEqual(MacFollowLogic.pollInterval([facts("a", following: true)]), 20)
        XCTAssertEqual(MacFollowLogic.pollInterval([facts("a", status: "starting", following: nil)]), 20,
                       "旧版 Mac 的任务按关注")
        XCTAssertEqual(MacFollowLogic.pollInterval([
            facts("a", status: "waiting_for_approval", waiting: true, following: true),
            facts("b", following: false),
        ]), 20)
    }

    // MARK: 行相等

    func testRowFactsNoticeTitleStatusAndFollowChanges() {
        let base = facts("s", title: "修 bug")
        XCTAssertEqual(base, facts("s", title: "修 bug"))
        XCTAssertNotEqual(base, facts("s", title: "修 bug(改名)"), "改了标题要刷新")
        XCTAssertNotEqual(base, facts("s", status: "idle", title: "修 bug"))
        XCTAssertNotEqual(base, facts("s", following: false, title: "修 bug"), "关注变了要刷新")
        XCTAssertNotEqual(base, facts("s", title: "修 bug", seq: 2))
        XCTAssertNotEqual(base, facts("s", waiting: true, title: "修 bug", approvalId: "a1"))
    }

    // MARK: 补拉通知 id

    func testCatchUpIdsMatchRelayCollapseIds() {
        XCTAssertEqual(MacFollowLogic.catchUpNotificationId(event: "run.completed", sessionId: "s1", approvalId: nil),
                       "run.completed-s1")
        XCTAssertEqual(MacFollowLogic.catchUpNotificationId(event: "run.failed", sessionId: "s1", approvalId: nil),
                       "run.failed-s1")
        XCTAssertEqual(MacFollowLogic.catchUpNotificationId(event: "approval.request", sessionId: "s1", approvalId: "ap-9"),
                       "approval.request-ap-9")
        // 中继:approval_id 缺省时退到 session_id。
        XCTAssertEqual(MacFollowLogic.catchUpNotificationId(event: "approval.request", sessionId: "s1", approvalId: nil),
                       "approval.request-s1")
        XCTAssertNil(MacFollowLogic.catchUpNotificationId(event: "automation.run.completed", sessionId: "s1", approvalId: nil))
        // APNs collapse id 截到 64 字节,本地 id 跟着截。
        let long = String(repeating: "x", count: 100)
        let id = MacFollowLogic.catchUpNotificationId(event: "run.completed", sessionId: long, approvalId: nil)
        XCTAssertEqual(id?.count, 64)
        XCTAssertEqual(id, String("run.completed-\(long)".prefix(64)))
    }

    func testCatchUpIdsAreStableAcrossRuns() {
        let a = MacFollowLogic.catchUpNotificationId(event: "run.completed", sessionId: "s", approvalId: nil)
        let b = MacFollowLogic.catchUpNotificationId(event: "run.completed", sessionId: "s", approvalId: nil)
        XCTAssertEqual(a, b, "不能再是随机 relay-<UUID>")
    }

    func testCatchUpSkipsOnlyKnownUnfollowedSessions() {
        let unfollowed: Set<String> = ["desk"]
        XCTAssertTrue(MacFollowLogic.skipsCatchUp(sessionId: "desk", unfollowed: unfollowed))
        XCTAssertFalse(MacFollowLogic.skipsCatchUp(sessionId: "phone", unfollowed: unfollowed),
                       "不认识的会话(没拉到、旧版 Mac)照常提示")
        XCTAssertFalse(MacFollowLogic.skipsCatchUp(sessionId: nil, unfollowed: unfollowed))
        XCTAssertFalse(MacFollowLogic.skipsCatchUp(sessionId: "", unfollowed: unfollowed))
    }

    // MARK: push-to-start

    func testPushToStartRegistersOnlyWhenLiveActivityEnabled() throws {
        XCTAssertTrue(MacFollowLogic.shouldRegisterPushToStart(liveActivityEnabled: true, supported: true))
        XCTAssertFalse(MacFollowLogic.shouldRegisterPushToStart(liveActivityEnabled: false, supported: true))
        XCTAssertFalse(MacFollowLogic.shouldRegisterPushToStart(liveActivityEnabled: true, supported: false))

        let suite = "MacFollowLogicTests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        XCTAssertTrue(MacFollowLogic.liveActivityEnabled(defaults), "没动过开关 = 默认开")
        defaults.set(false, forKey: MacFollowLogic.liveActivityEnabledKey)
        XCTAssertFalse(MacFollowLogic.liveActivityEnabled(defaults))
        defaults.set(true, forKey: MacFollowLogic.liveActivityEnabledKey)
        XCTAssertTrue(MacFollowLogic.liveActivityEnabled(defaults))
    }

    // MARK: 手表

    func testWatchItemsAreFollowedOnlyAndUseTitles() {
        let rows: [(facts: MacFollowLogic.Facts, statusText: String)] = [
            (facts("s1", following: true, title: "重构登录页"), "运行中"),
            (facts("s2", following: false, title: "桌面任务"), "运行中"),
            (facts("s3", status: "waiting_for_approval", waiting: true, following: nil, title: "跑测试",
                   approvalId: "ap1", command: "rm -rf build"), "等你审批"),
        ]
        let items = MacFollowLogic.watchItems(rows)
        XCTAssertEqual(items.map(\.title), ["重构登录页", "跑测试"])
        XCTAssertEqual(items[0], MacFollowLogic.WatchItem(id: "hs1", title: "重构登录页", status: "运行中",
                                                          waiting: false, running: true, approvalId: nil, detail: nil))
        XCTAssertEqual(items[1].approvalId, "ap1", "等审批的行带审批 id,手表点开能重开审批卡")
        XCTAssertEqual(items[1].detail, "rm -rf build")
        XCTAssertFalse(items[1].running)
    }

    func testWatchStatusCarriesApprovalAndStaysCompatible() throws {
        let status = WatchMacStatus.summarize(approvals: [
            (id: "h1", title: "跑测试", status: "等你审批", waiting: true, running: false,
             approvalId: "ap1", detail: "rm -rf build", risk: "high"),
            (id: "h2", title: "重构", status: "运行中", waiting: false, running: true,
             approvalId: nil, detail: nil, risk: nil),
        ], now: Date(timeIntervalSince1970: 100))
        XCTAssertEqual(status.rows[0].approvalId, "ap1")
        XCTAssertEqual(status.rows[0].detail, "rm -rf build")
        XCTAssertEqual(status.rows[0].risk, "high")
        // 往返:手表解得出带审批的行。
        let encoded = try XCTUnwrap(status.encodedForContext())
        XCTAssertEqual(WatchMacStatus.decode(fromContext: encoded), status)
        // 旧手机发来的(没有审批字段)照样能解。
        let old = #"{"running":1,"waiting":0,"rows":[{"id":"x","title":"t","status":"运行中","waiting":false}],"updatedAt":5}"#
        let decoded = try XCTUnwrap(WatchMacStatus.decode(fromContext: old))
        XCTAssertNil(decoded.rows[0].approvalId)
        // 改标题、来新审批都要换签名(否则不推到手表)。
        var renamed = status
        renamed.rows[1].title = "重构登录"
        XCTAssertNotEqual(renamed.signature, status.signature)
        var reapproved = status
        reapproved.rows[0].approvalId = "ap2"
        XCTAssertNotEqual(reapproved.signature, status.signature)
    }

    func testWatchApprovalsComeFromFollowedWaitingSessionsOnly() {
        let list = [
            facts("a", status: "waiting_for_approval", waiting: true, following: true, approvalId: "ap-a"),
            facts("b", status: "waiting_for_approval", waiting: true, following: false, approvalId: "ap-b"),
            facts("c", status: "waiting_for_approval", waiting: true, following: nil, approvalId: nil),
            facts("d", following: true, approvalId: nil),
        ]
        XCTAssertEqual(MacFollowLogic.watchApprovals(list).map(\.sessionId), ["a"])
    }
}
