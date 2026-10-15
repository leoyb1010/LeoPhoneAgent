import XCTest

/// [T-paperclip-retired] 1.72 下架服务器任务:老配置清干净、只跑一次、App 里不再有任何入口。
final class PaperclipRetirementTests: XCTestCase {
    private var iosRoot: URL {
        URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
    }

    /// 只测清配置这一半:runOnce 的系统清理会碰通知中心,在没有宿主 App 的测试进程里会崩(曾让下一个测试挂掉)。
    func testClearDefaultsRemovesEveryPaperclipKeyAndOnlyRunsOnce() throws {
        let suite = "PaperclipRetirementTests-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let profile = UUID()
        defaults.set(try JSONSerialization.data(withJSONObject: [["id": profile.uuidString, "name": "x"]]),
                     forKey: PaperclipRetirement.profilesKey)
        defaults.set("paperclip", forKey: "leo.ios.executionBackend.v1")
        defaults.set("draft", forKey: "leo.paperclip.draft.v1.abc")
        defaults.set(true, forKey: "leo.paperclip.localReturnPending.v1")
        defaults.set(true, forKey: "permissions.fullAuto.enabled")   // 共享键,不能动
        defaults.set("keep", forKey: "leo.other.setting")

        XCTAssertEqual(PaperclipRetirement.clearDefaultsOnce(defaults), [profile])

        for key in [PaperclipRetirement.profilesKey, "leo.ios.executionBackend.v1",
                    "leo.paperclip.draft.v1.abc", "leo.paperclip.localReturnPending.v1"] {
            XCTAssertNil(defaults.object(forKey: key), key)
        }
        XCTAssertTrue(defaults.bool(forKey: "permissions.fullAuto.enabled"))
        XCTAssertEqual(defaults.string(forKey: "leo.other.setting"), "keep")
        XCTAssertTrue(defaults.bool(forKey: PaperclipRetirement.doneKey))

        // 第二次:标记已在,新写进去的同名键不会再被清(证明只跑一次)。
        defaults.set("later", forKey: "leo.paperclip.draft.v1.new")
        XCTAssertNil(PaperclipRetirement.clearDefaultsOnce(defaults))
        XCTAssertEqual(defaults.string(forKey: "leo.paperclip.draft.v1.new"), "later")
    }

    func testProfileIdsAreReadForWebDataCleanup() {
        let a = UUID(), b = UUID()
        let data = try? JSONSerialization.data(withJSONObject: [["id": a.uuidString], ["id": "not-a-uuid"], ["id": b.uuidString]])
        XCTAssertEqual(PaperclipRetirement.profileIds(from: data), [a, b])
        XCTAssertEqual(PaperclipRetirement.profileIds(from: nil), [])
        XCTAssertEqual(PaperclipRetirement.profileIds(from: Data("garbage".utf8)), [])
    }

    func testKeysToRemoveKeepsTheDoneMarker() {
        let keys = PaperclipRetirement.keysToRemove(in: ["leo.paperclip.a", PaperclipRetirement.doneKey, "leo.x"])
        XCTAssertEqual(Set(keys), ["leo.paperclip.a", "leo.ios.executionBackend.v1"])
    }

    /// 没有任何 Swift 源文件还在引用已删除的服务器任务类型或入口。
    func testNoAppCodeStillReferencesTheServerWorkspace() throws {
        let banned = ["PaperclipWorkspace", "PaperclipProfile", "PaperclipDeepLink", "PaperclipHandoff",
                      "IOSExecutionBackend", "PaperclipBackendSettingsView", "leo.openPaperclipFromChat",
                      "PaperclipLiveActivityWidget", "CreatePaperclipIssueIntent"]
        guard let walker = FileManager.default.enumerator(at: iosRoot, includingPropertiesForKeys: nil) else { return XCTFail() }
        for case let url as URL in walker where url.pathExtension == "swift" {
            if url.path.contains("/MinisTests/") || url.path.contains("/MinisUITests/") { continue }
            let text = try String(contentsOf: url, encoding: .utf8)
            for name in banned { XCTAssertFalse(text.contains(name), "\(url.lastPathComponent) 还引用 \(name)") }
        }
        let launch = try String(contentsOf: iosRoot.appendingPathComponent("MinisApp.swift"), encoding: .utf8)
        XCTAssertTrue(launch.contains("PaperclipRetirement.runOnce()"))
        XCTAssertTrue(launch.contains("                ContentView()\n"), "App 根视图直接是 ContentView")
        for lang in ["en", "zh-Hans", "zh-Hant"] {
            let strings = try String(contentsOf: iosRoot.appendingPathComponent("\(lang).lproj/AppShortcuts.strings"), encoding: .utf8)
            XCTAssertFalse(strings.contains("Paperclip"), lang)
        }
    }
}
