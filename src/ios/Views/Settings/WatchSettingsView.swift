//
//  WatchSettingsView.swift
//  MinisApp
//
//  [T-watch-standalone] 设置 → Apple Watch:手表怎么回答、直连时用哪个模型。
//  改完立刻经 WatchConnectivity 发给手表(API Key 进手表自己的钥匙串)。
//

import SwiftUI

struct WatchSettingsView: View {
    @AppStorage(WatchStandalone.modeKey) private var mode = WatchStandalone.mode.rawValue
    @AppStorage(WatchStandalone.entryKey) private var entryId = ""
    @State private var candidates: [WatchStandalone.Candidate] = []

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
            return "手表总是自己直连下面的模型,不等 iPhone,蜂窝网络下也一样;只有对话,不能用工具。"
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
