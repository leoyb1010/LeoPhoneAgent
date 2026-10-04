import SwiftUI
import UIKit

struct EnvironmentVariablesView: View {
    @StateObject private var store = EnvVarStore.shared
    @StateObject private var privacy = EnvVarPrivacyStore.shared
    @ObservedObject private var deepLink = DeepLinkCoordinator.shared
    @State private var searchText = ""
    @State private var showingAddSheet = false
    @State private var editingEntry: EnvVarEntry?
    /// [T-envvar-secret-handling] Values of the rows the user revealed (entry
    /// id → value), read from the Keychain on tap. Rows no longer read the
    /// Keychain on every render just to draw the mask.
    @State private var revealedValues: [String: String] = [:]
    @State private var copiedId: String?
    @State private var prefillKey = ""
    @State private var prefillValue = ""
    @State private var prefillNote = ""
    @State private var overwriteConfirm: OverwriteRequest?
    /// Swipe-delete waiting for confirmation: the value is a secret that
    /// can't be recovered once the Keychain item is gone.
    @State private var pendingDelete: EnvVarEntry?
    @State private var saveError: String?
    /// A delete also reaches the user's other devices while iCloud sync is on
    /// (EnvVarItem op=delete); the confirmations say so.
    @AppStorage("cloudSync.v2.enabled") private var iCloudSyncEnabled: Bool = SyncV2Bootstrap.isEnabled

    private struct OverwriteRequest: Identifiable {
        let id = UUID()
        let entryId: String
        let key: String
        let newValue: String
        /// The variable exists but has no value yet.
        let currentIsEmpty: Bool
    }

    private var filteredEntries: [EnvVarEntry] {
        if searchText.isEmpty {
            return store.entries
        }
        return store.entries.filter { $0.key.localizedCaseInsensitiveContains(searchText) }
    }

