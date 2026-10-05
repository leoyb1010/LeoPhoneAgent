import SwiftUI
import AVFoundation

// MARK: - Virtual System Voice Entries

extension ModelEntry {
    /// Allows system-managed network recognition when no installed local route is available.
    /// Legacy identifiers stay stable so saved selections continue to resolve.
    static let systemASROnline = ModelEntry(
        uuid: "system-asr-online",
        providerInstanceId: SystemVoiceProvider.builtinProviderId,
        model: LLMModel(
            id: "system-asr-online",
            displayName: String(localized: "System Recognition (Online)", comment: "Built-in cloud ASR option"),
            provider: "system",
            modalityOverride: [.audioInput]
        ),
        isHidden: true
    )
    /// Strictly local. Missing language resources never trigger a network fallback.
    static let systemASROffline = ModelEntry(
        uuid: "system-asr-offline",
        providerInstanceId: SystemVoiceProvider.builtinProviderId,
        model: LLMModel(
            id: "system-asr-offline",
            displayName: String(localized: "System Recognition (Offline)", comment: "Built-in on-device ASR option"),
            provider: "system",
            modalityOverride: [.audioInput]
        ),
        isHidden: true
    )
    /// Legacy/default ASR entry (maps to Offline-preferred behavior). Retained so
    /// existing "…/system-asr" references and the bare sentinel keep resolving.
    static let systemASR = ModelEntry(
        uuid: "system-asr",
        providerInstanceId: SystemVoiceProvider.builtinProviderId,
        model: LLMModel(
            id: "system-asr",
            displayName: String(localized: "System Speech Recognition", comment: "Built-in ASR option"),
            provider: "system",
            modalityOverride: [.audioInput]
        ),
        isHidden: true
    )
    static let systemTTS = ModelEntry(
        uuid: "system-tts",
        providerInstanceId: SystemVoiceProvider.builtinProviderId,
        model: LLMModel(
            id: "system-tts",
            displayName: String(localized: "System Voice (Auto)", comment: "Built-in TTS auto-by-language option"),
            provider: "system",
            modalityOverride: [.audioOutput]
        ),
        isHidden: true
    )

    /// One selectable ModelEntry per filtered Apple TTS voice (Stage 1). The
    /// entry id is the composite "<sentinel>/<voice.identifier>" so selection is
    /// preserved through VoiceSelectionStore and resolved back to a concrete
    /// AVSpeechSynthesisVoice at synthesis time. The always-present "System Voice
    /// (Auto)" default (`.systemTTS`) leads the list for by-language auto-select.
    @MainActor
    static func systemTTSVoiceEntries() -> [ModelEntry] {
        // providerInstanceId = the bare sentinel keeps isSystemEntry(...) true;
        // model.id = the voice identifier makes ModelEntry.id (= "{provider}/{model.id}")
        // the composite "<sentinel>/<voice.identifier>" the resolver reads back.
        SystemVoiceCatalog.ttsModels().map { model in
            ModelEntry(
                providerInstanceId: SystemVoiceProvider.builtinProviderId,
                model: model,
                isHidden: true
            )
        }
    }
}

// MARK: - ModelPickerConfig

struct ModelPickerConfig {
    var title: LocalizedStringKey = "Select Model"
    var mode: Mode = .single

    var explicitPreferModality: [ModelModality]?

    var groupScope: GroupScope = .all

    var candidateFilter: ((ModelEntry) -> Bool)?
    var isDisabled: ((ModelEntry) -> Bool)?
    var existingIds: (@MainActor () -> Set<String>)?
    var headerNote: String?
    var showGroups: Bool = true
    var showCreateGroup: Bool = false
    var createGroupDirection: VoiceDirection?
    var dismissOnSelect: Bool = true

    var currentEntryId: (@MainActor () -> String?)?
    var currentGroupId: (@MainActor () -> String?)?

    var onSelect: (@MainActor (ModelEntry) -> Void)?
    var onSelectGroup: (@MainActor (ModelGroup) -> Void)?
    /// Tap on a member row inside an expanded group. Receives the parent group so
    /// the caller can keep the group binding (pin the entry within the group's
    /// strategy) instead of downgrading to a direct-entry binding. Falls back to
    /// `onSelect` when nil.
    var onSelectInGroup: (@MainActor (ModelEntry, ModelGroup) -> Void)?
    var onAddMulti: (@MainActor (Set<String>) -> Void)?
    /// Ordered callback for routing groups: tap order becomes fallback priority.
    var onAddOrdered: (@MainActor ([String]) -> Bool)?
    var prefersQuickSelection = false
    var onResetToDefault: (@MainActor () -> Void)?
    var onExpand: (@MainActor () -> Void)?

    enum Mode { case single, multi }
    enum GroupScope {
        case all
        case single(String?)
        case none
    }

    @MainActor
    var effectivePreferModality: [ModelModality]? {
        if let explicit = explicitPreferModality { return explicit }
        guard case .single(let groupId) = groupScope, let gid = groupId else { return nil }
        let store = ProviderConfigStore.shared
        if gid == store.voiceInputGroupId  { return [.audioInput] }
        if gid == store.voiceOutputGroupId { return [.audioOutput] }
        return nil
    }

    // MARK: - Factory Methods

    /// Whether `model` can serve the voice direction: dedicated voice model OR
    /// multimodal with the required audio modality (chat-based transcription).
    private static func canServe(_ model: LLMModel, direction: VoiceDirection) -> Bool {
        if direction.isVoiceModel(model) { return true }
        let m = model.capabilities.supportedModalities
        return direction == .input ? m.contains(.audioInput) : m.contains(.audioOutput)
    }

    @MainActor
    static func voiceInput() -> ModelPickerConfig {
        let store = ProviderConfigStore.shared
        let selection = VoiceSelectionStore.shared
        return ModelPickerConfig(
            title: "Voice Input",
            mode: .single,
            explicitPreferModality: [.audioInput],
            groupScope: .single(store.voiceInputGroupId),
            isDisabled: { !canServe($0.model, direction: .input) },
            showCreateGroup: true,
            createGroupDirection: .input,
            // Effective selection mirrors VoiceProviderResolver: explicit override
            // first; with no override the configured group is the selection; with
            // neither, the offline System engine is the effective default.
            currentEntryId: {
                if let sel = selection.inputEntryId { return sel }
                return store.voiceInputGroupId == nil ? VoiceProviderResolver.systemEntryId : nil
            },
            currentGroupId: {
                selection.inputEntryId == nil ? store.voiceInputGroupId : nil
            },
            onSelect: { entry in
                if VoiceProviderResolver.isSystemEntry(entry.providerInstanceId) {
                    // Preserve the Online/Offline composite id (entry.id =
                    // "<sentinel>/system-asr-online|offline") so the choice survives;
                    // the bare/legacy System entry collapses to the sentinel.
                    let eid = entry.id
                    selection.inputEntryId = (eid.hasSuffix("/system-asr-online")
                        || eid.hasSuffix("/system-asr-offline")) ? eid : VoiceProviderResolver.systemEntryId
                } else {
                    selection.inputEntryId = entry.id
                }
            },
            onSelectGroup: { group in
                let entries = group.memberEntryIds.compactMap { store.entry(for: $0) }
                if let e = entries.first(where: { canServe($0.model, direction: .input) }) ?? entries.first {
                    selection.inputEntryId = e.id
                }
            }
        )
    }

