//
//  GatewayViews.swift
//  MinisApp
//
//  [T-leogateway] The two screens that make a remote gateway usable:
//  a host editor, and a console that follows one remote run live.
//
//  Both are additive — with no host configured the settings row still shows
//  (so the feature is discoverable) but nothing connects, and no existing
//  screen changes behaviour.
//

import SwiftUI

// MARK: - Settings

struct GatewaySettingsView: View {
    @StateObject private var store = GatewayHostStore.shared
    @State private var editing: GatewayHostDraft?
    @State private var reachable: [String: Bool] = [:]

    var body: some View {
        List {
            Section {
                if store.hosts.isEmpty {
                    Text("No gateway yet. Add the Mac that runs your Hermes agent.")
                        .font(.system(size: 14))
                        .foregroundStyle(.secondary)
                } else {
                    ForEach(store.hosts) { host in
                        Button {
                            editing = GatewayHostDraft(host: host)
                        } label: {
                            GatewayHostRow(host: host, isReachable: reachable[host.id])
                        }
                        .buttonStyle(.plain)
                    }
                    .onDelete { offsets in
                        for index in offsets { store.delete(id: store.hosts[index].id) }
                    }
                }
            } header: {
                Text("Gateways")
            } footer: {
                Text("A gateway is a Hermes agent running on your own Mac. It keeps working while your phone is asleep, and this app can watch, approve and stop its work from anywhere on your tailnet.")
            }

            Section {
                Button {
                    editing = GatewayHostDraft()
                } label: {
                    Label("Add Gateway", systemImage: "plus.circle")
                }
            }
        }
        .navigationTitle(Text("Gateways"))
        .navigationBarTitleDisplayMode(.inline)
        .sheet(item: $editing) { draft in
            GatewayHostEditor(draft: draft) { saved in
                store.upsert(saved)
                editing = nil
                Task { await refresh() }
            } onCancel: {
                editing = nil
            }
        }
        .task { await refresh() }
    }

    private func refresh() async {
        for host in store.hosts {
            let ok = await GatewayHostStore.probe(host)
            reachable[host.id] = ok
            if ok { store.markSeen(id: host.id) }
        }
    }
}

private struct GatewayHostRow: View {
    let host: GatewayHost
    let isReachable: Bool?

    var body: some View {
        HStack(spacing: 12) {
            Circle()
                .fill(isReachable == true ? Color.green : (isReachable == false ? Color.secondary.opacity(0.4) : Color.orange))
                .frame(width: 8, height: 8)
                .leoPulse(active: isReachable == nil)
            VStack(alignment: .leading, spacing: 2) {
                Text(host.name).font(.system(size: 16, weight: .medium))
                Text(host.baseURL)
                    .font(.system(size: 12, design: .monospaced))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            Spacer()
            Image(systemName: "chevron.right")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(.tertiary)
        }
        .contentShape(Rectangle())
    }
}

/// Sheet state. A class so typing into the form does not rebuild-and-reset the
/// draft — the same trap that made the SSH host editor lose keystrokes.
final class GatewayHostDraft: ObservableObject, Identifiable {
    let id: String
    @Published var name: String
    @Published var baseURL: String
    @Published var accessKey: String
    let isNew: Bool

    init() {
        id = UUID().uuidString.lowercased()
        name = ""
        baseURL = "https://"
        accessKey = ""
        isNew = true
    }

    init(host: GatewayHost) {
        id = host.id
        name = host.name
        baseURL = host.baseURL
        accessKey = GatewayHostStore.accessKey(hostId: host.id) ?? ""
        isNew = false
    }

    func makeHost() -> GatewayHost {
        GatewayHost(id: id,
                    name: name.trimmingCharacters(in: .whitespaces),
                    baseURL: baseURL.trimmingCharacters(in: .whitespaces))
    }
}

private struct GatewayHostEditor: View {
    @ObservedObject var draft: GatewayHostDraft
    let onSave: (GatewayHost) -> Void
    let onCancel: () -> Void

    @State private var testResult: String?
    @State private var isTesting = false

