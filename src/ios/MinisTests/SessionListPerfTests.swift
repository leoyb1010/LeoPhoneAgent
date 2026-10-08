import SQLite3
import XCTest

private let TRANSIENT = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

/// [T-ios-listsessions-perf] Session list: persisted preview, incremental
/// cache patch, refresh cooldown. Runs the production SQL text
/// (SessionListQuery / SessionPreviewRule) against a database migrated by the
/// production ChatStoreSchemaContract, with LeoBot's provenance columns added
/// the way SessionProvenanceStore adds them.
final class SessionListPerfTests: XCTestCase {
    private var db: OpaquePointer?

    override func setUpWithError() throws {
        XCTAssertEqual(sqlite3_open(":memory:", &db), SQLITE_OK)
        _ = try ChatStoreSchemaContract.migrate(db)
        try exec("ALTER TABLE sessions ADD COLUMN origin_device_id TEXT")
        try exec("ALTER TABLE sessions ADD COLUMN last_writer_device_id TEXT")
        try exec("CREATE TABLE sync_devices (device_id TEXT PRIMARY KEY, device_name TEXT)")
    }

    override func tearDown() {
        sqlite3_close(db)
        db = nil
    }

    // MARK: - Schema contract

    func testContractV4CarriesNullablePreviewColumns() throws {
        XCTAssertGreaterThanOrEqual(ChatStoreSchemaContract.currentVersion, 4)
        XCTAssertEqual(ChatStoreSchemaContract.validate(db), [])
        let info = try rows("PRAGMA table_info(sessions)") { stmt in
            (text(stmt, 1) ?? "", text(stmt, 2) ?? "", sqlite3_column_int(stmt, 3), sqlite3_column_type(stmt, 4) == SQLITE_NULL)
        }
        let previewText = try XCTUnwrap(info.first { $0.0 == "preview_text" })
        let previewOrder = try XCTUnwrap(info.first { $0.0 == "preview_sort_order" })
        XCTAssertEqual(previewText.1, "TEXT")
        XCTAssertEqual(previewOrder.1, "INTEGER")
        XCTAssertEqual(previewText.2, 0, "nullable")
        XCTAssertTrue(previewText.3, "no DEFAULT: NULL must mean 'not computed yet'")
        XCTAssertTrue(previewOrder.3)
    }

    func testV3DatabaseGainsPreviewColumnsWithoutLosingRows() throws {
        var legacy: OpaquePointer?
        XCTAssertEqual(sqlite3_open(":memory:", &legacy), SQLITE_OK)
        defer { sqlite3_close(legacy) }
        _ = try ChatStoreSchemaContract.migrate(legacy)
        XCTAssertEqual(sqlite3_exec(legacy, "ALTER TABLE sessions DROP COLUMN preview_sort_order", nil, nil, nil), SQLITE_OK)
        XCTAssertEqual(sqlite3_exec(legacy, "ALTER TABLE sessions DROP COLUMN preview_text", nil, nil, nil), SQLITE_OK)
        XCTAssertEqual(sqlite3_exec(legacy, "UPDATE chat_store_schema_meta SET contract_version = 3", nil, nil, nil), SQLITE_OK)
        XCTAssertEqual(sqlite3_exec(legacy, "INSERT INTO sessions (id, title, model_id, created_at, updated_at) VALUES ('s1','T','m',1,2)", nil, nil, nil), SQLITE_OK)

        let report = try ChatStoreSchemaContract.migrate(legacy)
        XCTAssertEqual(report.previousVersion, 3)
        XCTAssertTrue(report.addedColumns.contains("sessions.preview_text"))
        XCTAssertTrue(report.addedColumns.contains("sessions.preview_sort_order"))
        var stmt: OpaquePointer?
        defer { sqlite3_finalize(stmt) }
        XCTAssertEqual(sqlite3_prepare_v2(legacy, "SELECT title, preview_text IS NULL FROM sessions WHERE id='s1'", -1, &stmt, nil), SQLITE_OK)
        XCTAssertEqual(sqlite3_step(stmt), SQLITE_ROW)
        XCTAssertEqual(text(stmt, 0), "T")
        XCTAssertEqual(sqlite3_column_int(stmt, 1), 1, "pre-upgrade rows start NULL → one-time backfill")
    }

