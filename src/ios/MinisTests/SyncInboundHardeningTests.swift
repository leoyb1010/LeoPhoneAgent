import Foundation
import XCTest

/// A peer (or a corrupted replica) controls every inbound field. These tests
/// drive the real sanitizer, quarantine, Tailnet page decoder and the
/// per-record apply loop behind `SyncCore.processInbound` with stub mergers.
@MainActor
final class SyncInboundHardeningTests: XCTestCase {

    private let now = Date(timeIntervalSince1970: 2_000_000_000)
    private var tempDirs: [URL] = []

    override func tearDown() {
        tempDirs.forEach { try? FileManager.default.removeItem(at: $0) }
        tempDirs = []
        super.tearDown()
    }

    private func tempDir() throws -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("sync-hardening-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        tempDirs.append(url)
        return url
    }

    private func quarantine() throws -> SyncInboundQuarantine {
        SyncInboundQuarantine(fileURL: try tempDir().appendingPathComponent("q.json"))
    }

    private func session(_ id: String, updatedAt: Date? = nil, extra: [String: PortableFieldValue] = [:]) -> PortableRecord {
        var fields: [String: PortableFieldValue] = [
            "sessionId": .string(id), "modelId": .string("m"),
            "createdAt": .date(now), "updatedAt": .date(updatedAt ?? now), "memoryEnabled": .int(1),
        ]
        extra.forEach { fields[$0.key] = $0.value }
        return PortableRecord(id: SyncRecordID(type: "SessionV2", id: id), fields: fields,
                              schemaVersion: 2, updatedAt: updatedAt ?? now)
    }

    private func message(_ id: String, session: String, extra: [String: PortableFieldValue] = [:]) -> PortableRecord {
        var fields: [String: PortableFieldValue] = [
            "messageId": .string(id), "sessionId": .string(session), "role": .string("user"),
            "partsJson": .string("[]"), "createdAt": .date(now), "updatedAt": .date(now),
        ]
        extra.forEach { fields[$0.key] = $0.value }
        return PortableRecord(id: SyncRecordID(type: "MessageV2", id: id), fields: fields, updatedAt: now)
    }

    private func applier(_ q: SyncInboundQuarantine,
                         known: Set<String> = ["SessionV2", "MessageV2", "CompactMarkerV2"],
                         children: Set<String> = [],
                         merge: @escaping @MainActor (PortableRecord) async -> SyncMergeOutcome = { _ in .applied },
                         delete: @escaping @MainActor (SyncRecordID, Date?) async -> SyncMergeOutcome = { _, _ in .applied }) -> SyncInboundApplier {
        SyncInboundApplier(
            metadata: { known.contains($0) ? .init(version: 2, knownKeys: []) : nil },
            merge: merge, delete: delete, quarantine: q,
            isLocalChildSession: { children.contains($0) },
            now: { [now] in now }, isCancelled: { false })
    }

    // MARK: - P0 #5 / B9: integers and clocks

    func testStreamInterruptCountOverflowDoesNotTrap() async throws {
        let hostile = message("M1", session: "S1", extra: [
            "streamInterruptCount": .int(Int(Int64.max)), "sortOrder": .int(Int(Int64.min)),
        ])
        guard case .accept(let clean) = SyncRecordSanitizer.sanitize(hostile, now: now, isLocalChildSession: { _ in false }) else {
            return XCTFail("well-formed record must be accepted")
        }
        XCTAssertEqual(clean.fields["streamInterruptCount"], .int(Int(Int32.max)))
        XCTAssertEqual(clean.fields["sortOrder"], .int(Int(Int32.min)))
        // What the merger receives is already safe for `sqlite3_bind_int`.
        var seen: PortableRecord?
        let summary = await applier(try quarantine(), merge: { seen = $0; return .applied })
            .apply(SyncInboundBatch(records: [hostile], deletes: [], sourceDeviceId: nil))
        XCTAssertTrue(summary.complete)
        guard case .int(let count) = seen?.fields["streamInterruptCount"] ?? .null else { return XCTFail("missing") }
        XCTAssertEqual(Int32(clamping: count), Int32(count), "fits Int32 without trapping")
    }

