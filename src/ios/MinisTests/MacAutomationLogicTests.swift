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
}
