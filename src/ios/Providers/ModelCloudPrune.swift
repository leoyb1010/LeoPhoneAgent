//
//  ModelCloudPrune.swift
//  MinisApp
//
//  [T-model-cloud-prune] 刷新模型列表时,服务器上已经没有的模型在 iCloud 里要删哪些记录。
//  纯字符串逻辑,编进 App 和逻辑测试两个 target(ProviderConfigStore 只在 App 里)。
//

import Foundation

enum ModelCloudPrune {
    /// 一个条目在云端可能用过的名字。
    struct EntryNames: Equatable {
        var id: String              // 规范 id(本机 DB 主键)
        var uuid: String
        var legacyColonKey: String  // "实例:模型" 旧格式
    }

    /// 被服务器列表拿掉的条目,在云端可能存在的全部记录名:规范 id、uuid、旧的冒号组合键,
    /// 以及迁移前那批随机 UUID 记录名(legacyAliases 里指向它的别名)。
    /// 仍在保留列表里的名字一律不删;删一个云端不存在的记录名是无害的。
    static func recordIds(existing: [EntryNames], kept: [EntryNames], legacyAliases: [String: String]) -> [String] {
        let keptIds = Set(kept.flatMap { [$0.id, $0.uuid] })
        let omitted = existing.filter { !keptIds.contains($0.id) && !keptIds.contains($0.uuid) }
        guard !omitted.isEmpty else { return [] }
        let omittedIds = Set(omitted.map(\.id))
        var names = Set<String>()
        for entry in omitted {
            names.insert(entry.id)
            names.insert(entry.uuid)
            if !entry.legacyColonKey.isEmpty { names.insert(entry.legacyColonKey) }
        }
        for (alias, canonical) in legacyAliases where omittedIds.contains(canonical) { names.insert(alias) }
        return names.subtracting(keptIds).sorted()
    }
}