    /// The decode in ChatStore reads by index; this pins LeoBot's layout
    /// (14-16 provenance, 17/18 preview) against the SQL text itself.
    func testListQueryColumnLayoutMatchesDecodeMap() throws {
        var stmt: OpaquePointer?
        defer { sqlite3_finalize(stmt) }
        XCTAssertEqual(sqlite3_prepare_v2(db, SessionListQuery.sql(whereClause: ""), -1, &stmt, nil), SQLITE_OK,
                       String(cString: sqlite3_errmsg(db)))
        XCTAssertEqual(Int(sqlite3_column_count(stmt)), SessionListQuery.Column.count)
        typealias C = SessionListQuery.Column
        let expected: [(Int32, String)] = [
            (C.id, "id"), (C.title, "title"), (C.modelId, "model_id"), (C.createdAt, "created_at"),
            (C.updatedAt, "updated_at"), (C.category, "category"), (C.source, "source"),
            (C.lastSyncedAt, "last_synced_at"), (C.remoteOriginDeviceId, "remote_origin_device_id"),
            (C.pinnedAt, "pinned_at"), (C.originDeviceId, "origin_device_id"),
            (C.lastWriterDeviceId, "last_writer_device_id"),
            (C.previewText, "preview_text"), (C.previewSortOrder, "preview_sort_order"),
        ]
        for (index, name) in expected {
            XCTAssertEqual(String(cString: sqlite3_column_name(stmt, index)), name, "column \(index)")
        }
        var filtered: OpaquePointer?
        defer { sqlite3_finalize(filtered) }
        XCTAssertEqual(sqlite3_prepare_v2(db, SessionListQuery.sql(whereClause: SessionListQuery.idFilter(count: 3)), -1, &filtered, nil), SQLITE_OK)
        XCTAssertEqual(sqlite3_bind_parameter_count(filtered), 3)
    }

    /// [T-subagent] Hidden child sessions never reach the sidebar, on the full
    /// rebuild or the incremental patch.
    func testChildSessionsExcludedOnFullAndPatchPaths() throws {
        try insertSession("parent", updatedAt: 1, preview: "")
        try insertSession("child", updatedAt: 2, preview: "")
        try exec("UPDATE sessions SET parent_session_id='parent', parent_tool_use_id='toolu_1' WHERE id='child'")
        let full = try rows(SessionListQuery.sql(whereClause: "")) { text($0, SessionListQuery.Column.id) ?? "" }
        XCTAssertEqual(full, ["parent"])
        var stmt: OpaquePointer?
        defer { sqlite3_finalize(stmt) }
        XCTAssertEqual(sqlite3_prepare_v2(db, SessionListQuery.sql(whereClause: SessionListQuery.idFilter(count: 2)), -1, &stmt, nil), SQLITE_OK)
        for (i, id) in ["parent", "child"].enumerated() {
            sqlite3_bind_text(stmt, Int32(i + 1), (id as NSString).utf8String, -1, unsafeBitCast(-1, to: sqlite3_destructor_type.self))
        }
        var patched: [String] = []
        while sqlite3_step(stmt) == SQLITE_ROW { patched.append(text(stmt, SessionListQuery.Column.id) ?? "") }
        XCTAssertEqual(patched, ["parent"])
    }