    @MainActor
    static func voiceOutput() -> ModelPickerConfig {
        let store = ProviderConfigStore.shared
        let selection = VoiceSelectionStore.shared
        return ModelPickerConfig(
            title: "Voice Output",
            mode: .single,
            explicitPreferModality: [.audioOutput],
            groupScope: .single(store.voiceOutputGroupId),
            isDisabled: { !canServe($0.model, direction: .output) },
            showCreateGroup: true,
            createGroupDirection: .output,
            currentEntryId: {
                if let sel = selection.outputEntryId { return sel }
                return store.voiceOutputGroupId == nil ? VoiceProviderResolver.systemEntryId : nil
            },
            currentGroupId: {
                selection.outputEntryId == nil ? store.voiceOutputGroupId : nil
            },
            onSelect: { entry in
                if VoiceProviderResolver.isSystemEntry(entry.providerInstanceId) {
                    // A specific System voice (composite id "<sentinel>/<voiceId>")
                    // is preserved so synthesis uses that exact AVSpeechSynthesisVoice;
                    // the bare "System Voice (auto)" default collapses to the sentinel.
                    selection.outputEntryId = VoiceProviderResolver.selectedSystemVoiceId(entry.id) != nil
                        ? entry.id
                        : VoiceProviderResolver.systemEntryId
                } else {
                    selection.outputEntryId = entry.id
                }
                VoiceOutputPlayer.shared.resetActiveModel()
            },
            onSelectGroup: { group in
                let entries = group.memberEntryIds.compactMap { store.entry(for: $0) }
                if let e = entries.first(where: { canServe($0.model, direction: .output) }) ?? entries.first {
                    selection.outputEntryId = e.id
                }
                VoiceOutputPlayer.shared.resetActiveModel()
            }
        )
    }

    @MainActor
    static func agentLoopAddModels() -> ModelPickerConfig {
        let store = ProviderConfigStore.shared
        return ModelPickerConfig(
            mode: .multi,
            groupScope: .none,
            existingIds: {
                let entries = Set(store.agentLoopModelEntryIds)
                let groupEntryIds = Set(store.agentLoopGroupIds.compactMap { store.group(for: $0) }.flatMap(\.memberEntryIds))
                return entries.union(groupEntryIds)
            },
            onAddMulti: { ids in for id in ids.sorted() { store.addAgentLoopEntry(id) } }
        )
    }
}

// Informational copy must not inherit a Button's accent tint. The native
// light/dark contrast audit exposed faded blue metadata and light section text.
private enum ModelPickerText {
    // Opaque adaptive text avoids applying transparency again inside system
    // section-header/vibrancy styles. Keep the same readable light/dark tones.
    static let secondary = Color(uiColor: UIColor { traits in
        UIColor(white: traits.userInterfaceStyle == .dark ? 0.74 : 0.28, alpha: 1)
    })
    static let action = Color(uiColor: UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(red: 0.63, green: 0.82, blue: 1, alpha: 1)
            : UIColor(red: 0.08, green: 0.27, blue: 0.54, alpha: 1)
    })
}

// MARK: - UnifiedModelPicker

struct UnifiedModelPicker: View {
    let config: ModelPickerConfig
    @ObservedObject private var store = ProviderConfigStore.shared
    /// Observed so the System voice rows rebuild when the available-voices roster
    /// changes (Enhanced/Premium pack download, Personal Voice creation).
    @ObservedObject private var systemVoiceRoster = SystemVoiceRoster.shared
    @Environment(\.dismiss) private var dismiss

    @ObservedObject private var pins = ModelPinStore.shared
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @State private var browseScope: BrowseScope = .providers
    @State private var editMode: EditMode = .inactive
    @State private var pinFailure = false
    @State private var saveFailed = false
    @State private var pendingCreatedGroupId: String?
    @State private var selectionOrder: [String] = []
    @State private var searchText = ""

