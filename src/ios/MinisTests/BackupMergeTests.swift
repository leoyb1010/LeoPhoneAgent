import Foundation
import XCTest

/// Pure merge rules (BackupMerge), including upstream's order-preservation
/// contract [T-backup-restore-order] re-expressed for the JSON-level provider
/// merge LeoBot uses.
final class BackupMergeTests: XCTestCase {

    private let t = Date(timeIntervalSince1970: 1_780_000_000)

    // MARK: - LWW

    func testDecideIsStrictlyNewerWinsAtSecondPrecision() {
        XCTAssertEqual(BackupMerge.decide(local: nil, incoming: t), .insert)
        XCTAssertEqual(BackupMerge.decide(local: t, incoming: t.addingTimeInterval(1)), .update)
        XCTAssertEqual(BackupMerge.decide(local: t, incoming: t), .keepLocal)
        XCTAssertEqual(BackupMerge.decide(local: t.addingTimeInterval(5), incoming: t), .keepLocal)
        // A package carries whole seconds: the same row read back must not
        // count as "newer" because the local copy kept its fraction.
        XCTAssertEqual(BackupMerge.decide(local: t.addingTimeInterval(0.73), incoming: t), .keepLocal)
    }

    func testFileDecision() {
        XCTAssertEqual(BackupMerge.decideFile(localExists: false, localSha: nil, localMtime: nil,
                                              packageSha: "a", packageMtime: nil), .write)
        XCTAssertEqual(BackupMerge.decideFile(localExists: true, localSha: "a", localMtime: t,
                                              packageSha: "a", packageMtime: 0), .identical)
        XCTAssertEqual(BackupMerge.decideFile(localExists: true, localSha: "b", localMtime: t,
                                              packageSha: "a", packageMtime: t.timeIntervalSince1970 + 10), .replace)
        XCTAssertEqual(BackupMerge.decideFile(localExists: true, localSha: "b", localMtime: t,
                                              packageSha: "a", packageMtime: t.timeIntervalSince1970 - 10), .keepLocal)
        XCTAssertEqual(BackupMerge.decideFile(localExists: true, localSha: "b", localMtime: t,
                                              packageSha: "a", packageMtime: nil), .keepLocal,
                       "a foreign package without mtimes never overwrites a different local file")
    }

    // MARK: - Providers

    private func inst(_ id: String, _ label: String = "") -> [String: Any] {
        ["id": id, "label": label.isEmpty ? id : label, "providerType": "openAI"]
    }

    private func ids(_ d: [String: Any], _ key: String) -> [String] {
        ((d[key] as? [[String: Any]]) ?? []).compactMap { $0["id"] as? String }
    }

    func testRestoreRebuildsInstanceOrderFromTheBackup() {
        let backup: [String: Any] = ["instances": [inst("C"), inst("A"), inst("B")]]
        let r = BackupMerge.mergeProviderConfig(local: ["instances": []], backup: backup, backupSnapshotAt: t)
        XCTAssertEqual(ids(r.merged, "instances"), ["C", "A", "B"])
        XCTAssertEqual(r.stats.instancesAdded, 3)
    }

    func testLocalOnlyInstancesFollowTheBackupsOrderAndLocalContentWins() {
        let local: [String: Any] = ["instances": [inst("X"), inst("A", "local label")]]
        let backup: [String: Any] = ["instances": [inst("B"), inst("A", "backup label")]]
        let r = BackupMerge.mergeProviderConfig(local: local, backup: backup, backupSnapshotAt: t)
        XCTAssertEqual(ids(r.merged, "instances"), ["B", "A", "X"])
        let a = (r.merged["instances"] as? [[String: Any]])?.first { $0["id"] as? String == "A" }
        XCTAssertEqual(a?["label"] as? String, "local label", "same id: local content wins")
        XCTAssertEqual(r.stats.instancesKept, 1)
    }

