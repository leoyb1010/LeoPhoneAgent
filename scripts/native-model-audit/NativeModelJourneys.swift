import XCTest

/// Hosted iPhone/iPad Simulator UI tests against production SwiftUI source.
/// Fixtures own only storage and external-service boundaries. Every image is an
/// XCUIScreenshot attachment from the native simulator, never HTML or a mockup.
final class NativeModelJourneys: XCTestCase {
    private var app: XCUIApplication!

    override func setUpWithError() throws {
        continueAfterFailure = false
        app = XCUIApplication()
    }

    override func tearDownWithError() throws {
        if (testRun?.failureCount ?? 0) > 0, app.state == .runningForeground {
            capture("failure-" + name)
        }
        app.terminate()
    }

    private func launch(_ route: String, reset: Bool = true, large: Bool = true, largeText: Bool = false, empty: Bool = false, legacyPins: Bool = false, language: String = "en", catalogCount: Int = 180, failNextGroupSave: Bool = false, failNextEntrySave: Bool = false, dark: Bool = false) {
        app.launchEnvironment = ["AUDIT_ROUTE": route, "AUDIT_RESET": reset ? "1" : "0",
                                 "AUDIT_LARGE": large ? "1" : "0", "AUDIT_LARGE_TEXT": largeText ? "1" : "0",
                                 "AUDIT_EMPTY": empty ? "1" : "0", "AUDIT_LEGACY_PINS": legacyPins ? "1" : "0", "AUDIT_LANGUAGE": language, "AUDIT_CATALOG_COUNT": String(catalogCount),
                                 "AUDIT_FAIL_NEXT_GROUP_SAVE": failNextGroupSave ? "1" : "0",
                                 "AUDIT_FAIL_NEXT_ENTRY_SAVE": failNextEntrySave ? "1" : "0", "AUDIT_DARK": dark ? "1" : "0"]
        app.launchArguments = ["-AppleLanguages", "(\(language))", "-AppleLocale", language == "en" ? "en_US" : "zh_CN"]
        app.launchArguments += ["-UIPreferredContentSizeCategoryName", largeText ? "UICTContentSizeCategoryAccessibilityXL" : "UICTContentSizeCategoryL"]
        app.launch()
        XCTAssertTrue(app.wait(for: .runningForeground, timeout: 20))
    }

    private func capture(_ name: String) {
        let image = XCTAttachment(screenshot: app.screenshot())
        image.name = name
        image.lifetime = .keepAlways
        add(image)
        let tree = XCTAttachment(string: app.debugDescription)
        tree.name = name + "-accessibility-tree"
        tree.lifetime = .keepAlways
        add(tree)
    }

    private func search(_ query: String, replacing: Bool = false) {
        let field = app.searchFields.firstMatch
        if !(field.exists || field.waitForExistence(timeout: 8)) || !field.isHittable { app.swipeDown() }
        XCTAssertTrue(field.exists || field.waitForExistence(timeout: 8))
        field.tap()
        let keyboard = app.keyboards.firstMatch
        if !(keyboard.exists || keyboard.waitForExistence(timeout: 8)) { field.tap() }
        XCTAssertTrue(keyboard.exists || keyboard.waitForExistence(timeout: 8), "Native search must acquire keyboard focus before typing")
        if replacing {
            field.buttons["Clear text"].tap()
            capture("search-after-clear-before-refocus")
            // iPad的系统Clear会退回未激活搜索状态；通过真实再点输入框继续输入，
            // 不能把Clear之前的keyboard存在当作之后仍有焦点。
            field.tap()
            XCTAssertTrue(keyboard.exists || keyboard.waitForExistence(timeout: 8), "Cleared native search must regain keyboard focus")
        }
        field.typeText(query)
    }

    private func waitForText(_ text: String) -> XCUIElement {
        let element = app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", text)).firstMatch
        XCTAssertTrue(element.waitForExistence(timeout: 10), "Missing visible text: \(text)")
        return element
    }

    private func rootValue(_ identifier: String) -> String {
        let state = app.staticTexts["audit.state"]
        XCTAssertTrue(state.exists || state.waitForExistence(timeout: 10))
        guard let value = state.value as? String,
              let data = value.data(using: .utf8),
              let fields = try? JSONDecoder().decode([String: String].self, from: data),
              let result = fields[identifier] else {
            XCTFail("Fixture state does not expose \(identifier)")
            return ""
        }
        return result
    }

    private func closeAudit() {
        let close = app.buttons["Close audit"]
        if !close.isHittable {
            // iOS 26 hides navigation chrome during active search. This is only
            // the fixture exit, after production search actions were asserted.
            let searchClose = app.buttons["close"].firstMatch
            XCTAssertTrue(searchClose.isHittable)
            searchClose.tap()
        }
        let visible = expectation(for: NSPredicate(format: "hittable == true"), evaluatedWith: close)
        wait(for: [visible], timeout: 10)
        close.tap()
    }

    private func selectScope(_ scope: String) {
        let identifier = "model-picker.scope.\(scope.lowercased())"
        if app.buttons[identifier].exists { app.buttons[identifier].tap() }
        else if app.segmentedControls.buttons[scope].exists { app.segmentedControls.buttons[scope].tap() }
        else if app.buttons[scope].exists { app.buttons[scope].tap() }
    }

