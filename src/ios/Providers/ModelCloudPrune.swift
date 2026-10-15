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

    // MARK: - 拒收云端旧副本

    /// 某个服务商最近一次从它自己的 /models 拿到的完整列表。
    struct ServerList: Codable, Equatable {
        var at: Date
        var modelIds: [String]
    }

    static let serverListsKey = "leo.models.serverLists.v1"

    /// 1.73 实测:只删本机手上有的条目不够——云端还压着 400 多份旧记录,本机列表刚刷成 64,
    /// 紧接着的 iCloud 拉取就把 95 个 cursor/ 模型又插回来。拉下来的记录如果:不是自定义模型、
    /// 不在这个服务商最近一次的服务器列表里、并且比那份列表还旧——就是旧副本,拒收并删掉云端。
    /// 比列表新的放行:别的设备刚刷到、本机还没刷到的新模型不会被误删。
    static func rejectsInbound(modelId: String, isCustom: Bool, updatedAt: Date, serverList: ServerList?) -> Bool {
        guard !isCustom, let list = serverList, !list.modelIds.isEmpty else { return false }
        return updatedAt < list.at && !list.modelIds.contains(modelId)
    }

    static func serverList(for instanceId: String, defaults: UserDefaults = .standard) -> ServerList? {
        loadServerLists(defaults)[instanceId]
    }

    static func recordServerList(_ list: ServerList, for instanceId: String, defaults: UserDefaults = .standard) {
        var all = loadServerLists(defaults)
        all[instanceId] = list
        if let data = try? JSONEncoder().encode(all) { defaults.set(data, forKey: serverListsKey) }
    }

    private static func loadServerLists(_ defaults: UserDefaults) -> [String: ServerList] {
        guard let data = defaults.data(forKey: serverListsKey) else { return [:] }
        return (try? JSONDecoder().decode([String: ServerList].self, from: data)) ?? [:]
    }
}
