import XCTest

/// [E2] 从这次对话生成技能:模型输出解析、编辑页预填与保存内容。
final class SkillDraftTests: XCTestCase {
    func testParsesFencedJSONWithSurroundingText() throws {
        let output = """
        好的,草稿如下:
        ```json
        {"name": "Weekly Report Summary", "trigger": "需要整理本周周报时", "steps": ["1. 收集本周完成事项", "- 按项目分组", "写成三段式周报", "  "]}
        ```
        """
        let draft = try XCTUnwrap(SkillDraft.parse(output))
        XCTAssertEqual(draft.name, "weekly-report-summary")
        XCTAssertEqual(draft.trigger, "需要整理本周周报时")
        XCTAssertEqual(draft.steps, ["收集本周完成事项", "按项目分组", "写成三段式周报"])
    }

    func testAcceptsStepsAsTextAndDescriptionAlias() throws {
        let draft = try XCTUnwrap(SkillDraft.parse(#"{"name":"clean-inbox","description":"清理收件箱","steps":"1) 拉取未读\n2、归档通知"}"#))
        XCTAssertEqual(draft.trigger, "清理收件箱")
        XCTAssertEqual(draft.steps, ["拉取未读", "归档通知"])
    }

    func testRejectsUnusableOutput() {
        XCTAssertNil(SkillDraft.parse("我无法完成"))
        XCTAssertNil(SkillDraft.parse(#"{"name": "x", "steps": []}"#))
        XCTAssertNil(SkillDraft.parse(#"{"name": "!!!", "steps": ["a"]}"#))
    }

    func testEditorPrefillRoundTripsSteps() {
        let draft = SkillDraft(name: "trip-plan", trigger: "规划出行", steps: ["查天气", "订酒店"])
        XCTAssertEqual(draft.stepsEditorText, "查天气\n订酒店")
        XCTAssertEqual(SkillDraft.steps(fromEditorText: "1. 查天气\n\n• 订酒店\n"), ["查天气", "订酒店"])
        XCTAssertFalse(SkillDraft(name: "  ", trigger: "", steps: ["a"]).canSave)
        XCTAssertFalse(SkillDraft(name: "ok", trigger: "", steps: []).canSave)
    }

    func testSkillMDHasFrontmatterTriggerAndNumberedSteps() {
        let draft = SkillDraft(name: "trip-plan", trigger: "- 出行前: 规划行程 #旅行", steps: ["查天气", "订酒店"])
        let md = draft.skillMD
        XCTAssertTrue(md.hasPrefix("---\nname: trip-plan\ndescription: 出行前： 规划行程 ＃旅行\nversion: 0.1.0\n---\n"))
        XCTAssertTrue(md.contains("## 步骤\n1. 查天气\n2. 订酒店"))
        // 没写触发场景时 description 用名字,不留空。
        XCTAssertTrue(SkillDraft(name: "x-y", trigger: "", steps: ["a"]).skillMD.contains("description: x-y\n"))
    }

    func testTranscriptKeepsRolesAndTrimsToRecentPart() {
        let text = SkillDraft.transcript([(true, "帮我写周报"), (false, " "), (false, "好的")])
        XCTAssertEqual(text, "用户:帮我写周报\n\n助手:好的")
        let long = SkillDraft.transcript([(true, String(repeating: "a", count: 1_500)),
                                          (false, String(repeating: "b", count: 1_500))], limit: 1_000)
        XCTAssertTrue(long.hasPrefix("…\n"))
        XCTAssertTrue(long.hasSuffix("b"))
        XCTAssertEqual(long.count, 1_002)
        XCTAssertTrue(SkillDraft.prompt(transcript: text).hasSuffix(text))
    }
}
