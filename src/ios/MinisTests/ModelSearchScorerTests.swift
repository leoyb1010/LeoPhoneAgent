import XCTest

/// [F1] 模型选择器搜索相关度与「新模型在前」排序(`ModelSearchScorer.swift`)。
final class ModelSearchScorerTests: XCTestCase {
    private struct Row { let id: String; let name: String; var provider = "Prov" }
    private func fields(_ r: Row) -> ModelSearchScorer.Fields {
        .init(displayName: r.name, baseDisplayName: r.name, modelId: r.id, providerLabel: r.provider)
    }
    private func score(_ q: String, _ r: Row) -> Int? { ModelSearchScorer.score(q, fields: fields(r)) }

    func testExactIdWinsOverPrefixMatches() {
        let rows = [Row(id: "gpt-5-mini", name: "GPT-5 mini"), Row(id: "gpt-5-pro", name: "GPT-5 Pro"),
                    Row(id: "gpt-5", name: "GPT-5")]
        let ranked = ModelSearchScorer.rank(rows, query: "gpt-5", fields: fields)
        XCTAssertEqual(ranked.first?.id, "gpt-5")
        XCTAssertEqual(ranked.count, 3)
    }

    func testTierOrderPrefixWordBoundarySubstringFuzzy() {
        let prefix = score("son", Row(id: "sonnet-4", name: "x"))
        let boundary = score("son", Row(id: "claude-sonnet", name: "x"))
        let substring = score("son", Row(id: "jsonmodel", name: "x"))
        let fuzzy = score("snt", Row(id: "sonnet", name: "x"))
        XCTAssertNotNil(prefix); XCTAssertNotNil(boundary); XCTAssertNotNil(substring); XCTAssertNotNil(fuzzy)
        XCTAssertGreaterThan(prefix!, boundary!)
        XCTAssertGreaterThan(boundary!, substring!)
        XCTAssertGreaterThan(substring!, fuzzy!)
    }

    func testRankOrdersByTierAndKeepsInputOrderOnTies() {
        let rows = [Row(id: "a-qwen-z", name: "z1"), Row(id: "xqwenx", name: "z2"),
                    Row(id: "qwen3-max", name: "z3"), Row(id: "qwen3-plus", name: "z4")]
        let ranked = ModelSearchScorer.rank(rows, query: "qwen", fields: fields).map(\.id)
        XCTAssertEqual(ranked, ["qwen3-max", "qwen3-plus", "a-qwen-z", "xqwenx"])
    }

    func testEveryTermMustMatchSomeField() {
        let r = Row(id: "deepseek-chat", name: "DeepSeek Chat", provider: "My Relay")
        XCTAssertNotNil(score("relay chat", r))
        XCTAssertNil(score("relay vision", r))
    }

    func testProviderOnlyMatchRanksBelowModelMatch() {
        let byModel = Row(id: "kimi-k2", name: "Kimi K2", provider: "Other")
        let byProvider = Row(id: "abc", name: "ABC", provider: "Kimi Relay")
        XCTAssertEqual(ModelSearchScorer.rank([byProvider, byModel], query: "kimi", fields: fields).first?.id, "kimi-k2")
    }

    func testNoMatchAndEmptyQuery() {
        XCTAssertNil(score("zzz", Row(id: "gpt-5", name: "GPT-5")))
        XCTAssertEqual(score("   ", Row(id: "gpt-5", name: "GPT-5")), 0)
        XCTAssertEqual(ModelSearchScorer.rank([Row(id: "b", name: "b"), Row(id: "a", name: "a")], query: "",
                                              fields: fields).map(\.id), ["b", "a"])
    }

    func testFuzzyNeedsThreeCharactersAndIsCaseWidthInsensitive() {
        XCTAssertNil(score("gx", Row(id: "gpt-x", name: "n")))  // 两个字不做模糊
        XCTAssertNotNil(score("GPT4O", Row(id: "gpt-4o", name: "n")))
        XCTAssertNotNil(score("ＣＬＡＵＤＥ", Row(id: "claude-opus", name: "n")))
        XCTAssertNotNil(score("cafe", Row(id: "x", name: "Café Model")))
    }

    func testRecencyNewestFirstUnknownLastStable() {
        let items = [("old", "2024-01-02"), ("none1", nil), ("new", "2026-04-24"), ("bad", "soon"),
                     ("mid", "2025-06"), ("none2", nil)] as [(String, String?)]
        let sorted = ModelRecency.sortNewestFirst(items) { $0.1 }.map { $0.0 }
        XCTAssertEqual(sorted, ["new", "mid", "old", "none1", "bad", "none2"])
    }
}
