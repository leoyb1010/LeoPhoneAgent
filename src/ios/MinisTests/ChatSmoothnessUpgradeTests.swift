import XCTest

/// 2026-10 聊天流畅度升级：纯逻辑直接测，渲染/列表/视图（不在逻辑测试 target 里）按源码钉住接线。
final class ChatSmoothnessUpgradeTests: XCTestCase {
    private func source(_ relative: String) throws -> String {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
        return try String(contentsOf: root.appendingPathComponent(relative), encoding: .utf8)
    }

    // MARK: 工具调用写进思考（OpenMinis Android 1.15）

    func testMisplacedToolCallInThinkingIsRecognized() {
        let names = ["shell_execute", "file_read"]
        let dsml = "我需要先看看目录。<｜DSML｜function_calls><｜DSML｜invoke name=\"shell_execute\">ls</｜DSML｜invoke>"
        XCTAssertTrue(AgentChatCorrectness.reasoningContainsMisplacedToolCall(text: "", toolCallCount: 0, reasoning: dsml, toolNames: names))
        XCTAssertTrue(AgentChatCorrectness.reasoningContainsMisplacedToolCall(
            text: "  \n", toolCallCount: 0, reasoning: "<tool_call>{\"name\": \"file_read\"}</tool_call>", toolNames: names))
        XCTAssertTrue(AgentChatCorrectness.reasoningContainsMisplacedToolCall(
            text: "", toolCallCount: 0, reasoning: "{\"name\": \"shell_execute\", \"arguments\": {\"command\": \"ls\"}}", toolNames: names))
    }

    func testOrdinaryThinkingOrRealToolCallIsNotRetried() {
        let names = ["shell_execute"]
        // 只是在思考里提到工具名
        XCTAssertFalse(AgentChatCorrectness.reasoningContainsMisplacedToolCall(
            text: "", toolCallCount: 0, reasoning: "我应该用 shell_execute 列出文件", toolNames: names))
        // 有正文 / 有真正的工具调用：不是这种情况
        XCTAssertFalse(AgentChatCorrectness.reasoningContainsMisplacedToolCall(
            text: "好的", toolCallCount: 0, reasoning: "<tool_call>", toolNames: names))
        XCTAssertFalse(AgentChatCorrectness.reasoningContainsMisplacedToolCall(
            text: "", toolCallCount: 1, reasoning: "<tool_call>", toolNames: names))
        XCTAssertFalse(AgentChatCorrectness.reasoningContainsMisplacedToolCall(
            text: "", toolCallCount: 0, reasoning: "", toolNames: names))
    }

    func testMisplacedToolCallRetryIsWiredOncePerRun() throws {
        let vm = try source("Agent/Chat/AIChatViewModel.swift")
        XCTAssertTrue(vm.contains("if !didRetryMisplacedToolCallThisRun,"))
        XCTAssertTrue(vm.contains("didRetryMisplacedToolCallThisRun = false"), "reset at the start of each run")
        XCTAssertTrue(vm.contains("} else if stopReason == .endTurn && assistantText.isEmpty {"),
                      "a thinking-only end surfaces the empty-reply error + Resume instead of stopping silently")
    }

    // MARK: /v1/models 上下文长度（OpenMinis Android 1.15）

    func testOpenAICompatibleModelLimitsAreRead() {
        XCTAssertEqual(OpenAIModelLimits.contextWindow(in: ["id": "x", "context_length": 262_144]), 262_144)
        XCTAssertEqual(OpenAIModelLimits.contextWindow(in: ["max_model_len": 32768.0]), 32768, "vLLM, as a double")
        XCTAssertEqual(OpenAIModelLimits.contextWindow(in: ["context_window": "131072"]), 131_072, "number written as a string")
        XCTAssertEqual(OpenAIModelLimits.contextWindow(in: ["top_provider": ["context_length": 64000]]), 64000)
        XCTAssertNil(OpenAIModelLimits.contextWindow(in: ["id": "x"]))
        XCTAssertNil(OpenAIModelLimits.contextWindow(in: ["context_length": 0]))
        XCTAssertEqual(OpenAIModelLimits.maxOutputTokens(in: ["max_output_tokens": 8192]), 8192)
        XCTAssertEqual(OpenAIModelLimits.maxOutputTokens(in: ["top_provider": ["max_completion_tokens": 4096]]), 4096)
    }

