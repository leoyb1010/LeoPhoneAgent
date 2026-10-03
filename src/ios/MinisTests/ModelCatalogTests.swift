#if NATIVE_MODEL_AUDIT
import XCTest

/// Synthetic fixtures only: no live providers, credentials or shared defaults.
final class ModelCatalogTests: XCTestCase {
    private func entry(_ modelID: String = "org/model:latest", provider: String = "provider-a",
                       uuid: String = "legacy-a", name: String = "Shared model",
                       overrides: ModelOverrides = .init(), hidden: Bool = false,
                       custom: Bool = false, modified: Date? = nil) -> ModelEntry {
        ModelEntry(uuid: uuid, providerInstanceId: provider,
                   model: LLMModel(id: modelID, displayName: name, provider: "OpenAI",
                                   modalityOverride: .textOnly),
                   overrides: overrides, isCustom: custom, isHidden: hidden,
                   userModifiedAt: modified)
    }

    func testSameModelNameAndIDInDifferentProvidersRemainDistinct() {
        let a = entry()
        let b = entry(provider: "provider-b", uuid: "legacy-b")
        let projected = ModelCatalog.entries([b, a, a], providerOrder: ["provider-a", "provider-b"])
        XCTAssertEqual(projected.map(\.id), [a.id, b.id])
        XCTAssertEqual(Set(projected.map(\.id)).count, 2)
    }

    func testIdentityRetainsModelSeparatorsAndCase() {
        let a = entry("org/model:latest")
        let b = entry("org/Model:latest", uuid: "legacy-b")
        XCTAssertNotEqual(a.id, b.id)
        XCTAssertEqual(a.id, "provider-a/org/model:latest")
        XCTAssertEqual(ModelCatalog.entries([a, b], providerOrder: []).count, 2)
    }

    func testDeterministicDuplicateRepresentativeKeepsNewestUserOverlay() {
        let old = entry(uuid: "aaa")
        let edited = entry(uuid: "zzz", overrides: .init(displayName: "My model", maxThinkingLevel: .high),
                           hidden: true, modified: Date(timeIntervalSince1970: 100))
        let result = ModelCatalog.entries([old, edited], providerOrder: [])
        XCTAssertEqual(result, ModelCatalog.entries([edited, old], providerOrder: []))
        XCTAssertEqual(result.first?.uuid, "aaa")
        XCTAssertEqual(result.first?.model.displayName, "My model")
        XCTAssertEqual(result.first?.overrides.maxThinkingLevel, .high)
        XCTAssertEqual(result.first?.isHidden, true)
        XCTAssertEqual(result.first?.userModifiedAt, edited.userModifiedAt)
    }

    func testUntimestampedLegacyOverlaySurvivesDuplicateCollapse() {
        let old = entry(uuid: "aaa")
        let edited = entry(uuid: "zzz", overrides: .init(displayName: "Legacy favorite"), hidden: true)
        let result = ModelCatalog.representative([old, edited])
        XCTAssertEqual(result?.model.displayName, "Legacy favorite")
        XCTAssertEqual(result?.isHidden, true)
        XCTAssertNil(result?.userModifiedAt)
    }

    func testLegacyCustomDuplicateCannotEraseAnotherRowsHiddenIntent() {
        let custom = entry(uuid: "aaa", overrides: .init(contextWindow: 128000), custom: true)
        let hidden = entry(uuid: "zzz", overrides: .init(displayName: "Keep name"), hidden: true)
        let result = ModelCatalog.representative([custom, hidden])
        XCTAssertEqual(result?.isHidden, true)
        XCTAssertEqual(result?.overrides.displayName, "Keep name")
        XCTAssertEqual(result?.overrides.contextWindow, 128000)
        XCTAssertEqual(result, ModelCatalog.representative([hidden, custom]))
    }

    func testLatestExplicitClearBeatsOlderCustomization() {
        let edited = entry(uuid: "aaa", overrides: .init(displayName: "Old name"), hidden: true,
                           modified: Date(timeIntervalSince1970: 100))
        let cleared = entry(uuid: "zzz", modified: Date(timeIntervalSince1970: 200))
        let result = ModelCatalog.representative([cleared, edited])
        XCTAssertEqual(result?.isHidden, false)
        XCTAssertEqual(result?.overrides, ModelOverrides())
    }

