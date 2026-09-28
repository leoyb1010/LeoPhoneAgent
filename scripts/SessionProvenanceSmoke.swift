import Foundation
import SQLite3

@main enum SessionProvenanceSmoke {
    static func main() throws {
        var handle: OpaquePointer?
        precondition(sqlite3_open(":memory:", &handle) == SQLITE_OK)
        let db = handle!
        defer { sqlite3_close(db) }
        func sql(_ value: String) { precondition(sqlite3_exec(db, value, nil, nil, nil) == SQLITE_OK) }
        sql("CREATE TABLE sessions(id TEXT PRIMARY KEY, remote_origin_device_id TEXT, updated_at REAL)")
        sql("INSERT INTO sessions VALUES ('legacy-local',NULL,1),('legacy-v2','',1),('legacy-v1','ipad',1),('new',NULL,1)")
        try SessionProvenanceStore.migrate(db)
        try SessionProvenanceStore.migrate(db)
        precondition(SessionProvenanceStore.read(db, id: "legacy-local").origin == nil)
        precondition(SessionProvenanceStore.read(db, id: "legacy-v2").origin == nil)
        precondition(SessionProvenanceStore.read(db, id: "legacy-v1").origin == "ipad")
        SessionProvenanceStore.createdLocally(db, id: "new", deviceID: "iphone")
        SessionProvenanceStore.merge(db, id: "new", origin: "ipad", writer: "ipad", acceptsWriter: true)
        precondition(SessionProvenanceStore.read(db, id: "new").origin == "iphone", "editing device cannot steal creator")
        precondition(SessionProvenanceStore.read(db, id: "new").writer == "ipad")
        SessionProvenanceStore.merge(db, id: "new", origin: nil, writer: "stale", acceptsWriter: false)
        precondition(SessionProvenanceStore.read(db, id: "new").writer == "ipad", "stale record cannot steal writer")
        SessionProvenanceStore.merge(db, id: "new", origin: nil, writer: nil, acceptsWriter: true)
        precondition(SessionProvenanceStore.read(db, id: "new").writer == nil, "newer legacy edit has unknown writer")
        SessionProvenanceStore.editedLocally(db, id: "legacy-local", deviceID: "iphone")
        precondition(SessionProvenanceStore.read(db, id: "legacy-local").origin == nil, "editing old data must not invent creator")
        precondition(SessionProvenanceStore.read(db, id: "legacy-local").writer == "iphone")
        SessionProvenanceStore.merge(db, id: "legacy-v2", origin: "ipad", writer: "ipad", acceptsWriter: true)
        precondition(SessionProvenanceStore.read(db, id: "legacy-v2").origin == "ipad")
        print("SessionProvenanceSmoke: migration, unknown legacy, creator immutability, LWW writer, legacy writer clearing, local edit passed")
    }
}
