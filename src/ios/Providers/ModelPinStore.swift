//
//  ModelPinStore.swift
//  MinisApp
//
//  [T-model-pin] 钉选状态的可观察包装。
//
//  为什么要这一层:钉选存在 App Group 的 UserDefaults 里,SwiftUI 看不见
//  它的变化。上一版靠 @State 计数器 + .id() 强制重建整个 List —— 图标
//  是更新了,代价是滚到第 20 行点一下就跳回顶部。去掉 .id() 之后跳顶
//  没了,但 ForEach 的行身份没变、依赖也没变,SwiftUI 干脆不重绘那一行:
//  点了 ☆ 存储已经改了,图标却是原样,看起来就是"点了没反应"。
//
//  正确做法是把这份状态变成真正的依赖源:@Published 一变,读它的视图
//  自然重绘,不必也不该去动列表身份。
//

import Foundation
import SwiftUI

@MainActor
final class ModelPinStore: ObservableObject {
    static let shared = ModelPinStore()

    /// 钉选 key(有序)。视图读这个,而不是直接读 ModelSwitcher.pinnedKeys。
    @Published private(set) var keys: [String]

    private init() {
        keys = ModelSwitcher.pinnedKeys
    }

    func isPinned(_ key: String) -> Bool { keys.contains(key) }

    /// 返回 false 表示已达上限、没钉上,调用方要如实提示。
    @discardableResult
    func toggle(_ key: String) -> Bool {
        let ok = ModelSwitcher.togglePin(key)
        keys = ModelSwitcher.pinnedKeys
        return ok
    }

    func move(visibleKeys: [String], from source: IndexSet, to destination: Int) {
        ModelSwitcher.movePinned(visibleKeys: visibleKeys, from: source, to: destination)
        keys = ModelSwitcher.pinnedKeys
    }

    /// 当前可用的钉选条目(停用供应商下的会被跳过,但不从存储里摘)。
    func entries(store: ProviderConfigStore) -> [ModelEntry] {
        let enabled = Set(store.instances.filter(\.isEnabled).map(\.id))
        return keys.compactMap { key in
            guard let entry = store.entry(for: key), !entry.isHidden,
                  enabled.contains(entry.providerInstanceId) else { return nil }
            return entry
        }
    }
}
