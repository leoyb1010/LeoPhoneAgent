import XCTest

final class RelayMachinesClientTests: XCTestCase {
    func testParseListsAndroidWithoutRepoString() throws {
        let data = """
        {"machines":[
          {"name":"fixture-mac-mini","online":true,"server":"leocodebox"},
          {"name":"LeoFold8","online":true,"platform":"android","server":"minis","version":"1.0.0-alpha.6"}
        ]}
        """.data(using: .utf8)!
        let rows = try RelayMachinesClient.parse(data)
        XCTAssertEqual(rows.count, 2)
        XCTAssertFalse(rows[0].isAndroidBody)
        XCTAssertTrue(rows[1].isAndroidBody)
        XCTAssertEqual(RelayMachinesClient.harnessURL(for: "LeoFold8", apiRoot: "https://relay.example/api/"),
                       "https://relay.example/api/m/LeoFold8")
        XCTAssertEqual(RelayMachinesClient.displayName(for: "fixture-mac-mini", fleet: Self.fleet), "Mac mini")
        XCTAssertEqual(RelayMachinesClient.displayName(for: "unlisted-box", fleet: Self.fleet), "unlisted-box")
    }

    static let fleet = LeoRelayConfig.parseFleet("MacBook Pro=fixture-macbook-pro;Mac mini=fixture-mac-mini")

    /// 中继地址与机器名不进源码：未注入或占位未展开时视为未配置，界面不发请求。
    func testRelayConfigRejectsMissingPlaceholderAndInsecureValues() {
        XCTAssertNil(LeoRelayConfig.normalizedApiRoot(""))
        XCTAssertNil(LeoRelayConfig.normalizedApiRoot("$(LEO_RELAY_API_ROOT)"))
        XCTAssertNil(LeoRelayConfig.normalizedApiRoot("http://relay.example/api"))
        XCTAssertNil(LeoRelayConfig.normalizedApiRoot("https://"))
        XCTAssertEqual(LeoRelayConfig.normalizedApiRoot(" https://relay.example/api/ "), "https://relay.example/api")
        XCTAssertEqual(Self.fleet, [.init(name: "MacBook Pro", machine: "fixture-macbook-pro"),
                                    .init(name: "Mac mini", machine: "fixture-mac-mini")])
        XCTAssertEqual(LeoRelayConfig.parseFleet("坏=../etc;=empty;没有等号;好 = ok-box ;"), [.init(name: "好", machine: "ok-box")])
        XCTAssertTrue(LeoRelayConfig.parseFleet("$(LEO_RELAY_FLEET)").isEmpty)
        // 逻辑测试包没有注入构建配置：必须是"未配置"，而不是回落到任何写死的主机。
        XCTAssertNil(LeoRelayConfig.apiRoot)
        XCTAssertTrue(LeoRelayConfig.fleet.isEmpty)
        XCTAssertNil(LeoRelayConfig.sshTarget)
    }

    func testParseReadsNestedInfoPlatformForAndroidBody() throws {
        let data = """
        {"machines":[
          {"name":"LeoFold8","online":true,"info":{"platform":"android","server":"minis","version":"1.0.0-alpha.7"}}
        ]}
        """.data(using: .utf8)!
        let rows = try RelayMachinesClient.parse(data)
        XCTAssertEqual(rows.count, 1)
        XCTAssertTrue(rows[0].isAndroidBody)
        XCTAssertEqual(rows[0].platform, "android")
        XCTAssertEqual(rows[0].server, "minis")
        XCTAssertEqual(rows[0].version, "1.0.0-alpha.7")
    }

    func testHostMatchPrefersMachineIdOverDisplayName() {
        let ids = ["fixture-macbook-pro", "fixture-mac-mini"]
        let names = ["MacBook Pro", "Mac mini"]
        XCTAssertEqual(
            RelayMachinesClient.pickHostIndex(
                hostIds: ids, displayNames: names, hostId: "", machine: "fixture-macbook-pro", fleet: Self.fleet),
            0
        )
        XCTAssertEqual(
            RelayMachinesClient.pickHostIndex(
                hostIds: ids, displayNames: names, hostId: "", machine: "fixture-mac-mini", fleet: Self.fleet),
            1
        )
        XCTAssertNil(
            RelayMachinesClient.pickHostIndex(
                hostIds: ids, displayNames: names, hostId: "", machine: "unknown-box", fleet: Self.fleet)
        )
    }

