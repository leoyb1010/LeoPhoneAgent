#if NATIVE_MODEL_AUDIT
import XCTest
import SQLite3

/// Runs unchanged production Store method bodies in the dependency-isolated
/// persistence seam. Network, app startup, compact slots and dirty transport are
/// adapters; JSON, archive, save admission, serial writes and SQLite are real.
@MainActor
final class ProductionProviderPersistenceTests: XCTestCase {
    private func directory() throws -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    private func fixture() -> ProviderConfig {
        let provider = ProviderInstance(id: "fixture-provider", label: "Fixture", providerType: .openAI,
                                        credentialType: .apiKey, createdAt: Date(timeIntervalSince1970: 100))
        let a = ModelEntry(uuid: "legacy-a", providerInstanceId: provider.id,
                           model: LLMModel(id: "a", displayName: "A", provider: "OpenAI", modalityOverride: .textOnly),
                           overrides: ModelOverrides(displayName: "Edited A", maxThinkingLevel: .high),
                           isHidden: true, userModifiedAt: Date(timeIntervalSince1970: 200))
        let b = ModelEntry(uuid: "legacy-b", providerInstanceId: provider.id,
                           model: LLMModel(id: "b", displayName: "B", provider: "OpenAI", modalityOverride: .textOnly))
        let group = ModelGroup(id: "group", name: "Ordered fallback", memberEntryIds: [a.id, b.id])
        let binding = SessionModelBinding(sessionId: "session", primarySource: .directEntry(modelEntryId: a.uuid, compositeKey: a.id))
        return ProviderConfig(instances: [provider], modelEntries: [a, b], modelGroups: [group],
                              defaultPrimaryGroupId: group.id, defaultSubGroupId: nil,
                              sessionBindings: ["session": binding], agentLoopModelEntryIds: [a.id, b.id])
    }

    private func execute(_ sql: String, at url: URL) throws {
        var handle: OpaquePointer?
        guard sqlite3_open(url.path, &handle) == SQLITE_OK, let handle else {
            throw NSError(domain: "PersistenceTests", code: 1)
        }
        defer { sqlite3_close(handle) }
        guard sqlite3_exec(handle, sql, nil, nil, nil) == SQLITE_OK else {
            throw NSError(domain: "PersistenceTests", code: 2)
        }
    }

    func testActualLoadPreservesEmptyGroupUnknownMembersDefaultsAndUUID() throws {
        let directory = try directory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let url = directory.appendingPathComponent("config.json")
        var original = fixture()
        original.modelGroups.insert(ModelGroup(id: "empty", name: "Keep empty", memberEntryIds: []), at: 0)
        original.modelGroups[1].memberEntryIds.append("missing-provider/missing:model")
        original.defaultPrimaryGroupId = nil
        try JSONEncoder().encode(original).write(to: url)
        let store = ProductionProviderPersistence(fileURL: url)
        XCTAssertEqual(store.config, original)
        XCTAssertEqual(store.config.modelEntries[0].uuid, "legacy-a")
    }

    func testActualSaveFailureRollsBackBindingAndVisibilityWithoutChangingJSON() throws {
        let directory = try directory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let url = directory.appendingPathComponent("config.json")
        let original = fixture()
        let bytes = try JSONEncoder().encode(original)
        try bytes.write(to: url)
        let store = ProductionProviderPersistence(fileURL: url)
        try FileManager.default.createDirectory(at: ProviderSnapshotJournal.markerURL(for: url), withIntermediateDirectories: false)
        let changed = SessionModelBinding(sessionId: "session", primarySource: .directEntry(modelEntryId: original.modelEntries[1].id))
        XCTAssertFalse(store.setBinding(changed, for: "session"))
        XCTAssertEqual(store.config, original)
        XCTAssertFalse(store.setEntriesHidden(ids: [original.modelEntries[1].id], hidden: true))
        XCTAssertEqual(store.config, original)
        XCTAssertEqual(store.configRevision, 0)
        XCTAssertEqual(try Data(contentsOf: url), bytes)
    }

