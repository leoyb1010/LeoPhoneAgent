import XCTest

/// Hosted iPhone Simulator UI tests against unchanged production SwiftUI source.
/// Fixtures own only storage and external-service boundaries. Every image is an
/// XCUIScreenshot attachment from the native simulator, never HTML or a mockup.
final class NativeModelJourneys: XCTestCase {
    private var app: XCUIApplication!

    override func setUpWithError() throws {
        continueAfterFailure = false
        app = XCUIApplication()
    }

    private func launch(_ route: String, reset: Bool = true, large: Bool = true, largeText: Bool = false, empty: Bool = false) {
        app.launchEnvironment = ["AUDIT_ROUTE": route, "AUDIT_RESET": reset ? "1" : "0",
                                 "AUDIT_LARGE": large ? "1" : "0", "AUDIT_LARGE_TEXT": largeText ? "1" : "0",
                                 "AUDIT_EMPTY": empty ? "1" : "0"]
        app.launchArguments = ["-AppleLanguages", "(en)", "-AppleLocale", "en_US"]
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

    private func search(_ query: String) {
        let field = app.searchFields.firstMatch
        if !field.waitForExistence(timeout: 8) || !field.isHittable { app.swipeDown() }
        XCTAssertTrue(field.waitForExistence(timeout: 8))
        field.tap()
        if !(field.value as? String ?? "").isEmpty,
           field.buttons["Clear text"].exists { field.buttons["Clear text"].tap() }
        field.typeText(query)
    }

    private func waitForText(_ text: String) -> XCUIElement {
        let element = app.staticTexts[text].firstMatch
        XCTAssertTrue(element.waitForExistence(timeout: 10), "Missing visible text: \(text)")
        return element
    }

    private func rootValue(_ identifier: String) -> String {
        let element = app.staticTexts[identifier]
        XCTAssertTrue(element.waitForExistence(timeout: 10))
        return element.label
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
        search("nonexistent-zzzz-9876")
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
        app.buttons["Next"].tap()
        XCTAssertEqual(rootValue("audit.default"), "daily")
        app.buttons["audit.open.groups"].tap()
        _ = waitForText("Default Models")
        capture("17-imported-model-group-created")
    }
}
