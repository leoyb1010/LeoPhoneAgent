import XCTest

/// [up3-ios] 首页「+」和定时任务列表的文案都在字符串目录里,三种语言齐全。
final class HomePlusMenuLocalizationTests: XCTestCase {
    private var iosRoot: URL { URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent() }

    func testHomePlusMenuReusesChatPlusMenuKeys() throws {
        let source = try String(contentsOf: iosRoot.appendingPathComponent("Views/ContentView.swift"), encoding: .utf8)
        let start = try XCTUnwrap(source.range(of: "private var homePlusMenuContent: some View {"))
        let end = try XCTUnwrap(source.range(of: "private var homeActions:", range: start.upperBound..<source.endIndex))
        let menu = String(source[start.upperBound..<end.lowerBound])
        for key in ["Take Photo", "Choose Photos & Videos", "Add File", "录音"] {
            XCTAssertTrue(menu.contains("Label(\"\(key)\""), key)
        }
        for stale in ["Label(\"拍照\"", "Label(\"照片与视频\"", "Label(\"文件\""] {
            XCTAssertFalse(menu.contains(stale), "\(stale) 不在字符串目录里 / 没有英文")
        }
    }

    func testCatalogHasAllLanguages() throws {
        let data = try Data(contentsOf: iosRoot.appendingPathComponent("Localizable.xcstrings"))
        let root = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let strings = try XCTUnwrap(root["strings"] as? [String: Any])
        for key in ["Take Photo", "Choose Photos & Videos", "Add File", "录音", "删除", "查看这次运行"] {
            let entry = try XCTUnwrap(strings[key] as? [String: Any], key)
            let locs = try XCTUnwrap(entry["localizations"] as? [String: Any], key)
            for lang in ["en", "zh-Hans", "zh-Hant"] { XCTAssertNotNil(locs[lang], "\(key) \(lang)") }
        }
    }
}
