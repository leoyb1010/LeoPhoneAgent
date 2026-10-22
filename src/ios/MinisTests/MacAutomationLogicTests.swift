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

    /// [up3-ios] 权限模式跟着建 / 改;只收 plan / guarded / build,手机不能开 yolo。
    func testModeIsForwardedOnCreateAndUpdate() throws {
        let create = try MacAutomationLogic.request(action: .create, args: [
            "prompt": "汇总新闻", "schedule": "0 8 * * *", "mode": "Plan"])
        XCTAssertEqual(create.body, #"{"mode":"plan","prompt":"汇总新闻","schedule":"0 8 * * *"}"#)
        let update = try MacAutomationLogic.request(action: .update, args: ["id": "a1", "mode": "guarded"])
        XCTAssertEqual(update.body, #"{"mode":"guarded"}"#)
        XCTAssertThrowsError(try MacAutomationLogic.request(action: .create, args: [
            "prompt": "x", "schedule": "0 8 * * *", "mode": "yolo"]))
        XCTAssertEqual(try MacAutomationLogic.request(action: .create, args: [
            "prompt": "x", "schedule": "0 8 * * *", "mode": " "]).body, #"{"prompt":"x","schedule":"0 8 * * *"}"#)
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
        // [up3-ios] 期望值用 Python 算的(中继同一个公式):
        // "relay-automation-" + hashlib.sha256(key.encode()).hexdigest()[:40],
        // key = run_id or (str(automation_id or '') + '-' + str(timestamp or ''))。
        XCTAssertEqual(MacAutomationLogic.runNotificationId(event: ["run_id": "automation-1:1761181200000", "automation_id": "automation-1"]),
                       "relay-automation-47932a0fb03906109f348358008ba8fbc119f758")
        XCTAssertEqual(MacAutomationLogic.runNotificationId(event: ["automation_id": "automation-1", "timestamp": 1761181260.5]),
                       "relay-automation-28cd86cb333c1aa1f50f30ad65427c815459e8b7")
        XCTAssertEqual(MacAutomationLogic.runNotificationId(event: ["automation_id": "automation-1", "timestamp": 1761181260]),
                       "relay-automation-9284199fc221a1893bce4035d57dd2cc30bf9f37")
        XCTAssertEqual(MacAutomationLogic.runNotificationId(event: ["automation_id": "automation-1", "run_id": ""]),
                       "relay-automation-36fdf9ad7026e5b57c4fa9ba36083aa8a6bfa42f")
        // JSON 解出来的数字(NSNumber)和字面量一样认整数 / 浮点。
        let decoded = try? JSONSerialization.jsonObject(with: Data(#"{"automation_id":"automation-1","timestamp":1761181260.5}"#.utf8)) as? [String: Any]
        XCTAssertEqual(MacAutomationLogic.runNotificationId(event: decoded ?? [:]),
                       "relay-automation-28cd86cb333c1aa1f50f30ad65427c815459e8b7")
        // 长 run_id 也不超过 APNs collapse id 的 64 字节,不同的运行不再被截成同一个。
        let long = "automation-" + String(repeating: "x", count: 60) + ":1761181200000"
        let longId = MacAutomationLogic.runNotificationId(event: ["run_id": long])
        XCTAssertEqual(longId, "relay-automation-f6720a263ad2b1ede89b6f33519f9967b47851b7")
        XCTAssertLessThanOrEqual(longId.utf8.count, 64)
        XCTAssertNotEqual(longId, MacAutomationLogic.runNotificationId(event: ["run_id": long + "1"]))
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
             "last_run": ["status": "succeeded", "at": 1761181200.0, "summary": "已汇总 3 条", "session_id": "task-9"],
             "next_run_at": 1761267600.0],
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
        XCTAssertEqual(rows[0].lastRunSummary, "已汇总 3 条")
        XCTAssertEqual(rows[0].lastRunSessionId, "task-9")
        XCTAssertNil(rows[0].lastRunProblem, "成功的不显示原因行")
        XCTAssertEqual(rows[1].scheduleText, "*/5 * * * *", "human 为空退到 cron")
        XCTAssertEqual(rows[1].name.count, 30, "没名字取 prompt 前 30 字")
        XCTAssertTrue(rows[1].isFinished)
        XCTAssertNil(rows[1].lastRunStatus)
        XCTAssertNil(rows[1].nextRunAt)
        XCTAssertNil(rows[1].lastRunSummary)
        XCTAssertNil(rows[1].lastRunSessionId)
        XCTAssertEqual(MacAutomationLogic.summaries(fromList: ["error": "x"]), [])
    }

    /// [up3-ios] 失败 / 没派发出去:列表把原因显示出来,并能打开那次运行。
    func testLastRunProblemAndSessionForFailures() {
        let rows = MacAutomationLogic.summaries(fromList: ["automations": [
            ["id": "a", "last_run": ["status": "dispatch_failed", "at": 1761181200, "summary": "  Mac 上没有可用的模型  ", "session_id": ""]],
            ["id": "b", "last_run": ["status": "failed", "summary": String(repeating: "错", count: 400), "session_id": "task-2"]],
            ["id": "c", "last_run": ["status": "running", "summary": "进行中"]],
        ]])
        XCTAssertEqual(rows[0].lastRunProblem, "Mac 上没有可用的模型")
        XCTAssertNil(rows[0].lastRunSessionId, "空的会话 id 当没有")
        XCTAssertEqual(rows[1].lastRunProblem?.count, MacAutomationLogic.summaryLimit)
        XCTAssertEqual(rows[1].lastRunSessionId, "task-2")
        XCTAssertNil(rows[2].lastRunProblem)
    }

    func testTemplatesBuildCreateRequests() {
        let rows = MacAutomationLogic.templates(from: ["templates": [
            ["id": "daily-digest", "name": "每日摘要", "description": "早上汇总",
             "prompt": "汇总昨天的提交", "schedule": ["kind": "daily", "time": "09:00", "human": "每天 09:00", "recurring": true],
             "mode": "plan"],
            ["id": "opaque", "title": "只有 id"],
            ["name": "没 id"],
            ["id": "cleanup", "name": "清理", "prompt": "清掉缓存", "schedule": "0 3 * * *", "mode": "yolo"],
        ]])
        XCTAssertEqual(rows.map(\.id), ["daily-digest", "opaque", "cleanup"])
        XCTAssertEqual(rows[0].scheduleText, "每天 09:00")
        XCTAssertEqual(rows[0].create.method, "POST")
        XCTAssertEqual(rows[0].create.path, "/automations")
        XCTAssertEqual(rows[0].create.body,
                       #"{"mode":"plan","name":"每日摘要","prompt":"汇总昨天的提交","schedule":{"kind":"daily","time":"09:00"}}"#,
                       "模板的权限模式跟着建,不能落成 Mac 默认的 build")
        XCTAssertEqual(rows[1].name, "只有 id")
        XCTAssertEqual(rows[1].create.body, #"{"template_id":"opaque"}"#)
        XCTAssertEqual(rows[2].create.body, #"{"name":"清理","prompt":"清掉缓存","schedule":"0 3 * * *"}"#,
                       "手机不认的模式不往 Mac 送")
        XCTAssertEqual(MacAutomationLogic.templates(from: nil), [])
    }
}
