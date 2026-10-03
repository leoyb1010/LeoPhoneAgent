import SwiftUI

// MARK: - GroupSlotPicker
//
// A single "slot → model group" selector used for Default Primary / Default Sub
// / Voice Input / Voice Output. Shows the current group via a Menu listing all
// groups + None, plus a "Create new group from models…" action that opens the
// unified model picker in multi-select mode, builds a ModelGroup from the chosen
// entries, and assigns it to this slot.

struct GroupSlotPicker: View {
    @ObservedObject private var store = ProviderConfigStore.shared
    let label: LocalizedStringKey
    @Binding var selection: String?
    var voiceDirection: VoiceDirection? = nil

    @State private var showCreate = false
    @State private var saveFailed = false
    @State private var pendingCreatedGroupId: String?

    private var selectedName: String {
        if let id = selection {
            return store.group(for: id)?.name ?? String(localized: "Unavailable group")
        }
        return String(localized: "None", comment: "No group selected")
    }

    var body: some View {
        Menu {
            Picker(selection: Binding(get: { selection }, set: { value in
                selection = value
                if selection != value { saveFailed = true }
            })) {
                Text("None", comment: "No group selected").tag(String?.none)
                ForEach(store.modelGroups) { group in
                    Text(group.name).tag(Optional(group.id)).disabled(!isEligible(group))
                }
            } label: { EmptyView() }

            Divider()
            Button {
                showCreate = true
            } label: {
                Label("Create group from models…", systemImage: "plus.rectangle.on.folder")
            }
        } label: {
            HStack {
                Text(label)
                    .foregroundStyle(Color(UIColor.label))
                Spacer()
                Text(selectedName)
                    .foregroundStyle(.secondary)
                Image(systemName: "chevron.up.chevron.down")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
        }

        .alert("Model organization", isPresented: $saveFailed) {
            Button("OK", role: .cancel) {}
        } message: {
            Text("Could not save model changes. Your previous configuration was kept. Try again.")
        }
        .sheet(isPresented: $showCreate) {
            NavigationStack {
                UnifiedModelPicker(config: createGroupConfig())
            }
        }
    }

    private func canAssign(_ entry: ModelEntry, direction: VoiceDirection?) -> Bool {
        let system = VoiceProviderResolver.isSystemEntry(entry.providerInstanceId)
        guard system || ModelSwitcher.isAvailable(entry, store: store) else { return false }
        let modalities = entry.model.modalityOverride ?? entry.model.capabilities.supportedModalities
        if let direction {
            return direction.isVoiceModel(entry.model)
                || modalities.contains(direction == .input ? .audioInput : .audioOutput)
        }
        return !system && !modalities.contains(.imageOutput)
            && !modalities.contains(.audioOutput) && !modalities.contains(.videoOutput)
    }

    private func isEligible(_ group: ModelGroup) -> Bool {
        let available = group.memberEntryIds.compactMap { id -> ModelEntry? in
            guard let entry = store.entry(for: id) ?? UnifiedModelPicker.systemEntry(for: id) else { return nil }
            if VoiceProviderResolver.isSystemEntry(entry.providerInstanceId) { return voiceDirection == nil ? nil : entry }
            return ModelSwitcher.isAvailable(entry, store: store) ? entry : nil
        }
        guard !available.isEmpty else { return false }
        if voiceDirection != nil {
            // Voice resolution filters by direction before routing.
            return available.contains { canAssign($0, direction: voiceDirection) }
        }
        // Every possible routed member must fit this purpose, including later
        // fallback members. Existing incompatible assignments stay visible.
        return available.allSatisfy { canAssign($0, direction: voiceDirection) }
    }

    @MainActor
    private func createGroupConfig() -> ModelPickerConfig {
        let dir = voiceDirection
        let assign: (String) -> Void = { selection = $0 }
        return ModelPickerConfig(
            title: "Create Group",
            mode: .multi,
            explicitPreferModality: dir.map { $0 == .input ? [.audioInput] : [.audioOutput] },
            groupScope: .none,
            candidateFilter: { entry in canAssign(entry, direction: dir) },
            headerNote: dir?.filterNote,
            onAddOrdered: { ids in
                guard !ids.isEmpty else { return false }
                let store = ProviderConfigStore.shared
                let group: ModelGroup
                if let id = pendingCreatedGroupId, let saved = store.group(for: id), saved.memberEntryIds == ids {
                    group = saved
                } else {
                    group = ModelGroup(name: Self.suggestedName(for: dir, store: store), memberEntryIds: ids)
                    guard store.addGroup(group) else { return false }
                    pendingCreatedGroupId = group.id
                }
                assign(group.id)
                guard selection == group.id else { return false }
                pendingCreatedGroupId = nil
                return true
            }
        )
    }

    private static func suggestedName(for dir: VoiceDirection?, store: ProviderConfigStore) -> String {
        let base: String
        switch dir {
        case .input:  base = String(localized: "Voice Input", comment: "Default voice input group name")
        case .output: base = String(localized: "Voice Output", comment: "Default voice output group name")
        case nil:     base = String(localized: "New Group", comment: "Default group name")
        }
        let existing = Set(store.modelGroups.map(\.name))
        if !existing.contains(base) { return base }
        var n = 2
        while existing.contains("\(base) \(n)") { n += 1 }
        return "\(base) \(n)"
    }
}
