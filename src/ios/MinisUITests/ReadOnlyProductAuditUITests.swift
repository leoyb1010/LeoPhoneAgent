import XCTest

/// Drives the installed Release through an audited runner-only xctestrun.
/// UseDestinationArtifacts is preferred when supported. Never installs a product, writes
/// a composer, selects a model, toggles settings, or starts a capability probe.
@MainActor
final class ReadOnlyProductAuditUITests: XCTestCase {
    private let app = XCUIApplication(bundleIdentifier: "com.leoyuan.leophoneagent")

    override func setUp() { continueAfterFailure = true }

    private func settle() {
        RunLoop.current.run(until: Date().addingTimeInterval(0.8))
    }

    private func capture(_ name: String, status: String = "CAPTURED — visual verification required") {
        let picture = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        picture.name = name
        picture.lifetime = .keepAlways
        add(picture)
        let tree = XCTAttachment(string: "\(status)\n\(app.debugDescription)")
        tree.name = name + "-accessibility"
        tree.lifetime = .keepAlways
        add(tree)
    }

    private func missing(_ name: String) {
        capture(name, status: "MISSING — requested surface was not reached")
        XCTFail("Missing audit surface: \(name)")
    }

    func test01CurrentHomeAndModelPicker() {
        app.activate()
        XCTAssertTrue(app.wait(for: .runningForeground, timeout: 8))
        capture("01-current-app-baseline")
        let capsule = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "执行位置和模型")).firstMatch
        guard capsule.waitForExistence(timeout: 3), capsule.isHittable else {
            missing("02-home-capsule"); return
        }
        capsule.tap()
        settle()
        capture("02-home-execution-model-menu")
        let more = app.buttons["更多模型…"]
        guard more.waitForExistence(timeout: 3), more.isHittable else {
            missing("03-more-models-entry"); return
        }
        more.tap()
        settle()
        capture("03-model-picker-initial")
        for (name, labels) in [("favorites", ["常用", "收藏", "Favorites"]),
                               ("providers", ["AI 服务商", "服务商", "供应商", "Providers"]),
                               ("groups", ["分组", "Groups"])] {
            let tab = app.segmentedControls.buttons.matching(NSPredicate(format: "label IN %@", labels)).firstMatch
            guard tab.exists, tab.isHittable else { missing("04-model-tab-" + name); continue }
            tab.tap()
            settle()
            capture("04-model-tab-" + name)
        }
        // Only the picker navigation bar's dismiss action, never a row action.
        let close = app.navigationBars.buttons.matching(NSPredicate(format: "label IN %@", ["完成", "Done", "取消", "Cancel"])).firstMatch
        if close.exists, close.isHittable { close.tap(); settle() }
        else { missing("05-model-picker-dismiss") }
        capture("05-home-after-model-inspection")
    }

    func test02ReadOnlySettingsRoutes() {
        app.activate()
        // These routes are plain navigation in Shared/DeepLinkRouter.swift.
        // Deliberately omit new, voice, quick-task, environments/create_*, and selftest.
        let routes: [(String, String)] = [
            ("settings", "设置"), ("settings/providers", "模型"),
            ("settings/model-groups", "分组"), ("settings/usage", "用量"),
            ("settings/skills", "技能"), ("settings/mcp", "MCP"),
            ("settings/mail", "邮箱"), ("settings/memory", "记忆"),
            ("settings/storage", "存储"), ("settings/mount-external", "挂载"),
            ("settings/shared-folders", "共享"), ("settings/logs", "日志"),
            ("settings/appearance", "外观"), ("settings/background", "后台"),
            ("settings/permissions", "权限"), ("settings/about", "关于")
        ]
        for (index, route) in routes.enumerated() {
            app.open(URL(string: "leophoneagent://" + route.0)!)
            XCTAssertTrue(app.wait(for: .runningForeground, timeout: 8))
            settle()
            let name = String(format: "%02d-", index + 10) + route.0.replacingOccurrences(of: "/", with: "-")
            let found = app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", route.1)).firstMatch.exists
                || app.navigationBars.matching(NSPredicate(format: "identifier CONTAINS %@", route.1)).firstMatch.exists
            capture(name, status: found ? "ROUTE REQUESTED — title token observed; verify screenshot" : "MISSING TITLE TOKEN — route may not have opened: " + route.1)
            if !found { XCTFail("Unverified route title: \(route.0)") }
        }
    }
}
