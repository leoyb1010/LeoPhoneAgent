import XCTest

/// [T-brain-ui] 藏宝阁 × 资料库:搜索状态、范围、出错下一步、按需调用知识工具的提示与「/」引用。
final class TreasuryBrainBrowseTests: XCTestCase {

    // MARK: Search state machine

    private func phase(configured: Bool = true, scope: BrainBrowseScope = .archive, query: String = "合同",
                       loading: Bool = false, error: BrainError? = nil, count: Int = 0) -> BrainBrowsePhase {
        BrainBrowsePhase.resolve(configured: configured, scope: scope, query: query,
                                 loading: loading, error: error, resultCount: count)
    }

    func testPhoneScopeNeverShowsArchiveState() {
        XCTAssertEqual(phase(configured: false, scope: .phone), .idle)
        XCTAssertEqual(phase(scope: .phone, error: .offline), .idle)
    }

    func testNotConfiguredPromptsOnlyOutsideAllScope() {
        XCTAssertEqual(phase(configured: false, scope: .all), .notConfigured(showsConnectPrompt: false))
        XCTAssertEqual(phase(configured: false, scope: .archive), .notConfigured(showsConnectPrompt: true))
        XCTAssertEqual(phase(configured: false, scope: .cards, query: ""), .notConfigured(showsConnectPrompt: true))
    }

    func testEmptyOrBlankQueryIsIdleExceptCardListing() {
        XCTAssertEqual(phase(query: ""), .idle)
        XCTAssertEqual(phase(query: "   "), .idle)
        XCTAssertEqual(phase(scope: .all, query: ""), .idle)
        // 知识卡范围空关键词 = 列出全部卡
        XCTAssertEqual(phase(scope: .cards, query: "", loading: true), .loading)
        XCTAssertEqual(phase(scope: .cards, query: "", count: 3), .results)
        XCTAssertEqual(phase(scope: .cards, query: ""), .empty)
    }

    func testLoadingResultsEmptyAndFailure() {
        XCTAssertEqual(phase(loading: true), .loading)
        XCTAssertEqual(phase(count: 2), .results)
        XCTAssertEqual(phase(loading: true, count: 2), .results, "keep showing previous hits while refreshing")
        XCTAssertEqual(phase(), .empty)
        XCTAssertEqual(phase(error: .unauthorized), .failed(.unauthorized))
        XCTAssertEqual(phase(error: .rateLimited(retryAfter: 30)), .failed(.rateLimited(retryAfter: 30)))
    }

    func testErrorRecoveryOffersRetryOrReconnect() {
        XCTAssertEqual(BrainError.offline.recovery, .retry)
        XCTAssertEqual(BrainError.timeout.recovery, .retry)
        XCTAssertEqual(BrainError.rateLimited(retryAfter: nil).recovery, .retry)
        XCTAssertEqual(BrainError.server(status: 500, message: nil).recovery, .retry)
        XCTAssertEqual(BrainError.unauthorized.recovery, .reconnect)
        XCTAssertEqual(BrainError.forbidden(nil).recovery, .reconnect)
        XCTAssertEqual(BrainError.notConfigured.recovery, .reconnect)
        XCTAssertEqual(BrainError.notFound.recovery, .none)
        // 401 / 429 的提示是中文
        XCTAssertTrue(BrainError.unauthorized.message.contains("令牌"))
        XCTAssertTrue(BrainError.rateLimited(retryAfter: 12).message.contains("12"))
    }

    // MARK: Scope

    func testSearchPromptFollowsScope() {
        let prompts = BrainBrowseScope.allCases.map(\.searchPrompt)
        XCTAssertEqual(Set(prompts).count, BrainBrowseScope.allCases.count)
        XCTAssertTrue(BrainBrowseScope.archive.searchPrompt.contains("资料库"))
        XCTAssertTrue(BrainBrowseScope.cards.searchPrompt.contains("知识卡"))
    }

    func testPhoneEditingOnlyWherePhoneItemsShow() {
        XCTAssertTrue(BrainBrowseScope.all.supportsPhoneEditing)
        XCTAssertTrue(BrainBrowseScope.phone.supportsPhoneEditing)
        XCTAssertFalse(BrainBrowseScope.archive.supportsPhoneEditing)
        XCTAssertFalse(BrainBrowseScope.cards.supportsPhoneEditing)
    }

    func testScopeRoundTripsThroughStoredRawValue() {
        // 藏宝阁用 @AppStorage("treasury.brainScope") 记住上次的范围
        for scope in BrainBrowseScope.allCases {
            XCTAssertEqual(BrainBrowseScope(rawValue: scope.rawValue), scope)
        }
        XCTAssertNil(BrainBrowseScope(rawValue: "unknown"))
    }

