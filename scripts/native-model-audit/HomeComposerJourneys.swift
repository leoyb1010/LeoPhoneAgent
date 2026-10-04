import XCTest
import UIKit

/// Run these same production-component journeys on the pinned iPhone AND iPad.
/// Device execution is external; this fixture never creates or starts simulators.
final class HomeComposerJourneys: XCTestCase {
    private var app: XCUIApplication!

    override func setUpWithError() throws {
        continueAfterFailure = false
        XCUIDevice.shared.orientation = UIDevice.current.userInterfaceIdiom == .pad ? .landscapeLeft : .portrait
        app = XCUIApplication()
    }

    override func tearDownWithError() throws {
        if (testRun?.failureCount ?? 0) > 0 { capture("home-failure-" + name) }
        app.terminate()
    }

    private func launch(largeText: Bool = false, longName: Bool = false) {
        app.launchEnvironment = ["AUDIT_ROUTE": "home", "AUDIT_RESET": "1", "AUDIT_LARGE": "1",
            "AUDIT_LANGUAGE": "en_US", "AUDIT_LARGE_TEXT": largeText ? "1" : "0",
            "AUDIT_HOME_LONG_NAME": longName ? "1" : "0"]
        app.launchArguments = ["-AppleLanguages", "(en)", "-AppleLocale", "en_US",
            "-UIPreferredContentSizeCategoryName", largeText ? "UICTContentSizeCategoryAccessibilityXL" : "UICTContentSizeCategoryL"]
        app.launch()
        XCTAssertTrue(app.buttons["home.execution-target"].waitForExistence(timeout: 15))
        XCTAssertTrue(app.buttons["home.model-picker"].waitForExistence(timeout: 10))
    }

    private func capture(_ name: String) {
        let screenshot = XCTAttachment(screenshot: app.screenshot())
        screenshot.name = name; screenshot.lifetime = .keepAlways; add(screenshot)
        let tree = XCTAttachment(string: app.debugDescription)
        tree.name = name + "-tree"; tree.lifetime = .keepAlways; add(tree)
    }

    private func state() -> [String: String] {
        let element = app.staticTexts["audit.home.state"]
        XCTAssertTrue(element.waitForExistence(timeout: 8))
        guard let value = element.value as? String, let data = value.data(using: .utf8),
              let fields = try? JSONDecoder().decode([String: String].self, from: data) else {
            XCTFail("Missing isolated Home state"); return [:]
        }
        return fields
    }

    private func assertSeparateReachableControls() {
        let place = app.buttons["home.execution-target"], model = app.buttons["home.model-picker"]
        let ready = [place, model].map {
            expectation(for: NSPredicate(format: "hittable == true"), evaluatedWith: $0)
        }
        wait(for: ready, timeout: 8)
        XCTAssertTrue(place.isHittable); XCTAssertTrue(model.isHittable)
        XCTAssertGreaterThanOrEqual(place.frame.height, 43.5)
        XCTAssertGreaterThanOrEqual(model.frame.height, 43.5)
        XCTAssertGreaterThanOrEqual(place.frame.width, 44)
        XCTAssertGreaterThanOrEqual(model.frame.width, 44)
        XCTAssertFalse(place.frame.intersects(model.frame), "Execution and model must remain distinct non-overlapping actions")
        let window = app.windows.firstMatch.frame
        XCTAssertGreaterThanOrEqual(place.frame.minX, window.minX)
        XCTAssertLessThanOrEqual(model.frame.maxX, window.maxX)
    }

    private func closeModelPicker() {
        let done = app.buttons["Done"].firstMatch
        XCTAssertTrue(done.waitForExistence(timeout: 8), "Production model picker must expose its close action")
        done.tap()
        XCTAssertTrue(app.buttons["home.model-picker"].waitForExistence(timeout: 8))
    }

    func test01SplitExecutionAndModelPreserveTypedDraft() {
        launch()
        assertSeparateReachableControls()
        let original = state()
        let input = app.textFields.firstMatch
        XCTAssertTrue(input.waitForExistence(timeout: 8))
        input.tap()
        let draft = "Keep this Home draft while choosing a model."
        input.typeText(draft)
        app.buttons["home.model-picker"].tap()
        XCTAssertTrue(app.searchFields.firstMatch.waitForExistence(timeout: 8))
        capture("home-model-sheet-native")
        closeModelPicker()
        XCTAssertEqual(state()["text"], draft)
        XCTAssertEqual(state()["binding-count"], original["binding-count"])
        XCTAssertEqual(state()["default"], original["default"])
        app.buttons["home.execution-target"].tap()
        let remote = app.buttons["Fixture Mac"].firstMatch
        XCTAssertTrue(remote.waitForExistence(timeout: 5)); remote.tap()
        XCTAssertEqual(state()["place"], "mac")
        XCTAssertEqual(state()["text"], draft)
        XCTAssertFalse(app.buttons["home.model-picker"].exists, "Remote fixture follows production's separate remote-model flow")
        app.buttons["home.execution-target"].tap()
        let local = app.buttons["Fixture iPhone"]
        XCTAssertTrue(local.waitForExistence(timeout: 5))
        XCTAssertTrue(local.isHittable)
        local.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        XCTAssertEqual(state()["place"], "iphone")
        assertSeparateReachableControls()
        XCTAssertEqual(state()["text"], draft)
        capture("home-split-controls-draft-" + String(Int(app.windows.firstMatch.frame.width)))
    }

    func test02LongModelNameAtAccessibilityTextSize() {
        launch(largeText: true, longName: true)
        assertSeparateReachableControls()
        XCTAssertGreaterThan(app.buttons["home.model-picker"].frame.width, 200, "Large-text model names need a readable row, not an ellipsis-only capsule")
        XCTAssertTrue(app.buttons["home.model-picker"].label.contains("Research Model With a Very Long Descriptive Name"))
        capture("home-long-name-AX3-" + String(Int(app.windows.firstMatch.frame.width)))
        app.buttons["home.model-picker"].tap()
        XCTAssertTrue(app.searchFields.firstMatch.waitForExistence(timeout: 8))
        closeModelPicker()
        assertSeparateReachableControls()
        XCTAssertEqual(state()["model"], "relay-proxy/long-context-model")
    }
}