    func testActualRefreshOmissionAndRestorePreserveSelectionGroupsAndHiddenOverlay() throws {
        let directory = try directory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let url = directory.appendingPathComponent("config.json")
        let original = fixture()
        let store = ProductionProviderPersistence(fileURL: url, initial: original)
        XCTAssertTrue(store.replaceEntries(for: original.instances[0].id, models: [original.modelEntries[1].baseModel]))
        XCTAssertEqual(store.config.modelEntries.map(\.id), [original.modelEntries[1].id])
        XCTAssertEqual(store.config.modelGroups, original.modelGroups)
        XCTAssertEqual(store.config.sessionBindings, original.sessionBindings)
        XCTAssertEqual(store.config.defaultPrimaryGroupId, original.defaultPrimaryGroupId)
        let restarted = ProductionProviderPersistence(fileURL: url)
        XCTAssertEqual(restarted.normalizeEntryRef("legacy-a"), original.modelEntries[0].id)
        XCTAssertTrue(restarted.replaceEntries(for: original.instances[0].id, models: original.modelEntries.map(\.baseModel)))
        XCTAssertEqual(restarted.config.modelEntries[0], original.modelEntries[0])
        XCTAssertEqual(restarted.config.modelGroups, original.modelGroups)
        XCTAssertEqual(restarted.config.sessionBindings, original.sessionBindings)
        XCTAssertEqual(restarted.config.agentLoopModelEntryIds, original.agentLoopModelEntryIds)
    }

    func testActualDeleteAdmissionFailurePreservesDormantArchive() throws {
        let directory = try directory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let url = directory.appendingPathComponent("config.json")
        let original = fixture()
        let store = ProductionProviderPersistence(fileURL: url, initial: original)
        XCTAssertTrue(store.replaceEntries(for: original.instances[0].id, models: [original.modelEntries[1].baseModel]))
        let archive = url.appendingPathExtension("model-archive")
        let before = try Data(contentsOf: archive)
        let prior = store.config
        try FileManager.default.removeItem(at: ProviderSnapshotJournal.markerURL(for: url))
        try FileManager.default.createDirectory(at: ProviderSnapshotJournal.markerURL(for: url), withIntermediateDirectories: false)
        XCTAssertFalse(store.removeEntry(original.modelEntries[0].id))
        XCTAssertEqual(store.config, prior)
        XCTAssertEqual(try Data(contentsOf: archive), before)
    }

    func testActualTwoRapidSavesFinishWithNewestDatabaseAndJSON() async throws {
        let directory = try directory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let jsonURL = directory.appendingPathComponent("config.json")
        let db = try ProviderConfigDB(url: directory.appendingPathComponent("config.db"))
        let original = fixture()
        let store = ProductionProviderPersistence(fileURL: jsonURL, initial: original, db: db)
        let entered = expectation(description: "Queue held before first write")
        var release: CheckedContinuation<Void, Never>?
        store.holdWrites {
            await withCheckedContinuation { continuation in
                release = continuation
                entered.fulfill()
            }
        }
        var first = original
        first.modelGroups[0].name = "First"
        var second = original
        second.modelGroups[0].name = "Second"
        XCTAssertTrue(store.stage(first))
        XCTAssertTrue(store.stage(second))
        await fulfillment(of: [entered], timeout: 3)
        XCTAssertNotNil(ProviderSnapshotJournal.pendingToken(for: jsonURL))
        release?.resume()
        await store.drainWrites()
        let restored = await db.dumpProviderConfig()
        XCTAssertEqual(restored, second)
        XCTAssertEqual(try JSONDecoder().decode(ProviderConfig.self, from: Data(contentsOf: jsonURL)), second)
        XCTAssertNil(ProviderSnapshotJournal.pendingToken(for: jsonURL))
    }

    func testActualDatabaseMirrorFailureRecoversFromDurableJSONOnRestart() async throws {
        let directory = try directory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let jsonURL = directory.appendingPathComponent("config.json")
        let dbURL = directory.appendingPathComponent("config.db")
        let db = try ProviderConfigDB(url: dbURL)
        let original = fixture()
        let firstSaved = await db.bulkReplace(from: original)
        XCTAssertTrue(firstSaved)
        await db.setLegacyUuidMapKV("{\"older-uuid\":\"fixture-provider/a\"}")
        try execute("CREATE TRIGGER fail_write BEFORE INSERT ON provider_model_entries BEGIN SELECT RAISE(ABORT, 'synthetic write failure'); END", at: dbURL)
        let store = ProductionProviderPersistence(fileURL: jsonURL, initial: original, db: db)
        var latest = original
        latest.modelGroups[0].name = "Durable latest edit"
        XCTAssertTrue(store.stage(latest))
        await store.drainWrites()
        let unchanged = await db.dumpProviderConfig()
        XCTAssertEqual(unchanged, original)
        XCTAssertNotNil(ProviderSnapshotJournal.pendingToken(for: jsonURL))
        try execute("DROP TRIGGER fail_write", at: dbURL)
        let restarted = ProductionProviderPersistence(fileURL: jsonURL, db: db)
        let recovered = await restarted.recoverPendingSnapshot()
        XCTAssertTrue(recovered)
        let restored = await db.dumpProviderConfig()
        XCTAssertEqual(restored, latest)
        XCTAssertEqual(restarted.legacyUuidToCompositeKey["older-uuid"], "fixture-provider/a")
        XCTAssertNil(ProviderSnapshotJournal.pendingToken(for: jsonURL))
    }