    func testCandidateColumnsOnlyMaterialiseForUnbackfilledRows() throws {
        try insertSession("fresh", updatedAt: 2, preview: nil)
        try insertSession("done", updatedAt: 1, preview: "stored")
        for sid in ["fresh", "done"] {
            try insertMessage(sid, "a-\(sid)", role: "assistant", text: "answer", sortOrder: 1)
            try insertMessage(sid, "u-\(sid)", role: "user", text: "question", sortOrder: 0)
        }
        let out = try rows(SessionListQuery.sql(whereClause: "")) { stmt in
            (text(stmt, SessionListQuery.Column.id),
             sqlite3_column_type(stmt, SessionListQuery.Column.assistantParts) == SQLITE_NULL,
             sqlite3_column_type(stmt, SessionListQuery.Column.userSortOrder) == SQLITE_NULL,
             text(stmt, SessionListQuery.Column.previewText))
        }
        XCTAssertEqual(out.map(\.0), ["fresh", "done"])
        XCTAssertFalse(out[0].1, "NULL preview: candidate parts are read for the backfill")
        XCTAssertFalse(out[0].2)
        XCTAssertTrue(out[1].1, "stored preview: no parts_json read per refresh")
        XCTAssertTrue(out[1].2)
        XCTAssertEqual(out[1].3, "stored")
    }

    func testOriginDeviceNameJoinStillAtColumn16() throws {
        try insertSession("s", updatedAt: 1, preview: "")
        try exec("UPDATE sessions SET origin_device_id='dev1', last_writer_device_id='dev2' WHERE id='s'")
        try exec("INSERT INTO sync_devices VALUES ('dev1', 'Leo 的 iPhone')")
        let out = try rows(SessionListQuery.sql(whereClause: "")) { stmt in
            (text(stmt, SessionListQuery.Column.originDeviceId), text(stmt, SessionListQuery.Column.lastWriterDeviceId),
             text(stmt, SessionListQuery.Column.originDeviceName))
        }
        XCTAssertEqual(out.first?.0, "dev1")
        XCTAssertEqual(out.first?.1, "dev2")
        XCTAssertEqual(out.first?.2, "Leo 的 iPhone")
    }

    // MARK: - Persisted preview: fold == read-time rule

    func testWinnerRuleCases() {
        typealias P = SessionPreviewRule.Candidate
        XCTAssertEqual(SessionPreviewRule.winner(assistant: P(text: "a", sortOrder: 3), user: P(text: "u", sortOrder: 2))?.text, "a")
        XCTAssertEqual(SessionPreviewRule.winner(assistant: P(text: "a", sortOrder: 3), user: P(text: "u", sortOrder: 4))?.text, "u")
        XCTAssertEqual(SessionPreviewRule.winner(assistant: P(text: "a", sortOrder: 3), user: P(text: "u", sortOrder: 3))?.text, "a", "tie → assistant")
        XCTAssertEqual(SessionPreviewRule.winner(assistant: nil, user: P(text: "u", sortOrder: 1))?.text, "u")
        XCTAssertNil(SessionPreviewRule.winner(assistant: nil, user: nil))
        XCTAssertTrue(SessionPreviewRule.qualifies(isAssistant: true, partFlags: 2), "assistant tool_use qualifies")
        XCTAssertFalse(SessionPreviewRule.qualifies(isAssistant: false, partFlags: 0), "tool_result row never qualifies")
        XCTAssertFalse(SessionPreviewRule.qualifies(isAssistant: false, partFlags: 2))
        XCTAssertNil(SessionPreviewRule.display(""), "'' sentinel renders as no preview")
        XCTAssertEqual(SessionPreviewRule.display("x"), "x")
    }

    /// Randomised: folding each message through the production fold SQL
    /// leaves exactly what the read-time rule (recompute SQL + winner) derives
    /// over the whole history — including out-of-order sort_orders.
    func testFoldSQLMatchesReadTimeRuleOverRandomHistories() throws {
        var rng = SplitMix(seed: 0x5EED)
        for round in 0..<300 {
            let sid = "s\(round)"
            try insertSession(sid, updatedAt: 0, preview: "")
            try exec("UPDATE sessions SET preview_text = NULL WHERE id='\(sid)'")
            let count = Int(rng.next() % 10) + 1
            var orders = Array(0..<count)
            if round % 3 == 0 { orders.shuffle(using: &rng) }   // inbound merge arrival order
            for (i, order) in orders.enumerated() {
                let isAssistant = rng.next() % 2 == 0
                let kind = rng.next() % 4   // 0 text, 1 toolUse(assistant)/text, 2 tool_result-ish (flags 0), 3 text
                let flags = kind == 2 ? 0 : (kind == 1 && isAssistant ? 2 : 1)
                let text = "m\(round)-\(i)"
                try insertMessage(sid, "\(sid)-\(i)", role: isAssistant ? "assistant" : "user", text: text, sortOrder: order, flags: flags)
                if SessionPreviewRule.qualifies(isAssistant: isAssistant, partFlags: flags) {
                    try fold(sid, text: text, isAssistant: isAssistant, sortOrder: order)
                }
            }
            XCTAssertEqual(try storedPreview(sid), try recomputed(sid), "round \(round)")
        }
    }

