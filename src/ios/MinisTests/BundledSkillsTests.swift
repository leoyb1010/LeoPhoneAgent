import XCTest

/// [T-bundled-skills] 随 App 打包的技能:安装决策(纯逻辑)+ 打包内容本身的检查。
final class BundledSkillsTests: XCTestCase {
    private var iosRoot: URL {
        URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
    }
    private var bundleRoot: URL { iosRoot.appendingPathComponent("BundledSkills") }

    // MARK: - 安装决策

    func testFreshDeviceInstalls() {
        XCTAssertEqual(BundledSkillPlan.decide(bundledVersion: "1.0.0", installedVersion: nil,
                                               installedIsBundled: false, everInstalled: false), .install)
    }

    func testUserRemovedSkillIsNotReinstalled() {
        XCTAssertEqual(BundledSkillPlan.decide(bundledVersion: "2.0.0", installedVersion: nil,
                                               installedIsBundled: false, everInstalled: true), .skip("user-removed"))
    }

    func testUserOwnedSameNameSkillIsNeverOverwritten() {
        XCTAssertEqual(BundledSkillPlan.decide(bundledVersion: "9.0.0", installedVersion: "1.0.0",
                                               installedIsBundled: false, everInstalled: false), .skip("user-owned"))
    }

    func testBundledSkillUpgradesOnlyWhenNewer() {
        XCTAssertEqual(BundledSkillPlan.decide(bundledVersion: "1.1.0", installedVersion: "1.0.0",
                                               installedIsBundled: true, everInstalled: true), .upgrade)
        XCTAssertEqual(BundledSkillPlan.decide(bundledVersion: "1.0.0", installedVersion: "1.0.0",
                                               installedIsBundled: true, everInstalled: true), .skip("up-to-date"))
        XCTAssertEqual(BundledSkillPlan.decide(bundledVersion: "1.0.0", installedVersion: "1.2.0",
                                               installedIsBundled: true, everInstalled: true), .skip("up-to-date"))
    }

    func testVersionsCompareNumerically() {
        XCTAssertEqual(BundledSkillPlan.compareVersions("1.10.0", "1.9.0"), .orderedDescending, "不是字符串比较")
        XCTAssertEqual(BundledSkillPlan.compareVersions("1.0", "1.0.0"), .orderedSame)
        XCTAssertEqual(BundledSkillPlan.compareVersions("2", "10"), .orderedAscending)
    }

    // MARK: - 打包内容

    private func bundledSkillDirs() throws -> [URL] {
        try FileManager.default.contentsOfDirectory(at: bundleRoot, includingPropertiesForKeys: nil)
            .filter { !$0.lastPathComponent.hasPrefix(".") }
            .sorted { $0.lastPathComponent < $1.lastPathComponent }
    }

    func testBundleHoldsExactlyThePlannedSkills() throws {
        XCTAssertEqual(try bundledSkillDirs().map(\.lastPathComponent),
                       ["data-analyze", "frontend-design", "humanizer-zh", "leo-office", "pdf"])
    }

    /// 每个技能:能被 App 的解析器读出名字 / 描述 / 版本,目录名就是它的 id,并且带许可文件。
    func testEverySkillParsesAndCarriesALicense() throws {
        for dir in try bundledSkillDirs() {
            let text = try String(contentsOf: dir.appendingPathComponent("SKILL.md"), encoding: .utf8)
            let parsed = SkillManifest.parse(text)
            XCTAssertEqual(parsed.name, dir.lastPathComponent, "目录名要等于 name,否则 id 对不上")
            XCTAssertFalse(parsed.description.isEmpty, dir.lastPathComponent)
            XCTAssertFalse(parsed.frontmatterUnterminated, dir.lastPathComponent)
            XCTAssertEqual(parsed.version, "1.0.0", dir.lastPathComponent)
            let files = try FileManager.default.contentsOfDirectory(atPath: dir.path)
            XCTAssertTrue(files.contains { $0.hasPrefix("LICENSE") }, "\(dir.lastPathComponent) 缺少许可文件")
        }
    }

    /// Anthropic 的 docx / pdf / xlsx / pptx 是专有许可(禁止复制),不能出现在包里。
    func testNoProprietaryAnthropicDocumentSkillsAreBundled() throws {
        for dir in try bundledSkillDirs() {
            let license = try FileManager.default.contentsOfDirectory(atPath: dir.path)
                .filter { $0.hasPrefix("LICENSE") }
                .map { try String(contentsOf: dir.appendingPathComponent($0), encoding: .utf8) }
                .joined()
            XCTAssertFalse(license.contains("All rights reserved"), "\(dir.lastPathComponent) 是专有许可")
            XCTAssertTrue(license.contains("MIT License") || license.contains("Apache License"), dir.lastPathComponent)
        }
    }

    /// 脚本不能叫 inspect.py:会遮住标准库 inspect,numpy / openpyxl 一导入就崩(实测)。
    func testNoScriptShadowsAStandardLibraryModule() throws {
        let walker = FileManager.default.enumerator(at: bundleRoot, includingPropertiesForKeys: nil)
        let shadowing: Set<String> = ["inspect.py", "types.py", "json.py", "re.py", "io.py", "copy.py", "string.py"]
        while let url = walker?.nextObject() as? URL {
            XCTAssertFalse(shadowing.contains(url.lastPathComponent), url.path)
        }
        let office = try String(contentsOf: bundleRoot.appendingPathComponent("leo-office/SKILL.md"), encoding: .utf8)
        XCTAssertTrue(office.contains("/var/minis/skills/leo-office/scripts/office_inspect.py"))
    }

    // MARK: - 接线(SkillStore 编不进逻辑测试,读源码)

    func testInstallerRunsEveryLaunchAndRecordsWhatItInstalled() throws {
        let store = try String(contentsOf: iosRoot.appendingPathComponent("Agent/Session/SkillStore.swift"), encoding: .utf8)
        let fn = try XCTUnwrap(store.range(of: "private func installBundledSkills()"))
        let body = String(store[fn.lowerBound...].prefix(700))
        XCTAssertTrue(body.contains("installBundledSkillDirectories()"))
        XCTAssertFalse(body.contains("else { return }"), "skill-creator 已是最新时也要继续装目录里的技能")
        XCTAssertTrue(store.contains("Bundle.main.url(forResource: \"BundledSkills\", withExtension: nil)"))
        XCTAssertTrue(store.contains("everInstalled: ledger[id] != nil"))
        XCTAssertTrue(store.contains("importSkill(content: content, source: .bundled, replace: true)"))
        let pbx = try String(contentsOf: iosRoot.appendingPathComponent("LeoPhoneAgent.xcodeproj/project.pbxproj"), encoding: .utf8)
        XCTAssertTrue(pbx.contains("E5BSK0001 /* BundledSkills in Resources */,"), "要打进 App 的资源")
    }
}