    func testConnectionSummary() {
        XCTAssertEqual(BrainConnectionSummary.text(configured: false, health: nil, statusError: nil), "资料库未连接")
        XCTAssertNil(BrainConnectionSummary.text(configured: true, health: nil, statusError: nil))
        XCTAssertEqual(BrainConnectionSummary.text(configured: true, health: nil, statusError: "x"), "资料库暂时连不上")
        let health = try! BrainJSON.decode(BrainHealth.self, from: Data(#"{"ok":true,"archive":{"files":42}}"#.utf8))
        XCTAssertTrue(BrainConnectionSummary.text(configured: true, health: health, statusError: nil)!.contains("42"))
        let down = try! BrainJSON.decode(BrainHealth.self, from: Data(#"{"ok":false}"#.utf8))
        XCTAssertEqual(BrainConnectionSummary.text(configured: true, health: down, statusError: nil), "资料库网关异常")
    }

    // MARK: 藏宝阁 filters & files

    func testClearFiltersOfferedOnlyWhenFiltering() {
        XCTAssertFalse(TreasuryFilterReset.hasActiveFilters(view: "all", source: nil, showArchived: false))
        XCTAssertTrue(TreasuryFilterReset.hasActiveFilters(view: "failed", source: nil, showArchived: false))
        XCTAssertTrue(TreasuryFilterReset.hasActiveFilters(view: "all", source: "小红书", showArchived: false))
        XCTAssertTrue(TreasuryFilterReset.hasActiveFilters(view: "all", source: nil, showArchived: true))
    }

    func testNonImageAttachmentsGoToQuickLook() {
        XCTAssertTrue(TreasuryFilePreviewPolicy.usesImagePreview(fileName: "scan-1.JPG"))
        XCTAssertTrue(TreasuryFilePreviewPolicy.usesImagePreview(fileName: "a.heic"))
        XCTAssertFalse(TreasuryFilePreviewPolicy.usesImagePreview(fileName: "报价单.pdf"))
        XCTAssertFalse(TreasuryFilePreviewPolicy.usesImagePreview(fileName: "notes.docx"))
        XCTAssertFalse(TreasuryFilePreviewPolicy.usesImagePreview(fileName: "noext"))
    }

    // MARK: On-demand knowledge in everyday chat

    func testOrdinaryUserChatsGetBrainTools() {
        // 普通对话(没有 source,或 chat)都提供;只有无人值守的回合拿不到。
        for source: String? in [nil, "chat"] {
            let offered = BrainToolGating.offeredTools(configured: true, isSubAgentChild: false, blocksSideEffectTools: false,
                                                       sessionSource: source, isRemote: false, knownScopes: ["read"])
            XCTAssertEqual(offered, ["brain_search", "brain_read"], String(describing: source))
        }
    }

    func testGuidanceIsOnDemandAndScoped() {
        XCTAssertEqual(KnowledgeToolGuidance.prompt(treasuryOffered: false, brainOffered: false), "")
        let both = KnowledgeToolGuidance.prompt(treasuryOffered: true, brainOffered: true)
        XCTAssertTrue(both.contains("on demand only"))
        XCTAssertTrue(both.contains("answer directly without searching"))
        XCTAssertTrue(both.contains("never search on every turn"))
        XCTAssertTrue(both.contains("treasury_*"))
        XCTAssertTrue(both.contains("brain_*"))
        XCTAssertTrue(both.hasSuffix("\n"))
        let phoneOnly = KnowledgeToolGuidance.prompt(treasuryOffered: true, brainOffered: false)
        XCTAssertFalse(phoneOnly.contains("brain_*"), "never mention archive tools the model does not have")
        XCTAssertLessThan(both.count, 800, "keep the guidance short")
    }

    func testQuoteCommandsFollowAvailability() {
        XCTAssertEqual(KnowledgeQuoteCommand.available(brainOffered: true, treasuryOffered: true), [.brain, .treasury])
        XCTAssertEqual(KnowledgeQuoteCommand.available(brainOffered: false, treasuryOffered: true), [.treasury])
        XCTAssertEqual(KnowledgeQuoteCommand.available(brainOffered: false, treasuryOffered: false), [])
        XCTAssertEqual(KnowledgeQuoteCommand.brain.title, "引用资料库")
        XCTAssertEqual(KnowledgeQuoteCommand.treasury.title, "引用藏宝阁")
    }

    func testQuoteCommandKeepsDraftAndNeverStacks() {
        let brain = KnowledgeQuoteCommand.brain
        XCTAssertEqual(brain.apply(to: ""), brain.composerPrefix)
        XCTAssertEqual(brain.apply(to: "上次的报价方案"), brain.composerPrefix + "上次的报价方案")
        let once = brain.apply(to: "上次的报价方案")
        XCTAssertEqual(brain.apply(to: once), once)
        // 换成藏宝阁:替换前缀而不是叠两层
        XCTAssertEqual(KnowledgeQuoteCommand.treasury.apply(to: once),
                       KnowledgeQuoteCommand.treasury.composerPrefix + "上次的报价方案")
    }
}
