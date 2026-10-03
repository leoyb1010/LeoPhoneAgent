#if NATIVE_MODEL_AUDIT
import XCTest
import SQLite3

/// Executes the production SQLite actor against throwaway databases. Faults
/// come from SQLite triggers, not a replacement store or mocked write method.
final class ProviderConfigDBTests: XCTestCase {
    private func fixture() -> ProviderConfig {
        let provider = ProviderInstance(id: "11111111-1111-1111-1111-111111111111", label: "Fixture proxy",
            providerType: .openAI, credentialType: .apiKey, isEnabled: false,
            createdAt: Date(timeIntervalSince1970: 100), customBaseURL: "https://fixture.invalid",
            appendV1Suffix: false, imageEndpointMode: .chatCompletions,
            imageEndpointResolved: .chatCompletions, customUserAgent: "Fixture-UA", azureMode: true)
        let entry = ModelEntry(uuid: "22222222-2222-2222-2222-222222222222", providerInstanceId: provider.id,
            model: LLMModel(id: "org/model:v1", displayName: "Fixture", provider: "OpenAI", modalityOverride: .vision),
            overrides: ModelOverrides(displayName: "User name", maxOutputTokens: 4096, contextWindow: 128000,
                                      supportsReasoning: true, maxThinkingLevel: .high),
            isHidden: true, userModifiedAt: Date(timeIntervalSince1970: 200))
        let group = ModelGroup(id: "default-group", name: "Ordered fallback", memberEntryIds: [entry.uuid, "pending/model"],
            strategy: .fallback, fallbackStrategy: .always, defaultThinkingLevel: .high,
            contextLimitTokens: 64000, lastContextLimitTokens: 128000,
            addedMembers: [entry.uuid: Date(timeIntervalSince1970: 200)],
            removedMembers: ["removed/model": Date(timeIntervalSince1970: 100)])
        let empty = ModelGroup(id: "empty-group", name: "Unfinished custom group", memberEntryIds: [])
        let binding = SessionModelBinding(sessionId: "session", primarySource: .directEntry(modelEntryId: entry.uuid, compositeKey: entry.id),
                                        subModelSource: .group(groupId: group.id, resolvedEntryId: entry.id))
        return ProviderConfig(instances: [provider], modelEntries: [entry], modelGroups: [empty, group],
            defaultPrimaryGroupId: group.id, defaultSubGroupId: empty.id, sessionBindings: ["session": binding],
            agentLoopModelEntryIds: [entry.uuid, "pending/model"], agentLoopGroupIds: [group.id, empty.id],
            voiceInputGroupId: empty.id, voiceOutputGroupId: group.id,
            deletedInstances: [.init(id: "deleted-provider", deletedAt: Date(timeIntervalSince1970: 300))],
            deletedModelEntries: [.init(id: "deleted-provider/model", deletedAt: Date(timeIntervalSince1970: 300))],
            deletedModelGroups: [.init(id: "deleted-group", deletedAt: Date(timeIntervalSince1970: 300))])
    }