    // MARK: 渲染 / 列表接线

    func testStreamingRendersReuseStableBlocksAndCorrectAtTheEnd() throws {
        let md = try source("Views/Chat/SelectableMarkdownView.swift")
        XCTAssertTrue(md.contains("renderer.render(blocks: content.blocks, reusingStableBlocks: isStreaming)"))
        XCTAssertTrue(md.contains("let reuseNeedsFinalRender = !isStreaming && context.coordinator.renderedWithStableBlockReuse"))
        XCTAssertTrue(md.contains("renderer.dropStableBlockMemo()"), "a rewrite drops the memo with the attachment caches")
        XCTAssertTrue(md.contains("StreamingTablePrefixParse.content(blockId: blockId, prefix: _splitForUpdate.prefix)"))
        XCTAssertTrue(md.contains("ctx.invalidateItems(at: [ip])"), "item-only invalidation, with a full fallback")
        XCTAssertTrue(md.contains("fadeAnimator.restoreOriginalColorsForDiff()"))
        XCTAssertTrue(md.contains("fadeAnimator.reapplyInFlightAlpha()"))
        let sse = try source("Agent/Chat/AIChatViewModel+SSEStream.swift")
        XCTAssertTrue(sse.contains("StreamingTablePrefixParse.store(blockId:"))
    }

    func testLayoutPreparesIncrementally() throws {
        let layout = try source("Agent/MessageList/MessageListLayout.swift")
        XCTAssertTrue(layout.contains("override func invalidateLayout(with context: UICollectionViewLayoutInvalidationContext)"))
        XCTAssertTrue(layout.contains("markDirty(from: index)"))
        XCTAssertTrue(layout.contains("itemAttributes.removeSubrange(start...)"))
    }

    func testChatViewSubscriptionsLiveInSmallViews() throws {
        let chat = try source("Views/Chat/AIChatView.swift")
        // 只剩各自小视图里的那一处订阅
        XCTAssertEqual(chat.components(separatedBy: "@ObservedObject private var gatewayStore").count - 1, 1)
        XCTAssertEqual(chat.components(separatedBy: "@ObservedObject private var askUserCenter").count - 1, 1)
        XCTAssertFalse(chat.contains("@StateObject private var speechManager"))
        XCTAssertTrue(chat.contains("private struct MacSwitchDialogModifier: ViewModifier"))
        XCTAssertTrue(chat.contains("private struct ComposerRecordingSwitch: View"))
        XCTAssertTrue(chat.contains("private struct ComposerWorkingIndicator: View"))
        let sse = try source("Agent/Chat/AIChatViewModel+SSEStream.swift")
        XCTAssertFalse(sse.contains("flushThinkingBuffer()\n                        self.publishUnlessTransitioning()"),
                       "thinking flushes no longer re-render the whole chat")
    }

    // MARK: MCP OAuth 平铺桥接文件（上游 OpenMinis #381）

    func testOAuthBridgeIsFlatWithLegacyFallback() throws {
        let native = try source("Agent/Session/MCPOAuthController.swift")
        XCTAssertTrue(native.contains(".appendingPathComponent(\"\\(server).oauth.json\")"))
        XCTAssertTrue(native.contains(".appendingPathComponent(\"\\(server).oauth.secret\")"))
        XCTAssertTrue(native.contains("legacyBridgeFileURL(server: server)"), "sign-out removes the old nested file too")
        let guest = try source("default_mount/usr/local/lib/leophoneagent-mcp-cli/transport/http.py")
        XCTAssertTrue(guest.contains("\"%s.oauth.json\" % server_name"))
        XCTAssertTrue(guest.contains("_legacy_oauth_token_path(server_name)"))
    }

    // MARK: 日程

    func testScheduleReminderHelpersAreShared() throws {
        let cal = try source("NativeOffloads/CalendarOffload.m")
        XCTAssertEqual(cal.components(separatedBy: "apply_reminder_due(reminder, dueStr, due,").count - 1, 2,
                       "create and update-reminder behave the same")
        XCTAssertTrue(cal.contains("[early timeIntervalSinceNow] > 0"), "an advance alarm already in the past is skipped")
        let vm = try source("Agent/Chat/AIChatViewModel.swift")
        XCTAssertFalse(vm.contains("Run `date"), "the exact local time is in the prompt; no date round-trip")
    }
}
