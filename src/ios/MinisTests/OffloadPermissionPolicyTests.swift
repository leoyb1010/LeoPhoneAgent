import XCTest

final class OffloadPermissionPolicyTests: XCTestCase {
    func testPrivacyDefaultsToAskWhenUnset() {
        XCTAssertEqual(OffloadPermissionPolicy.resolvedLevel(stored: nil, isPrivacy: true), 1)
        XCTAssertEqual(OffloadPermissionPolicy.resolvedLevel(stored: 0, isPrivacy: true), 0)
        XCTAssertEqual(OffloadPermissionPolicy.resolvedLevel(stored: 1, isPrivacy: true), 1)
        XCTAssertEqual(OffloadPermissionPolicy.resolvedLevel(stored: nil, isPrivacy: false), 0)
    }

    func testExtractFindsOffloadAfterPathOrChain() {
        let known = ["apple-files", "apple-camera"]
        XCTAssertEqual(
            OffloadPermissionPolicy.extractOffloadCommand(from: "apple-files request", known: known),
            "apple-files"
        )
        XCTAssertEqual(
            OffloadPermissionPolicy.extractOffloadCommand(from: "/usr/local/bin/apple-files request", known: known),
            "apple-files"
        )
        XCTAssertEqual(
            OffloadPermissionPolicy.extractOffloadCommand(from: "cd /tmp && apple-camera photo", known: known),
            "apple-camera"
        )
        XCTAssertNil(OffloadPermissionPolicy.extractOffloadCommand(from: "ls /tmp", known: known))
    }

    func testDenialStringsAreChinese() {
        XCTAssertTrue(OffloadPermissionPolicy.disabledDenial(command: "apple-files").contains("已拒绝"))
        XCTAssertFalse(OffloadPermissionPolicy.disabledDenial(command: "apple-files").hasPrefix("Permission denied"))
    }
}
