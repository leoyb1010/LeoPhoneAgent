import XCTest

/// [P3] 定时任务交给 Mac:选机器、请求整形、跑完提示。
final class MacAutomationLogicTests: XCTestCase {
    private let hosts = [MacAutomationLogic.HostRef(id: "a", name: "LeoyuanAir"),
                         MacAutomationLogic.HostRef(id: "s", name: "LeoMac-Studio-2"),
                         MacAutomationLogic.HostRef(id: "m", name: "LeodeMac-mini-2")]

    func testHostPickingPrefersRequestedThenRememberedThenStudio() {
        XCTAssertEqual(MacAutomationLogic.pickHost(hosts, requested: "mini", rememberedId: "a")?.id, "m")
        XCTAssertEqual(MacAutomationLogic.pickHost(hosts, requested: nil, rememberedId: "a")?.id, "a")
        XCTAssertEqual(MacAutomationLogic.pickHost(hosts, requested: nil, rememberedId: "gone")?.id, "s")
        XCTAssertEqual(MacAutomationLogic.pickHost(hosts, requested: "  ", rememberedId: nil)?.id, "s")
        XCTAssertNil(MacAutomationLogic.pickHost(hosts, requested: "iMac", rememberedId: "s"), "点名点错了不能悄悄换一台")
        XCTAssertNil(MacAutomationLogic.pickHost([], requested: nil, rememberedId: nil))
    }