    private var canSave: Bool {
        !draft.name.trimmingCharacters(in: .whitespaces).isEmpty
            && URL(string: draft.baseURL.trimmingCharacters(in: .whitespaces))?.host != nil
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Name", text: $draft.name)
                        .textInputAutocapitalization(.never)
                    TextField("https://host.tailnet.ts.net:8645", text: $draft.baseURL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .font(.system(size: 14, design: .monospaced))
                } header: {
                    Text("Address")
                } footer: {
                    // The single most likely setup mistake, called out where
                    // it happens rather than left to fail as a TLS error.
                    Text("Use the machine's tailnet hostname, not its IP — the certificate is selected by hostname and an IP address will fail to connect.")
                }

                Section {
                    SecureField("API_SERVER_KEY", text: $draft.accessKey)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                } header: {
                    Text("Access Key")
                } footer: {
                    Text("From API_SERVER_KEY in ~/.hermes/.env on the gateway. Stored in this device's Keychain only — it is never synced to iCloud.")
                }

                Section {
                    Button {
                        Task { await test() }
                    } label: {
                        HStack {
                            Text("Test Connection")
                            Spacer()
                            if isTesting { ProgressView() }
                        }
                    }
                    .disabled(!canSave || isTesting)
                    if let testResult {
                        Text(testResult).font(.system(size: 13)).foregroundStyle(.secondary)
                    }
                }
            }
            .navigationTitle(Text(draft.isNew ? "Add Gateway" : "Edit Gateway"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { onCancel() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        let host = draft.makeHost()
                        GatewayHostStore.saveAccessKey(draft.accessKey, hostId: host.id)
                        onSave(host)
                    }
                    .disabled(!canSave)
                }
            }
        }
    }

    private func test() async {
        isTesting = true
        defer { isTesting = false }
        let host = draft.makeHost()
        guard await GatewayHostStore.probe(host) else {
            testResult = String(localized: "Could not reach the gateway. Check the address and that Tailscale is connected.")
            return
        }
        // Reachable — now check whether the key is accepted, which is a
        // separate failure the user fixes differently.
        guard let url = host.url, !draft.accessKey.isEmpty else {
            testResult = String(localized: "Gateway is reachable. Add the access key to finish.")
            return
        }
        let client = HermesGatewayClient(baseURL: url, apiKey: draft.accessKey)
        do {
            let caps = try await client.capabilities()
            testResult = String(localized: "Connected to \(caps.platform). Approvals: \(caps.has("approval_events") ? "supported" : "unavailable").")
        } catch {
            testResult = error.localizedDescription
        }
    }
}

// MARK: - Console

struct GatewayConsoleView: View {
    let host: GatewayHost
    @StateObject private var driver: GatewayRunDriver
    @State private var input = ""
    @FocusState private var inputFocused: Bool

    init(host: GatewayHost, client: HermesGatewayClient) {
        self.host = host
        _driver = StateObject(wrappedValue: GatewayRunDriver(client: client, hostId: host.id))
    }

    var body: some View {
        VStack(spacing: 0) {
            transcript
            if let approval = driver.pendingApproval {
                GatewayApprovalCard(approval: approval) { choice in
                    driver.respond(to: approval, choice: choice)
                }
                .transition(.move(edge: .bottom).combined(with: .opacity))
            }
            composer
        }
        .navigationTitle(Text(host.name))
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                if driver.isRunning {
                    Button {
                        driver.stop()
                    } label: {
                        Image(systemName: "stop.circle.fill").foregroundStyle(.red)
                    }
                    .accessibilityLabel(Text("Stop"))
                }
            }
        }
        .animation(LeoMotion.smooth(reduceMotion: false), value: driver.pendingApproval?.runId)
        .onDisappear { driver.cancelLocalStream() }
    }

    private var transcript: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 12) {
                    ForEach(driver.items) { item in
                        GatewayItemView(item: item).id(item.id)
                    }
                    if driver.isRunning && driver.pendingApproval == nil {
                        HStack(spacing: 8) {
                            LeoTypingIndicator()
                            Text(driver.status)
                                .font(.system(size: 12, design: .monospaced))
                                .foregroundStyle(.secondary)
                        }
                        .id("typing")
                    }
                    if let usage = driver.usage {
                        Text("\(usage.totalTokens) tokens")
                            .font(.system(size: 11, design: .monospaced))
                            .foregroundStyle(.tertiary)
                    }
                }
                .padding(16)
            }
            .onChange(of: driver.items.count) { _ in
                guard let last = driver.items.last else { return }
                withAnimation { proxy.scrollTo(last.id, anchor: .bottom) }
            }
        }
    }

    private var composer: some View {
        HStack(spacing: 10) {
            TextField("Ask the gateway…", text: $input, axis: .vertical)
                .lineLimit(1...5)
                .focused($inputFocused)
                .textFieldStyle(.plain)
                .padding(.horizontal, 12)
                .padding(.vertical, 9)
                .background(Color.secondary.opacity(0.12), in: RoundedRectangle(cornerRadius: 18))
            Button {
                let text = input
                input = ""
                driver.send(text)
            } label: {
                Image(systemName: "arrow.up.circle.fill")
                    .font(.system(size: 28))
            }
            .disabled(input.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || driver.isRunning)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(.bar)
    }
}

