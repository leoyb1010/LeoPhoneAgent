//
//  RemoteHostSettingsView.swift
//  MinisApp
//
//  [T-remote-exec] Settings for SSH remote hosts. Configuring the first host
//  is what makes the remote_shell / remote_agent tools appear to the agent.
//
//  [T-remote-form-state-reset] Rewritten after "typed text vanishes": the
//  first version attached TWO .sheet modifiers to one view (undefined
//  behaviour) and forced a Section rebuild via .id() — either can hand the
//  sheet content a fresh identity mid-typing, wiping every @State field.
//  Now: ONE .sheet(item:) whose item id is stable for the sheet's lifetime,
//  and all mutable fields live in a @StateObject that SwiftUI keeps alive
//  for that identity no matter how often the body re-evaluates.
//

import SwiftUI

/// Stable sheet item: `id` never changes while the sheet is up, for both the
/// add case (fresh UUID minted once) and the edit case (the host's own id).
private struct HostSheetItem: Identifiable {
    let id: String
    let host: RemoteHost?

    static func add() -> HostSheetItem { HostSheetItem(id: UUID().uuidString.lowercased(), host: nil) }
    static func edit(_ host: RemoteHost) -> HostSheetItem { HostSheetItem(id: host.id, host: host) }
}

struct RemoteHostSettingsView: View {
    @ObservedObject private var store = RemoteHostStore.shared
    @State private var sheetItem: HostSheetItem?

    var body: some View {
        List {
            Section {
                ForEach(store.hosts) { host in
                    Button {
                        sheetItem = .edit(host)
                    } label: {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(host.name).font(.body.weight(.medium)).foregroundStyle(.primary)
                            Text("\(host.username)@\(host.host):\(String(host.port))")
                                .font(.caption.monospaced()).foregroundStyle(.secondary)
                        }
                    }
                }
                .onDelete { offsets in
                    let ids = offsets.map { store.hosts[$0].id }
                    for id in ids { store.delete(id: id) }
                }
                Button {
                    sheetItem = .add()
                } label: {
                    Label("Add remote host", systemImage: "plus.circle.fill")
                }
            } footer: {
                Text("Once at least one host is configured, the agent gains remote_shell (run commands over SSH) and remote_agent (drive Claude Code on that machine). Heavy work runs on the remote computer; light and offline work stays on-device. Passwords are stored only in this device's Keychain.")
            }
        }
        .navigationTitle(Text("Remote Hosts"))
        .sheet(item: $sheetItem) { item in
            RemoteHostEditSheet(sheetId: item.id, host: item.host)
        }
    }
}

/// All mutable form state, identity-stable for the sheet's lifetime.
@MainActor
private final class HostEditModel: ObservableObject {
    let draftId: String
    let isEditing: Bool
    @Published var name: String
    @Published var address: String
    @Published var port: String
    @Published var username: String
    @Published var password = ""
    @Published var testResult: String?
    @Published var testing = false
    @Published var failShake = 0
    @Published var okSweep = 0
    @Published var pubkey: String?

    init(sheetId: String, host: RemoteHost?) {
        draftId = host?.id ?? sheetId
        isEditing = host != nil
        name = host?.name ?? ""
        address = host?.host ?? ""
        port = host.map { String($0.port) } ?? "22"
        username = host?.username ?? ""
        pubkey = RemoteHostStore.devicePublicKeyLine()
    }

    var draft: RemoteHost {
        RemoteHost(
            id: draftId,
            name: name.trimmingCharacters(in: .whitespaces),
            host: address.trimmingCharacters(in: .whitespaces),
            port: Int(port) ?? 22,
            username: username.trimmingCharacters(in: .whitespaces)
        )
    }

    var canSave: Bool {
        !draft.name.isEmpty && !draft.host.isEmpty && !draft.username.isEmpty
    }

    func runTest() {
        let candidate = draft
        let pw = password
        testing = true
        testResult = nil
        Task {
            if !pw.isEmpty { RemoteHostStore.setPassword(pw, hostId: candidate.id) }
            let result = await RemoteSSHExecutor.shared.test(host: candidate)
            await MainActor.run {
                self.testing = false
                self.testResult = String(result.output.prefix(400))
                if result.output.contains("LEO_OK") { self.okSweep += 1 } else { self.failShake += 1 }
            }
        }
    }

    func generateKey() {
        _ = RemoteHostStore.ensureDeviceKey()
        pubkey = RemoteHostStore.devicePublicKeyLine()
    }

    func save() {
        RemoteHostStore.shared.upsert(draft, password: password.isEmpty ? nil : password)
    }
}

private struct RemoteHostEditSheet: View {
    @Environment(\.dismiss) private var dismiss
    @StateObject private var model: HostEditModel

    init(sheetId: String, host: RemoteHost?) {
        _model = StateObject(wrappedValue: HostEditModel(sheetId: sheetId, host: host))
    }

    var body: some View {
        NavigationStack {
            Form {
                Section(String(localized: "Host")) {
                    TextField(String(localized: "Name (e.g. My Mac)"), text: $model.name)
                    TextField(String(localized: "Address (IP or hostname)"), text: $model.address)
                        .autocorrectionDisabled().textInputAutocapitalization(.never)
                        .keyboardType(.URL)
                    TextField(String(localized: "Port"), text: $model.port)
                        .keyboardType(.numberPad)
                    TextField(String(localized: "Username"), text: $model.username)
                        .autocorrectionDisabled().textInputAutocapitalization(.never)
                }
                Section {
                    SecureField(String(localized: "Password (optional — leave empty for key auth)"), text: $model.password)
                } footer: {
                    Text("Stored in the local Keychain only — never synced, never logged. On a Mac, enable System Settings → Sharing → Remote Login first.")
                }
                Section {
                    if let pubkey = model.pubkey {
                        Text(pubkey)
                            .font(.caption2.monospaced())
                            .lineLimit(3)
                            .textSelection(.enabled)
                        Button {
                            UIPasteboard.general.string = pubkey
                        } label: {
                            Label("Copy public key", systemImage: "doc.on.doc")
                        }
                    } else {
                        Button {
                            model.generateKey()
                        } label: {
                            Label("Generate device key", systemImage: "key.fill")
                        }
                    }
                } header: {
                    Text("Key authentication (recommended)")
                } footer: {
                    Text("Generate once, then on the computer run:  echo '<public key>' >> ~/.ssh/authorized_keys — after that no password is needed. If the address starts with 100.x (Tailscale), the Tailscale app on this device must be connected.")
                }
                Section {
                    Button {
                        model.runTest()
                    } label: {
                        if model.testing { ProgressView() } else { Label("Test connection", systemImage: "bolt.horizontal") }
                    }
                    .disabled(!model.canSave)
                    if let testResult = model.testResult {
                        Text(testResult)
                            .font(.caption.monospaced())
                            .foregroundStyle(testResult.contains("LEO_OK") ? .green : .red)
                            .leoShake(trigger: model.failShake)
                            .leoShineSweep(trigger: model.okSweep)
                    }
                }
            }
            .navigationTitle(Text(model.isEditing ? "Edit Host" : "Add Host"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(String(localized: "Cancel")) {
                        // A pre-save Test stored the typed password under the
                        // draft id; cancelling must not strand it in Keychain.
                        if !model.isEditing { RemoteHostStore.deletePassword(hostId: model.draftId) }
                        dismiss()
                    }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(String(localized: "Save")) {
                        model.save()
                        dismiss()
                    }
                    .disabled(!model.canSave)
                }
            }
        }
    }
}