    func testFailedSaveAThenSuccessfulSaveBStillDispatchesAOnlyChanges() async throws {
        let directory = try directory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let jsonURL = directory.appendingPathComponent("config.json")
        let dbURL = directory.appendingPathComponent("config.db")
        let db = try ProviderConfigDB(url: dbURL)
        let original = fixture()
        let saved = await db.bulkReplace(from: original)
        XCTAssertTrue(saved)
        let store = ProductionProviderPersistence(fileURL: jsonURL, initial: original, db: db)
        try execute("CREATE TRIGGER fail_write BEFORE INSERT ON provider_model_entries BEGIN SELECT RAISE(ABORT, 'synthetic A failure'); END", at: dbURL)
        var a = original
        a.modelEntries[0].isHidden = false
        a.deletedModelEntries = [.init(id: "deleted-only-in-a", deletedAt: Date(timeIntervalSince1970: 300))]
        XCTAssertTrue(store.stage(a))
        await store.drainWrites()
        try execute("DROP TRIGGER fail_write", at: dbURL)
        ChatStore.shared.dirtyCalls.removeAll()
        var b = a
        b.modelGroups[0].name = "Changed only in B"
        XCTAssertTrue(store.stage(b))
        await store.drainWrites()
        let calls = ChatStore.shared.dirtyCalls
        XCTAssertTrue(calls.contains { $0.recordType == "ProviderModelEntryV3" && $0.recordId == "legacy-a" && $0.operation == "upsert" })
        XCTAssertTrue(calls.contains { $0.recordType == "ProviderModelEntryV3" && $0.recordId == "deleted-only-in-a" && $0.operation == "delete" })
        XCTAssertTrue(calls.contains { $0.recordType == "ProviderModelGroupV3" && $0.recordId == "group" && $0.operation == "upsert" })
        XCTAssertNil(ProviderSnapshotJournal.pendingToken(for: jsonURL))
    }

    func testCrashRecoveryDispatchesExplicitDeletesWithoutDeletingActiveReaddedIDs() async throws {
        let directory = try directory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let jsonURL = directory.appendingPathComponent("config.json")
        let db = try ProviderConfigDB(url: directory.appendingPathComponent("config.db"))
        var snapshot = fixture()
        let date = Date(timeIntervalSince1970: 300)
        snapshot.deletedInstances = [.init(id: "gone-provider", deletedAt: date)]
        snapshot.deletedModelEntries = [.init(id: "gone-entry", deletedAt: date)]
        snapshot.deletedModelGroups = [.init(id: "gone-group", deletedAt: date), .init(id: "group", deletedAt: date)]
        _ = try ProviderSnapshotJournal.write(JSONEncoder().encode(snapshot), to: jsonURL)
        let restarted = ProductionProviderPersistence(fileURL: jsonURL, db: db)
        ChatStore.shared.dirtyCalls.removeAll()
        let recovered = await restarted.recoverPendingSnapshot()
        XCTAssertTrue(recovered)
        let calls = ChatStore.shared.dirtyCalls
        for (type, id) in [("ProviderInstanceV3", "gone-provider"), ("ProviderModelEntryV3", "gone-entry"), ("ProviderModelGroupV3", "gone-group")] {
            XCTAssertTrue(calls.contains { $0.recordType == type && $0.recordId == id && $0.operation == "delete" })
        }
        XCTAssertFalse(calls.contains { $0.recordType == "ProviderModelGroupV3" && $0.recordId == "group" && $0.operation == "delete" })
        XCTAssertNil(ProviderSnapshotJournal.pendingToken(for: jsonURL))
    }
}
#endif
