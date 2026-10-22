import XCTest

/// [E1] 「Leo 画像」卡:正文拼装、2 KB 裁剪(纠错优先)、去密钥、内容指纹与发布判断。
final class BrainProfileCardTests: XCTestCase {

    private func inputs(name: String = "LeoBot", style: String = "", soul: String = "",
                        global: String = "", corrections: [String] = []) -> BrainProfileCard.Inputs {
        BrainProfileCard.Inputs(soulName: name, soulStyle: style, soulBody: soul, global: global, corrections: corrections)
    }

    // MARK: Composition

    func testHeaderAndSections() {
        let body = BrainProfileCard.composeBody(inputs(
            name: "小乐", style: "简洁直接", soul: "说中文,先给结论。",
            global: "# 关于我\n- 在上海工作\n- 用 Mac 写代码",
            corrections: ["- [2026-10-01] 不要用英文回答", "- [2026-10-02] 日期写成 yyyy-MM-dd"]))
        XCTAssertTrue(body.hasPrefix("> 由 LeoBot iPhone 自动同步，Mac 上的 Agent 会读取"))
        XCTAssertTrue(body.contains(BrainProfileCard.correctionsHeading))
        XCTAssertTrue(body.contains("不要用英文回答"))
        XCTAssertTrue(body.contains("日期写成 yyyy-MM-dd"))
        XCTAssertTrue(body.contains("助手名字:小乐"))
        XCTAssertTrue(body.contains("说话风格:简洁直接"))
        XCTAssertTrue(body.contains("先给结论"))
        XCTAssertTrue(body.contains("在上海工作"))
        // 纠错排在最前。
        let c = body.range(of: BrainProfileCard.correctionsHeading)!.lowerBound
        let p = body.range(of: BrainProfileCard.preferencesHeading)!.lowerBound
        XCTAssertLessThan(c, p)
    }

    func testDefaultSoulIsOmitted() {
        let body = BrainProfileCard.composeBody(inputs(global: "- 喜欢咖啡"))
        XCTAssertFalse(body.contains(BrainProfileCard.identityHeading))
        XCTAssertTrue(body.contains("喜欢咖啡"))
    }

    func testEmptyInputsGiveEmptyProfile() {
        let body = BrainProfileCard.composeBody(inputs())
        XCTAssertTrue(BrainProfileCard.isEmptyProfile(body))
        XCTAssertTrue(body.contains(BrainProfileCard.header))
        XCTAssertFalse(BrainProfileCard.isEmptyProfile(BrainProfileCard.composeBody(inputs(global: "x"))))
    }

    func testCappedAt2KBWithHugeInputs() {
        let global = (1...400).map { "- 偏好第 \($0) 条:很长很长的描述" }.joined(separator: "\n")
        let soul = String(repeating: "人格描述。", count: 500)
        let corrections = (1...30).map { "- [2026-10-\($0)] " + String(repeating: "纠", count: 300) }
        let body = BrainProfileCard.composeBody(inputs(name: "乐", soul: soul, global: global, corrections: corrections))
        XCTAssertLessThanOrEqual(body.utf8.count, BrainProfileCard.maxBytes)
        XCTAssertTrue(body.contains(BrainProfileCard.header))
    }

    func testCorrectionsWinOverGlobalWhenTrimming() {
        let global = (1...200).map { "- 全局记忆 \($0)" }.joined(separator: "\n")
        let corrections = (1...8).map { "- [2026-10-0\($0 % 10)] 纠错 \($0):这一条必须保留" }
        let body = BrainProfileCard.composeBody(inputs(global: global, corrections: corrections))
        XCTAssertLessThanOrEqual(body.utf8.count, BrainProfileCard.maxBytes)
        for i in 1...8 { XCTAssertTrue(body.contains("纠错 \(i):这一条必须保留"), "correction \(i) missing") }
        XCTAssertTrue(body.contains("全局记忆 1"), "GLOBAL head kept")
        XCTAssertFalse(body.contains("全局记忆 200"), "GLOBAL tail trimmed")
        XCTAssertTrue(body.contains("…"))
    }

