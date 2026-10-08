import SwiftUI

// [T-subagent] Settings › 子代理: the on/off switch and the custom roles
// (ported from upstream iOS 1.14 `HelperSettingsView`, roster editing only).
// A role is name + description (what the main model reads to pick it) +
// instructions (appended to the child's brief) + model group (Auto = the
// delegating model chooses) + thinking level (inherit by default). At most
// `SubAgentLimits.maxCount` including the built-in general agent.

struct HelperSettingsView: View {
    @ObservedObject private var store = SubAgentStore.shared
    @State private var enabled = SubAgentSettings.isEnabled
    @State private var editing: SubAgentDefinition?
    @State private var isAdding = false

    var body: some View {
        List {
            Section {
                Toggle(String(localized: "允许 Agent 委派子代理"), isOn: $enabled)
                    .onChange(of: enabled) { _, v in SubAgentSettings.isEnabled = v }
            } footer: {
                Text(String(localized: "开启后,Agent 可以把独立的大任务交给后台子代理并行完成(最多同时 3 个),完成后结果自动回到对话里。子代理不出现在会话列表、不同步到 iCloud、不读写记忆;它要执行敏感操作时,仍在本对话里请你确认。"))
            }

            Section {
                ForEach(store.subAgents) { def in
                    Button { editing = def } label: { row(def) }
                        .buttonStyle(.plain)
                        .deleteDisabled(def.isBuiltIn)
                }
                .onDelete { idx in
                    for i in idx where !store.subAgents[i].isBuiltIn { store.removeSubAgent(id: store.subAgents[i].id) }
                }
                .onMove { from, to in
                    var ids = store.subAgents.map(\.id)
                    ids.move(fromOffsets: from, toOffset: to)
                    store.reorderSubAgents(ids)
                }
                if store.canAddSubAgent {
                    Button { isAdding = true } label: {
                        Label(String(localized: "新建角色"), systemImage: "plus.circle.fill")
                    }
                    .accessibilityIdentifier("subagents.add")
                }
            } header: {
                Text(String(localized: "角色"))
            } footer: {
                Text(String(localized: "最多 \(SubAgentLimits.maxCount) 个(含通用子代理)。名称和描述每轮都会告诉 Agent,用来挑选合适的角色;说明只发给子代理本身。"))
            }
            .disabled(!enabled)
        }
        .navigationTitle(String(localized: "子代理"))
        .toolbar { EditButton() }
        .sheet(item: $editing) { def in
            NavigationStack { SubAgentEditorView(original: def) }
        }
        .sheet(isPresented: $isAdding) {
            NavigationStack { SubAgentEditorView(original: nil) }
        }
    }

    private func row(_ def: SubAgentDefinition) -> some View {
        HStack(spacing: 12) {
            Image(systemName: def.isBuiltIn ? "person.2.fill" : "person.crop.circle.badge.checkmark")
                .foregroundStyle(.tint)
                .frame(width: 24)
            VStack(alignment: .leading, spacing: 2) {
                Text(def.displayName).foregroundStyle(.primary)
                Text(def.displayDescription).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                Text(modelSummary(def)).font(.caption2).foregroundStyle(.tertiary)
            }
            Spacer(minLength: 0)
            Image(systemName: "chevron.right").font(.caption).foregroundStyle(.tertiary)
        }
        .contentShape(Rectangle())
    }

    private func modelSummary(_ def: SubAgentDefinition) -> String {
        var parts: [String] = []
        if let gid = def.modelGroupId, let g = ProviderConfigStore.shared.group(for: gid) {
            parts.append(String(localized: "模型组:\(g.name)"))
        } else {
            parts.append(String(localized: "模型:自动"))
        }
        if let lvl = def.thinkingLevelOverride { parts.append(String(localized: "推理:\(lvl.displayName)")) }
        return parts.joined(separator: " · ")
    }
}