    func testCreateAcceptsCronStringOrObjectAndDropsUnknownFields() throws {
        let cron = try MacAutomationLogic.request(action: .create, args: [
            "prompt": "整理今天的邮件", "schedule": "0 8 * * *", "name": "早报", "rm_rf": "/"])
        XCTAssertEqual(cron.method, "POST")
        XCTAssertEqual(cron.path, "/automations")
        XCTAssertEqual(cron.body, #"{"name":"早报","prompt":"整理今天的邮件","schedule":"0 8 * * *"}"#)

        let object = try MacAutomationLogic.request(action: .create, args: [
            "prompt": "x", "schedule": #"{"kind":"daily","time":"09:00"}"#, "agent": "claude"])
        XCTAssertEqual(object.body, #"{"harness":"claude","prompt":"x","schedule":{"kind":"daily","time":"09:00"}}"#)
    }

    func testBadArgumentsAreRejectedBeforeAnyRequest() {
        XCTAssertThrowsError(try MacAutomationLogic.request(action: .create, args: ["schedule": "0 8 * * *"]))
        XCTAssertThrowsError(try MacAutomationLogic.request(action: .create, args: ["prompt": "x", "schedule": "every day"]))
        XCTAssertThrowsError(try MacAutomationLogic.request(action: .delete, args: ["id": "../x"]))
        XCTAssertThrowsError(try MacAutomationLogic.request(action: .update, args: ["id": "a1"]))
    }

    func testUpdateDeleteRunPaths() throws {
        let pause = try MacAutomationLogic.request(action: .update, args: ["id": "a1", "enabled": false])
        XCTAssertEqual(pause.method, "PATCH")
        XCTAssertEqual(pause.path, "/automations/a1")
        XCTAssertEqual(pause.body, #"{"enabled":false}"#)
        XCTAssertEqual(try MacAutomationLogic.request(action: .delete, args: ["id": "a1"]).method, "DELETE")
        let run = try MacAutomationLogic.request(action: .run, args: ["id": "a1"])
        XCTAssertEqual(run.path, "/automations/a1/run")
        XCTAssertNil(try MacAutomationLogic.request(action: .list, args: [:]).body)
    }

    func testRunNoticeWording() {
        let ok = MacAutomationLogic.runNotice(machine: "LeoMac-Studio-2",
                                              event: ["name": "早报", "status": "succeeded", "summary": "已在 Mac 上跑完"])
        XCTAssertEqual(ok.title, "✅ LeoMac-Studio-2 定时任务「早报」完成")
        XCTAssertEqual(ok.body, "已在 Mac 上跑完")
        let failed = MacAutomationLogic.runNotice(machine: "mini", event: ["status": "failed", "summary": "没有模型"])
        XCTAssertEqual(failed.title, "⏰ mini 定时任务「定时任务」失败")
    }

    // MARK: - 时区

    func testOnceIsAnchoredToPhoneTimeZone() throws {
        let shanghai = TimeZone(identifier: "Asia/Shanghai")!
        let once = try MacAutomationLogic.request(action: .create, args: [
            "prompt": "x", "schedule": #"{"kind":"once","date":"2026-10-23","time":"08:00"}"#], timeZone: shanghai)
        XCTAssertEqual(once.body, #"{"prompt":"x","schedule":{"at":"2026-10-23T08:00:00+08:00","kind":"once"}}"#)

        // 夏令时:同一个手机时区,不同日期偏移不同。
        let newYork = TimeZone(identifier: "America/New_York")!
        XCTAssertEqual(try MacAutomationLogic.anchorOnce(["kind": "once", "date": "2026-07-01", "time": "09:30"], timeZone: newYork)
                        as? [String: String], ["kind": "once", "at": "2026-07-01T09:30:00-04:00"])
        XCTAssertEqual(try MacAutomationLogic.anchorOnce(["kind": "once", "at": "2026-12-01T09:30"], timeZone: newYork)
                        as? [String: String], ["kind": "once", "at": "2026-12-01T09:30:00-05:00"])
        // 已带偏移的原样转。
        XCTAssertEqual(try MacAutomationLogic.anchorOnce(["kind": "once", "at": "2026-10-23T08:00:00+09:00"], timeZone: shanghai)
                        as? [String: String], ["kind": "once", "at": "2026-10-23T08:00:00+09:00"])
        XCTAssertThrowsError(try MacAutomationLogic.anchorOnce(["kind": "once", "date": "明天"], timeZone: shanghai))
        // 周期计划不动。
        XCTAssertEqual(try MacAutomationLogic.anchorOnce("0 8 * * *", timeZone: shanghai) as? String, "0 8 * * *")
        XCTAssertEqual(try MacAutomationLogic.anchorOnce(["kind": "daily", "time": "08:00"], timeZone: shanghai)
                        as? [String: String], ["kind": "daily", "time": "08:00"])
    }

    func testMacTimeZoneMismatchIsReported() {
        XCTAssertEqual(MacAutomationLogic.macTimeZone(from: ["time_zone": "America/Los_Angeles"]), "America/Los_Angeles")
        XCTAssertEqual(MacAutomationLogic.macTimeZone(from: ["automation": ["id": "a", "timezone": "Europe/Berlin"]]), "Europe/Berlin")
        XCTAssertEqual(MacAutomationLogic.macTimeZone(from: ["automations": [["id": "a", "tz": "UTC"]]]), "UTC")
        XCTAssertNil(MacAutomationLogic.macTimeZone(from: ["automations": [["id": "a"]]]), "今天的 Mac 不报时区")

        XCTAssertNil(MacAutomationLogic.timeZoneWarning(phone: "Asia/Shanghai", mac: nil))
        XCTAssertNil(MacAutomationLogic.timeZoneWarning(phone: "Asia/Shanghai", mac: "Asia/Shanghai"))
        XCTAssertNil(MacAutomationLogic.timeZoneWarning(phone: "Asia/Shanghai", mac: "Asia/Hong_Kong"), "同一偏移不算不一致")
        let warning = MacAutomationLogic.timeZoneWarning(phone: "Asia/Shanghai", mac: "America/Los_Angeles")
        XCTAssertTrue(warning?.contains("America/Los_Angeles") == true && warning?.contains("Asia/Shanghai") == true)
    }

    // MARK: - 404

    func testNotFoundDistinguishesOldMacFromMissingId() {
        XCTAssertEqual(MacAutomationLogic.classifyNotFound(action: .list, listReachable: nil), .routeMissing)
        XCTAssertEqual(MacAutomationLogic.classifyNotFound(action: .create, listReachable: nil), .routeMissing)
        XCTAssertEqual(MacAutomationLogic.classifyNotFound(action: .run, listReachable: true), .idMissing)
        XCTAssertEqual(MacAutomationLogic.classifyNotFound(action: .delete, listReachable: false), .routeMissing)
        XCTAssertEqual(MacAutomationLogic.classifyNotFound(action: .update, listReachable: nil), .idMissing,
                       "探测本身出错时按 id 不在处理,不误报版本旧")
        let missing = MacAutomationLogic.notFoundMessage(.idMissing, mac: "LeoMac-Studio-2")
        XCTAssertTrue(missing.contains("这台 Mac 上没有这个任务（id 可能在另一台）；先用 list 查"))
        XCTAssertFalse(missing.contains("1.14.0"))
        XCTAssertTrue(MacAutomationLogic.notFoundMessage(.routeMissing, mac: "mini").contains("1.14.0"))
    }

    // MARK: - 通知

    func testRunNotificationIdIsStableAcrossPushAndCatchUp() {
        XCTAssertEqual(MacAutomationLogic.runNotificationId(event: ["run_id": "automation-1:1761181200000", "automation_id": "automation-1"]),
                       "relay-automation-automation-1:1761181200000")
        XCTAssertEqual(MacAutomationLogic.runNotificationId(event: ["automation_id": "automation-1", "timestamp": 1761181260.5]),
                       "relay-automation-automation-1-1761181260")
        XCTAssertEqual(MacAutomationLogic.runSessionId(["task_id": "task-1", "session_id": "task-2"]), "task-2")
        XCTAssertEqual(MacAutomationLogic.runSessionId(["task_id": "task-1"]), "task-1")
        XCTAssertNil(MacAutomationLogic.runSessionId([:]))
    }

    func testRunNoticeShowsSummaryUnlessPrivate() {
        let long = String(repeating: "结", count: 400)
        let open = MacAutomationLogic.runNotice(machine: "mini", event: ["name": "日报", "status": "succeeded", "summary": long], privacy: false)
        XCTAssertEqual(open.body.count, MacAutomationLogic.summaryLimit)
        let hidden = MacAutomationLogic.runNotice(machine: "mini", event: ["name": "日报", "status": "succeeded", "summary": "密码是 1234"], privacy: true)
        XCTAssertFalse(hidden.body.contains("1234"))
        XCTAssertEqual(hidden.title, open.title)
    }

    // MARK: - 列表与模板(C3)

    func testSummariesParseTheMacView() {
        let list: [String: Any] = ["automations": [
            ["id": "automation-1", "name": "日报", "prompt": "汇总",
             "schedule": ["kind": "daily", "cron": "0 9 * * *", "human": "每天 09:00", "recurring": true],
             "enabled": true, "state": "active",
             "last_run": ["status": "succeeded", "at": 1761181200.0], "next_run_at": 1761267600.0],
            ["id": "automation-2", "prompt": String(repeating: "长", count: 40),
             "schedule": ["kind": "cron", "cron": "*/5 * * * *", "human": ""], "enabled": false, "state": "completed",
             "last_run": NSNull(), "next_run_at": NSNull()],
            ["name": "没有 id 的丢掉"],
        ]]
        let rows = MacAutomationLogic.summaries(fromList: list)
        XCTAssertEqual(rows.map(\.id), ["automation-1", "automation-2"])
        XCTAssertEqual(rows[0].scheduleText, "每天 09:00")
        XCTAssertEqual(rows[0].lastRunStatus, "succeeded")
        XCTAssertEqual(rows[0].lastRunAt, Date(timeIntervalSince1970: 1761181200))
        XCTAssertEqual(rows[0].nextRunAt, Date(timeIntervalSince1970: 1761267600))
        XCTAssertEqual(rows[1].scheduleText, "*/5 * * * *", "human 为空退到 cron")
        XCTAssertEqual(rows[1].name.count, 30, "没名字取 prompt 前 30 字")
        XCTAssertTrue(rows[1].isFinished)
        XCTAssertNil(rows[1].lastRunStatus)
        XCTAssertNil(rows[1].nextRunAt)
        XCTAssertEqual(MacAutomationLogic.summaries(fromList: ["error": "x"]), [])
    }

    func testTemplatesBuildCreateRequests() {
        let rows = MacAutomationLogic.templates(from: ["templates": [
            ["id": "daily-digest", "name": "每日摘要", "description": "早上汇总",
             "prompt": "汇总昨天的提交", "schedule": ["kind": "daily", "time": "09:00", "human": "每天 09:00", "recurring": true]],
            ["id": "opaque", "title": "只有 id"],
            ["name": "没 id"],
        ]])
        XCTAssertEqual(rows.map(\.id), ["daily-digest", "opaque"])
        XCTAssertEqual(rows[0].scheduleText, "每天 09:00")
        XCTAssertEqual(rows[0].create.method, "POST")
        XCTAssertEqual(rows[0].create.path, "/automations")
        XCTAssertEqual(rows[0].create.body, #"{"name":"每日摘要","prompt":"汇总昨天的提交","schedule":{"kind":"daily","time":"09:00"}}"#)
        XCTAssertEqual(rows[1].name, "只有 id")
        XCTAssertEqual(rows[1].create.body, #"{"template_id":"opaque"}"#)
        XCTAssertEqual(MacAutomationLogic.templates(from: nil), [])
    }
}
