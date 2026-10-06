import XCTest
import SQLite3

/// 1.57 之后的非 UI 核心审计修复(同步安全、数据落盘、权限边界)的回归测试。
final class CoreAuditFixTests: XCTestCase {

    // MARK: provider 库整表重写

    private func exec(_ db: OpaquePointer, _ sql: String) {
        XCTAssertEqual(sqlite3_exec(db, sql, nil, nil, nil), SQLITE_OK, String(cString: sqlite3_errmsg(db)))
    }

    private func double(_ db: OpaquePointer, _ sql: String) -> Double? {
        var stmt: OpaquePointer?
        defer { sqlite3_finalize(stmt) }
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK, sqlite3_step(stmt) == SQLITE_ROW,
              sqlite3_column_type(stmt, 0) != SQLITE_NULL else { return nil }
        return sqlite3_column_double(stmt, 0)
    }

    private func text(_ db: OpaquePointer, _ sql: String) -> String? {
        var stmt: OpaquePointer?
        defer { sqlite3_finalize(stmt) }
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK, sqlite3_step(stmt) == SQLITE_ROW,
              let c = sqlite3_column_text(stmt, 0) else { return nil }
        return String(cString: c)
    }

    /// 重写后:内容没变的行保留原 updated_at(对端更早的改动才合得进来);改了的行才是新时间;
    /// secret_* / extras_json 这类 ProviderConfig 里没有的列不被清空。
    func testBulkRewriteKeepsTimestampsOfUnchangedRowsAndPassthroughColumns() throws {
        var handle: OpaquePointer?
        XCTAssertEqual(sqlite3_open(":memory:", &handle), SQLITE_OK)
        let db = try XCTUnwrap(handle)
        defer { sqlite3_close(db) }
        exec(db, """
            CREATE TABLE provider_model_groups (id TEXT PRIMARY KEY, name TEXT, strategy TEXT, fallback_strategy TEXT,
              default_thinking_level TEXT, context_limit_tokens INTEGER, context_limit_remembered INTEGER,
              member_entry_ids_json TEXT, sort_order INTEGER, updated_at REAL, extras_json TEXT,
              removed_members_json TEXT, added_members_json TEXT);
            INSERT INTO provider_model_groups VALUES ('same','A','fallback','always',NULL,NULL,NULL,'[]',0,100,'{"future":1}','{}','{}');
            INSERT INTO provider_model_groups VALUES ('edited','B','fallback','always',NULL,NULL,NULL,'[]',1,100,NULL,'{}','{}');
            BEGIN IMMEDIATE;
            """)
        let table = ProviderRowStamps.groups
        XCTAssertTrue(ProviderRowStamps.snapshot(db, table))
        exec(db, """
            DELETE FROM provider_model_groups;
            INSERT INTO provider_model_groups VALUES ('same','A','fallback','always',NULL,NULL,NULL,'[]',0,999,NULL,'{}','{}');
            INSERT INTO provider_model_groups VALUES ('edited','B2','fallback','always',NULL,NULL,NULL,'[]',1,999,NULL,'{}','{}');
            INSERT INTO provider_model_groups VALUES ('new','C','fallback','always',NULL,NULL,NULL,'[]',2,999,NULL,'{}','{}');
            """)
        XCTAssertTrue(ProviderRowStamps.restore(db, table))
        exec(db, "COMMIT")
        XCTAssertEqual(double(db, "SELECT updated_at FROM provider_model_groups WHERE id='same'"), 100, "没变的行保留原时间")
        XCTAssertEqual(double(db, "SELECT updated_at FROM provider_model_groups WHERE id='edited'"), 999, "改了的行用新时间")
        XCTAssertEqual(double(db, "SELECT updated_at FROM provider_model_groups WHERE id='new'"), 999)
        XCTAssertEqual(text(db, "SELECT extras_json FROM provider_model_groups WHERE id='same'"), #"{"future":1}"#,
                       "前向兼容信封不被清空")
        XCTAssertNil(text(db, "SELECT name FROM sqlite_temp_master WHERE name LIKE 'leo_prior_%'"), "临时快照已清理")
    }

    // MARK: iCloud 保存冲突