    func testTooManyCorrectionsKeepNewestAndSayHowManyDropped() {
        let corrections = (1...30).map { "- 纠错编号\(String(format: "%02d", $0)) " + String(repeating: "长", count: 200) }
        let body = BrainProfileCard.composeBody(inputs(corrections: corrections))
        XCTAssertLessThanOrEqual(body.utf8.count, BrainProfileCard.maxBytes)
        XCTAssertTrue(body.contains("纠错编号30"), "newest kept")
        XCTAssertFalse(body.contains("纠错编号01"), "oldest dropped")
        XCTAssertTrue(body.contains("条较早的纠错没放下"))
    }

    func testSoulSectionIsShort() {
        let soul = (1...100).map { "人格第 \($0) 行" }.joined(separator: "\n")
        let body = BrainProfileCard.composeBody(inputs(name: "乐", soul: soul))
        let start = body.range(of: BrainProfileCard.identityHeading)!.upperBound
        XCTAssertLessThanOrEqual(String(body[start...]).utf8.count, BrainProfileCard.soulMaxBytes + 2)
    }

    // MARK: Secrets

    func testSecretLinesAreStripped() {
        let secrets = [
            "OpenAI key: sk-proj-abcdefghijklmnop1234567890",
            "sk-ant-api03-AbCdEfGhIjKlMnOpQrStUv",
            "token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
            "github_pat_11ABCDEFG0123456789_abcdefghijklmnop",
            "aws AKIAIOSFODNN7EXAMPLE",
            "AIzaSyA1234567890abcdefghijklmnopqrstu",
            "密码：hunter2hunter2",
            "api_key = 9f8e7d6c5b4a",
            "Authorization: Bearer abcdefghijklmnopqrstuvwxyz",
            "dGhpc0lzQUxvbmdCYXNlNjRTZWNyZXRWYWx1ZTEyMzQ1Njc4OTA=",
            "-----BEGIN OPENSSH PRIVATE KEY-----",
            "hash 0123456789abcdef0123456789abcdef",
        ]
        for s in secrets { XCTAssertTrue(BrainProfileCard.isSecretLike(s), s) }

        let body = BrainProfileCard.composeBody(inputs(
            global: "- 喜欢简洁\n" + secrets.joined(separator: "\n"),
            corrections: ["- [2026-10-01] key 是 sk-abcdefghijklmnopqrstuvwx", "- [2026-10-02] 别用 emoji"]))
        XCTAssertFalse(body.contains("sk-"))
        XCTAssertFalse(body.contains("ghp_"))
        XCTAssertFalse(body.contains("AKIA"))
        XCTAssertFalse(body.contains("hunter2"))
        XCTAssertFalse(body.contains("dGhpc0lz"))
        XCTAssertTrue(body.contains("喜欢简洁"))
        XCTAssertTrue(body.contains("别用 emoji"))
    }

    func testOrdinaryLinesAreNotSecrets() {
        let ordinary = [
            "- 项目在 /Users/leoyuan/leophone-mac/src/ios/Agent/Chat",
            "- 博客 https://github.com/leoyb1010/some-repo-name",
            "- 喜欢用 SwiftUI 写界面,讨厌 storyboard",
            "- token 预算要省着用",
            "- 生日 1990-01-01",
        ]
        for s in ordinary { XCTAssertFalse(BrainProfileCard.isSecretLike(s), s) }
        XCTAssertEqual(BrainProfileCard.stripSecrets(ordinary.joined(separator: "\n")), ordinary.joined(separator: "\n"))
    }

    // MARK: Hash and publish decision