    var body: some View {
        List {
            if let saveError {
                Text(saveError).foregroundStyle(.red).font(.footnote)
            }
            Section {
                Toggle("Privacy Mode", isOn: $privacy.enabled)
            } footer: {
                Text("When enabled, any environment variable value that appears in shell-execute output is replaced with a masked form (e.g. `sk-1********ajhks`) before reaching the model. Values shorter than 8 characters become all `*`. The user-visible output in chat is unchanged.")
            }

            if store.entries.isEmpty {
                Section {
                    VStack(spacing: 8) {
                        Image(systemName: "terminal")
                            .font(.largeTitle)
                            .foregroundStyle(.secondary)
                        Text("No Environment Variables")
                            .font(.headline)
                        Text("Add variables like API keys or tokens that will be available in the shell environment.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .multilineTextAlignment(.center)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 20)
                }
            } else {
                ForEach(filteredEntries) { entry in
                    envVarRow(entry)
                }
                .onDelete(perform: deleteEntries)
            }
        }
        .listStyle(.insetGrouped)
        .alert(String(localized: "Delete Variable"), isPresented: Binding(
            get: { pendingDelete != nil },
            set: { if !$0 { pendingDelete = nil } }
        )) {
            Button(String(localized: "Delete"), role: .destructive) {
                if let id = pendingDelete?.id { store.delete(id: id) }
                pendingDelete = nil
            }
            Button(String(localized: "Cancel"), role: .cancel) { pendingDelete = nil }
        } message: {
            // 值存在可同步的钥匙串里:不管 App 的 iCloud 同步开没开,删掉都会跟着 iCloud 钥匙串同步到别的设备。
            Text(String(localized: "Delete \(pendingDelete?.key ?? "")? This can't be undone. With iCloud Keychain on, the value is also removed on your other devices."))
        }
        .searchable(text: $searchText, prompt: "Filter by name")
        .navigationTitle("Environment Variables")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    showingAddSheet = true
                } label: {
                    Image(systemName: "plus")
                }
            }
        }
        .sheet(isPresented: $showingAddSheet) {
            EnvVarFormSheet(mode: .add, initialKey: prefillKey, initialValue: prefillValue, initialNote: prefillNote,
                            syncOn: iCloudSyncEnabled) { key, value, note in
                store.add(key: key, value: value, note: note)
            }
            .onDisappear {
                prefillKey = ""
                prefillValue = ""
                prefillNote = ""
            }
        }
        .onAppear {
            if let pending = deepLink.pendingEnvVarCreate {
                let normalizedKey = pending.key.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
                deepLink.pendingEnvVarCreate = nil
                if let existing = store.entries.first(where: { $0.key == normalizedKey }) {
                    let currentValue = store.value(forKey: existing.key) ?? ""
                    // [T-envvar-deeplink-confirm] A link never writes a value
                    // without asking — an existing empty variable included.
                    if currentValue != pending.value {
                        overwriteConfirm = OverwriteRequest(
                            entryId: existing.id,
                            key: existing.key,
                            newValue: pending.value,
                            currentIsEmpty: currentValue.isEmpty
                        )
                    }
                } else {
                    prefillKey = pending.key
                    prefillValue = pending.value
                    prefillNote = pending.note
                    showingAddSheet = true
                }
            }
        }
        .alert(
            overwriteConfirm?.currentIsEmpty == true
                ? String(localized: "Set value from link?")
                : String(localized: "Replace existing value?"),
            isPresented: Binding(
                get: { overwriteConfirm != nil },
                set: { if !$0 { overwriteConfirm = nil } }
            ),
            presenting: overwriteConfirm
        ) { request in
            Button(request.currentIsEmpty ? String(localized: "Save") : String(localized: "Replace"),
                   role: .destructive) {
                switch store.update(id: request.entryId, key: request.key, value: request.newValue) {
                case .success:
                    saveError = nil
                    revealedValues[request.entryId] = nil
                case .failure(let error):
                    if case .valueChangedMetadataWriteFailed = error { revealedValues[request.entryId] = nil }
                    saveError = error.localizedDescription
                }
            }
            Button(String(localized: "Cancel"), role: .cancel) {}
        } message: { request in
            // The new value is a secret: never shown in clear here.
            Text(request.currentIsEmpty
                 ? String(localized: "\"\(request.key)\" has no value yet. Set it to the value from the link?")
                 : String(localized: "\"\(request.key)\" already has a value. Replace it with the value from the link?"))
        }
        .sheet(item: $editingEntry) { entry in
            EnvVarFormSheet(
                mode: .edit,
                initialKey: entry.key,
                initialValue: store.value(forKey: entry.key) ?? "",
                initialNote: entry.note,
                syncOn: iCloudSyncEnabled,
                onSave: { key, value, note in
                    let result = store.update(id: entry.id, key: key, value: value, note: note)
                    switch result {
                    case .success: revealedValues[entry.id] = nil
                    case .failure(.valueChangedMetadataWriteFailed): revealedValues[entry.id] = nil
                    case .failure: break
                    }
                    return result
                },
                onDelete: {
                    store.delete(id: entry.id)
                    revealedValues[entry.id] = nil
                }
            )
        }
    }

    @ViewBuilder
    private func envVarRow(_ entry: EnvVarEntry) -> some View {
        let revealedValue = revealedValues[entry.id]
        let isRevealed = revealedValue != nil

        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(entry.key)
                    .font(.system(.body, design: .monospaced))
                    .fontWeight(.medium)
                // Fixed-width mask: no Keychain read per render, and it doesn't hint at the length.
                Text(verbatim: revealedValue ?? String(repeating: "\u{2022}", count: 8))
                    .font(.system(.caption, design: .monospaced))
                    .foregroundStyle(.secondary)
                if !entry.note.isEmpty {
                    Text(entry.note)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }

            Spacer()

            HStack(spacing: 10) {
                Button {
                    if isRevealed {
                        revealedValues[entry.id] = nil
                    } else {
                        revealedValues[entry.id] = store.value(forKey: entry.key) ?? ""
                    }
                } label: {
                    Image(systemName: isRevealed ? "eye.slash" : "eye")
                        .font(.system(size: 14))
                        .foregroundStyle(.secondary)
                }
                .buttonStyle(.plain)

                Button {
                    // Local-only and expiring: a secret must not ride Universal
                    // Clipboard to other devices or stay on the pasteboard.
                    SecretPasteboard.copy("\(entry.key)=\(store.value(forKey: entry.key) ?? "")")
                    withAnimation { copiedId = entry.id }
                    DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
                        withAnimation { if copiedId == entry.id { copiedId = nil } }
                    }
                } label: {
                    Image(systemName: copiedId == entry.id ? "checkmark" : "doc.on.clipboard")
                        .font(.system(size: 13))
                        .foregroundStyle(copiedId == entry.id ? .green : .secondary)
                }
                .buttonStyle(.plain)
            }
        }
        .contentShape(Rectangle())
        .onTapGesture {
            editingEntry = entry
        }
    }

    private func deleteEntries(at offsets: IndexSet) {
        guard let first = offsets.first else { return }
        pendingDelete = filteredEntries[first]
    }
}

// MARK: - Form Sheet

private struct EnvVarFormSheet: View {
    enum Mode { case add, edit }

    let mode: Mode
    var initialKey: String = ""
    var initialValue: String = ""
    var initialNote: String = ""
    /// iCloud sync on: a delete also removes it on the user's other devices.
    var syncOn: Bool = false
    let onSave: (String, String, String) -> Result<Void, EnvVarStore.MutationError>
    var onDelete: (() -> Void)? = nil

    @Environment(\.dismiss) private var dismiss
    @State private var key = ""
    @State private var value = ""
    @State private var note = ""
    @State private var showingDeleteConfirm = false
    @State private var saveError: String?
    /// [T-envvar-secret-handling] The value is masked unless the user asks to see it.
    @State private var showValue = false
    @FocusState private var focusedField: Field?

    private enum Field: Hashable { case key, value, note }

