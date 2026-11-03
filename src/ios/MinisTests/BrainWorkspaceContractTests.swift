import XCTest

final class BrainWorkspaceContractTests: XCTestCase {
    func testMediaEndpointsIgnoreUntrustedURLsAndEncodeIDs() throws {
        let endpoint = try XCTUnwrap(BrainEndpoint(baseString: "https://example.test/gateway"))
        let url = endpoint.media("a/b?token=x", variant: "preview")
        XCTAssertEqual(url.host, "example.test")
        XCTAssertEqual(url.pathComponents.last, "preview")
        XCTAssertNil(URLComponents(url: url, resolvingAgainstBaseURL: false)?.query)
        XCTAssertTrue(url.absoluteString.contains("a%2Fb%3Ftoken%3Dx"))
        let search = URLComponents(url: endpoint.mediaSearch(query: "海边 & 2026", kind: "invalid", offset: -2, limit: 999), resolvingAgainstBaseURL: false)!
        let values = Dictionary(uniqueKeysWithValues: search.queryItems!.map { ($0.name, $0.value!) })
        XCTAssertEqual(values["q"], "海边 & 2026")
        XCTAssertEqual(values["kind"], "all")
        XCTAssertEqual(values["offset"], "0")
        XCTAssertEqual(values["limit"], "50")
    }

    func testMediaDecodingIsFailClosedForMissingPrivacy() throws {
        let json = #"{"items":[{"id":"media-1","caption":"受控测试视频","media_kind":"video","duration":12.5,"privacy":"private","segments":[{"start":4.5,"end":7,"text":"测试片段","method":"transcript"}],"preview_url":"https://evil.invalid/leak"}],"total":1}"#
        let page = try BrainJSON.decode(BrainMediaPage.self, from: Data(json.utf8))
        XCTAssertTrue(page.items[0].isVideo)
        XCTAssertEqual(page.items[0].privacy, .private)
        XCTAssertEqual(page.items[0].segments[0].start, 4.5)
        let unknown = try BrainJSON.decode(BrainMediaItem.self, from: Data(#"{"id":"m2"}"#.utf8))
        XCTAssertEqual(unknown.privacy, .unknown)
        XCTAssertThrowsError(try BrainJSON.decode(BrainMediaItem.self, from: Data(#"{"caption":"missing id"}"#.utf8)))
    }

    func testFilteredMediaPageConsumesHiddenPositions() throws {
        let hidden = try BrainJSON.decode(BrainMediaPage.self, from: Data(#"{"items":[],"total":48,"hidden_sensitive":24}"#.utf8))
        XCTAssertEqual(hidden.resumeOffset(after: 0), 24)
        let visible = try BrainJSON.decode(BrainMediaPage.self, from: Data(#"{"items":[{"id":"m","privacy":"private"}],"total":48,"hidden_sensitive":3}"#.utf8))
        XCTAssertEqual(visible.resumeOffset(after: 24), 28)
        let compact = try BrainJSON.decode(BrainMediaPage.self, from: Data(#"{"items":[],"total":60,"next_offset":48}"#.utf8))
        XCTAssertEqual(compact.resumeOffset(after: 24), 48)
    }

    func testMediaScopesNeverBecomeGeneralArchiveScope() {
        XCTAssertTrue(BrainWorkspaceScope.photos.isMedia)
        XCTAssertTrue(BrainWorkspaceScope.videos.isMedia)
        XCTAssertFalse(BrainWorkspaceScope.files.isMedia)
        XCTAssertEqual(BrainWorkspaceScope.photos.mediaKind, "photo")
        XCTAssertEqual(BrainWorkspaceScope.videos.mediaKind, "video")
        XCTAssertEqual(Set(BrainWorkspaceScope.allCases.map(\.title)).count, 5)
    }
}
