import SwiftUI

/// Provider provenance is separate from a user's favorites and routing groups.
/// No credential UI or API calls live in this catalog surface.
struct ProviderModelCatalogView: View {
    let instanceId: String
    var onEdit: (ModelEntry) -> Void
    var onAddCustom: () -> Void
    @ObservedObject private var store = ProviderConfigStore.shared
    @ObservedObject private var pins = ModelPinStore.shared
    @State private var query = ""
    @State private var filter: CatalogFilter = .all
    @State private var organizing = false
    @State private var selectedIds: Set<String> = []
    @State private var showHideConfirmation = false
    @State private var showGroupPicker = false
    @State private var showNewGroup = false
    @State private var createAfterDismiss = false
    @State private var newGroupName = ""
    @State private var message: String?
    @State private var pendingDelete: ModelEntry?

    private enum CatalogFilter: String, CaseIterable {
        case all, visible, hidden, favorites
        var title: LocalizedStringKey {
            switch self {
            case .all: return "All models"
            case .visible: return "Visible"
            case .hidden: return "Hidden"
            case .favorites: return "Favorites"
            }
        }
    }
    private var entries: [ModelEntry] {
        ModelCatalog.entries(store.entries(for: instanceId), providerOrder: [instanceId])
    }
    private var visibleEntries: [ModelEntry] {
        entries.filter { entry in
            let passes: Bool
            switch filter {
            case .all: passes = true
            case .visible: passes = !entry.isHidden
            case .hidden: passes = entry.isHidden
            case .favorites: passes = pins.isPinned(entry.id)
            }
            return passes && ModelCatalog.matches(query, entry: entry, providerLabel: store.instance(for: instanceId)?.label ?? "")
        }
    }
    private var selectedEntries: [ModelEntry] { entries.filter { selectedIds.contains($0.id) } }

