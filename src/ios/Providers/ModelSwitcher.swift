//
//  ModelSwitcher.swift
//  MinisApp
//
//  [T-model-quickswitch] 换模型的唯一提交口 + 最近使用记忆。
//
//  以前换模型只有一条路:导航栏模型按钮 → 大号 picker → 逐层展开供应商
//  → 找到那个模型。日常真实需求 90% 是"换回刚才那个",却要走全程。
//
//  这里把提交逻辑从 SessionModelPicker 抽出来共享,给三个入口用:
//  ① 输入条上的模型胶囊(最近 3 个直接点)
//  ② /model kimi 斜杠命令
//  ③ 长按发送键"用 X 发送"(临时一次)
//  最近使用写 App Group,快捷任务/Widget 之后也能读。
//

import Foundation

@MainActor
enum ModelSwitcher {
    private static let recentsKey = "leo.model.recents.v1"
    private static let maxRecents = 8
    private static let pinnedKey = "leo.model.pinned.v1"
    /// 钉选上限。超过这个数,长按胶囊弹出的菜单就不再是"一眼扫完"了,
    /// 而那正是这条路径存在的全部理由。
    static let maxPinned = 6

    // MARK: - 常用(钉选)
    //
    // 为什么不用"最近使用":最近使用是算法在猜你的习惯,猜错了就是
    // "面板里全是我不想要的"。常用由用户自己钉,顺序也自己定 ——
    // 这是"我说了算"和"系统替我猜"的区别。

    /// 钉选的 key 列表,有序(即菜单里的顺序)。
    static var pinnedKeys: [String] {
        get { (SharedContainerStore.sharedDefaults ?? .standard).stringArray(forKey: pinnedKey) ?? [] }
        // 不在 setter 里截断:静默丢一条比报错更难查。数量由 togglePin 把关。
        set { (SharedContainerStore.sharedDefaults ?? .standard).set(newValue, forKey: pinnedKey) }
    }

    static func isPinned(_ key: String) -> Bool { pinnedKeys.contains(key) }

    /// 钉/取消钉。已满时钉入失败,返回 false 让调用方能如实提示。
    @discardableResult
    static func togglePin(_ key: String) -> Bool {
        guard !key.isEmpty else { return false }
        var list = pinnedKeys
        if let idx = list.firstIndex(of: key) {
            list.remove(at: idx)
            pinnedKeys = list
            return true
        }
        guard list.count < maxPinned else { return false }
        list.append(key)
        pinnedKeys = list
        return true
    }

    /// 按 key 重排。
    ///
    /// 不能直接拿 UI 给的下标去动 pinnedKeys:列表里显示的是**可用**的
    /// 钉选(pinnedEntries 过滤掉了停用供应商下的条目),而 pinnedKeys 是
    /// 全集。有条目不可用时两者下标不对齐,直接 move 会移错行,越界还会崩。
    /// 所以先在"可见序列"上算出新顺序,再把不可见的按原相对位置缝回去。
    static func movePinned(visibleKeys: [String], from source: IndexSet, to destination: Int) {
        var visible = visibleKeys
        guard !visible.isEmpty else { return }
        visible.move(fromOffsets: source, toOffset: destination)
        let visibleSet = Set(visibleKeys)
        var result: [String] = []
        var cursor = visible.makeIterator()
        for key in pinnedKeys {
            if visibleSet.contains(key) {
                if let next = cursor.next() { result.append(next) }
            } else {
                result.append(key)   // 不可用的留在原位,别把它挤掉
            }
        }
        pinnedKeys = result
    }

    /// 钉选对应的可用条目。不可用的(供应商停用/条目删除)直接跳过 ——
    /// 但不从存储里摘,因为供应商可能只是临时停用,回头启用就该回来。
    static func pinnedEntries(store: ProviderConfigStore) -> [ModelEntry] {
        let enabled = Set(store.instances.filter(\.isEnabled).map(\.id))
        return pinnedKeys.compactMap { key in
            guard let entry = store.entry(for: key), !entry.isHidden,
                  enabled.contains(entry.providerInstanceId) else { return nil }
            return entry
        }
    }