    func test01QuickPickerAndLargeCatalogSearch() {
        launch("quick")
        XCTAssertTrue(app.searchFields.firstMatch.waitForExistence(timeout: 15))
        capture("01-quick-picker")
        search("Catalog Model 180")
        _ = waitForText("Catalog Model 180")
        capture("02-search-large-catalog")
        XCTAssertFalse(app.staticTexts["Disabled fixture"].exists)
        XCTAssertFalse(app.staticTexts["Hidden fixture"].exists)
    }

    func test02FullPickerSearchAndEmptyResults() {
        launch("full")
        XCTAssertTrue(app.searchFields.firstMatch.waitForExistence(timeout: 15))
        capture("03-full-picker")
        selectScope("Providers")
        search("DeepSeek")
        _ = waitForText("DeepSeek Reasoner")
        capture("04-search-provider-catalog")
        search("nonexistent-zzzz-9876", replacing: true)
        capture("05-empty-search")
        XCTAssertFalse(app.staticTexts["DeepSeek Reasoner"].exists)
    }

    func test03ModelGroupsAndGroupDetail() {
        launch("groups", large: false)
        _ = waitForText("Daily Work")
        capture("06-model-groups-defaults")
        app.staticTexts["Daily Work"].firstMatch.tap()
        XCTAssertTrue(app.textFields["Group name"].waitForExistence(timeout: 10))
        capture("07-model-group-detail")
    }

    func test04ProviderCatalogNativeRows() {
        launch("catalog", large: false)
        _ = waitForText("DeepSeek Reasoner")
        capture("08-provider-catalog")
    }

    func test05AccessibilityTextSizeAndEmptyCatalog() {
        launch("full", largeText: true)
        XCTAssertTrue(app.searchFields.firstMatch.waitForExistence(timeout: 15))
        capture("09-full-picker-accessibility3")
        selectScope("Providers")
        search("long-context-model")
        _ = waitForText("Research Model With a Very Long Descriptive Name")
        capture("10-long-name-accessibility3")
        if !AuditSourceKind.isBaseline {
            let row = app.buttons["model-picker.entry.relay-proxy/long-context-model"]
            let favorite = app.buttons["model-picker.favorite.relay-proxy/long-context-model"]
            let keyboard = app.keyboards.firstMatch
            XCTAssertTrue(row.waitForExistence(timeout: 10))
            XCTAssertTrue(favorite.waitForExistence(timeout: 10))
            XCTAssertTrue(keyboard.exists)
            XCTAssertTrue(row.isHittable, "AX3 model choice must be directly tappable without scrolling")
            XCTAssertTrue(favorite.isHittable, "AX3 favorite action must be directly tappable")
            let visibleTop = max(row.frame.minY, app.searchFields.firstMatch.frame.maxY)
            let visibleBottom = min(row.frame.maxY, keyboard.frame.minY)
            XCTAssertGreaterThanOrEqual(visibleBottom - visibleTop, 44, "AX3 model choice needs at least a 44-point visible tap region")
            XCTAssertLessThan(row.frame.midY, keyboard.frame.minY, "Model tap center must remain above the keyboard")
            XCTAssertGreaterThanOrEqual(favorite.frame.height, 44)
            XCTAssertGreaterThanOrEqual(favorite.frame.minY, app.searchFields.firstMatch.frame.maxY - 1)
            XCTAssertLessThanOrEqual(favorite.frame.maxY, keyboard.frame.minY + 1, "Favorite target must not sit behind the keyboard")
            favorite.tap()
            XCTAssertTrue(row.isHittable, "Favoriting must keep the picker open")
            capture("47-accessibility3-favorite-without-switch")
            row.tap()
            XCTAssertEqual(rootValue("audit.selection"), "relay-proxy/long-context-model")
            XCTAssertEqual(rootValue("audit.default"), "daily")
            XCTAssertTrue(rootValue("audit.pins").contains("relay-proxy/long-context-model"))
            app.terminate()
            launch("", reset: false, largeText: true)
            XCTAssertEqual(rootValue("audit.selection"), "relay-proxy/long-context-model")
            XCTAssertEqual(rootValue("audit.default"), "daily")
            XCTAssertTrue(rootValue("audit.pins").contains("relay-proxy/long-context-model"))
        }
        app.terminate()
        launch("quick", empty: true)
        XCTAssertTrue(app.navigationBars.firstMatch.waitForExistence(timeout: 15))
        capture("11-empty-catalog")
    }

