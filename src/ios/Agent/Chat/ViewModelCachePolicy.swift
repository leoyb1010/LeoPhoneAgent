//
//  ViewModelCachePolicy.swift
//  MinisApp
//
//  [T-vmcache-pools] / [B24] The eviction rule of ViewModelCache, pure so the
//  logic tests can pin it: the conversations the user opens (`.normal`) and
//  headless runs such as sub-agent children (`.background`) are separate LRU
//  pools, each swept against its own cap, so a burst of background sessions can
//  never push the user's own chats out.
//

import Foundation

enum ViewModelCachePool: String {
    /// A conversation the user opens directly (default for every caller).
    case normal
    /// A headless run created off-screen; separate, larger cap.
    case background
}

enum ViewModelCachePolicy {
    static let normalCap = 6
    static let backgroundCap = 10

    static func cap(for pool: ViewModelCachePool) -> Int {
        pool == .normal ? normalCap : backgroundCap
    }

    /// Session ids to evict, in eviction order. `lruOrder` lists the resident
    /// sessions least- to most-recently used. Within each pool the oldest
    /// evictable entries go first until the pool is back at its cap; entries
    /// that are not evictable (running, on screen, pinned) are skipped, so a
    /// pool may stay over its cap. A pool never evicts another pool's entry.
    static func victims(lruOrder: [String],
                        pool: (String) -> ViewModelCachePool,
                        isEvictable: (String) -> Bool) -> [String] {
        var out: [String] = []
        for kind in [ViewModelCachePool.normal, .background] {
            let members = lruOrder.filter { pool($0) == kind }
            var overflow = members.count - cap(for: kind)
            for sessionId in members where overflow > 0 && isEvictable(sessionId) {
                out.append(sessionId)
                overflow -= 1
            }
        }
        return out
    }
}
