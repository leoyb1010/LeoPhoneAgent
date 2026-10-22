import XCTest

/// [chat-chrome] Header cap, model-name degradation and list insets for the
/// conversation chrome, plus source guards for the wiring that keeps the
/// activity strip from covering messages.
final class ChatChromeLayoutTests: XCTestCase {
    private var iosRoot: URL {
        URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
    }
    private func source(_ path: String) throws -> String {
        try String(contentsOf: iosRoot.appendingPathComponent(path), encoding: .utf8)
    }

    // MARK: Model name degradation

    func testCompactDropsQualifiersDatesAndVendorPrefix() {
        XCTAssertEqual(ModelNameCompaction.compact("Claude Opus 4.5 Thinking Max Preview (2026-10-01, Extended Context)"),
                       "Claude Opus 4.5 Thinking Max Preview")
        XCTAssertEqual(ModelNameCompaction.compact("anthropic/claude-sonnet-4-5-20250929"), "claude-sonnet-4-5")
        XCTAssertEqual(ModelNameCompaction.compact("o1-2024-12-17"), "o1")
        XCTAssertEqual(ModelNameCompaction.compact("deepseek-v4-pro [beta]"), "deepseek-v4-pro")
    }

    func testCompactKeepsShortAndVersionNames() {
        for name in ["gpt-5", "GPT-5.5", "qwen2.5-72b-instruct", "gpt-4-0613", "Claude Haiku 4.5", "未选择模型"] {
            XCTAssertEqual(ModelNameCompaction.compact(name), name, name)
            XCTAssertEqual(ModelNameCompaction.candidates(name), [name], "no duplicate spelling for \(name)")
        }
        // Never compacts to nothing.
        XCTAssertEqual(ModelNameCompaction.compact("(beta)"), "(beta)")
        XCTAssertEqual(ModelNameCompaction.compact("vendor/"), "vendor/")
    }

    func testCandidatesGoWidestFirst() {
        let c = ModelNameCompaction.candidates("openrouter/anthropic/claude-opus-4.5-20251101")
        XCTAssertEqual(c, ["openrouter/anthropic/claude-opus-4.5-20251101", "claude-opus-4.5"])
    }

    func testHeaderCandidatesForGroupBoundSessions() {
        XCTAssertEqual(ModelNameCompaction.headerCandidates(displayName: "日常", isGroupBound: true,
                                                            resolvedModel: "Claude Opus 4.5 (Extended)"),
                       ["日常 · Claude Opus 4.5 (Extended)", "Claude Opus 4.5 (Extended)", "Claude Opus 4.5"])
        // Not group-bound, or the group resolves to the same name: just the model.
        XCTAssertEqual(ModelNameCompaction.headerCandidates(displayName: "gpt-5", isGroupBound: false, resolvedModel: "gpt-5"),
                       ["gpt-5"])
        XCTAssertEqual(ModelNameCompaction.headerCandidates(displayName: "gpt-5", isGroupBound: true, resolvedModel: nil),
                       ["gpt-5"])
    }

    // MARK: Header cap

    func testPrincipalCapReservesTheWiderSideOnBothSides() {
        // iPhone portrait, back + "…": 440 − 2 × (16 + 44 + 8).
        XCTAssertEqual(ChatHeaderLayout.principalCap(columnWidth: 440, leadingItems: 1, trailingItems: 1), 304)
        // Artifacts tray adds a trailing item: the title gets narrower, not overlapped.
        XCTAssertEqual(ChatHeaderLayout.principalCap(columnWidth: 440, leadingItems: 1, trailingItems: 2), 200)
        // iPhone SE width still leaves a usable title.
        XCTAssertGreaterThanOrEqual(ChatHeaderLayout.principalCap(columnWidth: 320, leadingItems: 1, trailingItems: 2),
                                    ChatHeaderLayout.minimumCap)
        // iPad full width caps the measure.
        XCTAssertEqual(ChatHeaderLayout.principalCap(columnWidth: 1366, leadingItems: 2, trailingItems: 2),
                       ChatHeaderLayout.maximumCap)
        // Unmeasured column: a safe minimum, never 0.
        XCTAssertEqual(ChatHeaderLayout.principalCap(columnWidth: 0, leadingItems: 1, trailingItems: 1),
                       ChatHeaderLayout.minimumCap)
    }

