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
        var out: [ModelEntry] = []
        for key in recentKeys where !key.hasPrefix("group:") {
            if let entry = store.entry(for: key), !entry.isHidden {
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

    static func allChoices(store: ProviderConfigStore) -> [Choice] {
        var out: [Choice] = []
        for group in store.modelGroups {
            out.append(Choice(id: "group:\(group.id)", kind: .group,
                              title: group.name, subtitle: String(localized: "模型分组")))
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
            let resolvedEntryId = ModelGroupRouter.resolve(group: group, sessionId: sessionId, store: store) ?? ""
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
