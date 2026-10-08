import XCTest

/// Adapted from upstream OffloadPermissionBypassTests [GH#242]: the permission
/// gate must recognise an offload by the kernel's own rule (basename of the exec
/// path). Our extractor is stricter than upstream's first-token rule (it scans
/// every token), so the upstream "echo apple-x is not an offload" and
/// "indirection stays undetected" cases are intentionally not ported; the hard
/// enforcement is the per-slot authorizer in NativeOffloadDispatch anyway.
final class OffloadPermissionBypassTests: XCTestCase {
    private let known = ["apple-healthkit", "apple-clipboard", "apple-photos", "apple-location", "apple-calendar"]

    private func extract(_ cmd: String) -> String? {
        OffloadPermissionPolicy.extractOffloadCommand(from: cmd, known: known)
    }

    func testPathSpellingsAreRecognisedAsTheRegisteredName() {
        XCTAssertEqual(extract("/usr/local/bin/apple-healthkit read steps"), "apple-healthkit")
        XCTAssertEqual(extract("./apple-clipboard get"), "apple-clipboard")
        XCTAssertEqual(extract("/bin/../usr/local/bin/apple-photos list"), "apple-photos")
        XCTAssertEqual(extract("/tmp/anything/apple-location current"), "apple-location")
        XCTAssertEqual(extract("/usr/local/bin/apple-calendar list"), "apple-calendar")
    }

    func testPlainSpellingsStillRecognised() {
        XCTAssertEqual(extract("apple-healthkit read steps"), "apple-healthkit")
        XCTAssertEqual(extract("apple-clipboard"), "apple-clipboard")
        XCTAssertEqual(extract("   apple-photos list  "), "apple-photos")
    }

    func testNonOffloadAndLookalikeNamesAreNotRecognised() {
        for cmd in ["ls -la", "/bin/ls", "", "   ",
                    "apple-healthkit-helper read", "not-apple-photos list",
                    "/usr/bin/apple-photos-extra list"] {
            XCTAssertNil(extract(cmd), cmd.debugDescription)
        }
    }

    func testIndirectionThroughEnvIsStillGated() {
        // Stricter than upstream: any token naming an offload is gated.
        XCTAssertEqual(extract("env apple-photos list"), "apple-photos")
    }
}