    func testProviderOrderWinsOverStorageOrNameOrder() {
        let a = entry("z", provider: "a", uuid: "a")
        let b = entry("b", provider: "b", uuid: "b")
        let c = entry("a", provider: "b", uuid: "c")
        let projected = ModelCatalog.entries([a, b, c], providerOrder: ["b", "a"])
        XCTAssertEqual(projected.map(\.id), [c.id, b.id, a.id])
        XCTAssertEqual(projected, ModelCatalog.entries([c, a, b], providerOrder: ["b", "a"]))
    }

    func testLegacyAliasesDeduplicateWithoutDroppingUnresolvedFavorites() {
        let e = entry()
        let pending = "missing-provider/missing/model:v2"
        XCTAssertEqual(ModelCatalog.normalizedKeys([e.uuid, pending, e.legacyColonCompositeKey, e.id, pending],
                                                   entries: [e]), [e.id, pending])
    }

    func testOrderedFavoritesUseStoredOrderAndKeepProviderIdentity() {
        let a = entry()
        let b = entry(provider: "provider-b", uuid: "legacy-b")
        XCTAssertEqual(ModelCatalog.orderedEntries(keys: [b.uuid, a.id, b.id], entries: [a, b]).map(\.id),
                       [b.id, a.id])
    }

    func testTemporaryMissingFavoriteReturnsInSamePlace() {
        let a = entry()
        let b = entry(provider: "provider-b", uuid: "legacy-b")
        let saved = [b.id, a.id]
        XCTAssertEqual(ModelCatalog.orderedEntries(keys: saved, entries: [a]).map(\.id), [a.id])
        XCTAssertEqual(ModelCatalog.normalizedKeys(saved, entries: [a]), saved)
        XCTAssertEqual(ModelCatalog.orderedEntries(keys: saved, entries: [a, b]).map(\.id), saved)
    }

    func testSearchMatchesProviderAndModelIDAcrossTerms() {
        let e = entry(overrides: .init(displayName: "Friendly name"))
        XCTAssertTrue(ModelCatalog.matches("  proxy  org/model:latest\n", entry: e, providerLabel: "My Proxy"))
        XCTAssertTrue(ModelCatalog.matches("shared", entry: e, providerLabel: "Proxy"))
        XCTAssertTrue(ModelCatalog.matches("friendly", entry: e, providerLabel: "Proxy"))
        XCTAssertFalse(ModelCatalog.matches("another-provider latest", entry: e, providerLabel: "Proxy"))
    }

    func testSearchHandlesWhitespaceCaseDiacriticsAndWidth() {
        XCTAssertTrue(ModelCatalog.matches("\n \t", text: "Anything"))
        XCTAssertTrue(ModelCatalog.matches("CAFE model", text: "Café Ｍｏｄｅｌ"))
        XCTAssertTrue(ModelCatalog.matches("中转 快速", text: "快速模型 · 中转供应商"))
    }

    func testGroupNormalizationPreservesEmptyAndUnresolvedGroups() {
        let empty = ModelGroup(id: "empty", name: "My empty group", memberEntryIds: [])
        XCTAssertEqual(ModelCatalog.normalizedGroup(empty, aliases: [:]), empty)
        let group = ModelGroup(id: "group", name: "Fallback", memberEntryIds: ["missing/model:v1", "unknown-uuid"])
        XCTAssertEqual(ModelCatalog.normalizedGroup(group, aliases: [:]), group)
    }

