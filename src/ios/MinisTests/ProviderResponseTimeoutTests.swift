import XCTest

/// [F1] 每服务商响应超时(`ProviderResponseTimeout.swift`):默认不变、夹紧、按实例存取。
final class ProviderResponseTimeoutTests: XCTestCase {
    private func defaults() -> UserDefaults { UserDefaults(suiteName: "F1Timeout-\(UUID().uuidString)")! }

    func testDefaultsUnchangedWhenUnset() {
        let d = defaults()
        XCTAssertNil(ProviderResponseTimeout.stored(instanceId: "a", defaults: d))
        XCTAssertEqual(ProviderResponseTimeout.stallSeconds(instanceId: "a", defaults: d), 120)
        XCTAssertEqual(ProviderResponseTimeout.requestSeconds(instanceId: "a", defaults: d), 600)
        XCTAssertEqual(ProviderResponseTimeout.stallSeconds(instanceId: nil, defaults: d), 120)
    }

    func testSetValueAppliesToStallAndRequestForThatInstanceOnly() {
        let d = defaults()
        ProviderResponseTimeout.set(300, instanceId: "a", defaults: d)
        XCTAssertEqual(ProviderResponseTimeout.stallSeconds(instanceId: "a", defaults: d), 300)
        XCTAssertEqual(ProviderResponseTimeout.requestSeconds(instanceId: "a", defaults: d), 300)
        XCTAssertEqual(ProviderResponseTimeout.stallSeconds(instanceId: "b", defaults: d), 120)
        ProviderResponseTimeout.set(nil, instanceId: "a", defaults: d)
        XCTAssertEqual(ProviderResponseTimeout.stallSeconds(instanceId: "a", defaults: d), 120)
    }

    func testValuesAreClampedAndParsed() {
        let d = defaults()
        ProviderResponseTimeout.set(5, instanceId: "a", defaults: d)
        XCTAssertEqual(ProviderResponseTimeout.stored(instanceId: "a", defaults: d), 30)
        ProviderResponseTimeout.set(Int.max, instanceId: "a", defaults: d)
        XCTAssertEqual(ProviderResponseTimeout.stored(instanceId: "a", defaults: d), 600)
        d.set(99_999, forKey: ProviderResponseTimeout.key(instanceId: "c"))  // 旧值/手改值也夹紧
        XCTAssertEqual(ProviderResponseTimeout.stallSeconds(instanceId: "c", defaults: d), 600)
        XCTAssertEqual(ProviderResponseTimeout.parse(" 90 "), 90)
        XCTAssertNil(ProviderResponseTimeout.parse(""))
        XCTAssertNil(ProviderResponseTimeout.parse("0"))
        XCTAssertNil(ProviderResponseTimeout.parse("abc"))
        XCTAssertNil(ProviderResponseTimeout.parse("-5"))
        XCTAssertEqual(ProviderResponseTimeout.parse("100000"), 600)
    }
}