    func testOutOfOrderOlderMessageDoesNotWin() throws {
        try insertSession("s", updatedAt: 0, preview: nil)
        try fold("s", text: "new answer", isAssistant: true, sortOrder: 10)
        try fold("s", text: "old answer", isAssistant: true, sortOrder: 4)
        try fold("s", text: "old question", isAssistant: false, sortOrder: 9)
        XCTAssertEqual(try storedPreview("s")?.text, "new answer")
        try fold("s", text: "same-order user", isAssistant: false, sortOrder: 10)
        XCTAssertEqual(try storedPreview("s")?.text, "new answer", "a user row must be strictly newer")
        try fold("s", text: "in-flight prompt", isAssistant: false, sortOrder: 11)
        XCTAssertEqual(try storedPreview("s")?.text, "in-flight prompt")
    }

    // MARK: - Incremental patch

    private struct Row: SessionListRow, Equatable {
        let id: String
        var updatedAt: Date
        var preview: String
    }

    func testPatchKeepsUntouchedRowsAndReSorts() {
        let cached = [Row(id: "c", updatedAt: Date(timeIntervalSince1970: 30), preview: "c"),
                      Row(id: "b", updatedAt: Date(timeIntervalSince1970: 20), preview: "b"),
                      Row(id: "a", updatedAt: Date(timeIntervalSince1970: 10), preview: "a")]
        let bumped = Row(id: "a", updatedAt: Date(timeIntervalSince1970: 40), preview: "a2")
        let out = SessionListPatch.apply(cached: cached, dirtyIds: ["a"], refreshed: ["a": bumped])
        XCTAssertEqual(out?.map(\.id), ["a", "c", "b"])
        XCTAssertEqual(out?[0].preview, "a2")
        XCTAssertEqual(out?[1], cached[0])
    }

    func testPatchDropsDeletedRowsAndRefusesUnknownRows() {
        let cached = [Row(id: "b", updatedAt: Date(timeIntervalSince1970: 20), preview: "b"),
                      Row(id: "a", updatedAt: Date(timeIntervalSince1970: 10), preview: "a")]
        XCTAssertEqual(SessionListPatch.apply(cached: cached, dirtyIds: ["a"], refreshed: [:])?.map(\.id), ["b"])
        let stranger = Row(id: "z", updatedAt: Date(timeIntervalSince1970: 50), preview: "z")
        XCTAssertNil(SessionListPatch.apply(cached: cached, dirtyIds: ["z"], refreshed: ["z": stranger]),
                     "a row the cache never had needs a full rebuild, not a guess")
    }

    func testPatchOrderMatchesSQLTieBreak() throws {
        try insertSession("s-a", updatedAt: 5, preview: "")
        try insertSession("s-b", updatedAt: 5, preview: "")
        try insertSession("s-c", updatedAt: 9, preview: "")
        let sqlOrder = try rows(SessionListQuery.sql(whereClause: "")) { text($0, 0) ?? "" }
        var swiftRows = [Row(id: "s-a", updatedAt: Date(timeIntervalSince1970: 5), preview: ""),
                         Row(id: "s-c", updatedAt: Date(timeIntervalSince1970: 9), preview: ""),
                         Row(id: "s-b", updatedAt: Date(timeIntervalSince1970: 5), preview: "")]
        SessionListPatch.sort(&swiftRows)
        XCTAssertEqual(swiftRows.map(\.id), sqlOrder)
    }

