import XCTest

/// Upstream sync gaps ported onto our transport: poll keys, empty-schema types,
/// two-pass anchoring with a 7-day overlap, parents-first apply order, UTF-8
/// record-name limit, byte-budget batching and the v1-delete count deadlock.
final class SyncPollPlanTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 2_000_000_000)

    func testSessionPolledByUpdatedAtAndMessagesStayOnCreatedAt() {
        let keys = Dictionary(uniqueKeysWithValues: SyncPollPlan.recentQueries.map { ($0.type, $0.dateKey) })
        XCTAssertEqual(keys["SessionV2"], "updatedAt", "a title edit on an old session must reach peers")
        XCTAssertEqual(keys["MessageV2"], "createdAt")
        XCTAssertEqual(keys["CompactMarkerV2"], "createdAt")
        XCTAssertEqual(SyncPollPlan.fallbackDateKey(for: "SessionV2", primary: "updatedAt"), "createdAt")
        XCTAssertNil(SyncPollPlan.fallbackDateKey(for: "MessageV2", primary: "createdAt"))
    }

    func testMCPServersV2IsNoLongerPolledOrFullHistory() {
        XCTAssertFalse(SyncPollPlan.recentQueries.contains { $0.type == "MCPServersV2" })
        XCTAssertFalse(SyncPollPlan.fullHistoryConfigTypes.contains("MCPServersV2"))
        XCTAssertTrue(SyncPollPlan.recentQueries.contains { $0.type == "MCPServerItem" })
    }

    func testUnknownItemMeansEmptyTypeNotFailure() {
        XCTAssertTrue(SyncPollPlan.isEmptySchemaType(ckCode: 11))
        XCTAssertFalse(SyncPollPlan.isEmptySchemaType(ckCode: 7), "rate limit is a real failure")
        XCTAssertFalse(SyncPollPlan.isEmptySchemaType(ckCode: nil))
    }

    func testAnchoringNeedsTwoMatchingFullHistoryPulls() {
        let first = SyncPollPlan.anchorDecision(previousPendingCount: nil, fetched: 40)
        XCTAssertFalse(first.anchor)
        XCTAssertEqual(first.pendingCount, 40)
        let subset = SyncPollPlan.anchorDecision(previousPendingCount: 40, fetched: 42)
        XCTAssertFalse(subset.anchor, "an eventually-consistent subset must not anchor")
        XCTAssertEqual(subset.pendingCount, 42)
        let confirmed = SyncPollPlan.anchorDecision(previousPendingCount: 42, fetched: 42)
        XCTAssertTrue(confirmed.anchor)
        XCTAssertNil(confirmed.pendingCount)
        XCTAssertTrue(SyncPollPlan.anchorDecision(previousPendingCount: 0, fetched: 0).anchor)
    }

    func testConfigTypesKeepSevenDayOverlapOnceAnchored() {
        XCTAssertEqual(SyncPollPlan.cutoff(type: "ProviderInstanceV3", now: now, lastSuccess: 0, anchored: false), .distantPast)
        let recent = now.timeIntervalSince1970 - 60
        let config = SyncPollPlan.cutoff(type: "ProviderInstanceV3", now: now, lastSuccess: recent, anchored: true)
        XCTAssertEqual(config, now.addingTimeInterval(-7 * 24 * 3600))
        let message = SyncPollPlan.cutoff(type: "MessageV2", now: now, lastSuccess: recent, anchored: false)
        XCTAssertEqual(message, Date(timeIntervalSince1970: recent - 300), "high-volume types keep the tight cursor")
        let stale = SyncPollPlan.cutoff(type: "MessageV2", now: now, lastSuccess: 1, anchored: false)
        XCTAssertEqual(stale, now.addingTimeInterval(-24 * 3600))
    }

    func testParentsFirstIsStableAndPutsSessionsBeforeMessages() {
        let input = ["MessageV2#1", "SkillV2#a", "SessionV2#s", "MessageV2#2", "FolderV2#f", "CompactMarkerV2#c"]
        let out = SyncPollPlan.parentsFirst(input) { String($0.split(separator: "#")[0]) }
        XCTAssertEqual(out, ["FolderV2#f", "SessionV2#s", "MessageV2#1", "MessageV2#2", "CompactMarkerV2#c", "SkillV2#a"])
        XCTAssertEqual(SyncPollPlan.parentsFirst(["SkillV2#a", "SoulV2#b"]) { String($0.split(separator: "#")[0]) },
                       ["SkillV2#a", "SoulV2#b"])
    }

    func testRecordNameLimitCountsUTF8Bytes() {
        let cjk = "SessionFileV2:s:" + String(repeating: "文", count: 100)   // 116 chars, 316 bytes
        XCTAssertLessThan(cjk.count, 255)
        XCTAssertFalse(SyncPollPlan.isValidRecordName(cjk))
        XCTAssertTrue(SyncPollPlan.isValidRecordName("SessionFileV2:s:" + String(repeating: "文", count: 70)))
        let family = String(repeating: "👨‍👩‍👧‍👦", count: 11)  // 11 Characters, 275 bytes
        XCTAssertFalse(SyncPollPlan.isValidRecordName(family))
        XCTAssertTrue(SyncPollPlan.isValidRecordName(String(repeating: "a", count: 255)))
        XCTAssertFalse(SyncPollPlan.isValidRecordName(String(repeating: "a", count: 256)))
        XCTAssertFalse(SyncPollPlan.isValidRecordName("SessionV2:"))
        XCTAssertFalse(SyncPollPlan.isValidRecordName("_x"))
        XCTAssertFalse(SyncPollPlan.isValidRecordName("a\u{0}b"))
    }

    func testBatchCutPrefersSmallRecordsAndBudgetsBytes() {
        // Two assets queued ahead of three small messages.
        let cut = SyncPollPlan.batchCut(hasAsset: [true, true, false, false, false],
                                        bytes: [3_000_000, 3_000_000, 8_000, 8_000, 8_000], deleteCount: 0)
        XCTAssertEqual(cut.selected, [2, 3, 4])
        XCTAssertFalse(cut.assets)
        XCTAssertEqual(cut.overflow, [0, 1])
        // Assets alone: 8 MB budget, first always admitted.
        let assets = SyncPollPlan.batchCut(hasAsset: [true, true, true], bytes: [5_000_000, 5_000_000, 5_000_000], deleteCount: 0)
        XCTAssertEqual(assets.selected, [0, 1])
        XCTAssertEqual(assets.overflow, [2])
        let huge = SyncPollPlan.batchCut(hasAsset: [true], bytes: [50_000_000], deleteCount: 0)
        XCTAssertEqual(huge.selected, [0], "one oversized record must not stall the queue")
        // Many tiny records: capped by the record limit minus deletes.
        let tiny = SyncPollPlan.batchCut(hasAsset: Array(repeating: false, count: 400),
                                         bytes: Array(repeating: 10, count: 400), deleteCount: 50)
        XCTAssertEqual(tiny.selected.count, 200)
        XCTAssertEqual(tiny.overflow.count, 200)
    }

    func testV1DeleteSkipsCloudCountOnlyForVerifiablyEmptyStore() {
        XCTAssertEqual(SyncPollPlan.v1DeleteGate(localSessions: 0, localMessages: 0), .proceedWithoutCount)
        XCTAssertEqual(SyncPollPlan.v1DeleteGate(localSessions: nil, localMessages: nil), .deferUnreadable,
                       "an unreadable DB must never look empty")
        XCTAssertEqual(SyncPollPlan.v1DeleteGate(localSessions: 0, localMessages: 12), .deferUnreadable)
        XCTAssertEqual(SyncPollPlan.v1DeleteGate(localSessions: 0, localMessages: nil), .deferUnreadable)
        XCTAssertEqual(SyncPollPlan.v1DeleteGate(localSessions: 8, localMessages: 90), .requiresCloudCount(localSessions: 8))
    }

    func testV1DeleteCountFailureDefersInsteadOfFailing() {
        XCTAssertEqual(SyncPollPlan.v1DeleteVerdict(localSessions: 10, cloudCount: nil), .deferUntilNextLaunch)
        XCTAssertEqual(SyncPollPlan.v1DeleteVerdict(localSessions: 10, cloudCount: 4), .abortSafeguard(minimum: 5))
        XCTAssertEqual(SyncPollPlan.v1DeleteVerdict(localSessions: 10, cloudCount: 5), .proceed)
        XCTAssertTrue(SyncPollPlan.transientCKCodes.contains(7), "requestRateLimited")
        XCTAssertTrue(SyncPollPlan.transientCKCodes.contains(23), "zoneBusy")
        XCTAssertFalse(SyncPollPlan.transientCKCodes.contains(10), "permissionFailure is a real failure")
    }
}
