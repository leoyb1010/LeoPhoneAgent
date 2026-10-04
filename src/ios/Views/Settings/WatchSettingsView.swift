//
//  WatchSettingsView.swift
//  MinisApp
//
//  [T-watch-standalone] 设置 → Apple Watch:手表怎么回答、直连时用哪个模型、
//  [T-watch-skills] 直连时能用哪些远程工具(联网搜索这类)。
//  改完立刻经 WatchConnectivity 发给手表(API Key 和工具钥匙进手表自己的钥匙串)。
//

import SwiftUI

struct WatchSettingsView: View {
    @ObservedObject private var bridge = WatchBridge.shared
    @AppStorage(WatchStandalone.modeKey) private var mode = WatchStandalone.mode.rawValue
    @AppStorage(WatchStandalone.entryKey) private var entryId = ""
    @State private var candidates: [WatchStandalone.Candidate] = []
    @State private var toolRows: [WatchStandalone.ToolRow] = []
    @State private var toolsOn: Set<String> = []

    private var isOff: Bool { mode == WatchStandalone.Mode.off.rawValue }

    var body: some View {
        List {
            Section {
                Picker("手表怎么回答", selection: $mode) {
                    Text("自动").tag(WatchStandalone.Mode.auto.rawValue)
                    Text("总是手表直连").tag(WatchStandalone.Mode.always.rawValue)
                    Text("只经 iPhone").tag(WatchStandalone.Mode.off.rawValue)
                }
                .pickerStyle(.inline)
                .labelsHidden()
            } header: {
                Text("手表怎么回答")
            } footer: {
                Text(modeFooter)
            }

            if !isOff {
                Section {
                    NavigationLink {
                        WatchDirectModelPicker(entryId: $entryId, candidates: candidates)
                    } label: {
                        LabeledContent("直连模型") {
                            Text(selectedModelLabel)
                                .foregroundStyle(.secondary)
                                .multilineTextAlignment(.trailing)
                        }
                    }
                    let resolved = resolvedLine
                    Label(resolved.text, systemImage: resolved.ok ? "checkmark.circle.fill" : "exclamationmark.circle.fill")
                        .font(.footnote)
                        .foregroundStyle(resolved.ok ? Color.secondary : Color.orange)
                } header: {
                    Text("手表直连用的模型")
                } footer: {
                    Text("只有用 API Key 接入、OpenAI 兼容或 Anthropic 接口的模型能在手表上直连(DeepSeek、Kimi、通义这类兼容接口都算);订阅登录(OAuth)的只能经 iPhone。这个模型的 API Key 经加密通道存进手表自己的钥匙串,改成「只经 iPhone」就从手表上删掉。")
                }
            }

            if !isOff {
                Section {
                    if toolRows.isEmpty {
                        Text("还没有远程(HTTP)工具。在 设置 → MCP 里添加一个,比如「智谱联网搜索」,手表直连时就能搜。")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                    ForEach(toolRows) { row in
                        Toggle(isOn: Binding(
                            get: { row.usable && toolsOn.contains(row.id) },
                            set: { on in
                                if on { toolsOn.insert(row.id) } else { toolsOn.remove(row.id) }
                                WatchStandalone.toolsOn = toolsOn
                                WatchBridge.shared.syncStandaloneConfigIfNeeded(force: true)
                            }
                        )) {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(row.id)
                                if let reason = row.reason {
                                    Text(reason).font(.caption).foregroundStyle(.orange)
                                }
                            }
                        }
                        .disabled(!row.usable)
                    }
                } header: {
                    Text("手表直连时能用的工具")
                } footer: {
                    Text("iPhone 在身边时,手表的问题交给 iPhone 上的 Leo,所有技能和工具都能用。手表自己回答时,只能用你在这里逐个打开的远程工具(默认全关):手表上调用工具不会再问你,打开的工具连同它的地址和钥匙会经加密通道存进手表自己的钥匙串,所以只开只读的(联网搜索、地图、天气这类)。要在 iPhone 本机环境里跑的技能、需要登录授权的工具只能经 iPhone。")
                }
            }

            Section {
                Button("现在同步到手表") {
                    WatchBridge.shared.syncStandaloneConfigIfNeeded(force: true)
                }
                .disabled(bridge.watchUnreachableReason != nil)
            } footer: {
                Text(bridge.watchUnreachableReason ?? "改了上面的选项会自动同步;手表暂时连不上时,下次连上自动送到。")
            }
        }
        .navigationTitle("Apple Watch")
        .navigationBarTitleDisplayMode(.inline)
        .onAppear {
            candidates = WatchStandalone.candidates()
            toolRows = WatchStandalone.toolRows()
            toolsOn = WatchStandalone.toolsOn
            // An unavailable explicit choice stays selected until the user changes it.
            bridge.refreshWatchState()
        }
        .onChange(of: mode) { _, _ in WatchBridge.shared.syncStandaloneConfigIfNeeded(force: true) }
        .onChange(of: entryId) { _, _ in WatchBridge.shared.syncStandaloneConfigIfNeeded(force: true) }
    }

