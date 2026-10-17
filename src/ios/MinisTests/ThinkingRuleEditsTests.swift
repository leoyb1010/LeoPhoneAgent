import XCTest

/// WP-40:思考规则编辑页与 minis-config `thinkingrules` 共用的校验。
final class ThinkingRuleEditsTests: XCTestCase {
    func testRuleMustDoSomething() {
        XCTAssertThrowsError(try ThinkingRuleEdits.makeRule(pattern: "gpt-5.7", maxLevel: nil, wireFormat: nil)) {
            XCTAssertEqual($0 as? ThinkingRuleEdits.EditError, .nothingToDo)
        }
        XCTAssertThrowsError(try ThinkingRuleEdits.makeRule(pattern: "  ", maxLevel: .high, wireFormat: nil)) {
            XCTAssertEqual($0 as? ThinkingRuleEdits.EditError, .emptyPattern)
        }
        XCTAssertThrowsError(try ThinkingRuleEdits.makeRule(pattern: "x", maxLevel: .off, wireFormat: nil)) {
            XCTAssertEqual($0 as? ThinkingRuleEdits.EditError, .offIsNotACeiling)
        }
    }

    func testMakeRuleTrimsAndDefaultsLabelAndProvider() throws {
        let rule = try ThinkingRuleEdits.makeRule(pattern: " gpt-5.7 ", maxLevel: .max, wireFormat: .qwenRootOnly,
                                                  label: "  ", providerInstanceId: " ")
        XCTAssertEqual(rule.kind, .custom)
        XCTAssertEqual(rule.patternText, "gpt-5.7")
        XCTAssertEqual(rule.label, "gpt-5.7")
        XCTAssertNil(rule.providerInstanceId)
        XCTAssertTrue(rule.matches("gpt-5.7-mini"), "no * = prefix")
        let kept = try ThinkingRuleEdits.makeRule(pattern: "a", maxLevel: .low, wireFormat: nil, id: rule.id)
        XCTAssertEqual(kept.id, rule.id, "editing keeps identity")
    }

    func testOrderingOperations() throws {
        let a = try ThinkingRuleEdits.makeRule(pattern: "a", maxLevel: .low, wireFormat: nil)
        let b = try ThinkingRuleEdits.makeRule(pattern: "b", maxLevel: .low, wireFormat: nil)
        let c = try ThinkingRuleEdits.makeRule(pattern: "c", maxLevel: .low, wireFormat: nil)
        var list = ThinkingRuleEdits.inserting(a, into: [])
        list = ThinkingRuleEdits.inserting(b, into: list)          // 默认插到最前 = 最高优先级
        list = ThinkingRuleEdits.inserting(c, into: list, at: 99)  // 越界 = 末尾
        XCTAssertEqual(list.map(\.patternText), ["b", "a", "c"])
        XCTAssertEqual(try ThinkingRuleEdits.reordered(list, ids: [c.id, a.id, b.id]).map(\.patternText), ["c", "a", "b"])
        XCTAssertThrowsError(try ThinkingRuleEdits.reordered(list, ids: [c.id, a.id]))
        XCTAssertThrowsError(try ThinkingRuleEdits.reordered(list, ids: [c.id, a.id, "zzz"]))
        var edited = a; edited.label = "renamed"
        XCTAssertEqual(try ThinkingRuleEdits.replacing(edited, in: list).map(\.label), ["b", "renamed", "c"])
        XCTAssertEqual(try ThinkingRuleEdits.removing(id: b.id, from: list).map(\.patternText), ["a", "c"])
        XCTAssertThrowsError(try ThinkingRuleEdits.removing(id: "nope", from: list))
    }

    func testMatchPreviewFindsConfiguredModels() throws {
        let rule = try ThinkingRuleEdits.makeRule(pattern: "claude-opus-4.8", maxLevel: .max, wireFormat: nil)
        let hits = ThinkingRuleEdits.matchedModelIds(rule, among: ["claude-opus-4-8", "CLAUDE-OPUS-4-8", "gpt-5.7", "claude-opus-4.8-fast"])
        XCTAssertEqual(hits, ["claude-opus-4-8", "claude-opus-4.8-fast"], "dot/dash and case are folded; duplicates once")
    }
}
