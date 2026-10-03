import SwiftUI

/// In-session model picker — thin wrapper around `UnifiedModelPicker` that adds
/// session binding logic and the non-text-output confirmation alert.
struct SessionModelPicker: View {
    let sessionId: String?
    var ensureSessionId: (() async -> String)?
    var draftChoice: String? = nil
    var onPick: ((String) -> Void)? = nil
    @ObservedObject private var store = ProviderConfigStore.shared
    @Environment(\.dismiss) private var dismiss
    @State private var pendingNonTextOutput: PendingSelection?
    @State private var selectionFailure: String?
    @State private var isCommitting = false

    private struct PendingSelection: Identifiable {
        let id = UUID()
        let entry: ModelEntry
        let group: ModelGroup?
        let modalityLabel: String
        let isGroupBind: Bool
    }

    init(sessionId: String?, ensureSessionId: (() async -> String)? = nil,
         draftChoice: String? = nil, onPick: ((String) -> Void)? = nil) {
        self.sessionId = sessionId
        self.ensureSessionId = ensureSessionId
        self.draftChoice = draftChoice
        self.onPick = onPick
    }

    private var currentEntryId: String? {
        if onPick != nil { return draftChoice.flatMap { store.entry(for: $0)?.id } }
        guard let sid = sessionId,
              let binding = store.binding(for: sid) else { return nil }
        switch binding.primarySource {
        case .directEntry(let entryId, let composite): return store.entry(for: composite ?? entryId)?.id ?? entryId
        case .group(_, let resolvedEntryId): return store.entry(for: resolvedEntryId)?.id ?? resolvedEntryId
        }
    }

    private var currentGroupId: String? {
        if onPick != nil {
            guard let draftChoice else { return store.defaultPrimaryGroupId }
            return draftChoice.hasPrefix("group:") ? String(draftChoice.dropFirst(6)) : nil
        }
        guard let sid = sessionId else { return store.defaultPrimaryGroupId }
        guard let binding = store.binding(for: sid) else {
            return store.defaultPrimaryGroupId
        }
        if case .group(let groupId, _) = binding.primarySource {
            return groupId
        }
        return nil
    }

    var body: some View {
        UnifiedModelPicker(config: .init(
            title: "Choose Model",
            mode: .single,
            groupScope: .all,
            headerNote: onPick != nil
                ? String(localized: "Choose for your next chat. Your saved default stays the same.")
                : String(localized: "Changes this conversation only. Manage groups to change defaults for new chats."),
            dismissOnSelect: false,
            currentEntryId: { [self] in currentEntryId },
            currentGroupId: { [self] in currentGroupId },
            onSelect: { entry in handleEntryTap(entry) },
            onSelectGroup: { group in handleGroupTap(group) },
            onSelectInGroup: { entry, group in handleEntryTap(entry, inGroup: group) }
        ))
        .disabled(isCommitting)
        .alert("Could not select model", isPresented: Binding(
            get: { selectionFailure != nil }, set: { if !$0 { selectionFailure = nil } }
        )) {
            Button("OK", role: .cancel) { selectionFailure = nil }
        } message: { Text(selectionFailure ?? "") }
        .alert(
            String(localized: "This model may not work as an Agent"),
            isPresented: Binding(
                get: { pendingNonTextOutput != nil },
                set: { if !$0 { pendingNonTextOutput = nil } }
            ),
            presenting: pendingNonTextOutput
        ) { selection in
            Button(String(localized: "Choose another model"), role: .cancel) {
                pendingNonTextOutput = nil
            }
            Button(String(localized: "Use anyway")) {
                let entry = selection.entry
                let group = selection.group
                let isGroupBind = selection.isGroupBind
                pendingNonTextOutput = nil
                if isGroupBind, let group {
                    bindToGroup(group)
                } else {
                    bindToEntry(entry, inGroup: group)
                }
            }
        } message: { selection in
            Text(String(localized: "\(selection.entry.model.displayName) outputs \(selection.modalityLabel) and usually can't drive an Agent task. Pick a text-output model for the session, or add this model to Available Models in Agent Loop so the agent can call it via minis-model-use when it needs to generate \(selection.modalityLabel)."))
        }
    }

    // MARK: - Non-text output guard

    private func nonTextOutputLabel(for model: LLMModel) -> String? {
        guard let modality = model.modalityOverride else { return nil }
        if modality.contains(.imageOutput) { return String(localized: "image") }
        if modality.contains(.audioOutput) { return String(localized: "audio") }
        if modality.contains(.videoOutput) { return String(localized: "video") }
        return nil
    }

    private func handleEntryTap(_ entry: ModelEntry, inGroup group: ModelGroup? = nil) {
        if let label = nonTextOutputLabel(for: entry.model) {
            pendingNonTextOutput = PendingSelection(entry: entry, group: group, modalityLabel: label, isGroupBind: false)
            return
        }
        bindToEntry(entry, inGroup: group)
    }