    func testFarFutureUpdatedAtIsClamped() async throws {
        let year3000 = now.addingTimeInterval(1000 * 365 * 86_400)
        let hostile = session("S1", updatedAt: year3000, extra: ["pinnedAt": .date(year3000)])
        guard case .accept(let clean) = SyncRecordSanitizer.sanitize(hostile, now: now, isLocalChildSession: { _ in false }) else {
            return XCTFail("accepted")
        }
        let ceiling = now.addingTimeInterval(SyncRecordSanitizer.maxFutureSkew)
        XCTAssertEqual(clean.updatedAt, ceiling)
        XCTAssertEqual(clean.fields["updatedAt"], .date(ceiling))
        XCTAssertEqual(clean.fields["pinnedAt"], .date(ceiling))
        // A local edit made after the skew window wins last-writer-wins again,
        // so this device's changes still upload instead of losing forever.
        let laterLocalEdit = ceiling.addingTimeInterval(1)
        XCTAssertEqual(SyncConflictPolicy.resolve(localUpdatedAt: laterLocalEdit, serverUpdatedAt: clean.updatedAt), .resendLocal)
        XCTAssertEqual(SyncConflictPolicy.resolve(localUpdatedAt: laterLocalEdit, serverUpdatedAt: hostile.updatedAt), .acceptServer,
                       "unclamped, the peer would win forever")
        // Dated deletions are clamped too.
        var deletionDate: Date?
        _ = await applier(try quarantine(), delete: { _, d in deletionDate = d; return .applied })
            .apply(SyncInboundBatch(records: [], deletes: [SyncRecordID(type: "SessionV2", id: "S1")],
                                    sourceDeviceId: nil, deletionUpdatedAt: [SyncRecordID(type: "SessionV2", id: "S1"): year3000]))
        XCTAssertEqual(deletionDate, ceiling)
    }

    func testSessionTitleFromPeerIsSingleLineAndBounded() {
        let hostile = session("S1", extra: ["title": .string("line1\nline2\t" + String(repeating: "x", count: 50_000))])
        guard case .accept(let clean) = SyncRecordSanitizer.sanitize(hostile, now: now, isLocalChildSession: { _ in false }),
              case .string(let title) = clean.fields["title"] ?? .null else { return XCTFail("title") }
        XCTAssertFalse(title.contains("\n"))
        XCTAssertLessThanOrEqual(title.count, SessionTitleSanitizer.maxStoredLength)
    }

    // MARK: - B10: per-record isolation keeps ACKs flowing

    func testUnknownRecordTypeDoesNotWithholdAck() async throws {
        let q = try quarantine()
        var merged: [String] = []
        let future = PortableRecord(id: SyncRecordID(type: "FutureTypeV9", id: "x"), fields: ["a": .int(1)], updatedAt: now)
        let summary = await applier(q, merge: { merged.append($0.id.id); return .applied })
            .apply(SyncInboundBatch(records: [future, session("S1")],
                                    deletes: [SyncRecordID(type: "FutureTypeV9", id: "y")], sourceDeviceId: nil))
        XCTAssertTrue(summary.complete, "the batch ACKs; the cursor advances")
        XCTAssertEqual(merged, ["S1"], "known records in the same batch still apply")
        XCTAssertEqual(summary.quarantined, 2)
        let entries = q.all()
        XCTAssertTrue(entries.allSatisfy { $0.replayable }, "kept for replay after an upgrade")
        XCTAssertEqual(Set(entries.map(\.recordId.type)), ["FutureTypeV9"])
        // Once the type is known, the quarantined upsert and delete replay.
        let replay = SyncInboundApplier.replayableEntries(entries, metadata: { _ in .init(version: 1, knownKeys: []) }, parents: nil)
        XCTAssertEqual(replay.count, 2)
    }