    /// [T-relay-key-fallback] 同一个中继根下的多把不同密钥都要保留,
    /// 否则 hosts[0] 的密钥一过期,整条发现链 401 到底且没有回退。
    func testCredentialsKeepEveryDistinctKeyPerRelayRoot() {
        let rows = [
            RelayCredentialCandidate(
                harnessURL: "https://a.example/relay/api/m/mac", key: "stale-key-0123456789"),
            RelayCredentialCandidate(
                harnessURL: "https://a.example/relay/api/m/fold", key: "fresh-key-0123456789"),
            // 完全相同的一把不重复返回。
            RelayCredentialCandidate(
                harnessURL: "https://a.example/relay/api/m/other", key: "stale-key-0123456789"),
        ]
        let creds = RelayMachinesClient.credentials(from: rows)
        XCTAssertEqual(creds.map(\.key), ["stale-key-0123456789", "fresh-key-0123456789"])
        // 单条查询仍取第一条匹配,行为不变。
        XCTAssertEqual(
            RelayMachinesClient.credential(matching: "https://a.example/relay/api", from: rows)?.key,
            "stale-key-0123456789")
    }

    func testParseSkipsNamelessRows() throws {
        let data = #"{"machines":[{"online":true},{"name":"ok","online":false}]}"#.data(using: .utf8)!
        let rows = try RelayMachinesClient.parse(data)
        XCTAssertEqual(rows.map(\.name), ["ok"])
        XCTAssertFalse(rows[0].online)
    }

    func testPairPayloadRoundTripOmitsKey() throws {
        let payload = RelayPairPayload(
            apiRoot: "https://relay-host.example.ts.net/leoagent-relay/relay/api/",
            machine: "LeoFold8",
            join: nil,
            exp: nil)
        let encoded = payload.encode()
        XCTAssertTrue(encoded.hasPrefix(RelayPairPayload.prefix))
        let jsonText = String(encoded.dropFirst(RelayPairPayload.prefix.count))
        let data = try XCTUnwrap(jsonText.data(using: .utf8))
        let obj = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(Set(obj.keys), ["apiRoot", "machine"])
        XCTAssertNil(obj["key"])
        XCTAssertNil(obj["apiKey"])
        XCTAssertNil(obj["token"])
        let parsed = RelayPairPayload.parse(encoded)
        XCTAssertEqual(parsed?.machine, "LeoFold8")
        XCTAssertEqual(parsed?.apiRoot, "https://relay-host.example.ts.net/leoagent-relay/relay/api")
        XCTAssertTrue(parsed?.harnessURL.contains("/m/LeoFold8") == true)
        XCTAssertNil(RelayPairPayload.parse("leoagent-body:v1|{\"apiRoot\":\"http://x\",\"machine\":\"y\"}"))
        XCTAssertNil(RelayPairPayload.parse("leoagent-body:v1|{\"apiRoot\":\"https://ok\",\"machine\":\"../etc\"}"))
        XCTAssertNil(RelayPairPayload.parse("leoagent-body:v1|{\"apiRoot\":\"https://ok\",\"machine\":\"a/b\"}"))
        let v2 = RelayPairPayload(
            apiRoot: "https://relay-host.example.ts.net/leoagent-relay/relay/api",
            machine: "LeoFold8",
            join: "join-short",
            exp: 1_800_000_000
        ).encode()
        XCTAssertTrue(v2.hasPrefix(RelayPairPayload.prefixV2))
        XCTAssertFalse(v2.contains("key"))
        let parsedV2 = RelayPairPayload.parse(v2)
        XCTAssertEqual(parsedV2?.join, "join-short")
        XCTAssertEqual(parsedV2?.machine, "LeoFold8")
    }

    func testApiRootPinningAndMachineSanitize() {
        XCTAssertTrue(RelayMachinesClient.sameApiRoot(
            "https://relay-host.example.ts.net/leoagent-relay/relay/api/",
            "https://relay-host.example.ts.net/leoagent-relay/relay/api"))
        XCTAssertFalse(RelayMachinesClient.sameApiRoot(
            "https://relay-host.example.ts.net/leoagent-relay/relay/api",
            "https://attacker.example/relay/api"))
        XCTAssertEqual(
            RelayMachinesClient.apiRoot(fromHarnessURL: "https://relay-host.example.ts.net/leoagent-relay/relay/api/m/LeoFold8"),
            "https://relay-host.example.ts.net/leoagent-relay/relay/api")
        XCTAssertEqual(RelayMachinesClient.sanitizeMachine("LeoFold8"), "LeoFold8")
        XCTAssertNil(RelayMachinesClient.sanitizeMachine("foo/bar"))
    }

    func testCredentialAlwaysBindsKeyToTheSameRelayRoot() {
        let rows = [
            RelayCredentialCandidate(
                harnessURL: "https://a.example/relay/api/m/mac",
                key: "a-key-0123456789"
            ),
            RelayCredentialCandidate(
                harnessURL: "https://b.example/relay/api/m/body",
                key: "b-key-0123456789"
            ),
        ]
        XCTAssertEqual(
            RelayMachinesClient.credential(matching: "https://b.example/relay/api/", from: rows),
            RelayCredential(apiRoot: "https://b.example/relay/api", key: "b-key-0123456789")
        )
        XCTAssertNil(RelayMachinesClient.credential(
            matching: "https://c.example/relay/api",
            from: rows
        ))
    }
}
