//
//  CollectionSearchIndex.swift
//  MinisApp
//
//  [T-collections-fulltext] 收藏全文检索(SQLite FTS5)+ 系统搜索索引。
//
//  为什么要单开一个库:items.json 存的是条目元数据(几 KB),而全文
//  一篇文章就几万字——塞进同一个 JSON 会让每次读写都拖着几 MB 走。
//  正文单独进 SQLite,用 FTS5 做匹配;条目本体仍在 JSON 里,两边用
//  id 关联。
//
//  中文分词:FTS5 默认的 unicode61 分词器不切中文词,整段中文会被当成
//  一个 token。用 trigram 分词器(SQLite 3.34+,iOS 15+ 自带)——它按
//  三字滑窗切分,对中文全文检索足够好,且不需要外挂词典。
//
//  Spotlight:只索引标题、来源、摘要这些"给人看的"字段,不把正文塞进
//  系统索引——正文可能包含私密内容,而 Spotlight 的数据出了 app 沙盒。
//

import CoreSpotlight
import Foundation
import SQLite3

// SQLite 的 SQLITE_TRANSIENT 宏在 Swift 里没有对应符号,按 C 语义手写:
// -1 转成析构函数指针 = "这份数据是临时的,SQLite 请自己拷贝"。
private let SQLITE_TRANSIENT = unsafeBitCast(-1, to: (@convention(c) (UnsafeMutableRawPointer?) -> Void).self)

@MainActor
final class CollectionSearchIndex {
    static let shared = CollectionSearchIndex()

    private var db: OpaquePointer?
    private var ready = false

    private init() { open() }

    private var dbPath: String? {
        CollectionStore.directory?.appendingPathComponent("fulltext.sqlite").path
    }

    private func open() {
        guard let dbPath else { return }
        guard sqlite3_open(dbPath, &db) == SQLITE_OK else {
            db = nil
            return
        }
        // trigram 需要 SQLite 3.34+;失败就退回 unicode61(英文仍可用,
        // 中文退化为整段匹配)——宁可弱一点,不要整个功能没有。
        let createTrigram = """
        CREATE VIRTUAL TABLE IF NOT EXISTS docs USING fts5(
            item_id UNINDEXED, title, body, tokenize='trigram'
        );
        """
        if sqlite3_exec(db, createTrigram, nil, nil, nil) != SQLITE_OK {
            let fallback = """
            CREATE VIRTUAL TABLE IF NOT EXISTS docs USING fts5(
                item_id UNINDEXED, title, body
            );
            """
            guard sqlite3_exec(db, fallback, nil, nil, nil) == SQLITE_OK else { return }
        }
        ready = true
    }

    // MARK: - 写入

    /// 存一条收藏的正文。同 id 覆盖(先删后插,FTS5 没有 upsert)。
    func index(itemId: String, title: String, body: String) {
        guard ready, let db else { return }
        remove(itemId: itemId)
        var stmt: OpaquePointer?
        let sql = "INSERT INTO docs(item_id, title, body) VALUES (?, ?, ?);"
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return }
        defer { sqlite3_finalize(stmt) }
        sqlite3_bind_text(stmt, 1, itemId, -1, SQLITE_TRANSIENT)
        sqlite3_bind_text(stmt, 2, title, -1, SQLITE_TRANSIENT)
        sqlite3_bind_text(stmt, 3, body, -1, SQLITE_TRANSIENT)
        sqlite3_step(stmt)
    }

    func remove(itemId: String) {
        guard ready, let db else { return }
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, "DELETE FROM docs WHERE item_id = ?;", -1, &stmt, nil) == SQLITE_OK else { return }
        defer { sqlite3_finalize(stmt) }
        sqlite3_bind_text(stmt, 1, itemId, -1, SQLITE_TRANSIENT)
        sqlite3_step(stmt)
    }

    // MARK: - 查询

    struct Hit {
        let itemId: String
        /// 命中位置前后的一小段原文,让人知道为什么命中。
        let snippet: String
    }

    /// 全文搜索。返回命中的条目 id 与片段。
    func search(_ query: String, limit: Int = 50) -> [Hit] {
        guard ready, let db else { return [] }
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !q.isEmpty else { return [] }
        // FTS5 的 MATCH 语法对引号、星号敏感;整体当短语查,避免用户
        // 输入里的符号变成语法错误让搜索直接失败。
        let phrase = "\"" + q.replacingOccurrences(of: "\"", with: "") + "\""
        var stmt: OpaquePointer?
        let sql = """
        SELECT item_id, snippet(docs, 2, '', '', '…', 12)
        FROM docs WHERE docs MATCH ? ORDER BY rank LIMIT ?;
        """
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return [] }
        defer { sqlite3_finalize(stmt) }
        sqlite3_bind_text(stmt, 1, phrase, -1, SQLITE_TRANSIENT)
        sqlite3_bind_int(stmt, 2, Int32(limit))

        var hits: [Hit] = []
        while sqlite3_step(stmt) == SQLITE_ROW {
            guard let idC = sqlite3_column_text(stmt, 0) else { continue }
            let id = String(cString: idC)
            let snippet = sqlite3_column_text(stmt, 1).map { String(cString: $0) } ?? ""
            hits.append(Hit(itemId: id, snippet: snippet))
        }
        return hits
    }

    /// 已经存了正文的条目 id 集合(用于判断哪些还需要抓)。
    func indexedIds() -> Set<String> {
        guard ready, let db else { return [] }
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, "SELECT item_id FROM docs;", -1, &stmt, nil) == SQLITE_OK else { return [] }
        defer { sqlite3_finalize(stmt) }
        var out = Set<String>()
        while sqlite3_step(stmt) == SQLITE_ROW {
            if let c = sqlite3_column_text(stmt, 0) { out.insert(String(cString: c)) }
        }
        return out
    }

    // MARK: - Spotlight

    /// 把收藏交给系统搜索。只放给人看的字段,正文不出沙盒。
    func publishToSpotlight(_ items: [CollectedItem]) {
        let attributes = items.map { item -> CSSearchableItem in
            let attrs = CSSearchableItemAttributeSet(contentType: .content)
            attrs.title = item.title ?? item.value
            attrs.contentDescription = [item.summary, item.sourceLabel]
                .compactMap { $0 }.joined(separator: " · ")
            attrs.keywords = item.tags + [item.sourceLabel, "收藏"]
            attrs.contentCreationDate = item.createdAt
            return CSSearchableItem(uniqueIdentifier: "collection:\(item.id)",
                                    domainIdentifier: "com.leoyuan.leophoneagent.collections",
                                    attributeSet: attrs)
        }
        guard !attributes.isEmpty else { return }
        CSSearchableIndex.default().indexSearchableItems(attributes)
    }

    func unpublishFromSpotlight(ids: Set<String>) {
        guard !ids.isEmpty else { return }
        CSSearchableIndex.default().deleteSearchableItems(
            withIdentifiers: ids.map { "collection:\($0)" })
    }
}