    func testRestoreRebuildsGroupOrderAndRenamesCollisions() {
        let local: [String: Any] = ["modelGroups": [["id": "g-local", "name": "Default"]]]
        let backup: [String: Any] = ["modelGroups": [["id": "g2", "name": "Coding"], ["id": "g1", "name": "Default"]]]
        let r = BackupMerge.mergeProviderConfig(local: local, backup: backup, backupSnapshotAt: t)
        XCTAssertEqual(ids(r.merged, "modelGroups"), ["g2", "g1", "g-local"])
        let names = ((r.merged["modelGroups"] as? [[String: Any]]) ?? []).compactMap { $0["name"] as? String }
        XCTAssertEqual(names, ["Coding", "Default（备份）", "Default"])
        XCTAssertEqual(r.stats.groupsRenamed, 1)
    }

    func testEmptyBackupLeavesLocalUntouched() {
        let local: [String: Any] = ["instances": [inst("A"), inst("B")], "defaultPrimaryGroupId": "g"]
        let r = BackupMerge.mergeProviderConfig(local: local, backup: [:], backupSnapshotAt: t)
        XCTAssertEqual(ids(r.merged, "instances"), ["A", "B"])
        XCTAssertFalse(r.stats.changed)
        XCTAssertEqual(r.merged["defaultPrimaryGroupId"] as? String, "g")
    }

    func testDeletionAfterTheBackupStaysDeleted() {
        let iso = ISO8601DateFormatter()
        let local: [String: Any] = [
            "instances": [],
            "deletedInstances": [["id": "late", "deletedAt": iso.string(from: t.addingTimeInterval(100))],
                                 ["id": "early", "deletedAt": iso.string(from: t.addingTimeInterval(-100))]],
        ]
        let backup: [String: Any] = ["instances": [inst("late"), inst("early")]]
        let r = BackupMerge.mergeProviderConfig(local: local, backup: backup, backupSnapshotAt: t)
        XCTAssertEqual(ids(r.merged, "instances"), ["early"], "deleted after the backup → stays deleted")
        XCTAssertEqual(r.stats.instancesSkippedDeleted, 1)
        XCTAssertEqual(ids(r.merged, "deletedInstances"), ["late"],
                       "an older tombstone for a restored id is dropped so sync doesn't re-delete it")
    }

    func testEntriesOfExistingInstancesOnlyReturnWhenCustomised() {
        let local: [String: Any] = ["instances": [inst("A")], "modelEntries": []]
        let backup: [String: Any] = [
            "instances": [inst("A"), inst("N")],
            "modelEntries": [
                ["uuid": "1", "providerInstanceId": "A", "model": ["id": "api-truth"]],
                ["uuid": "2", "providerInstanceId": "A", "model": ["id": "custom"], "isCustom": true],
                ["uuid": "3", "providerInstanceId": "N", "model": ["id": "anything"]],
                ["uuid": "4", "providerInstanceId": "GONE", "model": ["id": "orphan"]],
            ],
        ]
        let r = BackupMerge.mergeProviderConfig(local: local, backup: backup, backupSnapshotAt: t)
        let uuids = ((r.merged["modelEntries"] as? [[String: Any]]) ?? []).compactMap { $0["uuid"] as? String }
        XCTAssertEqual(uuids, ["2", "3"])
    }

    func testPointersAdoptedOnlyWhenUnsetLocally() {
        let backup: [String: Any] = ["modelGroups": [["id": "g", "name": "G"]], "defaultPrimaryGroupId": "g",
                                     "sessionBindings": ["s1": ["x": 1], "s2": ["x": 2]]]
        let fresh = BackupMerge.mergeProviderConfig(local: ["sessionBindings": ["s1": ["x": 9]]], backup: backup, backupSnapshotAt: t)
        XCTAssertEqual(fresh.merged["defaultPrimaryGroupId"] as? String, "g")
        let bindings = fresh.merged["sessionBindings"] as? [String: [String: Int]]
        XCTAssertEqual(bindings?["s1"]?["x"], 9, "local binding wins")
        XCTAssertEqual(bindings?["s2"]?["x"], 2)
        let configured = BackupMerge.mergeProviderConfig(local: ["defaultPrimaryGroupId": "mine"], backup: backup, backupSnapshotAt: t)
        XCTAssertEqual(configured.merged["defaultPrimaryGroupId"] as? String, "mine")
    }

    // MARK: - MCP

