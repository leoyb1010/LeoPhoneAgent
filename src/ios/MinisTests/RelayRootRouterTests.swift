import XCTest

/// [fix-remote] 中继多入口：地址迁移、两种前缀解析、入口坏了回落、偏好缓存 10 分钟。
final class RelayRootRouterTests: XCTestCase {
    let cloudflare = "https://relay.example.com/relay/api"
    let funnel = "https://relay-host.example.ts.net/leoagent-relay/relay/api"

    private func router(now: @escaping () -> Date = Date.init,
                        probe: (@Sendable (String) async -> TimeInterval?)? = { _ in nil }) -> RelayRootRouter {
        RelayRootRouter(configured: [cloudflare, funnel], defaults: nil, now: now, probe: probe)
    }

    func testPrefixParsingAcceptsBothRootShapes() {
        XCTAssertEqual(RelayMachinesClient.apiRoot(fromHarnessURL: cloudflare + "/m/LeoMac-Studio"), cloudflare)
        XCTAssertEqual(RelayMachinesClient.apiRoot(fromHarnessURL: funnel + "/m/LeoMac-Studio"), funnel)
        XCTAssertEqual(RelayRootRouter.healthURL(apiRoot: cloudflare)?.absoluteString, "https://relay.example.com/relay/health")
        XCTAssertEqual(RelayRootRouter.healthURL(apiRoot: funnel)?.absoluteString,
                       "https://relay-host.example.ts.net/leoagent-relay/relay/health")
        XCTAssertEqual(LeoRelayConfig.roots(primary: cloudflare, fallback: cloudflare + "/"), [cloudflare])
        XCTAssertEqual(LeoRelayConfig.roots(primary: cloudflare, fallback: funnel), [cloudflare, funnel])
    }

    func testSavedHostURLMigratesFromFunnelToPrimaryOnce() {
        let group = [cloudflare, funnel]
        XCTAssertEqual(RelayRootRouter.migratedHarnessURL(funnel + "/m/LeoMac-Studio", primaryRoot: cloudflare, group: group),
                       cloudflare + "/m/LeoMac-Studio")
        // 已经在主入口、别的中继、直连地址：都不动。
        XCTAssertNil(RelayRootRouter.migratedHarnessURL(cloudflare + "/m/LeoMac-Studio", primaryRoot: cloudflare, group: group))
        XCTAssertNil(RelayRootRouter.migratedHarnessURL("https://other.example/relay/api/m/x", primaryRoot: cloudflare, group: group))
        XCTAssertNil(RelayRootRouter.migratedHarnessURL("https://mac.tail.ts.net:8647", primaryRoot: cloudflare, group: group))
        XCTAssertNil(RelayRootRouter.migratedHarnessURL(funnel + "/m/x", primaryRoot: nil, group: group))
    }

    func testCandidatesStayInsideTheSameRelayGroup() {
        let r = router()
        let url = URL(string: funnel + "/m/Mac/harness/sessions?after=3")!
        XCTAssertEqual(r.candidates(for: url).map(\.absoluteString), [
            cloudflare + "/m/Mac/harness/sessions?after=3",
            funnel + "/m/Mac/harness/sessions?after=3",
        ])
        let foreign = URL(string: "https://other.example/relay/api/m/Mac/health")!
        XCTAssertEqual(r.candidates(for: foreign), [foreign])
    }

    func testDeviceDescriptorRootsJoinOnlyWhenTheyContainTheHostsRoot() throws {
        let r = RelayRootRouter(configured: [], defaults: nil, probe: { _ in nil })
        let device = LeoDeviceDescriptor(
            schemaVersion: 1, deviceId: UUID().uuidString, name: "Mac", platform: "macos", capabilities: [],
            endpoints: [.init(id: "relay", kind: "relay", baseURL: funnel + "/m/Mac", expiresAt: nil),
                        .init(id: "relay-2", kind: "relay", baseURL: cloudflare + "/m/Mac", expiresAt: nil)],
            aliases: nil)
        r.learn(device: device, currentHarnessURL: "https://elsewhere.example/relay/api/m/Mac")
        XCTAssertNil(r.group(for: funnel + "/m/Mac"))
        r.learn(device: device, currentHarnessURL: funnel + "/m/Mac")
        XCTAssertEqual(r.group(for: cloudflare + "/m/Mac/x")?.roots.count, 2)
    }