    func testGroupNormalizationRetainsOrderStrategyAndTimestamps() {
        let e = entry()
        let early = Date(timeIntervalSince1970: 100)
        let late = Date(timeIntervalSince1970: 200)
        let group = ModelGroup(id: "g", name: "Ordered", memberEntryIds: ["pending/model", e.uuid, e.id],
                               strategy: .loadBalance, fallbackStrategy: .always, defaultThinkingLevel: .high,
                               contextLimitTokens: 64000, lastContextLimitTokens: 128000,
                               addedMembers: [e.uuid: early, e.id: late], removedMembers: ["missing": early])
        let result = ModelCatalog.normalizedGroup(group, aliases: ModelCatalog.aliases(entries: [e]))
        XCTAssertEqual(result.memberEntryIds, ["pending/model", e.id])
        XCTAssertEqual(result.addedMembers, [e.id: late])
        XCTAssertEqual(result.removedMembers, group.removedMembers)
        XCTAssertEqual(result.strategy, group.strategy)
        XCTAssertEqual(result.fallbackStrategy, group.fallbackStrategy)
        XCTAssertEqual(result.defaultThinkingLevel, group.defaultThinkingLevel)
        XCTAssertEqual(result.contextLimitTokens, group.contextLimitTokens)
        XCTAssertEqual(result.lastContextLimitTokens, group.lastContextLimitTokens)
        XCTAssertEqual(ModelCatalog.normalizedGroup(result, aliases: ModelCatalog.aliases(entries: [e])), result)
    }

    func testRefreshPreservesLegacyUUIDAndAllUserOverrides() {
        let overrides = ModelOverrides(displayName: "Custom", maxOutputTokens: 4096,
                                       modalityOverride: .vision, contextWindow: 128000,
                                       supportsReasoning: true, maxThinkingLevel: .xhigh)
        let original = entry(overrides: overrides, hidden: true, custom: true,
                             modified: Date(timeIntervalSince1970: 123))
        let refreshed = original.replacingBaseModel(
            LLMModel(id: original.baseModel.id, displayName: "API new name", provider: "OpenAI",
                     modalityOverride: .textOnly), isCustom: false)
        XCTAssertEqual(refreshed.id, original.id)
        XCTAssertEqual(refreshed.uuid, original.uuid)
        XCTAssertEqual(refreshed.providerInstanceId, original.providerInstanceId)
        XCTAssertEqual(refreshed.overrides, overrides)
        XCTAssertEqual(refreshed.isHidden, original.isHidden)
        XCTAssertEqual(refreshed.userModifiedAt, original.userModifiedAt)
        XCTAssertFalse(refreshed.isCustom)
        XCTAssertEqual(refreshed.model.displayName, "Custom")
    }

    func testEntryCodableRoundTripAndLegacyMissingUUID() throws {
        let original = entry(overrides: .init(displayName: "My model", maxThinkingLevel: .high),
                             hidden: true, modified: Date(timeIntervalSince1970: 100))
        let encoded = try JSONEncoder().encode(original)
        XCTAssertEqual(try JSONDecoder().decode(ModelEntry.self, from: encoded), original)
        var legacy = try XCTUnwrap(JSONSerialization.jsonObject(with: encoded) as? [String: Any])
        legacy.removeValue(forKey: "uuid")
        legacy.removeValue(forKey: "userModifiedAt")
        let old = try JSONDecoder().decode(ModelEntry.self, from: JSONSerialization.data(withJSONObject: legacy))
        XCTAssertEqual(old.id, original.id)
        XCTAssertNotNil(UUID(uuidString: old.uuid))
        XCTAssertEqual(old.overrides, original.overrides)
        XCTAssertTrue(old.isHidden)
    }

    func testReorderKeepsUnavailableSlotsAndOtherPreferences() {
        let keys = ["a", "unavailable", "b", "c"]
        XCTAssertEqual(ModelCatalog.reorderedKeys(keys, visibleKeys: ["a", "b", "c"],
                                                  from: IndexSet(integer: 2), to: 0),
                       ["c", "unavailable", "a", "b"])
        XCTAssertEqual(ModelCatalog.reorderedKeys(keys, visibleKeys: ["a", "b", "c"],
                                                  from: IndexSet([0, 2]), to: 3),
                       ["b", "unavailable", "a", "c"])
    }

