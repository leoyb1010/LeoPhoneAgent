import XCTest

/// Persistence of the unified `ThinkingRule` in UserDefaults (`leo.thinkingRules.v1`).
/// Adapted from upstream's ThinkingRulePersistenceTests (which targeted a DB table): the
/// store here keeps the existing key, reads rows written by older builds unchanged, and
/// drops — never misreads — rows it does not understand.
final class ThinkingRulePersistenceTests: XCTestCase {

    private let key = ThinkingRuleStore.defaultsKey
    private var saved: Data?

    override func setUp() {
        super.setUp()
        saved = UserDefaults.standard.data(forKey: key)
        UserDefaults.standard.removeObject(forKey: key)
    }

    override func tearDown() {
        if let saved { UserDefaults.standard.set(saved, forKey: key) } else { UserDefaults.standard.removeObject(forKey: key) }
        super.tearDown()
    }

    /// Rows saved by builds before the rule engine (`{prefix, maxLevel, defaultLevel}`)
    /// load as ceiling rules with the old prefix semantics — no migration step.
    func testLegacyCeilingRowsLoadAsCustomRules() {
        let legacy = #"[{"prefix":"gpt-5.7","maxLevel":"medium","defaultLevel":"low"},{"prefix":"","maxLevel":"high","defaultLevel":"low"}]"#
        UserDefaults.standard.set(Data(legacy.utf8), forKey: key)
        let rules = ThinkingRuleStore.load()
        XCTAssertEqual(rules.count, 1, "an empty prefix is not a rule")
        XCTAssertEqual(rules.first?.kind, .custom)
        XCTAssertEqual(rules.first?.maxLevel, .medium)
        XCTAssertNil(rules.first?.wireFormat)
        XCTAssertEqual(ThinkingRuleStore.ceiling(for: "gpt-5.7-preview"), .medium)
        XCTAssertNil(ThinkingRuleStore.ceiling(for: "gpt-5.6"))
        XCTAssertTrue(ThinkingRuleStore.wireRules(for: nil).isEmpty, "a ceiling row is not a wire rule")
    }

    /// Every wire format round-trips through the persisted JSON form.
    func testWireRuleRoundTrip() {
        let formats: [ThinkingWireFormat] = [
            .omitEverything, .reasoningEffort(offValue: "minimal"), .reasoningEffort(offValue: nil),
            .reasoningEffortNested(offValue: nil), .deepSeekSibling, .qwenDual, .qwenRootOnly,
            .booleanToggle(path: "thinking"), .extraBodyToggle(path: "extra_body.thinking.enabled"),
            .customPath(path: "x.y", values: [.high: "hi", .low: "lo"], offValue: "off"),
        ]
        let rules = formats.enumerated().map { i, f in
            ThinkingRule(kind: .custom, scope: .modelPattern("model-\(i)*"), wireFormat: f,
                         label: "r\(i)", providerInstanceId: i.isMultiple(of: 2) ? "inst-a" : nil)
        }
        ThinkingRuleStore.save(rules)
        let loaded = ThinkingRuleStore.load()
        XCTAssertEqual(loaded.count, rules.count)
        for (a, b) in zip(rules, loaded) {
            XCTAssertEqual(a.wireFormat, b.wireFormat)
            XCTAssertEqual(a.scope, b.scope)
            XCTAssertEqual(a.id, b.id, "ids are stable across a save/load")
            XCTAssertEqual(a.providerInstanceId, b.providerInstanceId)
        }
    }

    /// A rule written by a NEWER build (unknown wire kind) is dropped, not misread, and
    /// does not take the rest of the list with it.
    func testUnknownWireKindDropsOnlyThatRow() {
        let raw = #"[{"id":"a","label":"a","scopeKind":"modelPattern","pattern":"x*","wireFormat":{"kind":"fromTheFuture"}},{"id":"b","label":"b","scopeKind":"modelPattern","pattern":"y*","wireFormat":{"kind":"deepSeekSibling"}}]"#
        UserDefaults.standard.set(Data(raw.utf8), forKey: key)
        let rules = ThinkingRuleStore.load()
        XCTAssertEqual(rules.map(\.id), ["b"])
    }

    /// Corrupt storage reads as "no rules" (built-in behaviour), never a crash.
    func testCorruptStorageReadsAsEmpty() {
        UserDefaults.standard.set(Data("not json".utf8), forKey: key)
        XCTAssertTrue(ThinkingRuleStore.load().isEmpty)
    }

    /// Instance-pinned rules apply only to their instance; global rules to every one.
    func testWireRulesScopeToProviderInstance() {
        ThinkingRuleStore.save([
            ThinkingRule(kind: .custom, scope: .modelPattern("a*"), wireFormat: .omitEverything,
                         label: "pinned", providerInstanceId: "inst-1"),
            ThinkingRule(kind: .custom, scope: .modelPattern("b*"), wireFormat: .qwenRootOnly, label: "global"),
        ])
        XCTAssertEqual(ThinkingRuleStore.wireRules(for: "inst-1").map(\.label), ["pinned", "global"])
        XCTAssertEqual(ThinkingRuleStore.wireRules(for: "inst-2").map(\.label), ["global"])
        XCTAssertEqual(ThinkingRuleStore.wireRules(for: nil).map(\.label), ["global"])
    }

    /// A saved ceiling row still carries the legacy keys, so an older build reads it.
    func testCeilingRowKeepsLegacyKeys() throws {
        ThinkingRuleStore.save([.ceiling(prefix: "glm-5", maxLevel: .high)])
        let data = try XCTUnwrap(UserDefaults.standard.data(forKey: key))
        let rows = try XCTUnwrap(try JSONSerialization.jsonObject(with: data) as? [[String: Any]])
        XCTAssertEqual(rows.first?["prefix"] as? String, "glm-5")
        XCTAssertEqual(rows.first?["maxLevel"] as? String, "high")
        XCTAssertNotNil(rows.first?["defaultLevel"])
    }
}
