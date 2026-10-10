import Foundation
import SQLite3
import XCTest

/// Runs the real search SQL (ChatSearchSQL) against an in-memory SQLite with
/// the columns it touches.
final class SearchEscapeTests: XCTestCase {

    private let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
    private var db: OpaquePointer?

    override func setUpWithError() throws {
        XCTAssertEqual(sqlite3_open(":memory:", &db), SQLITE_OK)
        exec("""
            CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT, model_id TEXT, created_at REAL,
                                   updated_at REAL, category TEXT, parent_session_id TEXT);
            CREATE TABLE messages (id TEXT PRIMARY KEY, session_id TEXT, parts_json TEXT, sort_order INTEGER);
            """)
    }

    override func tearDown() {
        sqlite3_close(db)
        super.tearDown()
    }

    private func exec(_ sql: String) {
        XCTAssertEqual(sqlite3_exec(db, sql, nil, nil, nil), SQLITE_OK, String(cString: sqlite3_errmsg(db)))
    }

    /// parts_json exactly as the app writes it (JSONEncoder escapes `/` and `"`).
    private func parts(_ texts: [String], tool: Bool = false) throws -> String {
        var array: [[String: String]] = texts.map { ["type": "text", "value": $0] }
        if tool { array.append(["type": "toolUse", "value": "\"quoted\" a_b"]) }
        return String(decoding: try JSONEncoder().encode(array), as: UTF8.self)
    }

    private func insertSession(_ id: String, title: String?, updated: Double, messages: [String] = []) {
        var stmt: OpaquePointer?
        sqlite3_prepare_v2(db, "INSERT INTO sessions VALUES (?, ?, 'm', 0, ?, NULL, NULL)", -1, &stmt, nil)
        sqlite3_bind_text(stmt, 1, id, -1, transient)
        if let title { sqlite3_bind_text(stmt, 2, title, -1, transient) } else { sqlite3_bind_null(stmt, 2) }
        sqlite3_bind_double(stmt, 3, updated)
        XCTAssertEqual(sqlite3_step(stmt), SQLITE_DONE)
        sqlite3_finalize(stmt)
        for (i, json) in messages.enumerated() {
            sqlite3_prepare_v2(db, "INSERT INTO messages VALUES (?, ?, ?, ?)", -1, &stmt, nil)
            sqlite3_bind_text(stmt, 1, "\(id)-\(i)", -1, transient)
            sqlite3_bind_text(stmt, 2, id, -1, transient)
            sqlite3_bind_text(stmt, 3, json, -1, transient)
            sqlite3_bind_int(stmt, 4, Int32(i))
            XCTAssertEqual(sqlite3_step(stmt), SQLITE_DONE)
            sqlite3_finalize(stmt)
        }
    }

    private func search(_ query: String) -> [String] {
        guard let built = ChatSearchSQL.sessionSearch(query: query) else { return [] }
        var stmt: OpaquePointer?
        XCTAssertEqual(sqlite3_prepare_v2(db, built.sql, -1, &stmt, nil), SQLITE_OK, String(cString: sqlite3_errmsg(db)))
        for (i, value) in built.bindings.enumerated() { sqlite3_bind_text(stmt, Int32(i + 1), value, -1, transient) }
        var ids: [String] = []
        var rc = sqlite3_step(stmt)
        while rc == SQLITE_ROW {
            ids.append(String(cString: sqlite3_column_text(stmt, 0)))
            rc = sqlite3_step(stmt)
        }
        XCTAssertEqual(rc, SQLITE_DONE, String(cString: sqlite3_errmsg(db)))
        sqlite3_finalize(stmt)
        return ids
    }

    func testSearchSessionsQuoteDoesNotMatchEverything() throws {
        insertSession("S1", title: "Trip", updated: 3, messages: [try parts(["hello world"], tool: true)])
        insertSession("S2", title: "Code", updated: 2, messages: [try parts(["she said \"hi\""])])
        insertSession("S3", title: "Notes", updated: 1, messages: ["{not json"])
        XCTAssertEqual(search("\""), ["S2"], "only a message that really contains a quote")
        XCTAssertEqual(search("type"), [], "the JSON envelope is not searchable text")
        XCTAssertEqual(search("value"), [])
        XCTAssertEqual(search("hello"), ["S1"])
        XCTAssertEqual(search("trip"), ["S1"], "titles still match (case-insensitive)")
        XCTAssertEqual(search("quoted"), [], "tool payloads are not message text")
        XCTAssertEqual(search("not json"), [], "a corrupt row neither matches nor breaks the query")
    }

    func testSearchMessagesEscapesLikeWildcards() throws {
        insertSession("S1", title: nil, updated: 2, messages: [try parts(["file a_b.txt"])])
        insertSession("S2", title: nil, updated: 1, messages: [try parts(["file axb.txt and 100 percent"])])
        XCTAssertEqual(search("a_b"), ["S1"], "`_` is a literal, not any character")
        XCTAssertEqual(search("100%"), [], "`%` is a literal")
        XCTAssertEqual(search("a/b"), [])
        insertSession("S3", title: nil, updated: 0, messages: [try parts(["path a/b/c"])])
        XCTAssertEqual(search("a/b"), ["S3"], "`/` is escaped by JSONEncoder; the text projection still finds it")

        // The tool-search helpers use the same escaping.
        func like(_ text: String, _ pattern: String) -> Bool {
            var stmt: OpaquePointer?
            sqlite3_prepare_v2(db, "SELECT ? LIKE ? ESCAPE '\\'", -1, &stmt, nil)
            sqlite3_bind_text(stmt, 1, text, -1, transient)
            sqlite3_bind_text(stmt, 2, pattern, -1, transient)
            sqlite3_step(stmt)
            defer { sqlite3_finalize(stmt) }
            return sqlite3_column_int(stmt, 0) == 1
        }
        XCTAssertFalse(like("axb", ChatSearchSQL.containsPattern("a_b")))
        XCTAssertTrue(like("xa_bx", ChatSearchSQL.containsPattern("a_b")))
        XCTAssertFalse(like("100 percent", ChatSearchSQL.containsPattern("100%")))
        XCTAssertTrue(like("c:\\dir", ChatSearchSQL.containsPattern("c:\\d")))
    }

    func testQueryIsBounded() {
        XCTAssertNil(ChatSearchSQL.normalizedQuery("   \n"))
        XCTAssertEqual(ChatSearchSQL.normalizedQuery(String(repeating: "q", count: 100_000))?.count, ChatSearchSQL.maxQueryLength)
        XCTAssertNil(ChatSearchSQL.sessionSearch(query: ""))
    }
}