    private func directory() throws -> URL {
        let result = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: result, withIntermediateDirectories: true)
        return result
    }

    private func execute(_ sql: String, at url: URL) throws {
        var db: OpaquePointer?
        guard sqlite3_open(url.path, &db) == SQLITE_OK, let db else {
            throw NSError(domain: "ProviderConfigDBTests", code: 1)
        }
        defer { sqlite3_close(db) }
        guard sqlite3_exec(db, sql, nil, nil, nil) == SQLITE_OK else {
            throw NSError(domain: "ProviderConfigDBTests", code: 2,
                          userInfo: [NSLocalizedDescriptionKey: String(cString: sqlite3_errmsg(db))])
        }
    }

    func testProductionSQLiteRoundTripPreservesOrganizationAndMetadata() async throws {
        let directory = try directory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let db = try ProviderConfigDB(url: directory.appendingPathComponent("providers.db"))
        let original = fixture()
        let saved = await db.bulkReplace(from: original)
        XCTAssertTrue(saved)
        let restored = await db.dumpProviderConfig()
        XCTAssertEqual(restored, original)
        let encoded = try JSONEncoder().encode(restored)
        XCTAssertEqual(try JSONDecoder().decode(ProviderConfig.self, from: encoded), original)
        let reopened = try ProviderConfigDB(url: directory.appendingPathComponent("providers.db"))
        let coldStart = await reopened.dumpProviderConfig()
        XCTAssertEqual(coldStart, original)
    }

    func testBulkEditRetainsUUIDMapAndUnrelatedLocalPreferences() async throws {
        let directory = try directory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let url = directory.appendingPathComponent("providers.db")
        let db = try ProviderConfigDB(url: url)
        let original = fixture()
        let saved = await db.bulkReplace(from: original)
        XCTAssertTrue(saved)
        await db.setLegacyUuidMapKV("{\"legacy\":\"provider/model\"}")
        try execute("INSERT INTO provider_local_kv (key,value) VALUES ('unrelated.preference','keep-me')", at: url)
        var edited = original
        edited.modelGroups[1].name = "Renamed only"
        edited.defaultSubGroupId = nil
        let editedSaved = await db.bulkReplace(from: edited)
        XCTAssertTrue(editedSaved)
        let map = await db.localKV("legacyUuidMap")
        let unrelated = await db.localKV("unrelated.preference")
        let sub = await db.localKV("defaultSubGroupId")
        XCTAssertEqual(map, "{\"legacy\":\"provider/model\"}")
        XCTAssertEqual(unrelated, "keep-me")
        XCTAssertNil(sub)
        let restored = await db.dumpProviderConfig()
        XCTAssertEqual(restored, edited)
    }

    func testFailedModelInsertRollsBackAllDeletedRowsAndPreferences() async throws {
        let directory = try directory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let url = directory.appendingPathComponent("providers.db")
        let db = try ProviderConfigDB(url: url)
        let original = fixture()
        let saved = await db.bulkReplace(from: original)
        XCTAssertTrue(saved)
        await db.setLegacyUuidMapKV("keep-aliases")
        try execute("CREATE TRIGGER fail_model_write BEFORE INSERT ON provider_model_entries BEGIN SELECT RAISE(ABORT, 'synthetic model failure'); END", at: url)
        var replacement = original
        replacement.instances[0].label = "Must roll back"
        replacement.defaultPrimaryGroupId = nil
        let succeeded = await db.bulkReplace(from: replacement)
        XCTAssertFalse(succeeded)
        let restored = await db.dumpProviderConfig()
        XCTAssertEqual(restored, original)
        let aliases = await db.localKV("legacyUuidMap")
        XCTAssertEqual(aliases, "keep-aliases")
        try execute("DROP TRIGGER fail_model_write", at: url)
        let retried = await db.bulkReplace(from: replacement)
        XCTAssertTrue(retried)
        let afterRetry = await db.dumpProviderConfig()
        XCTAssertEqual(afterRetry, replacement)
    }

    func testFailedLocalSelectionWriteRollsBackModelAndGroupChanges() async throws {
        let directory = try directory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let url = directory.appendingPathComponent("providers.db")
        let db = try ProviderConfigDB(url: url)
        let original = fixture()
        let saved = await db.bulkReplace(from: original)
        XCTAssertTrue(saved)
        try execute("CREATE TRIGGER fail_local_write BEFORE INSERT ON provider_local_kv BEGIN SELECT RAISE(ABORT, 'synthetic preference failure'); END", at: url)
        var replacement = original
        replacement.modelGroups[1].name = "Must roll back"
        let succeeded = await db.bulkReplace(from: replacement)
        XCTAssertFalse(succeeded)
        let restored = await db.dumpProviderConfig()
        XCTAssertEqual(restored, original)
    }

    func testLegacyMigrationFailureDoesNotClaimSuccessOrDamageExistingStore() async throws {
        let directory = try directory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let url = directory.appendingPathComponent("providers.db")
        let jsonURL = directory.appendingPathComponent("legacy.json")
        let db = try ProviderConfigDB(url: url)
        let original = fixture()
        let saved = await db.bulkReplace(from: original)
        XCTAssertTrue(saved)
        try JSONEncoder().encode(original).write(to: jsonURL)
        try execute("CREATE TRIGGER fail_group_write BEFORE INSERT ON provider_model_groups BEGIN SELECT RAISE(ABORT, 'synthetic migration failure'); END", at: url)
        let migrated = await db.migrateFromLegacyJSON(at: jsonURL)
        XCTAssertFalse(migrated)
        let restored = await db.dumpProviderConfig()
        XCTAssertEqual(restored, original)
        try Data("not valid config".utf8).write(to: jsonURL)
        let corrupt = await db.migrateFromLegacyJSON(at: jsonURL)
        XCTAssertFalse(corrupt)
        let afterCorrupt = await db.dumpProviderConfig()
        XCTAssertEqual(afterCorrupt, original)
    }

    func testTombstoneWriteFailureRollsBackDeletionIntentAndAllOtherRows() async throws {
        let directory = try directory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let url = directory.appendingPathComponent("providers.db")
        let db = try ProviderConfigDB(url: url)
        let original = fixture()
        let saved = await db.bulkReplace(from: original)
        XCTAssertTrue(saved)
        try execute("CREATE TRIGGER fail_tombstone_write BEFORE INSERT ON provider_local_kv WHEN NEW.key = 'deletedModelEntries' BEGIN SELECT RAISE(ABORT, 'synthetic tombstone failure'); END", at: url)
        var replacement = original
        replacement.modelGroups[0].name = "Must roll back"
        replacement.deletedModelEntries.append(.init(id: "new-deletion", deletedAt: Date(timeIntervalSince1970: 400)))
        let failed = await db.bulkReplace(from: replacement)
        XCTAssertFalse(failed)
        let restored = await db.dumpProviderConfig()
        XCTAssertEqual(restored, original)
        try execute("DROP TRIGGER fail_tombstone_write", at: url)
        let retried = await db.bulkReplace(from: replacement)
        XCTAssertTrue(retried)
        let reopened = try ProviderConfigDB(url: url)
        let coldStart = await reopened.dumpProviderConfig()
        XCTAssertEqual(coldStart, replacement)
    }
}

#endif