    private enum BrowseScope: String, CaseIterable {
        case quick, favorites, providers, groups
        var title: LocalizedStringKey {
            switch self {
            case .quick: return "Quick picks"
            case .favorites: return "Favorites"
            case .providers: return "Providers"
            case .groups: return "Groups"
            }
        }
    }
    private var isSearching: Bool { !searchText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    private var isQuickBrowse: Bool { config.prefersQuickSelection && browseScope == .quick && !isMulti }
    private var quickRecentEntries: [ModelEntry] {
        let favorites = Set(favoriteEntries.map(\.id))
        return Array(ModelCatalog.orderedEntries(
            keys: ModelSwitcher.normalizedChoiceKeys(ModelSwitcher.recentKeys, store: store),
            entries: candidateEntries
        ).filter { !favorites.contains($0.id) && memberUnavailableReason($0.id) == nil }.prefix(3))
    }
    private var supportsGroups: Bool { config.showGroups && !isMulti && config.onSelectGroup != nil }
    private var scopes: [BrowseScope] { supportsGroups ? [.favorites, .providers, .groups] : [.favorites, .providers] }
    private var favoriteEntries: [ModelEntry] {
        ModelCatalog.orderedEntries(keys: ModelSwitcher.normalizedChoiceKeys(pins.keys, store: store), entries: candidateEntries)
    }
    private var filteredFavorites: [ModelEntry] { favoriteEntries.filter { matchesEntry($0) } }
    private func matchesEntry(_ entry: ModelEntry) -> Bool {
        ModelCatalog.matches(searchText, entry: entry, providerLabel: store.instance(for: entry.providerInstanceId)?.label ?? "")
    }
    @State private var selectedEntryIds: Set<String> = []
    @State private var expandedGroupIds: Set<String> = []
    @State private var collapsedInstanceIds: Set<String> = []
    @State private var collapseSeeded = false
    @State private var showCreateGroupSheet = false
    /// Presents the full Model Groups management page (Settings → Model Groups)
    /// on top of the picker via the "Edit" affordance in the group section header,
    /// so users can reconfigure groups without dismissing the picker and digging
    /// through Settings.
    @State private var showGroupsManager = false
    @State private var showModelLibrary = false
    /// The model row whose Quick Test sheet is open (nil = none). Set by the
    /// per-row bolt button so any model — cloud, group member, or System voice —
    /// can be smoke-tested (speak / text output) without leaving the picker.
    @State private var quickTestEntry: ModelEntry?

    private var isMulti: Bool { config.mode == .multi }
    private var validSelectedOrder: [String] {
        let valid = Set(candidateEntries.filter { !(config.isDisabled?($0) ?? false) }.map(\.id))
        return selectionOrder.filter { selectedEntryIds.contains($0) && valid.contains($0) }
    }

    // MARK: - Candidate Filtering

    private func matchesPreference(_ modality: ModelModality, prefs: [ModelModality]) -> Bool {
        prefs.contains { modality.isSuperset(of: $0) }
    }

    private var candidateEntries: [ModelEntry] {
        let prefs = config.effectivePreferModality
        var pool = store.modelEntries.filter { entry in
            guard !entry.isHidden else { return false }
            guard store.instance(for: entry.providerInstanceId)?.isEnabled == true else { return false }
            guard let prefs, !prefs.isEmpty else { return true }
            return matchesPreference(entry.model.capabilities.supportedModalities, prefs: prefs)
        }
        if let prefs, !prefs.isEmpty {
            if prefs.contains(where: { $0 == .audioInput }) {
                // Two selectable System ASR models: Online (cloud) leads — higher
                // accuracy + more languages — then Offline (on-device) for
                // privacy/offline. The user picks the trade-off explicitly.
                pool.append(.systemASROnline)
                pool.append(.systemASROffline)
            }
            if prefs.contains(where: { $0 == .audioOutput }) {
                // "System Voice (Auto)" default first, then one row per installed
                // Apple voice (Stage 1). `systemVoiceRoster` is observed so the
                // list rebuilds when the user downloads/removes voice packs.
                pool.append(.systemTTS)
                pool.append(contentsOf: ModelEntry.systemTTSVoiceEntries())
            }
        }
        if let f = config.candidateFilter { pool = pool.filter(f) }
        if let existing = config.existingIds?() { pool = pool.filter { !existing.contains($0.id) } }
        return ModelCatalog.entries(pool, providerOrder: store.instances.map(\.id))
    }

    private var systemEntries: [ModelEntry] {
        candidateEntries.filter { VoiceProviderResolver.isSystemEntry($0.providerInstanceId) }
    }

    private var regularEntries: [ModelEntry] {
        candidateEntries.filter { !VoiceProviderResolver.isSystemEntry($0.providerInstanceId) }
    }

    private var entriesByInstance: [(instance: ProviderInstance, entries: [ModelEntry])] {
        var result: [(ProviderInstance, [ModelEntry])] = []
        // Built-in System engine FIRST — as its own provider section (Phase C), the
        // same collapsible header treatment as any cloud provider, driven by the
        // synthetic local-only instance rather than a parallel systemSection.
        if !systemEntries.isEmpty {
            result.append((SystemVoiceProvider.providerInstance, systemEntries))
        }
        let grouped = Dictionary(grouping: regularEntries, by: { $0.providerInstanceId })
        var seen = Set<String>()
        for instance in store.instances where instance.isEnabled {
            guard !seen.contains(instance.id) else { continue }
            seen.insert(instance.id)
            if let entries = grouped[instance.id], !entries.isEmpty {
                result.append((instance, entries))
            }
        }
        return result
    }

    // MARK: - Search

    private func fuzzyMatch(_ text: String) -> Bool {
        ModelCatalog.matches(searchText, text: text)
    }

    private var filteredEntriesByInstance: [(instance: ProviderInstance, entries: [ModelEntry])] {
        entriesByInstance.compactMap { item in
            let filtered = item.entries.filter { matchesEntry($0) }
            return filtered.isEmpty ? nil : (item.instance, filtered)
        }
    }

    // MARK: - Groups

    private var visibleGroups: [ModelGroup] {
        switch config.groupScope {
        case .all:
            let groups = store.modelGroups
            guard !searchText.isEmpty else { return groups }
            return groups.filter { group in
                fuzzyMatch(group.name) || group.memberEntryIds.contains { id in
                    store.entry(for: id).map { matchesEntry($0) } ?? false
                }
            }
        case .single(let groupId):
            guard let gid = groupId, let g = store.group(for: gid) else { return [] }
            guard !searchText.isEmpty else { return [g] }
            if fuzzyMatch(g.name) { return [g] }
            let memberMatch = g.memberEntryIds.contains { id in
                store.entry(for: id).map { fuzzyMatch($0.model.displayName) } ?? false
            }
            return memberMatch ? [g] : []
        case .none:
            return []
        }
    }

    // MARK: - Body

    var body: some View {
        List {
            if !isSearching && isQuickBrowse {
                quickSections
            }
            if !isSearching && !editMode.isEditing && !isQuickBrowse {
                if !isMulti { selectionSummary }
                Section {
                    if dynamicTypeSize.isAccessibilitySize {
                        Picker("Browse models", selection: $browseScope) {
                            ForEach(scopes, id: \.self) { scope in Text(scope.title).tag(scope) }
                        }.pickerStyle(.menu).accessibilityIdentifier("model-picker.scope")
                    } else {
                        Picker("Browse models", selection: $browseScope) {
                            ForEach(scopes, id: \.self) { scope in Text(scope.title).tag(scope) }
                        }.pickerStyle(.segmented).accessibilityIdentifier("model-picker.scope")
                    }
                } footer: {
                    if let note = config.headerNote { Text(note).foregroundStyle(ModelPickerText.secondary) }
                }
            }
            if isSearching {
                // The keyboard leaves little room. Direct matches come first;
                // never push them below selection cards, scope or explanation.
                // Search is a flat result list: provenance is in every row.
                // Repeating a provider header above it consumes the entire
                // keyboard viewport at accessibility text sizes.
                if !filteredEntriesByInstance.isEmpty {
                    Section {
                        ForEach(filteredEntriesByInstance.flatMap { $0.entries }) { entry in entryRow(entry) }
                    }
                }
                if supportsGroups && !visibleGroups.isEmpty { groupsSection }
                if filteredEntriesByInstance.isEmpty && (!supportsGroups || visibleGroups.isEmpty) { emptySection }
            } else {
                if browseScope == .favorites { favoritesSection }
                if supportsGroups && browseScope == .groups { groupsSection }
                if browseScope == .providers {
                    ForEach(filteredEntriesByInstance, id: \.instance.id) { item in instanceSection(item) }
                    if filteredEntriesByInstance.isEmpty { emptySection }
                }
            }
            if config.showCreateGroup {
                Section {
                    Button { showCreateGroupSheet = true } label: {
                        Label("Create group from models…", systemImage: "plus.rectangle.on.folder")
                    }
                }
            }
        }
        .environment(\.editMode, $editMode)
        .searchable(text: $searchText, placement: .navigationBarDrawer(displayMode: .always), prompt: "Search model, ID or provider")
        .scrollDismissesKeyboard(.interactively)
        .navigationTitle(config.title)
        .navigationBarTitleDisplayMode(.inline)
        .onAppear {
            seedCollapse()
            SystemVoiceCatalog.startObservingVoiceChanges()
        }
        .onChange(of: browseScope) { _, _ in editMode = .inactive }
        .onChange(of: searchText) { _, _ in
            editMode = .inactive
            if isSearching { config.onExpand?() }
        }
        .safeAreaInset(edge: .bottom) {
            if isMulti {
                Button { commitMultiSelection() } label: {
                    Text("Add (\(validSelectedOrder.count))").frame(maxWidth: .infinity, minHeight: 44)
                }
                .buttonStyle(.borderedProminent)
                .disabled(validSelectedOrder.isEmpty)
                .accessibilityIdentifier("model-picker.add-selected")
                .padding(.horizontal).padding(.vertical, 8)
                .background(.regularMaterial)
            }
        }
        .toolbar { toolbarContent }
        .alert("Favorites are full", isPresented: $pinFailure) {
            Button("OK", role: .cancel) {}
        } message: {
            Text("You can save up to \(ModelSwitcher.maxPinned) favorites. Remove one before adding another.")
        }

        .alert("Model organization", isPresented: $saveFailed) {
            Button("OK", role: .cancel) {}
        } message: {
            Text("Could not save model changes. Your previous configuration was kept. Try again.")
        }
        .sheet(isPresented: $showCreateGroupSheet) {
            NavigationStack {
                UnifiedModelPicker(config: createGroupConfig())
            }
        }
        .sheet(isPresented: $showGroupsManager) {
            NavigationStack {
                ModelGroupsView()
                    .toolbar {
                        ToolbarItem(placement: .cancellationAction) {
                            Button("Done") { showGroupsManager = false }
                                .accessibilityIdentifier("model-picker.close-group-manager")
                        }
                    }
            }
        }
        .sheet(isPresented: $showModelLibrary) {
            NavigationStack {
                ModelLibraryView()
            }
        }
        .sheet(item: $quickTestEntry) { entry in
            // [T-quicktest-stale-session] .id(entry.id) forces a FRESH view
            // identity per model: @StateObject's initial-value closure only
            // evaluates when the identity is first established, and an
            // interactive swipe-dismiss followed by opening another model's
            // test could reuse the previous identity — header showed the new
            // model while TestSession still ran the OLD one.
            ModelQuickTestSheet(entry: entry)
                .id(entry.id)
                .presentationDetents([.medium, .large])
                .presentationDragIndicator(.visible)
        }
    }

    @ViewBuilder
    private var quickSections: some View {
        // The selected favorite already has a checkmark and provider label.
        // Don't spend the compact sheet repeating the same model above it.
        if config.currentGroupId?() != nil || !favoriteEntries.prefix(3).contains(where: { $0.id == config.currentEntryId?() }) {
            selectionSummary
        }
        if !favoriteEntries.isEmpty {
            Section {
                ForEach(favoriteEntries.prefix(3)) { entry in entryRow(entry) }
                Button("All favorites") { browseScope = .favorites; config.onExpand?() }
                    .foregroundStyle(ModelPickerText.action)
                    .accessibilityIdentifier("model-picker.all-favorites")
            } header: { Text("Favorites").foregroundStyle(ModelPickerText.secondary) }
        }
        if !quickRecentEntries.isEmpty {
            Section {
                ForEach(quickRecentEntries) { entry in entryRow(entry) }
            } header: { Text("Recently used").foregroundStyle(ModelPickerText.secondary) }
        }
        if favoriteEntries.isEmpty && quickRecentEntries.isEmpty {
            let available = candidateEntries.filter { memberUnavailableReason($0.id) == nil }
            if available.isEmpty {
                emptySection
            } else {
                Section {
                    ForEach(available.prefix(3)) { entry in entryRow(entry) }
                } header: { Text("Available models").foregroundStyle(ModelPickerText.secondary) }
            }
        }
        Section {
            if let reset = config.onResetToDefault {
                Button(action: reset) {
                    Label("Use saved default", systemImage: "arrow.uturn.backward")
                        .frame(minHeight: 44)
                }
                .foregroundStyle(ModelPickerText.action)
                .accessibilityIdentifier("model-picker.use-default")
            }
            Button { browseScope = .providers; config.onExpand?() } label: {
                Label("All models", systemImage: "list.bullet")
                    .frame(minHeight: 44)
            }
            .foregroundStyle(ModelPickerText.action)
            .accessibilityIdentifier("model-picker.all-models")
            if supportsGroups {
                Button { browseScope = .groups; config.onExpand?() } label: {
                    Label("Groups", systemImage: "square.stack.3d.up")
                        .frame(minHeight: 44)
                }
                .foregroundStyle(ModelPickerText.action)
                .accessibilityIdentifier("model-picker.all-groups")
            }
            Button { showModelLibrary = true } label: {
                Label("Model Library", systemImage: "slider.horizontal.3")
                    .frame(minHeight: 44)
            }
            .foregroundStyle(ModelPickerText.action)
            .accessibilityIdentifier("model-picker.library")
        } footer: {
            if let note = config.headerNote { Text(note).foregroundStyle(ModelPickerText.secondary) }
        }
    }

    @ViewBuilder
    private var selectionSummary: some View {
        if let gid = config.currentGroupId?(), let group = store.group(for: gid) {
            Section {
                VStack(alignment: .leading, spacing: 4) {
                    Label(group.name, systemImage: "square.stack.3d.up").font(.headline)
                    if let eid = config.currentEntryId?(), let entry = store.entry(for: eid) {
                        Text("Selected member: \(entry.model.displayName)").font(.footnote).foregroundStyle(ModelPickerText.secondary)
                        if let reason = memberUnavailableReason(entry.id) {
                            Text(reason).font(.caption).foregroundStyle(.orange)
                        }
                    }
                }
            } header: { Text("Current selection").foregroundStyle(ModelPickerText.secondary) }
        } else if let eid = config.currentEntryId?(), let entry = store.entry(for: eid) ?? Self.systemEntry(for: eid) {
            Section {
                VStack(alignment: .leading, spacing: 4) {
                    Label(entry.model.displayName, systemImage: "checkmark.circle.fill").font(.headline)
                    if let provider = store.instance(for: entry.providerInstanceId) {
                        Text(provider.label).font(.footnote).foregroundStyle(ModelPickerText.secondary)
                    }
                }
            } header: { Text("Current selection").foregroundStyle(ModelPickerText.secondary) }
        }
    }

    private var favoritesSection: some View {
        Section {
            if favoriteEntries.isEmpty {
                Label("Star models in Providers to keep them here.", systemImage: "star")
                    .foregroundStyle(ModelPickerText.secondary)
                Button("Browse providers") { browseScope = .providers }
            } else {
                ForEach(favoriteEntries) { entry in entryRow(entry) }
                    .onMove { from, to in pins.move(visibleKeys: favoriteEntries.map(\.id), from: from, to: to) }
            }
        } header: { Text("Favorites").foregroundStyle(ModelPickerText.secondary) }
        footer: { Text("Favorites are your shortlist. Reorder them with Edit; choosing a model does not change your default.").foregroundStyle(ModelPickerText.secondary) }
    }

    private var groupsSection: some View {
        Section {
            if visibleGroups.isEmpty {
                Text("No model groups").foregroundStyle(ModelPickerText.secondary)
            }
            ForEach(visibleGroups) { group in
                groupRow(group)
                if expandedGroupIds.contains(group.id) { groupMemberRows(group) }
            }
            Button { showGroupsManager = true } label: {
                Label("Manage groups and defaults", systemImage: "slider.horizontal.3")
            }
            .accessibilityIdentifier("model-picker.manage-groups")
        } header: { Text("Routing groups").foregroundStyle(ModelPickerText.secondary) }
        footer: { Text("A group tries its models in order or balances sessions. Default applies to new chats; selecting here only changes this choice.").foregroundStyle(ModelPickerText.secondary) }
    }

    private func favoriteButton(_ entry: ModelEntry) -> some View {
        Button {
            if !pins.toggle(entry.id) { pinFailure = true }
        } label: {
            Image(systemName: pins.isPinned(entry.id) ? "star.fill" : "star")
                .foregroundStyle(pins.isPinned(entry.id) ? Color.orange : Color.secondary)
                .frame(minWidth: 44, minHeight: 44)
                .contentShape(Rectangle())
        }
        .buttonStyle(.borderless)
        .accessibilityLabel(Text(pins.isPinned(entry.id) ? "Remove from favorites" : "Add to favorites"))
        .accessibilityValue(entry.model.displayName)
        .accessibilityIdentifier("model-picker.favorite.\(entry.id)")
    }

    /// Compact per-row Quick Test button — opens the SAME ModelQuickTestSheet used
    /// by the provider model list, for a consistent experience everywhere (the
    /// sheet auto-plays audio results, so a voice test speaks on its own). Reused
    /// across cloud rows, group members, and System voices.
    private func quickTestButton(_ entry: ModelEntry) -> some View {
        Button {
            quickTestEntry = entry
        } label: {
            Image(systemName: "bolt.badge.checkmark")
                .font(.system(size: 15, weight: .medium))
                .foregroundStyle(.tint)
                .frame(width: 44, height: 44)
                .contentShape(Rectangle())
        }
        .buttonStyle(.borderless)
        .accessibilityLabel(Text("Quick Test \(entry.model.displayName)"))
    }

    /// Nested multi-select picker for "Create group from models…". The voice
    /// direction is carried via `explicitPreferModality` (no group exists yet,
    /// so scope inference can't apply) — the System virtual entry unlocks
    /// automatically for the matching direction.
    @MainActor
    private func createGroupConfig() -> ModelPickerConfig {
        let dir = config.createGroupDirection
        let parentConfig = config
        let dismissPicker = dismiss
        return ModelPickerConfig(
            title: "Create Group",
            mode: .multi,
            explicitPreferModality: dir.map { $0 == .input ? [.audioInput] : [.audioOutput] },
            groupScope: .none,
            headerNote: dir?.filterNote,
            onAddOrdered: { ids in
                guard !ids.isEmpty else { return false }
                let store = ProviderConfigStore.shared
                let group: ModelGroup
                if let id = pendingCreatedGroupId, let saved = store.group(for: id), saved.memberEntryIds == ids {
                    group = saved
                } else {
                    group = ModelGroup(name: Self.uniqueGroupName(for: dir, store: store), memberEntryIds: ids)
                    guard store.addGroup(group) else { return false }
                    pendingCreatedGroupId = group.id
                }
                if let dir {
                    if dir == .input {
                        store.voiceInputGroupId = group.id
                        guard store.voiceInputGroupId == group.id else { return false }
                    } else {
                        store.voiceOutputGroupId = group.id
                        guard store.voiceOutputGroupId == group.id else { return false }
                    }
                }
                if let firstId = ids.first {
                    if let entry = store.entry(for: firstId) {
                        parentConfig.onSelect?(entry)
                    } else if VoiceProviderResolver.isSystemEntry(firstId) {
                        parentConfig.onSelect?(dir == .output ? .systemTTS : .systemASR)
                    }
                }
                pendingCreatedGroupId = nil
                dismissPicker()
                return true
            }
        )
    }

    private static func uniqueGroupName(for dir: VoiceDirection?, store: ProviderConfigStore) -> String {
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

    private func commitMultiSelection() {
        let ordered = validSelectedOrder
        guard !ordered.isEmpty else { return }
        if let onAddOrdered = config.onAddOrdered {
            guard onAddOrdered(ordered) else { saveFailed = true; return }
        } else { config.onAddMulti?(Set(ordered)) }
        dismiss()
    }

    // MARK: - Toolbar

    @ToolbarContentBuilder
    private var toolbarContent: some ToolbarContent {
        if isMulti {
            ToolbarItem(placement: .topBarLeading) {
                Button("Cancel") { dismiss() }
            }
        } else {
            if config.prefersQuickSelection && browseScope != .quick && !isSearching {
                ToolbarItem(placement: .topBarLeading) {
                    Button { browseScope = .quick } label: {
                        Label("Quick picks", systemImage: "chevron.backward")
                    }
                    .accessibilityIdentifier("model-picker.back-to-quick")
                }
            }
            if browseScope == .favorites && !isSearching && !favoriteEntries.isEmpty {
                ToolbarItem(placement: .topBarLeading) {
                    Button(editMode.isEditing ? "Done editing" : "Edit") {
                        editMode = editMode.isEditing ? .inactive : .active
                    }
                    .accessibilityIdentifier("model-picker.edit-favorites")
                }
            }
            ToolbarItem(placement: .topBarTrailing) {
                Button { dismiss() } label: {
                    Text("Done").frame(minWidth: 44, minHeight: 44)
                        .foregroundStyle(ModelPickerText.action)
                }.buttonStyle(.plain)
            }
        }
    }

    /// A stable "which System row" key from an entry/selection id: the specific
    /// voice id, the ASR online/offline variant, or "" for the bare sentinel / auto
    /// default. Lets exactly ONE System row show selected in the generic entryRow.
    private static func systemRowKey(_ id: String?) -> String {
        guard let id else { return "" }
        if let v = VoiceProviderResolver.selectedSystemVoiceId(id) { return v }
        if id.hasSuffix("/system-asr-online")  { return "asr-online" }
        if id.hasSuffix("/system-asr-offline") { return "asr-offline" }
        return ""   // bare sentinel / auto default
    }

    // MARK: - Group Row

    private func groupRow(_ group: ModelGroup) -> some View {
        let isSelected = isGroupSelected(group)
        let available = !availableMemberEntryIds(group).isEmpty
        return HStack(spacing: 8) {
            Button {
                guard available else { return }
                config.onSelectGroup?(group)
                dismissIfNeeded()
            } label: {
                HStack(spacing: 10) {
                    Image(systemName: isSelected ? "checkmark.circle.fill" : "square.stack.3d.up")
                        .foregroundStyle(isSelected ? Color.accentColor : Color.secondary)
                    VStack(alignment: .leading, spacing: 4) {
                        Text(group.name).font(.body.weight(.medium)).foregroundStyle(Color.primary)
                        groupSubtitle(group)
                        Text(group.strategy == .fallback ? "Ordered fallback" : "Load balancing")
                            .font(.caption).foregroundStyle(ModelPickerText.secondary)
                        if store.defaultPrimaryGroupId == group.id {
                            Text("Default for new chats").font(.caption).foregroundStyle(.tint)
                        }
                    }
                    Spacer(minLength: 0)
                }
                .frame(minHeight: 44).contentShape(Rectangle())
            }
            .buttonStyle(.borderless)
            .disabled(!available)
            .accessibilityIdentifier("model-picker.group.\(group.id)")
            .accessibilityValue(isSelected ? Text("Selected") : Text("Not selected"))
            Button {
                if expandedGroupIds.contains(group.id) { expandedGroupIds.remove(group.id) }
                else { expandedGroupIds.insert(group.id) }
            } label: {
                Image(systemName: expandedGroupIds.contains(group.id) ? "chevron.up" : "chevron.down")
                    .frame(minWidth: 44, minHeight: 44)
            }
            .buttonStyle(.borderless)
            .accessibilityLabel(Text("Show models in \(group.name)"))
            .accessibilityIdentifier("model-picker.expand-group.\(group.id)")
        }
    }

    private func isGroupSelected(_ group: ModelGroup) -> Bool {
        config.currentGroupId?() == group.id
    }

    @ViewBuilder
    private func groupSubtitle(_ group: ModelGroup) -> some View {
        // 组内计数在Button内会继承浅蓝tertiary；实际iPad白底仅1.36:1，保持显式语义色。
        if group.memberEntryIds.isEmpty {
            Text(String(localized: "No models"))
                .font(.caption)
                .foregroundStyle(ModelPickerText.secondary)
        } else if isGroupSelected(group),
                  let eid = config.currentEntryId?(),
                  let entry = store.entry(for: eid) {
            Text("→ \(entry.model.displayName)")
                .font(.caption)
                .foregroundStyle(ModelPickerText.secondary)
        } else {
            let available = availableMemberEntryIds(group).count
            let total = group.memberEntryIds.count
            if available == total {
                Text(String(localized: "\(total) models"))
                    .font(.caption)
                    .foregroundStyle(ModelPickerText.secondary)
            } else if available == 0 {
                Text(String(localized: "\(total) models · all unavailable"))
                    .font(.caption)
                    .foregroundStyle(.red.opacity(0.7))
            } else {
                Text(String(localized: "\(available)/\(total) available"))
                    .font(.caption)
                    .foregroundStyle(.orange)
            }
        }
    }

    private func strategyBadge(_ strategy: RoutingStrategy) -> some View {
        HStack(spacing: 2) {
            Image(systemName: strategy == .fallback ? "arrow.down.circle" : "arrow.triangle.branch")
                .font(.system(size: 8))
            Text(strategy == .fallback ? "FB" : "LB")
                .font(.system(size: 9, weight: .medium, design: .rounded))
        }
        .foregroundStyle(ModelPickerText.secondary)
        .padding(.horizontal, 4)
        .padding(.vertical, 1)
        .background(Color(UIColor.quaternarySystemFill))
        .clipShape(Capsule())
    }

    private func availableMemberEntryIds(_ group: ModelGroup) -> [String] {
        group.memberEntryIds.filter { memberUnavailableReason($0) == nil }
    }

    private func memberUnavailableReason(_ entryId: String) -> String? {
        // Resolve the entry — real store entry, or a virtual built-in (System)
        // entry. A model that needs no credential (offline built-in) is always
        // available, so it short-circuits BEFORE the instance/credential checks.
        // This is property-driven: no "is this System?" branch here.
        guard let entry = store.entry(for: entryId) ?? Self.systemEntry(for: entryId) else {
            return String(localized: "Model not found")
        }
        if config.isDisabled?(entry) == true { return String(localized: "Unavailable for this purpose") }
        if let filter = config.candidateFilter, !filter(entry) { return String(localized: "Unavailable for this purpose") }
        if VoiceProviderResolver.isSystemEntry(entry.providerInstanceId), config.effectivePreferModality == nil {
            return String(localized: "Unavailable for this purpose")
        }
        if !entry.displayTraits.requiresCredential { return nil }
        if entry.isHidden { return String(localized: "Hidden") }
        guard let instance = store.instance(for: entry.providerInstanceId) else {
            return String(localized: "Provider not found")
        }
        if instance.isRetiredSignIn { return String(localized: "Retired · needs API key") }
        if !instance.isEnabled { return String(localized: "Provider disabled") }
        if !instance.hasAnyCredential { return String(localized: "Not signed in") }
        return nil
    }

    /// Maps an entry id that refers to the built-in System engine to the matching
    /// virtual entry, nil for regular ids. Order matters:
    ///   1. A SPECIFIC voice id ("…/com.apple.voice.…") → a real per-voice entry
    ///      carrying that voice's localized display name (so a group lists e.g.
    ///      "Samantha (English, Female voice)", NOT the generic "System Voice").
    ///   2. The TTS auto default ("…/output" / "…/system-tts") → .systemTTS.
    ///   3. The ASR Online/Offline variants ("…/system-asr-online|offline").
    ///   4. Everything else (bare sentinel, "…/system-asr", "…/input") → .systemASR.
    @MainActor
    static func systemEntry(for id: String) -> ModelEntry? {
        guard VoiceProviderResolver.isSystemEntry(id) else { return nil }
        if let voiceId = VoiceProviderResolver.selectedSystemVoiceId(id) {
            // The voice IS a TTS voice member. If it's currently installed, use its
            // rich localized name; if NOT installed on this device (e.g. a synced
            // group picked a voice this device doesn't have), still render it as a
            // TTS entry with a name derived from the identifier — never fall through
            // to the generic ASR row (which showed the wrong "System Speech
            // Recognition" + mic icon for uninstalled voices).
            let name: String
            if let voice = AVSpeechSynthesisVoice(identifier: voiceId) {
                name = SystemVoiceCatalog.displayName(for: voice)
            } else {
                // Not installed on this device (e.g. a synced group named a voice
                // this device lacks). Derive "Tingting (zh-CN) · not installed" from
                // the identifier "com.apple.voice.super-compact.zh-CN.Tingting".
                let parts = voiceId.split(separator: ".").map(String.init)
                let leaf = parts.last ?? voiceId
                let lang = parts.count >= 2 ? parts[parts.count - 2] : ""
                let notInstalled = String(localized: "not installed", comment: "voice pack not downloaded")
                name = lang.isEmpty ? "\(leaf) · \(notInstalled)" : "\(leaf) (\(lang)) · \(notInstalled)"
            }
            return ModelEntry(
                providerInstanceId: SystemVoiceProvider.builtinProviderId,
                model: LLMModel(
                    id: voiceId,
                    displayName: name,
                    provider: SystemVoiceProvider.builtinProviderId,
                    modalityOverride: [.audioOutput]),
                isHidden: true)
        }
        if id.hasSuffix("/output") || id.hasSuffix("/system-tts") { return .systemTTS }
        if id.hasSuffix("/system-asr-online") { return .systemASROnline }
        if id.hasSuffix("/system-asr-offline") { return .systemASROffline }
        return .systemASR
    }

    /// Instance variant that resolves a bare sentinel by the picker's own
    /// modality preference (TTS context → System Voice).
    private func systemVirtualEntry(forMemberId id: String) -> ModelEntry {
        // A specific voice id → its real per-voice entry (localized voice name).
        if VoiceProviderResolver.selectedSystemVoiceId(id) != nil,
           let e = Self.systemEntry(for: id) { return e }
        if id.hasSuffix("/output") || id.hasSuffix("/system-tts") { return .systemTTS }
        if id.hasSuffix("/input") || id.hasSuffix("/system-asr") { return .systemASR }
        // Bare sentinel — pick by the picker's modality preference.
        if config.effectivePreferModality?.contains(where: { $0 == .audioOutput }) == true {
            return .systemTTS
        }
        return .systemASR
    }

    @ViewBuilder
    private func groupMemberRows(_ group: ModelGroup) -> some View {
        if group.memberEntryIds.isEmpty {
            Text("No models in this group")
                .font(.caption)
                .foregroundStyle(ModelPickerText.secondary)
                .padding(.leading, 30)
                .padding(.vertical, 4)
        } else {
            ForEach(group.memberEntryIds, id: \.self) { entryId in
                // System member ids never resolve via store.entry — in a voice
                // context (audio preference active) render the virtual System
                // entry (selectable) instead of "Model not found". In non-voice
                // contexts (e.g. the session picker listing a voice group) fall
                // through to the unavailable row so System can't be bound as a
                // chat model.
                if VoiceProviderResolver.isSystemEntry(entryId), config.effectivePreferModality != nil {
                    expandedEntryRow(systemVirtualEntry(forMemberId: entryId), parentGroup: group)
                        .padding(.leading, 30)
                } else if let reason = memberUnavailableReason(entryId) {
                    unavailableMemberRow(entryId: entryId, reason: reason)
                        .padding(.leading, 30)
                } else if let entry = store.entry(for: entryId) {
                    expandedEntryRow(entry, parentGroup: group)
                        .padding(.leading, 30)
                }
            }
        }
    }

    private func expandedEntryRow(_ entry: ModelEntry, parentGroup: ModelGroup) -> some View {
        let isSystem = VoiceProviderResolver.isSystemEntry(entry.providerInstanceId)
        let isActive = (config.currentGroupId?() == parentGroup.id && config.currentEntryId?() == entry.id)
            || (isSystem && Self.systemRowKey(config.currentEntryId?()) == Self.systemRowKey(entry.id)
                && VoiceProviderResolver.isSystemEntry(config.currentEntryId?()))
        let disabled = config.isDisabled?(entry) ?? false
        return HStack(spacing: 8) {
            Button {
                guard !disabled else { return }
                if let inGroup = config.onSelectInGroup { inGroup(entry, parentGroup) }
                else { config.onSelect?(entry) }
                dismissIfNeeded()
            } label: {
                HStack(spacing: 10) {
                    Image(systemName: isActive ? "checkmark.circle.fill" : "circle")
                        .foregroundStyle(isActive ? Color.accentColor : Color.secondary)
                    VStack(alignment: .leading, spacing: 4) {
                        Text(entry.model.displayName).font(.body).foregroundStyle(Color.primary)
                        Text(store.instance(for: entry.providerInstanceId)?.label ?? entry.model.provider)
                            .font(.caption).foregroundStyle(ModelPickerText.secondary)
                        if isActive { Text("Active in this group").font(.caption).foregroundStyle(.tint) }
                    }
                    Spacer(minLength: 0)
                }.frame(minHeight: 44).contentShape(Rectangle())
            }
            .buttonStyle(.borderless)
            .disabled(disabled)
            .accessibilityIdentifier("model-picker.member.\(parentGroup.id).\(entry.id)")
            .accessibilityValue(isActive ? Text("Selected") : Text("Not selected"))
            if !isSystem { favoriteButton(entry) }
        }
    }

    @ViewBuilder
    private func unavailableMemberRow(entryId: String, reason: String) -> some View {
        let entry = store.entry(for: entryId)
        HStack(spacing: 10) {
            Image(systemName: "circle")
                .font(.system(size: 17))
                .foregroundStyle(Color(UIColor.quaternaryLabel))

            if let entry {
                providerDot(entry.model.provider)
                    .opacity(0.4)

                VStack(alignment: .leading, spacing: 1) {
                    Text(entry.model.displayName)
                        .font(.subheadline)
                        .foregroundStyle(Color(UIColor.tertiaryLabel))
                    HStack(spacing: 4) {
                        if let instanceLabel = store.instance(for: entry.providerInstanceId)?.label {
                            Text(instanceLabel)
                                .font(.caption2.weight(.medium))
                                .foregroundStyle(.tertiary)
                        }
                        Text("·")
                            .font(.caption2)
                            .foregroundStyle(.quaternary)
                        Text(reason)
                            .font(.caption2)
                            .foregroundStyle(.red.opacity(0.7))
                    }
                }
            } else {
                VStack(alignment: .leading, spacing: 1) {
                    Text(entryId.components(separatedBy: "/").last ?? entryId)
                        .font(.subheadline)
                        .foregroundStyle(Color(UIColor.tertiaryLabel))
                    Text(reason)
                        .font(.caption2)
                        .foregroundStyle(.red.opacity(0.7))
                }
            }

            Spacer()
        }
    }

    // MARK: - Instance Section

    private func instanceSection(_ item: (instance: ProviderInstance, entries: [ModelEntry])) -> some View {
        let collapsed = !isSearching && collapsedInstanceIds.contains(item.instance.id)
        return Section {
            Button {
                if collapsed { collapsedInstanceIds.remove(item.instance.id) }
                else { collapsedInstanceIds.insert(item.instance.id) }
            } label: {
                HStack {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(item.instance.label).font(.headline).foregroundStyle(Color.primary)
                        Text("\(item.entries.count) models").font(.caption).foregroundStyle(ModelPickerText.secondary)
                    }
                    Spacer()
                    Image(systemName: collapsed ? "chevron.down" : "chevron.up").foregroundStyle(ModelPickerText.secondary)
                }.frame(minHeight: 44).contentShape(Rectangle())
            }
            .buttonStyle(.borderless)
            .disabled(isSearching)
            .accessibilityIdentifier("model-picker.provider.\(item.instance.id)")
            .accessibilityValue(collapsed ? Text("Collapsed") : Text("Expanded"))
            if !collapsed {
                if isMulti {
                    let selectable = item.entries.filter { !(config.isDisabled?($0) ?? false) }
                    Button(selectedEntryIds.isSuperset(of: Set(selectable.map(\.id))) ? "Clear this provider" : "Select this provider") {
                        let keys = selectable.map(\.id)
                        if selectedEntryIds.isSuperset(of: Set(keys)) {
                            selectedEntryIds.subtract(keys)
                            selectionOrder.removeAll { keys.contains($0) }
                        } else {
                            for key in keys where !selectedEntryIds.contains(key) { toggleSelection(key) }
                        }
                    }.disabled(selectable.isEmpty)
                }
                ForEach(item.entries) { entry in entryRow(entry) }
            }
        }
    }

    // MARK: - Entry Row

    private func entryRow(_ entry: ModelEntry) -> some View {
        let unavailable = isMulti ? nil : memberUnavailableReason(entry.id)
        let disabled = (config.isDisabled?(entry) ?? false) || unavailable != nil
        let traits = entry.displayTraits
        let selected: Bool = {
            if isMulti { return selectedEntryIds.contains(entry.id) }
            guard config.currentGroupId?() == nil, let eid = config.currentEntryId?() else { return false }
            if VoiceProviderResolver.isSystemEntry(entry.providerInstanceId) {
                return VoiceProviderResolver.isSystemEntry(eid) && Self.systemRowKey(eid) == Self.systemRowKey(entry.id)
            }
            return store.entry(for: eid)?.id == entry.id
        }()
        return HStack(spacing: 8) {
            Button {
                guard !disabled, !editMode.isEditing else { return }
                if isMulti { toggleSelection(entry.id) }
                else { config.onSelect?(entry); dismissIfNeeded() }
            } label: {
                HStack(alignment: .center, spacing: 10) {
                    Image(systemName: selected ? "checkmark.circle.fill" : "circle")
                        .foregroundStyle(selected ? Color.accentColor : Color.secondary)
                    VStack(alignment: .leading, spacing: 4) {
                        Text(entry.model.displayName).font(.body).foregroundStyle(Color.primary)
                            .multilineTextAlignment(.leading)
                            .fixedSize(horizontal: false, vertical: true)
                        if let provider = store.instance(for: entry.providerInstanceId) {
                            Text(provider.label).font(.caption).foregroundStyle(ModelPickerText.secondary)
                        }
                        if !isQuickBrowse || isSearching {
                            Text(traits.subtitle ?? entry.model.id)
                                .font(isSearching ? .caption2 : .caption).foregroundStyle(ModelPickerText.secondary)
                                .lineLimit(isSearching ? 1 : 2).textSelection(.disabled)
                        }
                        if disabled { Text(unavailable ?? String(localized: "Unavailable for this purpose")).font(.caption).foregroundStyle(.orange) }
                    }
                    Spacer(minLength: 0)
                }.frame(minHeight: 44).contentShape(Rectangle())
            }
            .buttonStyle(.borderless)
            .disabled(disabled)
            .frame(minHeight: 48)
            .contentShape(Rectangle())
            .accessibilityIdentifier("model-picker.entry.\(entry.id)")
            .accessibilityValue(selected ? Text("Selected") : Text("Not selected"))
            if !VoiceProviderResolver.isSystemEntry(entry.providerInstanceId) { favoriteButton(entry) }
        }
        .contextMenu {
            Button { quickTestEntry = entry } label: { Label("Quick Test", systemImage: "bolt.badge.checkmark") }
            Button {
                UIPasteboard.general.string = "entry:\(entry.compositeKey)"
                MinisToast.show(String(localized: "Copied: \(entry.model.displayName)"))
            } label: { Label("Copy Shortcut Model ID", systemImage: "link") }
        }
    }

    // MARK: - Empty State

    private var emptySection: some View {
        Section {
            VStack(spacing: 8) {
                Image(systemName: searchText.isEmpty ? "cpu" : "magnifyingglass")
                    .font(.system(size: 28))
                    .foregroundStyle(.quaternary)
                Text(searchText.isEmpty ? "No models available" : "No results")
                    .font(.subheadline)
                    .foregroundStyle(ModelPickerText.secondary)
                Text(searchText.isEmpty
                     ? "Configure providers in Settings to see models here."
                     : "Try a different search term.")
                    .font(.caption)
                    .foregroundStyle(.tertiary)
                    .multilineTextAlignment(.center)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 16)
        }
    }

    // MARK: - Helpers

    private func dismissIfNeeded() {
        if config.dismissOnSelect { dismiss() }
    }

    @ViewBuilder
    private func providerDot(_ provider: String) -> some View {
        Circle()
            .fill(providerColor(provider))
            .frame(width: 6, height: 6)
    }

    private func providerColor(_ provider: String) -> Color {
        ModelEntry.providerTint(provider)
    }

    private func modalityBadges(_ model: LLMModel) -> [String] {
        let m = model.capabilities.supportedModalities
        var badges: [String] = []
        if m.contains(.imageInput)  { badges.append("img") }
        if m.contains(.audioInput)  { badges.append("audio") }
        if m.contains(.videoInput)  { badges.append("video") }
        if m.contains(.pdfInput)    { badges.append("pdf") }
        if m.contains(.imageOutput) { badges.append("img-out") }
        if m.contains(.audioOutput) { badges.append("audio-out") }
        if m.contains(.videoOutput) { badges.append("video-out") }
        return badges
    }

    private func toggleSelection(_ entryId: String) {
        if selectedEntryIds.contains(entryId) {
            selectedEntryIds.remove(entryId)
            selectionOrder.removeAll { $0 == entryId }
        } else {
            selectedEntryIds.insert(entryId)
            selectionOrder.append(entryId)
        }
    }

    private func seedCollapse() {
        guard !collapseSeeded else { return }
        collapseSeeded = true
        if !isMulti && config.effectivePreferModality == nil {
            if config.prefersQuickSelection { browseScope = .quick }
            else if !favoriteEntries.isEmpty { browseScope = .favorites }
        }
        // Voice pickers (Voice Input / Output group binding, or an explicit audio
        // modality preference) exist specifically to browse and add TTS/ASR voices.
        // Dedicated voice providers carry many rows (Azure TTS ~39 voices, Doubao
        // 8, MiMo 9), so the default ">1 model → collapse to one row + Show N"
        // behavior hid every voice but the first behind a disclosure — users
        // reported the voices as "missing" from the Add Models list. In a voice
        // scenario, keep all sections expanded so every voice is immediately
        // visible. Non-voice pickers are unaffected.
        let prefs = config.effectivePreferModality
        let isVoiceScenario = prefs?.contains { $0 == .audioInput || $0 == .audioOutput } == true
        guard !isVoiceScenario else {
            collapsedInstanceIds = []
            return
        }
        var ids = Set<String>()
        // System is now an ordinary entry in entriesByInstance (its synthetic
        // instance), so this single loop collapses it too when it has >1 model
        // (the ~60 voice roster shouldn't fill the list).
        for item in entriesByInstance where item.entries.count > 1 {
            ids.insert(item.instance.id)
        }
        collapsedInstanceIds = ids
    }
}
