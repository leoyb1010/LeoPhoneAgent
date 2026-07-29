//
//  RemoteHostSettingsView.swift
//  MinisApp
//
//  [T-remote-exec] Settings for SSH remote hosts. Configuring the first host
//  is what makes the remote_shell / remote_agent tools appear to the agent.
//

import SwiftUI

struct RemoteHostSettingsView: View {
    @ObservedObject private var store = RemoteHostStore.shared
    @State private var editing: RemoteHost?
    @State private var showAdd = false

    var body: some View {
        List {
            Section {
                ForEach(store.hosts) { host in
                    Button {
                        editing = host
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
                    showAdd = true
                } label: {
                    Label("Add remote host", systemImage: "plus.circle.fill")
                }
            } footer: {
                Text("Once at least one host is configured, the agent gains remote_shell (run commands over SSH) and remote_agent (drive Claude Code on that machine). Heavy work runs on the remote computer; light and offline work stays on-device. Passwords are stored only in this device's Keychain.")
            }
        }
        .navigationTitle(Text("Remote Hosts"))
        .sheet(isPresented: $showAdd) { RemoteHostEditSheet(host: nil) }
        .sheet(item: $editing) { host in RemoteHostEditSheet(host: host) }
    }
}

private struct RemoteHostEditSheet: View {
    @Environment(\.dismiss) private var dismiss
    let host: RemoteHost?

    @State private var name: String
    @State private var address: String
    @State private var port: String
    @State private var username: String
    @State private var password = ""
    @State private var testResult: String?
    @State private var testing = false
    @State private var failShake = 0
    @State private var okSweep = 0

    /// [T-draft-id-stability] Fixed once — `draft` used to mint a NEW UUID on
    /// every access, so Test wrote the password under one id and Save stored
    /// the host under another, stranding the password in the Keychain forever.
    @State private var draftId: String

    init(host: RemoteHost?) {
        self.host = host
        _draftId = State(initialValue: host?.id ?? UUID().uuidString.lowercased())
        _name = State(initialValue: host?.name ?? "")
        _address = State(initialValue: host?.host ?? "")
        _port = State(initialValue: host.map { String($0.port) } ?? "22")
        _username = State(initialValue: host?.username ?? "")
    }

    private var draft: RemoteHost {
        RemoteHost(
            id: draftId,
            name: name.trimmingCharacters(in: .whitespaces),
            host: address.trimmingCharacters(in: .whitespaces),
            port: Int(port) ?? 22,
            username: username.trimmingCharacters(in: .whitespaces)
        )
    }

    private var canSave: Bool {
        !draft.name.isEmpty && !draft.host.isEmpty && !draft.username.isEmpty
            && (host != nil || !password.isEmpty)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section(String(localized: "Host")) {
                    TextField(String(localized: "Name (e.g. My Mac)"), text: $name)
                    TextField(String(localized: "Address (IP or hostname)"), text: $address)
                        .autocorrectionDisabled().textInputAutocapitalization(.never)
                        .keyboardType(.URL)
                    TextField(String(localized: "Port"), text: $port)
                        .keyboardType(.numberPad)
                    TextField(String(localized: "Username"), text: $username)
                        .autocorrectionDisabled().textInputAutocapitalization(.never)
                }
                Section {
                    SecureField(host == nil
                        ? String(localized: "Password")
                        : String(localized: "Password (leave empty to keep current)"), text: $password)
                } footer: {
                    Text("Stored in the local Keychain only — never synced, never logged. On a Mac, enable System Settings → Sharing → Remote Login first.")
                }
                Section {
                    Button {
                        runTest()
                    } label: {
                        if testing { ProgressView() } else { Label("Test connection", systemImage: "bolt.horizontal") }
                    }
                    .disabled(!canSave && password.isEmpty)
                    if let testResult {
                        Text(testResult)
                            .font(.caption.monospaced())
                            .foregroundStyle(testResult.contains("LEO_OK") ? .green : .red)
                            .leoShake(trigger: failShake)
                            .leoShineSweep(trigger: okSweep)
                    }
                }
            }
            .navigationTitle(Text(host == nil ? "Add Host" : "Edit Host"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(String(localized: "Cancel")) { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(String(localized: "Save")) {
                        RemoteHostStore.shared.upsert(draft, password: password.isEmpty ? nil : password)
                        dismiss()
                    }
                    .disabled(!canSave)
                }
            }
        }
    }

    private func runTest() {
        let candidate = draft
        let pw = password
        testing = true
        testResult = nil
        Task {
            // Use the typed password when present so testing works pre-save.
            if !pw.isEmpty { RemoteHostStore.setPassword(pw, hostId: candidate.id) }
            let result = await RemoteSSHExecutor.shared.test(host: candidate)
            await MainActor.run {
                testing = false
                testResult = String(result.output.prefix(300))
                if result.output.contains("LEO_OK") { okSweep += 1 } else { failShake += 1 }
            }
        }
    }
}