    func testMinimumCompatibleVersionIsQuarantinedNotBlocking() async throws {
        let q = try quarantine()
        let newer = PortableRecord(id: SyncRecordID(type: "SessionV2", id: "S9"),
                                   fields: session("S9").fields, schemaVersion: 999,
                                   minimumCompatibleVersion: 999, updatedAt: now)
        let summary = await applier(q).apply(SyncInboundBatch(records: [newer], deletes: [], sourceDeviceId: nil))
        XCTAssertTrue(summary.complete)
        XCTAssertEqual(q.all().first?.reason, "minimumCompatibleVersion")
        XCTAssertTrue(SyncInboundApplier.replayableEntries(q.all(), metadata: { _ in .init(version: 2, knownKeys: []) }, parents: nil).isEmpty,
                      "still too new for this build")
    }

    func testMessageForMissingSessionDoesNotBlockPageAck() async throws {
        let q = try quarantine()
        let parent = SyncRecordID(type: "SessionV2", id: "S-missing")
        let marker = PortableRecord(id: SyncRecordID(type: "CompactMarkerV2", id: "K1"),
                                    fields: ["markerId": .string("K1"), "sessionId": .string("S-missing")], updatedAt: now)
        let summary = await applier(q, merge: { record in
            // What ChatStore does: messages park in remote_messages, markers wait.
            record.id.type == "MessageV2" ? .parked(dependency: parent) : .awaitingParent(parent)
        }).apply(SyncInboundBatch(records: [message("M1", session: "S-missing"), marker], deletes: [], sourceDeviceId: nil))
        XCTAssertTrue(summary.complete, "an orphan must not hold the batch")
        XCTAssertEqual(summary.dependencies, [parent, parent], "the parent is requested from the transport")
        let waiting = q.all()
        XCTAssertEqual(waiting.map(\.recordId.id), ["K1"])
        XCTAssertEqual(waiting.first?.dependency, parent)
        // Replayed only when that parent lands.
        let meta: (String) -> SyncInboundApplier.Metadata? = { _ in .init(version: 2, knownKeys: []) }
        XCTAssertTrue(SyncInboundApplier.replayableEntries(waiting, metadata: meta,
                                                           parents: [SyncRecordID(type: "SessionV2", id: "other")]).isEmpty)
        XCTAssertEqual(SyncInboundApplier.replayableEntries(waiting, metadata: meta, parents: [parent]).count, 1)
    }

    func testTransientFailureStillWithholdsAck() async throws {
        let summary = await applier(try quarantine(), merge: { _ in .retry })
            .apply(SyncInboundBatch(records: [session("S1")], deletes: [], sourceDeviceId: nil))
        XCTAssertFalse(summary.complete, "DB busy / running session: keep it on the wire")
        XCTAssertEqual(summary.retryIds, [SyncRecordID(type: "SessionV2", id: "S1")])
    }

    func testOversizeTailnetPageSkipsEntryNotCursor() throws {
        let replica = UUID().uuidString
        let big = String(repeating: "a", count: TailnetPageDecoder.maxPageBytes + 10)
        func page(limit: Int) throws -> Data {
            let change: [String: Any] = [
                "changeId": "c1", "revision": 1, "operation": "upsert", "updatedAt": 0,
                "id": ["type": "MessageV2", "id": "M1"],
                "record": ["id": ["type": "MessageV2", "id": "M1"],
                           "fields": ["partsJson": ["t": "string", "v": big]],
                           "assets": [:], "schemaVersion": 1, "unknownFields": [:], "updatedAt": 0],
            ]
            return try JSONSerialization.data(withJSONObject: [
                "replicaId": replica, "nextCursor": 42, "hasMore": true,
                "changes": [["cursor": 42, "senderDeviceId": "peer", "change": change]],
            ])
        }
        XCTAssertThrowsError(try TailnetPageDecoder.decode(page(limit: 100), after: 41, limit: 100)) {
            XCTAssertTrue($0 is TailnetPageDecoder.PageTooLarge, "a big page is refetched one change at a time")
        }
        let single = try TailnetPageDecoder.decode(page(limit: 1), after: 41, limit: 1)
        XCTAssertTrue(single.page.changes.isEmpty)
        XCTAssertEqual(single.page.nextCursor, 42, "the cursor moves past exactly that change")
        XCTAssertTrue(single.page.hasMore)
        XCTAssertEqual(single.skipped, [.init(cursor: 42, id: SyncRecordID(type: "MessageV2", id: "M1"), reason: "oversizeTailnetEntry")])
    }