struct SubAgentEditorView: View {
    let original: SubAgentDefinition?
    @Environment(\.dismiss) private var dismiss
    @ObservedObject private var store = SubAgentStore.shared
    @State private var name = ""
    @State private var description = ""
    @State private var instructions = ""
    @State private var groupId: String?
    @State private var thinking: ThinkingLevel?
    @State private var error: String?

    private var isBuiltIn: Bool { original?.isBuiltIn ?? false }

    var body: some View {
        Form {
            Section(String(localized: "名称与用途")) {
                if isBuiltIn {
                    LabeledContent(String(localized: "名称"), value: original?.displayName ?? "")
                    Text(original?.displayDescription ?? "").font(.callout).foregroundStyle(.secondary)
                } else {
                    TextField(String(localized: "名称(如:代码审查员)"), text: $name)
                        .onChange(of: name) { _, v in if v.count > SubAgentLimits.nameMaxLength { name = String(v.prefix(SubAgentLimits.nameMaxLength)) } }
                    TextField(String(localized: "什么时候用它(Agent 据此挑选)"), text: $description, axis: .vertical)
                        .lineLimit(2...4)
                        .onChange(of: description) { _, v in if v.count > SubAgentLimits.descriptionMaxLength { description = String(v.prefix(SubAgentLimits.descriptionMaxLength)) } }
                }
            }
            Section {
                TextField(String(localized: "给这个子代理的长期说明(可选)"), text: $instructions, axis: .vertical)
                    .lineLimit(3...10)
                    .onChange(of: instructions) { _, v in if v.count > SubAgentLimits.instructionsMaxLength { instructions = String(v.prefix(SubAgentLimits.instructionsMaxLength)) } }
            } header: {
                Text(String(localized: "说明"))
            } footer: {
                Text(String(localized: "附加在每次委派的任务说明之后,只有子代理看得到。"))
            }
            Section {
                Picker(String(localized: "模型"), selection: $groupId) {
                    Text(String(localized: "自动(由 Agent 按任务选择)")).tag(String?.none)
                    ForEach(ProviderConfigStore.shared.modelGroups) { g in
                        Text(g.name).tag(String?.some(g.id))
                    }
                }
                Picker(String(localized: "推理强度"), selection: $thinking) {
                    Text(String(localized: "跟随模型组 / 对话")).tag(ThinkingLevel?.none)
                    ForEach(ThinkingLevel.allCases.filter { $0 != .ultra }, id: \.self) { lvl in
                        Text(lvl.displayName).tag(ThinkingLevel?.some(lvl))
                    }
                }
            } header: {
                Text(String(localized: "模型"))
            } footer: {
                Text(String(localized: "固定模型组后,Agent 的模型选择对这个角色不再生效;推理强度会按所用模型的上限自动降档。"))
            }
            if let error {
                Section { Text(error).foregroundStyle(.red) }
            }
        }
        .navigationTitle(original == nil ? String(localized: "新建角色") : String(localized: "编辑角色"))
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) { Button(String(localized: "取消")) { dismiss() } }
            ToolbarItem(placement: .confirmationAction) {
                Button(String(localized: "保存")) { save() }
                    .disabled(!isBuiltIn && name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
        .onAppear {
            guard let o = original else { return }
            name = o.name
            description = o.description
            instructions = o.instructions
            groupId = o.modelGroupId
            thinking = o.thinkingLevelOverride
        }
    }

    private func save() {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        if !isBuiltIn, store.subAgentNameIsTaken(trimmed, excluding: original?.id) {
            error = String(localized: "已经有同名的角色了。")
            return
        }
        var def = original ?? SubAgentDefinition(name: trimmed, description: description)
        if !isBuiltIn {
            def.name = trimmed
            def.description = description.trimmingCharacters(in: .whitespacesAndNewlines)
        }
        def.instructions = instructions
        def.modelGroupId = groupId
        def.thinkingLevelOverride = thinking
        if store.upsertSubAgent(def) {
            dismiss()
        } else {
            error = String(localized: "没能保存:角色已满或名称无效。")
        }
    }
}
