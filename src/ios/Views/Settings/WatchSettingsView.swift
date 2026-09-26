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
    @AppStorage(WatchStandalone.modeKey) private var mode = WatchStandalone.mode.rawValue
    @AppStorage(WatchStandalone.entryKey) private var entryId = ""
    @State private var candidates: [WatchStandalone.Candidate] = []
    @State private var toolRows: [WatchStandalone.ToolRow] = []
    @State private var toolsOff: Set<String> = []

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
                    Picker("直连模型", selection: $entryId) {
                        Text("跟默认模型分组走").tag("")
                        ForEach(candidates) { candidate in
                            Text("\(candidate.modelName) · \(candidate.providerName)").tag(candidate.id)
                        }
                    }
                    .pickerStyle(.navigationLink)
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
                            get: { row.usable && !toolsOff.contains(row.id) },
                            set: { on in
                                if on { toolsOff.remove(row.id) } else { toolsOff.insert(row.id) }
                                WatchStandalone.toolsOff = toolsOff
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
                    Text("iPhone 在身边时,手表的问题交给 iPhone 上的 Leo,所有技能和工具都能用。手表自己回答时,能用这里打开的远程工具(联网搜索、地图、天气这类);要在 iPhone 本机环境里跑的技能、需要登录授权的工具只能经 iPhone。工具的地址和钥匙经加密通道存进手表自己的钥匙串。")
                }
            }

            Section {
                Button("现在同步到手表") {
                    WatchBridge.shared.syncStandaloneConfigIfNeeded(force: true)
                }
                .disabled(WatchBridge.shared.watchUnreachableReason != nil)
            } footer: {
                Text(WatchBridge.shared.watchUnreachableReason ?? "改了上面的选项会自动同步;手表暂时连不上时,下次连上自动送到。")
            }
        }
        .navigationTitle("Apple Watch")
        .navigationBarTitleDisplayMode(.inline)
        .onAppear {
            candidates = WatchStandalone.candidates()
            toolRows = WatchStandalone.toolRows()
            toolsOff = WatchStandalone.toolsOff
            // 选过的模型被删了或服务商关了:回到跟默认分组走
            if !entryId.isEmpty, !candidates.contains(where: { $0.id == entryId }) { entryId = "" }
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

    private var resolvedLine: (ok: Bool, text: String) {
        switch WatchStandalone.resolve() {
        case .success(let config): return (true, "手表会用 \(config.modelName) · \(config.providerName)")
        case .failure(let reason): return (false, reason.explanation)
        }
    }
}
