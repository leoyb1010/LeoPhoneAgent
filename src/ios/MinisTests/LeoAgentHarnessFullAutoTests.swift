import XCTest

/// [A1][A2][A3][A5] 全自动对所有 Mac CLI 生效;Mac 拒绝时的降级与说明。
final class LeoAgentHarnessFullAutoTests: XCTestCase {
    private let harnesses = ["claude", "codex", "grok", "zcode"]

    func testCreatePayloadCarriesFullAutoForEveryHarness() {
        for key in harnesses {
            let wanted = HarnessFullAuto.wanted(gateOn: true, refused: false)
            let payload = HarnessFullAuto.createPayload(harness: key, cwd: "~", prompt: "hi", thinking: nil, fullAuto: wanted)
            XCTAssertEqual(payload["full_auto"] as? Bool, true, key)
            XCTAssertEqual(payload["harness"] as? String, key)
        }
    }

    func testFullAutoOffOrRefusedIsNotRequested() {
        for key in harnesses {
            let off = HarnessFullAuto.createPayload(harness: key, cwd: "~", prompt: "hi", thinking: nil,
                                                    fullAuto: HarnessFullAuto.wanted(gateOn: false, refused: false))
            XCTAssertNil(off["full_auto"], key)
            XCTAssertFalse(HarnessFullAuto.wanted(gateOn: true, refused: true))
        }
    }

    func testSteerValueKeepsOldDesktopCompatible() {
        for key in ["claude", "codex", "grok"] {
            XCTAssertEqual(HarnessFullAuto.steerValue(harnessKey: key, gateOn: true, refused: false), true)
            XCTAssertNil(HarnessFullAuto.steerValue(harnessKey: key, gateOn: false, refused: false))
            XCTAssertNil(HarnessFullAuto.steerValue(harnessKey: key, gateOn: true, refused: true))
        }
        XCTAssertEqual(HarnessFullAuto.steerValue(harnessKey: "zcode", gateOn: true, refused: false), true)
        XCTAssertEqual(HarnessFullAuto.steerValue(harnessKey: "zcode", gateOn: false, refused: false), false)
    }

    func testRefusalCovers403AndOldDesktop400() {
        XCTAssertTrue(HarnessFullAuto.isRefusal(status: 403, harnessKey: "zcode", requestedFullAuto: true))
        XCTAssertTrue(HarnessFullAuto.isRefusal(status: 400, harnessKey: "codex", requestedFullAuto: true))
        XCTAssertFalse(HarnessFullAuto.isRefusal(status: 400, harnessKey: "zcode", requestedFullAuto: true))
        XCTAssertFalse(HarnessFullAuto.isRefusal(status: 403, harnessKey: "claude", requestedFullAuto: false))
        XCTAssertFalse(HarnessFullAuto.isRefusal(status: 409, harnessKey: "grok", requestedFullAuto: true))
    }

    func testRefusedNoteShowsServerStepsOrConcreteFallback() {
        let envelope: [String: Any] = ["error": ["message": "认不出是哪台设备发来的", "code": "device_not_recognized",
                                                 "fix": "mac_steps", "steps": ["更新中继", "更新 Mac", "重发"]]]
        let message = HarnessFullAuto.errorMessage(from: envelope)
        XCTAssertEqual(message, "认不出是哪台设备发来的\n1. 更新中继\n2. 更新 Mac\n3. 重发")
        XCTAssertTrue(HarnessFullAuto.refusedNote(serverMessage: message).contains("3. 重发"))
        let fallback = HarnessFullAuto.refusedNote(serverMessage: "老中继的原因")
        XCTAssertTrue(fallback.contains("1. " + HarnessFullAuto.fallbackSteps[0]))
        XCTAssertFalse(fallback.contains("中继升级后才认得"))
        XCTAssertTrue(HarnessFullAuto.refusedNote(serverMessage: nil, status: 400).contains("更新到最新版"))
        XCTAssertEqual(HarnessFullAuto.errorMessage(from: ["error": ["message": "plain"]]), "plain")
    }

    func testAutoApprovalEventIsSummarisedForTimeline() {
        let auto: [String: Any] = ["event": "approval.responded", "choice": "session", "approval_id": "a1",
                                   "auto": true, "tool": "Bash", "command": "touch /tmp/a.txt"]
        XCTAssertEqual(HarnessFullAuto.autoApprovalSummary(auto), "Bash · touch /tmp/a.txt")
        XCTAssertNil(HarnessFullAuto.autoApprovalSummary(["event": "approval.responded", "choice": "once"]))
    }

    /// [A5] Paperclip 只读同一个全自动键,不引用 App 其他模块。
    func testPaperclipReadsTheSameFullAutoKey() {
        XCTAssertEqual(PaperclipFullAuto.defaultsKey, FullAutoGate.defaultsKey)
    }
}
