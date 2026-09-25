import XCTest

/// [T-a11y-audit] Every control on the main surfaces has a name VoiceOver can
/// read, is detectable, and carries the right traits.
///
/// Not audited, on purpose: Dynamic Type and clipped text (the app follows its
/// own text-size setting in Settings → Appearance, and session previews
/// truncate by design) and hit regions (the model subtitle in the chat title is
/// a deliberately small text button; the composer card takes taps for its
/// one-line text view).
final class AccessibilityAuditUITests: XCTestCase {
    private let audited: XCUIAccessibilityAuditType = [.sufficientElementDescription, .elementDetection, .trait]

    func testMainSurfacesHaveNamedControls() throws {
        let app = XCUIApplication()
        app.launch()
        // A fresh install shows "本次更新" first.
        if app.buttons["完成"].waitForExistence(timeout: 4) { app.buttons["完成"].tap() }

        try app.performAccessibilityAudit(for: audited)

        open("leophoneagent://new", in: app)
        try app.performAccessibilityAudit(for: audited)

        open("leophoneagent://settings", in: app)
        try app.performAccessibilityAudit(for: audited)
    }

    /// Like tapping a link: the running app handles it, no relaunch.
    private func open(_ url: String, in app: XCUIApplication) {
        XCUIDevice.shared.system.open(URL(string: url)!)
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        for label in ["打开", "Open"] where springboard.buttons[label].waitForExistence(timeout: 1.5) {
            springboard.buttons[label].tap()
            break
        }
        _ = app.wait(for: .runningForeground, timeout: 5)
        RunLoop.current.run(until: Date().addingTimeInterval(2))
    }
}