    func testHashIsStableAndSensitive() {
        let a = BrainProfileCard.composeBody(inputs(global: "- 喜欢咖啡"))
        let b = BrainProfileCard.composeBody(inputs(global: "- 喜欢咖啡"))
        let c = BrainProfileCard.composeBody(inputs(global: "- 喜欢茶"))
        XCTAssertEqual(BrainProfileCard.contentHash(a), BrainProfileCard.contentHash(b))
        XCTAssertNotEqual(BrainProfileCard.contentHash(a), BrainProfileCard.contentHash(c))
        XCTAssertEqual(BrainProfileCard.contentHash(a).count, 64)
    }

    func testShouldPublish() {
        let gw = "https://brain.example.com/"
        let body = BrainProfileCard.composeBody(inputs(global: "- 喜欢咖啡"))
        let empty = BrainProfileCard.composeBody(inputs())
        // 从没发过:有内容就发,空的不建卡。
        XCTAssertTrue(BrainProfileCard.shouldPublish(body: body, state: nil, gateway: gw))
        XCTAssertFalse(BrainProfileCard.shouldPublish(body: empty, state: nil, gateway: gw))
        let published = BrainProfileCard.State(gateway: gw, cardId: "c1", version: 3,
                                               contentHash: BrainProfileCard.contentHash(body), status: "confirmed")
        // 没变不发;变了发;已经有卡时清空了也发(不留过期画像)。
        XCTAssertFalse(BrainProfileCard.shouldPublish(body: body, state: published, gateway: gw))
        XCTAssertTrue(BrainProfileCard.shouldPublish(body: BrainProfileCard.composeBody(inputs(global: "- 喜欢茶")),
                                                     state: published, gateway: gw))
        XCTAssertTrue(BrainProfileCard.shouldPublish(body: empty, state: published, gateway: gw))
        // 换了网关当没发过。
        XCTAssertTrue(BrainProfileCard.shouldPublish(body: body, state: published, gateway: "https://other.example.com/"))
    }

    func testCanPublishNeedsConnectionAndWriteScope() {
        XCTAssertFalse(BrainProfileCard.canPublish(configured: false, knownScopes: nil))
        XCTAssertTrue(BrainProfileCard.canPublish(configured: true, knownScopes: nil))
        XCTAssertTrue(BrainProfileCard.canPublish(configured: true, knownScopes: ["read", "write:cards"]))
        XCTAssertFalse(BrainProfileCard.canPublish(configured: true, knownScopes: ["read", "write:inbox"]))
    }

    func testStateRoundTrip() {
        let defaults = UserDefaults(suiteName: "BrainProfileCardTests-\(UUID().uuidString)")!
        XCTAssertNil(BrainProfileCard.loadState(defaults))
        let state = BrainProfileCard.State(gateway: "g", cardId: "id", version: 2, contentHash: "h", status: "reference")
        BrainProfileCard.saveState(state, defaults)
        XCTAssertEqual(BrainProfileCard.loadState(defaults), state)
        BrainProfileCard.saveState(nil, defaults)
        XCTAssertNil(BrainProfileCard.loadState(defaults))
    }

    func testDraftCarriesIdVersionAndStatus() throws {
        let draft = BrainCardDraft(id: "card-1", version: 4, title: BrainProfileCard.title, body: "b",
                                   category: BrainProfileCard.category, status: BrainProfileCard.preferredStatus)
        let obj = try XCTUnwrap(JSONSerialization.jsonObject(with: draft.jsonBody()) as? [String: Any])
        XCTAssertEqual(obj["id"] as? String, "card-1")
        XCTAssertEqual(obj["version"] as? Int, 4)
        XCTAssertEqual(obj["title"] as? String, "Leo 画像")
        XCTAssertEqual(obj["category"] as? String, "用户画像")
        XCTAssertEqual(obj["status"] as? String, "confirmed")
        XCTAssertTrue(BrainCardDraft.allowedStatuses.contains(BrainProfileCard.fallbackStatus))
    }
}
