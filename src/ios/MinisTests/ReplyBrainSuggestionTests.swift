import XCTest

/// [E2] 「值得收进大脑？」:够长 + 有结构才建议;报错 / 闲聊 / 出错回合不建议;每条最多一次。
final class ReplyBrainSuggestionTests: XCTestCase {

    private let filler = String(repeating: "这是一段有内容的说明文字，", count: 30)   // ~390 字

    func testStructuredLongReplyQualifies() {
        let withList = "## 方案对比\n\n" + filler + "\n\n- 第一点:成本低\n- 第二点:上手快\n- 第三点:可维护"
        XCTAssertTrue(ReplyNextStep.suggestsBrain(reply: withList))

        let numbered = filler + "\n1. 先备份\n2. 再升级\n3. 最后验证"
        XCTAssertTrue(ReplyNextStep.suggestsBrain(reply: numbered))

        let chineseNumbered = filler + "\n1、先备份\n2、再升级"
        XCTAssertTrue(ReplyNextStep.suggestsBrain(reply: chineseNumbered))

        let table = filler + "\n\n| 项目 | 价格 |\n| --- | --- |\n| A | 1 |\n| B | 2 |"
        XCTAssertTrue(ReplyNextStep.suggestsBrain(reply: table))

        let heading = "# 总结\n" + filler + "再补充一些。"
        XCTAssertTrue(ReplyNextStep.suggestsBrain(reply: heading))
    }

    func testShortReplyDoesNotQualify() {
        XCTAssertFalse(ReplyNextStep.suggestsBrain(reply: "## 好的\n- 一\n- 二"))
    }

    func testUnstructuredCasualChatDoesNotQualify() {
        XCTAssertFalse(ReplyNextStep.suggestsBrain(reply: filler + filler))
        // 只有一个列表项不算结构;分隔线也不算列表。
        XCTAssertFalse(ReplyNextStep.suggestsBrain(reply: filler + "\n- 唯一一点\n\n---\n\n* * *\n" + filler))
        // 1.5 倍这种数字不是列表。
        XCTAssertFalse(ReplyNextStep.suggestsBrain(reply: filler + "\n1.5 倍的速度\n2.0 版本更好"))
    }

    func testStructureInsideCodeFenceDoesNotCount() {
        let code = filler + "\n```\n# comment\n- a\n- b\n| x | y |\n|---|---|\n| 1 | 2 |\n```"
        XCTAssertFalse(ReplyNextStep.suggestsBrain(reply: code))
    }

    func testErrorsDoNotQualify() {
        let structured = "## 标题\n" + filler + "\n- 一\n- 二"
        XCTAssertFalse(ReplyNextStep.suggestsBrain(reply: structured, hasError: true))
        XCTAssertFalse(ReplyNextStep.suggestsBrain(reply: "Error: tool failed\n" + structured))
        XCTAssertFalse(ReplyNextStep.suggestsBrain(reply: "抱歉，工具调用失败了。\n" + structured))
        XCTAssertFalse(ReplyNextStep.suggestsBrain(reply: "错误：找不到文件\n" + structured))
    }

    func testLedgerMarksOncePerReplyAndIsBounded() {
        let defaults = UserDefaults(suiteName: "ReplyBrainSuggestionTests-\(UUID().uuidString)")!
        let ledger = ReplyNextStep.BrainSuggestionLedger(defaults: defaults)
        let id = UUID()
        XCTAssertFalse(ledger.isHandled(id))
        ledger.markHandled(id)
        ledger.markHandled(id)
        XCTAssertTrue(ledger.isHandled(id))
        XCTAssertEqual(defaults.stringArray(forKey: ReplyNextStep.BrainSuggestionLedger.key)?.count, 1)

        for _ in 0..<(ReplyNextStep.BrainSuggestionLedger.limit + 5) { ledger.markHandled(UUID()) }
        XCTAssertEqual(defaults.stringArray(forKey: ReplyNextStep.BrainSuggestionLedger.key)?.count,
                       ReplyNextStep.BrainSuggestionLedger.limit)
        XCTAssertFalse(ledger.isHandled(id), "oldest entry rolled off")
    }
}