    private var modeFooter: String {
        switch WatchStandalone.Mode(rawValue: mode) ?? .auto {
        case .auto:
            return "iPhone 在身边时交给 iPhone 上的 Leo 完整处理(能用工具、接着手机上的对话);离开 iPhone(蜂窝版手表、手机没带)时,手表自己直连下面的模型。"
        case .always:
            return "手表总是自己直连下面的模型,不等 iPhone,蜂窝网络下也一样;能用下面打开的联网工具,其余技能只能经 iPhone。"
        case .off:
            return "iPhone 不在身边时手表不回答,手表上不留任何钥匙。"
        }
    }

    private var selectedModelLabel: String {
        guard !entryId.isEmpty else { return String(localized: "跟默认模型分组走") }
        guard let selected = candidates.first(where: { $0.id == entryId }) else {
            return String(localized: "Unavailable model")
        }
        return "\(selected.modelName) · \(selected.providerName)"
    }

    private var resolvedLine: (ok: Bool, text: String) {
        switch WatchStandalone.resolve() {
        case .success(let config): return (true, "手表会用 \(config.modelName) · \(config.providerName)")
        case .failure(let reason): return (false, reason.explanation)
        }
    }
}

private struct WatchDirectModelPicker: View {
    @Binding var entryId: String
    let candidates: [WatchStandalone.Candidate]
    @State private var query = ""
    @Environment(\.dismiss) private var dismiss

    private var selected: WatchStandalone.Candidate? {
        candidates.first { $0.id == entryId }
    }

    private var matches: [WatchStandalone.Candidate] {
        WatchModelSearch.results(candidates, query: query)
    }

    var body: some View {
        List {
            // Keep the actual choice visible even when the search excludes it.
            // Merely opening, filtering or leaving this list never writes entryId.
            Section("Current selection") {
                if entryId.isEmpty {
                    defaultChoice
                } else if let selected {
                    candidateChoice(selected)
                } else {
                    HStack {
                        Text("Unavailable model")
                            .foregroundStyle(.secondary)
                        Spacer(minLength: 8)
                        Image(systemName: "checkmark")
                            .foregroundStyle(Color.accentColor)
                            .accessibilityHidden(true)
                    }
                    .accessibilityAddTraits(.isSelected)
                }
            }

            Section("Available models") {
                if !entryId.isEmpty { defaultChoice }
                ForEach(matches.filter { $0.id != entryId }) { candidate in
                    candidateChoice(candidate)
                }
                if matches.isEmpty {
                    if query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                        Text("No models available").foregroundStyle(.secondary)
                    } else {
                        Text("No results").foregroundStyle(.secondary)
                    }
                }
            }
        }
        .navigationTitle("直连模型")
        .navigationBarTitleDisplayMode(.inline)
        .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always),
                    prompt: "Search model, ID or provider")
    }

    private var defaultChoice: some View {
        Button { select("") } label: {
            HStack {
                Text("跟默认模型分组走")
                    .foregroundStyle(.primary)
                Spacer(minLength: 8)
                if entryId.isEmpty {
                    Image(systemName: "checkmark")
                        .foregroundStyle(Color.accentColor)
                        .accessibilityHidden(true)
                }
            }
            .contentShape(Rectangle())
        }
        .accessibilityAddTraits(entryId.isEmpty ? .isSelected : [])
    }

    private func candidateChoice(_ candidate: WatchStandalone.Candidate) -> some View {
        Button { select(candidate.id) } label: {
            HStack(spacing: 12) {
                VStack(alignment: .leading, spacing: 3) {
                    Text(candidate.modelName).foregroundStyle(.primary)
                    Text(candidate.providerName).font(.subheadline).foregroundStyle(.secondary)
                    Text(WatchModelSearch.modelID(candidate)).font(.caption).foregroundStyle(.secondary)
                }
                Spacer(minLength: 8)
                if candidate.id == entryId {
                    Image(systemName: "checkmark")
                        .foregroundStyle(Color.accentColor)
                        .accessibilityHidden(true)
                }
            }
            .contentShape(Rectangle())
        }
        .accessibilityAddTraits(candidate.id == entryId ? .isSelected : [])
    }

    private func select(_ id: String) {
        if entryId != id { entryId = id }
        dismiss()
    }
}

private enum WatchModelSearch {
    static func results(_ candidates: [WatchStandalone.Candidate], query: String) -> [WatchStandalone.Candidate] {
        candidates.filter { candidate in
            ModelCatalog.matches(query, text: [candidate.modelName, candidate.providerName, modelID(candidate)].joined(separator: " "))
        }
    }

    static func modelID(_ candidate: WatchStandalone.Candidate) -> String {
        // Entry identity is providerInstanceId/baseModel.id; model IDs may contain slashes.
        candidate.id.split(separator: "/", maxSplits: 1).last.map(String.init) ?? candidate.id
    }
}
