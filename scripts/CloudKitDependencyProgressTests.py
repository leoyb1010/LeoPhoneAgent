#!/usr/bin/env python3
"""Composite dependency regression: production journal/pass + exact production SQL.

Extracts current ChatStore/ProviderConfigDB methods, rather than keeping copied SQL.
UI notifications, models unrelated to SQL, and tombstone lookup are explicit fixture
boundaries; real CloudKit/network/Keychain and full SyncCore are not executed.
"""
import argparse
import ast
from pathlib import Path
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
p = argparse.ArgumentParser(description=__doc__)
p.add_argument('--swiftc', default=shutil.which('swiftc'))
p.add_argument('--sqlite-module')
a = p.parse_args()
if not a.swiftc:
    p.error('swiftc required')


def method(text, name):
    start = text.index('func ' + name + '(')
    start = text.rfind('\n', 0, start) + 1
    end = text.index('\n    }', start) + 6
    return text[start:end]


# Reuse only the explicit test support string, not that script's execution.
syntax = ast.parse((ROOT / 'scripts/SyncSQLiteDurabilityTests.py').read_text())
support = next(ast.literal_eval(x.value) for x in syntax.body
               if isinstance(x, ast.Assign) and any(isinstance(t, ast.Name) and t.id == 'support' for t in x.targets))
support += '\n    func isRecentlyDeletedRecord(type: String, id: String, remoteUpdatedAt: Date) -> Bool { false }\n'
chat = (ROOT / 'src/ios/Agent/Chat/ChatStore.swift').read_text()
marker_start = chat.index('struct CompactMarker:')
marker = chat[marker_start:chat.index('\n}', marker_start) + 2]
chat_methods = ['withInboundMutation', 'prepareInbound', 'stepInbound', 'mergeRemoteSession',
                'mergeRemoteMessage', 'deleteLocalMessage', 'mergeRemoteCompactMarker',
                'insertCompactMarkerRow', 'getCompactMarker', 'readCompactMarker']
provider = (ROOT / 'src/ios/Providers/ProviderConfigDB.swift').read_text()
provider_support = '''
final class ProviderSQLProbe {
    let db: OpaquePointer?
    init(_ db: OpaquePointer?) { self.db = db }
    private static let SQLITE_TRANSIENT = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
'''
provider_methods = ['upsertInstanceFromInbound', 'upsertEntryFromInbound', 'upsertInstanceRow',
                    'upsertEntryRow', 'inboundStep', 'bindOpt', 'bindOptDouble', 'text']

