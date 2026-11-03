import XCTest

@MainActor
final class BrainWorkspaceUpgradeUITests: XCTestCase {
    override class func setUp() { super.setUp(); UITestRecordingPolicy.apply() }
    private func capture(_ name: String) {
        let image = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        image.name = name; image.lifetime = .keepAlways; add(image)
    }
    func testSecondBrainEntryAndAdaptiveScopes() {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = ["-AppleLanguages", "(zh-Hans)", "-AppleLocale", "zh_CN",
                               "-leo.releaseNotes.lastPresentedVersion", "1.87.1"]
        app.launch()
        if app.navigationBars["本次更新"].waitForExistence(timeout: 3) {
            capture("brain-product-whats-new")
            app.navigationBars["本次更新"].buttons["完成"].tap()
        }
        let skip = app.buttons["onboarding.skip"]
        if skip.waitForExistence(timeout: 4) { skip.tap() }
        // 1.89: 分类检索 lives in the 第二大脑 space (title bar → 资料 → 分类检索); the collections link is the phone list again.
        let brain = app.buttons["第二大脑"]
        XCTAssertTrue(brain.waitForExistence(timeout: 10))
        brain.tap()
        let library = app.tabBars.buttons["资料"]
        XCTAssertTrue(library.waitForExistence(timeout: 10))
        library.tap()
        let workspace = app.buttons["brain.workspace"]
        XCTAssertTrue(workspace.waitForExistence(timeout: 10))
        workspace.tap()
        XCTAssertTrue(app.navigationBars["分类检索"].waitForExistence(timeout: 15))
        XCTAssertTrue(app.searchFields.firstMatch.exists)
        for id in ["all", "files", "photos", "videos", "cards"] {
            let scope = app.buttons["brain.scope." + id]
            XCTAssertTrue(scope.exists)
            // CoreGraphics may report 43.99999999999994 for a 44pt target.
            XCTAssertGreaterThanOrEqual(scope.frame.height + 0.001, 44)
        }
        capture("brain-product-portrait")
        app.buttons["brain.scope.photos"].tap()
        capture("brain-product-photos-state")
        app.buttons["brain.scope.videos"].tap()
        capture("brain-product-videos-state")
        XCUIDevice.shared.orientation = .landscapeLeft
        XCTAssertTrue(app.buttons["brain.scope.files"].waitForExistence(timeout: 5))
        capture("brain-product-landscape")
        XCUIDevice.shared.orientation = .portrait
        let phone = app.buttons["brain.phone-collections"]
        for _ in 0..<4 where !phone.isHittable { app.swipeUp() }
        XCTAssertTrue(phone.isHittable)
        phone.tap()
        XCTAssertTrue(app.navigationBars["手机收藏"].waitForExistence(timeout: 8))
        capture("brain-product-phone-collections-preserved")
    }
}