    /// 后写者胜,与合并器同一规则:服务器更新才接受服务器;同时或本地更新都重发本地。
    func testSyncConflictIsLastWriterWins() {
        let t = Date(timeIntervalSince1970: 1_000)
        XCTAssertEqual(SyncConflictPolicy.resolve(localUpdatedAt: t, serverUpdatedAt: t.addingTimeInterval(1)), .acceptServer)
        XCTAssertEqual(SyncConflictPolicy.resolve(localUpdatedAt: t.addingTimeInterval(1), serverUpdatedAt: t), .resendLocal)
        XCTAssertEqual(SyncConflictPolicy.resolve(localUpdatedAt: t, serverUpdatedAt: t), .resendLocal)
    }

    // MARK: 收藏 SQLite 不可用时的暂存

    func testTreasuryPendingOpsRecordsAddsEditsAndDeletes() {
        let kept = CollectedItem(kind: .text, value: "旧条目", sourceLabel: "t")
        var edited = CollectedItem(kind: .text, value: "要改的", sourceLabel: "t")
        let removed = CollectedItem(kind: .text, value: "要删的", sourceLabel: "t")
        let base = [kept, edited, removed]
        var ops = TreasuryPendingOps()
        let added = CollectedItem(kind: .text, value: "SQLite 挂掉时新收的", sourceLabel: "share")
        var after = base
        after.insert(added, at: 0)
        ops.record(before: base, after: after)
        var view = ops.overlay(on: base)
        edited.pinned = true
        var next = view
        next[next.firstIndex { $0.id == edited.id }!] = edited
        next.removeAll { $0.id == removed.id }
        ops.record(before: view, after: next)
        view = ops.overlay(on: base)
        XCTAssertEqual(Set(ops.upserts.map(\.id)), [added.id, edited.id])
        XCTAssertEqual(ops.deletedIDs, [removed.id])
        XCTAssertTrue(view.contains(added))
        XCTAssertTrue(view.contains(edited))
        XCTAssertFalse(view.contains { $0.id == removed.id })
        XCTAssertTrue(view.contains(kept))
    }

    /// 暂存的写入在 SQLite 恢复后并回库:新增进库、改动覆盖、删除变墓碑。
    func testTreasuryPendingOpsApplyToSQLite() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("pending-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = try TreasurySQLiteStore(directory: directory)
        var existing = CollectedItem(kind: .text, value: "库里已有", sourceLabel: "t")
        let doomed = CollectedItem(kind: .text, value: "待删除", sourceLabel: "t")
        try store.add([existing, doomed])
        existing.annotation = "离线时加的批注"
        let fresh = CollectedItem(kind: .text, value: "离线时新收的", sourceLabel: "share")
        try store.applyPending(TreasuryPendingOps(upserts: [existing, fresh], deletedIDs: [doomed.id]))
        let items = try store.load()
        XCTAssertEqual(items.first { $0.id == existing.id }?.annotation, "离线时加的批注")
        XCTAssertTrue(items.contains { $0.id == fresh.id })
        XCTAssertFalse(items.contains { $0.id == doomed.id })
    }

    // MARK: Cookie 备份

    /// 站点还在、少了几个 cookie = 站点自己删的(登出),不恢复;整站消失 = ITP 清理,照旧恢复。
    func testCookieBackupRespectsSiteDeletionButNotWholeSiteWipe() {
        let previous: [String: Set<String>] = [
            "x.com": ["x.com|/|auth_token", "x.com|/|lang"],
            "google.com": [".google.com|/|SID", ".google.com|/|NID"],
        ]
        let current: [String: Set<String>] = ["x.com": ["x.com|/|lang"]]
        XCTAssertEqual(CookieDeletionPolicy.deliberatelyRemovedKeys(previous: previous, current: current),
                       ["x.com|/|auth_token"])
    }

    // MARK: Anthropic 每请求设置

