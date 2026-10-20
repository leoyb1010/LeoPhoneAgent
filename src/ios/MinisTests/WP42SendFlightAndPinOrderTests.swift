import XCTest

/// WP-42 补充：发送飞入的时序判定、置顶会话拖拽排序(存储、合并、同步字段)。
final class WP42SendFlightAndPinOrderTests: XCTestCase {
    typealias P = SendFlightPolicy
    let window = CGRect(x: 0, y: 0, width: 390, height: 844)
    let source = CGRect(x: 16, y: 760, width: 300, height: 40)

    // MARK: Send flight

    func testFliesToTheBubbleCornerOnceTheCellIsLaidOut() {
        let cell = CGRect(x: 0, y: 500, width: 390, height: 60)
        let landing = P.landingRect(source: source, cell: cell)
        XCTAssertEqual(P.decide(source: source, cellFrame: cell, previousCellFrame: cell, window: window, reduceMotion: false, waits: 0), .fly(to: landing))
        XCTAssertEqual(landing, CGRect(x: 90, y: 500, width: 300, height: 40), "trailing-top of the cell, user bubbles are right-aligned")
        XCTAssertEqual(P.landingRect(source: source, cell: CGRect(x: 0, y: 0, width: 200, height: 20)).size,
                       CGSize(width: 200, height: 20), "never bigger than the cell")
    }

    func testWaitsForTheCellToSettleBeforeFlying() {
        // 键盘收起时 cell 还在往下走：第一次看到、或者位置还在变，就再等一帧；等满了按当前位置飞。
        let cell = CGRect(x: 0, y: 500, width: 390, height: 60)
        XCTAssertEqual(P.decide(source: source, cellFrame: cell, window: window, reduceMotion: false, waits: 1), .wait)
        XCTAssertEqual(P.decide(source: source, cellFrame: cell, previousCellFrame: cell.offsetBy(dx: 0, dy: -40),
                                window: window, reduceMotion: false, waits: 5), .wait)
        XCTAssertEqual(P.decide(source: source, cellFrame: cell, previousCellFrame: cell.offsetBy(dx: 0, dy: -40),
                                window: window, reduceMotion: false, waits: P.maxSettleWaits),
                       .fly(to: P.landingRect(source: source, cell: cell)))
    }

    func testLandsOnTheBubbleNotTheWholeRow() {
        let cell = CGRect(x: 0, y: 500, width: 390, height: 60)
        let text = CGSize(width: 60, height: 20)
        let bubble = P.bubbleFrame(cell: cell, text: text)
        XCTAssertEqual(bubble, CGRect(x: 390 - 16 - 88, y: 520, width: 88, height: 40), "right-aligned, 16pt cell inset, bubble padding 28×20")
        let landing = P.landingRect(source: source, cell: cell, bubbleText: text)
        XCTAssertEqual(landing.minX, bubble.minX)
        XCTAssertEqual(landing.minY, bubble.minY)
        XCTAssertLessThanOrEqual(landing.width, bubble.width)
        XCTAssertEqual(landing.width / landing.height, source.width / source.height, accuracy: 0.001, "scaled, never squashed")
        // 长文本：气泡最宽 = 行宽 - 两侧 16 - 左侧 Spacer 60
        XCTAssertEqual(P.bubbleFrame(cell: cell, text: CGSize(width: 1000, height: 40)).width, 390 - 32 - 60)
        XCTAssertEqual(P.bubbleTextWidth(cellWidth: 390), 390 - 32 - 60 - 28)
    }

    func testAsyncInsertWaitsAFewFramesThenFadesIn() {
        // Cell not created yet / not measured yet / still off screen → wait, then fall back.
        for cell in [nil, CGRect(x: 0, y: 500, width: 390, height: 0), CGRect(x: 0, y: 2000, width: 390, height: 60)] as [CGRect?] {
            XCTAssertEqual(P.decide(source: source, cellFrame: cell, window: window, reduceMotion: false, waits: 0), .wait)
            XCTAssertEqual(P.decide(source: source, cellFrame: cell, window: window, reduceMotion: false,
                                    waits: P.maxLayoutWaits), .fadeIn)
        }
    }

    func testReduceMotionAndMissingSnapshotOnlyFade() {
        let cell = CGRect(x: 0, y: 500, width: 390, height: 60)
        XCTAssertEqual(P.decide(source: source, cellFrame: cell, window: window, reduceMotion: true, waits: 0), .fadeIn)
        XCTAssertEqual(P.decide(source: nil, cellFrame: cell, window: window, reduceMotion: false, waits: 0), .fadeIn)
        XCTAssertEqual(P.decide(source: .zero, cellFrame: cell, window: window, reduceMotion: false, waits: 0), .fadeIn)
    }

    func testOnlyAFreshSendIsClaimedAndSpringMatchesLeoMotion() {
        let t = Date()
        XCTAssertTrue(P.isFresh(armedAt: t, now: t.addingTimeInterval(0.4)))
        XCTAssertFalse(P.isFresh(armedAt: t, now: t.addingTimeInterval(P.maxArmAge + 0.1)), "queued / synced messages don't fly")
        XCTAssertFalse(P.isFresh(armedAt: t, now: t.addingTimeInterval(-1)))
        XCTAssertEqual(P.springResponse, 0.30, "same as LeoMotion.springResponse")
        XCTAssertEqual(P.springDamping, 0.82)
        // response 0.30 → stiffness (2π/0.3)² ≈ 438.6, damping 4π·0.82/0.3 ≈ 34.3
        XCTAssertEqual(P.springStiffness, 438.65, accuracy: 0.1)
        XCTAssertEqual(P.springDampingCoefficient, 34.35, accuracy: 0.1)
    }

