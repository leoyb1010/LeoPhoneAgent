import XCTest

final class ThinkingLevelTests: XCTestCase {

    func testDecodedKnownValues() {
        XCTAssertEqual(ThinkingLevel.decoded("off"), .off)
        XCTAssertEqual(ThinkingLevel.decoded("low"), .low)
        XCTAssertEqual(ThinkingLevel.decoded("medium"), .medium)
        XCTAssertEqual(ThinkingLevel.decoded("high"), .high)
        XCTAssertEqual(ThinkingLevel.decoded("xhigh"), .xhigh)
        XCTAssertEqual(ThinkingLevel.decoded("max"), .max)
        XCTAssertEqual(ThinkingLevel.decoded("ultra"), .ultra)
    }

    func testDecodedUnknownValueFallsBackToXHigh() {
        XCTAssertEqual(ThinkingLevel.decoded("some-future-level"), .xhigh)
        XCTAssertEqual(ThinkingLevel.decoded(""), .xhigh)
        XCTAssertEqual(ThinkingLevel.decoded("supermax"), .xhigh)
    }

    func testComparable() {
        XCTAssertTrue(ThinkingLevel.off < .low)
        XCTAssertTrue(ThinkingLevel.low < .medium)
        XCTAssertTrue(ThinkingLevel.medium < .high)
        XCTAssertTrue(ThinkingLevel.high < .xhigh)
        XCTAssertTrue(ThinkingLevel.xhigh < .max)
        XCTAssertTrue(ThinkingLevel.max < .ultra)
        XCTAssertFalse(ThinkingLevel.ultra < .off)
    }

    func testModelGroupDecodeWithUltraThinkingLevel() throws {
        let json = """
        {
            "id": "test-group",
            "name": "Test",
            "memberEntryIds": [],
            "strategy": "fallback",
            "defaultThinkingLevel": "ultra"
        }
        """.data(using: .utf8)!
        let group = try JSONDecoder().decode(ModelGroup.self, from: json)
        XCTAssertEqual(group.defaultThinkingLevel, .ultra)
    }

    func testModelGroupDecodeWithUnknownThinkingLevel() throws {
        let json = """
        {
            "id": "test-group",
            "name": "Test",
            "memberEntryIds": [],
            "strategy": "fallback",
            "defaultThinkingLevel": "some-future-level"
        }
        """.data(using: .utf8)!
        let group = try JSONDecoder().decode(ModelGroup.self, from: json)
        XCTAssertEqual(group.defaultThinkingLevel, .xhigh)
    }

    func testCustomThinkingRuleBeatsBuiltinCatalog() {
        let key = ThinkingRuleStore.defaultsKey
        let previous = UserDefaults.standard.data(forKey: key)
        defer {
            if let previous {
                UserDefaults.standard.set(previous, forKey: key)
            } else {
                UserDefaults.standard.removeObject(forKey: key)
            }
        }
        ThinkingRuleStore.save([
            ThinkingRule(prefix: "gpt-5.7-new", maxLevel: .medium, defaultLevel: .low)
        ])
        XCTAssertEqual(ThinkingLevelCatalog.declaredMaxLevel(for: "gpt-5.7-new-preview"), .medium)
        XCTAssertTrue(ThinkingLevelCatalog.isKnownFamily(for: "gpt-5.7-new-preview"))
        XCTAssertNil(ThinkingLevelCatalog.declaredMaxLevel(for: "totally-unknown-model-xyz"))
    }

    /// [T-thinking-rules-hot-path] declaredMaxLevel 现在缓存 decode 结果。
    /// 缓存判据必须是「UserDefaults 里那份 Data」,不能靠 save() 主动失效 ——
    /// 否则任何绕过 save() 的写入(测试、配置下发、另一个进程)都会读到陈旧值。
    func testThinkingRuleCacheFollowsRawDefaultsWrites() throws {
        let key = ThinkingRuleStore.defaultsKey
        let previous = UserDefaults.standard.data(forKey: key)
        defer {
            if let previous {
                UserDefaults.standard.set(previous, forKey: key)
            } else {
                UserDefaults.standard.removeObject(forKey: key)
            }
        }

        ThinkingRuleStore.save([
            ThinkingRule(prefix: "cache-probe", maxLevel: .medium, defaultLevel: .low)
        ])
        XCTAssertEqual(ThinkingLevelCatalog.declaredMaxLevel(for: "cache-probe-1"), .medium)

        // 绕过 save(),直接改 UserDefaults —— 必须立刻被看到。
        let raw = try JSONEncoder().encode([
            ThinkingRule(prefix: "cache-probe", maxLevel: .low, defaultLevel: .low)
        ])
        UserDefaults.standard.set(raw, forKey: key)
        XCTAssertEqual(ThinkingLevelCatalog.declaredMaxLevel(for: "cache-probe-1"), .low)

        // 删掉键之后也不能继续吐旧规则。
        UserDefaults.standard.removeObject(forKey: key)
        XCTAssertNil(ThinkingLevelCatalog.declaredMaxLevel(for: "cache-probe-1"))
    }

    func testSessionInferenceConfigDecodeWithUnknownLevel() throws {
        let json = """
        { "thinkingLevel": "hyper-future" }
        """.data(using: .utf8)!
        let cfg = try JSONDecoder().decode(SessionInferenceConfig.self, from: json)
        XCTAssertEqual(cfg.thinkingLevel, .xhigh)
    }
}
