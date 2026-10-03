import SwiftUI

/// Onboarding step 2: pick one or more models from all configured providers and create a "Default Models" group.
struct OnboardingModelSelectionView: View {
    @ObservedObject private var store = ProviderConfigStore.shared
    @Environment(\.dismiss) private var dismiss

    @State private var selectedModelEntryIds: [String] = []
    @State private var searchText: String = ""
    @State private var saveFailed = false

    /// All visible model entries across all enabled instances.
    private var allEntries: [ModelEntry] {
        store.instances
            .filter(\.isEnabled)
            .flatMap { store.visibleEntries(for: $0.id) }
            .filter { entry in
                guard ModelSwitcher.isAvailable(entry, store: store) else { return false }
                let modalities = entry.model.modalityOverride ?? entry.model.capabilities.supportedModalities
                return !modalities.contains(.imageOutput) && !modalities.contains(.audioOutput)
                    && !modalities.contains(.videoOutput)
            }
    }

    var body: some View {
        List {
            if allEntries.isEmpty {
                Section {
                    HStack {
                        Spacer()
                        VStack(spacing: 8) {
                            Image(systemName: "cpu").font(.title)
                            Text("No models available")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        Spacer()
                    }
                    .padding(.vertical, 8)
                } header: {
                    Text("Models")
                } footer: {
                    Text("Configure providers in Settings to see models here.")
                }
            } else {
                // Group entries by provider instance
                let instanceIds = store.instances.filter(\.isEnabled).map(\.id)
                ForEach(instanceIds, id: \.self) { instanceId in
                    let entries = allEntries.filter { $0.providerInstanceId == instanceId }.filter { entry in
                        ModelCatalog.matches(searchText, entry: entry, providerLabel: store.instance(for: instanceId)?.label ?? "")
                    }
                    if !entries.isEmpty, let instance = store.instance(for: instanceId) {
                        Section {
                            ForEach(entries) { entry in
                                modelRow(entry: entry)
                            }
                        } header: {
                            Text(instance.label)
                        }
                    }
                }

            }
        }

        .alert("Model organization", isPresented: $saveFailed) {
            Button("OK", role: .cancel) {}
        } message: {
            Text("Could not save model changes. Your previous configuration was kept. Try again.")
        }
        .searchable(text: $searchText, prompt: "Filter models")
        .navigationTitle("Select Models")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Button("Skip") { dismiss() }
            }
            ToolbarItem(placement: .topBarTrailing) {
                Button("Next") { createGroupAndDismiss() }
                    .disabled(selectedModelEntryIds.isEmpty)
            }
        }
    }

    @ViewBuilder
    private func modelRow(entry: ModelEntry) -> some View {
        let selectionIndex = selectedModelEntryIds.firstIndex(of: entry.id)
        let isSelected = selectionIndex != nil

        Button {
            if let idx = selectionIndex {
                selectedModelEntryIds.remove(at: idx)
            } else {
                selectedModelEntryIds.append(entry.id)
            }
        } label: {
            HStack(spacing: 12) {
                ZStack {
                    Circle()
                        .fill(isSelected ? Color.accentColor : Color(UIColor.tertiarySystemFill))
                        .frame(width: 26, height: 26)
                    if isSelected, let idx = selectionIndex {
                        Text("\(idx + 1)")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.white)
                    }
                }
                Text(entry.model.displayName)
                    .font(.body)
                    .foregroundStyle(Color(UIColor.label))
                Spacer()
            }
        }
    }

    private func createGroupAndDismiss() {
        let validIds = selectedModelEntryIds.filter { id in allEntries.contains { $0.id == id } }
        guard !validIds.isEmpty else { return }
        if let existing = store.modelGroups.first(where: { $0.memberEntryIds == validIds && $0.strategy == .fallback }) {
            if store.defaultPrimaryGroupId == nil {
                store.defaultPrimaryGroupId = existing.id
                guard store.defaultPrimaryGroupId == existing.id else { saveFailed = true; return }
            }
            dismiss()
            return
        }
        let base = String(localized: "Default Models")
        var name = base
        var suffix = 2
        while store.modelGroups.contains(where: { $0.name == name }) { name = "\(base) \(suffix)"; suffix += 1 }
        let group = ModelGroup(
            name: name,
            memberEntryIds: validIds,
            strategy: .fallback
        )
        guard store.addGroup(group) else { saveFailed = true; return }
        if store.defaultPrimaryGroupId == nil {
            store.defaultPrimaryGroupId = group.id
            guard store.defaultPrimaryGroupId == group.id else { saveFailed = true; return }
        }
        dismiss()
    }
}