    // MARK: - Refresh cooldown (ported from upstream SessionRefreshCooldownTests)

    func testCooldownDecisions() {
        let t0 = Date(timeIntervalSince1970: 1_000_000)
        XCTAssertEqual(SessionRefreshScheduler.decide(now: t0, lastFinishedAt: nil), .runNow)
        XCTAssertEqual(SessionRefreshScheduler.decide(now: t0, lastFinishedAt: t0), .defer(3))
        XCTAssertEqual(SessionRefreshScheduler.decide(now: t0.addingTimeInterval(0.5), lastFinishedAt: t0), .defer(2.5))
        if case .defer(let d) = SessionRefreshScheduler.decide(now: t0.addingTimeInterval(2.999), lastFinishedAt: t0) {
            XCTAssertEqual(d, 0.001, accuracy: 0.01)
        } else { XCTFail("2.999 s must still defer") }
        XCTAssertEqual(SessionRefreshScheduler.decide(now: t0.addingTimeInterval(3), lastFinishedAt: t0), .runNow)
        XCTAssertEqual(SessionRefreshScheduler.decide(now: t0.addingTimeInterval(10), lastFinishedAt: t0), .runNow)
        XCTAssertEqual(SessionRefreshScheduler.decide(now: t0.addingTimeInterval(-60), lastFinishedAt: t0), .runNow,
                       "a clock jump backwards must not stall the list")
        XCTAssertEqual(SessionRefreshScheduler.cooldown, 3)
    }

    func testCooldownDeferralIsAlwaysPositiveAndBounded() {
        let t0 = Date(timeIntervalSince1970: 1_000_000)
        for ms in stride(from: -900, through: 2_999, by: 37) {
            guard case .defer(let delay) = SessionRefreshScheduler.decide(now: t0.addingTimeInterval(Double(ms) / 1000), lastFinishedAt: t0) else {
                return XCTFail("elapsed \(ms) ms should defer")
            }
            XCTAssertGreaterThan(delay, 0)
            XCTAssertLessThanOrEqual(delay, 3.9)
        }
    }

    /// 300 s agent task, 1 s notifications, 4.4 s refresh (upstream's trace):
    /// the completion-measured cooldown bounds the actor's duty cycle while
    /// the sidebar still refreshes regularly.
    func testCooldownBoundsDutyCycleOverLongAgentRun() {
        func simulate(cooldown: TimeInterval) -> (runs: Int, busy: Double) {
            var t = 0.0, lastFinished: Double? = nil, runs = 0, busy = 0.0
            while t < 300 {
                let next: Double
                if let last = lastFinished, t - last < cooldown { next = last + cooldown } else { next = t }
                runs += 1; busy += 4.4
                lastFinished = next + 4.4
                t = lastFinished! + (cooldown == 0 ? 0 : 0.001)
            }
            return (runs, busy / max(t, 300))
        }
        let legacy = simulate(cooldown: 0)
        let new = simulate(cooldown: SessionRefreshScheduler.cooldown)
        XCTAssertLessThan(new.runs, legacy.runs)
        XCTAssertGreaterThan(legacy.busy, 0.95)
        XCTAssertLessThan(new.busy, 0.65)
        XCTAssertGreaterThanOrEqual(new.runs, 35)
    }

    // MARK: - Helpers

