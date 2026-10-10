import Foundation
import XCTest

/// Links come from anywhere. They may navigate and prefill — never escape a
/// scope, never execute, never supply a secret.
final class DeepLinkRouterTests: XCTestCase {

    private let sid = "6F1C2A3B-4D5E-4F60-8A9B-0C1D2E3F4A5B"

    func testOpenDeepLinkRejectsTraversalSessionId() {
        // `leophoneagent://open?session=../../..&path=attachments/index.html`
        XCTAssertNil(DeepLinkSafety.parseWebAppLaunch(session: "../../..", rawPath: "attachments/index.html"))
        XCTAssertNil(DeepLinkSafety.parseWebAppLaunch(session: "a/b", rawPath: "workspace/index.html"))
        XCTAssertNil(DeepLinkSafety.parseWebAppLaunch(session: "..", rawPath: "workspace/index.html"))
        XCTAssertNil(DeepLinkSafety.parseWebAppLaunch(session: nil, rawPath: "attachments/index.html"))
        // `..` inside the path is refused before anything is resolved.
        XCTAssertNil(DeepLinkSafety.parseWebAppLaunch(session: sid, rawPath: "attachments/../../other/index.html"))
        XCTAssertNil(DeepLinkSafety.parseWebAppLaunch(session: sid, rawPath: "workspace/./x/../../y.html"))
        XCTAssertNil(DeepLinkSafety.parseWebAppLaunch(session: nil, rawPath: "shared:../secrets.html"))
        XCTAssertNil(DeepLinkSafety.parseWebAppLaunch(session: nil, rawPath: "shared:/etc/passwd"))
        XCTAssertNil(DeepLinkSafety.parseWebAppLaunch(session: nil, rawPath: "mount:not-a-uuid/index.html"))
        XCTAssertNil(DeepLinkSafety.parseWebAppLaunch(session: nil, rawPath: "mount:\(sid)/../../index.html"))
        XCTAssertNil(DeepLinkSafety.parseWebAppLaunch(session: sid, rawPath: "attachments/a\\..\\b.html"))
        XCTAssertNil(DeepLinkSafety.parseWebAppLaunch(session: sid, rawPath: "attachments/a\u{0}.html"))

        // Legit launcher round-trips still work.
        XCTAssertEqual(DeepLinkSafety.parseWebAppLaunch(session: sid, rawPath: "attachments/site/index.html"),
                       .init(scope: .sessionAttachment, context: sid, htmlPath: "site/index.html"))
        XCTAssertEqual(DeepLinkSafety.parseWebAppLaunch(session: sid, rawPath: "workspace/app..v2/index.html")?.htmlPath,
                       "app..v2/index.html", "dots inside a name are fine; only `..` segments are not")
        XCTAssertEqual(DeepLinkSafety.parseWebAppLaunch(session: nil, rawPath: "mount:\(sid)/a/b.html"),
                       .init(scope: .mount, context: sid, htmlPath: "a/b.html"))
        XCTAssertEqual(DeepLinkSafety.parseWebAppLaunch(session: nil, rawPath: "shared:tools/x.html")?.scope, .shared)
    }

    func testSessionIdShapes() {
        XCTAssertTrue(DeepLinkSafety.isSafeSessionId(sid))
        XCTAssertTrue(DeepLinkSafety.isSafeSessionId("draft-123_abc"))
        for bad in ["", ".", "..", "../x", "a/b", ".hidden", "a b", String(repeating: "a", count: 200), "a..b"] {
            XCTAssertFalse(DeepLinkSafety.isSafeSessionId(bad), bad)
        }
    }

    func testDeepLinkNeverAutoSends() {
        // Terminal: prefill only — an encoded newline must not press Return.
        let url = URL(string: "leophoneagent://open_terminal?init_command=rm%20-rf%20~%0Aecho%20pwned%0D")!
        let raw = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first?.value
        let prefill = DeepLinkSafety.terminalPrefill(raw)
        XCTAssertEqual(prefill, "rm -rf ~echo pwned")
        XCTAssertFalse(prefill?.contains("\n") ?? true)
        XCTAssertFalse(prefill?.contains("\r") ?? true)

        // Environment variables: the link names the key; it never plants a value.
        let env = URLComponents(string: "leophoneagent://settings/environments?create_key=GH_TOKEN&create_value=ghp_attacker&create_note=from%20docs")!
        let fill = DeepLinkSafety.envVarPrefill(env.queryItems ?? [])
        XCTAssertEqual(fill?.key, "GH_TOKEN")
        XCTAssertEqual(fill?.note, "from docs")
        XCTAssertNil(DeepLinkSafety.envVarPrefill([URLQueryItem(name: "create_value", value: "x")]))
        XCTAssertNil(DeepLinkSafety.envVarPrefill([URLQueryItem(name: "create_key", value: "  ")]))
    }
}