    func testFailoverToTheOtherRootAndRememberItForTenMinutes() async throws {
        var clock = Date(timeIntervalSince1970: 1_000_000)
        let r = router(now: { clock })
        var attempts: [String] = []
        let request = URLRequest(url: URL(string: cloudflare + "/m/Mac/v1/capabilities")!)
        let (data, _) = try await r.perform(request) { req -> (Data, URLResponse) in
            attempts.append(req.url!.host!)
            if req.url!.host == "relay.example.com" { throw URLError(.timedOut) }
            return (Data("ok".utf8), HTTPURLResponse(url: req.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
        }
        XCTAssertEqual(String(decoding: data, as: UTF8.self), "ok")
        XCTAssertEqual(attempts, ["relay.example.com", "relay-host.example.ts.net"])

        // 记住了：下一次直接走 Funnel。
        attempts.removeAll()
        _ = try await r.perform(request) { req -> (Data, URLResponse) in
            attempts.append(req.url!.host!)
            return (Data(), HTTPURLResponse(url: req.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
        }
        XCTAssertEqual(attempts, ["relay-host.example.ts.net"])

        // 10 分钟后偏好过期（测速都失败时退回配置顺序）。
        clock = clock.addingTimeInterval(RelayRootRouter.cacheLifetime + 1)
        XCTAssertEqual(r.candidates(for: request.url!).first?.host, "relay.example.com")
    }

    func testGatewayErrorsFailOverButMutationsWithoutOperationIdDoNot() async throws {
        let r = router()
        var post = URLRequest(url: URL(string: cloudflare + "/m/Mac/harness/sessions")!)
        post.httpMethod = "POST"
        var attempts = 0
        let (_, response) = try await r.perform(post) { req -> (Data, URLResponse) in
            attempts += 1
            return (Data(), HTTPURLResponse(url: req.url!, statusCode: 530, httpVersion: nil, headerFields: nil)!)
        }
        XCTAssertEqual(attempts, 1, "无操作编号的写请求拿到响应后不重发")
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 530)

        post.setValue("op-1", forHTTPHeaderField: "X-Leo-Request-Id")
        attempts = 0
        let (_, retried) = try await r.perform(post) { req -> (Data, URLResponse) in
            attempts += 1
            let status = req.url!.host == "relay.example.com" ? 502 : 202
            return (Data(), HTTPURLResponse(url: req.url!, statusCode: status, httpVersion: nil, headerFields: nil)!)
        }
        XCTAssertEqual(attempts, 2)
        XCTAssertEqual((retried as? HTTPURLResponse)?.statusCode, 202)

        // 没网不换入口（换哪个都一样）。
        let get = URLRequest(url: URL(string: cloudflare + "/m/Mac/health")!)
        attempts = 0
        do {
            _ = try await router().perform(get) { _ -> (Data, URLResponse) in
                attempts += 1
                throw URLError(.notConnectedToInternet)
            }
            XCTFail("should throw")
        } catch {}
        XCTAssertEqual(attempts, 1)
    }

    func testHealthProbePicksTheFasterRoot() async {
        let r = router(probe: { root in root.contains("relay.example.com") ? 1.5 : 0.4 })
        let key = r.group(for: cloudflare)!.key
        await r.refresh(groupKey: key, roots: [cloudflare, funnel])
        XCTAssertEqual(r.candidates(for: URL(string: cloudflare + "/m/Mac")!).first?.host, "relay-host.example.ts.net")
    }
}
