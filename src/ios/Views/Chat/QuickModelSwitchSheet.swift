//
//  QuickModelSwitchSheet.swift
//  MinisApp
//
//  [T-model-pin] 换模型的快车道 —— 常用由用户自己钉。
//
//  上一版用"最近使用"当常用来源,是算法在猜习惯:猜错了面板里就全是
//  不想要的,而真正想换的那两三个反倒要翻。这一版改成钉选 —— 点 ☆
//  钉住,顺序自己拖,长按输入框上的模型胶囊直接弹出这几个,一步换完。
//
//  分组不在这里。分组是路由配置(默认模型 + 语音模型的组合),和"日常
//  换个模型"是两回事,混在一起只是噪音;要绑分组走底部完整选择器。
//
//  这个面板本身的定位随之变成"管理常用 + 兜底切换":日常最快的路径是
//  长按胶囊,不必开面板。
//

import SwiftUI

struct QuickModelSwitchSheet: View {
    let sessionId: String?
    /// 会话还没建时(草稿)由调用方补建,拿到 id 才能写绑定。
    let ensureSessionId: (() async -> String)?

    @StateObject private var store = ProviderConfigStore.shared
    @State private var query = ""
    @State private var showFullPicker = false
    @State private var failure: String?
    /// 钉选存在 UserDefaults 里,不是 @Published;改动后靠这个 @State 触发
    /// body 重算。**不要**拿它当 .id() —— 换身份会把整个 List 拆掉重建,
    /// 滚到第 20 行点个 ☆ 就跳回顶部,连钉三个要重新滚三次。
    @State private var pinTick = 0
    @Environment(\.dismiss) private var dismiss

    /// 打勾按身份比。同一个模型挂在两个供应商实例下时,按显示名比会
    /// 两行都打勾,而点哪行都会真的换实例。
    private var currentKey: String? { ModelSwitcher.currentChoiceId(sessionId: sessionId) }

    private var searching: Bool {
        !query.trimmingCharacters(in: .whitespaces).isEmpty
    }

    var body: some View {
        NavigationStack {
            List {
                if searching {
                    searchResults
                } else {
                    pinnedSection
                    othersSection
                    footerSection
                }
            }
            .searchable(text: $query, prompt: "搜索模型")
            .navigationTitle("切换模型")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消") { dismiss() }
                }
                // 条件要跟实际渲染的行一致:用 pinnedKeys 会在"钉过但当前
                // 不可用"时显示一个拖不动任何东西的编辑按钮。
                if !ModelSwitcher.pinnedEntries(store: store).isEmpty {
                    ToolbarItem(placement: .primaryAction) { EditButton() }
                }
            }
            .alert("没能切换", isPresented: Binding(
                get: { failure != nil }, set: { if !$0 { failure = nil } })) {
                Button("知道了", role: .cancel) { failure = nil }
            } message: {
                Text(failure ?? "")
            }
            .sheet(isPresented: $showFullPicker) {
                NavigationStack {
                    SessionModelPicker(sessionId: sessionId) {
                        await ensureSessionId?() ?? ""
                    }
                }
                .presentationDetents([.large])
            }
        }
    }

    // MARK: - 常用

    @ViewBuilder
    private var pinnedSection: some View {
        let pinned = ModelSwitcher.pinnedEntries(store: store)
        Section {
            if pinned.isEmpty {
                Label("点下面任意模型右边的 ☆,把常用的钉在这里",
                      systemImage: "star")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            } else {
                ForEach(pinned, id: \.compositeKey) { entry in
                    row(key: entry.compositeKey,
                        title: entry.model.displayName,
                        subtitle: store.instances.first { $0.id == entry.providerInstanceId }?.label ?? "")
                }
                .onMove { source, dest in
                    ModelSwitcher.movePinned(visibleKeys: pinned.map(\.compositeKey),
                                             from: source, to: dest)
                    pinTick += 1
                }
            }
        } header: {
            Text("常用")
        } footer: {
            if !pinned.isEmpty {
                Text("长按输入框上方的模型胶囊,可以直接弹出这几个,不用开面板。")
            }
        }
    }

    // MARK: - 其他

    @ViewBuilder
    private var othersSection: some View {
        let others = ModelSwitcher.unpinnedChoices(store: store)
        if others.isEmpty {
            if ModelSwitcher.pinnedEntries(store: store).isEmpty {
                Section {
                    Text("还没有可用的模型——先到「模型供应商」里添加或启用一个。")
                        .font(.callout).foregroundStyle(.secondary)
                }
            }
        } else {
            Section("其他模型") {
                ForEach(others.prefix(40)) { choice in
                    row(key: choice.id, title: choice.title, subtitle: choice.subtitle)
                }
                if others.count > 40 {
                    Text("还有 \(others.count - 40) 个,搜索一下更快")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
        }
    }

    @ViewBuilder
    private var searchResults: some View {
        let hits = ModelSwitcher.search(query, store: store).filter { $0.kind == .entry }
        if hits.isEmpty {
            Text("没有匹配的模型").foregroundStyle(.secondary)
        } else {
            ForEach(hits.prefix(30)) { choice in
                row(key: choice.id, title: choice.title, subtitle: choice.subtitle)
            }
        }
    }

    private var footerSection: some View {
        Section {
            Button {
                showFullPicker = true
            } label: {
                Label("全部模型与分组…", systemImage: "square.grid.2x2")
            }
        } footer: {
            Text("模型分组(默认模型 + 语音模型的组合)在这里绑定。输入框打 /model kimi 也能一步切换。")
        }
    }

    // MARK: - 行

    private func row(key: String, title: String, subtitle: String) -> some View {
        HStack(spacing: 10) {
            Button {
                commit(key)
            } label: {
                HStack(spacing: 10) {
                    VStack(alignment: .leading, spacing: 1) {
                        Text(title).font(.system(size: 15)).foregroundStyle(.primary)
                        if !subtitle.isEmpty {
                            Text(subtitle).font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    Spacer(minLength: 0)
                    if key == currentKey {
                        Image(systemName: "checkmark")
                            .font(.system(size: 12, weight: .semibold))
                            .foregroundStyle(.tint)
                    }
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            // ☆ 独立热区:钉选不该顺带把模型切了
            Button {
                if !ModelSwitcher.togglePin(key) {
                    failure = "常用最多放 \(ModelSwitcher.maxPinned) 个,先取消一个再钉。"
                }
                LeoHaptics.selection()
                pinTick += 1
            } label: {
                Image(systemName: ModelSwitcher.isPinned(key) ? "star.fill" : "star")
                    .font(.system(size: 15))
                    .foregroundStyle(ModelSwitcher.isPinned(key) ? .yellow : .secondary)
                    .frame(width: 40, height: 36)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(ModelSwitcher.isPinned(key) ? "取消常用" : "设为常用")
        }
    }

    private func commit(_ choiceId: String) {
        LeoHaptics.selection()
        Task {
            var sid = sessionId ?? ""
            if sid.isEmpty { sid = await ensureSessionId?() ?? "" }
            guard !sid.isEmpty else {
                await MainActor.run { failure = "会话还没准备好,稍后再试。" }
                return
            }
            let ok = await ModelSwitcher.apply(choiceId: choiceId, sessionId: sid)
            await MainActor.run {
                // 切失败还关面板,用户会以为切好了 —— 留在原地并说明原因。
                if ok { dismiss() } else { failure = "这个模型当前不可用(供应商已停用,或已被删除)。" }
            }
        }
    }
}
