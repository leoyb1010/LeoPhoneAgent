import XCTest

/// WP-44:手表 Mac 状态 / 复杂功能快照 / 审批口径,以及分享扩展「发给 Mac 当前任务」。
final class WP44WatchAndShareTests: XCTestCase {
    private var iosRoot: URL {
        URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
    }

    // MARK: Mac status

    func testSummaryPutsWaitingFirstAndCapsRows() {
        let items = (0..<8).map { i in
            (id: "s\(i)", title: "Mac · task \(i)", status: i == 6 ? "等你审批" : "运行中", waiting: i == 6, running: i % 2 == 0)
        }
        let status = WatchMacStatus.summarize(items, now: Date(timeIntervalSince1970: 100))
        XCTAssertEqual(status.waiting, 1)
        XCTAssertEqual(status.running, 4)
        XCTAssertEqual(status.rows.count, WatchMacStatus.maxRows)
        XCTAssertEqual(status.rows.first?.id, "s6", "waiting first")
    }

    func testContextRoundTripAndSignature() throws {
        let status = WatchMacStatus.summarize([(id: "a", title: "t", status: "运行中", waiting: false, running: true)],
                                              now: Date(timeIntervalSince1970: 1_800_000_000))
        let encoded = try XCTUnwrap(status.encodedForContext())
        XCTAssertEqual(WatchMacStatus.decode(fromContext: encoded), status)
        XCTAssertNil(WatchMacStatus.decode(fromContext: 42))
        var later = status; later.updatedAt = .now
        XCTAssertEqual(later.signature, status.signature, "time alone must not burn the context push budget")
    }

    func testApprovalTonesAndTimeout() {
        XCTAssertEqual(WatchApprovalPolicy.tone(forRisk: "high"), .destructive)
        XCTAssertEqual(WatchApprovalPolicy.tone(forRisk: "medium"), .attention)
        XCTAssertEqual(WatchApprovalPolicy.tone(forRisk: "low"), .readOnly)
        let shown = Date(timeIntervalSince1970: 0)
        XCTAssertFalse(WatchApprovalPolicy.hasTimedOut(shownAt: shown, now: shown.addingTimeInterval(59)))
        XCTAssertTrue(WatchApprovalPolicy.hasTimedOut(shownAt: shown, now: shown.addingTimeInterval(60)))
    }

    func testWidgetSnapshotRelevanceAndChangeDetection() throws {
        XCTAssertGreaterThan(WatchWidgetSnapshot(macRunning: 0, macWaiting: 1, lastQuestion: "", lastAnswer: "", updatedAt: .now).relevanceScore,
                             WatchWidgetSnapshot(macRunning: 3, macWaiting: 0, lastQuestion: "", lastAnswer: "", updatedAt: .now).relevanceScore)
        let suite = "wp44-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let snap = WatchWidgetSnapshot(macRunning: 1, macWaiting: 0, lastQuestion: "q", lastAnswer: "a", updatedAt: Date(timeIntervalSince1970: 1))
        XCTAssertTrue(snap.save(to: defaults))
        var same = snap; same.updatedAt = Date(timeIntervalSince1970: 99)
        XCTAssertFalse(same.save(to: defaults), "no timeline reload when nothing visible changed")
        XCTAssertEqual(WatchWidgetSnapshot.load(from: defaults), snap)
    }

    // MARK: Share → Mac

    private func target(directExpiresIn: TimeInterval?) -> ShareMacTarget {
        ShareMacTarget(sessionId: "abc", title: "MacBook · Claude", hostName: "MacBook",
                       relayBase: "https://relay.example/relay/api/m/MacBook/",
                       directBase: directExpiresIn == nil ? nil : "http://100.64.0.2:8650",
                       directDeviceId: directExpiresIn == nil ? nil : "dev-1",
                       directExpiresAt: directExpiresIn.map { Date().timeIntervalSince1970 + $0 },
                       updatedAt: Date())
    }

