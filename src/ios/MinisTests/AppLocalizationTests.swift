import XCTest

/// WP-40:应用内切语言即时生效 —— `AppLocalized` 必须读当前 override 的 `.lproj`,
/// 而不是进程启动时定下的语言。
final class AppLocalizationTests: XCTestCase {
    private var tmp: URL!

    override func setUpWithError() throws {
        tmp = FileManager.default.temporaryDirectory.appendingPathComponent("AppLocalizationTests-\(UUID().uuidString)")
        for (lang, value) in [("en", "Hello"), ("zh-Hans", "你好")] {
            let dir = tmp.appendingPathComponent("\(lang).lproj")
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            try "\"wp40.greeting\" = \"\(value)\";\n".write(to: dir.appendingPathComponent("Localizable.strings"),
                                                          atomically: true, encoding: .utf8)
        }
    }

    override func tearDownWithError() throws {
        Bundle.main.languageBundle = nil
        try? FileManager.default.removeItem(at: tmp)
    }

    func testFollowsOverrideBundleWithoutRelaunch() throws {
        let host = try XCTUnwrap(Bundle(url: tmp))
        Bundle.main.languageBundle = Bundle.languageBundle(for: "zh-Hans", in: host)
        XCTAssertEqual(AppLocalized("wp40.greeting"), "你好")
        // 同一进程里再切,立即生效。
        Bundle.main.languageBundle = Bundle.languageBundle(for: "en", in: host)
        XCTAssertEqual(AppLocalized("wp40.greeting"), "Hello")
    }

    func testNoOverrideFallsBackToMainBundle() {
        Bundle.main.languageBundle = nil
        XCTAssertTrue(AppBundle.current === Bundle.main)
        // 主 bundle 里没有这个 key:原样返回 key,不崩。
        XCTAssertEqual(AppLocalized("wp40.missing.key"), "wp40.missing.key")
    }

    func testUnknownOrEmptyLanguageHasNoBundle() throws {
        let host = try XCTUnwrap(Bundle(url: tmp))
        XCTAssertNil(Bundle.languageBundle(for: "", in: host))
        XCTAssertNil(Bundle.languageBundle(for: nil, in: host))
        XCTAssertNil(Bundle.languageBundle(for: "ja", in: host))
    }

    func testOverrideSwizzleIsIdempotent() throws {
        Bundle.enableLanguageOverride()
        Bundle.enableLanguageOverride()
        // 交换两次会把实现换回去,`Text("…")` 走的 localizedString 就不再看 override。
        let host = try XCTUnwrap(Bundle(url: tmp))
        Bundle.main.languageBundle = Bundle.languageBundle(for: "zh-Hans", in: host)
        XCTAssertEqual(Bundle.main.localizedString(forKey: "wp40.greeting", value: nil, table: nil), "你好")
    }

    func testResourceFormFollowsSystemWithoutOverride() {
        Bundle.setLanguage(nil)
        XCTAssertNil(Bundle.overrideLanguageCode)
        XCTAssertEqual(AppLocalized(resource: LocalizedStringResource("wp40.missing.key")), "wp40.missing.key")
    }

    /// 门禁:App 进程里的源码不再出现裸 `String(localized:)`(字符串插值内部的除外),
    /// 否则那一处切语言后要重启才变。扩展进程的源码(小组件/分享/FileProvider/手表)不受此约束。
    func testAppSourcesRouteThroughAppLocalized() throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
        let pbx = try String(contentsOf: root.appendingPathComponent("LeoPhoneAgent.xcodeproj/project.pbxproj"), encoding: .utf8)
        // 扩展 target 编译的文件名:各 target 的 Sources 段里列出的 "X.swift in Sources"。
        var extensionFiles = Set<String>()
        let targetRe = try NSRegularExpression(pattern: #"/\* (LeoWatch|MinisShare|MinisFileProvider|AgentWidgetExtension) \*/ = \{\s*isa = PBXNativeTarget;[\s\S]*?buildPhases = \(([\s\S]*?)\);"#)
        let ns = pbx as NSString
        for m in targetRe.matches(in: pbx, range: NSRange(location: 0, length: ns.length)) {
            let phases = ns.substring(with: m.range(at: 2))
            guard let phaseId = phases.components(separatedBy: .whitespacesAndNewlines)
                    .first(where: { !$0.isEmpty && phases.contains("\($0) /* Sources */") }),
                  let start = pbx.range(of: "\(phaseId) /* Sources */ = {"),
                  let end = pbx.range(of: ");", range: start.upperBound..<pbx.endIndex) else { continue }
            let body = pbx[start.upperBound..<end.lowerBound]
            for line in body.components(separatedBy: "\n") {
                if let r = line.range(of: #"/\* (.+?) in Sources \*/"#, options: .regularExpression) {
                    extensionFiles.insert(String(line[r]).replacingOccurrences(of: "/* ", with: "")
                        .replacingOccurrences(of: " in Sources */", with: ""))
                }
            }
        }
        XCTAssertTrue(extensionFiles.contains("AgentLiveActivityWidget.swift"), "pbxproj parse broke")
        let skipDirs: Set<String> = ["Vendor", "iSH", "MinisTests", "MinisUITests", "LeoWatch", "AgentWidget",
                                     "ShareExtension", "FileProvider", "LeoPhoneAgent.xcodeproj"]
        var offenders: [String] = []
        let it = FileManager.default.enumerator(at: root, includingPropertiesForKeys: nil)!
        for case let url as URL in it {
            if skipDirs.contains(url.lastPathComponent) { it.skipDescendants(); continue }
            guard url.pathExtension == "swift", !extensionFiles.contains(url.lastPathComponent),
                  url.lastPathComponent != "AppLocalization.swift",
                  let text = try? String(contentsOf: url, encoding: .utf8) else { continue }
            for (n, line) in text.components(separatedBy: "\n").enumerated() {
                let code = line.components(separatedBy: "//").first ?? line
                guard code.contains("String(localized:") else { continue }
                if code.contains("\\(String(localized:") { continue }   // 插值内部,脚本没改
                offenders.append("\(url.lastPathComponent):\(n + 1)")
            }
        }
        XCTAssertEqual(offenders, [], "use AppLocalized(...) so the in-app language switch applies immediately")
    }
}
