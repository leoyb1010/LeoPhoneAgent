import Foundation
import SQLite3

@main enum SyncDeliveryLedgerSmoke {
    static func main() throws {
        let path = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".sqlite")
        defer { try? FileManager.default.removeItem(at: path) }
        var db: OpaquePointer?
        precondition(sqlite3_open(path.path, &db) == SQLITE_OK)
        defer { sqlite3_close(db) }
        func expect(_ value: Bool, _ message: String = "ledger assertion") { precondition(value, message) }
        func sql(_ text: String) { let rc = sqlite3_exec(db, text, nil, nil, nil); precondition(rc == SQLITE_OK, String(cString: sqlite3_errmsg(db))) }
        sql("CREATE TABLE sync_dirty_records(record_type TEXT,record_id TEXT,zone_name TEXT DEFAULT '',operation TEXT DEFAULT 'upsert',priority INTEGER DEFAULT 0,created_at REAL DEFAULT 1,PRIMARY KEY(record_type,record_id))")
        sql("INSERT INTO sync_dirty_records(record_type,record_id) VALUES('SessionV2','legacy')")
        try SyncDeliveryLedger.migrate(db, recordTypes: ["SessionV2"])
        try SyncDeliveryLedger.configure(db, enabled: ["iCloud", "tailnet:mac"])
        let cloud = try SyncDeliveryLedger.load(db, destination: "iCloud")[0]
        let peer = try SyncDeliveryLedger.load(db, destination: "tailnet:mac")[0]
        precondition(cloud.changeId == peer.changeId)
        try SyncDeliveryLedger.acknowledge(db, ticket: cloud)
        expect(try SyncDeliveryLedger.load(db, destination: "iCloud").isEmpty)
        sqlite3_close(db); db = nil; precondition(sqlite3_open(path.path, &db) == SQLITE_OK)
        try SyncDeliveryLedger.migrate(db, recordTypes: ["SessionV2"])
        try SyncDeliveryLedger.configure(db, enabled: ["iCloud", "tailnet:mac"])
        expect(try SyncDeliveryLedger.load(db, destination: "iCloud").isEmpty, "restart must not recreate acknowledged destination")
        expect(try SyncDeliveryLedger.load(db, destination: "tailnet:mac").count == 1)
        sql("UPDATE sync_dirty_records SET created_at=2 WHERE record_id='legacy'")
        let edit = try SyncDeliveryLedger.load(db, destination: "iCloud")[0]
        precondition(edit.revision > cloud.revision)
        try SyncDeliveryLedger.acknowledge(db, ticket: peer)
        expect(try SyncDeliveryLedger.load(db, destination: "tailnet:mac")[0].revision == edit.revision, "stale ACK must preserve newer revision")
        expect(try SyncDeliveryLedger.freeze(db, ticket: edit, payload: Data("original".utf8)))
        expect(try SyncDeliveryLedger.freeze(db, ticket: edit, payload: Data("mutated".utf8)))
        expect(try SyncDeliveryLedger.payload(db, ticket: edit) == Data("original".utf8), "retry snapshot immutable")
        try SyncDeliveryLedger.configure(db, enabled: ["iCloud"])
        expect(try SyncDeliveryLedger.load(db, destination: "tailnet:mac").isEmpty)
        try SyncDeliveryLedger.acknowledge(db, ticket: edit)
        expect(try SyncDeliveryLedger.count(db) == 0, "disabled destination must not spin dispatcher")
        expect(try SyncDeliveryLedger.count(db, enabledOnly: false) == 1)
        sql("DELETE FROM sync_dirty_records WHERE record_id='legacy'")
        expect(try SyncDeliveryLedger.count(db, enabledOnly: false, includeBlocked: true) == 0, "explicit cancellation cancels tickets")
        sql("INSERT INTO sync_dirty_records(record_type,record_id,operation) VALUES('SessionV2','legacy','delete')")
        let deletion = try SyncDeliveryLedger.load(db, destination: "iCloud")[0]
        precondition(deletion.revision > edit.revision, "revision survives delete/reinsert")
        try SyncDeliveryLedger.fail(db, ticket: deletion, reason: "permanent rejection")
        expect(try SyncDeliveryLedger.count(db) == 0)
        expect(try SyncDeliveryLedger.count(db, includeBlocked: true) == 1, "permanent failure stays visible")
        try SyncDeliveryLedger.retryFailures(db)
        expect(try SyncDeliveryLedger.count(db) == 1)
        sql("BEGIN; UPDATE sync_dirty_records SET created_at=3; ROLLBACK")
        expect(try SyncDeliveryLedger.load(db, destination: "iCloud")[0].revision == deletion.revision, "dirty and tickets rollback atomically")
        try SyncDeliveryLedger.configure(db, enabled: ["iCloud", "tailnet:mac"])
        let finalCloud = try SyncDeliveryLedger.load(db, destination: "iCloud")[0]
        let finalPeer = try SyncDeliveryLedger.load(db, destination: "tailnet:mac")[0]
        try SyncDeliveryLedger.acknowledge(db, ticket: finalCloud)
        try SyncDeliveryLedger.acknowledge(db, ticket: finalPeer)
        try SyncDeliveryLedger.acknowledge(db, ticket: finalCloud)
        expect(try SyncDeliveryLedger.count(db, enabledOnly: false, includeBlocked: true) == 0, "all destinations ACK cleans queue and duplicate ACK is harmless")
        sql("INSERT INTO sync_dirty_records(record_type,record_id) VALUES('SessionV2','legacy')")
        expect(try SyncDeliveryLedger.load(db, destination: "iCloud")[0].revision > finalCloud.revision, "ACK cleanup also preserves revision head")
        // Replica seed: tickets for ONE destination, no dirty row, iCloud untouched.
        let legacyCloud = try SyncDeliveryLedger.load(db, destination: "iCloud")[0]
        try SyncDeliveryLedger.acknowledge(db, ticket: legacyCloud)
        try SyncDeliveryLedger.seed(db, destination: "tailnet:mac", recordType: "SessionV2", recordId: "legacy")
        try SyncDeliveryLedger.seed(db, destination: "tailnet:mac", recordType: "MessageV2", recordId: "never-dirty")
        expect(try SyncDeliveryLedger.load(db, destination: "iCloud").isEmpty, "seeding a replica must not re-queue iCloud")
        let seeded = try SyncDeliveryLedger.load(db, destination: "tailnet:mac")
        expect(seeded.count == 2 && seeded.allSatisfy { $0.operation == "upsert" }, "seed queues every record for the replica")
        let seededLegacy = seeded.first { $0.recordId == "legacy" }!
        expect(seededLegacy.revision == legacyCloud.revision, "seed reuses the current head revision")
        try SyncDeliveryLedger.seed(db, destination: "tailnet:mac", recordType: "SessionV2", recordId: "legacy")
        expect(try SyncDeliveryLedger.load(db, destination: "tailnet:mac").count == 2, "re-seed is idempotent")
        expect(try SyncDeliveryLedger.freeze(db, ticket: seededLegacy, payload: Data("x".utf8)))
        try SyncDeliveryLedger.acknowledge(db, ticket: seededLegacy)
        expect(try SyncDeliveryLedger.payload(db, ticket: seededLegacy) == nil, "ACK reclaims frozen bytes of seeded tickets")
        // Purging a turned-off replica drains rows only it was pinning; iCloud work stays.
        try SyncDeliveryLedger.configure(db, enabled: ["iCloud", "tailnet:mac"])
        sql("INSERT OR REPLACE INTO sync_dirty_records(record_type,record_id,created_at) VALUES('SessionV2','pinned',9)")
        sql("INSERT OR REPLACE INTO sync_dirty_records(record_type,record_id,created_at) VALUES('SessionV2','pending',9)")
        let pinnedCloud = try SyncDeliveryLedger.load(db, destination: "iCloud").first { $0.recordId == "pinned" }!
        try SyncDeliveryLedger.acknowledge(db, ticket: pinnedCloud)
        expect(try SyncDeliveryLedger.purge(db, prefix: "tailnet:", keeping: ["tailnet:other"]) == ["tailnet:mac"])
        expect(try SyncDeliveryLedger.load(db, destination: "tailnet:mac").isEmpty, "purged replica has no tickets")
        expect(try SyncDeliveryLedger.load(db, destination: "iCloud").contains { $0.recordId == "pending" }, "iCloud work survives purge")
        var dirtyStmt: OpaquePointer?
        sqlite3_prepare_v2(db, "SELECT count(*) FROM sync_dirty_records WHERE record_id='pinned'", -1, &dirtyStmt, nil)
        sqlite3_step(dirtyStmt); let pinnedRows = sqlite3_column_int(dirtyStmt, 0); sqlite3_finalize(dirtyStmt)
        expect(pinnedRows == 0, "row acknowledged by every remaining destination is drained")
        // A disabled category retains its tickets but must not occupy the
        // bounded ready page ahead of enabled categories.
        try SyncDeliveryLedger.configure(db, enabled: ["tailnet:solo"])
        for index in 0..<120 { try SyncDeliveryLedger.seed(db, destination: "tailnet:solo", recordType: "EnvVarItem", recordId: "private-\(index)") }
        try SyncDeliveryLedger.seed(db, destination: "tailnet:solo", recordType: "SessionV2", recordId: "allowed")
        let permitted = try SyncDeliveryLedger.load(db, destination: "tailnet:solo", excludingTypes: ["EnvVarItem"])
        expect(permitted.contains { $0.recordId == "allowed" } && permitted.allSatisfy { $0.recordType != "EnvVarItem" }, "disabled category must not starve enabled records")
        let privateTicket = try SyncDeliveryLedger.load(db, destination: "tailnet:solo").first { $0.recordType == "EnvVarItem" }!
        expect(try SyncDeliveryLedger.freeze(db, ticket: privateTicket, payload: Data("single-destination-v1".utf8)))
        sqlite3_close(db); db = nil; precondition(sqlite3_open(path.path, &db) == SQLITE_OK)
        expect(try SyncDeliveryLedger.payload(db, ticket: privateTicket) == Data("single-destination-v1".utf8), "single-destination lost-ACK restart preserves payload")
        expect(try SyncDeliveryLedger.freeze(db, ticket: privateTicket, payload: Data("single-destination-v2".utf8)))
        expect(try SyncDeliveryLedger.payload(db, ticket: privateTicket) == Data("single-destination-v1".utf8), "same receipt ID must retain original bytes after restart")
        print("SyncDeliveryLedgerSmoke: multi-destination, restart, stale ACK, immutable snapshot, disable, cancel, monotonic recreate, permanent failure, transactional rollback, replica seed, replica purge passed")
    }
}
