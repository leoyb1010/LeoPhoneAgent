//
//  HarnessSessionSettingsSheet.swift
//  MinisApp
//
//  [remote-ctl-ios] Mac 会话设置:模型、推理强度、压缩上下文、重命名、关注。
//  每一项都只在这台 Mac 报了对应能力(`/v1/capabilities` features)时显示,旧 Mac 看不到。
//  契约见 src/mac/leophone/docs/specs/leo-link-remote-controls.md。
//

import SwiftUI

/// 会话页顶部的一行:当前模型 · 强度、关注状态;点开设置。没有任何可设项时不显示。
struct HarnessSessionHeader: View {
    @ObservedObject var driver: HarnessSessionDriver
    let onOpen: () -> Void

    var body: some View {
        Button(action: onOpen) {
            HStack(spacing: 6) {
                Image(systemName: "cpu").font(.system(size: 11, weight: .semibold))
                Text(modelLabel)
                    .font(.system(size: 12, weight: .semibold))
                    .lineLimit(1)
                if let effort = driver.model?.effort {
                    Text("·").foregroundStyle(.secondary)
                    Text(HarnessEffort.title(effort))
                        .font(.system(size: 12))
                        .foregroundStyle(.secondary)
                }
                if driver.features?.follows == true, let following = driver.following {
                    Image(systemName: following ? "bell.fill" : "bell.slash")
                        .font(.system(size: 11))
                        .foregroundStyle(following ? Color.accentColor : Color.secondary)
                        .accessibilityLabel(following ? Text("已关注") : Text("未关注"))
                }
                Spacer(minLength: 0)
                Image(systemName: "gearshape").font(.system(size: 13))
            }
            .foregroundStyle(.primary)
            .padding(.horizontal, 14)
            .padding(.vertical, 6)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .background(.bar)
        .accessibilityLabel(Text("会话设置"))
        .accessibilityValue(Text(modelLabel))
        .accessibilityIdentifier("harness.sessionSettings")
    }

    private var modelLabel: String {
        driver.model?.displayName ?? AppLocalized("自动选择模型")
    }
}

struct HarnessSessionSettingsSheet: View {
    @ObservedObject var driver: HarnessSessionDriver
    @Environment(\.dismiss) private var dismiss
    @State private var catalog: HarnessModelCatalog?
    @State private var loadError: String?
    @State private var working = false
    @State private var confirmCompact = false
    @State private var renaming = false
    @State private var newTitle = ""

    private var features: HarnessFeatures { driver.features ?? HarnessFeatures(server: nil, flags: []) }

    /// 当前模型可选的强度:列表里找到当前模型用它的,找不到用 Mac 的自动选择那一项。
    private var efforts: [String] {
        guard let catalog else { return [] }
        let option = catalog.option(for: driver.model) ?? catalog.option(for: catalog.defaultModel)
        return option?.efforts ?? []
    }

    var body: some View {
        NavigationStack {
            List {
                if features.switchesModel {
                    modelSection
                }
                if features.switchesEffort, !efforts.isEmpty {
                    Section {
                        ForEach(efforts, id: \.self) { effort in
                            Button {
                                LeoHaptics.selection()
                                run { await driver.setEffort(effort) }
                            } label: {
                                HStack {
                                    Text(HarnessEffort.title(effort)).foregroundStyle(.primary)
                                    Spacer()
                                    if driver.model?.effort == effort {
                                        Image(systemName: "checkmark").foregroundStyle(.tint)
                                    }
                                }
                            }
                            .disabled(working)
                        }
                    } header: {
                        Text("推理强度")
                    } footer: {
                        Text("从下一轮起生效。")
                    }
                }
                if features.follows {
                    Section {
                        Toggle(isOn: Binding(
                            get: { driver.following ?? false },
                            set: { value in run { await driver.setFollowing(value) } })) {
                            Text("关注这个任务")
                        }
                        .disabled(working)
                    } footer: {
                        Text("关注后才会推送和显示在进行中")
                    }
                }
                if features.renames || features.compacts {
                    Section {
                        if features.renames {
                            Button {
                                newTitle = driver.sessionTitle ?? ""
                                renaming = true
                            } label: {
                                Label("重命名", systemImage: "pencil")
                            }
                            .disabled(working)
                        }
                        if features.compacts {
                            Button {
                                confirmCompact = true
                            } label: {
                                Label("压缩上下文", systemImage: "arrow.down.right.and.arrow.up.left")
                            }
                            .disabled(working)
                        }
                    } header: {
                        Text("会话")
                    }
                }
            }
            .navigationTitle(Text("会话设置"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("完成") { dismiss() }
                }
            }
            .task {
                guard features.switchesModel || features.switchesEffort, catalog == nil else { return }
                do { catalog = try await driver.loadModels() }
                catch { loadError = LeoAgentClient.describeHarnessFeatureError(error) }
            }
            .confirmationDialog(Text("压缩上下文？"), isPresented: $confirmCompact, titleVisibility: .visible) {
                Button("压缩上下文") { run { await driver.compact() } }
                Button("取消", role: .cancel) {}
            } message: {
                Text("Mac 会把这个会话之前的对话总结成摘要，腾出上下文空间。")
            }
            .alert(Text("重命名"), isPresented: $renaming) {
                TextField("任务标题", text: $newTitle)
                Button("取消", role: .cancel) {}
                Button("保存") { run { await driver.rename(newTitle) } }
                    .disabled(newTitle.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            } message: {
                Text("Mac 桌面上也会看到新标题。")
            }
        }
    }

    @ViewBuilder
    private var modelSection: some View {
        if let catalog {
            if catalog.models.isEmpty {
                Section {
                    Text("这台 Mac 没有可选的模型。").foregroundStyle(.secondary)
                } header: {
                    Text("模型")
                }
            }
            ForEach(Array(catalog.groups.enumerated()), id: \.element.id) { index, group in
                Section {
                    ForEach(group.models) { option in
                        Button {
                            LeoHaptics.selection()
                            run { await driver.setModel(option) }
                        } label: {
                            HStack {
                                Text(option.name).foregroundStyle(.primary)
                                Spacer()
                                if driver.model?.sameModel(as: option) == true {
                                    Image(systemName: "checkmark").foregroundStyle(.tint)
                                }
                            }
                        }
                        .disabled(working)
                    }
                } header: {
                    if index == 0 {
                        Text("模型 · \(group.providerName)")
                    } else {
                        Text(group.providerName)
                    }
                } footer: {
                    if index == catalog.groups.count - 1 {
                        Text("从下一轮起生效。")
                    }
                }
            }
        } else {
            Section {
                if let loadError {
                    Label(loadError, systemImage: "exclamationmark.triangle")
                        .font(.footnote).foregroundStyle(.red)
                } else {
                    HStack { ProgressView(); Text("正在读取 Mac 上的模型…").foregroundStyle(.secondary) }
                }
            } header: {
                Text("模型")
            }
        }
    }

    private func run(_ action: @escaping () async -> Bool) {
        working = true
        Task {
            _ = await action()
            working = false
        }
    }
}