    // MARK: - 最近使用(LRU)

    /// 存的是 ModelEntry.compositeKey("实例/模型")或 "group:<id>"。
    static var recentKeys: [String] {
        let store = SharedContainerStore.sharedDefaults ?? .standard
        return store.stringArray(forKey: recentsKey) ?? []
    }

    static func remember(_ key: String) {
        guard !key.isEmpty else { return }
        var list = recentKeys.filter { $0 != key }
        list.insert(key, at: 0)
        if list.count > maxRecents { list = Array(list.prefix(maxRecents)) }
        (SharedContainerStore.sharedDefaults ?? .standard).set(list, forKey: recentsKey)
    }

    /// 最近用过的模型条目(已过滤掉被删除/隐藏的)。
    static func recentEntries(store: ProviderConfigStore, limit: Int = 3) -> [ModelEntry] {
        // 供应商被停用后,它下面的模型不能再出现在"最近用过"里——
        // 点了会把会话绑到一个不可用的实例上,发送时才报错。
        let enabled = Set(store.instances.filter(\.isEnabled).map(\.id))
        var out: [ModelEntry] = []
        for key in recentKeys where !key.hasPrefix("group:") {
            if let entry = store.entry(for: key), !entry.isHidden,
               enabled.contains(entry.providerInstanceId) {
                out.append(entry)
                if out.count >= limit { break }
            }
        }
        return out
    }

    static func recentGroups(store: ProviderConfigStore, limit: Int = 2) -> [ModelGroup] {
        var out: [ModelGroup] = []
        for key in recentKeys where key.hasPrefix("group:") {
            let gid = String(key.dropFirst("group:".count))
            if let g = store.modelGroups.first(where: { $0.id == gid }) {
                out.append(g)
                if out.count >= limit { break }
            }
        }
        return out
    }

    // MARK: - 全部可选项(搜索用)

    struct Choice: Identifiable, Hashable {
        enum Kind: Hashable { case entry, group }
        let id: String          // entry.compositeKey 或 "group:<id>"
        let kind: Kind
        let title: String       // 模型名 / 分组名
        let subtitle: String    // 供应商实例名 / "模型分组"
    }

    /// includeGroups:分组是路由配置(默认模型 + 语音模型的组合),
    /// 和"日常换个模型"是两回事,快切路径不列它;/model 与完整选择器仍要。
    static func allChoices(store: ProviderConfigStore,
                           includeGroups: Bool = true) -> [Choice] {
        var out: [Choice] = []
        if includeGroups {
            for group in store.modelGroups {
                out.append(Choice(id: "group:\(group.id)", kind: .group,
                                  title: group.name, subtitle: String(localized: "模型分组")))
            }
        }
        for instance in store.instances where instance.isEnabled {
            for entry in store.entries(for: instance.id) where !entry.isHidden {
                out.append(Choice(id: entry.compositeKey, kind: .entry,
                                  title: entry.model.displayName,
                                  subtitle: instance.label))
            }
        }
        return out
    }

    /// 没被钉的其他模型。最近用过的排前面 —— 最近使用不再单独占一节,
    /// 降级成这里的排序信号。
    static func unpinnedChoices(store: ProviderConfigStore) -> [Choice] {
        let pinned = Set(pinnedKeys)
        // uniqueKeysWithValues 遇重复 key 直接 trap。recentKeys 来自持久化
        // 存储,脏一次就崩 —— 用 uniquingKeysWith 保守取最早那个名次。
        let recentRank = Dictionary(recentKeys.enumerated().map { ($0.element, $0.offset) },
                                    uniquingKeysWith: { first, _ in first })
        return allChoices(store: store, includeGroups: false)
            .filter { !pinned.contains($0.id) }
            .sorted { a, b in
                let ra = recentRank[a.id] ?? Int.max
                let rb = recentRank[b.id] ?? Int.max
                if ra != rb { return ra < rb }
                return a.title.localizedStandardCompare(b.title) == .orderedAscending
            }
    }