    /// 设置按请求登记:重试再次经过改写仍拿得到;两个请求互不串;标记从请求体里去掉。
    func testAnthropicRequestSettingsArePerRequestAndSurviveRetry() throws {
        var first = AnthropicRequestSettings()
        first.thinkingDisabled = true
        var second = AnthropicRequestSettings()
        second.thinkingEffort = "high"
        let a = AnthropicRequestSettingsRegistry.register(first)
        let b = AnthropicRequestSettingsRegistry.register(second)
        defer { AnthropicRequestSettingsRegistry.release(a); AnthropicRequestSettingsRegistry.release(b) }
        let body = try JSONSerialization.data(withJSONObject: ["model": "claude", "stop_sequences": [a]])
        for _ in 0..<2 {   // 第一次尝试 + 网络重试
            let (settings, rewritten) = try XCTUnwrap(AnthropicRequestSettingsRegistry.extract(fromBody: body))
            XCTAssertTrue(settings.thinkingDisabled)
            XCTAssertNil(settings.thinkingEffort, "不会拿到另一个请求的设置")
            let json = try XCTUnwrap(JSONSerialization.jsonObject(with: rewritten) as? [String: Any])
            XCTAssertNil(json["stop_sequences"], "标记不发给服务器")
        }
        let mixed = try JSONSerialization.data(withJSONObject: ["stop_sequences": ["END", b]])
        let (settings, rewritten) = try XCTUnwrap(AnthropicRequestSettingsRegistry.extract(fromBody: mixed))
        XCTAssertEqual(settings.thinkingEffort, "high")
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: rewritten) as? [String: Any])
        XCTAssertEqual(json["stop_sequences"] as? [String], ["END"], "调用方自己的停止序列保留")
        XCTAssertNil(AnthropicRequestSettingsRegistry.extract(fromBody: try JSONSerialization.data(withJSONObject: ["model": "x"])))
    }

    // MARK: Paperclip Spotlight

    /// 已完成 / 已取消的工单不进系统搜索;关单、切公司会改变签名,从而触发整体重建。
    func testPaperclipSpotlightIndexesOpenIssuesOnly() throws {
        func issue(_ id: String, _ status: String, company: String = "c") throws -> PaperclipIssue {
            try JSONDecoder().decode(PaperclipIssue.self, from: Data(
                #"{"id":"\#(id)","companyId":"\#(company)","title":"T","status":"\#(status)","priority":"medium"}"#.utf8))
        }
        let issues = [try issue("a", "todo"), try issue("b", "done"), try issue("c", "cancelled"), try issue("d", "in_review")]
        XCTAssertEqual(PaperclipSpotlightIndexer.indexable(issues).map(\.id), ["a", "d"])
        XCTAssertNotEqual(PaperclipSpotlightIndexer.signature([try issue("a", "todo")]),
                          PaperclipSpotlightIndexer.signature([try issue("a", "done")]))
        XCTAssertNotEqual(PaperclipSpotlightIndexer.signature([try issue("a", "todo")]),
                          PaperclipSpotlightIndexer.signature([try issue("a", "todo", company: "other")]))
    }

    // MARK: 系统 TTS

    func testSystemSynthesisTimeoutScalesAndIsCapped() {
        XCTAssertEqual(SystemSpeechPolicy.synthesisTimeout(characters: 0), 15)
        XCTAssertEqual(SystemSpeechPolicy.synthesisTimeout(characters: 100), 45)
        XCTAssertEqual(SystemSpeechPolicy.synthesisTimeout(characters: 100_000), 180)
    }

    // MARK: 朗读音频拼接

    /// MP3(默认格式)按字节首尾相接,不改头、不砍 44 字节;只有真的 WAV 才合并 PCM。
    func testTTSConcatTreatsOnlyRealWAVAsWAV() {
        let mp3a = Data([0x49, 0x44, 0x33, 0x04] + Array(repeating: 0xAA, count: 60))
        let mp3b = Data([0xFF, 0xFB] + Array(repeating: 0xBB, count: 60))
        XCTAssertFalse(TTSAudioData.isWAV(mp3a))
        XCTAssertEqual(TTSAudioData.concat([mp3a, mp3b]), mp3a + mp3b)
        func wav(_ pcm: [UInt8]) -> Data {
            var d = Data("RIFF".utf8); d += withUnsafeBytes(of: UInt32(36 + pcm.count).littleEndian) { Data($0) }
            d += Data("WAVEfmt ".utf8); d += withUnsafeBytes(of: UInt32(16).littleEndian) { Data($0) }
            d += Data([1, 0, 1, 0]); d += withUnsafeBytes(of: UInt32(8000).littleEndian) { Data($0) }
            d += withUnsafeBytes(of: UInt32(16000).littleEndian) { Data($0) }; d += Data([2, 0, 16, 0])
            d += Data("data".utf8); d += withUnsafeBytes(of: UInt32(pcm.count).littleEndian) { Data($0) }
            return d + Data(pcm)
        }
        let joined = TTSAudioData.concat([wav([1, 2, 3, 4]), wav([5, 6])])
        XCTAssertTrue(TTSAudioData.isWAV(joined))
        XCTAssertEqual(joined.count, 44 + 6)
        XCTAssertEqual(Array(joined.suffix(6)), [1, 2, 3, 4, 5, 6])
        XCTAssertEqual(TTSAudioData.duration(wav(Array(repeating: 0, count: 16000))), 1, accuracy: 0.001)
    }
}
