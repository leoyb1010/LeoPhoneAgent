import XCTest

final class T5ShellBridgeTests: XCTestCase {
    func testSafeExportStripsOAuthAndKeys() {
        let raw: [String: Any] = [
            "label": "Claude",
            "apiKey": "secret",
            "manualOAuthToken": "tok",
            "oauthToken": "blob",
            "oauthEmail": "a@b.c",
            "oauthGcpProject": "proj",
            "customBaseURL": "https://example.com",
        ]
        let safe = ProviderExportSecrets.stripped(raw)
        XCTAssertEqual(safe["label"] as? String, "Claude")
        XCTAssertEqual(safe["customBaseURL"] as? String, "https://example.com")
        for key in ProviderExportSecrets.keys {
            XCTAssertNil(safe[key], "safe export must drop \(key)")
        }
    }

    func testWorkspaceBindFileRoundTrip() {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("t5-workspace-bind-\(UUID().uuidString).json")
        defer { try? FileManager.default.removeItem(at: url) }
        let mount = UUID().uuidString
        SessionWorkspaceBindStore.save(["hs_test": mount], to: url)
        XCTAssertEqual(SessionWorkspaceBindStore.load(from: url)["hs_test"], mount)
    }
}