private struct GatewayItemView: View {
    let item: GatewayTranscriptItem

    var body: some View {
        switch item.kind {
        case .assistantText:
            Text(item.text)
                .font(.system(size: 16))
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)

        case .reasoning:
            Text(item.text)
                .font(.system(size: 13, design: .monospaced))
                .foregroundStyle(.secondary)
                .padding(10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 8))

        case .tool(let name, let isRunning, let isError, let duration):
            HStack(spacing: 8) {
                Image(systemName: isRunning ? "gearshape.2" : (isError ? "exclamationmark.triangle" : "checkmark.circle"))
                    .font(.system(size: 13))
                    .foregroundStyle(isError ? .red : (isRunning ? .orange : .green))
                    .leoPulse(active: isRunning)
                Text(name).font(.system(size: 13, weight: .medium, design: .monospaced))
                if !item.text.isEmpty {
                    Text(item.text)
                        .font(.system(size: 12, design: .monospaced))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
                Spacer()
                if let duration {
                    Text(String(format: "%.2fs", duration))
                        .font(.system(size: 11, design: .monospaced))
                        .foregroundStyle(.tertiary)
                }
            }
            .padding(.vertical, 6)
            .padding(.horizontal, 10)
            .background(Color.secondary.opacity(0.07), in: RoundedRectangle(cornerRadius: 8))

        case .notice:
            Text(item.text)
                .font(.system(size: 12))
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)

        case .failure:
            Text(item.text)
                .font(.system(size: 13))
                .foregroundStyle(.red)
                .padding(10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color.red.opacity(0.1), in: RoundedRectangle(cornerRadius: 8))
        }
    }
}

/// The approval card. Buttons come from the gateway's own `choices` array —
/// it narrows the set for risky commands (a "smart denied" one only ever
/// offers once/deny), so a hardcoded four-button row would offer permissions
/// the server would then reject.
struct GatewayApprovalCard: View {
    let approval: GatewayApprovalRequest
    let onChoose: (String) -> Void

    private func label(for choice: String) -> String {
        switch choice {
        case "once": return String(localized: "Allow Once")
        case "session": return String(localized: "Allow This Session")
        case "always": return String(localized: "Always Allow")
        case "deny": return String(localized: "Deny")
        default: return choice
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 8) {
                Image(systemName: "hand.raised.fill").foregroundStyle(.orange)
                Text("Approval needed").font(.system(size: 15, weight: .semibold))
                Spacer()
            }
            if let reason = approval.reason, !reason.isEmpty {
                Text(reason).font(.system(size: 13)).foregroundStyle(.secondary)
            }
            if let command = approval.command, !command.isEmpty {
                Text(command)
                    .font(.system(size: 13, design: .monospaced))
                    .textSelection(.enabled)
                    .padding(10)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color.black.opacity(0.06), in: RoundedRectangle(cornerRadius: 6))
            }
            HStack(spacing: 8) {
                ForEach(approval.choices, id: \.self) { choice in
                    Button {
                        LeoHaptics.impact(choice == "deny" ? .medium : .light)
                        onChoose(choice)
                    } label: {
                        Text(label(for: choice))
                            .font(.system(size: 13, weight: .medium))
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 9)
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(choice == "deny" ? .red : .accentColor)
                }
            }
        }
        .padding(14)
        .background(Color.orange.opacity(0.09))
        .overlay(Rectangle().frame(height: 1).foregroundStyle(.orange.opacity(0.35)), alignment: .top)
    }
}

// MARK: - Entry point

/// Picks a host, then opens its console. Shown from Settings so the feature
/// has a home before it is folded into the main chat list.
struct GatewayEntryView: View {
    @StateObject private var store = GatewayHostStore.shared

    var body: some View {
        List {
            if store.activeHosts.isEmpty {
                Section {
                    Text("Add a gateway in Settings to run tasks on your Mac from here.")
                        .font(.system(size: 14))
                        .foregroundStyle(.secondary)
                }
            }
            ForEach(store.activeHosts) { host in
                if let client = store.client(for: host) {
                    NavigationLink {
                        GatewayConsoleView(host: host, client: client)
                    } label: {
                        Label(host.name, systemImage: "desktopcomputer")
                    }
                } else {
                    Label {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(host.name)
                            Text("Access key missing").font(.system(size: 12)).foregroundStyle(.secondary)
                        }
                    } icon: {
                        Image(systemName: "desktopcomputer.trianglebadge.exclamationmark")
                    }
                }
            }
        }
        .navigationTitle(Text("Gateway"))
        .navigationBarTitleDisplayMode(.inline)
    }
}