    func test06FavoriteDoesNotSelectAndPersists() {
        launch("quick")
        search("Catalog Model 180")
        _ = waitForText("Catalog Model 180")
        let stable = app.buttons["model-picker.favorite.relay-proxy/catalog-180"]
        if stable.exists { stable.tap() }
        else {
            let legacy = app.buttons["设为常用"].firstMatch
            XCTAssertTrue(legacy.waitForExistence(timeout: 8))
            legacy.tap()
        }
        capture("12-favorite-selected-without-switch")
        app.terminate()
        launch("", reset: false)
        XCTAssertEqual(rootValue("audit.selection"), "anthropic-direct/claude-sonnet-4", "Favoriting must not switch this conversation")
        XCTAssertTrue(rootValue("audit.pins").contains("relay-proxy/catalog-180"), "Favorite must survive process relaunch")
        app.buttons["audit.open.quick"].tap()
        search("Catalog Model 180")
        waitForText("Catalog Model 180").tap()
        XCTAssertEqual(rootValue("audit.selection"), "relay-proxy/catalog-180")
        XCTAssertEqual(rootValue("audit.default"), "daily", "Current conversation changes must not replace the default")
        capture("13-direct-selection-persisted")
        app.terminate()
        launch("", reset: false)
        XCTAssertEqual(rootValue("audit.selection"), "relay-proxy/catalog-180")
    }

    func test07GroupSelectionKeepsGroupIdentity() {
        launch("full", large: false)
        XCTAssertTrue(app.searchFields.firstMatch.waitForExistence(timeout: 15))
        selectScope("Groups")
        capture("14-groups-in-picker")
        waitForText("Daily Work").tap()
        XCTAssertEqual(rootValue("audit.selection"), "group:daily")
        XCTAssertEqual(rootValue("audit.default"), "daily")
        app.buttons["audit.open.full"].tap()
        selectScope("Groups")
        waitForText("Research Team").tap()
        XCTAssertEqual(rootValue("audit.selection"), "group:research")
        XCTAssertEqual(rootValue("audit.default"), "daily", "Selecting a group must not modify new-conversation default")
        capture("15-group-selection-distinct-from-default")
    }

    func test08ImportedCatalogModelSelection() {
        // Transport is deliberately outside this harness. Production onboarding
        // receives a catalog decoded from fixture JSON and creates a real group.
        launch("onboarding", large: false)
        XCTAssertTrue(app.searchFields.firstMatch.waitForExistence(timeout: 15))
        capture("16-imported-catalog-selection")
        search("DeepSeek")
        waitForText("DeepSeek Reasoner").tap()
        app.buttons["onboarding-models.next"].tap()
        XCTAssertEqual(rootValue("audit.default"), "daily")
        app.buttons["audit.open.groups"].tap()
        _ = waitForText("Default Models")
        capture("17-imported-model-group-created")
    }
    func test09UnavailableGroupsAndExplicitMemberKeepRoutingIdentity() throws {
        launch("full", large: false)
        XCTAssertTrue(app.searchFields.firstMatch.waitForExistence(timeout: 15))
        guard app.segmentedControls["model-picker.scope"].exists else {
            if AuditSourceKind.isBaseline { throw XCTSkip("Improved-scope regression; baseline screenshots exercise original behavior separately") }
            XCTFail("Required current production feature is missing")
            return
        }
        selectScope("Groups")
        let empty = app.buttons["model-picker.group.empty-group"]
        let unavailable = app.buttons["model-picker.group.unavailable-group"]
        // iPad原生sheet较矮，下面两组尚未物化；用户通过真实滚动才能读到它们。
        for _ in 0..<6 where !empty.exists { app.swipeUp() }
        XCTAssertTrue(empty.exists)
        XCTAssertFalse(empty.isEnabled)
        for _ in 0..<6 where !unavailable.exists { app.swipeUp() }
        XCTAssertTrue(unavailable.exists)
        XCTAssertFalse(unavailable.isEnabled)
        capture("18a-unavailable-groups-after-real-scroll")
        let daily = app.buttons["model-picker.expand-group.daily"]
        for _ in 0..<6 where !daily.isHittable { app.swipeDown() }
        XCTAssertTrue(daily.isHittable)
        daily.tap()
        capture("18-group-members-and-unavailable-groups")
        let member = app.buttons["model-picker.member.daily.openai-direct/gpt-5"]
        if member.exists { member.tap() } else { waitForText("GPT-5").tap() }
        XCTAssertEqual(rootValue("audit.selection"), "group:daily")
        XCTAssertEqual(rootValue("audit.reference"), "openai-direct/gpt-5")
        XCTAssertEqual(rootValue("audit.default"), "daily")
    }

    func test10DuplicateNamesSelectExactlyOneProviderIdentity() throws {
        launch("full", large: false)
        XCTAssertTrue(app.searchFields.firstMatch.waitForExistence(timeout: 15))
        guard app.segmentedControls["model-picker.scope"].exists else {
            if AuditSourceKind.isBaseline { throw XCTSkip("Stable row identity assertions apply to improved picker") }
            XCTFail("Required current production feature is missing")
            return
        }
        search("gpt-5")
        let relay = app.buttons["model-picker.entry.relay-proxy/gpt-5"]
        let official = app.buttons["model-picker.entry.openai-direct/gpt-5"]
        XCTAssertTrue(relay.waitForExistence(timeout: 10))
        relay.tap()
        XCTAssertEqual(rootValue("audit.selection"), "relay-proxy/gpt-5")
        app.buttons["audit.open.full"].tap()
        search("gpt-5")
        XCTAssertEqual(relay.value as? String, "Selected")
        XCTAssertEqual(official.value as? String, "Not selected")
        capture("19-duplicate-names-distinct-provider-selection")
    }