    var body: some View {
        List {
            Section {
                Text("Imported catalog: \(entries.count) models").font(.headline)
                Text("Keep everyday models in Favorites. Use groups only when you want ordered fallback or load balancing.")
                    .font(.footnote).foregroundStyle(.secondary)
                Picker("Show", selection: $filter) {
                    ForEach(CatalogFilter.allCases, id: \.self) { Text($0.title).tag($0) }
                }
                .accessibilityIdentifier("model-catalog.filter")
            }
            if organizing { organizationSection }
            Section {
                if visibleEntries.isEmpty {
                    ContentUnavailableView("No matching models", systemImage: "magnifyingglass",
                        description: Text("Change the filter or search by model name, ID or provider."))
                }
                ForEach(visibleEntries) { entry in catalogRow(entry) }
            } header: { Text("\(visibleEntries.count) models shown") }
        }
        .searchable(text: $query, prompt: "Search model, ID or provider")
        .scrollDismissesKeyboard(.interactively)
        .navigationTitle(store.instance(for: instanceId)?.label ?? String(localized: "Models"))
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button(organizing ? "Done" : "Organize") {
                    organizing.toggle()
                    if !organizing { selectedIds.removeAll() }
                }.accessibilityIdentifier("model-catalog.organize")
            }
            ToolbarItem(placement: .secondaryAction) {
                Button(action: onAddCustom) { Label("Add Custom Model", systemImage: "plus") }
            }
        }
        .confirmationDialog("Hide selected models?", isPresented: $showHideConfirmation, titleVisibility: .visible) {
            Button("Hide selected models", role: .destructive) {
                if store.setEntriesHidden(ids: selectedIds, hidden: true) { selectedIds.removeAll() }
                else { message = String(localized: "Could not save model changes. Your previous configuration was kept. Try again.") }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Hidden models disappear from model selection and chat-group fallback. Saved direct-chat and voice bindings remain. Favorites and group membership are preserved; show the models again to restore availability.")
        }
        .confirmationDialog("Delete Model", isPresented: Binding(
            get: { pendingDelete != nil }, set: { if !$0 { pendingDelete = nil } }
        ), titleVisibility: .visible) {
            Button("Delete", role: .destructive) {
                if let entry = pendingDelete {
                    if store.removeEntry(entry.id) { selectedIds.remove(entry.id) }
                    else { message = String(localized: "Could not save model changes. Your previous configuration was kept. Try again.") }
                }
                pendingDelete = nil
            }
            Button("Cancel", role: .cancel) { pendingDelete = nil }
        } message: {
            Text("This removes the model and its saved group references. To temporarily remove it from selection, use Hide instead.")
        }
        .sheet(isPresented: $showGroupPicker, onDismiss: {
            if createAfterDismiss { createAfterDismiss = false; showNewGroup = true }
        }) {
            NavigationStack {
                List {
                    Section {
                        Text("Adds selected models to the end of a routing group. Existing priority and defaults stay unchanged.")
                            .font(.footnote).foregroundStyle(.secondary)
                    }
                    ForEach(store.modelGroups) { group in
                        Button(group.name) { addSelected(to: group); showGroupPicker = false }
                    }
                    Button { createAfterDismiss = true; showGroupPicker = false } label: {
                        Label("New Group", systemImage: "plus")
                    }
                }
                .navigationTitle("Add to group")
                .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { showGroupPicker = false } } }
            }
        }
        .alert("New Group", isPresented: $showNewGroup) {
            TextField("Group name", text: $newGroupName)
            Button("Create") { createGroup() }
                .disabled(newGroupName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            Button("Cancel", role: .cancel) {}
        } message: { Text("Selected models are added in catalog order. You can reorder priority in the group.") }
        .alert("Model organization", isPresented: Binding(get: { message != nil }, set: { if !$0 { message = nil } })) {
            Button("OK", role: .cancel) { message = nil }
        } message: { Text(message ?? "") }
    }

    private var organizationSection: some View {
        Section {
            Text("\(selectedEntries.count) selected").font(.headline)
            Button("Select shown models") { selectedIds.formUnion(visibleEntries.map(\.id)) }
                .disabled(visibleEntries.isEmpty)
            Button("Clear selection") { selectedIds.removeAll() }.disabled(selectedIds.isEmpty)
            Button("Add to group") { showGroupPicker = true }.disabled(selectedEntries.isEmpty)
            Button("Show selected models") {
                if store.setEntriesHidden(ids: selectedIds, hidden: false) { selectedIds.removeAll() }
                else { message = String(localized: "Could not save model changes. Your previous configuration was kept. Try again.") }
            }.disabled(selectedEntries.isEmpty)
            Button("Hide selected models", role: .destructive) { showHideConfirmation = true }
                .disabled(selectedEntries.isEmpty)
        } header: { Text("Organize selected models") }
        footer: { Text("Selection is kept when you change the search or filter. Nothing changes until you choose an action.") }
    }

    private func catalogRow(_ entry: ModelEntry) -> some View {
        HStack(spacing: 8) {
            Button {
                if organizing {
                    if selectedIds.contains(entry.id) { selectedIds.remove(entry.id) }
                    else { selectedIds.insert(entry.id) }
                } else { onEdit(entry) }
            } label: {
                HStack(spacing: 10) {
                    if organizing {
                        Image(systemName: selectedIds.contains(entry.id) ? "checkmark.circle.fill" : "circle")
                            .foregroundStyle(.tint)
                    }
                    VStack(alignment: .leading, spacing: 4) {
                        Text(entry.model.displayName).font(.body).foregroundStyle(.primary)
                            .fixedSize(horizontal: false, vertical: true)
                        Text(entry.model.id).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                        if entry.isHidden { Label("Hidden", systemImage: "eye.slash").font(.caption).foregroundStyle(.secondary) }
                        if entry.isCustom { Text("Custom").font(.caption).foregroundStyle(.orange) }
                    }
                    Spacer(minLength: 0)
                    if !organizing { Image(systemName: "chevron.right").font(.caption).foregroundStyle(.secondary) }
                }.frame(minHeight: 44).contentShape(Rectangle())
            }
            .buttonStyle(.borderless)
            .accessibilityIdentifier("model-catalog.entry.\(entry.id)")
            Button {
                if !pins.toggle(entry.id) { message = String(localized: "Favorites are full") }
            } label: {
                Image(systemName: pins.isPinned(entry.id) ? "star.fill" : "star")
                    .foregroundStyle(pins.isPinned(entry.id) ? Color.orange : Color.secondary)
                    .frame(minWidth: 44, minHeight: 44).contentShape(Rectangle())
            }
            .buttonStyle(.borderless)
            .accessibilityLabel(Text(pins.isPinned(entry.id) ? "Remove from favorites" : "Add to favorites"))
            .accessibilityValue(entry.model.displayName)
            .accessibilityIdentifier("model-catalog.favorite.\(entry.id)")
        }
        .contextMenu {
            Button("Edit model") { onEdit(entry) }
            Button("Delete Model", role: .destructive) { pendingDelete = entry }
        }
    }

    private func addSelected(to captured: ModelGroup) {
        guard var group = store.group(for: captured.id) else { return }
        for entry in selectedEntries where !group.memberEntryIds.contains(entry.id) { group.memberEntryIds.append(entry.id) }
        store.updateGroup(group)
        selectedIds.removeAll()
        message = String(localized: "Models added. Review their priority in Groups.")
    }

    private func createGroup() {
        let name = newGroupName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty, !selectedEntries.isEmpty else { return }
        store.addGroup(ModelGroup(name: name, memberEntryIds: selectedEntries.map(\.id)))
        selectedIds.removeAll()
        newGroupName = ""
        message = String(localized: "Group created. Your default stays the same.")
    }
}

/// A real management destination, also used by Home's “Manage models” action.
/// Reopening management never repeats onboarding or creates duplicate defaults.
struct ModelLibraryView: View {
    @ObservedObject private var store = ProviderConfigStore.shared
    @ObservedObject private var pins = ModelPinStore.shared
    @State private var editingEntry: ModelEntry?
    @State private var addingInstanceId: String?
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        List {
            Section {
                NavigationLink { ModelGroupsView() } label: {
                    Label("Groups and defaults", systemImage: "square.stack.3d.up")
                }
                Text("Favorites are shared with the model picker. Provider catalogs stay separate from routing groups.")
                    .font(.footnote).foregroundStyle(.secondary)
            }
            Section("Provider catalogs") {
                ForEach(store.instances) { instance in
                    NavigationLink {
                        ProviderModelCatalogView(instanceId: instance.id,
                            onEdit: { editingEntry = $0 }, onAddCustom: { addingInstanceId = instance.id })
                    } label: {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(instance.label)
                            Text("\(store.entries(for: instance.id).count) models").font(.caption).foregroundStyle(.secondary)
                            if !instance.isEnabled { Text("Provider disabled").font(.caption).foregroundStyle(.orange) }
                        }
                    }
                }
            }
            if store.instances.isEmpty {
                ContentUnavailableView("No models available", systemImage: "cpu",
                    description: Text("Configure providers in Settings to see models here."))
            }
        }
        .navigationTitle("Model Library")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } } }
        .sheet(item: $editingEntry) { ModelEntryDetailSheet(entry: $0) }
        .sheet(isPresented: Binding(get: { addingInstanceId != nil }, set: { if !$0 { addingInstanceId = nil } })) {
            if let id = addingInstanceId { AddCustomModelSheet(instanceId: id) }
        }
    }
}