    private var isValid: Bool {
        EnvVarStore.isValidKey(key)
    }

    var body: some View {
        NavigationStack {
            Form {
                if let saveError {
                    Section { Text(saveError).foregroundStyle(.red).font(.footnote) }
                }
                Section {
                    TextField("NAME", text: Binding(
                        get: { key },
                        set: { key = $0.uppercased() }
                    ))
                    .font(.system(.body, design: .monospaced))
                    .textInputAutocapitalization(.characters)
                    .autocorrectionDisabled()
                    .focused($focusedField, equals: .key)
                    .submitLabel(.next)
                    .onSubmit { focusedField = .value }
                } header: {
                    Text("Name")
                } footer: {
                    if !key.isEmpty && !isValid {
                        Text("Must start with a letter and contain only letters, digits, and underscores.")
                            .foregroundStyle(.red)
                    }
                }

                Section("Value") {
                    HStack {
                        Group {
                            if showValue {
                                TextField("Value", text: $value)
                            } else {
                                SecureField("Value", text: $value)
                            }
                        }
                        .font(.system(.body, design: .monospaced))
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
                        .focused($focusedField, equals: .value)
                        .submitLabel(.next)
                        .onSubmit { focusedField = .note }
                        Button {
                            showValue.toggle()
                        } label: {
                            Image(systemName: showValue ? "eye.slash" : "eye")
                                .foregroundStyle(.secondary)
                        }
                        .buttonStyle(.borderless)
                        .accessibilityLabel(showValue ? String(localized: "Hide value") : String(localized: "Show value"))
                    }
                }

                Section("Note") {
                    ZStack(alignment: .topLeading) {
                        if note.isEmpty {
                            Text("Describe what this variable is for (optional)")
                                .foregroundStyle(.secondary)
                                .padding(.horizontal, 4)
                                .padding(.vertical, 8)
                                .allowsHitTesting(false)
                        }
                        TextEditor(text: $note)
                            .frame(minHeight: 80)
                            .focused($focusedField, equals: .note)
                            .scrollContentBackground(.hidden)
                    }
                }

                if mode == .edit, onDelete != nil {
                    Section {
                        Button(role: .destructive) {
                            showingDeleteConfirm = true
                        } label: {
                            Label {
                                Text("Delete Variable")
                            } icon: {
                                Image(systemName: "trash.fill")
                                    .font(.system(size: 9))
                                    .foregroundStyle(.white)
                                    .frame(width: 21, height: 21)
                                    .background(.red, in: Circle())
                            }
                        }
                    }
                }
            }
            .navigationTitle(mode == .add ? "Add Variable" : "Edit Variable")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(mode == .add ? "Add" : "Save") {
                        switch onSave(key, value, note.trimmingCharacters(in: .whitespacesAndNewlines)) {
                        case .success: dismiss()
                        case .failure(let error): saveError = error.localizedDescription
                        }
                    }
                    .disabled(!isValid)
                }
            }
        }
        .presentationDetents([.medium, .large])
        .alert(
            String(localized: "Delete this variable?"),
            isPresented: $showingDeleteConfirm
        ) {
            Button(String(localized: "Delete"), role: .destructive) {
                onDelete?()
                dismiss()
            }
            Button(String(localized: "Cancel"), role: .cancel) {}
        } message: {
            Text(String(localized: "This can't be undone. With iCloud Keychain on, the value is also removed on your other devices."))
        }
        .onAppear {
            key = initialKey
            value = initialValue
            note = initialNote
        }
        // Use .task instead of onAppear+DispatchQueue: the wait is cancellable
        // (sheet dismissed mid-animation cancels cleanly) and we can resign any
        // existing first responder in the parent view tree first — otherwise
        // the chat input / iSH terminal can keep firstResponder and iOS
        // suppresses the sheet's keyboard intermittently.
        .task {
            // Resign any first responder owned by the presenting view tree so
            // UIKit doesn't hand the keyboard back to it when the sheet's
            // TextField asks for focus.
            UIApplication.shared.sendAction(
                #selector(UIResponder.resignFirstResponder),
                to: nil, from: nil, for: nil
            )
            // Wait for the sheet's present/detent animation to settle before
            // requesting focus. 0.45s covers both .medium and .large detents
            // on slower devices; if the sheet is dismissed sooner, .task is
            // cancelled and focus is never set.
            try? await Task.sleep(nanoseconds: 450_000_000)
            if mode == .add {
                focusedField = .key
            }
        }
    }
}

/// [T-delete-sync-warning] Env var, skill and MCP deletes are pushed to the
/// user's other devices while iCloud sync is on (op=delete records), so their
/// confirmations append a line saying so. Callers pass whether that applies.
enum SyncedDeleteMessage {
    static func text(_ base: String, syncOn: Bool) -> String {
        syncOn ? base + "\n" + String(localized: "iCloud sync is on, so it's also deleted on your other devices.") : base
    }
}
