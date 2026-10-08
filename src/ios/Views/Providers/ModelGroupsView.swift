import SwiftUI

/// Lists all model groups with default badges, and allows creating new groups.
struct ModelGroupsView: View {
    @ObservedObject private var store = ProviderConfigStore.shared
    @State private var showCreateGroup = false
    @State private var saveFailed = false
    @State private var newGroupName = ""
    @State private var showAddAgentModels = false
    @State private var showAddAgentGroups = false
    @State private var forceSyncToast: String?
    @AppStorage("cloudSync.v2.enabled") private var iCloudSyncEnabled: Bool = false

    var body: some View {
        List {
            if store.modelGroups.isEmpty {
                Section {
                    VStack(spacing: 8) {
                        Image(systemName: "square.stack.3d.up")
                            .font(.system(size: 32))
                            .foregroundStyle(.quaternary)
                        Text("No model groups")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                        Text("Groups let you combine models for fallback or load balancing.")
                            .font(.caption)
                            .foregroundStyle(.tertiary)
                            .multilineTextAlignment(.center)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 20)
                }
            }

            if !store.modelGroups.isEmpty {
                Section {
                    ForEach(store.modelGroups) { group in
                        NavigationLink {
                            ModelGroupDetailView(groupId: group.id)
                        } label: {
                            GroupRow(group: group)
                        }
                    }
                    .onMove(perform: moveGroups)
                    .onDelete(perform: deleteGroups)
                } header: {
                    HStack {
                        Text("Groups")
                        Spacer()
                        EditButton()
                            .font(.caption)
                            .textCase(nil)
                    }
                }
            }

            // Default assignments
            if !store.modelGroups.isEmpty {
                Section {
                    GroupSlotPicker(
                        label: "Default Primary",
                        selection: Binding(
                            get: { store.defaultPrimaryGroupId },
                            set: { store.defaultPrimaryGroupId = $0 }
                        )
                    )
                    GroupSlotPicker(
                        label: "Default Sub",
                        selection: Binding(
                            get: { store.defaultSubGroupId },
                            set: { store.defaultSubGroupId = $0 }
                        )
                    )
                } header: {
                    Text("Defaults for new chats")
                } footer: {
                    Text("Primary starts new chats. Sub handles lightweight tasks such as titles. Choosing a model in an existing chat does not change these defaults.")
                }
                Section {
                    GroupSlotPicker(
                        label: "Voice Input",
                        selection: Binding(
                            get: { store.voiceInputGroupId },
                            set: { store.voiceInputGroupId = $0 }
                        ),
                        voiceDirection: .input
                    )
                    GroupSlotPicker(
                        label: "Voice Output",
                        selection: Binding(
                            get: { store.voiceOutputGroupId },
                            set: { store.voiceOutputGroupId = $0 }
                        ),
                        voiceDirection: .output
                    )
                } header: {
                    Text("Voice defaults")
                } footer: {
                    Text("Voice Input and Output use the matching audio models in a group. None uses the offline System voice.")
                }
                // [T-ios-vision-group #182] Image reading for models that cannot see.
                Section {
                    VisionGroupSlotPicker()
                } header: {
                    Text("Vision Group")
                } footer: {
                    Text("When the current model cannot read images, image-capable models in this group read them on its behalf (up to 3 tried, 90 s each) and pass a description back. This device only.")
                }
            }

            // Agent Loop Models
            AgentLoopModelsSection(showAddModels: $showAddAgentModels,
                                   showAddGroups: $showAddAgentGroups)
        }
        .navigationTitle("Model Groups")
        .navigationBarTitleDisplayMode(.inline)
        .sheet(isPresented: $showAddAgentModels) {
            NavigationStack {
                UnifiedModelPicker(config: .agentLoopAddModels())
            }
        }
        .sheet(isPresented: $showAddAgentGroups) {
            NavigationStack {
                AddAgentLoopGroupsSheet()
            }
        }
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Button {
                        showCreateGroup = true
                        newGroupName = ""
                    } label: {
                        Label(String(localized: "New Group"), systemImage: "plus")
                    }
                    if #available(iOS 17.0, *), iCloudSyncEnabled {
                        Divider()
                        Button {
                            Task { await forceSyncGroups() }
                        } label: {
                            Label(String(localized: "Force iCloud Sync"),
                                  systemImage: "arrow.triangle.2.circlepath.icloud")
                        }
                    }
                } label: {
                    Image(systemName: "plus")
                }
            }
        }
        .overlay(alignment: .top) {
            if let msg = forceSyncToast {
                Text(msg)
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(.white)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 10)
                    .background(Color.accentColor, in: Capsule())
                    .padding(.top, 8)
                    .transition(.move(edge: .top).combined(with: .opacity))
            }
        }
        .animation(LeoMotion.spring(), value: forceSyncToast)

        .alert("Model organization", isPresented: $saveFailed) {
            Button("OK", role: .cancel) {}
        } message: {
            Text("Could not save model changes. Your previous configuration was kept. Try again.")
        }
        .alert("New Group", isPresented: $showCreateGroup) {
            TextField("Group name", text: $newGroupName)
            Button("Create") { createGroup() }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Enter a name for the new model group.")
        }
    }

    // MARK: - Actions

    private func createGroup() {
        let trimmed = newGroupName.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty else { return }
        let group = ModelGroup(name: trimmed, memberEntryIds: [])
        if !store.addGroup(group) { saveFailed = true }
    }

    private func deleteGroups(at offsets: IndexSet) {
        let groups = store.modelGroups
        for index in offsets where groups.indices.contains(index) {
            guard store.removeGroup(groups[index].id) else { saveFailed = true; break }
        }
    }

    private func moveGroups(from source: IndexSet, to destination: Int) {
        let ids = store.modelGroups.map(\.id)
        let ordered = ModelCatalog.reorderedKeys(ids, visibleKeys: ids, from: source, to: destination)
        if !store.reorderGroups(ordered) { saveFailed = true }
    }

    @available(iOS 17.0, *)
    private func forceSyncGroups() async {
        _ = await ForceSyncHelper.markProvidersDirty()
        await ForceSyncHelper.bidirectionalSync(recordTypes: ["ProviderConfig", "ProviderConfigV2"])
        forceSyncToast = String(localized: "Syncing model groups via iCloud")
        DispatchQueue.main.asyncAfter(deadline: .now() + 3) {
            forceSyncToast = nil
        }
    }
}

