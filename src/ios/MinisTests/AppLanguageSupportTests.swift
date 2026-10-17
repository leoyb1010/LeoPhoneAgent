import XCTest

/// WP-03:半译语言下架后,语言选择器、Info.plist、.lproj、备用图标四处必须一致。
final class AppLanguageSupportTests: XCTestCase {
    private var iosRoot: URL {
        URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
    }

    private func infoPlist() throws -> [String: Any] {
        let data = try Data(contentsOf: iosRoot.appendingPathComponent("Info.plist"))
        return try XCTUnwrap(PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any])
    }

    func testPickerOnlyOffersFullyTranslatedLanguages() {
        XCTAssertEqual(supportedLanguages.map(\.id), ["", "en", "zh-Hans", "zh-Hant"])
    }

    func testRetiredLanguageFallsBackToSystem() {
        for retired in ["ja", "ko", "fr", "de", "ru", "xx"] {
            XCTAssertEqual(LanguageOption.normalizedAppLanguage(retired), "", retired)
        }
        for kept in ["", "en", "zh-Hans", "zh-Hant"] {
            XCTAssertEqual(LanguageOption.normalizedAppLanguage(kept), kept)
        }
    }

    func testInfoPlistLocalizationsMatchPicker() throws {
        let declared = try XCTUnwrap(infoPlist()["CFBundleLocalizations"] as? [String])
        XCTAssertEqual(Set(declared), Set(supportedLanguages.map(\.id).filter { !$0.isEmpty }))
        for retired in ["ja", "ko", "fr", "de", "ru"] {
            XCTAssertFalse(FileManager.default.fileExists(atPath: iosRoot.appendingPathComponent("\(retired).lproj").path),
                           "\(retired).lproj should stay removed")
        }
    }

    func testAlternateIconsPointAtExistingFiles() throws {
        for key in ["CFBundleIcons", "CFBundleIcons~ipad"] {
            let icons = try XCTUnwrap(infoPlist()[key] as? [String: Any])
            let alternates = try XCTUnwrap(icons["CFBundleAlternateIcons"] as? [String: [String: Any]])
            XCTAssertEqual(Array(alternates.keys), ["AppIcon-Light"], key)
            for entry in alternates.values {
                for file in entry["CFBundleIconFiles"] as? [String] ?? [] {
                    let path = iosRoot.appendingPathComponent("Resources/\(file).png").path
                    XCTAssertTrue(FileManager.default.fileExists(atPath: path), path)
                }
            }
        }
    }
}
