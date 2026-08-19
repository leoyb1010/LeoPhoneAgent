import XCTest

final class RelayMachinesClientTests: XCTestCase {
    func testParseListsAndroidWithoutRepoString() throws {
        let data = """
        {"machines":[
          {"name":"LeodeMac-mini-2","online":true,"server":"leocodebox"},
          {"name":"LeoFold8","online":true,"platform":"android","server":"minis","version":"1.0.0-alpha.6"}
        ]}
        """.data(using: .utf8)!
        let rows = try RelayMachinesClient.parse(data)
        XCTAssertEqual(rows.count, 2)
        XCTAssertFalse(rows[0].isAndroidBody)
        XCTAssertTrue(rows[1].isAndroidBody)
        XCTAssertTrue(RelayMachinesClient.harnessURL(for: "LeoFold8").contains("/m/LeoFold8"))
        XCTAssertEqual(RelayMachinesClient.displayName(for: "LeodeMac-mini-2"), "Mac mini · cortex")
    }

    func testParseSkipsNamelessRows() throws {
        let data = #"{"machines":[{"online":true},{"name":"ok","online":false}]}"#.data(using: .utf8)!
        let rows = try RelayMachinesClient.parse(data)
        XCTAssertEqual(rows.map(\.name), ["ok"])
        XCTAssertFalse(rows[0].online)
    }

    func testPairPayloadRoundTripOmitsKey() {
        let payload = RelayPairPayload(
            apiRoot: "https://mac-mini-cortex.tail23de22.ts.net/leoagent-relay/relay/api/",
            machine: "LeoFold8")
        let encoded = payload.encode()
        XCTAssertTrue(encoded.hasPrefix(RelayPairPayload.prefix))
        XCTAssertFalse(encoded.contains("key"))
        let parsed = RelayPairPayload.parse(encoded)
        XCTAssertEqual(parsed?.machine, "LeoFold8")
        XCTAssertEqual(parsed?.apiRoot, "https://mac-mini-cortex.tail23de22.ts.net/leoagent-relay/relay/api")
        XCTAssertTrue(parsed?.harnessURL.contains("/m/LeoFold8") == true)
        XCTAssertNil(RelayPairPayload.parse("leoagent-body:v1|{\"apiRoot\":\"http://x\",\"machine\":\"y\"}"))
        XCTAssertNil(RelayPairPayload.parse("leoagent-body:v1|{\"apiRoot\":\"https://ok\",\"machine\":\"../etc\"}"))
        XCTAssertNil(RelayPairPayload.parse("leoagent-body:v1|{\"apiRoot\":\"https://ok\",\"machine\":\"a/b\"}"))
    }

    func testApiRootPinningAndMachineSanitize() {
        XCTAssertTrue(RelayMachinesClient.sameApiRoot(
            "https://mac-mini-cortex.tail23de22.ts.net/leoagent-relay/relay/api/",
            "https://mac-mini-cortex.tail23de22.ts.net/leoagent-relay/relay/api"))
        XCTAssertFalse(RelayMachinesClient.sameApiRoot(
            "https://mac-mini-cortex.tail23de22.ts.net/leoagent-relay/relay/api",
            "https://attacker.example/relay/api"))
        XCTAssertEqual(
            RelayMachinesClient.apiRoot(fromHarnessURL: "https://mac-mini-cortex.tail23de22.ts.net/leoagent-relay/relay/api/m/LeoFold8"),
            "https://mac-mini-cortex.tail23de22.ts.net/leoagent-relay/relay/api")
        XCTAssertEqual(RelayMachinesClient.sanitizeMachine("LeoFold8"), "LeoFold8")
        XCTAssertNil(RelayMachinesClient.sanitizeMachine("foo/bar"))
    }
}
