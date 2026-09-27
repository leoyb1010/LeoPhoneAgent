import XCTest

/// OpenCode Go serves each model on one endpoint; sending it to another one is
/// a 4xx on every request. Fallback expectations mirror the endpoint table of
/// https://opencode.ai/docs/go/ (checked 2026-09-27).
final class OpenCodeGoWireProtocolTests: XCTestCase {

    private func route(_ id: String, npm: String? = nil) -> OpenCodeGoWireProtocol {
        OpenCodeGoWireProtocol.resolve(modelId: id, catalogNpm: npm)
    }

    func testDocsTable_withoutCatalog() {
        let messages = ["minimax-m3", "minimax-m2.7", "minimax-m2.5",
                        "qwen3.8-max", "qwen3.8-flash", "qwen3.7-max", "qwen3.7-plus", "qwen3.6-plus"]
        let responses = ["grok-4.7", "grok-4.6", "gpt-6-luna", "gpt-5.6-luna",
                         "muse-spark-1.3-contributor", "muse-spark-1.2-contributor"]
        let chat = ["glm-5.3-flash", "glm-5.3", "glm-5.2", "glm-5.1", "kimi-k3", "kimi-k2.7-code", "kimi-k2.6",
                    "longcat-2.0", "deepseek-v4.1-flash", "deepseek-v4-pro", "deepseek-v4-flash",
                    "deepseek-v4-flash-vision-exp", "mimo-v2.6-flash", "mimo-v2.6-pro", "mimo-v2.5",
                    "mimo-v2.5-pro", "hy4-preview", "hy3", "space-bunny-free", "longcat-2.5-preview-free"]
        for id in messages { XCTAssertEqual(route(id), .anthropicMessages, id) }
        for id in responses { XCTAssertEqual(route(id), .responses, id) }
        for id in chat { XCTAssertEqual(route(id), .chatCompletions, id) }
    }

    func testUnknownFutureModelsFollowTheirFamily() {
        XCTAssertEqual(route("minimax-m4"), .anthropicMessages)
        XCTAssertEqual(route("qwen3.9-max"), .anthropicMessages)
        XCTAssertEqual(route("gpt-7-luna"), .responses)
        XCTAssertEqual(route("glm-6"), .chatCompletions)
    }

    func testProviderPrefixAndCaseAreIgnored() {
        XCTAssertEqual(route("opencode-go/MiniMax-M2.7"), .anthropicMessages)
        XCTAssertEqual(route("opencode-go/GPT-5.6-luna"), .responses)
        XCTAssertEqual(OpenCodeGoWireProtocol.bareId("opencode-go/Qwen3.8-Max"), "qwen3.8-max")
    }

    func testCatalogNpmWins() {
        XCTAssertEqual(route("glm-9", npm: "@ai-sdk/anthropic"), .anthropicMessages)
        XCTAssertEqual(route("kimi-k4", npm: "@ai-sdk/openai"), .responses)
        XCTAssertEqual(route("qwen3.8-max", npm: "@ai-sdk/openai-compatible"), .chatCompletions)
        XCTAssertEqual(route("minimax-m2.7", npm: "@AI-SDK/Anthropic"), .anthropicMessages)
    }

    func testUnknownCatalogNpmFallsBackToTable() {
        XCTAssertEqual(route("minimax-m2.7", npm: "@ai-sdk/google"), .anthropicMessages)
        XCTAssertEqual(route("glm-5.3", npm: ""), .chatCompletions)
        XCTAssertNil(OpenCodeGoWireProtocol.fromNpm("@ai-sdk/google"))
    }

    /// models.dev (2026-09-27) gives only some models their own npm; the rest
    /// must still land where the docs put them.
    func testCurrentCatalogSnapshot() {
        let catalog: [String: String?] = [
            "minimax-m2.7": "@ai-sdk/anthropic", "minimax-m2.5": "@ai-sdk/anthropic",
            "minimax-m3": "@ai-sdk/anthropic", "qwen3.8-flash": "@ai-sdk/anthropic",
            "qwen3.8-max": nil, "qwen3.7-plus": nil, "gpt-5.6-luna": "@ai-sdk/openai",
            "grok-4.6": "@ai-sdk/openai", "kimi-k3": nil, "deepseek-v4-pro": nil,
        ]
        let expected: [String: OpenCodeGoWireProtocol] = [
            "minimax-m2.7": .anthropicMessages, "minimax-m2.5": .anthropicMessages,
            "minimax-m3": .anthropicMessages, "qwen3.8-flash": .anthropicMessages,
            "qwen3.8-max": .anthropicMessages, "qwen3.7-plus": .anthropicMessages,
            "gpt-5.6-luna": .responses, "grok-4.6": .responses,
            "kimi-k3": .chatCompletions, "deepseek-v4-pro": .chatCompletions,
        ]
        for (id, npm) in catalog {
            XCTAssertEqual(route(id, npm: npm), expected[id], id)
        }
    }
}