    func testFlightIsWiredIntoSendAndTheList() throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
        let chat = try String(contentsOf: root.appendingPathComponent("Views/Chat/AIChatView.swift"), encoding: .utf8)
        XCTAssertTrue(chat.contains("SendFlightAnimator.shared.arm(vmId:"))
        let list = try String(contentsOf: root.appendingPathComponent("Agent/MessageList/CollectionViewMessageListV3.swift"), encoding: .utf8)
        XCTAssertTrue(list.contains("SendFlightAnimator.shared.claim(vmId:"))
    }

    // MARK: Pinned order

    private func entry(_ id: String, updated: Double, pinned: Double = 1) -> PinnedSessionOrder.Entry {
        .init(id: id, updatedAt: Date(timeIntervalSince1970: updated), pinnedAt: Date(timeIntervalSince1970: pinned))
    }

    func testWithoutRanksTheOriginalOrderIsKept() {
        let pinned = [entry("a", updated: 10), entry("b", updated: 30), entry("c", updated: 20)]
        XCTAssertEqual(PinnedSessionOrder.sort(pinned, ranks: [:]), ["b", "c", "a"])
    }

    func testDraggedOrderWinsAndNewPinsGoOnTop() {
        let pinned = [entry("a", updated: 10), entry("b", updated: 30), entry("c", updated: 20), entry("new", updated: 5)]
        let ranks = ["a": PinRank(rank: 0, editedAtMs: 1), "b": PinRank(rank: 2, editedAtMs: 1), "c": PinRank(rank: 1, editedAtMs: 1)]
        XCTAssertEqual(PinnedSessionOrder.sort(pinned, ranks: ranks), ["new", "a", "c", "b"])
    }

    func testMoveMatchesListOnMoveAndWritesOnlyChangedRanks() {
        let ids = ["a", "b", "c", "d"]
        XCTAssertEqual(PinnedSessionOrder.move(ids, from: [0], to: 3), ["b", "c", "a", "d"])
        XCTAssertEqual(PinnedSessionOrder.move(ids, from: [3], to: 0), ["d", "a", "b", "c"])
        XCTAssertEqual(PinnedSessionOrder.move(ids, from: [1, 2], to: 4), ["a", "d", "b", "c"])
        let now = Date(timeIntervalSince1970: 100)
        let first = PinnedSessionOrder.assignments(order: ["b", "a", "c"], current: [:], now: now)
        XCTAssertEqual(first.count, 3)
        XCTAssertEqual(first["b"], PinRank(rank: 0, editedAtMs: 100_000))
        let second = PinnedSessionOrder.assignments(order: ["b", "c", "a"], current: first, now: now.addingTimeInterval(1))
        XCTAssertEqual(Set(second.keys), ["c", "a"], "b kept its rank: not rewritten, not re-synced")
    }

    func testSyncMergeKeepsTheNewestOrderAndToleratesOldPeers() {
        let local = PinRank(rank: 0, editedAtMs: 200)
        XCTAssertEqual(PinnedSessionOrder.merge(local: local, remote: nil), local, "old device sent no field")
        XCTAssertEqual(PinnedSessionOrder.merge(local: local, remote: PinRank(rank: 3, editedAtMs: 100)), local)
        XCTAssertEqual(PinnedSessionOrder.merge(local: local, remote: PinRank(rank: 3, editedAtMs: 300)), PinRank(rank: 3, editedAtMs: 300))
        XCTAssertEqual(PinnedSessionOrder.merge(local: nil, remote: local), local)
        XCTAssertEqual(PinRank(encoded: "4|1792213314960"), PinRank(rank: 4, editedAtMs: 1792213314960))
        XCTAssertEqual(PinRank(encoded: PinRank(rank: 2, editedAtMs: 9).encoded), PinRank(rank: 2, editedAtMs: 9))
        for bad in [nil, "", "x|1", "1|", "-1|5", "1|0", "1|2|3"] as [String?] { XCTAssertNil(PinRank(encoded: bad), "\(bad ?? "nil")") }
    }

    func testPinOrderTravelsWithTheSessionRecord() throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
        let v1 = try String(contentsOf: root.appendingPathComponent("Agent/Sync/CloudSyncEngine.swift"), encoding: .utf8)
        XCTAssertTrue(v1.contains(#"record["pinOrder"] = extras.pinOrder"#))
        XCTAssertTrue(v1.contains("mergeRemotePinOrder"))
        let v2 = try String(contentsOf: root.appendingPathComponent("Agent/Sync/V2/ChatStoreSyncHydrators.swift"), encoding: .utf8)
        XCTAssertTrue(v2.contains("pinOrder: extras.pinOrder") && v2.contains("mergeRemotePinOrder"))
        let types = try String(contentsOf: root.appendingPathComponent("Agent/Sync/V2/SyncedTypes.swift"), encoding: .utf8)
        XCTAssertTrue(types.contains(#"F.optionalString("pinOrder", \SyncedSession.pinOrder)"#))
        let schema = try String(contentsOf: root.appendingPathComponent("Agent/Chat/ChatStoreSchemaContract.swift"), encoding: .utf8)
        XCTAssertTrue(schema.contains(#"Column(name: "pin_order", definition: "TEXT")"#))
    }
}
