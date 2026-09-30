#!/usr/bin/env python3
"""Exercise the exact file-deletion hydrator and pending SQL against a large queue.

Only the Library location and unrelated platform dependencies are adapted.
No user app data or preferences are read or written.
"""
from pathlib import Path
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
SYNC = ROOT / 'src/ios/Agent/Sync/V2'


def method(source, name):
    start = source.index('func ' + name + '(')
    start = source.rfind('\n', 0, start) + 1
    end = source.index('\n    }', start) + 6
    return source[start:end]


chat = (ROOT / 'src/ios/Agent/Chat/ChatStore.swift').read_text()
hydrators = (SYNC / 'ChatStoreSyncHydrators.swift').read_text()
sink = method(hydrators, 'deleteSessionFile').replace('private static func', 'static func', 1)
library = 'FileManager.default.urls(for: .libraryDirectory, in: .userDomainMask).first!'
assert library in sink
sink = sink.replace(library, 'testLibrary', 1)
methods = ['loadDirtyRecords']
if 'func hasPendingSessionFileEdit(' in chat:
    methods += ['hasPendingSessionFileEdit', 'prepareInbound', 'stepInbound']

support = r'''
import Foundation
import SQLite3
let testLibrary = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
struct TestLogger { func info(_ text: String) {} }
let logger = TestLogger()
struct DirtyRecord { let recordType: String; let recordId: String; let zoneName: String; let operation: String }
actor ChatStore {
    static let shared = ChatStore()
    static let v2SyncRecordTypesSQL = "'SessionFileV2'"
    let db: OpaquePointer?
    init() {
        var handle: OpaquePointer?
        precondition(sqlite3_open(":memory:", &handle) == SQLITE_OK)
        db = handle
        precondition(sqlite3_exec(handle, "CREATE TABLE sync_dirty_records(record_type TEXT,record_id TEXT,zone_name TEXT,operation TEXT,priority INTEGER,created_at REAL)", nil, nil, nil) == SQLITE_OK)
    }
    func sql(_ text: String) { precondition(sqlite3_exec(db, text, nil, nil, nil) == SQLITE_OK) }
    func recordDeletedRecordTombstone(type: String, id: String, at: Date) -> Bool { true }
'''
tracker = r'''
}
actor SessionFileChangeTracker {
    static let shared = SessionFileChangeTracker()
    var pending = false
    func hasPendingChange(sessionId: String, relativePath: String) -> Bool { pending }
    func setPending(_ value: Bool) { pending = value }
}
enum HydratorProbe {
'''
main = r'''
}
@main enum PendingDeletionSmoke {
    static func main() async throws {
        let store = ChatStore.shared
        let fm = FileManager.default
        defer { try? fm.removeItem(at: testLibrary) }
        let file = testLibrary.appendingPathComponent("MinisChat/minis/s/workspace/file.txt")
        try fm.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        func writeFile() throws { try Data("unpublished local edit".utf8).write(to: file) }
        func protected(_ label: String) async throws {
            try writeFile()
            do {
                try await HydratorProbe.deleteSessionFile(id: "s:workspace/file.txt", updatedAt: nil)
                fatalError("\(label): clockless delete consumed unpublished local edit")
            } catch {}
            let content = try Data(contentsOf: file)
            precondition(content == Data("unpublished local edit".utf8), label)
        }
        // The producer has already drained its buffer into SQLite. Parent and
        // message rows put the pending file outside the old LIMIT 100 query.
        for n in 0..<101 {
            await store.sql("INSERT INTO sync_dirty_records VALUES('MessageV2','m\(n)','z','upsert',0,\(n))")
        }
        for type in ["SessionFile", "SessionFileV2"] {
            await store.sql("INSERT INTO sync_dirty_records VALUES('\(type)','s:workspace/file.txt','z','upsert',0,0)")
            let firstPage = await store.loadDirtyRecords()
            precondition(firstPage.count == 100 && !firstPage.contains { $0.recordId == "s:workspace/file.txt" })
            try await protected("queued \(type) beyond first page")
            await store.sql("DELETE FROM sync_dirty_records WHERE record_type='\(type)'")
        }
        await SessionFileChangeTracker.shared.setPending(true)
        try await protected("buffered edit")
        await SessionFileChangeTracker.shared.setPending(false)
        await store.sql("INSERT INTO sync_dirty_records VALUES('SessionFileV2','s:workspace/other.txt','z','upsert',0,0)")
        await store.sql("INSERT INTO sync_dirty_records VALUES('SessionFileV2','s:workspace/file.txt','z','delete',0,0)")
        try writeFile()
        try await HydratorProbe.deleteSessionFile(id: "s:workspace/file.txt", updatedAt: nil)
        precondition(!fm.fileExists(atPath: file.path), "unrelated edits and pending local deletes must not block")
        // A failed query must retain the destination and withhold ACK.
        await store.sql("DROP TABLE sync_dirty_records")
        try await protected("unavailable pending store")
        print("SessionFile pending-delete PASS: both aliases beyond 100 rows, buffered edit, unrelated/delete rows, failed SQL")
    }
}
'''

with tempfile.TemporaryDirectory(prefix='session-file-pending-') as temporary:
    work = Path(temporary)
    source = work / 'Probe.swift'
    source.write_text(support + '\n'.join(method(chat, name) for name in methods) + tracker
                      + method(hydrators, 'sessionFileURL') + '\n' + sink + main)
    binary = work / 'probe'
    swiftc = shutil.which('swiftc')
    if not swiftc:
        raise SystemExit('swiftc required')
    subprocess.run([swiftc, '-parse-as-library', '-module-cache-path', str(work / 'cache'),
                    str(SYNC / 'SyncFileSafety.swift'), str(source), '-o', str(binary)], check=True)
    subprocess.run([str(binary)], check=True)
