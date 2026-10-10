import XCTest

/// [F1] 端侧标题/分类与追问建议的纯逻辑(`LocalIntelligencePolicies.swift`)。
final class LocalIntelligencePolicyTests: XCTestCase {

    // MARK: 输入裁剪(4,096 token 窗口)

    func testTitleInputIsTruncatedToBudget() {
        let input = OnDeviceTextBudget.titleInput(firstUser: String(repeating: "问", count: 50_000),
                                                  replyStart: String(repeating: "答", count: 50_000))
        XCTAssertEqual(input.user.count, OnDeviceTextBudget.titleUserChars)
        XCTAssertEqual(input.reply.count, OnDeviceTextBudget.titleReplyChars)
        // 输入 + 指令远小于窗口(中文最坏 1 token/字)。
        XCTAssertLessThan(input.user.count + input.reply.count + 400, OnDeviceTextBudget.contextTokens / 2)
    }

    func testClipStripsAttachmentBlockAndCollapsesWhitespace() {
        let raw = "帮我看看\n\n<user-attached-files><file>secret.pdf</file></user-attached-files>  这个   文件"
        XCTAssertEqual(OnDeviceTextBudget.clip(raw, limit: 100), "帮我看看 这个 文件")
        XCTAssertEqual(OnDeviceTextBudget.clip("abc", limit: 0), "")
    }

    // MARK: 标题校验

    func testValidTitlesPass() {
        XCTAssertEqual(OnDeviceTitleValidator.validate("“修复登录页问题”。"), "修复登录页问题")
        XCTAssertEqual(OnDeviceTitleValidator.validate("标题:  Debug   Login Page"), "Debug Login Page")
        XCTAssertEqual(OnDeviceTitleValidator.validate("\n\n周末去杭州的行程\n分类:travel"), "周末去杭州的行程")
    }

    func testInvalidTitlesAreRejectedSoCloudFallbackRuns() {
        XCTAssertNil(OnDeviceTitleValidator.validate(""))
        XCTAssertNil(OnDeviceTitleValidator.validate("   \n  "))
        XCTAssertNil(OnDeviceTitleValidator.validate(String(repeating: "长", count: 41)))
        XCTAssertNil(OnDeviceTitleValidator.validate("{\"title\": \"x\"}"))
        XCTAssertNil(OnDeviceTitleValidator.validate("抱歉,我无法为这段对话生成标题"))
        XCTAssertNil(OnDeviceTitleValidator.validate("I'm sorry, I can't help"))
        XCTAssertNil(OnDeviceTitleValidator.validate("……!!!"))
        XCTAssertEqual(OnDeviceTitleValidator.validate("A\u{0007}B 计划"), "AB 计划")
    }

    func testCategoryOnlyFromAllowedSet() {
        XCTAssertEqual(SessionTitleCategory.normalize(" Code "), "code")
        XCTAssertNil(SessionTitleCategory.normalize("hacking"))
        XCTAssertNil(SessionTitleCategory.normalize(nil))
        XCTAssertNil(SessionTitleCategory.normalize(""))
    }

    // MARK: 追问建议

    private func should(enabled: Bool = true, ready: Bool = true, source: String? = nil, sub: Bool = false,
                        programmatic: Bool = false, cancelled: Bool = false, reply: String = "这是回答",
                        error: Bool = false) -> Bool {
        FollowUpSuggestionPolicy.shouldGenerate(enabled: enabled, onDeviceReady: ready, sessionSource: source,
                                                isSubAgent: sub, isProgrammaticSend: programmatic,
                                                userCancelled: cancelled, replyText: reply, replyHasError: error)
    }

    func testFollowUpsOnlyForInteractiveSessionsWithOnDeviceModel() {
        XCTAssertTrue(should())
        XCTAssertTrue(should(source: ""))
        XCTAssertFalse(should(enabled: false))
        XCTAssertFalse(should(ready: false))  // 本机模型不可用:不生成,也绝不联网
        for source in ["quiet", "context", "subagent", "orchestration", "shortcut", "siri", "watch", "cli"] {
            XCTAssertFalse(should(source: source), source)
        }
        XCTAssertFalse(should(sub: true))
        XCTAssertFalse(should(programmatic: true))
        XCTAssertFalse(should(cancelled: true))
        XCTAssertFalse(should(error: true))
        XCTAssertFalse(should(reply: "  "))
    }

    func testFollowUpSettingDefaultsOn() {
        let defaults = UserDefaults(suiteName: "F1FollowUp-\(UUID().uuidString)")!
        XCTAssertTrue(FollowUpSuggestionPolicy.isEnabled(defaults))
        defaults.set(false, forKey: FollowUpSuggestionPolicy.enabledKey)
        XCTAssertFalse(FollowUpSuggestionPolicy.isEnabled(defaults))
    }

    func testSanitizeCapsDedupesAndStripsMarkers() {
        let raw = ["1. 怎么部署到生产环境?", "- 怎么部署到生产环境?", "“能给个例子吗”", "", "第二行\n还有",
                   String(repeating: "长", count: 60), "帮我写个脚本", "还有别的方法吗"]
        let out = FollowUpSuggestionPolicy.sanitize(raw, lastUserPrompt: "帮我写个脚本")
        XCTAssertEqual(out, ["怎么部署到生产环境?", "能给个例子吗", "第二行"])
        XCTAssertLessThanOrEqual(out.count, FollowUpSuggestionPolicy.maxCount)
        XCTAssertTrue(FollowUpSuggestionPolicy.sanitize([], lastUserPrompt: "x").isEmpty)
    }
}