main = r'''
final class Harness {
    var db: OpaquePointer?
    let path: String
    var chat: ChatSQLProbe { ChatSQLProbe(db) }
    var provider: ProviderSQLProbe { ProviderSQLProbe(db) }
    var applied: [String] = []
    init(_ root: URL) {
        path = root.appendingPathComponent("domain.sqlite").path
        precondition(sqlite3_open(path, &db) == SQLITE_OK)
        sql("PRAGMA foreign_keys=ON")
        sql("CREATE TABLE sessions(id TEXT PRIMARY KEY,title TEXT,category TEXT,model_id TEXT,created_at REAL,updated_at REAL,remote_origin_device_id TEXT,memory_enabled INTEGER,model_binding TEXT,pinned_at REAL,origin_device_id TEXT,last_writer_device_id TEXT)")
        sql("CREATE TABLE messages(id TEXT PRIMARY KEY,session_id TEXT,role TEXT,parts_json TEXT,created_at REAL,token_usage TEXT,sort_order INTEGER,reasoning_content TEXT,stream_interrupt_count INTEGER,updated_at REAL,part_flags INTEGER)")
        sql("CREATE TABLE remote_messages AS SELECT * FROM messages")
        sql("CREATE TABLE compact_markers(id TEXT PRIMARY KEY,session_id TEXT,summary TEXT,first_kept_sort_order INTEGER,compacted_count INTEGER,created_at REAL,ui_boundary_sort_order INTEGER,boundary_message_id TEXT,first_kept_message_id TEXT,last_compacted_message_id TEXT,version INTEGER)")
        sql("CREATE TABLE provider_instances(id TEXT PRIMARY KEY,label TEXT,provider_type TEXT,credential_type TEXT,custom_base_url TEXT,append_v1_suffix INTEGER,image_endpoint_mode TEXT,image_endpoint_resolved TEXT,is_enabled INTEGER,sort_order INTEGER,secret_blob TEXT,secret_kind TEXT,secret_updated_at REAL,created_at REAL,updated_at REAL,extras_json TEXT,custom_user_agent TEXT,azure_mode INTEGER)")
        sql("CREATE TABLE provider_model_entries(id TEXT PRIMARY KEY,provider_instance_id TEXT NOT NULL,base_model_json TEXT,overrides_json TEXT,is_custom INTEGER,is_hidden INTEGER,user_modified_at REAL,sort_order INTEGER,updated_at REAL,extras_json TEXT,FOREIGN KEY(provider_instance_id) REFERENCES provider_instances(id) ON DELETE CASCADE)")
    }
    deinit { sqlite3_close(db) }
    func reopen() { sqlite3_close(db); db = nil; precondition(sqlite3_open(path, &db) == SQLITE_OK); sql("PRAGMA foreign_keys=ON") }
    func sql(_ text: String) { precondition(sqlite3_exec(db, text, nil, nil, nil) == SQLITE_OK, String(cString: sqlite3_errmsg(db))) }
    func scalar(_ text: String) -> String {
        var s: OpaquePointer?; defer { sqlite3_finalize(s) }
        precondition(sqlite3_prepare_v2(db, text, -1, &s, nil) == SQLITE_OK)
        guard sqlite3_step(s) == SQLITE_ROW, let t = sqlite3_column_text(s, 0) else { return "" }
        return String(cString: t)
    }
    func apply(_ batch: SyncInboundBatch) throws {
        for r in batch.records {
            func str(_ key: String) -> String { if case .string(let value) = r.fields[key] { return value }; return "" }
            switch r.id.type {
            case "SessionV2":
                try chat.mergeRemoteSession(ChatSession(id: r.id.id, title: "parent", category: nil, modelId: "m", createdAt: r.updatedAt, updatedAt: r.updatedAt), fromDeviceId: "peer")
            case "MessageV2":
                try chat.mergeRemoteMessage(id: r.id.id, sessionId: str("sessionId"), role: "user", partsJson: "[]", createdAt: Date(timeIntervalSince1970: 1), tokenUsageJson: nil, sortOrder: 0, reasoningContent: nil, streamInterruptCount: 0, updatedAt: r.updatedAt)
            case "CompactMarkerV2":
                try chat.mergeRemoteCompactMarker(CompactMarker(id: r.id.id, sessionId: str("sessionId"), summary: "summary", firstKeptSortOrder: 1, compactedCount: 1, createdAt: r.updatedAt, uiBoundarySortOrder: nil, boundaryMessageId: nil, firstKeptMessageId: nil, lastCompactedMessageId: nil))
            case "ProviderInstanceV3":
                _ = try provider.upsertInstanceFromInbound(id: r.id.id, label: "parent", providerType: "test", credentialType: nil, customBaseURL: nil, appendV1Suffix: false, imageEndpointMode: nil, imageEndpointResolved: nil, isEnabled: true, sortOrder: 0, secretBlob: nil, secretKind: nil, secretUpdatedAt: nil, createdAt: 1, updatedAt: r.updatedAt.timeIntervalSince1970, extrasJson: nil, customUserAgent: nil)
            case "ProviderModelEntryV3":
                _ = try provider.upsertEntryFromInbound(id: r.id.id, providerInstanceId: str("providerInstanceId"), baseModelJson: "{}", overridesJson: nil, isCustom: false, isHidden: false, userModifiedAt: nil, sortOrder: 0, updatedAt: r.updatedAt.timeIntervalSince1970, extrasJson: nil)
            default: throw CocoaError(.fileReadUnknown)
            }
            applied.append(r.id.description)
        }
        for id in batch.deletes {
            guard id.type == "MessageV2" else { throw CocoaError(.fileWriteUnknown) }
            try chat.deleteLocalMessage(messageId: id.id)
            applied.append("delete:" + id.description)
        }
    }
    @discardableResult func drain(_ journal: CloudKitInboundJournal, limit: Int = 256) throws -> Int {
        var pass = CloudKitInboundJournal.DeliveryPass(limit: limit)
        var attempts = 0
        while let page = try pass.claim(from: journal) {
            attempts += 1
            do {
                try apply(page.batch)
                _ = try journal.acknowledge(page.batch)
                pass.acknowledged()
            } catch { journal.release(page.id) }
        }
        return attempts
    }
}

@main enum CloudKitDependencyProgress {
    static func check(_ condition: Bool, _ message: String = "dependency assertion failed") { precondition(condition, message) }
    @MainActor static func main() throws {
        let fm = FileManager.default
        let root = fm.temporaryDirectory.appendingPathComponent("cloud-dependencies-" + UUID().uuidString)
        try fm.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? fm.removeItem(at: root) }
        func setup(_ name: String) throws -> (Harness, CloudKitInboundJournal, URL) {
            let path = root.appendingPathComponent(name)
            try fm.createDirectory(at: path, withIntermediateDirectories: true)
            return (Harness(path), try CloudKitInboundJournal(directory: path.appendingPathComponent("inbox")), path)
        }
        func rec(_ type: String, _ id: String, parent: String? = nil, clock: Double = 2) -> PortableRecord {
            let field = type == "ProviderModelEntryV3" ? "providerInstanceId" : "sessionId"
            return PortableRecord(id: .init(type: type, id: id), fields: parent.map { [field: .string($0)] } ?? [:], updatedAt: Date(timeIntervalSince1970: clock))
        }
        for separatePages in [false, true] {
            let (h, j, _) = try setup(separatePages ? "cross-page" : "same-page")
            let children = [rec("MessageV2", "m", parent: "s"), rec("CompactMarkerV2", "c", parent: "s")]
            if separatePages {
                try j.append(records: children, deletes: [])
                for i in 0..<51 { try j.append(records: [rec("SessionV2", "unrelated-\(i)")], deletes: []) }
                try j.append(records: [rec("SessionV2", "s", clock: 1)], deletes: [])
            } else { try j.append(records: children + [rec("SessionV2", "s", clock: 1)], deletes: []) }
            try h.drain(j)
            check(j.pendingCount == 0)
            check(h.scalar("SELECT COUNT(*) FROM messages") == "1")
            check(h.scalar("SELECT COUNT(*) FROM compact_markers") == "1")
            check(h.applied.firstIndex(of: "SessionV2:s")! < h.applied.firstIndex(of: "MessageV2:m")!)
        }
        // A recent child with a parent far outside the time window. The actual
        // dependency mapper yields a stable parent ID; network response is a
        // fixture and enters through the real durable append path.
        do {
            let (h, j, path) = try setup("old-parent")
            let file = path.appendingPathComponent("temporary")
            try Data("child asset".utf8).write(to: file)
            let child = PortableRecord(id: .init(type: "MessageV2", id: "m"), fields: ["sessionId": .string("old")], assets: ["asset": .init(key: "asset", fileURL: file, size: 11, mimeType: nil)], updatedAt: Date())
            try j.append(records: [child], deletes: [])
            try fm.removeItem(at: file)
            check(try h.drain(j) == 1, "no progress must stop retrying")
            let resumed = try CloudKitInboundJournal(directory: j.directory)
            let held = try resumed.peek()!
            check(try Data(contentsOf: held.records[0].assets["asset"]!.fileURL) == Data("child asset".utf8))
            check(CloudKitInboundJournal.dependency(for: child) == .init(type: "SessionV2", id: "old"))
            let cloudRecords = [SyncRecordID(type: "SessionV2", id: "old"): rec("SessionV2", "old", clock: 1)]
            try resumed.append(records: [cloudRecords[CloudKitInboundJournal.dependency(for: child)!]!], deletes: [])
            h.reopen(); try h.drain(resumed)
            check(resumed.pendingCount == 0)
            check(h.scalar("SELECT updated_at FROM messages WHERE id='m'") != "1.0", "deferred child must preserve its updatedAt")
        }
        do {
            let (h, j, _) = try setup("provider")
            let child = rec("ProviderModelEntryV3", "entry", parent: "instance")
            check(CloudKitInboundJournal.dependency(for: child) == .init(type: "ProviderInstanceV3", id: "instance"))
            try j.append(records: [child], deletes: [])
            try j.append(records: [rec("ProviderInstanceV3", "instance", clock: 1)], deletes: [])
            try h.drain(j)
            check(j.pendingCount == 0 && h.scalar("SELECT COUNT(*) FROM provider_model_entries") == "1")
        }
        // Failed parent writes remain durable; an unrelated row still applies.
        do {
            let (h, j, _) = try setup("parent-fault")
            h.sql("CREATE TRIGGER fail_parent BEFORE INSERT ON sessions WHEN NEW.id='s' BEGIN SELECT RAISE(ABORT,'disk full'); END")
            try j.append(records: [rec("MessageV2", "m", parent: "s"), rec("SessionV2", "s"), rec("SessionV2", "healthy")], deletes: [])
            let attempts = try h.drain(j)
            check(attempts <= 6 && j.pendingCount == 1)
            check(h.scalar("SELECT COUNT(*) FROM sessions WHERE id='healthy'") == "1")
            h.sql("DROP TRIGGER fail_parent"); h.reopen()
            let restarted = try CloudKitInboundJournal(directory: j.directory)
            try h.drain(restarted)
            check(restarted.pendingCount == 0 && h.scalar("SELECT COUNT(*) FROM messages") == "1")
        }
        // Same-record mutations and deletes are barriers, even across pages.
        do {
            let (h, j, _) = try setup("ordering")
            let first = rec("MessageV2", "m", parent: "s", clock: 2)
            try j.append(records: [first], deletes: [])
            try j.append(records: [], deletes: [first.id])
            try j.append(records: [rec("MessageV2", "m", parent: "s", clock: 3), rec("SessionV2", "healthy")], deletes: [])
            try h.drain(j)
            check(!h.applied.contains("delete:MessageV2:m"), "delete overtook failed upsert")
            try j.append(records: [rec("SessionV2", "s", clock: 1)], deletes: [])
            try h.drain(j)
            check(h.applied.filter { $0.contains("MessageV2:m") } == ["MessageV2:m", "delete:MessageV2:m", "MessageV2:m"])
            check(h.scalar("SELECT updated_at FROM messages WHERE id='m'") == "3.0")
            check(j.pendingCount == 0)
        }
        // Poison/unsupported entries retain bytes without blocking healthy IDs;
        // successful entry ACKs survive restart in the middle of a shared page.
        do {
            let (h, j, _) = try setup("poison")
            try j.append(records: [rec("UnsupportedFutureV9", "bad"), rec("SessionV2", "ok")], deletes: [])
            check(try h.drain(j) <= 4)
            check(h.scalar("SELECT COUNT(*) FROM sessions") == "1")
            let resumed = try CloudKitInboundJournal(directory: j.directory)
            check(try resumed.hasPendingMutation(for: .init(type: "UnsupportedFutureV9", id: "bad")))
            check(!(try resumed.hasPendingMutation(for: .init(type: "SessionV2", id: "ok"))))
            check(try h.drain(resumed) == 1)
        }
        // SQL committed, process died before ACK: idempotent replay preserves
        // child progress. A replacement transport cannot steal an active lease.
        do {
            let (h, j, _) = try setup("overlap")
            try j.append(records: [rec("MessageV2", "m", parent: "s"), rec("SessionV2", "s")], deletes: [])
            var pass = CloudKitInboundJournal.DeliveryPass()
            let child = try pass.claim(from: j)!
            let replacement = try CloudKitInboundJournal(directory: j.directory)
            check(try replacement.claimFirst() == nil)
            j.release(child.id)
            let parent = try pass.claim(from: j)!
            try h.apply(parent.batch)
            j.release(parent.id) // simulated termination before ACK
            h.reopen()
            try h.drain(replacement)
            check(replacement.pendingCount == 0 && h.scalar("SELECT COUNT(*) FROM messages") == "1")
        }
        // Partial-page ACK write failure keeps completed domain work replayable.
        do {
            let (h, j, _) = try setup("ack-fault")
            try j.append(records: [rec("UnsupportedFutureV9", "bad"), rec("SessionV2", "ok")], deletes: [])
            let fault = try CloudKitInboundJournal(directory: j.directory) { _, _ in throw CocoaError(.fileWriteOutOfSpace) }
            try h.drain(fault)
            check(try CloudKitInboundJournal(directory: j.directory).hasPendingMutation(for: .init(type: "SessionV2", id: "ok")))
            try h.drain(j)
            check(!(try j.hasPendingMutation(for: .init(type: "SessionV2", id: "ok"))))
        }
        // Hard cap bounds even a stream of successful work and leaves the rest.
        do {
            let (h, j, _) = try setup("cap")
            try j.append(records: (0..<8).map { rec("SessionV2", "s\($0)") }, deletes: [])
            check(try h.drain(j, limit: 3) == 3)
            check(j.pendingCount == 1)
            try h.drain(j); check(j.pendingCount == 0)
        }
        // More failures than the per-wake budget cannot starve a late parent.
        do {
            let (h, j, _) = try setup("budget-resume")
            try j.append(records: (0..<9).map { rec("MessageV2", "m\($0)", parent: "s") } + [rec("SessionV2", "s")], deletes: [])
            var pass = CloudKitInboundJournal.DeliveryPass(limit: 3)
            for _ in 0..<10 {
                pass.begin()
                while let page = try pass.claim(from: j) {
                    do { try h.apply(page.batch); _ = try j.acknowledge(page.batch); pass.acknowledged() }
                    catch { j.release(page.id) }
                }
                if j.pendingCount == 0 { break }
            }
            check(j.pendingCount == 0 && h.scalar("SELECT COUNT(*) FROM messages") == "9")
        }
        print("CloudKitDependencyProgress: same/cross-page + event parents, old-parent ID recovery, Message/CompactMarker/Provider SQL, restart/partial ACK/write faults, delete barriers, unsupported poison, overlapping leases and bounded passes passed")
    }
}
'''

