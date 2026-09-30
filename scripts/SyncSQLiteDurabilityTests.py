#!/usr/bin/env python3
"""Run real SQLite failure/retry tests against exact extracted ChatStore methods.

UIKit/SwiftAnthropic/UI notification types are isolated with test-only stubs;
SQL mutation, conflict checks, transactions and commit/error paths are production
source. Also executes the full production delivery-ledger smoke suite.
"""
import argparse
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
p = argparse.ArgumentParser(description=__doc__)
p.add_argument('--swiftc', default=shutil.which('swiftc'))
p.add_argument('--sqlite-module', help='Linux-only directory containing module.modulemap and libsqlite3.so')
a = p.parse_args()
if not a.swiftc: p.error('swiftc required')


def method(text, name):
    start = text.index('func ' + name + '(')
    start = text.rfind('\n', 0, start) + 1
    end = text.index('\n    }', start) + 6
    return text[start:end]


support = r'''
import Foundation
import SQLite3
struct TestLogger { func info(_ x: String) {}; func warning(_ x: String) {}; func debug(_ x: String) {} }
let iCloudLogger = TestLogger()
struct SyncDevice { let id: String; let deviceName: String; let zoneName: String; let lastSeen: Date; let osVersion: String; let uploadTypes: [String] }
struct ChatSession { let id: String; let title: String?; let category: String?; let modelId: String; let createdAt: Date; let updatedAt: Date }
enum SessionActivityTracker { static var active = false; static func isActiveThreadSafe(_ id: String) -> Bool { active } }
@MainActor final class ViewModelCache { static let shared = ViewModelCache(); func markStale(sessionId: String) {} }
extension Notification.Name { static let sessionDidUpdate = Notification.Name("updated"); static let sessionDidCreate = Notification.Name("created") }
final class ChatSQLProbe {
    let db: OpaquePointer?
    init(_ db: OpaquePointer?) { self.db = db }
    func invalidateSessionListCache() {}
    func isResurrectionOfDeleted(_ id: String, remoteUpdatedAt: Date) -> Bool { false }
    static func partFlags(fromPartsJSON: String) -> Int { 0 }
    static func partFlagsSQLExpr(_ x: String) -> String { "0" }
    func bindOptionalText(_ statement: OpaquePointer?, index: Int32, value: String?) {
        if let value { sqlite3_bind_text(statement, index, (value as NSString).utf8String, -1, unsafeBitCast(-1, to: sqlite3_destructor_type.self)) }
        else { sqlite3_bind_null(statement, index) }
    }
'''
main = r'''
}
@main enum SQLiteInboundSmoke {
    @MainActor static func main() throws {
        var db: OpaquePointer?
        precondition(sqlite3_open(":memory:", &db) == SQLITE_OK)
        defer { sqlite3_close(db) }
        func sql(_ text: String) { precondition(sqlite3_exec(db, text, nil, nil, nil) == SQLITE_OK, String(cString: sqlite3_errmsg(db))) }
        func scalar(_ text: String) -> String {
            var s: OpaquePointer?; defer { sqlite3_finalize(s) }
            precondition(sqlite3_prepare_v2(db, text, -1, &s, nil) == SQLITE_OK)
            guard sqlite3_step(s) == SQLITE_ROW, let t = sqlite3_column_text(s, 0) else { return "" }
            return String(cString: t)
        }
        func failed(_ operation: () throws -> Void) { do { try operation(); preconditionFailure("failed storage was acknowledged") } catch {} }
        sql("CREATE TABLE sessions(id TEXT PRIMARY KEY,title TEXT,category TEXT,model_id TEXT,created_at REAL,updated_at REAL,remote_origin_device_id TEXT,memory_enabled INTEGER,model_binding TEXT,pinned_at REAL,origin_device_id TEXT,last_writer_device_id TEXT)")
        sql("CREATE TABLE messages(id TEXT PRIMARY KEY,session_id TEXT,role TEXT,parts_json TEXT,created_at REAL,token_usage TEXT,sort_order INTEGER,reasoning_content TEXT,stream_interrupt_count INTEGER,updated_at REAL,part_flags INTEGER)")
        sql("CREATE TABLE remote_messages AS SELECT * FROM messages")
        sql("CREATE TABLE sync_devices(device_id TEXT PRIMARY KEY,device_name TEXT,zone_name TEXT,last_seen REAL,os_version TEXT,upload_types TEXT)")
        let store = ChatSQLProbe(db)
        let session = ChatSession(id: "s", title: "old", category: nil, modelId: "m", createdAt: Date(timeIntervalSince1970: 1), updatedAt: Date(timeIntervalSince1970: 1))
        let device = SyncDevice(id: "d", deviceName: "peer", zoneName: "z", lastSeen: Date(), osVersion: "iOS", uploadTypes: [])
        failed { try ChatSQLProbe(nil).upsertSyncDevice(device) }
        try store.mergeRemoteSession(session, fromDeviceId: "peer")
        precondition(scalar("SELECT title FROM sessions WHERE id='s'") == "old")
        sql("CREATE TRIGGER fail_provenance BEFORE UPDATE OF origin_device_id ON sessions BEGIN SELECT RAISE(ABORT,'injected failure'); END")
        let newer = ChatSession(id: "s", title: "new", category: nil, modelId: "m", createdAt: session.createdAt, updatedAt: Date(timeIntervalSince1970: 2))
        failed { try store.mergeRemoteSession(newer, fromDeviceId: "peer") }
        precondition(scalar("SELECT title FROM sessions WHERE id='s'") == "old", "late write failure must roll back earlier session update")
        sql("DROP TRIGGER fail_provenance")
        try store.mergeRemoteSession(newer, fromDeviceId: "peer")
        precondition(scalar("SELECT title FROM sessions WHERE id='s'") == "new")
        try store.mergeRemoteSession(session, fromDeviceId: "peer")
        precondition(scalar("SELECT title FROM sessions WHERE id='s'") == "new", "local-newer remains an intentional success")
        func message() throws {
            try store.mergeRemoteMessage(id: "msg", sessionId: "s", role: "user", partsJson: "[]", createdAt: Date(timeIntervalSince1970: 3), tokenUsageJson: nil, sortOrder: 0, reasoningContent: nil, streamInterruptCount: 0, updatedAt: Date(timeIntervalSince1970: 3))
        }
        SessionActivityTracker.active = true; failed { try message() }; SessionActivityTracker.active = false
        sql("CREATE TRIGGER fail_message BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT,'disk full stand-in'); END")
        failed { try message() }
        precondition(scalar("SELECT COUNT(*) FROM messages") == "0")
        sql("DROP TRIGGER fail_message")
        try message()
        precondition(scalar("SELECT COUNT(*) FROM messages") == "1")
        sql("CREATE TRIGGER fail_delete BEFORE DELETE ON messages BEGIN SELECT RAISE(ABORT,'denied'); END")
        failed { try store.deleteLocalMessage(messageId: "msg") }
        precondition(scalar("SELECT COUNT(*) FROM messages") == "1")
        sql("DROP TRIGGER fail_delete")
        try store.deleteLocalMessage(messageId: "msg")
        try store.deleteLocalMessage(messageId: "msg") // absent delete is a valid idempotent apply
        precondition(scalar("SELECT COUNT(*) FROM messages") == "0")
        sql("PRAGMA query_only=ON")
        failed { try store.upsertSyncDevice(device) }
        sql("PRAGMA query_only=OFF")
        try store.upsertSyncDevice(device)
        precondition(scalar("SELECT COUNT(*) FROM sync_devices") == "1")
        print("SQLiteInboundSmoke: nil DB, read-only DB, SQL failures, transaction rollback, replay, local-newer, active-session deferral and idempotent delete passed")
    }
}
'''
with tempfile.TemporaryDirectory(prefix='sync-sqlite-') as temp:
    work = Path(temp)
    flags = [a.swiftc, '-module-cache-path', str(work / 'cache'), '-parse-as-library']
    if a.sqlite_module: flags += ['-I', a.sqlite_module, '-L', a.sqlite_module]
    sync = ROOT / 'src/ios/Agent/Sync/V2'
    ledger = work / 'ledger'
    subprocess.run(flags + [str(sync / 'SyncDeliveryLedger.swift'), str(ROOT / 'scripts/SyncDeliveryLedgerSmoke.swift'), '-o', str(ledger)], check=True)
    subprocess.run([str(ledger)], check=True)
    source = (ROOT / 'src/ios/Agent/Chat/ChatStore.swift').read_text()
    methods = ['withInboundMutation', 'prepareInbound', 'stepInbound', 'upsertSyncDevice',
               'mergeRemoteSession', 'mergeRemoteMessage', 'deleteLocalMessage']
    probe = work / 'Probe.swift'
    probe.write_text(support + '\n'.join(method(source, x) for x in methods) + main)
    binary = work / 'inbound-sql'
    subprocess.run(flags + [str(sync / 'SessionProvenanceStore.swift'), str(probe), '-o', str(binary)], check=True)
    subprocess.run([str(binary)], check=True)