    func testUndecodableTailnetEntryIsSkippedAndPageAdvances() throws {
        let replica = UUID().uuidString
        func entry(_ cursor: Int, _ id: String, fieldTag: String = "string") -> [String: Any] {
            ["cursor": cursor, "senderDeviceId": "peer", "change": [
                "changeId": "c\(cursor)", "revision": 1, "operation": "upsert", "updatedAt": 0,
                "id": ["type": "SessionV2", "id": id],
                "record": ["id": ["type": "SessionV2", "id": id],
                           "fields": ["title": ["t": fieldTag, "v": "x"]],
                           "assets": [:], "schemaVersion": 1, "unknownFields": [:], "updatedAt": 0],
            ] as [String: Any]]
        }
        let data = try JSONSerialization.data(withJSONObject: [
            "replicaId": replica, "nextCursor": 3, "hasMore": false,
            "changes": [entry(1, "A"), entry(2, "B", fieldTag: "not-a-tag"), entry(3, "C")],
        ])
        let decoded = try TailnetPageDecoder.decode(data, after: 0, limit: 100)
        XCTAssertEqual(decoded.page.changes.map(\.change.id.id), ["A", "C"])
        XCTAssertEqual(decoded.page.nextCursor, 3)
        XCTAssertEqual(decoded.skipped.map(\.cursor), [2])
        XCTAssertEqual(decoded.skipped.first?.id, SyncRecordID(type: "SessionV2", id: "B"))
    }

    func testRebuiltReplicaIsDetectedBeforeCursorChecks() throws {
        let data = try JSONSerialization.data(withJSONObject: [
            "replicaId": UUID().uuidString, "nextCursor": 1, "hasMore": false, "changes": [] as [Any],
        ])
        XCTAssertThrowsError(try TailnetPageDecoder.decode(data, after: 500, limit: 100, knownReplicaId: UUID().uuidString)) {
            XCTAssertTrue($0 is TailnetPageDecoder.ReplicaChanged, "a new replica restarts from 0 instead of failing forever")
        }
    }

    // MARK: - B11: running sessions, stale deletes

    func testInboundDeleteOfRunningSessionIsDeferred() async throws {
        XCTAssertEqual(SyncSessionDeleteGate.decide(isRunning: true, localUpdatedAt: now, deletionUpdatedAt: now.addingTimeInterval(60)),
                       .deferUntilIdle)
        // The store throws for a running session → `.retry` → batch not ACKed, row kept.
        let summary = await applier(try quarantine(), delete: { _, _ in .retry })
            .apply(SyncInboundBatch(records: [], deletes: [SyncRecordID(type: "SessionV2", id: "S1")], sourceDeviceId: nil))
        XCTAssertFalse(summary.complete)
        XCTAssertTrue(summary.appliedIds.isEmpty)
    }

    func testStaleSessionDeleteDoesNotRemoveNewerLocalSession() {
        XCTAssertEqual(SyncSessionDeleteGate.decide(isRunning: false, localUpdatedAt: now,
                                                    deletionUpdatedAt: now.addingTimeInterval(-60)), .keepLocalNewer)
        XCTAssertEqual(SyncSessionDeleteGate.decide(isRunning: false, localUpdatedAt: now,
                                                    deletionUpdatedAt: now.addingTimeInterval(60)), .apply)
        XCTAssertEqual(SyncSessionDeleteGate.decide(isRunning: false, localUpdatedAt: now, deletionUpdatedAt: nil), .apply,
                       "clockless (CloudKit) deletes keep their existing behaviour")
    }

    // MARK: - B12: identities

