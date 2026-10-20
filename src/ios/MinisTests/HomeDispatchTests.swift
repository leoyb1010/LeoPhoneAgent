import XCTest

/// [up-home] 首页派 Mac：舰队默认随配对打开、执行目标记忆、最近目录、agent 菜单与启动器一致。
final class HomeDispatchTests: XCTestCase {
    private var defaults: UserDefaults!
    private let suite = "HomeDispatchTests"

    override func setUp() {
        super.setUp()
        defaults = UserDefaults(suiteName: suite)
        defaults.removePersistentDomain(forName: suite)
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suite)
        super.tearDown()
    }

    private func storeHosts(_ hosts: [[String: Any]]) throws {
        defaults.set(try JSONSerialization.data(withJSONObject: hosts), forKey: MacFleetFeature.hostsKey)
    }

    func testFleetTurnsOnOnceAMacIsPairedButRespectsAnExplicitOff() throws {
        XCTAssertFalse(MacFleetFeature.isEnabled(defaults), "没配对过：关")
        try storeHosts([["id": "a", "name": "Fold", "baseURL": "https://x", "platform": "android", "server": "minis"]])
        XCTAssertFalse(MacFleetFeature.isEnabled(defaults), "只有 Android 机身不算配对过 Mac")
        XCTAssertNil(defaults.object(forKey: MacFleetFeature.defaultsKey))

        try storeHosts([["id": "m", "name": "Studio", "baseURL": "https://y"]])
        XCTAssertTrue(MacFleetFeature.isEnabled(defaults))
        XCTAssertEqual(defaults.object(forKey: MacFleetFeature.defaultsKey) as? Bool, true, "写回，@AppStorage 视图跟着亮")

        defaults.set(false, forKey: MacFleetFeature.defaultsKey)
        XCTAssertFalse(MacFleetFeature.isEnabled(defaults), "用户显式关过：尊重")
    }

    func testExecutionTargetRoundTripsAndFallsBackWhenTheMachineIsGone() {
        let target = HomeMacDispatchTarget(hostId: "m1", cliKey: "codex", cliName: "Codex", cwd: "/Users/me/code/app")
        HomeMacDispatchTarget.save(target, defaults)
        XCTAssertEqual(HomeMacDispatchTarget.load(defaults), target)
        XCTAssertEqual(HomeMacDispatchTarget.restore(HomeMacDispatchTarget.load(defaults), availableHostIds: ["m1", "m2"]), target)
        XCTAssertNil(HomeMacDispatchTarget.restore(target, availableHostIds: ["m2"]), "机器没了：回落此 iPhone")
        HomeMacDispatchTarget.save(nil, defaults)
        XCTAssertNil(HomeMacDispatchTarget.load(defaults))
    }

    func testRecentDirectoriesDedupesSkipsHomeAndKeepsSix() {
        let dirs = HomeMacDispatchTarget.recentDirectories(
            ["/a", "~", "", "/b", "/a", " /c ", "/d", "/e", "/f", "/g", "/h"])
        XCTAssertEqual(dirs, ["/a", "/b", "/c", "/d", "/e", "/f"])
        XCTAssertEqual(HomeMacDispatchTarget.shortName("/Users/me/code/app/"), "app")
        XCTAssertEqual(HomeMacDispatchTarget.shortName("/"), "/")
    }

    func testAgentMenuListsEverythingLikeTheLauncher() {
        let known = HarnessCatalog.parse([
            ["key": "zcode", "name": "LeoBot", "available": false, "unavailable_reason": "还没配置模型"],
            ["key": "claude", "name": "Claude Code", "auth": ["logged_in": false, "login_kind": "auth_code"]],
            ["key": "codex", "name": "Codex", "auth": ["logged_in": true, "login_kind": "device"]],
        ])
        let entries = HarnessCatalog.menuEntries(known: known, runsLeoPhoneAgent: true, isAndroidBody: false)
        XCTAssertEqual(entries.map(\.key), ["zcode", "claude", "codex"], "不可用的也列出")
        XCTAssertEqual(entries[0].selectable, false)
        XCTAssertEqual(entries[0].note, "还没配置模型")
        XCTAssertTrue(entries[1].needsLogin)
        XCTAssertFalse(entries[1].selectable, "没登录：点了去登录，不直接派")
        XCTAssertTrue(entries[2].selectable)
        XCTAssertNil(entries[2].note)
        // 旧菜单仍只给能用的（对话框「指挥 Mac」现在用它）。
        XCTAssertEqual(HarnessCatalog.menuOptions(known: known, runsLeoPhoneAgent: true, isAndroidBody: false).map(\.0),
                       ["claude", "codex"])
        XCTAssertEqual(HarnessCatalog.menuEntries(known: nil, runsLeoPhoneAgent: false, isAndroidBody: false).map(\.key),
                       ["claude", "codex", "grok"])
    }
}