    func test11DraftSelectionDoesNotCreateConversationOrChangeDefault() {
        launch("draft", large: false)
        search("DeepSeek")
        waitForText("DeepSeek Reasoner").tap()
        XCTAssertEqual(rootValue("audit.draft"), "relay-proxy/deepseek-reasoner")
        XCTAssertEqual(rootValue("audit.binding-count"), "1")
        XCTAssertEqual(rootValue("audit.selection"), "anthropic-direct/claude-sonnet-4")
        XCTAssertEqual(rootValue("audit.default"), "daily")
        capture("20-draft-selection-isolated")
    }

    func test12SystemVoicePickerRemainsNativeAndAvailable() {
        launch("voiceInput", large: false)
        _ = waitForText("System Recognition (Offline)")
        capture("21-system-voice-input")
        app.terminate()
        launch("voiceOutput", large: false)
        _ = waitForText("System Voice (Auto)")
        capture("22-system-voice-output")
    }

    func test13CatalogBulkHideShowKeepsFavoritesGroupsAndDefault() throws {
        // This two-stage hide/readback/reopen/show/readback journey reached its
        // final assertions at 122s on a loaded hosted simulator. Preserve all
        // checks within the runner's existing 180s maximum; never turn a timeout green.
        executionTimeAllowance = 180
        launch("catalog", large: false)
        guard app.buttons["model-catalog.organize"].waitForExistence(timeout: 8) else {
            if AuditSourceKind.isBaseline { throw XCTSkip("Bulk organization is introduced by the improved production catalog") }
            XCTFail("Required current production feature is missing")
            return
        }
        search("DeepSeek")
        let favorite = app.buttons["model-catalog.favorite.relay-proxy/deepseek-reasoner"]
        XCTAssertTrue(favorite.waitForExistence(timeout: 10))
        favorite.tap()
        app.buttons["model-catalog.organize"].tap()
        app.buttons["Select shown models"].tap()
        app.buttons["Hide selected models"].tap()
        XCTAssertTrue(app.sheets.firstMatch.waitForExistence(timeout: 8))
        capture("23-confirm-bulk-hide")
        let confirmations = app.sheets.buttons.matching(identifier: "model-catalog.confirm-hide")
        let ready = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            confirmations.allElementsBoundByIndex.contains { $0.isHittable }
        }, object: app)
        let readiness = XCTWaiter.wait(for: [ready], timeout: 10)
        let nodes = confirmations.allElementsBoundByIndex
        let candidates = XCTAttachment(string: nodes.enumerated().map { index, node in
            "candidate=\(index) frame=\(node.frame) enabled=\(node.isEnabled) hittable=\(node.isHittable)"
        }.joined(separator: "\n"))
        candidates.name = "hide-confirmation-native-candidates"
        candidates.lifetime = .keepAlways
        add(candidates)
        XCTAssertEqual(readiness, .completed, "A real confirmation node must be hittable")
        // iOS 26 exposes a container Button and its actual leaf with the same
        // identifier. Resolve an actually hittable leaf inside the visible sheet.
        let confirmation = try XCTUnwrap(nodes.last(where: { $0.isHittable }))
        confirmation.tap()
        let hidden = expectation(for: NSPredicate { _, _ in confirmations.count == 0 }, evaluatedWith: app)
        wait(for: [hidden], timeout: 10)
        capture("24-catalog-model-hidden")
        closeAudit()
        XCTAssertTrue(rootValue("audit.hidden").contains("relay-proxy/deepseek-reasoner"))
        XCTAssertTrue(rootValue("audit.pins").contains("relay-proxy/deepseek-reasoner"))
        XCTAssertEqual(rootValue("audit.research-members"), "relay-proxy/deepseek-reasoner|anthropic-direct/claude-opus-4")
        XCTAssertEqual(rootValue("audit.default"), "daily")
        app.buttons["audit.open.catalog"].tap()
        search("DeepSeek")
        app.buttons["model-catalog.organize"].tap()
        app.buttons["Select shown models"].tap()
        app.buttons["Show selected models"].tap()
        closeAudit()
        XCTAssertFalse(rootValue("audit.hidden").contains("relay-proxy/deepseek-reasoner"))
        XCTAssertTrue(rootValue("audit.pins").contains("relay-proxy/deepseek-reasoner"))
    }

    func test14CatalogBulkAddsWithoutChangingExistingPriority() throws {
        launch("catalog", large: false)
        guard app.buttons["model-catalog.organize"].waitForExistence(timeout: 8) else {
            if AuditSourceKind.isBaseline { throw XCTSkip("Bulk group organization is introduced by improved catalog") }
            XCTFail("Required current production feature is missing")
            return
        }
        search("gpt-5")
        app.buttons["model-catalog.organize"].tap()
        app.buttons["Select shown models"].tap()
        app.buttons["Add to group"].tap()
        XCTAssertTrue(app.buttons["Research Team"].waitForExistence(timeout: 10))
        capture("25-add-models-to-existing-group")
        app.buttons["Research Team"].tap()
        XCTAssertTrue(app.alerts["Model organization"].waitForExistence(timeout: 8))
        app.alerts.buttons["OK"].tap()
        closeAudit()
        XCTAssertEqual(rootValue("audit.research-members"), "relay-proxy/deepseek-reasoner|anthropic-direct/claude-opus-4|relay-proxy/gpt-5")
        XCTAssertEqual(rootValue("audit.default"), "daily")
        app.terminate()
        launch("", reset: false)
        XCTAssertEqual(rootValue("audit.research-members"), "relay-proxy/deepseek-reasoner|anthropic-direct/claude-opus-4|relay-proxy/gpt-5")
    }

    func test15NewGroupAfterCatalogSheetDismissal() throws {
        launch("catalog", large: false)
        guard app.buttons["model-catalog.organize"].waitForExistence(timeout: 8) else {
            if AuditSourceKind.isBaseline { throw XCTSkip("New-group management journey is introduced by improved catalog") }
            XCTFail("Required current production feature is missing")
            return
        }
        search("DeepSeek")
        app.buttons["model-catalog.organize"].tap()
        app.buttons["Select shown models"].tap()
        app.buttons["Add to group"].tap()
        XCTAssertTrue(app.buttons["New Group"].waitForExistence(timeout: 8))
        app.buttons["New Group"].tap()
        XCTAssertTrue(app.alerts["New Group"].waitForExistence(timeout: 10), "Dismissing group sheet must present the name prompt")
        capture("26-create-group-after-sheet-dismissal")
        app.alerts.textFields.firstMatch.typeText("Catalog Favorites Team")
        app.alerts.buttons["Create"].tap()
        if app.alerts["Model organization"].waitForExistence(timeout: 8) { app.alerts.buttons["OK"].tap() }
        closeAudit()
        XCTAssertEqual(rootValue("audit.default"), "daily")
        app.buttons["audit.open.groups"].tap()
        _ = waitForText("Catalog Favorites Team")
    }

    func test16PrunedLegacyFavoriteRemainsVisible() throws {
        launch("quick", large: false, legacyPins: true)
        XCTAssertTrue(app.searchFields.firstMatch.waitForExistence(timeout: 15))
        guard app.segmentedControls["model-picker.scope"].exists else {
            if AuditSourceKind.isBaseline { throw XCTSkip("Alias normalization regression applies to improved picker") }
            XCTFail("Required current production feature is missing")
            return
        }
        selectScope("Favorites")
        let row = app.buttons["model-picker.entry.anthropic-direct/claude-sonnet-4"]
        XCTAssertTrue(row.waitForExistence(timeout: 10), "Legacy UUID alias must survive in actual Favorites list")
        capture("27-legacy-favorite-alias-visible")
    }

    func test17DraftUnavailableProviderCannotBeSelected() throws {
        launch("draft", large: false)
        XCTAssertTrue(app.searchFields.firstMatch.waitForExistence(timeout: 15))
        guard app.segmentedControls["model-picker.scope"].exists else {
            if AuditSourceKind.isBaseline { throw XCTSkip("Availability gate identifiers apply to improved picker") }
            XCTFail("Required current production feature is missing")
            return
        }
        search("Unavailable fixture")
        let row = app.buttons["model-picker.entry.missing-auth/unavailable"]
        XCTAssertTrue(row.waitForExistence(timeout: 10), "Unavailable model must remain discoverable with its disabled reason")
        XCTAssertFalse(row.isEnabled, "No-token provider must not be accepted as a draft choice")
        capture("28-draft-unavailable-model-disabled")
    }

    func test18ChineseNativeScreens() throws {
        launch("full", large: false, language: "zh-Hans")
        XCTAssertTrue(app.searchFields.firstMatch.waitForExistence(timeout: 15))
        capture("29-zh-full-picker")
        let scopes = app.segmentedControls["model-picker.scope"]
        if scopes.exists {
            scopes.buttons.element(boundBy: 0).tap()
            capture("30-zh-favorites")
            scopes.buttons.element(boundBy: 1).tap()
            let provider = app.buttons["model-picker.provider.relay-proxy"]
            if !provider.isHittable { app.swipeUp() }
            XCTAssertTrue(provider.exists)
            provider.tap()
            capture("31-zh-provider-expanded")
            search("deepseek-reasoner")
            let result = app.buttons["model-picker.entry.relay-proxy/deepseek-reasoner"]
            XCTAssertTrue(result.waitForExistence(timeout: 10))
            XCTAssertTrue(result.isHittable, "Search result must be visible above the keyboard")
            capture("42-zh-provider-search")
            app.terminate()
            launch("full", large: false, language: "zh-Hans")
            let groups = app.segmentedControls["model-picker.scope"].buttons.element(boundBy: 2)
            XCTAssertTrue(groups.waitForExistence(timeout: 10))
            groups.tap()
            capture("32-zh-routing-groups")
        }
        app.terminate()
        launch("catalog", large: false, language: "zh-Hans")
        XCTAssertTrue(app.navigationBars.firstMatch.waitForExistence(timeout: 15))
        capture("33-zh-provider-catalog")
        let organize = app.buttons["model-catalog.organize"]
        if organize.exists {
            search("DeepSeek")
            XCTAssertTrue(organize.isHittable, "Organize must remain reachable during native search")
            organize.tap()
            let selectShown = app.buttons["选择当前筛选结果"]
            XCTAssertTrue(selectShown.waitForExistence(timeout: 10))
            selectShown.tap()
            capture("43-zh-catalog-organize")
        }
    }

    func test19ThousandModelCatalogFindsLastEntryWithoutTruncation() {
        launch("full", catalogCount: 1200)
        let started = Date()
        search("catalog-1199")
        _ = waitForText("Catalog Model 1199")
        let duration = Date().timeIntervalSince(started)
        let timing = XCTAttachment(string: "1200 imported fixture models; native exact ID search automation took \(duration) seconds. Hosted simulator sanity measurement, not a device benchmark.")
        timing.name = "1200-model-search-timing"
        timing.lifetime = .keepAlways
        add(timing)
        XCTAssertLessThan(duration, 60, "Native 1200-model search must remain responsive")
        capture("34-thousand-model-id-search")
        if app.segmentedControls["model-picker.scope"].exists {
            search("Work Relay Catalog Model 1199", replacing: true)
            let result = app.buttons["model-picker.entry.relay-proxy/catalog-1199"]
            XCTAssertTrue(result.waitForExistence(timeout: 10))
            capture("35-thousand-model-provider-search")
        }
    }

    func test20FavoriteEditDragPersistsOrder() throws {
        try favoriteReorderJourney(waitForDropCommit: true)
    }

    func test26FavoriteImmediateDoneAfterDragPreservesOrder() throws {
        try favoriteReorderJourney(waitForDropCommit: false)
    }

    private func favoriteReorderJourney(waitForDropCommit: Bool) throws {
        launch("quick", large: false)
        XCTAssertTrue(app.searchFields.firstMatch.waitForExistence(timeout: 15))
        guard app.segmentedControls["model-picker.scope"].exists else {
            if AuditSourceKind.isBaseline { throw XCTSkip("Favorite edit identifiers apply to improved picker") }
            XCTFail("Required current production feature is missing")
            return
        }
        selectScope("Favorites")
        app.buttons["model-picker.edit-favorites"].tap()
        capture("36-favorites-native-edit-handles")
        let handles = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Reorder"))
        XCTAssertTrue(handles.firstMatch.waitForExistence(timeout: 10), "Native Edit must expose reorder handles")
        XCTAssertGreaterThanOrEqual(handles.count, 2)
        let first = handles.element(boundBy: 0)
        let last = handles.element(boundBy: 1)
        XCTAssertTrue(first.isHittable)
        XCTAssertTrue(last.isHittable)
        // Drop inside the first row's upper half. The recorded failed gesture
        // lifted and displaced the row, but dropping above its bounds (in the
        // section header) cancelled the native drop without invoking onMove.
        let firstRow = app.cells.containing(.button, identifier: "model-picker.entry.anthropic-direct/claude-sonnet-4").firstMatch
        XCTAssertTrue(firstRow.exists)
        let lastRow = app.cells.containing(.button, identifier: "model-picker.entry.openai-direct/gpt-5").firstMatch
        XCTAssertTrue(lastRow.exists)
        var previousFrames: [CGRect] = []
        var stableSamples = 0
        var frameObservations: [String] = []
        let frameStart = Date()
        let stable = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            let frames = [first.frame, last.frame, firstRow.frame, lastRow.frame]
            stableSamples = frames == previousFrames ? stableSamples + 1 : 0
            previousFrames = frames
            frameObservations.append("t=\(Date().timeIntervalSince(frameStart)) frames=\(frames) stable=\(stableSamples)")
            return stableSamples >= 2 && first.isHittable && last.isHittable
        }, object: app)
        let stability = XCTWaiter.wait(for: [stable], timeout: 10)
        let frameTrace = XCTAttachment(string: frameObservations.joined(separator: "\n"))
        frameTrace.name = "favorite-frame-stability-samples"
        frameTrace.lifetime = .keepAlways
        add(frameTrace)
        XCTAssertEqual(stability, .completed, "Native handle and row geometry must settle before the one drag")
        let geometry = XCTAttachment(string: "first handle=\(first.frame); last handle=\(last.frame); first row=\(firstRow.frame); last row=\(lastRow.frame); editing control=\(app.buttons["model-picker.edit-favorites"].label)")
        geometry.name = "favorite-native-drag-geometry"
        geometry.lifetime = .keepAlways
        add(geometry)
        let start = last.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
        // Stay above the insertion midpoint while remaining inside a real row.
        // A row-external target can show a temporary insertion then snap back.
        let destination = app.coordinate(withNormalizedOffset: .zero)
            .withOffset(CGVector(dx: first.frame.midX, dy: firstRow.frame.minY + firstRow.frame.height * 0.25))
        start.press(forDuration: 0.8, thenDragTo: destination, withVelocity: .slow, thenHoldForDuration: 0.5)
        if waitForDropCommit {
            let state = app.staticTexts["audit.state"]
            var observations: [String] = []
            let deadlineStart = Date()
            let committed = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
                guard state.exists, let value = state.value as? String, let data = value.data(using: .utf8),
                      let fields = try? JSONDecoder().decode([String: String].self, from: data) else {
                    observations.append("t=\(Date().timeIntervalSince(deadlineStart)) audit.state unavailable")
                    return false
                }
                observations.append("t=\(Date().timeIntervalSince(deadlineStart)) pins=\(fields["audit.pins"] ?? "missing") onMove=\(fields["audit.move"] ?? "missing")")
                return fields["audit.pins"] == "openai-direct/gpt-5|anthropic-direct/claude-sonnet-4"
                    && fields["audit.move"]?.hasPrefix("from=") == true
            }, object: app)
            let result = XCTWaiter.wait(for: [committed], timeout: 10)
            let trace = XCTAttachment(string: observations.joined(separator: "\n"))
            trace.name = "favorite-editing-drop-observations"
            trace.lifetime = .keepAlways
            add(trace)
            capture("37-favorites-after-native-drag")
            XCTAssertEqual(result, .completed, "The one real drop must invoke onMove and commit while still editing; no retry or direct mutation")
            let afterGeometry = XCTAttachment(string: "first handle=\(first.frame); last handle=\(last.frame); first row=\(firstRow.frame); last row=\(lastRow.frame); editing control=\(app.buttons["model-picker.edit-favorites"].label)")
            afterGeometry.name = "favorite-native-after-drag-geometry"
            afterGeometry.lifetime = .keepAlways
            add(afterGeometry)
        }
        // The interruption variant intentionally closes immediately after the
        // same single gesture, before screenshots or state queries can delay it.
        app.buttons["model-picker.edit-favorites"].tap()
        app.buttons["Done"].tap()
        if !waitForDropCommit { capture("52-favorites-immediate-done-after-drag") }
        let move = XCTAttachment(string: rootValue("audit.move"))
        move.name = "native-onMove-observation"
        move.lifetime = .keepAlways
        add(move)
        XCTAssertEqual(rootValue("audit.pins"), "openai-direct/gpt-5|anthropic-direct/claude-sonnet-4", "The live production pin store must reorder before process termination")
        app.terminate()
        launch("", reset: false)
        XCTAssertEqual(rootValue("audit.pins"), "openai-direct/gpt-5|anthropic-direct/claude-sonnet-4")
        XCTAssertEqual(rootValue("audit.selection"), "anthropic-direct/claude-sonnet-4")
    }

    func test21ReturningFromGroupManagementKeepsPickerOpen() throws {
        launch("full", large: false)
        XCTAssertTrue(app.searchFields.firstMatch.waitForExistence(timeout: 15))
        guard app.segmentedControls["model-picker.scope"].exists else {
            if AuditSourceKind.isBaseline { throw XCTSkip("Shared-picker group-management regression applies to improved picker") }
            XCTFail("Required current production feature is missing")
            return
        }
        selectScope("Groups")
        let manage = app.buttons["model-picker.manage-groups"]
        if !manage.isHittable { app.swipeUp() }
        XCTAssertTrue(manage.waitForExistence(timeout: 8))
        manage.tap()
        XCTAssertTrue(app.navigationBars["Model Groups"].waitForExistence(timeout: 10))
        capture("38-manage-groups-above-picker")
        let manager = app.navigationBars["Model Groups"]
        app.buttons["model-picker.close-group-manager"].tap()
        let dismissed = expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: manager)
        wait(for: [dismissed], timeout: 10)
        let scope = app.segmentedControls["model-picker.scope"]
        XCTAssertTrue(scope.waitForExistence(timeout: 10))
        selectScope("Providers")
        search("DeepSeek")
        _ = waitForText("DeepSeek Reasoner")
        capture("39-picker-still-interactive-after-management")
    }

    func test22RejectedGroupSaveKeepsSelectionAndAllowsRetry() {
        launch("groups", large: false, failNextGroupSave: true)
        waitForText("Research Team").tap()
        let addModels = app.buttons["Add Models"]
        for _ in 0..<5 where !addModels.isHittable { app.swipeUp() }
        XCTAssertTrue(addModels.isHittable)
        addModels.tap()
        search("gpt-5-mini")
        let model = app.buttons["model-picker.entry.openai-direct/gpt-5-mini"]
        XCTAssertTrue(model.waitForExistence(timeout: 10))
        model.tap()
        let add = app.buttons["model-picker.add-selected"]
        XCTAssertTrue(add.isEnabled)
        add.tap()
        let failure = app.alerts["Model organization"]
        XCTAssertTrue(failure.waitForExistence(timeout: 10), "Rejected save must be reported")
        XCTAssertTrue(failure.staticTexts["Could not save model changes. Your previous configuration was kept. Try again."].exists)
        capture("40-rejected-group-save-keeps-picker")
        failure.buttons["OK"].tap()
        XCTAssertTrue(app.navigationBars["Add Models"].exists, "Failed add must keep the picker open")
        XCTAssertTrue(add.isEnabled, "Selected model must survive the failure for retry")
        capture("41-selected-model-after-save-rejection")
        add.tap()
        let dismissed = expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: app.navigationBars["Add Models"])
        wait(for: [dismissed], timeout: 10)
        app.terminate()
        launch("", reset: false)
        XCTAssertEqual(rootValue("audit.research-members"), "relay-proxy/deepseek-reasoner|anthropic-direct/claude-opus-4|openai-direct/gpt-5-mini")
        XCTAssertEqual(rootValue("audit.selection"), "anthropic-direct/claude-sonnet-4")
        XCTAssertEqual(rootValue("audit.default"), "daily")
    }

    func test23ActualEditorRetainsAliasAfterRejectedSaveAndRetry() {
        launch("catalog", large: false, failNextEntrySave: true)
        search("DeepSeek")
        let model = app.buttons["model-catalog.entry.relay-proxy/deepseek-reasoner"]
        XCTAssertTrue(model.waitForExistence(timeout: 10))
        model.tap()
        let field = app.textFields["model-editor.name"]
        XCTAssertTrue(field.waitForExistence(timeout: 10))
        field.tap()
        field.typeText(" Audit Alias")
        let typed = field.value as? String ?? ""
        XCTAssertTrue(typed.contains("Audit Alias"))
        let save = app.buttons["model-editor.save"]
        save.tap()
        let failure = app.alerts["Model organization"]
        XCTAssertTrue(failure.waitForExistence(timeout: 10))
        XCTAssertTrue(failure.staticTexts["Could not save model changes. Your previous configuration was kept. Try again."].exists)
        capture("44-editor-rejected-save")
        failure.buttons["OK"].tap()
        XCTAssertTrue(app.navigationBars["Model Details"].exists, "Save rejection must keep the actual editor open")
        XCTAssertEqual(field.value as? String, typed, "Typed alias must remain available for retry")
        capture("45-editor-retained-alias-after-failure")
        save.tap()
        let dismissed = expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: app.navigationBars["Model Details"])
        wait(for: [dismissed], timeout: 10)
        app.terminate()
        launch("", reset: false)
        XCTAssertEqual(rootValue("audit.edited-name"), typed)
        XCTAssertEqual(rootValue("audit.edited-thinking"), "high", "Alias edits must not erase an imported reasoning ceiling")
        XCTAssertEqual(rootValue("audit.edited-id"), "relay-proxy/deepseek-reasoner")
        XCTAssertEqual(rootValue("audit.selection"), "anthropic-direct/claude-sonnet-4")
        XCTAssertEqual(rootValue("audit.default"), "daily")
        XCTAssertEqual(rootValue("audit.pins"), "anthropic-direct/claude-sonnet-4|openai-direct/gpt-5")
        app.buttons["audit.open.catalog"].tap()
        search("Audit Alias")
        XCTAssertTrue(app.buttons["model-catalog.entry.relay-proxy/deepseek-reasoner"].waitForExistence(timeout: 10))
        capture("46-edited-alias-after-relaunch")
    }

    private func auditContrastWithDiagnostics() throws {
        try app.performAccessibilityAudit(for: .contrast) { issue in
            let details = [issue.compactDescription, issue.detailedDescription,
                           "type: \(issue.auditType)",
                           "element: \(issue.element?.debugDescription ?? "none")",
                           "frame: \(String(describing: issue.element?.frame))",
                           "current tree: \(self.app.debugDescription)"].joined(separator: "\n")
            let attachment = XCTAttachment(string: details)
            attachment.name = "native-contrast-issue-details"
            attachment.lifetime = .keepAlways
            self.add(attachment)
            // false reports the original failure; recording is never an exemption.
            return false
        }
    }

    func test24ActualPickerLightContrastAudit() throws {
        continueAfterFailure = true
        launch("quick", large: false)
        XCTAssertTrue(app.searchFields.firstMatch.waitForExistence(timeout: 15))
        capture("48-picker-light-contrast")
        try auditContrastWithDiagnostics()
    }

    func test25ActualPickerDarkContrastAudit() throws {
        continueAfterFailure = true
        launch("quick", large: false, dark: true)
        XCTAssertTrue(app.searchFields.firstMatch.waitForExistence(timeout: 15))
        capture("49-picker-dark-contrast")
        try auditContrastWithDiagnostics()
    }

    func test27SystemSectionHeaderLightContrastReferences() throws {
        continueAfterFailure = true
        launch("contrastReference", large: false)
        XCTAssertTrue(app.staticTexts["audit.contrast.primary"].waitForExistence(timeout: 15))
        XCTAssertTrue(app.staticTexts["audit.contrast.secondary"].exists)
        XCTAssertTrue(app.staticTexts["audit.contrast.background"].exists)
        capture("53-system-header-light-contrast-references")
        try auditContrastWithDiagnostics()
    }

    func test28SystemSectionHeaderDarkContrastReferences() throws {
        continueAfterFailure = true
        launch("contrastReference", large: false, dark: true)
        XCTAssertTrue(app.staticTexts["audit.contrast.primary"].waitForExistence(timeout: 15))
        XCTAssertTrue(app.staticTexts["audit.contrast.secondary"].exists)
        XCTAssertTrue(app.staticTexts["audit.contrast.background"].exists)
        capture("54-system-header-dark-contrast-references")
        try auditContrastWithDiagnostics()
    }

}
