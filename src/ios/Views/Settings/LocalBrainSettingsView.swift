//
//  LocalBrainSettingsView.swift
//  MinisApp
//
//  [T-local-brain] 本机模型的状态与去向。
//
//  这页存在的理由是"可解释":本机模型能不能用取决于设备、系统开关、
//  模型下载状态好几件事,不告诉用户就成了"有时有有时没有"的玄学功能。
//  这里把当前状态、原因、以及它到底在哪些地方生效讲清楚。
//

import SwiftUI

struct LocalBrainSettingsView: View {
    @StateObject private var brain = LocalBrain.shared
    @State private var probe = ""
    @State private var probeResult: String?
    @State private var probing = false
    @AppStorage(FollowUpSuggestionPolicy.enabledKey) private var followUpsEnabled = true
    /// [WP-45] External stand-in model (ModelEntry id; "" = none).
    @AppStorage(ExternalBrainPreference.entryKey) private var externalEntryId = ""
    @ObservedObject private var store = ProviderConfigStore.shared

    /// Entries whose provider has a custom (OpenAI-compatible) base URL.
    private var externalCandidates: [ModelEntry] {
        store.modelEntries.filter { entry in
            !entry.isHidden && store.instance(for: entry.providerInstanceId)?.effectiveCustomBaseURL != nil
        }
    }

    var body: some View {
        List {
            Section {
                HStack(spacing: 10) {
                    Image(systemName: brain.isReady ? "checkmark.circle.fill" : "exclamationmark.circle.fill")
                        .foregroundStyle(brain.isReady ? .green : .orange)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(brain.statusText).font(.system(size: 15, weight: .medium))
                        if !brain.isReady {
                            Text(hint).font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }
            } header: {
                Text("状态")
            } footer: {
                Text("本机模型跑在这台设备上,内容不离本机;它不可用时,下面这些功能会自动回落到原来的方式,不会消失。")
            }

            // [WP-45] Foundation Models 27 `LanguageModel`: when Apple's on-device model is
            // unavailable, run on an OpenAI-compatible model the user configured (e.g. the
            // Mac subscription proxy). Opt-in, because content then leaves the device.
            Section {
                Picker("本机不可用时改用", selection: $externalEntryId) {
                    Text("不改用(只用本机)").tag("")
                    ForEach(externalCandidates, id: \.id) { entry in
                        Text(entry.model.displayName).tag(entry.id)
                    }
                }
            } header: {
                Text("外部模型")
            } footer: {
                Text("只列出你配置了自定义地址的 OpenAI 兼容模型(比如 Mac 上的订阅代理)。选了之后,本机模型不可用时「改写」「语音任务整理」等会把内容发给这个模型;「回复后建议追问」、离线问图片和离线找会话仍然只用本机模型。")
            }

            Section("它在这些地方生效") {
                row("收藏自动摘要与标签", "star.square.on.square",
                    "新收藏补抓封面时顺手生成一句话摘要,回头翻收藏不用点开")
                row("输入框改写", "wand.and.stars",
                    "输入框上方的「改写」:润色、精简、翻译、语气转换,全程离线")
                row("语音任务整理", "mic.fill",
                    "用 Siri 指挥 Mac 时,把口述的流水话整理成标题 + 要点再下发")
                row("会话标题与分类", "textformat",
                    "新会话的标题和类别先由本机生成,只看首轮提问和回复开头;不合格时才交给云端模型")
                row("回复后建议追问", "text.bubble",
                    "回复结束后在输入框上方给出最多 3 个追问,点一下填进输入框")
            }

            Section {
                Toggle("回复后建议追问", isOn: $followUpsEnabled)
            } footer: {
                Text("只用本机模型,不联网。点建议只会填进输入框,不会自动发送;本机模型不可用、后台任务和子代理会话里不显示。")
            }

            Section {
                TextField("输入一句话试试改写…", text: $probe, axis: .vertical)
                    .lineLimit(1...4)
                Button {
                    runProbe()
                } label: {
                    Label(probing ? "处理中…" : "本机润色一下", systemImage: "sparkles")
                }
                .disabled(!brain.isReady || probing ||
                          probe.trimmingCharacters(in: .whitespaces).isEmpty)
                if let probeResult {
                    Text(probeResult)
                        .font(.system(size: 14))
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                }
            } header: {
                Text("自检")
            } footer: {
                Text("能出结果就说明本机模型确实在工作。")
            }
        }
        .navigationTitle("本机模型")
        .navigationBarTitleDisplayMode(.inline)
    }

    private var hint: String {
        switch brain.availability {
        case .notEnabled:
            return "系统设置 → Apple 智能与 Siri,打开后即可使用"
        case .modelNotReady:
            return "系统正在下载模型,连着 Wi-Fi 稍等一会儿再来看"
        case .unsupportedDevice:
            return "需要支持 Apple 智能的机型"
        case .unavailableOnOS:
            return "需要更新的系统版本"
        case .ready:
            return ""
        }
    }

    private func row(_ title: String, _ icon: String, _ detail: String) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: icon)
                .font(.system(size: 12))
                .foregroundStyle(.pink)
                .frame(width: 22)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.system(size: 15))
                Text(detail).font(.caption).foregroundStyle(.secondary)
            }
        }
    }

    private func runProbe() {
        probing = true
        probeResult = nil
        Task {
            let out = await LocalBrain.shared.rewrite(probe, style: .polish)
            await MainActor.run {
                probing = false
                probeResult = out ?? "本机模型没有返回结果(可用性可能刚刚变化)。"
            }
        }
    }
}