// MARK: - Group Row

private struct GroupRow: View {
    let group: ModelGroup
    @ObservedObject private var store = ProviderConfigStore.shared

    private var isPrimaryDefault: Bool {
        store.defaultPrimaryGroupId == group.id
    }

    private var isSubDefault: Bool {
        store.defaultSubGroupId == group.id
    }

    private var memberSummary: String {
        let entries = group.memberEntryIds.compactMap { store.entry(for: $0) }
        if entries.isEmpty { return String(localized: "No models") }
        let names = entries.prefix(3).map(\.model.displayName)
        let suffix = entries.count > 3 ? " +\(entries.count - 3)" : ""
        return names.joined(separator: ", ") + suffix
    }

    /// [T-ios-modelgroup-modality-icons] The group's TOP-2 most distinctive
    /// modalities (across both inputs AND outputs), shown as icons after the
    /// title so the user can tell at a glance what the group is for (and which to
    /// avoid in a model picker). We aggregate every member model's effective
    /// modality (override else inferred) into one set, then pick the two
    /// highest-priority flags present — generation outputs and special audio/
    /// vision modalities rank above plain text, which is implied for every model.
    ///
    /// Priority (most distinctive first): video-out > image-out > audio-out(TTS)
    /// > audio-in(transcription) > video-in > image-in > pdf-in > text-out.
    /// `textInput` is never shown (universal, pure noise).
    private static let modalityPriority: [ModelModality] = [
        .videoOutput, .imageOutput, .audioOutput,
        .audioInput, .videoInput, .imageInput, .pdfInput,
        .textOutput,
    ]

    private var topModalities: [ModelModality] {
        var combined: ModelModality = []
        for entry in group.memberEntryIds.compactMap({ store.entry(for: $0) }) {
            let model = entry.model
            // Same effective-modality resolution as ProviderInstanceDetailView.
            combined.formUnion(model.modalityOverride ?? model.capabilities.supportedModalities)
        }
        return Self.modalityPriority.filter { combined.contains($0) }.prefix(2).map { $0 }
    }