sync = ROOT / 'src/ios/Agent/Sync/V2'
transport = (sync / 'ICloudSharedZoneTransport.swift').read_text()
assert 'record(for: ckID)' in transport, 'old parents need a date-window-independent path'
assert 'hasPendingInbound()' not in transport, 'backlog must not prevent ingestion'
assert 'inboundPass.claim(from: journal)' in transport
assert 'await fetchInboundDependency(dependency)' in transport
core = (sync / 'SyncCore.swift').read_text()
unknown = core[core.index('guard let metadata = registry.metadata(for: record.id.type)'):]
assert 'blocked += 1' in unknown[:500]
with tempfile.TemporaryDirectory(prefix='cloud-dependency-build-') as temp:
    work = Path(temp)
    probe = work / 'Probe.swift'
    probe.write_text('import Foundation\n' + marker + '\n' + support + '\n'.join(method(chat, n) for n in chat_methods) + '\n}\n' + provider_support + '\n'.join(method(provider, n) for n in provider_methods) + '\n}\n' + main)
    binary = work / 'dependencies'
    flags = [a.swiftc, '-suppress-warnings', '-module-cache-path', str(work / 'cache'), '-parse-as-library']
    if a.sqlite_module:
        flags += ['-I', a.sqlite_module, '-L', a.sqlite_module]
    subprocess.run(flags + [str(sync / 'SyncDeliveryLedger.swift'), str(sync / 'PortableRecord.swift'), str(sync / 'CloudKitInboundJournal.swift'), str(sync / 'SessionProvenanceStore.swift'), str(probe), '-o', str(binary)], check=True)
    subprocess.run([str(binary)], check=True)
