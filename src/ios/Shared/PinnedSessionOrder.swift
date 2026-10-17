//
//  PinnedSessionOrder.swift
//  MinisApp
//
//  [WP-42] 置顶会话的手动顺序。存在 `sessions.pin_order`(文本 "rank|editedAtMs"),随会话
//  元数据一起同步(v1 Session 记录与 v2 SessionV2 的 `pinOrder` 字段)。
//
//  - 没有这个字段(旧设备、从没拖过)时按原来的顺序:最近活动在前，置顶时间作平局。
//  - 有字段的按 rank 升序排在后面;还没排过的(新置顶的)排在最前。
//  - 合并按 editedAtMs:新的赢;远端没带字段就保留本地。不能用 pinnedAt 来编码顺序 ——
//    两边都置顶时 pinnedAt 取较大值，拖好的顺序会被同步改回去。
//

import Foundation

struct PinRank: Equatable, Sendable {
    var rank: Int
    var editedAtMs: Int64

    var encoded: String { "\(rank)|\(editedAtMs)" }

    init(rank: Int, editedAtMs: Int64) {
        self.rank = rank
        self.editedAtMs = editedAtMs
    }

    init?(encoded: String?) {
        guard let parts = encoded?.split(separator: "|"), parts.count == 2,
              let rank = Int(parts[0]), let ms = Int64(parts[1]), rank >= 0, ms > 0 else { return nil }
        self.rank = rank
        self.editedAtMs = ms
    }
}

enum PinnedSessionOrder {
    struct Entry: Equatable {
        var id: String
        var updatedAt: Date
        var pinnedAt: Date?
    }

    /// 置顶区的显示顺序(id)。
    static func sort(_ pinned: [Entry], ranks: [String: PinRank]) -> [String] {
        func original(_ a: Entry, _ b: Entry) -> Bool {
            if a.updatedAt != b.updatedAt { return a.updatedAt > b.updatedAt }
            return (a.pinnedAt ?? .distantPast) > (b.pinnedAt ?? .distantPast)
        }
        let unranked = pinned.filter { ranks[$0.id] == nil }.sorted(by: original)
        let ranked = pinned.filter { ranks[$0.id] != nil }.sorted { a, b in
            let ra = ranks[a.id]!.rank, rb = ranks[b.id]!.rank
            return ra != rb ? ra < rb : original(a, b)
        }
        return (unranked + ranked).map(\.id)
    }

    /// List 的 onMove 语义(和 SwiftUI `move(fromOffsets:toOffset:)` 一致)。
    static func move(_ ids: [String], from source: IndexSet, to destination: Int) -> [String] {
        let moving = source.filter { $0 < ids.count }.map { ids[$0] }
        var rest: [String] = []
        var insertAt = destination
        for (i, id) in ids.enumerated() {
            if source.contains(i) {
                if i < destination { insertAt -= 1 }
            } else {
                rest.append(id)
            }
        }
        insertAt = min(max(insertAt, 0), rest.count)
        rest.insert(contentsOf: moving, at: insertAt)
        return rest
    }

    /// 拖完之后要写的 rank:整个置顶区按新顺序编号，只返回变了的(省同步流量)。
    static func assignments(order: [String], current: [String: PinRank], now: Date) -> [String: PinRank] {
        let ms = Int64((now.timeIntervalSince1970 * 1000).rounded())
        var out: [String: PinRank] = [:]
        for (index, id) in order.enumerated() where current[id]?.rank != index {
            out[id] = PinRank(rank: index, editedAtMs: ms)
        }
        return out
    }

    /// 同步合并:新的赢;远端没带(旧设备 / 没排过)保留本地。
    static func merge(local: PinRank?, remote: PinRank?) -> PinRank? {
        guard let remote else { return local }
        guard let local else { return remote }
        return remote.editedAtMs > local.editedAtMs ? remote : local
    }
}
