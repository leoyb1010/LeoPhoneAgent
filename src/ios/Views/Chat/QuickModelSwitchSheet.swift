//
//  QuickModelSwitchSheet.swift
//  MinisApp
//
//  [T-model-quickswitch] 换模型的快车道。
//
//  紧凑面板(medium 尺寸,不是全屏):最近用过的置顶 → 搜索框 → 全部。
//  日常"换回刚才那个"变成两下:开面板、点名字。要翻全部供应商时,
//  底部一行进入原来的完整 picker,老路径一步没少。
//

import SwiftUI

struct QuickModelSwitchSheet: View {
    let sessionId: String?
    /// 会话还没建时(草稿)由调用方补建,拿到 id 才能写绑定。
    let ensureSessionId: (() async -> String)?

    @StateObject private var store = ProviderConfigStore.shared
    @State private var query = ""
    @State private var showFullPicker = false
    @Environment(\.dismiss) private var dismiss

    private var currentLabel: String? { ModelSwitcher.currentLabel(sessionId: sessionId) }

    private var searching: Bool {
        !query.trimmingCharacters(in: .whitespaces).isEmpty
    }

    var body: some View {
        NavigationStack {
            List {
                if searching {
                    let hits = ModelSwitcher.search(query, store: store)
                    if hits.isEmpty {
                        Text("没有匹配的模型").foregroundStyle(.secondary)
                    } else {
                        ForEach(hits.prefix(30)) { choice in
                            choiceRow(id: choice.id, title: choice.title,
                                      subtitle: choice.subtitle, isGroup: choice.kind == .group)
                        }
                    }
                } else {
                    recentSection
                    groupSection
                    // 全部模型直接平铺(cap 30)。原来这里只有一行"全部模型…"
                    // 入口——新用户/没用过快切的人打开面板是空的,看起来就是
                    // "点了但没东西可选"。
                    inlineAllSection
                    allSection
                }
            }
            .searchable(text: $query, prompt: "搜索模型")
            .alert("没能切换", isPresented: Binding(
                get: { failure != nil }, set: { if !$0 { failure = nil } })) {
                Button("知道了", role: .cancel) { failure = nil }
            } message: {
                Text(failure ?? "")
            }
            .navigationTitle("切换模型")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消") { dismiss() }
                }
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

    @ViewBuilder
    private var recentSection: some View {
        let recents = ModelSwitcher.recentEntries(store: store, limit: 4)
        if !recents.isEmpty {
            Section("最近用过") {
                ForEach(recents, id: \.compositeKey) { entry in
                    choiceRow(id: entry.compositeKey, title: entry.model.displayName,
                              subtitle: store.instances.first { $0.id == entry.providerInstanceId }?.label ?? "",
                              isGroup: false)
                }
            }
        }
    }

    @ViewBuilder
    private var groupSection: some View {
        if !store.modelGroups.isEmpty {
            Section("模型分组") {
                ForEach(store.modelGroups.prefix(6), id: \.id) { group in
                    choiceRow(id: "group:\(group.id)", title: group.name,
                              subtitle: "分组 · 自动路由", isGroup: true)
                }
            }
        }
    }

    @ViewBuilder
    private var inlineAllSection: some View {
        let recentKeys = Set(ModelSwitcher.recentEntries(store: store, limit: 4).map(\.compositeKey))
        let choices = ModelSwitcher.allChoices(store: store)
            .filter { $0.kind == .entry && !recentKeys.contains($0.id) }
        if !choices.isEmpty {
            Section("全部模型") {
                ForEach(choices.prefix(30)) { choice in
                    choiceRow(id: choice.id, title: choice.title,
                              subtitle: choice.subtitle, isGroup: false)
                }
                if choices.count > 30 {
                    Text("还有 \(choices.count - 30) 个,搜索或进完整列表查看")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
        } else if ModelSwitcher.recentEntries(store: store, limit: 1).isEmpty,
                  store.modelGroups.isEmpty {
            Section {
                Text("还没有可用的模型——先到「模型供应商」里添加或启用一个。")
                    .font(.callout).foregroundStyle(.secondary)
            }
        }
    }

    private var allSection: some View {
        Section {
            Button {
                showFullPicker = true
            } label: {
                Label("全部模型与供应商…", systemImage: "square.grid.2x2")
            }
        } footer: {
            Text("提示:在输入框直接打 /model kimi 可以一步切换;长按发送键可以只用某个模型发这一条。")
        }
    }

    private func choiceRow(id: String, title: String, subtitle: String, isGroup: Bool) -> some View {
        Button {
            commit(id)
        } label: {
            HStack(spacing: 10) {
                Image(systemName: isGroup ? "square.stack.3d.up" : "cpu")
                    .font(.system(size: 12))
                    .foregroundStyle(isGroup ? .orange : .indigo)
                    .frame(width: 22)
                VStack(alignment: .leading, spacing: 1) {
                    Text(title).font(.system(size: 15)).foregroundStyle(.primary)
                    if !subtitle.isEmpty {
                        Text(subtitle).font(.caption).foregroundStyle(.secondary)
                    }
                }
                Spacer(minLength: 0)
                if title == currentLabel {
                    Image(systemName: "checkmark").font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(.tint)
                }
            }
        }
        .buttonStyle(.plain)
    }

    @State private var failure: String?

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
                if ok { dismiss() } else { failure = "这个模型当前不可用(供应商已停用,或分组里没有可用成员)。" }
            }
        }
    }
}
