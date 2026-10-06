//
//  ProviderRowStamps.swift
//  MinisApp
//
//  provider 库整表重写(bulkReplace)时保留「没变的行」的 updated_at,以及只经过本机中继、
//  ProviderConfig 里根本没有的列(secret_*、extras_json)。
//
//  以前每次重写都把所有行盖成当前时间、把这些列清空:同步合并按 updated_at 做 LWW
//  (`localTs >= updatedAt` 就拒收),于是对端在那之前的改动全被拒,设备之间悄悄分叉;
//  extras_json 这个前向兼容信封也随之丢失。
//
//  纯 SQLite,不依赖 ProviderConfig 类型,逻辑测试可以直接对内存库跑。
//

import Foundation
import SQLite3

enum ProviderRowStamps {
    struct Table {
        let name: String
        /// 参与「内容是否变了」比较的列(不含 id、updated_at 与 passthrough 列)。
        let contentColumns: [String]
        /// 新行里为空时沿用旧行的列。
        let passthroughColumns: [String]
    }

    static let instances = Table(
        name: "provider_instances",
        contentColumns: ["label", "provider_type", "credential_type", "custom_base_url", "append_v1_suffix",
                         "image_endpoint_mode", "image_endpoint_resolved", "is_enabled", "sort_order",
                         "created_at", "custom_user_agent", "azure_mode"],
        passthroughColumns: ["secret_blob", "secret_kind", "secret_updated_at", "extras_json"])

    static let entries = Table(
        name: "provider_model_entries",
        contentColumns: ["provider_instance_id", "base_model_json", "overrides_json", "is_custom", "is_hidden",
                         "user_modified_at", "sort_order"],
        passthroughColumns: ["extras_json"])

    static let groups = Table(
        name: "provider_model_groups",
        contentColumns: ["name", "strategy", "fallback_strategy", "default_thinking_level", "context_limit_tokens",
                         "context_limit_remembered", "member_entry_ids_json", "sort_order",
                         "removed_members_json", "added_members_json"],
        passthroughColumns: ["extras_json"])

    static let all = [instances, entries, groups]

    private static func snapshotName(_ table: Table) -> String { "temp.leo_prior_\(table.name)" }

    private static func signature(_ table: Table, alias: String? = nil) -> String {
        let prefix = alias.map { "\($0)." } ?? ""
        return table.contentColumns.map { "quote(\(prefix)\($0))" }.joined(separator: " || char(31) || ")
    }

    /// 删表重写之前调用(同一事务里)。
    static func snapshot(_ db: OpaquePointer, _ table: Table) -> Bool {
        let columns = (["id", "updated_at"] + table.passthroughColumns).joined(separator: ", ")
        return exec(db, "DROP TABLE IF EXISTS \(snapshotName(table))")
            && exec(db, "CREATE TEMP TABLE \(snapshotName(table).dropFirst(5)) AS SELECT \(columns), \(signature(table)) AS sig FROM \(table.name)")
    }

    /// 重写完成之后调用:内容没变的行恢复旧 updated_at;passthrough 列为空时沿用旧值。
    static func restore(_ db: OpaquePointer, _ table: Table) -> Bool {
        let prior = snapshotName(table)
        let match = "p.id = \(table.name).id"
        var ok = true
        if !table.passthroughColumns.isEmpty {
            let sets = table.passthroughColumns
                .map { "\($0) = COALESCE(\($0), (SELECT p.\($0) FROM \(prior) p WHERE \(match)))" }
                .joined(separator: ", ")
            ok = ok && exec(db, "UPDATE \(table.name) SET \(sets) WHERE id IN (SELECT id FROM \(prior))")
        }
        ok = ok && exec(db, """
            UPDATE \(table.name) SET updated_at = (SELECT p.updated_at FROM \(prior) p WHERE \(match))
            WHERE EXISTS (SELECT 1 FROM \(prior) p WHERE \(match) AND p.sig = \(signature(table, alias: table.name)))
            """)
        return exec(db, "DROP TABLE IF EXISTS \(prior)") && ok
    }

    private static func exec(_ db: OpaquePointer, _ sql: String) -> Bool {
        sqlite3_exec(db, sql, nil, nil, nil) == SQLITE_OK
    }
}