    func testDirectFirstThenQueuedRelayWithOneRequestId() throws {
        let reqs = target(directExpiresIn: 600).requests(text: "看这个", secrets: .init(relayKey: "relay-key", directToken: "grant-token"),
                                                          requestId: "rid-1")
        XCTAssertEqual(reqs.count, 2)
        XCTAssertEqual(reqs[0].url?.absoluteString, "http://100.64.0.2:8650/harness/sessions/abc/send")
        XCTAssertEqual(reqs[0].value(forHTTPHeaderField: "Authorization"), "Bearer grant-token")
        XCTAssertEqual(reqs[0].value(forHTTPHeaderField: "X-Leo-Device-ID"), "dev-1")
        XCTAssertEqual(reqs[0].timeoutInterval, ShareMacTarget.directTimeout)
        XCTAssertEqual(reqs[1].url?.absoluteString, "https://relay.example/relay/api/m/MacBook/harness/sessions/abc/send")
        XCTAssertEqual(reqs[1].value(forHTTPHeaderField: "Authorization"), "Bearer relay-key")
        XCTAssertEqual(reqs[1].value(forHTTPHeaderField: "X-Leo-Queue"), "1")
        XCTAssertEqual(Set(reqs.compactMap { $0.value(forHTTPHeaderField: "X-Leo-Request-Id") }), ["rid-1"])
        XCTAssertLessThanOrEqual(reqs.map(\.timeoutInterval).reduce(0, +), ShareMacTarget.totalBudget)
        let body = try XCTUnwrap(reqs[1].httpBody.flatMap { try JSONSerialization.jsonObject(with: $0) as? [String: String] })
        XCTAssertEqual(body, ["text": "看这个"])
    }

    func testExpiredDirectGrantFallsBackToRelayOnly() {
        let reqs = target(directExpiresIn: 10).requests(text: "x", secrets: .init(relayKey: "k", directToken: "t"))
        XCTAssertEqual(reqs.count, 1)
        XCTAssertEqual(reqs[0].value(forHTTPHeaderField: "X-Leo-Queue"), "1")
        XCTAssertEqual(target(directExpiresIn: nil).requests(text: "x", secrets: .init(relayKey: "", directToken: nil)).count, 0)
    }

    func testStaleTargetIsNotOffered() {
        var t = target(directExpiresIn: nil)
        XCTAssertTrue(t.isFresh())
        t.updatedAt = Date().addingTimeInterval(-ShareMacTarget.maxAge - 1)
        XCTAssertFalse(t.isFresh())
    }

    // MARK: Project wiring

    func testWatchWidgetExtensionIsEmbeddedAndSharesTheAppGroup() throws {
        let pbx = try String(contentsOf: iosRoot.appendingPathComponent("LeoPhoneAgent.xcodeproj/project.pbxproj"), encoding: .utf8)
        XCTAssertTrue(pbx.contains("/* LeoWatchWidget */ = {\n\t\t\tisa = PBXNativeTarget;"))
        XCTAssertTrue(pbx.contains("LeoWatchWidget.appex in Embed Foundation Extensions"))
        XCTAssertTrue(pbx.contains("PRODUCT_BUNDLE_IDENTIFIER = com.leoyuan.leophoneagent.watchkitapp.widget;"))
        XCTAssertTrue(pbx.contains("CODE_SIGN_ENTITLEMENTS = LeoWatch/LeoWatch.entitlements;"))
        for path in ["LeoWatch/LeoWatch.entitlements", "LeoWatchWidget/LeoWatchWidget.entitlements"] {
            let data = try Data(contentsOf: iosRoot.appendingPathComponent(path))
            let plist = try XCTUnwrap(PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any])
            XCTAssertEqual(plist["com.apple.security.application-groups"] as? [String], [WatchWidgetSnapshot.appGroup], path)
        }
        XCTAssertEqual(WatchWidgetSnapshot.appGroup, ShareMacTarget.appGroup)
    }
}
