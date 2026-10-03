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

    func testJSONReloadBecomesRollbackBaselineAndSurvivesSaveRetry() async throws {
        let directory = try directory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let url = directory.appendingPathComponent("config.json")
        let original = fixture()
        try JSONEncoder().encode(original).write(to: url)
        let store = ProductionProviderPersistence(fileURL: url)
        var synced = original
        synced.modelGroups[0].name = "Synced organization"
        synced.modelGroups.append(ModelGroup(id: "synced-only", name: "Keep synced group", memberEntryIds: []))
        let syncedBytes = try JSONEncoder().encode(synced)
        try syncedBytes.write(to: url, options: .atomic)
        await store.reloadFromDisk()
        XCTAssertEqual(store.config, synced)

        let journal = ProviderSnapshotJournal.markerURL(for: url)
        try FileManager.default.createDirectory(at: journal, withIntermediateDirectories: false)
        let binding = SessionModelBinding(sessionId: "retry", primarySource: .directEntry(modelEntryId: original.modelEntries[0].id))
        XCTAssertFalse(store.setBinding(binding, for: "retry"))
        XCTAssertEqual(store.config, synced)
        XCTAssertEqual(try Data(contentsOf: url), syncedBytes)

        try FileManager.default.removeItem(at: journal)
        XCTAssertTrue(store.setBinding(binding, for: "retry"))
        var expected = synced
        expected.sessionBindings["retry"] = binding
        XCTAssertEqual(store.config, expected)
        XCTAssertEqual(try JSONDecoder().decode(ProviderConfig.self, from: Data(contentsOf: url)), expected)
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

    func testGroupCreateUpdateAndReorderFailuresReturnFalseAndRestoreOrganization() throws {
        let directory = try directory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let url = directory.appendingPathComponent("config.json")
        var original = fixture()
        original.modelGroups.append(ModelGroup(id: "second", name: "Second", memberEntryIds: []))
        let bytes = try JSONEncoder().encode(original)
        try bytes.write(to: url)
        let store = ProductionProviderPersistence(fileURL: url)
        try FileManager.default.createDirectory(at: ProviderSnapshotJournal.markerURL(for: url), withIntermediateDirectories: false)
        XCTAssertFalse(store.addGroup(ModelGroup(id: "new-group", name: "Must not survive", memberEntryIds: [])))
        XCTAssertEqual(store.config, original)
        var edited = original.modelGroups[0]
        edited.name = "Must roll back"
        edited.memberEntryIds.removeFirst()
        XCTAssertFalse(store.updateGroup(edited))
        XCTAssertEqual(store.config, original)
        XCTAssertFalse(store.updateGroup(ModelGroup(id: "missing", name: "Missing", memberEntryIds: [])))
        XCTAssertFalse(store.reorderGroups(["second", "group"]))
        XCTAssertEqual(store.config, original)
        XCTAssertEqual(try Data(contentsOf: url), bytes)
    }

    func testFailedGroupDeletePreservesDefaultsFavoritesRecentsAndNeverDispatchesDelete() async throws {
        let directory = try directory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let url = directory.appendingPathComponent("config.json")
        var original = fixture()
        original.defaultSubGroupId = "group"
        original.agentLoopGroupIds = ["group"]
        let bytes = try JSONEncoder().encode(original)
        try bytes.write(to: url)
        let store = ProductionProviderPersistence(fileURL: url)
        let defaults = SharedContainerStore.sharedDefaults ?? .standard
        let keys = ["leo.model.pinned.v1", "leo.model.recents.v1"]
        let previous = keys.map { defaults.object(forKey: $0) }
        defer {
            for (key, value) in zip(keys, previous) {
                if let value { defaults.set(value, forKey: key) } else { defaults.removeObject(forKey: key) }
            }
        }
        let choices = ["group:group", "unrelated/model"]
        for key in keys { defaults.set(choices, forKey: key) }
        ChatStore.shared.dirtyCalls.removeAll()
        try FileManager.default.createDirectory(at: ProviderSnapshotJournal.markerURL(for: url), withIntermediateDirectories: false)
        XCTAssertFalse(store.removeGroup("group"))
        XCTAssertEqual(store.config, original)
        XCTAssertEqual(try Data(contentsOf: url), bytes)
        XCTAssertEqual(ModelSwitcher.pinnedKeys, choices)
        XCTAssertEqual(ModelSwitcher.recentKeys, choices)
        await Task.yield()
        XCTAssertFalse(ChatStore.shared.dirtyCalls.contains {
            $0.recordType == "ProviderModelGroupV3" && $0.recordId == "group" && $0.operation == "delete"
        })
    }

    func testAcceptedGroupDeletePersistsThenCleansOnlyItsChoicesAndDispatchesDelete() async throws {
        let directory = try directory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let url = directory.appendingPathComponent("config.json")
        let db = try ProviderConfigDB(url: directory.appendingPathComponent("config.db"))
        var original = fixture()
        let voice = ModelEntry(providerInstanceId: original.instances[0].id,
                               model: LLMModel(id: "voice", displayName: "Voice", provider: "OpenAI", modalityOverride: .audioOutput))
        original.modelEntries.append(voice)
        original.modelGroups = [ModelGroup(id: "remaining", name: "Empty", memberEntryIds: []),
                                ModelGroup(id: "voice-only", name: "Voice", memberEntryIds: [voice.id])] + original.modelGroups
        original.defaultSubGroupId = "group"
        original.voiceInputGroupId = "group"
        original.voiceOutputGroupId = "group"
        original.agentLoopGroupIds = ["group", "remaining"]
        let store = ProductionProviderPersistence(fileURL: url, initial: original, db: db)
        let defaults = SharedContainerStore.sharedDefaults ?? .standard
        let keys = ["leo.model.pinned.v1", "leo.model.recents.v1"]
        let previous = keys.map { defaults.object(forKey: $0) }
        defer {
            for (key, value) in zip(keys, previous) {
                if let value { defaults.set(value, forKey: key) } else { defaults.removeObject(forKey: key) }
            }
        }
        for key in keys { defaults.set(["group:group", "group:remaining", "unrelated/model"], forKey: key) }
        ChatStore.shared.dirtyCalls.removeAll()
        XCTAssertTrue(store.removeGroup("group"))
        XCTAssertEqual(store.config.modelGroups.map(\.id), ["remaining", "voice-only"])
        XCTAssertNil(store.config.defaultPrimaryGroupId)
        XCTAssertNil(store.config.defaultSubGroupId)
        XCTAssertNil(store.config.voiceInputGroupId)
        XCTAssertNil(store.config.voiceOutputGroupId)
        XCTAssertEqual(store.config.agentLoopGroupIds, ["remaining"])
        XCTAssertEqual(store.config.deletedModelGroups.map(\.id), ["group"])
        XCTAssertEqual(ModelSwitcher.pinnedKeys, ["group:remaining", "unrelated/model"])
        XCTAssertEqual(ModelSwitcher.recentKeys, ["group:remaining", "unrelated/model"])
        await store.drainWrites()
        XCTAssertEqual(try JSONDecoder().decode(ProviderConfig.self, from: Data(contentsOf: url)), store.config)
        let mirrored = await db.dumpProviderConfig()
        XCTAssertEqual(mirrored.modelGroups, store.config.modelGroups)
        XCTAssertTrue(ChatStore.shared.dirtyCalls.contains {
            $0.recordType == "ProviderModelGroupV3" && $0.recordId == "group" && $0.operation == "delete"
        })
    }

    func testBootstrapAdmissionGatePreventsStaleJSONTemplateMigrationFromOverwritingNewerDatabase() async throws {
        let directory = try directory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let url = directory.appendingPathComponent("config.json")
        let db = try ProviderConfigDB(url: directory.appendingPathComponent("config.db"))
        var stale = fixture()
        stale.instances[0].customBaseURL = "https://voice-fixture.invalid"
        let staleBytes = try JSONEncoder().encode(stale)
        try staleBytes.write(to: url)
        var newer = stale
        newer.modelGroups[0].name = "Newer authoritative organization"
        newer.modelGroups.append(ModelGroup(id: "db-only", name: "Do not lose", memberEntryIds: []))
        let saved = await db.bulkReplace(from: newer)
        XCTAssertTrue(saved)
        let priorTemplates = VoiceProviderTemplate.testModelsByBaseURL
        defer { VoiceProviderTemplate.testModelsByBaseURL = priorTemplates }
        VoiceProviderTemplate.testModelsByBaseURL["https://voice-fixture.invalid"] = [
            LLMModel(id: "new-template-voice", displayName: "New voice", provider: "OpenAI", modalityOverride: .audioOutput)
        ]

        // The actual migration and save bodies execute with the same closed
        // admission state as first-frame startup. Full app startup/DB opening
        // is source-reviewed; authority selection below is a test-host seam.
        let loading = ProductionProviderPersistence(fileURL: url, db: db, persistenceReady: false)
        loading.ensureVoiceTemplateModels()
        XCTAssertFalse(loading.setBinding(SessionModelBinding(sessionId: "early", primarySource: .directEntry(modelEntryId: "other")), for: "early"))
        XCTAssertEqual(loading.config, stale)
        XCTAssertEqual(try Data(contentsOf: url), staleBytes)
        XCTAssertNil(ProviderSnapshotJournal.pendingToken(for: url))
        let recovery = await loading.recoverPendingSnapshot()
        XCTAssertTrue(recovery)
        let stillAuthoritative = await db.dumpProviderConfig()
        XCTAssertEqual(stillAuthoritative, newer)

        let ready = ProductionProviderPersistence(fileURL: url, initial: stillAuthoritative, db: db)
        ready.ensureVoiceTemplateModels()
        await ready.drainWrites()
        XCTAssertEqual(ready.config.modelGroups, newer.modelGroups)
        XCTAssertTrue(ready.config.modelEntries.contains { $0.baseModel.id == "new-template-voice" })
        let migrated = await db.dumpProviderConfig()
        XCTAssertEqual(migrated.modelGroups, newer.modelGroups)
        XCTAssertTrue(migrated.modelEntries.contains { $0.baseModel.id == "new-template-voice" })
        XCTAssertNil(ProviderSnapshotJournal.pendingToken(for: url))
    }

    func testDatabaseRestartRetainsDeletionIntentEvenIfDormantArchiveCleanupWasInterrupted() async throws {
        let directory = try directory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let url = directory.appendingPathComponent("config.json")
        let dbURL = directory.appendingPathComponent("config.db")
        let db = try ProviderConfigDB(url: dbURL)
        let original = fixture()
        let deleted = original.modelEntries[0]
        let store = ProductionProviderPersistence(fileURL: url, initial: original, db: db)
        XCTAssertTrue(store.replaceEntries(for: original.instances[0].id, models: [original.modelEntries[1].baseModel]))
        await store.drainWrites()
        let archiveURL = url.appendingPathExtension("model-archive")
        let staleArchive = try Data(contentsOf: archiveURL)
        XCTAssertTrue(store.removeEntry(deleted.id))
        await store.drainWrites()
        // Deterministically reproduce the disk state of a process ending after
        // durable delete admission but before best-effort archive cleanup.
        try staleArchive.write(to: archiveURL, options: .atomic)
        let reopened = try ProviderConfigDB(url: dbURL)
        let authoritative = await reopened.dumpProviderConfig()
        XCTAssertTrue(authoritative.deletedModelEntries.contains { $0.id == deleted.id })
        let restarted = ProductionProviderPersistence(fileURL: url, initial: authoritative, db: reopened)
        XCTAssertTrue(restarted.replaceEntries(for: original.instances[0].id, models: original.modelEntries.map(\.baseModel)))
        let returned = try XCTUnwrap(restarted.config.modelEntries.first { $0.id == deleted.id })
        XCTAssertNotEqual(returned.uuid, deleted.uuid)
        XCTAssertEqual(returned.overrides, ModelOverrides())
        XCTAssertFalse(returned.isHidden)
        await restarted.drainWrites()
    }

    func testMetadataImportAndCustomEntryFailuresNeverReportSuccessOrPersistPartialProvider() throws {
        let directory = try directory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let url = directory.appendingPathComponent("config.json")
        let original = fixture()
        let bytes = try JSONEncoder().encode(original)
        try bytes.write(to: url)
        let incoming = ProviderInstance(id: "new-provider", label: "Imported", providerType: .openAI, credentialType: .apiKey)
        let imported = ModelEntry(providerInstanceId: incoming.id,
                                  model: LLMModel(id: "same-model", displayName: "Same", provider: "OpenAI", modalityOverride: .textOnly))
        let loading = ProductionProviderPersistence(fileURL: url, persistenceReady: false)
        XCTAssertFalse(loading.importMetadata(incoming, entries: [imported]))
        XCTAssertEqual(loading.config, original)
        XCTAssertNil(ProviderSnapshotJournal.pendingToken(for: url))

        let store = ProductionProviderPersistence(fileURL: url)
        try FileManager.default.createDirectory(at: ProviderSnapshotJournal.markerURL(for: url), withIntermediateDirectories: false)
        XCTAssertFalse(store.importMetadata(incoming, entries: [imported]))
        XCTAssertEqual(store.config, original)
        let custom = ModelEntry(providerInstanceId: original.instances[0].id,
                                model: LLMModel(id: "custom", displayName: "Custom", provider: "OpenAI", modalityOverride: .textOnly), isCustom: true)
        XCTAssertFalse(store.addEntry(custom))
        XCTAssertEqual(store.config, original)
        XCTAssertEqual(try Data(contentsOf: url), bytes)
    }

    func testMetadataImportAdmitsOneSnapshotAndKeepsSameModelOnSeparateProviders() async throws {
        let directory = try directory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let url = directory.appendingPathComponent("config.json")
        let db = try ProviderConfigDB(url: directory.appendingPathComponent("config.db"))
        let original = fixture()
        let store = ProductionProviderPersistence(fileURL: url, initial: original, db: db)
        let incoming = ProviderInstance(id: "new-provider", label: "Imported", providerType: .openAI,
                                        credentialType: .apiKey, createdAt: Date(timeIntervalSince1970: 400))
        let imported = ModelEntry(uuid: "new-provider-model", providerInstanceId: incoming.id,
                                  model: original.modelEntries[0].baseModel,
                                  overrides: .init(displayName: "Imported override", maxThinkingLevel: .high), isHidden: true)
        XCTAssertTrue(store.importMetadata(incoming, entries: [imported, imported]))
        XCTAssertEqual(store.configRevision, 1)
        XCTAssertEqual(store.config.instances.map(\.id), [original.instances[0].id, incoming.id])
        XCTAssertEqual(store.config.modelEntries.count, original.modelEntries.count + 1)
        XCTAssertEqual(store.config.modelEntries.prefix(original.modelEntries.count), original.modelEntries[...])
        XCTAssertEqual(store.config.modelEntries.last?.uuid, imported.uuid)
        XCTAssertEqual(store.config.modelEntries.last?.overrides, imported.overrides)
        XCTAssertEqual(store.config.modelEntries.last?.isHidden, true)
        XCTAssertEqual(store.config.modelGroups, original.modelGroups)
        XCTAssertEqual(store.config.sessionBindings, original.sessionBindings)
        await store.drainWrites()
        let restored = await db.dumpProviderConfig()
        let index = try XCTUnwrap(store.config.modelEntries.firstIndex { $0.uuid == imported.uuid })
        let stamp = try XCTUnwrap(store.config.modelEntries[index].userModifiedAt)
        let restoredStamp = try XCTUnwrap(restored.modelEntries.first { $0.uuid == imported.uuid }?.userModifiedAt)
        // SQLite's established date representation is Unix-seconds Double;
        // converting from Date's reference epoch can round below a microsecond.
        // Normalize only that representation, keeping every metadata field exact.
        XCTAssertEqual(restoredStamp.timeIntervalSinceReferenceDate, stamp.timeIntervalSinceReferenceDate, accuracy: 0.000001)
        var databaseExpected = store.config
        databaseExpected.modelEntries[index].userModifiedAt = Date(timeIntervalSince1970: stamp.timeIntervalSince1970)
        XCTAssertEqual(restored, databaseExpected)
        XCTAssertEqual(try JSONDecoder().decode(ProviderConfig.self, from: Data(contentsOf: url)), store.config)
    }

    func testSingleModelEditFailureRetainsAcceptedMetadataAndSameInputCanRetry() throws {
        let directory = try directory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let url = directory.appendingPathComponent("config.json")
        let original = fixture()
        let bytes = try JSONEncoder().encode(original)
        try bytes.write(to: url)
        let store = ProductionProviderPersistence(fileURL: url)
        var edited = original.modelEntries[0]
        edited.overrides.displayName = "Retry this name"
        edited.overrides.contextWindow = 256000
        edited.isHidden = false
        let journal = ProviderSnapshotJournal.markerURL(for: url)
        try FileManager.default.createDirectory(at: journal, withIntermediateDirectories: false)
        XCTAssertFalse(store.updateEntry(edited))
        XCTAssertEqual(store.config, original)
        XCTAssertEqual(try Data(contentsOf: url), bytes)
        XCTAssertEqual(store.configRevision, 0)

        try FileManager.default.removeItem(at: journal)
        XCTAssertTrue(store.updateEntry(edited))
        let accepted = try XCTUnwrap(store.config.modelEntries.first { $0.id == edited.id })
        XCTAssertEqual(accepted.uuid, edited.uuid)
        XCTAssertEqual(accepted.baseModel, edited.baseModel)
        XCTAssertEqual(accepted.overrides, edited.overrides)
        XCTAssertEqual(accepted.isHidden, edited.isHidden)
        XCTAssertNotNil(accepted.userModifiedAt)
        XCTAssertEqual(store.config.modelGroups, original.modelGroups)
        XCTAssertEqual(store.config.sessionBindings, original.sessionBindings)
        XCTAssertEqual(store.config.defaultPrimaryGroupId, original.defaultPrimaryGroupId)
        XCTAssertEqual(store.configRevision, 1)
        XCTAssertEqual(try JSONDecoder().decode(ProviderConfig.self, from: Data(contentsOf: url)), store.config)
        let missing = ModelEntry(providerInstanceId: edited.providerInstanceId,
                                 model: LLMModel(id: "missing", displayName: "Missing", provider: "OpenAI", modalityOverride: .textOnly))
        XCTAssertFalse(store.updateEntry(missing))
        XCTAssertEqual(store.configRevision, 1)
    }
}
#endif