    private func handleGroupTap(_ group: ModelGroup) {
        let sid = sessionId ?? "draft"
        guard let resolvedEntryId = ModelGroupRouter.resolve(group: group, sessionId: sid, store: store),
              let resolvedEntry = store.entry(for: resolvedEntryId) else {
            bindToGroup(group)
            return
        }
        if let label = nonTextOutputLabel(for: resolvedEntry.model) {
            pendingNonTextOutput = PendingSelection(entry: resolvedEntry, group: group, modalityLabel: label, isGroupBind: true)
            return
        }
        bindToGroup(group)
    }

    // MARK: - Session Binding

    private func resolveSessionId() async -> String? {
        if let sid = sessionId, !sid.isEmpty { return sid }
        let sid = await ensureSessionId?()
        return sid?.isEmpty == false ? sid : nil
    }

    private func bindToGroup(_ group: ModelGroup) {
        if let onPick {
            guard let live = store.group(for: group.id),
                  ModelGroupRouter.resolve(group: live, sessionId: "draft", store: store, verbose: false) != nil else {
                selectionFailure = String(localized: "This group has no available models. Check its members and provider sign-in.")
                return
            }
            onPick("group:\(live.id)")
            dismiss()
            return
        }
        guard !isCommitting else { return }
        isCommitting = true
        Task {
            defer { isCommitting = false }
            guard let sid = await resolveSessionId() else {
                selectionFailure = String(localized: "The conversation is not ready. Try again.")
                return
            }
            guard await ModelSwitcher.apply(choiceId: "group:\(group.id)", sessionId: sid, store: store) else {
                selectionFailure = String(localized: "This group has no available models. Check its members and provider sign-in.")
                return
            }
            dismiss()
        }
    }

    private func bindToEntry(_ entry: ModelEntry, inGroup group: ModelGroup? = nil) {
        if let onPick {
            guard let live = store.entry(for: entry.id), ModelSwitcher.isAvailable(live, store: store) else {
                selectionFailure = String(localized: "This model is no longer available. Choose another model.")
                return
            }
            // The draft contract stores a choice, not a session or default.
            onPick(live.id)
            dismiss()
            return
        }
        guard !isCommitting else { return }
        isCommitting = true
        Task {
            defer { isCommitting = false }
            guard let sid = await resolveSessionId() else {
                selectionFailure = String(localized: "The conversation is not ready. Try again.")
                return
            }
            if let group {
                // Picking a member keeps the existing routing-group contract.
                // Re-read admission after await: sync may have changed the model.
                guard let liveGroup = store.group(for: group.id),
                      liveGroup.memberEntryIds.contains(where: { store.normalizeEntryRef($0) == entry.id }),
                      let liveEntry = store.entry(for: entry.id), !liveEntry.isHidden,
                      let provider = store.instance(for: liveEntry.providerInstanceId),
                      provider.isEnabled, provider.hasAnyCredential, !provider.isRetiredSignIn else {
                    selectionFailure = String(localized: "This model is no longer available. Choose another model.")
                    return
                }
                let existing = store.binding(for: sid)
                guard store.setBinding(SessionModelBinding(
                    sessionId: sid,
                    primarySource: .group(groupId: liveGroup.id, resolvedEntryId: liveEntry.id),
                    subModelSource: existing?.subModelSource), for: sid) else {
                    selectionFailure = String(localized: "Could not save model changes. Your previous configuration was kept. Try again.")
                    return
                }
                NotificationCenter.default.post(name: .sessionModelBindingChanged, object: nil,
                    userInfo: ["groupId": liveGroup.id, "sessionId": sid])
                ModelSwitcher.remember("group:\(liveGroup.id)")
                await ChatStore.shared.updateSessionModelId(sid, modelId: liveEntry.model.id)
            } else if !(await ModelSwitcher.apply(choiceId: entry.id, sessionId: sid, store: store)) {
                selectionFailure = String(localized: "This model is no longer available. Choose another model.")
                return
            }
            dismiss()
        }
    }

}

// MARK: - Compact Display Helper

@MainActor
struct SessionModelDisplay {
    let store: ProviderConfigStore
    var draftGroupId: String? = nil
    /// [T-home-model-pick] Model entry the Home capsule picked for a draft (compositeKey).
    var draftEntryKey: String? = nil

    private var draftEntry: ModelEntry? {
        draftEntryKey.flatMap { store.entry(for: $0) }
    }

    func displayName(for sessionId: String?) -> String {
        if sessionId == nil, let entry = draftEntry {
            return entry.model.displayName
        }
        if sessionId == nil, let gid = draftGroupId,
           let group = store.group(for: gid) {
            return group.name
        }
        guard let sid = sessionId,
              let binding = store.binding(for: sid) else {
            return defaultDisplayName()
        }

        switch binding.primarySource {
        case .directEntry(let entryId, _):
            if let entry = store.entry(for: entryId) {
                return entry.model.displayName
            }
            return entryId
        case .group(let groupId, _):
            return store.group(for: groupId)?.name ?? String(localized: "Group")
        }
    }

