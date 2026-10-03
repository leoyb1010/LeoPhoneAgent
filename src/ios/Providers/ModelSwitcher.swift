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
    /// Favorites are a library; compact menus choose their own small prefix.
    /// Existing lists are never truncated on upgrade or refresh.
    static let maxPinned = 50

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

    static func normalizedChoiceKeys(_ keys: [String], store: ProviderConfigStore) -> [String] {
        ModelCatalog.normalizedKeys(keys.map { store.normalizeEntryRef($0) }, aliases: [:])
    }

    static func isPinned(_ key: String, store: ProviderConfigStore = .shared) -> Bool {
        normalizedChoiceKeys(pinnedKeys, store: store).contains(store.normalizeEntryRef(key))
    }

    /// 钉/取消钉。已满时钉入失败,返回 false 让调用方能如实提示。
    ///
    /// 上限只数**看得见**的常用:删掉的供应商留下的钉选不显示,却曾照样
    /// 占名额 —— 6 个里删掉一个供应商,只剩 2 个可见,却提示"已满 6 个"。
    @discardableResult
    static func togglePin(_ key: String, store: ProviderConfigStore = .shared) -> Bool {
        guard !key.isEmpty else { return false }
        // 顺手清掉已删除供应商的遗留(实例 id 不会复用,删了就是永久的)。
        forget(instanceIds: store.deletedInstanceIds)
        let key = store.normalizeEntryRef(key)
        var list = normalizedChoiceKeys(pinnedKeys, store: store)
        if let idx = list.firstIndex(of: key) {
            list.remove(at: idx)
            pinnedKeys = list
            return true
        }
        guard store.entry(for: key) != nil,
              pinnedEntries(store: store).count < maxPinned else { return false }
        list.append(key)
        pinnedKeys = list
        return true
    }

    /// 删掉供应商 / 模型 / 分组时,把指向它们的钉选和最近使用一起摘掉。
    ///
    /// 只在**删除**时调用,停用不调:停用的供应商回头启用,它的常用应该回来。
    static func forget(instanceIds: Set<String> = [], entryIds: Set<String> = [], groupIds: Set<String> = []) {
        guard !instanceIds.isEmpty || !entryIds.isEmpty || !groupIds.isEmpty else { return }
        func isGone(_ key: String) -> Bool {
            ModelChoiceKey.isGone(key, instanceIds: instanceIds, entryIds: entryIds, groupIds: groupIds)
        }
        let pins = pinnedKeys
        let keptPins = pins.filter { !isGone($0) }
        if keptPins.count != pins.count {
            pinnedKeys = keptPins
            ModelPinStore.shared.reload()
        }
        let recents = recentKeys
        let keptRecents = recents.filter { !isGone($0) }
        if keptRecents.count != recents.count {
            (SharedContainerStore.sharedDefaults ?? .standard).set(keptRecents, forKey: recentsKey)
        }
    }

    /// 按 key 重排。
    ///
    /// 不能直接拿 UI 给的下标去动 pinnedKeys:列表里显示的是**可用**的
    /// 钉选(pinnedEntries 过滤掉了停用供应商下的条目),而 pinnedKeys 是
    /// 全集。有条目不可用时两者下标不对齐,直接 move 会移错行,越界还会崩。
    /// 所以先在"可见序列"上算出新顺序,再把不可见的按原相对位置缝回去。
    static func movePinned(visibleKeys: [String], from source: IndexSet, to destination: Int,
                           store: ProviderConfigStore = .shared) {
        let keys = normalizedChoiceKeys(pinnedKeys, store: store)
        let visible = normalizedChoiceKeys(visibleKeys, store: store)
        pinnedKeys = ModelCatalog.reorderedKeys(keys, visibleKeys: visible, from: source, to: destination)
    }

    /// 钉选对应的可用条目。不可用的(供应商停用/条目删除)直接跳过 ——
    /// 但不从存储里摘,因为供应商可能只是临时停用,回头启用就该回来。
    static func pinnedEntries(store: ProviderConfigStore) -> [ModelEntry] {
        let enabled = Set(store.instances.filter(\.isEnabled).map(\.id))
        return normalizedChoiceKeys(pinnedKeys, store: store).compactMap { key in
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

    static func remember(_ key: String, store: ProviderConfigStore = .shared) {
        guard !key.isEmpty else { return }
        let key = store.normalizeEntryRef(key)
        var list = normalizedChoiceKeys(recentKeys, store: store).filter { $0 != key }
        list.insert(key, at: 0)
        if list.count > maxRecents { list = Array(list.prefix(maxRecents)) }
        (SharedContainerStore.sharedDefaults ?? .standard).set(list, forKey: recentsKey)
    }

    /// 最近用过的模型条目(已过滤掉被删除/隐藏的)。
    static func recentEntries(store: ProviderConfigStore, limit: Int = 3) -> [ModelEntry] {
        // 供应商被停用后,它下面的模型不能再出现在"最近用过"里——
        // 点了会把会话绑到一个不可用的实例上,发送时才报错。
        guard limit > 0 else { return [] }
        let enabled = Set(store.instances.filter(\.isEnabled).map(\.id))
        var out: [ModelEntry] = []
        for key in normalizedChoiceKeys(recentKeys, store: store) where !key.hasPrefix("group:") {
            if let entry = store.entry(for: key), !entry.isHidden,
               enabled.contains(entry.providerInstanceId) {
                out.append(entry)
                if out.count >= limit { break }
            }
        }
        return out
    }

    static func recentGroups(store: ProviderConfigStore, limit: Int = 2) -> [ModelGroup] {
        guard limit > 0 else { return [] }
        var out: [ModelGroup] = []
        for key in normalizedChoiceKeys(recentKeys, store: store) where key.hasPrefix("group:") {
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
        let pinned = Set(normalizedChoiceKeys(pinnedKeys, store: store))
        // uniqueKeysWithValues 遇重复 key 直接 trap。recentKeys 来自持久化
        // 存储,脏一次就崩 —— 用 uniquingKeysWith 保守取最早那个名次。
        let recentRank = Dictionary(normalizedChoiceKeys(recentKeys, store: store).enumerated().map { ($0.element, $0.offset) },
                                    uniquingKeysWith: { first, _ in first })
        return allChoices(store: store, includeGroups: false)
            .filter { !pinned.contains($0.id) }
            .sorted { a, b in
                let ra = recentRank[a.id] ?? Int.max
                let rb = recentRank[b.id] ?? Int.max
                if ra != rb { return ra < rb }
                let titleOrder = a.title.localizedStandardCompare(b.title)
                if titleOrder != .orderedSame { return titleOrder == .orderedAscending }
                let providerOrder = a.subtitle.localizedStandardCompare(b.subtitle)
                if providerOrder != .orderedSame { return providerOrder == .orderedAscending }
                return a.id < b.id
            }
    }

    /// 模糊匹配:"/model kimi" 这种只打几个字母就要命中。
    static func search(_ query: String, store: ProviderConfigStore) -> [Choice] {
        allChoices(store: store).filter { choice in
            if choice.kind == .entry, let entry = store.entry(for: choice.id) {
                return ModelCatalog.matches(query, entry: entry, providerLabel: choice.subtitle)
            }
            return ModelCatalog.matches(query, text: choice.title + " " + choice.subtitle)
        }
    }

    /// Validate again at commit time: a provider can be disabled or lose its
    /// credential while a picker is open. Failed selection leaves binding and
    /// recents untouched; it must never silently choose a different provider.
    static func isAvailable(_ entry: ModelEntry, store: ProviderConfigStore = .shared) -> Bool {
        guard !entry.isHidden, let instance = store.instance(for: entry.providerInstanceId) else { return false }
        return instance.isEnabled && !instance.isRetiredSignIn && instance.hasAnyCredential
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
            guard store.setBinding(SessionModelBinding(
                sessionId: sessionId,
                primarySource: .group(groupId: group.id, resolvedEntryId: resolvedEntryId),
                subModelSource: existing?.subModelSource), for: sessionId) else { return false }
            // Keep the user's preferred thinking level across model switches.
            // Group default only seeds a session that has never picked a level.
            NotificationCenter.default.post(name: .sessionModelBindingChanged, object: nil,
                                            userInfo: ["groupId": group.id, "sessionId": sessionId])
            if let entry = store.entry(for: resolvedEntryId) {
                await ChatStore.shared.updateSessionModelId(sessionId, modelId: entry.model.id)
            }
        } else {
            guard let entry = store.entry(for: choiceId), isAvailable(entry, store: store) else { return false }
            let existing = store.binding(for: sessionId)
            guard store.setBinding(SessionModelBinding(
                sessionId: sessionId,
                primarySource: .directEntry(modelEntryId: entry.id),
                subModelSource: existing?.subModelSource), for: sessionId) else { return false }
            NotificationCenter.default.post(name: .sessionModelBindingChanged, object: nil,
                                            userInfo: ["sessionId": sessionId])
            await ChatStore.shared.updateSessionModelId(sessionId, modelId: entry.model.id)
        }
        remember(choiceId, store: store)
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
            return store.entry(for: key)?.compositeKey
                ?? store.entry(for: entryId)?.compositeKey ?? key
        }
    }

    /// 没有会话绑定时,新对话实际会用的模型 —— 默认模型分组解析出的那个。
    ///
    /// 胶囊显示的必须是"发出去会用谁",不是某个遗留的 selectedModel。
    /// 用户看到胶囊写 Haiku、实际发出去走默认分组的 Kimi,是欺骗。
    static func defaultLabel(store: ProviderConfigStore = .shared) -> String? {
        guard let groupId = store.defaultPrimaryGroupId,
              let group = store.group(for: groupId) else { return nil }
        // loadBalance 按真实 sessionId 散列,草稿阶段无法预知会命中谁 ——
        // 谎报一个具体模型名(显示 A 实际用 B)不如如实显示分组名。
        // fallback 策略 resolve 恒取第一个可用成员,与真实发送一致,可显示。
        if group.strategy == .loadBalance { return group.name }
        if let entryId = ModelGroupRouter.resolve(group: group, sessionId: "draft",
                                                  store: store, verbose: false),
           let entry = store.entry(for: entryId) {
            return entry.model.displayName
        }
        return group.name
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