    /// Icon + accessibility label + color for a single modality flag. Output
    /// (generation) modalities use the "generate"-style glyph + tint; input
    /// modalities use a muted secondary glyph — matching
    /// ProviderInstanceDetailView.modalityIcons.
    @ViewBuilder
    private func modalityIcon(_ modality: ModelModality) -> some View {
        switch modality {
        case .videoOutput:
            Image(systemName: "video.badge.plus")
                .font(.caption).foregroundStyle(.tint)
                .accessibilityLabel(String(localized: "Video generation"))
        case .imageOutput:
            Image(systemName: "photo.badge.plus")
                .font(.caption).foregroundStyle(.tint)
                .accessibilityLabel(String(localized: "Image generation"))
        case .audioOutput:
            Image(systemName: "speaker.wave.2")
                .font(.caption).foregroundStyle(.tint)
                .accessibilityLabel(String(localized: "Speech output"))
        case .audioInput:
            Image(systemName: "waveform.badge.mic")
                .font(.caption).foregroundStyle(.secondary)
                .accessibilityLabel(String(localized: "Speech transcription"))
        case .videoInput:
            Image(systemName: "video")
                .font(.caption).foregroundStyle(.secondary)
                .accessibilityLabel(String(localized: "Video input"))
        case .imageInput:
            Image(systemName: "photo")
                .font(.caption).foregroundStyle(.secondary)
                .accessibilityLabel(String(localized: "Image input"))
        case .pdfInput:
            Image(systemName: "doc")
                .font(.caption).foregroundStyle(.secondary)
                .accessibilityLabel(String(localized: "PDF input"))
        case .textOutput:
            Image(systemName: "text.alignleft")
                .font(.caption).foregroundStyle(.secondary)
                .accessibilityLabel(String(localized: "Text generation"))
        default:
            EmptyView()
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(group.name)
                    .font(.body.weight(.medium))
                // [T-ios-modelgroup-modality-icons] Mark the group's top-2 most
                // distinctive modalities (inputs + outputs) right after the title,
                // in priority order, for at-a-glance "what is this group for".
                ForEach(topModalities, id: \.rawValue) { modality in
                    modalityIcon(modality)
                }
                Spacer()
                if isPrimaryDefault {
                    badge(String(localized: "New chats"), color: .blue)
                }
                if isSubDefault {
                    badge(String(localized: "Light tasks"), color: .orange)
                }
            }

            HStack(spacing: 6) {
                Image(systemName: group.strategy == .fallback ? "arrow.down.circle" : "arrow.triangle.branch")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                Text(group.strategy == .fallback ? "Fallback" : "Load Balance")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                if group.strategy == .fallback {
                    Text("·")
                        .font(.caption)
                        .foregroundStyle(.quaternary)
                    Text(group.fallbackStrategy == .always ? String(localized: "Any error") : String(localized: "Provider errors"))
                        .font(.caption)
                        .foregroundStyle(group.fallbackStrategy == .always ? .orange : .secondary)
                }
                Text("·")
                    .font(.caption)
                    .foregroundStyle(.quaternary)
                Text(String(localized: "\(group.memberEntryIds.count) models"))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Text(memberSummary)
                .font(.caption2)
                .foregroundStyle(.tertiary)
                .lineLimit(1)
        }
        .padding(.vertical, 2)
    }

    private func badge(_ text: String, color: Color) -> some View {
        Text(text)
            .font(.caption2.weight(.semibold))
            .foregroundStyle(color)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(color.opacity(0.12))
            .clipShape(Capsule())
    }
}

/// [T-ios-vision-group #182] Picks the Vision Group. Only groups holding at least one
/// image-capable model are selectable; the pointer is local to this device.
private struct VisionGroupSlotPicker: View {
    @ObservedObject private var store = ProviderConfigStore.shared

    private func imageMembers(_ group: ModelGroup) -> Int {
        group.memberEntryIds.compactMap { store.entry(for: $0) }
            .filter { !$0.isHidden && $0.model.capabilities.supportedModalities.contains(.imageInput) }
            .count
    }

    private var selectedName: String {
        if let id = store.visionGroupId {
            return store.group(for: id)?.name ?? String(localized: "Unavailable group")
        }
        return String(localized: "None", comment: "No group selected")
    }

    var body: some View {
        Menu {
            Picker(selection: Binding(get: { store.visionGroupId }, set: { store.visionGroupId = $0 })) {
                Text("None", comment: "No group selected").tag(String?.none)
                ForEach(store.modelGroups) { group in
                    Text(group.name).tag(Optional(group.id)).disabled(imageMembers(group) == 0)
                }
            } label: { EmptyView() }
        } label: {
            HStack {
                Text("Read images with")
                    .foregroundStyle(Color(UIColor.label))
                Spacer()
                Text(selectedName)
                    .foregroundStyle(.secondary)
                Image(systemName: "chevron.up.chevron.down")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
        }
    }
}