# Exercise SyncCore's actual freeze boundary with its store adapter backed by
# the production ledger. Only the Application Support root is redirected into
# this test's temporary directory; no app data or platform preferences are used.
freeze_support = r'''
import Foundation
import SQLite3
@MainActor final class ChatStore {
    static let shared = ChatStore()
    var db: OpaquePointer?
    let path = ProcessInfo.processInfo.environment["SYNC_TEST_DB"]!
    init() {
        precondition(sqlite3_open(path, &db) == SQLITE_OK)
        precondition(sqlite3_exec(db, "CREATE TABLE sync_dirty_records(record_type TEXT,record_id TEXT,zone_name TEXT DEFAULT '',operation TEXT DEFAULT 'upsert',priority INTEGER DEFAULT 0,created_at REAL DEFAULT 1,PRIMARY KEY(record_type,record_id))", nil, nil, nil) == SQLITE_OK)
        try! SyncDeliveryLedger.migrate(db, recordTypes: ["EnvVarItem", "ProviderConfigV2", "SkillV2", "SessionFileV2"])
        try! SyncDeliveryLedger.configure(db, enabled: ["tailnet:solo"])
    }
    func syncDeliveryPayload(_ ticket: SyncDeliveryTicket) throws -> Data? { try SyncDeliveryLedger.payload(db, ticket: ticket) }
    func freezeSyncDelivery(_ ticket: SyncDeliveryTicket, payload: Data) throws -> Bool { try SyncDeliveryLedger.freeze(db, ticket: ticket, payload: payload) }
    func restart() { sqlite3_close(db); db = nil; precondition(sqlite3_open(path, &db) == SQLITE_OK) }
}
@MainActor final class FreezeProbe {
    let transports = ["tailnet:solo"]
'''
freeze_main = r'''
}
@main enum FrozenRevisionSmoke {
    @MainActor static func main() async throws {
        let root = URL(fileURLWithPath: ProcessInfo.processInfo.environment["SYNC_TEST_ROOT"]!)
        let file = root.appendingPathComponent("source")
        let probe = FreezeProbe(), store = ChatStore.shared
        for type in ["EnvVarItem", "ProviderConfigV2", "SkillV2", "SessionFileV2"] {
            try Data("original".utf8).write(to: file, options: .atomic)
            var builds = 0
            SyncCoreHydrators.shared.register(recordType: type, builder: { id in
                builds += 1
                return PortableRecord(id: .init(type: type, id: id), fields: ["now": .date(Date())],
                    assets: ["asset": .init(key: "asset", fileURL: file, size: 8, mimeType: nil)], updatedAt: Date())
            }, merger: nil)
            try SyncDeliveryLedger.seed(store.db, destination: "tailnet:solo", recordType: type, recordId: "id")
            let ticket = try SyncDeliveryLedger.load(store.db, destination: "tailnet:solo").first { $0.recordType == type }!
            let first = try await probe.frozenRecord(for: ticket)!
            precondition(first.assets["asset"]!.fileURL != file)
            let bytes = try store.syncDeliveryPayload(ticket)
            try Data("mutated!".utf8).write(to: file, options: .atomic)
            store.restart()
            let replay = try await probe.frozenRecord(for: ticket)!
            let persisted = try store.syncDeliveryPayload(ticket)
            let assetBytes = try Data(contentsOf: replay.assets["asset"]!.fileURL)
            precondition(first == replay && bytes == persisted && builds == 1)
            precondition(assetBytes == Data("original".utf8), "same change ID cannot pick up edited source bytes")
        }
        print("FrozenRevisionSmoke: actual single-destination Core freeze, changing builder timestamp, mutable assets and SQLite restart passed for Env/Provider/Skill/SessionFile")
    }
}
'''
with tempfile.TemporaryDirectory(prefix='sync-frozen-') as temp:
    work = Path(temp)
    sync = ROOT / 'src/ios/Agent/Sync/V2'
    freeze = method((sync / 'SyncCore.swift').read_text(), 'frozenRecord')
    freeze = freeze.replace('private func frozenRecord', 'func frozenRecord', 1)
    old_root = 'try manager.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)'
    assert old_root in freeze, 'root adaptation must remain explicit and bounded'
    freeze = freeze.replace(old_root, 'URL(fileURLWithPath: ProcessInfo.processInfo.environment["SYNC_TEST_ROOT"]!)', 1)
    probe = work / 'Frozen.swift'
    probe.write_text(freeze_support + freeze + freeze_main)
    binary = work / 'frozen'
    flags = [a.swiftc, '-module-cache-path', str(work / 'cache'), '-parse-as-library']
    if a.sqlite_module: flags += ['-I', a.sqlite_module, '-L', a.sqlite_module]
    subprocess.run(flags + [str(sync / 'SyncDeliveryLedger.swift'), str(sync / 'PortableRecord.swift'),
                           str(sync / 'SyncCoreHydrators.swift'), str(probe), '-o', str(binary)], check=True)
    subprocess.run([str(binary)], env={**os.environ, 'SYNC_TEST_DB': str(work / 'db.sqlite'), 'SYNC_TEST_ROOT': str(work)}, check=True)