    func testMCPRedactionKeepsReferencesAndStripsSecrets() {
        let root: [String: Any] = ["mcpServers": [
            "s": ["url": "https://u:p@host/x?key=1#f", "headers": ["Authorization": "Bearer abc", "X-Ref": "$$TOKEN"],
                  "env": ["A": "${HOME}", "B": "plain-secret"], "args": ["--api-key=zzz", "serve"]],
            "clean": ["command": "npx", "args": ["tool"], "env": ["P": "$PATH"]],
        ]]
        let r = BackupMerge.redactMCPServers(root)
        XCTAssertEqual(r.count, 1)
        let s = (r.redacted["mcpServers"] as? [String: Any])?["s"] as? [String: Any]
        XCTAssertEqual(s?["url"] as? String, "https://host/x")
        XCTAssertEqual((s?["headers"] as? [String: String])?["Authorization"], "")
        XCTAssertEqual((s?["headers"] as? [String: String])?["X-Ref"], "$$TOKEN")
        XCTAssertEqual((s?["env"] as? [String: String])?["A"], "${HOME}")
        XCTAssertEqual((s?["env"] as? [String: String])?["B"], "")
        XCTAssertEqual(s?["args"] as? [String], ["", "serve"])
        XCTAssertEqual(s?[BackupMerge.redactionMarker] as? Bool, true)
        let clean = (r.redacted["mcpServers"] as? [String: Any])?["clean"] as? [String: Any]
        XCTAssertNil(clean?[BackupMerge.redactionMarker])
    }

    func testMCPMergeNewerWinsAndRedactedNeverOverwrites() {
        let local: [String: Any] = ["mcpServers": ["a": ["url": "l", "updatedAt": 100.0],
                                                   "b": ["url": "l", "updatedAt": 300.0],
                                                   "c": ["url": "l", "updatedAt": 100.0]]]
        let backup: [String: Any] = ["mcpServers": ["a": ["url": "b", "updatedAt": 200.0],
                                                    "b": ["url": "b", "updatedAt": 200.0],
                                                    "c": ["url": "b", "updatedAt": 900.0, BackupMerge.redactionMarker: true],
                                                    "d": ["url": "b", BackupMerge.redactionMarker: true]]]
        let m = BackupMerge.mergeMCPServers(local: local, backup: backup)
        XCTAssertEqual(m.plan.replaced, ["a"])
        XCTAssertEqual(m.plan.kept, ["b", "c"])
        XCTAssertEqual(m.plan.added, ["d"])
        XCTAssertEqual(m.plan.needsSecrets, ["d"])
        XCTAssertNil((m.toApply["d"] as? [String: Any])?[BackupMerge.redactionMarker])
    }

    // MARK: - Env vars / rules

    func testEnvVarsOnlyAddNewValidKeys() {
        let backup = [BackupEnvVarRecord(id: "1", key: "EXISTING", createdAt: t, note: ""),
                      BackupEnvVarRecord(id: "2", key: "new_key", createdAt: t, note: "n"),
                      BackupEnvVarRecord(id: "3", key: "1BAD", createdAt: t, note: ""),
                      BackupEnvVarRecord(id: "4", key: "NEW_KEY", createdAt: t, note: "dup")]
        let add = BackupMerge.envVarsToAdd(localKeys: ["EXISTING"], backup: backup)
        XCTAssertEqual(add.map(\.key), ["NEW_KEY"])
        XCTAssertEqual(add.first?.note, "n")
    }

    func testThinkingRulesMergeByPrefixLocalWins() {
        let local = [BackupLeoThinkingRuleRecord(prefix: "GPT-5", maxLevel: "low", defaultLevel: "low")]
        let backup = [BackupLeoThinkingRuleRecord(prefix: "gpt-5", maxLevel: "high", defaultLevel: "high"),
                      BackupLeoThinkingRuleRecord(prefix: "claude", maxLevel: "high", defaultLevel: "medium")]
        let r = BackupMerge.mergeThinkingRules(local: local, backup: backup)
        XCTAssertEqual(r.added, 1)
        XCTAssertEqual(r.merged.map(\.maxLevel), ["low", "high"])
    }
}