    /// 模糊匹配:"/model kimi" 这种只打几个字母就要命中。
    static func search(_ query: String, store: ProviderConfigStore) -> [Choice] {
        let q = query.trimmingCharacters(in: .whitespaces).lowercased()
        guard !q.isEmpty else { return allChoices(store: store) }
        return allChoices(store: store).filter {
            ($0.title + " " + $0.subtitle).lowercased().contains(q)
        }
    }

    // MARK: - 提交(与 SessionModelPicker 同语义)

    /// 把选择写进会话绑定。sessionId 为空时由调用方先建会话。
    @discardableResult
    static func apply(choiceId: String, sessionId: String,
                      store: ProviderConfigStore = .shared) async -> Bool {
        guard !sessionId.isEmpty else { return false }
        if choiceId.hasPrefix("group:") {
            let gid = String(choiceId.dropFirst("group:".count))
            guard let group = store.modelGroups.first(where: { $0.id == gid }) else { return false }
            // 分组成员全被隐藏/删除时解析不出模型,绑上去等于绑了个空——
            // 发送时才失败。这里直接拒绝,让调用方能如实告诉用户。
            guard let resolvedEntryId = ModelGroupRouter.resolve(
                group: group, sessionId: sessionId, store: store), !resolvedEntryId.isEmpty else {
                return false
            }
            let existing = store.binding(for: sessionId)
            store.setBinding(SessionModelBinding(
                sessionId: sessionId,
                primarySource: .group(groupId: group.id, resolvedEntryId: resolvedEntryId),
                subModelSource: existing?.subModelSource), for: sessionId)
            if let level = group.defaultThinkingLevel {
                var cfg = store.inferenceConfig(for: sessionId) ?? SessionInferenceConfig()
                cfg.thinkingLevel = level
                store.setInferenceConfig(cfg, for: sessionId)
            }
            NotificationCenter.default.post(name: .sessionModelBindingChanged, object: nil,
                                            userInfo: ["groupId": group.id, "sessionId": sessionId])
            if let entry = store.entry(for: resolvedEntryId) {
                await ChatStore.shared.updateSessionModelId(sessionId, modelId: entry.model.id)
            }
        } else {
            guard let entry = store.entry(for: choiceId) else { return false }
            let existing = store.binding(for: sessionId)
            store.setBinding(SessionModelBinding(
                sessionId: sessionId,
                primarySource: .directEntry(modelEntryId: entry.id),
                subModelSource: existing?.subModelSource), for: sessionId)
            NotificationCenter.default.post(name: .sessionModelBindingChanged, object: nil,
                                            userInfo: ["sessionId": sessionId])
            await ChatStore.shared.updateSessionModelId(sessionId, modelId: entry.model.id)
        }
        remember(choiceId)
        return true
    }

    /// 当前绑定对应的 choiceId(compositeKey 或 "group:<id>")。
    ///
    /// 打勾必须按这个比,不能按显示名 —— 同一个模型挂在官方和中转两个
    /// 实例下时,按名字比会两行都打勾,而点哪行都会真的换实例。
    static func currentChoiceId(sessionId: String?, store: ProviderConfigStore = .shared) -> String? {
        guard let sessionId, !sessionId.isEmpty,
              let binding = store.binding(for: sessionId) else { return nil }
        switch binding.primarySource {
        case .group(let groupId, _):
            return "group:\(groupId)"
        case .directEntry(let entryId, let composite):
            let key = composite ?? entryId
            return store.entry(for: key)?.compositeKey ?? key
        }
    }

    /// 当前会话绑定对应的短名,给胶囊显示用。
    static func currentLabel(sessionId: String?, store: ProviderConfigStore = .shared) -> String? {
        guard let sessionId, !sessionId.isEmpty,
              let binding = store.binding(for: sessionId) else { return nil }
        switch binding.primarySource {
        case .group(let groupId, _):
            return store.modelGroups.first { $0.id == groupId }?.name
        case .directEntry(let entryId, let composite):
            let key = composite ?? entryId
            return store.entry(for: key)?.model.displayName
                ?? store.entry(for: entryId)?.model.displayName
        }
    }
}