    func testStaleAndInvalidReordersAreNoOps() {
        let keys = ["a", "b"]
        XCTAssertEqual(ModelCatalog.reorderedKeys(keys, visibleKeys: keys, from: IndexSet(integer: 9), to: 0), keys)
        XCTAssertEqual(ModelCatalog.reorderedKeys(keys, visibleKeys: keys, from: IndexSet(integer: 0), to: 9), keys)
        XCTAssertEqual(ModelCatalog.reorderedKeys(keys, visibleKeys: ["missing"], from: IndexSet(integer: 0), to: 0), keys)
        XCTAssertEqual(ModelCatalog.reorderedKeys(keys, visibleKeys: ["a", "a"], from: IndexSet(integer: 0), to: 0), keys)
    }

    func testLegacySnapshotRoundTripRollbackLeavesUnrelatedDefaultsUntouched() throws {
        struct Snapshot: Codable, Equatable {
            var entries: [ModelEntry]
            var groups: [ModelGroup]
            var defaultGroupID: String?
            var currentBinding: SessionModelBinding
        }
        let e = entry()
        let empty = ModelGroup(id: "empty", name: "Draft group", memberEntryIds: [])
        let group = ModelGroup(id: "default", name: "Default", memberEntryIds: [e.uuid, "pending/model"])
        let original = Snapshot(entries: [e], groups: [empty, group], defaultGroupID: group.id,
                                currentBinding: SessionModelBinding(sessionId: "session",
                                    primarySource: .directEntry(modelEntryId: e.uuid, compositeKey: e.id)))
        let suiteName = "ModelCatalogTests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        defaults.set("keep", forKey: "unrelated.preference")
        defaults.set([e.uuid, "pending/model"], forKey: "leo.model.pinned.v1")
        let backup = try JSONEncoder().encode(original)
        var changed = try JSONDecoder().decode(Snapshot.self, from: backup)
        changed.groups = changed.groups.map { ModelCatalog.normalizedGroup($0, aliases: ModelCatalog.aliases(entries: changed.entries)) }
        let roundTrip = try JSONDecoder().decode(Snapshot.self, from: JSONEncoder().encode(changed))
        XCTAssertEqual(roundTrip.groups.map(\.id), original.groups.map(\.id))
        XCTAssertEqual(roundTrip.groups[1].memberEntryIds, [e.id, "pending/model"])
        XCTAssertEqual(roundTrip.defaultGroupID, original.defaultGroupID)
        XCTAssertEqual(roundTrip.currentBinding, original.currentBinding)
        XCTAssertEqual(try JSONDecoder().decode(Snapshot.self, from: backup), original)
        XCTAssertEqual(defaults.string(forKey: "unrelated.preference"), "keep")
        XCTAssertEqual(defaults.stringArray(forKey: "leo.model.pinned.v1"), [e.uuid, "pending/model"])
    }

    func testThousandEntryCatalogIsStableAndSearchable() {
        let entries = (0..<1000).map { entry("model-\($0)", provider: "provider-\($0 % 10)", uuid: "row-\($0)") }
        let order = (0..<10).reversed().map { "provider-\($0)" }
        let forward = ModelCatalog.entries(entries, providerOrder: order)
        let reverse = ModelCatalog.entries(Array(entries.reversed()), providerOrder: order)
        XCTAssertEqual(forward, reverse)
        XCTAssertEqual(forward.count, 1000)
        XCTAssertEqual(forward.filter { ModelCatalog.matches("model-999", entry: $0, providerLabel: "Fixture") }.count, 1)
    }

