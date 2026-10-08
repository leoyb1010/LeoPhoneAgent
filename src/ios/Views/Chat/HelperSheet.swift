import SwiftUI

// [T-subagent] Detail sheet for a sub agent: the task, its result and a
// read-only transcript of the hidden child session, loaded straight from the
// database (the child never opens in a normal chat screen, so it cannot be
// handed off, shared to Paperclip or continued by hand).

struct HelperSheet: View {
    @ObservedObject var block: AssistantBlock
    var childSessionIdOverride: String? = nil
    @Environment(\.dismiss) private var dismiss
    @State private var transcript: [TranscriptLine] = []
    @State private var loaded = false

    struct TranscriptLine: Identifiable {
        let id = UUID()
        let role: String
        let text: String
    }

    var body: some View {
        let info = HelperBlockInfo(block: block)
        let childId = childSessionIdOverride ?? info.childSessionId
        NavigationStack {
            List {
                Section(String(localized: "任务")) {
                    Text(info.title).font(.body.weight(.semibold))
                    if let task = AIChatViewModel.subAgentInputArgs(block)["task"] as? String, !task.isEmpty {
                        Text(task).font(.callout).foregroundStyle(.secondary).textSelection(.enabled)
                    }
                    LabeledContent(String(localized: "子代理"), value: info.agent ?? SubAgentDefinition.builtInName)
                    if let model = info.modelLabel { LabeledContent(String(localized: "模型"), value: model) }
                    LabeledContent(String(localized: "状态"), value: AgentCallback.localizedStatus(info.status))
                }
                if let result = info.result, !result.isEmpty {
                    Section(String(localized: "结果")) {
                        Text(result).font(.callout).textSelection(.enabled)
                    }
                } else if info.isControlOnly, !block.content.isEmpty {
                    Section(String(localized: "返回")) {
                        Text(block.content).font(.caption.monospaced()).textSelection(.enabled)
                    }
                }
                if childId != nil {
                    Section(String(localized: "子代理对话（只读）")) {
                        if !loaded {
                            ProgressView()
                        } else if transcript.isEmpty {
                            Text(String(localized: "还没有内容")).foregroundStyle(.secondary)
                        } else {
                            ForEach(transcript) { line in
                                VStack(alignment: .leading, spacing: 4) {
                                    Text(line.role).font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                                    Text(line.text).font(.callout).textSelection(.enabled)
                                }
                                .padding(.vertical, 2)
                            }
                        }
                    }
                }
            }
            .navigationTitle(String(localized: "子代理"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button(String(localized: "完成")) { dismiss() }
                }
            }
            .task(id: childId) { await load(childId) }
        }
    }

    private func load(_ childId: String?) async {
        defer { loaded = true }
        guard let childId else { return }
        let raws = await ChatStore.shared.loadMessages(sessionId: childId)
        var lines: [TranscriptLine] = []
        for raw in raws {
            var parts: [String] = []
            for part in raw.parts {
                switch part {
                case .text(let t):
                    let clean = RawMessage.stripSystemReminders(t).trimmingCharacters(in: .whitespacesAndNewlines)
                    if !clean.isEmpty { parts.append(clean) }
                case .toolUse(let tu):
                    parts.append("→ \(tu.name)" + (tu.description.map { " · \($0)" } ?? ""))
                case .toolResult(let tr):
                    let head = tr.output.prefix(300)
                    if !head.isEmpty { parts.append("← " + head + (tr.output.count > 300 ? "…" : "")) }
                case .mediaRef:
                    parts.append(String(localized: "[图片]"))
                }
            }
            guard !parts.isEmpty else { continue }
            let role = raw.role == .assistant ? String(localized: "子代理") : String(localized: "输入 / 工具结果")
            lines.append(TranscriptLine(role: role, text: parts.joined(separator: "\n")))
        }
        transcript = lines
    }
}
