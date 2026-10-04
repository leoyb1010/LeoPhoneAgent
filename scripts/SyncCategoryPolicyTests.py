#!/usr/bin/env python3
"""Category pause/resume contracts using production Swift methods and real SQLite.
All defaults, database rows and network adapters are isolated test fixtures.
"""
from pathlib import Path
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
SYNC = ROOT / 'src/ios/Agent/Sync/V2'
CHAT = ROOT / 'src/ios/Agent/Chat/ChatStore.swift'

def method(source, name):
    start = source.index('func ' + name + '(')
    start = source.rfind('\n', 0, start) + 1
    return source[start:source.index('\n    }', start) + 6]

chat = CHAT.read_text()
support = r'''
import Foundation
import SQLite3
let fixtureDefaults = UserDefaults(suiteName: "leo.sync.category.test." + UUID().uuidString)!
struct Logger { func info(_ s: String) {}; func debug(_ s: String) {}; func error(_ s: String) {} }
let iCloudLogger = Logger()
enum SyncV2Bootstrap { static var isAnyEnabled = true }
@MainActor final class SyncCore { static let shared = SyncCore(); func scheduleSend() {} }
@MainActor final class CloudSyncEngine { static let shared = CloudSyncEngine(); func scheduleSend() {} }
final class ChatStore {
 static var shared = try! ChatStore()
 var db: OpaquePointer?
 var syncZoneName = "fixture"
 var syncSendDeferred = true
 var seedingDestination: String?
 var tombstones: Set<String> = []
 var scannedSessions: [String] = []
 struct DirtyRecord { let recordType: String; let recordId: String; let zoneName: String; let operation: String }
 static let v2SyncRecordTypesSQL = "'SessionV2','MessageV2','CompactMarkerV2','SessionFileV2','SkillV2','EnvVarItem','ProviderConfigV2','SyncDeviceV2'"
 func scanAndMarkSessionFiles(sessionId: String, priority: Int, preservingPending: Bool) -> Int {
  precondition(preservingPending)
  scannedSessions.append(sessionId)
  stageUploadBackfillRecord(recordType: "SessionFile", recordId: sessionId + ":workspace/fixture.txt")
  return 1
 }
 func sql(_ sql: String) {
  precondition(sqlite3_exec(db, sql, nil, nil, nil) == SQLITE_OK, String(cString: sqlite3_errmsg(db)))
 }
 func noteSyncMutationFailure() { fatalError("outbox SQL failed") }
 func recordDeletedRecordTombstone(type: String, id: String) { tombstones.insert(type + ":" + id) }
 init() throws {
  precondition(sqlite3_open(":memory:", &db) == SQLITE_OK)
  precondition(sqlite3_exec(db, "CREATE TABLE sync_dirty_records(record_type TEXT,record_id TEXT,zone_name TEXT DEFAULT '',operation TEXT DEFAULT 'upsert',priority INTEGER DEFAULT 0,created_at REAL DEFAULT 1,PRIMARY KEY(record_type,record_id))", nil, nil, nil) == SQLITE_OK)
  try SyncDeliveryLedger.migrate(db, recordTypes: ["SessionV2", "MessageV2", "CompactMarkerV2", "SessionFileV2", "SkillV2", "EnvVarItem", "ProviderConfigV2", "SyncDeviceV2", "EnvVarV2", "MCPServersV2", "MCPServerItem", "FutureV2"])
  try SyncDeliveryLedger.configure(db, enabled: ["iCloud", "tailnet:fixture"])
 }
 deinit { sqlite3_close(db) }
'''
source = support + '\n'.join(method(chat, name) for name in ['markDirty', 'v2RecordType', 'loadSyncDeliveryTickets', 'loadDirtyRecords', 'stageUploadBackfillRecord', 'stageChatUploadCategory', 'configureSyncDestinations']) + r'''
}
struct FixtureItem { var id: String; var uuid: String { id } }
@MainActor final class SkillStore {
 static let shared = SkillStore(); var skills = [FixtureItem(id: "skill")]
}
@MainActor final class EnvVarStore {
 static let shared = EnvVarStore(); var entries = [FixtureItem(id: "env-secret")]
}
struct FixtureProviderConfig {
 var instances = [FixtureItem(id: "provider")]
 var modelEntries = [FixtureItem(id: "model")]
 var modelGroups = [FixtureItem(id: "group")]
 var deletedInstances = [FixtureItem(id: "deleted-provider")]
 var deletedModelEntries: [FixtureItem] = []
 var deletedModelGroups: [FixtureItem] = []
}
@MainActor final class ProviderConfigStore {
 static let shared = ProviderConfigStore(); var config = FixtureProviderConfig()
}
@MainActor enum ForceSyncHelper {
 static var calls = 0
 static func markMemoryDirty(preservingPending: Bool) async -> Int { calls += 1; return 0 }
 static func markSoulDirty(preservingPending: Bool) async -> Int { calls += 1; return 0 }
}
@MainActor enum ChatStoreSyncHydrators {
 static var artifactCalls = 0
 static func stageAllArtifacts(preservingPending: Bool) async { artifactCalls += 1 }
''' + method((SYNC / 'ChatStoreSyncHydrators.swift').read_text(), 'stageUploadCategory') + r'''
}
@main enum CategoryPolicySmoke {
 @MainActor static func main() async throws {
  let store = try ChatStore()
  UploadPolicy.setEnabled(.skills, false)
  store.markDirty(recordType: "Skill", recordId: "edited-off")
  store.markDirty(recordType: "Skill", recordId: "deleted-off", operation: "delete")
  let paused = try SyncDeliveryLedger.load(store.db, destination: "iCloud")
  precondition(paused.count == 2, "category-off edits AND deletes must remain durably queued")
  precondition(paused.contains { $0.recordId == "deleted-off" && $0.operation == "delete" })
  let ready = try store.loadSyncDeliveryTickets(destination: "iCloud")
  precondition(ready.isEmpty)
  precondition(store.tombstones.contains("Skill:deleted-off"), "deletion protection must survive category pause")
  print("PASS category-off mutation persistence without outbound admission")

  let deleted = paused.first { $0.recordId == "deleted-off" }!
  let edited = paused.first { $0.recordId == "edited-off" }!
  precondition(try! SyncDeliveryLedger.freeze(store.db, ticket: edited, payload: Data("frozen edit".utf8)))
  UploadPolicy.setEnabled(.skills, true)
  store.stageUploadBackfillRecord(recordType: "Skill", recordId: "deleted-off")
  store.stageUploadBackfillRecord(recordType: "Skill", recordId: "edited-off")
  store.stageUploadBackfillRecord(recordType: "Skill", recordId: "historical-skill")
  let resumed = try store.loadSyncDeliveryTickets(destination: "iCloud")
  precondition(resumed.contains(deleted), "backfill must keep pending deletion revision/change ID")
  precondition(resumed.contains(edited), "backfill must keep pending frozen revision/change ID")
  precondition(try! SyncDeliveryLedger.payload(store.db, ticket: edited) == Data("frozen edit".utf8))
  precondition(resumed.contains { $0.recordId == "historical-skill" })
  UploadPolicy.setEnabled(.envVars, false)
  store.stageUploadBackfillRecord(recordType: "EnvVarItem", recordId: "private")
  precondition(!store.loadDirtyRecords().contains { $0.recordId == "private" }, "backfill cannot stage a disabled private category")
  print("PASS category backfill preserves tombstones, revisions and frozen bytes")

  UploadPolicy.setEnabled(.skills, false)
  UploadPolicy.setEnabled(.chatSessions, false)
  UploadPolicy.setEnabled(.envVars, true)
  store.markDirty(recordType: "EnvVarItem", recordId: "allowed")
  for n in 0..<160 {
   store.markDirty(recordType: "Skill", recordId: "paused-skill-\(n)")
   store.markDirty(recordType: "Session", recordId: "paused-session-\(n)")
  }
  for destination in ["iCloud", "tailnet:fixture"] {
   let allowed = try store.loadSyncDeliveryTickets(destination: destination)
   precondition(allowed.map(\.recordId) == ["allowed"], "paused categories cannot starve allowed tickets before LIMIT")
  }
  let legacyPage = store.loadDirtyRecords(allowedTypes: ["EnvVarItem"])
  precondition(legacyPage.map(\.recordId) == ["allowed"], "legacy dequeue filters BEFORE LIMIT")
  precondition(store.loadDirtyRecords(allowedTypes: []).isEmpty, "all categories disabled means no outbound rows")
  print("PASS real SQL V1/V2 filtering before LIMIT for 320 paused rows")

  let categoryStore = try ChatStore()
  categoryStore.sql("CREATE TABLE sessions(id TEXT PRIMARY KEY); CREATE TABLE messages(id TEXT PRIMARY KEY); CREATE TABLE compact_markers(id TEXT PRIMARY KEY)")
  categoryStore.sql("INSERT INTO sessions VALUES('new-session'); INSERT INTO messages VALUES('new-message'); INSERT INTO compact_markers VALUES('new-marker')")
  UploadPolicy.setEnabled(.chatSessions, true)
  UploadPolicy.setEnabled(.sessionFiles, false)
  await categoryStore.stageChatUploadCategory(.chatSessions)
  let chatRows = categoryStore.loadDirtyRecords(allowedTypes: ["SessionV2", "MessageV2", "CompactMarkerV2"])
  precondition(chatRows.contains { $0.recordId == "new-session" })
  precondition(categoryStore.scannedSessions.isEmpty, "chat category must not stage files")
  UploadPolicy.setEnabled(.sessionFiles, true)
  UploadPolicy.setEnabled(.chatSessions, false)
  await categoryStore.stageChatUploadCategory(.sessionFiles)
  let files = categoryStore.loadDirtyRecords(allowedTypes: ["SessionFileV2"])
  precondition(files.map(\.recordId) == ["new-session:workspace/fixture.txt"])
  precondition(categoryStore.scannedSessions == ["new-session"])
  print("PASS category-scoped chat/file backfill using real SQLite rows")

  for category in [UploadPolicy.Category.skills, .envVars, .providers] {
   ChatStore.shared = try ChatStore()
   // Even other categories that are independently enabled must not be
   // restaged by this toggle; queued history is scoped to this category.
   for value in UploadPolicy.Category.allCases { UploadPolicy.setEnabled(value, true) }
   await ChatStoreSyncHydrators.stageUploadCategory(category)
   let rows = ChatStore.shared.loadDirtyRecords()
   precondition(!rows.isEmpty)
   precondition(rows.allSatisfy { category.recordTypes.contains($0.recordType) }, "backfill staged unrelated private data")
   precondition(ForceSyncHelper.calls == 0 && ChatStoreSyncHydrators.artifactCalls == 0)
   if category == .providers {
    precondition(rows.contains { $0.recordId == "deleted-provider" && $0.operation == "delete" }, "provider's durable delete intent must be replayed")
   }
  }
  print("PASS actual category dispatcher never stages unrelated enabled private categories")

  let legacy = try ChatStore()
  legacy.sql("INSERT INTO sync_dirty_records(record_type,record_id) VALUES('EnvVarV2','env-vars'),('MCPServersV2','mcp-servers'),('EnvVarItem','real-variable'),('MCPServerItem','real-server'),('FutureV2','unknown'),('EnvVarV2','noncanonical')")
  for ticket in try SyncDeliveryLedger.load(legacy.db, destination: "iCloud") {
   try SyncDeliveryLedger.fail(legacy.db, ticket: ticket, reason: "record payload unavailable; retry after restoring source")
  }
  // Invoke the actual startup entry point, not just the cleanup helper.
  try legacy.configureSyncDestinations(["iCloud", "tailnet:fixture"])
  let failures = try SyncDeliveryLedger.failures(legacy.db)
  precondition(failures.count == 4 && failures.allSatisfy { !["env-vars", "mcp-servers"].contains($0.recordId) },
     "only proven empty canonical legacy containers may leave failure UI")
  let repeatCount = try SyncDeliveryLedger.retireEmptyLegacyContainerUpserts(legacy.db)
  precondition(repeatCount == 0, "upgrade cleanup must be idempotent")
  for _ in 0..<3 {
   legacy.markDirty(recordType: "EnvVar", recordId: "env-vars")
   legacy.markDirty(recordType: "MCPServers", recordId: "mcp-servers")
   legacy.markDirty(recordType: "EnvVarV2", recordId: "env-vars")
  }
  precondition(!legacy.loadDirtyRecords().contains { ["env-vars", "mcp-servers"].contains($0.recordId) },
     "future legacy file scans must not recreate retired V2 upserts")
  legacy.seedingDestination = "tailnet:fixture"
  legacy.markDirty(recordType: "EnvVar", recordId: "env-vars")
  legacy.seedingDestination = nil
  let seededAfterRetirement = try SyncDeliveryLedger.load(legacy.db, destination: "tailnet:fixture")
  precondition(!seededAfterRetirement.contains { $0.recordId == "env-vars" })

  let preserve = try ChatStore()
  preserve.sql("INSERT INTO sync_dirty_records(record_type,record_id,operation) VALUES('EnvVarV2','env-vars','delete'),('MCPServersV2','mcp-servers','upsert')")
  let frozenLegacy = try SyncDeliveryLedger.load(preserve.db, destination: "iCloud").first { $0.recordType == "MCPServersV2" }!
  precondition(try! SyncDeliveryLedger.freeze(preserve.db, ticket: frozenLegacy, payload: Data("actual legacy payload".utf8)))
  preserve.markDirty(recordType: "EnvVar", recordId: "env-vars")
  try preserve.configureSyncDestinations(["iCloud", "tailnet:fixture"])
  let retained = try SyncDeliveryLedger.load(preserve.db, destination: "iCloud")
  precondition(retained.count == 2 && retained.contains(frozenLegacy))
  precondition(retained.contains { $0.recordType == "EnvVarV2" && $0.operation == "delete" }, "real cloud-delete intent remains queued")
  precondition(try! SyncDeliveryLedger.payload(preserve.db, ticket: frozenLegacy) == Data("actual legacy payload".utf8))

  let seedOnly = try ChatStore()
  try SyncDeliveryLedger.seed(seedOnly.db, destination: "tailnet:fixture", recordType: "EnvVarV2", recordId: "env-vars")
  try seedOnly.configureSyncDestinations(["iCloud", "tailnet:fixture"])
  let remainingSeeds = try SyncDeliveryLedger.load(seedOnly.db, destination: "tailnet:fixture")
  precondition(remainingSeeds.isEmpty, "empty replica-only legacy seed is also retired")

  SyncV2Bootstrap.isAnyEnabled = false
  let fallback = try ChatStore()
  fallback.markDirty(recordType: "EnvVar", recordId: "env-vars")
  fallback.markDirty(recordType: "MCPServers", recordId: "mcp-servers")
  let v1Rows = fallback.loadDirtyRecords()
  precondition(Set(v1Rows.map(\.recordType)) == ["EnvVar", "MCPServers"], "active V1 aggregate writes remain intact without recreating V2 upserts")
  try fallback.configureSyncDestinations(["iCloud"])
  precondition(fallback.loadDirtyRecords().count == 2, "V2 compatibility cleanup must not delete V1 fallback work")
  print("PASS startup legacy migration: failed tickets, idempotence, future scans, delete/frozen/item/unknown preservation and V1 fallback")
 }
}
'''
with tempfile.TemporaryDirectory(prefix='leo-sync-category-') as temp:
    work = Path(temp)
    policy = work / 'UploadPolicy.swift'
    policy.write_text((SYNC / 'UploadPolicy.swift').read_text().replace('UserDefaults.standard', 'fixtureDefaults'))
    probe = work / 'Probe.swift'
    probe.write_text(source.replace('UserDefaults.standard', 'fixtureDefaults'))
    binary = work / 'probe'
    subprocess.run(['swiftc', '-parse-as-library', '-module-cache-path', str(work / 'cache'), str(policy),
                    str(SYNC / 'SyncDeliveryLedger.swift'), str(probe), '-o', str(binary)], check=True)
    subprocess.run([str(binary)], check=True)