    func testOmittedHiddenModelReturnsWithOriginalIdentityAndOverridesAfterRestart() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let url = directory.appendingPathComponent("archive.json")
        let a = entry("a", overrides: .init(displayName: "Private name", maxThinkingLevel: .high),
                      hidden: true, modified: Date(timeIntervalSince1970: 100))
        let b = entry("b", uuid: "legacy-b")
        let group = ModelGroup(id: "g", name: "Keep order", memberEntryIds: [a.id, b.id])
        let favoriteKeys = [a.uuid, b.id]
        let omitted = try ModelCatalogArchive.refresh(instanceId: a.providerInstanceId,
            activeEntries: [a, b], models: [b.baseModel], at: url)
        XCTAssertEqual(omitted.entries.map(\.id), [b.id])
        XCTAssertFalse(omitted.entries.contains { $0.id == a.id })
        XCTAssertEqual(omitted.aliases[a.uuid], a.id)
        // A fresh invocation reads the disk archive; no retained in-memory object.
        let restored = try ModelCatalogArchive.refresh(instanceId: a.providerInstanceId,
            activeEntries: omitted.entries, models: [a.baseModel, b.baseModel], at: url)
        let restoredA = try XCTUnwrap(restored.entries.first { $0.id == a.id })
        XCTAssertEqual(restoredA.uuid, a.uuid)
        XCTAssertEqual(restoredA.overrides, a.overrides)
        XCTAssertTrue(restoredA.isHidden)
        XCTAssertEqual(restoredA.userModifiedAt, a.userModifiedAt)
        XCTAssertEqual(group.memberEntryIds, [a.id, b.id])
        XCTAssertEqual(ModelCatalog.normalizedKeys(favoriteKeys, aliases: restored.aliases), [a.id, b.id])
    }

    func testArchiveRefreshUsesNewestActiveEditsAndDeduplicatesAPIModels() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let url = directory.appendingPathComponent("archive.json")
        let old = entry(overrides: .init(displayName: "Old"), modified: Date(timeIntervalSince1970: 100))
        _ = try ModelCatalogArchive.refresh(instanceId: old.providerInstanceId, activeEntries: [old], models: [], at: url)
        let latest = entry(overrides: .init(displayName: "Latest"), hidden: true, modified: Date(timeIntervalSince1970: 200))
        let result = try ModelCatalogArchive.refresh(instanceId: old.providerInstanceId, activeEntries: [latest],
                                                     models: [old.baseModel, old.baseModel], at: url)
        XCTAssertEqual(result.entries.count, 1)
        XCTAssertEqual(result.entries.first?.overrides.displayName, "Latest")
        XCTAssertEqual(result.entries.first?.isHidden, true)
    }

    func testCorruptAndFutureArchivesAreNeverOverwritten() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let url = directory.appendingPathComponent("archive.json")
        let e = entry(hidden: true)
        for text in ["corrupt bytes", "{\"version\":999,\"entries\":[]}"] {
            let original = Data(text.utf8)
            try original.write(to: url)
            XCTAssertThrowsError(try ModelCatalogArchive.refresh(instanceId: e.providerInstanceId,
                activeEntries: [e], models: [], at: url))
            XCTAssertEqual(try Data(contentsOf: url), original)
        }
    }

    func testFailedArchiveWriteDoesNotProduceDestructiveReplacement() throws {
        let missingDirectory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let url = missingDirectory.appendingPathComponent("archive.json")
        let e = entry(hidden: true)
        var active = [e]
        XCTAssertThrowsError(try {
            let prepared = try ModelCatalogArchive.refresh(instanceId: e.providerInstanceId,
                activeEntries: active, models: [], at: url)
            active = prepared.entries
        }())
        XCTAssertEqual(active, [e])
        XCTAssertFalse(FileManager.default.fileExists(atPath: url.path))
    }

    func testExplicitRemovalPurgesDormantMetadataOnlyForThatIdentity() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let url = directory.appendingPathComponent("archive.json")
        let a = entry(hidden: true)
        let other = entry(provider: "provider-b", uuid: "legacy-b", hidden: true)
        _ = try ModelCatalogArchive.refresh(instanceId: a.providerInstanceId, activeEntries: [a, other], models: [], at: url)
        let removed = try ModelCatalogArchive.remove(entryIds: [a.id], at: url)
        XCTAssertEqual(removed.map(\.id), [a.id])
        XCTAssertEqual(try ModelCatalogArchive.load(at: url).map(\.id), [other.id])
    }

    func testCustomModelsRemainAvailableWhileNonCustomOmissionsAreDormant() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let url = directory.appendingPathComponent("archive.json")
        let custom = entry("custom", custom: true)
        let discovered = entry("discovered", uuid: "legacy-discovered")
        let result = try ModelCatalogArchive.refresh(instanceId: custom.providerInstanceId,
            activeEntries: [custom, discovered], models: [], at: url)
        XCTAssertEqual(result.entries.map(\.id), [custom.id])
        XCTAssertEqual(Set(try ModelCatalogArchive.load(at: url).map(\.id)), [custom.id, discovered.id])
    }

    func testActiveLegacyRowWinsArchiveWhenModificationTimesAreEqualOrMissing() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let url = directory.appendingPathComponent("archive.json")
        let old = entry(uuid: "aaa", overrides: .init(displayName: "Old archive name"), hidden: true)
        _ = try ModelCatalogArchive.refresh(instanceId: old.providerInstanceId, activeEntries: [old], models: [], at: url)
        let current = entry(uuid: "zzz", overrides: .init(displayName: "Current name"))
        let result = try ModelCatalogArchive.refresh(instanceId: current.providerInstanceId,
            activeEntries: [current], models: [current.baseModel], at: url)
        XCTAssertEqual(result.entries.first?.uuid, current.uuid)
        XCTAssertEqual(result.entries.first?.overrides, current.overrides)
        XCTAssertEqual(result.entries.first?.isHidden, false)
        XCTAssertEqual(result.aliases[old.uuid], current.id)
    }

    func testInterruptedDeletionCleanupCannotRestoreArchivedOverrides() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let url = directory.appendingPathComponent("archive.json")
        let old = entry(overrides: .init(displayName: "Deleted customization"), hidden: true)
        _ = try ModelCatalogArchive.refresh(instanceId: old.providerInstanceId, activeEntries: [old], models: [], at: url)
        let rediscovered = try ModelCatalogArchive.refresh(instanceId: old.providerInstanceId,
            activeEntries: [], models: [old.baseModel], forgottenEntryIds: [old.id], at: url)
        XCTAssertEqual(rediscovered.entries.first?.overrides, ModelOverrides())
        XCTAssertNotEqual(rediscovered.entries.first?.uuid, old.uuid)
        XCTAssertEqual(rediscovered.entries.first?.isHidden, false)
    }

    func testJournalOlderCompletionCannotClearNewerSnapshot() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let url = directory.appendingPathComponent("config.json")
        let first = try ProviderSnapshotJournal.write(Data("first".utf8), to: url)
        let second = try ProviderSnapshotJournal.write(Data("second".utf8), to: url)
        ProviderSnapshotJournal.complete(first, for: url)
        XCTAssertEqual(ProviderSnapshotJournal.pendingToken(for: url), second)
        XCTAssertEqual(try Data(contentsOf: url), Data("second".utf8))
        ProviderSnapshotJournal.complete(second, for: url)
        XCTAssertNil(ProviderSnapshotJournal.pendingToken(for: url))
    }

    func testFailedJournalAdmissionKeepsPriorSnapshotBytes() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let url = directory.appendingPathComponent("config.json")
        let before = Data("prior valid snapshot".utf8)
        try before.write(to: url)
        // A directory at the marker path makes atomic file staging fail without
        // requiring elevated permissions or modifying a user-owned directory.
        try FileManager.default.createDirectory(at: ProviderSnapshotJournal.markerURL(for: url), withIntermediateDirectories: false)
        XCTAssertThrowsError(try ProviderSnapshotJournal.write(Data("replacement".utf8), to: url))
        XCTAssertEqual(try Data(contentsOf: url), before)
    }

    @MainActor
    func testSerialQueueKeepsRapidWritesInOrderWhileFirstIsSuspended() async {
        let queue = ModelCatalogWriteQueue()
        let entered = expectation(description: "First write entered")
        var release: CheckedContinuation<Void, Never>?
        var events: [String] = []
        queue.enqueue {
            events.append("first started")
            await withCheckedContinuation { continuation in
                release = continuation
                entered.fulfill()
            }
            events.append("first committed")
        }
        let second = queue.enqueue { events.append("second committed") }
        await fulfillment(of: [entered], timeout: 3)
        XCTAssertEqual(events, ["first started"])
        release?.resume()
        await second.value
        await queue.drain()
        XCTAssertEqual(events, ["first started", "first committed", "second committed"])
    }
}

#endif