    func resolvedDetail(for sessionId: String?) -> (providerLabel: String, modelName: String)? {
        if sessionId == nil, let entry = draftEntry {
            guard let instance = store.instance(for: entry.providerInstanceId) else { return nil }
            return (instance.label, entry.model.displayName)
        }
        if sessionId == nil, let gid = draftGroupId {
            return resolvedDetail(forGroupId: gid)
        }
        guard let sid = sessionId,
              let binding = store.binding(for: sid) else {
            return defaultResolvedDetail()
        }

        let entryId: String
        switch binding.primarySource {
        case .directEntry(let eid, _): entryId = eid
        case .group(_, let eid): entryId = eid
        }

        guard let entry = store.entry(for: entryId),
              let instance = store.instance(for: entry.providerInstanceId) else { return nil }
        return (instance.label, entry.model.displayName)
    }

    private func defaultResolvedDetail() -> (providerLabel: String, modelName: String)? {
        guard let groupId = store.defaultPrimaryGroupId else { return nil }
        return resolvedDetail(forGroupId: groupId)
    }

    /// [T-codex-fast-mode] Resolve the ProviderInstance AND model id behind
    /// the session's active model — same resolution order as resolvedDetail
    /// (draft group → binding → default group). Callers inspect
    /// credentialType/providerType/model (e.g. the "..." menu's Fast Mode
    /// gate: Responses-API providers with a gpt-family model).
    func resolvedInstanceAndModel(for sessionId: String?) -> (instance: ProviderInstance, modelId: String)? {
        if sessionId == nil, let entry = draftEntry {
            guard let instance = store.instance(for: entry.providerInstanceId) else { return nil }
            return (instance, entry.model.id)
        }
        if sessionId == nil, let gid = draftGroupId {
            return resolvedInstanceAndModel(forGroupId: gid)
        }
        guard let sid = sessionId,
              let binding = store.binding(for: sid) else {
            guard let groupId = store.defaultPrimaryGroupId else { return nil }
            return resolvedInstanceAndModel(forGroupId: groupId)
        }
        let entryId: String
        switch binding.primarySource {
        case .directEntry(let eid, _): entryId = eid
        case .group(_, let eid): entryId = eid
        }
        guard let entry = store.entry(for: entryId),
              let instance = store.instance(for: entry.providerInstanceId) else { return nil }
        return (instance, entry.model.id)
    }

    private func resolvedInstanceAndModel(forGroupId groupId: String) -> (instance: ProviderInstance, modelId: String)? {
        guard let group = store.group(for: groupId) else { return nil }
        let resolved = group.memberEntryIds.lazy.compactMap { eid -> (ProviderInstance, String)? in
            guard let entry = store.entry(for: eid), !entry.isHidden,
                  let instance = store.instance(for: entry.providerInstanceId),
                  instance.isEnabled, instance.hasAnyCredential else { return nil }
            return (instance, entry.model.id)
        }.first
        if let resolved { return resolved }
        guard let firstEntryId = group.memberEntryIds.first,
              let entry = store.entry(for: firstEntryId),
              let instance = store.instance(for: entry.providerInstanceId) else { return nil }
        return (instance, entry.model.id)
    }

    private func resolvedDetail(forGroupId groupId: String) -> (providerLabel: String, modelName: String)? {
        guard let group = store.group(for: groupId) else { return nil }
        let resolved = group.memberEntryIds.lazy.compactMap { eid -> (ProviderInstance, ModelEntry)? in
            guard let entry = store.entry(for: eid), !entry.isHidden,
                  let instance = store.instance(for: entry.providerInstanceId),
                  instance.isEnabled, instance.hasAnyCredential else { return nil }
            return (instance, entry)
        }.first
        if let (instance, entry) = resolved {
            return (instance.label, entry.model.displayName)
        }
        guard let firstEntryId = group.memberEntryIds.first,
              let entry = store.entry(for: firstEntryId),
              let instance = store.instance(for: entry.providerInstanceId) else { return nil }
        return (instance.label, entry.model.displayName)
    }

    func isGroupBound(for sessionId: String?) -> Bool {
        if sessionId == nil, let gid = draftGroupId,
           store.group(for: gid) != nil {
            return true
        }
        guard let sid = sessionId,
              let binding = store.binding(for: sid) else { return false }
        if case .group = binding.primarySource { return true }
        return false
    }

    private func defaultDisplayName() -> String {
        if let groupId = store.defaultPrimaryGroupId,
           let group = store.group(for: groupId) {
            return group.name
        }
        return String(localized: "No model selected")
    }
}
