import XCTest
import Security

/// Ported from upstream DeviceIdentityLockedKeychainTests, but driving the REAL
/// resolution table (`DeviceIdentityResolver`) with an injected Keychain
/// instead of a mirror. After a reboot iOS can relaunch the app before first
/// unlock; the `AfterFirstUnlockThisDeviceOnly` item then reads as
/// errSecInteractionNotAllowed. The old `static let` minted and wrote a new id
/// there, overwriting the real identity and pointing sync at a new zone.
final class DeviceIdentityLockedKeychainTests: XCTestCase {
    private final class FakeKeychain {
        var stored: String?
        var status: OSStatus = errSecSuccess
        var writeSucceeds = true
        private(set) var writes: [String] = []
        func read() -> DeviceIdentityResolver.KeychainRead {
            switch status {
            case errSecSuccess: return stored.map { .found($0) } ?? .absent
            case errSecItemNotFound: return .absent
            default: return .unreadable(status)
            }
        }
        func write(_ v: String) -> Bool {
            guard writeSucceeds else { return false }
            writes.append(v); stored = v; status = errSecSuccess
            return true
        }
    }

    private var defaults: UserDefaults!
    private var suite: String!
    private var mintCount = 0

    override func setUp() {
        suite = "DeviceIdentityTests.\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suite)
        mintCount = 0
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suite)
    }

    private func resolver(_ kc: FakeKeychain) -> DeviceIdentityResolver {
        DeviceIdentityResolver(read: kc.read, write: kc.write, defaults: defaults,
                               mint: { [unowned self] in mintCount += 1; return "minted-\(mintCount)" })
    }

    func testLockedKeychainNeitherRotatesNorPersists() {
        let kc = FakeKeychain(); kc.stored = "REAL"; kc.status = errSecInteractionNotAllowed
        let r = resolver(kc)
        let id = r.deviceId
        XCTAssertTrue(id.hasPrefix("provisional-"))
        XCTAssertTrue(DeviceIdentity.isProvisional(id))
        XCTAssertTrue(kc.writes.isEmpty, "a locked read must never write")
        XCTAssertEqual(kc.stored, "REAL")
        XCTAssertTrue(r.isProvisional)
        XCTAssertEqual(r.deviceId, id, "repeated locked reads agree within the process")
    }

    func testIdentityRecoversAfterUnlockWithoutWriting() {
        let kc = FakeKeychain(); kc.stored = "REAL"; kc.status = errSecInteractionNotAllowed
        let r = resolver(kc)
        XCTAssertTrue(r.isProvisional)
        kc.status = errSecSuccess
        XCTAssertEqual(r.deviceId, "REAL")
        XCTAssertFalse(r.isProvisional)
        XCTAssertTrue(kc.writes.isEmpty)
        XCTAssertNil(r.takeRetiredDeviceId(), "reading the real id retires nothing")
    }

    func testOtherFailureStatusesAreUnreadableNotAbsent() {
        for status in [errSecNotAvailable, errSecAuthFailed, OSStatus(-99999)] {
            let kc = FakeKeychain(); kc.stored = "REAL"; kc.status = status
            let r = resolver(kc)
            _ = r.deviceId
            XCTAssertTrue(kc.writes.isEmpty, "status \(status) must not write")
            XCTAssertTrue(r.isProvisional)
        }
    }

    func testGenuinelyAbsentMintsPersistsAndMemoizes() {
        let kc = FakeKeychain(); kc.status = errSecItemNotFound
        let r = resolver(kc)
        XCTAssertEqual(r.deviceId, "minted-1")
        XCTAssertEqual(r.deviceId, "minted-1")
        XCTAssertEqual(kc.writes, ["minted-1"])
        XCTAssertFalse(r.isProvisional)
    }

    func testBlankStoredValueRegenerates() {
        for blank in ["", "   ", " \n ", "\t"] {
            let kc = FakeKeychain(); kc.stored = blank
            let r = resolver(kc)
            let id = r.deviceId
            XCTAssertTrue(id.hasPrefix("minted-"), "blank \(blank.debugDescription) must regenerate")
            XCTAssertEqual(kc.writes.count, 1)
        }
    }

    func testFailedPersistStaysProvisionalSoNothingIsWrittenUnderIt() {
        let kc = FakeKeychain(); kc.status = errSecItemNotFound; kc.writeSucceeds = false
        let r = resolver(kc)
        XCTAssertTrue(r.deviceId.hasPrefix("provisional-"),
                      "an id that will not survive relaunch must not tag sync data")
        XCTAssertTrue(r.isProvisional)
        XCTAssertNil(defaults.string(forKey: DeviceIdentityResolver.previousIdKey))
        kc.writeSucceeds = true
        XCTAssertTrue(r.deviceId.hasPrefix("minted-"))
        XCTAssertFalse(r.isProvisional)
    }

    func testReMintQueuesPreviousIdForRetirementOnce() {
        defaults.set("OLD-ID", forKey: DeviceIdentityResolver.previousIdKey)
        let kc = FakeKeychain(); kc.status = errSecItemNotFound
        let r = resolver(kc)
        XCTAssertEqual(r.deviceId, "minted-1")
        XCTAssertEqual(r.takeRetiredDeviceId(), "OLD-ID")
        XCTAssertNil(r.takeRetiredDeviceId(), "consumed once")
        XCTAssertEqual(defaults.string(forKey: DeviceIdentityResolver.previousIdKey), "minted-1")
    }

    func testProvisionalPreviousIdIsNeverRetired() {
        defaults.set("provisional-ABC", forKey: DeviceIdentityResolver.previousIdKey)
        let kc = FakeKeychain(); kc.status = errSecItemNotFound
        let r = resolver(kc)
        _ = r.deviceId
        XCTAssertNil(r.takeRetiredDeviceId())
    }
}
