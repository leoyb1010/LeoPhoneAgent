//
//  TreasuryItemEntity.swift
//  MinisApp
//
//  [C4] 藏宝阁条目实体:「搜索藏宝阁」返回它,「发送提示」可以接上它,
//  把条目作为 treasury_get 同款的不可信资料上下文交给 Agent。
//
//  只暴露系统界面可以说出口的元数据(安全标题、来源、类型);正文不进实体,
//  Siri 也就不会朗读正文。
//

import AppIntents
import Foundation

struct TreasuryItemEntity: AppEntity, Sendable {
    static let typeDisplayRepresentation = TypeDisplayRepresentation(name: "藏宝阁条目")
    static let defaultQuery = TreasuryItemQuery()

    let id: String
    let title: String
    let source: String
    let kind: String

    var displayRepresentation: DisplayRepresentation {
        source.isEmpty
            ? DisplayRepresentation(title: "\(title)")
            : DisplayRepresentation(title: "\(title)", subtitle: "\(source)")
    }

    init(id: String, title: String, source: String, kind: String) {
        self.id = id
        self.title = title.isEmpty ? "未命名收藏" : title
        self.source = source
        self.kind = kind
    }

    /// 搜索结果只用 safeTitle:title 可能回落到私密正文或带查询串的完整网址。
    init(_ result: TreasuryService.SearchResult) {
        self.init(id: result.id, title: result.safeTitle, source: result.source, kind: result.kind)
    }

    init(_ item: CollectedItem) {
        self.init(id: item.id, title: CollectionSearchIndex.spotlightTitle(for: item),
                  source: item.sourceLabel, kind: item.kind.rawValue)
    }
}

struct TreasuryItemQuery: EntityStringQuery {
    func entities(for identifiers: [String]) async throws -> [TreasuryItemEntity] {
        let wanted = Set(identifiers)
        return CollectionStore.load().filter { wanted.contains($0.id) }.map(TreasuryItemEntity.init)
    }

    func entities(matching string: String) async throws -> [TreasuryItemEntity] {
        let query = String(string.trimmingCharacters(in: .whitespacesAndNewlines).prefix(500))
        guard !query.isEmpty else { return try await suggestedEntities() }
        return await TreasuryService.search(.init(query: query, limit: 20)).items.map(TreasuryItemEntity.init)
    }

    func suggestedEntities() async throws -> [TreasuryItemEntity] {
        await TreasuryService.search(.init(query: "", limit: 20)).items.map(TreasuryItemEntity.init)
    }
}