    private func exec(_ sql: String) throws {
        var err: UnsafeMutablePointer<CChar>?
        guard sqlite3_exec(db, sql, nil, nil, &err) == SQLITE_OK else {
            let message = err.map { String(cString: $0) } ?? "?"
            sqlite3_free(err)
            throw NSError(domain: "sqlite", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
        }
    }

    private func rows<T>(_ sql: String, _ map: (OpaquePointer?) -> T) throws -> [T] {
        var stmt: OpaquePointer?
        defer { sqlite3_finalize(stmt) }
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else {
            throw NSError(domain: "sqlite", code: 2, userInfo: [NSLocalizedDescriptionKey: String(cString: sqlite3_errmsg(db))])
        }
        var out: [T] = []
        while sqlite3_step(stmt) == SQLITE_ROW { out.append(map(stmt)) }
        return out
    }

    private func text(_ stmt: OpaquePointer?, _ col: Int32) -> String? {
        sqlite3_column_text(stmt, col).map { String(cString: $0) }
    }

    private func insertSession(_ id: String, updatedAt: Double, preview: String?) throws {
        let p = preview.map { "'\($0)'" } ?? "NULL"
        try exec("INSERT INTO sessions (id, title, model_id, created_at, updated_at, preview_text) VALUES ('\(id)', NULL, 'm', 0, \(updatedAt), \(p))")
    }

    private func insertMessage(_ sid: String, _ id: String, role: String, text: String, sortOrder: Int, flags: Int = 1) throws {
        let parts = "[{\"type\":\"text\",\"value\":\"\(text)\"}]"
        try exec("INSERT INTO messages (id, session_id, role, parts_json, created_at, sort_order, part_flags) VALUES ('\(id)', '\(sid)', '\(role)', '\(parts)', 0, \(sortOrder), \(flags))")
    }

    private func fold(_ sid: String, text: String, isAssistant: Bool, sortOrder: Int) throws {
        var stmt: OpaquePointer?
        defer { sqlite3_finalize(stmt) }
        XCTAssertEqual(sqlite3_prepare_v2(db, SessionPreviewRule.foldSQL(isAssistant: isAssistant), -1, &stmt, nil), SQLITE_OK)
        sqlite3_bind_text(stmt, 1, text, -1, TRANSIENT)
        sqlite3_bind_int64(stmt, 2, Int64(sortOrder))
        sqlite3_bind_text(stmt, 3, sid, -1, TRANSIENT)
        sqlite3_bind_int64(stmt, 4, Int64(sortOrder))
        XCTAssertEqual(sqlite3_step(stmt), SQLITE_DONE)
    }

    private func storedPreview(_ sid: String) throws -> SessionPreviewRule.Candidate? {
        try rows("SELECT preview_text, preview_sort_order FROM sessions WHERE id='\(sid)'") { stmt in
            self.text(stmt, 0).map {
                SessionPreviewRule.Candidate(text: $0, sortOrder: sqlite3_column_type(stmt, 1) == SQLITE_NULL ? nil : Int(sqlite3_column_int64(stmt, 1)))
            }
        }.first ?? nil
    }

    /// Read-time rule over the whole history, via the production recompute SQL.
    /// The test text part is the preview itself (`value` of the one part).
    private func recomputed(_ sid: String) throws -> SessionPreviewRule.Candidate? {
        var stmt: OpaquePointer?
        defer { sqlite3_finalize(stmt) }
        XCTAssertEqual(sqlite3_prepare_v2(db, SessionPreviewRule.recomputeSQL, -1, &stmt, nil), SQLITE_OK)
        sqlite3_bind_text(stmt, 1, sid, -1, TRANSIENT)
        guard sqlite3_step(stmt) == SQLITE_ROW else { return nil }
        func value(_ col: Int32) -> String? {
            guard let raw = text(stmt, col), let data = raw.data(using: .utf8),
                  let parts = try? JSONSerialization.jsonObject(with: data) as? [[String: String]] else { return nil }
            return parts.first?["value"]
        }
        func order(_ col: Int32) -> Int? { sqlite3_column_type(stmt, col) == SQLITE_NULL ? nil : Int(sqlite3_column_int64(stmt, col)) }
        return SessionPreviewRule.winner(
            assistant: value(0).map { SessionPreviewRule.Candidate(text: $0, sortOrder: order(2)) },
            user: value(1).map { SessionPreviewRule.Candidate(text: $0, sortOrder: order(3)) })
    }
}

private struct SplitMix: RandomNumberGenerator {
    var state: UInt64
    init(seed: UInt64) { state = seed }
    mutating func next() -> UInt64 {
        state &+= 0x9E37_79B9_7F4A_7C15
        var z = state
        z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
        z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
        return z ^ (z >> 31)
    }
}