    func testPrincipalCapNeverReachesBarItems() {
        for width in stride(from: CGFloat(300), through: 1400, by: 20) {
            for trailing in 1...3 {
                let cap = ChatHeaderLayout.principalCap(columnWidth: width, leadingItems: 2, trailingItems: trailing)
                let reservedTrailing = ChatHeaderLayout.edgeMargin + CGFloat(trailing) * 52
                if cap > ChatHeaderLayout.minimumCap {
                    XCTAssertLessThanOrEqual(width / 2 + cap / 2, width - reservedTrailing + 0.5,
                                             "width \(width), \(trailing) trailing items")
                }
            }
        }
    }

    // MARK: Insets

    func testListBottomInsetCoversComposerAndStrip() {
        XCTAssertEqual(ChatListInsets.bottom(inputBarHeight: 120, activityStripHeight: 0), 128)
        XCTAssertEqual(ChatListInsets.bottom(inputBarHeight: 120, activityStripHeight: 36), 164)
        // Expanded preview grows the inset with it.
        XCTAssertEqual(ChatListInsets.bottom(inputBarHeight: 120, activityStripHeight: 107), 235)
        XCTAssertEqual(ChatListInsets.bottom(inputBarHeight: -1, activityStripHeight: -1), LeoChromeMetrics.listBottomGap)
        XCTAssertGreaterThan(ChatListInsets.floatingControlBottom(inputBarHeight: 120, activityStripHeight: 36),
                             120 + 36)
    }

    func testChromeMetricsMeetTouchTarget() {
        XCTAssertGreaterThanOrEqual(LeoChromeMetrics.hitTarget, 44)
        XCTAssertLessThan(LeoChromeMetrics.pillHeight, LeoChromeMetrics.hitTarget)
        XCTAssertLessThan(LeoChromeMetrics.modelPillMinWidth, LeoChromeMetrics.modelPillMaxWidth)
        XCTAssertLessThanOrEqual(LeoChromeMetrics.activityRowHeight, LeoChromeMetrics.hitTarget)
    }

    // MARK: Wiring guards

    func testActivityStripIsMeasuredIntoTheListInset() throws {
        let chat = try source("Views/Chat/AIChatView.swift")
        let list = try source("Agent/MessageList/CollectionViewMessageListV3.swift")
        XCTAssertTrue(list.contains("ChatListInsets.bottom(inputBarHeight: inputBarHeight,"))
        XCTAssertFalse(list.contains("(floatingBarHeight > 0 ? 52 : 8)"), "no fixed reserve for an overhanging thumbnail")
        let strip = try XCTUnwrap(chat.range(of: "private var activityStrip: some View"))
        let body = String(chat[strip.lowerBound...].prefix(3200))
        XCTAssertTrue(body.contains("AgentCurrentStatusCard("), "status chip shares the strip")
        XCTAssertTrue(body.contains("FloatingToolBar("))
        XCTAssertTrue(body.contains("floatingBarHeight = newH"), "strip height feeds the inset")
        XCTAssertEqual(chat.components(separatedBy: "AgentCurrentStatusCard(").count, 2,
                       "status card is mounted once (not also inside the composer)")
        XCTAssertFalse(chat.contains("hasFloatingPreview ? 80 : 12"), "floating controls use measured heights")
    }

    func testToolBarCollapsesToOneLineAndRespectsReduceMotion() throws {
        let tool = try source("Views/Chat/ToolLiveSheet.swift")
        let start = try XCTUnwrap(tool.range(of: "struct FloatingToolBar: View"))
        let body = String(tool[start.lowerBound...].prefix(3600))
        XCTAssertTrue(body.contains("if toolPreviewEnabled && previewExpanded"), "thumbnail only when expanded")
        XCTAssertTrue(body.contains("LeoMotion.smooth(reduceMotion: reduceMotion)"))
        XCTAssertTrue(body.contains("reduceMotion ? .opacity"))
        XCTAssertFalse(tool.contains("ZStack(alignment: .bottomLeading) {\n            ToolStatusBar("),
                       "the 100×65 thumbnail no longer overhangs the collapsed bar")
    }

    func testModelPillsUseTheSharedChromeComponent() throws {
        let chat = try source("Views/Chat/AIChatView.swift")
        let home = try source("Views/Home/HomeComposer.swift")
        XCTAssertTrue(chat.contains("LeoChromePillLabel(modelCapsuleLabel"))
        XCTAssertTrue(chat.contains("LeoAdaptiveText(candidates: headerModelCandidates("))
        XCTAssertTrue(chat.contains(".frame(maxWidth: headerPrincipalCap)"))
        XCTAssertTrue(home.contains("LeoChromePillLabel(capsule.model"))
        XCTAssertTrue(home.contains("LeoChromePillLabel(capsule.place"))
    }
}
