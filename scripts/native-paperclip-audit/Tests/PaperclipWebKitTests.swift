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


/// 可控异步存储验证真实 WebKit await 边界的写入/清除次序，不依赖计时器碰运气。
@MainActor
private final class PausingCookieStorage: PaperclipCookieStorage {
    var cookies: [HTTPCookie] = []
    var writes = 0
    var pauseWrites = false
    var pauseClear = false
    private var writeStarted = false
    private var clearStarted = false
    private var writeWaiter: CheckedContinuation<Void, Never>?
    private var clearWaiter: CheckedContinuation<Void, Never>?
    private var writeGate: CheckedContinuation<Void, Never>?
    private var clearGate: CheckedContinuation<Void, Never>?
    func allCookies() async -> [HTTPCookie] { cookies }
    func setCookie(_ cookie: HTTPCookie) async {
        writeStarted = true
        writeWaiter?.resume(); writeWaiter = nil
        if pauseWrites { await withCheckedContinuation { writeGate = $0 } }
        writes += 1
        cookies.append(cookie)
    }
    func removeAllData() async {
        clearStarted = true
        clearWaiter?.resume(); clearWaiter = nil
        if pauseClear { await withCheckedContinuation { clearGate = $0 } }
        cookies = []
    }
    func waitForWrite() async {
        if !writeStarted { await withCheckedContinuation { writeWaiter = $0 } }
    }
    func waitForClear() async {
        if !clearStarted { await withCheckedContinuation { clearWaiter = $0 } }
    }
    func releaseWrite() { writeGate?.resume(); writeGate = nil }
    func releaseClear() { clearGate?.resume(); clearGate = nil }
}

extension PaperclipWebKitTests {
    func testRecreatedWorkspaceUsesSameCookieRevocationGeneration() async throws {
        let profile = try PaperclipProfile(name: "测试", address: "https://example.com")
        let before = PaperclipCookieVault.shared(for: profile)
        let generation = before.generation
        let after = PaperclipCookieVault.shared(for: profile)
        XCTAssertTrue(before === after)
        await after.clear()
        XCTAssertNotEqual(before.generation, generation)
        let oldCookies = await before.read(generation: generation)
        XCTAssertTrue(oldCookies.isEmpty)
    }

    func testClearWaitsForInFlightCookieWriteAndRejectsLateGeneration() async throws {
        let storage = PausingCookieStorage()
        storage.pauseWrites = true
        let vault = PaperclipCookieVault(storage: storage)
        let oldGeneration = vault.generation
        let cookie = try XCTUnwrap(HTTPCookie(properties: [.domain: "example.com", .path: "/", .name: "session", .value: "fixture", .secure: "TRUE"]))
        let write = Task { await vault.write([cookie, cookie], generation: oldGeneration) }
        await storage.waitForWrite()
        let clear = Task { await vault.clear() }
        while vault.generation == oldGeneration { await Task.yield() }
        let staleWrite = Task { await vault.write([cookie], generation: oldGeneration) }
        storage.releaseWrite()
        await write.value
        await clear.value
        await staleWrite.value
        XCTAssertEqual(storage.writes, 1)
        XCTAssertTrue(storage.cookies.isEmpty)
        let oldRead = await vault.read(generation: oldGeneration)
        let newRead = await vault.read(generation: vault.generation)
        XCTAssertTrue(oldRead.isEmpty)
        XCTAssertTrue(newRead.isEmpty)
    }

    func testOldProfileClearCannotReleaseNewProfileBusyState() async throws {
        let suite = "paperclip.clear-test.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let a = PausingCookieStorage(); a.pauseClear = true
        let b = PausingCookieStorage(); b.pauseClear = true
        let store = PaperclipWorkspaceStore(defaults: defaults, makeCookieVault: { profile in
            PaperclipCookieVault(storage: profile.name == "甲" ? a : b)
        })
        try store.add(name: "甲", address: "https://a.example")
        let first = Task { await store.clearLogin() }
        await a.waitForClear()
        try store.add(name: "乙", address: "https://b.example")
        let second = Task { await store.clearLogin() }
        await b.waitForClear()
        XCTAssertTrue(store.busy)
        a.releaseClear()
        await first.value
        XCTAssertEqual(store.selectedProfile?.name, "乙")
        XCTAssertTrue(store.busy)
        b.releaseClear()
        await second.value
        XCTAssertFalse(store.busy)
    }
}
