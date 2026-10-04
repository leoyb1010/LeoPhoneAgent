import Foundation
import WebKit
import XCTest

@MainActor
final class PaperclipWebKitTests: XCTestCase {
    func testWebsiteDataStoresAreIsolatedForSameOriginProfiles() async throws {
        let first = try PaperclipProfile(name: "甲", address: "https://example.com")
        let second = try PaperclipProfile(name: "乙", address: "https://example.com")
        let a = PaperclipWorkspaceStore.websiteData(for: first)
        let b = PaperclipWorkspaceStore.websiteData(for: second)
        let cookie = try XCTUnwrap(HTTPCookie(properties: [.domain: "example.com", .path: "/", .name: "paperclip-fixture.session_token", .value: "fixture-only", .secure: "TRUE"]))
        await a.httpCookieStore.setCookie(cookie)
        let cookiesA = await a.httpCookieStore.allCookies()
        let cookiesB = await b.httpCookieStore.allCookies()
        XCTAssertTrue(cookiesA.contains { $0.name == cookie.name })
        XCTAssertFalse(cookiesB.contains { $0.name == cookie.name })
        await a.removeData(ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(), modifiedSince: .distantPast)
        await b.removeData(ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(), modifiedSince: .distantPast)
    }
    func testProfilePersistenceNeverStoresCredentialsAndSelectionResetsIdentity() throws {
        let suite = "paperclip.web-test.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let store = PaperclipWorkspaceStore(defaults: defaults)
        try store.add(name: "甲", address: "https://a.example")
        try store.add(name: "乙", address: "https://b.example")
        let reopened = PaperclipWorkspaceStore(defaults: defaults)
        XCTAssertEqual(reopened.profiles.count, 2)
        XCTAssertEqual(reopened.selectedProfile?.origin.host, "b.example")
        reopened.select(reopened.profiles[0].id)
        XCTAssertNil(reopened.user)
        XCTAssertNil(reopened.client)
        XCTAssertEqual(reopened.companyID, "")
        let blob = try XCTUnwrap(defaults.data(forKey: "leo.paperclip.profiles.v1"))
        let raw = String(decoding: blob, as: UTF8.self)
        XCTAssertFalse(raw.contains("token"))
        XCTAssertFalse(raw.contains("password"))
        XCTAssertFalse(raw.contains("Cookie"))
    }
}