    func testInboundSessionIdWithPathSeparatorIsRejected() async throws {
        let q = try quarantine()
        var merged = 0, deleted = 0
        let traversal = "../../Documents"
        let hostileSession = PortableRecord(id: SyncRecordID(type: "SessionV2", id: traversal),
                                            fields: session(traversal).fields, updatedAt: now)
        let hostileMessage = message("M1", session: "../x")
        let mismatched = PortableRecord(id: SyncRecordID(type: "SessionV2", id: "S1"),
                                        fields: session("S2").fields, updatedAt: now)
        let tooLong = session(String(repeating: "é", count: 200))
        let summary = await applier(q, merge: { _ in merged += 1; return .applied },
                                    delete: { _, _ in deleted += 1; return .applied })
            .apply(SyncInboundBatch(records: [hostileSession, hostileMessage, mismatched, tooLong],
                                    deletes: [SyncRecordID(type: "SessionV2", id: traversal)], sourceDeviceId: nil))
        XCTAssertTrue(summary.complete)
        XCTAssertEqual(merged, 0, "no merger ever sees a hostile identity")
        XCTAssertEqual(deleted, 0)
        XCTAssertEqual(summary.quarantined, 4)
        XCTAssertEqual(summary.dropped, 1)
        XCTAssertTrue(q.all().allSatisfy { !$0.replayable })
    }

    func testDeleteSessionMediaRefusesTraversal() throws {
        let root = try tempDir()
        XCTAssertThrowsError(try SessionMediaPaths.directories(root: root, sessionId: "../../Documents"))
        XCTAssertThrowsError(try SessionMediaPaths.directories(root: root, sessionId: ".."))
        XCTAssertThrowsError(try SessionMediaPaths.directories(root: root, sessionId: "a/b"))
        let dirs = try SessionMediaPaths.directories(root: root, sessionId: "S1")
        XCTAssertEqual(dirs.count, 4)
        let base = root.standardizedFileURL.resolvingSymlinksInPath().path + "/S1/"
        XCTAssertTrue(dirs.allSatisfy { $0.standardizedFileURL.resolvingSymlinksInPath().path.hasPrefix(base) })
    }

    func testRecordsTargetingLocalChildSessionsAreIgnored() async throws {
        var merged = 0, deleted = 0
        let fromPeer = session("S-peer-child", extra: ["parentSessionId": .string("P1")])
        let asUnknown = PortableRecord(id: SyncRecordID(type: "SessionV2", id: "S2"), fields: session("S2").fields,
                                       unknownFields: ["parent_session_id": .string("P1")], updatedAt: now)
        let intoChild = message("M1", session: "CHILD")
        let summary = await applier(try quarantine(), children: ["CHILD"],
                                    merge: { _ in merged += 1; return .applied },
                                    delete: { _, _ in deleted += 1; return .applied })
            .apply(SyncInboundBatch(records: [fromPeer, asUnknown, intoChild, session("CHILD")],
                                    deletes: [SyncRecordID(type: "SessionV2", id: "CHILD")], sourceDeviceId: nil))
        XCTAssertTrue(summary.complete)
        XCTAssertEqual(merged, 0)
        XCTAssertEqual(deleted, 0, "a peer cannot delete a hidden sub-agent session")
        XCTAssertEqual(summary.dropped, 5)
    }

    // MARK: - Quarantine store

    func testQuarantineIsBoundedAndPersists() throws {
        let url = try tempDir().appendingPathComponent("q.json")
        let q = SyncInboundQuarantine(fileURL: url)
        for i in 0..<(SyncInboundQuarantine.maxEntries + 100) {
            q.add(recordId: SyncRecordID(type: "X", id: "\(i)"), record: nil, reason: "r", replayable: i % 2 == 0, now: now)
        }
        XCTAssertLessThanOrEqual(q.count, SyncInboundQuarantine.maxEntries)
        q.flush()
        let reloaded = SyncInboundQuarantine(fileURL: url)
        XCTAssertEqual(reloaded.count, q.count)
        let huge = PortableRecord(id: SyncRecordID(type: "X", id: "big"),
                                  fields: ["v": .string(String(repeating: "z", count: SyncInboundQuarantine.maxRecordBytes + 1))],
                                  updatedAt: now)
        q.add(recordId: huge.id, record: huge, reason: "unknownRecordType", replayable: true, now: now)
        let stored = q.all().first { $0.recordId == huge.id }
        XCTAssertNil(stored?.record, "oversized payloads are not kept")
        XCTAssertEqual(stored?.replayable, false)
    }
}
