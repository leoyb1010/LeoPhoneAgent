import XCTest

/// WP-45:本机脑的外部模型适配器(Foundation Models 27 `LanguageModel` → OpenAI Chat Completions)的线格式。
final class ChatCompletionsWireTests: XCTestCase {
    func testEndpointAppendsChatCompletionsOnce() {
        XCTAssertEqual(ChatCompletionsWire.endpoint(base: URL(string: "http://mac.local:38473/v1")!).absoluteString,
                       "http://mac.local:38473/v1/chat/completions")
        XCTAssertEqual(ChatCompletionsWire.endpoint(base: URL(string: "https://x/coding/v1/")!).absoluteString,
                       "https://x/coding/v1/chat/completions")
        XCTAssertEqual(ChatCompletionsWire.endpoint(base: URL(string: "https://x/v1/chat/completions")!).absoluteString,
                       "https://x/v1/chat/completions")
    }

    func testRequestBodyMergesSameRoleAndCarriesAuth() throws {
        let req = ChatCompletionsWire.request(
            base: URL(string: "http://mac:38473/v1")!, apiKey: "k", model: "claude-sonnet-5-5",
            messages: [.init(role: "system", content: "be brief"), .init(role: "user", content: "a"),
                       .init(role: "user", content: "b"), .init(role: "assistant", content: "")])
        XCTAssertEqual(req.value(forHTTPHeaderField: "Authorization"), "Bearer k")
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: try XCTUnwrap(req.httpBody)) as? [String: Any])
        XCTAssertEqual(body["model"] as? String, "claude-sonnet-5-5")
        XCTAssertEqual(body["stream"] as? Bool, false)
        let messages = try XCTUnwrap(body["messages"] as? [[String: String]])
        XCTAssertEqual(messages, [["role": "system", "content": "be brief"], ["role": "user", "content": "a\n\nb"]])
        let anonymous = ChatCompletionsWire.request(base: URL(string: "http://mac/v1")!, apiKey: "", model: "m", messages: [])
        XCTAssertNil(anonymous.value(forHTTPHeaderField: "Authorization"))
    }

    func testParseTextPartsUsageAndErrors() throws {
        let ok = Data(#"{"choices":[{"message":{"content":"你好"}}],"usage":{"prompt_tokens":12,"completion_tokens":3}}"#.utf8)
        XCTAssertEqual(try ChatCompletionsWire.parse(status: 200, data: ok),
                       .init(text: "你好", promptTokens: 12, completionTokens: 3))
        let parts = Data(#"{"choices":[{"message":{"content":[{"type":"text","text":"a"},{"type":"text","text":"b"}]}}]}"#.utf8)
        XCTAssertEqual(try ChatCompletionsWire.parse(status: 200, data: parts).text, "ab")
        XCTAssertThrowsError(try ChatCompletionsWire.parse(status: 401, data: Data("nope".utf8))) {
            XCTAssertEqual($0 as? ChatCompletionsWire.WireError, .http(401, "nope"))
        }
        XCTAssertThrowsError(try ChatCompletionsWire.parse(status: 200, data: Data("{}".utf8)))
    }

    func testExternalPreferenceDefaultsToNone() {
        let saved = UserDefaults.standard.string(forKey: ExternalBrainPreference.entryKey)
        defer { UserDefaults.standard.set(saved, forKey: ExternalBrainPreference.entryKey) }
        ExternalBrainPreference.entryId = nil
        XCTAssertNil(ExternalBrainPreference.entryId)
        ExternalBrainPreference.entryId = "inst/model"
        XCTAssertEqual(ExternalBrainPreference.entryId, "inst/model")
    }

    func testWiringGuards() throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
        let brain = try String(contentsOf: root.appendingPathComponent("Agent/LocalIntelligence/LocalBrain.swift"), encoding: .utf8)
        XCTAssertFalse(brain.contains("let session = LanguageModelSession("), "every session goes through makeSession")
        let tools = try String(contentsOf: root.appendingPathComponent("Agent/LocalIntelligence/LocalBrain+Tools.swift"), encoding: .utf8)
        XCTAssertTrue(tools.contains("guide: .focused(.items)"), "default Spotlight guide overflows on-device context")
        XCTAssertTrue(tools.contains("[OCRTool()]"))
        let send = try String(contentsOf: root.appendingPathComponent("Agent/Intents/SendPromptIntent.swift"), encoding: .utf8)
        XCTAssertTrue(send.contains("extension SendPromptIntent: LongRunningIntent, CancellableIntent {}"))
        let entity = try String(contentsOf: root.appendingPathComponent("Agent/Intents/SessionEntity.swift"), encoding: .utf8)
        XCTAssertTrue(entity.contains("extension SessionEntity: SyncableEntity {}"))
    }
}
