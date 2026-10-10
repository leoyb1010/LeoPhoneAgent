import XCTest

/// [F1] 服务商余额:只认官方主机、解析、低余额、缓存新鲜度(`ProviderBalance.swift`)。
final class ProviderBalanceTests: XCTestCase {
    private func ep(_ kind: ProviderBalanceRules.Kind, _ base: String?) -> ProviderBalanceEndpoint? {
        ProviderBalanceRules.endpoint(kind: kind, baseURL: base)
    }

    func testEndpointsOnlyOnTheConfiguredOfficialHost() {
        XCTAssertEqual(ep(.openAICompatible, "https://api.deepseek.com/v1")?.url.absoluteString,
                       "https://api.deepseek.com/user/balance")
        XCTAssertEqual(ep(.openAICompatible, "https://api.moonshot.cn/v1")?.url.absoluteString,
                       "https://api.moonshot.cn/v1/users/me/balance")
        XCTAssertEqual(ep(.openAICompatible, "https://api.moonshot.ai/v1")?.currency, "USD")
        XCTAssertEqual(ep(.openAICompatible, "https://api.siliconflow.cn/v1")?.url.absoluteString,
                       "https://api.siliconflow.cn/v1/user/info")
        XCTAssertEqual(ep(.openAICompatible, "https://API.SiliconFlow.com")?.currency, "USD")
        XCTAssertEqual(ep(.openRouter, nil)?.url.absoluteString, "https://openrouter.ai/api/v1/key")
        XCTAssertEqual(ep(.openRouter, "https://openrouter.ai/api/v1")?.service, .openRouter)
    }

    func testNoEndpointForRelaysHttpOrOtherProviders() {
        XCTAssertNil(ep(.openAICompatible, nil))
        XCTAssertNil(ep(.openAICompatible, "http://api.deepseek.com"))
        XCTAssertNil(ep(.openAICompatible, "https://deepseek.my-relay.com/v1"))
        XCTAssertNil(ep(.openAICompatible, "https://api.deepseek.com.evil.io"))
        XCTAssertNil(ep(.openRouter, "https://my-proxy.example/api"))
        XCTAssertNil(ep(.other, "https://api.deepseek.com"))
    }

    func testParseEachServiceFromDocumentedShapes() throws {
        let now = Date(timeIntervalSince1970: 1_000)
        let ds = try XCTUnwrap(ep(.openAICompatible, "https://api.deepseek.com"))
        let dsData = Data(#"{"is_available":true,"balance_infos":[{"currency":"USD","total_balance":"3.50"},{"currency":"CNY","total_balance":"110.00","granted_balance":"10.00","topped_up_balance":"100.00"}]}"#.utf8)
        XCTAssertEqual(ProviderBalanceRules.parse(ds, data: dsData, now: now),
                       ProviderBalance(amount: 110, currency: "CNY", fetchedAt: now))

        let or = try XCTUnwrap(ep(.openRouter, nil))
        XCTAssertEqual(ProviderBalanceRules.parse(or, data: Data(#"{"data":{"limit_remaining":4.25,"usage":1}}"#.utf8), now: now)?.amount, 4.25)
        XCTAssertNil(ProviderBalanceRules.parse(or, data: Data(#"{"data":{"limit_remaining":null}}"#.utf8)))

        let ms = try XCTUnwrap(ep(.openAICompatible, "https://api.moonshot.cn/v1"))
        XCTAssertEqual(ProviderBalanceRules.parse(ms, data: Data(#"{"code":0,"data":{"available_balance":49.58894,"voucher_balance":46.58893,"cash_balance":3.00001},"scode":"0x0","status":true}"#.utf8))?.amount ?? 0, 49.58894, accuracy: 1e-9)

        let sf = try XCTUnwrap(ep(.openAICompatible, "https://api.siliconflow.cn/v1"))
        let sfBalance = ProviderBalanceRules.parse(sf, data: Data(#"{"code":20000,"message":"OK","status":true,"data":{"balance":"0.88","chargeBalance":"88.00","totalBalance":"88.88"}}"#.utf8))
        XCTAssertEqual(sfBalance?.amount, 88.88)
        XCTAssertEqual(sfBalance?.currency, "CNY")
    }

    func testParseFailsSilentlyOnGarbage() throws {
        let ds = try XCTUnwrap(ep(.openAICompatible, "https://api.deepseek.com"))
        XCTAssertNil(ProviderBalanceRules.parse(ds, data: Data("<html>".utf8)))
        XCTAssertNil(ProviderBalanceRules.parse(ds, data: Data(#"{"balance_infos":[]}"#.utf8)))
        XCTAssertNil(ProviderBalanceRules.parse(ds, data: Data(#"{"balance_infos":[{"total_balance":true}]}"#.utf8)))
        XCTAssertNil(ProviderBalanceRules.parse(ds, data: Data(#"{"balance_infos":[{"total_balance":"1e300"}]}"#.utf8)))
        XCTAssertNil(ProviderBalanceRules.parse(ds, data: Data(count: ProviderBalanceRules.maxResponseBytes + 1)))
    }

    func testTTLAtLeastTenMinutes() {
        let now = Date()
        XCTAssertGreaterThanOrEqual(ProviderBalanceRules.ttl, 600)
        XCTAssertFalse(ProviderBalanceRules.isFresh(fetchedAt: nil, now: now))
        XCTAssertTrue(ProviderBalanceRules.isFresh(fetchedAt: now.addingTimeInterval(-599), now: now))
        XCTAssertFalse(ProviderBalanceRules.isFresh(fetchedAt: now.addingTimeInterval(-ProviderBalanceRules.ttl), now: now))
        XCTAssertFalse(ProviderBalanceRules.isFresh(fetchedAt: now.addingTimeInterval(3_600), now: now))  // 时钟回拨
    }

    func testLowThresholdPerCurrencyConfigurable() {
        let defaults = UserDefaults(suiteName: "F1Balance-\(UUID().uuidString)")!
        XCTAssertEqual(ProviderBalanceRules.threshold(currency: "CNY", defaults: defaults), 10)
        XCTAssertEqual(ProviderBalanceRules.threshold(currency: "USD", defaults: defaults), 2)
        ProviderBalanceRules.setThreshold(50, currency: "cny", defaults: defaults)
        XCTAssertEqual(ProviderBalanceRules.threshold(currency: "CNY", defaults: defaults), 50)
        ProviderBalanceRules.setThreshold(-1, currency: "CNY", defaults: defaults)
        XCTAssertEqual(ProviderBalanceRules.threshold(currency: "CNY", defaults: defaults), 10)
        let b = ProviderBalance(amount: 9.99, currency: "CNY", fetchedAt: Date())
        XCTAssertTrue(ProviderBalanceRules.isLow(b, threshold: 10))
        XCTAssertFalse(ProviderBalanceRules.isLow(b, threshold: 5))
        XCTAssertEqual(ProviderBalanceRules.display(b), "¥9.99")
        XCTAssertEqual(ProviderBalanceRules.display(ProviderBalance(amount: 1.5, currency: "USD", fetchedAt: Date())), "$1.50")
    }
}
