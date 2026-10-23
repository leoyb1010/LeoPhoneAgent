import XCTest

/// WP-40:部署目标 iOS / watchOS 27.0。低于等于 27 的 `#available` 永远为真、
/// `#unavailable` 永远为假,留着只会让人误以为还有旧系统分支要维护。
final class DeploymentTargetTests: XCTestCase {
    private var iosRoot: URL {
        URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
    }

    func testEveryTargetIsOn27() throws {
        let pbx = try String(contentsOf: iosRoot.appendingPathComponent("LeoPhoneAgent.xcodeproj/project.pbxproj"), encoding: .utf8)
        let re = try NSRegularExpression(pattern: #"(IPHONEOS|WATCHOS)_DEPLOYMENT_TARGET = ([0-9.]+);"#)
        let matches = re.matches(in: pbx, range: NSRange(pbx.startIndex..., in: pbx))
        XCTAssertFalse(matches.isEmpty)
        for m in matches {
            let value = String(pbx[Range(m.range(at: 2), in: pbx)!])
            XCTAssertEqual(value, "27.0")
        }
    }

    func testNoAlwaysTrueAvailabilityChecksRemain() throws {
        let re = try NSRegularExpression(
            pattern: #"#(un)?available\((iOS|iOSApplicationExtension|watchOS|watchOSApplicationExtension) ([0-9]+)(?:\.([0-9]+))?"#)
        let skip: Set<String> = ["Vendor", "iSH", "MinisTests", "MinisUITests", "LeoPhoneAgent.xcodeproj"]
        var offenders: [String] = []
        let enumerator = FileManager.default.enumerator(at: iosRoot, includingPropertiesForKeys: nil)!
        for case let url as URL in enumerator {
            if skip.contains(url.lastPathComponent) { enumerator.skipDescendants(); continue }
            guard url.pathExtension == "swift",
                  let text = try? String(contentsOf: url, encoding: .utf8) else { continue }
            for (n, line) in text.components(separatedBy: "\n").enumerated() {
                let trimmed = line.trimmingCharacters(in: .whitespaces)
                if trimmed.hasPrefix("//") || trimmed.hasPrefix("///") { continue }
                let code = line.components(separatedBy: "//").first ?? line
                for m in re.matches(in: code, range: NSRange(code.startIndex..., in: code)) {
                    let major = Int(code[Range(m.range(at: 3), in: code)!]) ?? 0
                    // 27.1+ APIs (iPhone Duo: vertical bars, reserved regions) are real checks.
                    let minor = Range(m.range(at: 4), in: code).flatMap { Int(code[$0]) } ?? 0
                    if major < 27 || (major == 27 && minor == 0) { offenders.append("\(url.lastPathComponent):\(n + 1)") }
                }
            }
        }
        XCTAssertEqual(offenders, [], "always-true availability checks; collapse them to the new branch")
    }
}
