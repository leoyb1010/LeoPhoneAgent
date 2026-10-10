//
//  SkillDraftEditorView.swift
//  MinisApp
//
//  [E2] 从对话生成的技能草稿:预填名称、触发场景、步骤,改好后保存进技能库(与导入的技能同一格式)。
//

import SwiftUI

struct SkillDraftEditorView: View {
    let onSaved: (String) -> Void

    @Environment(\.dismiss) private var dismiss
    @ObservedObject private var store = SkillStore.shared
    @State private var name: String
    @State private var trigger: String
    @State private var stepsText: String
    @State private var error: String?
    @State private var confirmOverwrite = false

    init(draft: SkillDraft, onSaved: @escaping (String) -> Void) {
        self.onSaved = onSaved
        _name = State(initialValue: draft.name)
        _trigger = State(initialValue: draft.trigger)
        _stepsText = State(initialValue: draft.stepsEditorText)
    }

    private var edited: SkillDraft {
        SkillDraft(name: SkillDraft.slug(name), trigger: trigger.trimmingCharacters(in: .whitespacesAndNewlines),
                   steps: SkillDraft.steps(fromEditorText: stepsText))
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("技能名", text: $name)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .accessibilityIdentifier("skillDraft.name")
                } header: {
                    Text("名称")
                } footer: {
                    Text("保存为「\(edited.name.isEmpty ? "…" : edited.name)」。只用小写字母、数字和短横线。")
                }
                Section {
                    TextField("什么时候用这个技能", text: $trigger, axis: .vertical)
                        .lineLimit(2...4)
                } header: {
                    Text("触发场景")
                } footer: {
                    Text("Agent 根据这句话判断什么时候调用它。")
                }
                Section {
                    TextField("一行一步", text: $stepsText, axis: .vertical)
                        .lineLimit(4...14)
                } header: {
                    Text("步骤")
                }
                if let error {
                    Section { Text(error).foregroundStyle(.red).font(.footnote) }
                }
            }
            .navigationTitle("从这次对话生成技能")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("保存") {
                        if store.skills.contains(where: { $0.id == SkillStore.slugify(edited.name) }) {
                            confirmOverwrite = true
                        } else {
                            save()
                        }
                    }
                    .disabled(!edited.canSave)
                    .accessibilityIdentifier("skillDraft.save")
                }
            }
            .confirmationDialog("已有同名技能", isPresented: $confirmOverwrite, titleVisibility: .visible) {
                Button("覆盖它", role: .destructive) { save() }
                Button("取消", role: .cancel) {}
            } message: {
                Text("保存会替换技能库里的「\(edited.name)」。想保留原来的，先改个名字。")
            }
        }
    }

    private func save() {
        do {
            // An existing name was confirmed through the overwrite dialog.
            let skill = try store.importSkill(content: edited.skillMD, source: .session, replace: true)
            LeoHaptics.notification(.success)
            onSaved(skill.name)
            dismiss()
        } catch {
            self.error = "保存失败：\(error.localizedDescription)"
            LeoHaptics.notification(.error)
        }
    }
}
