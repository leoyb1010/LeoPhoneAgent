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
    /// [T-fleet] hostId → reachable, probed on appear.
    @State private var reachability: [String: Bool] = [:]
    @State private var pendingDelete: RemoteHost?

    var body: some View {
        List {
            Section {
                ForEach(store.hosts) { host in
                    Button {
                        sheetItem = .edit(host)
                    } label: {
                        VStack(alignment: .leading, spacing: 2) {
                            HStack(spacing: 6) {
                                Circle()
                                    .fill(reachability[host.id] == true ? Color.green
                                          : reachability[host.id] == false ? Color.red : Color.gray)
                                    .frame(width: 8, height: 8)
                                    .leoPulse(active: reachability[host.id] == true)
                                Text(host.name).font(.body.weight(.medium)).foregroundStyle(.primary)
                            }
                            Text("\(host.username)@\(host.host):\(String(host.port))")
                                .font(.caption.monospaced()).foregroundStyle(.secondary)
                        }
                    }
                }
                .onDelete { offsets in
                    pendingDelete = offsets.first.map { store.hosts[$0] }
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
        .task {
            for host in store.hosts {
                let ok = await RemoteSSHExecutor.probe(host: host)
                reachability[host.id] = ok
            }
        }
        .sheet(item: $sheetItem) { item in
            RemoteHostEditSheet(sheetId: item.id, host: item.host)
        }
        .alert(String(localized: "Delete this host?"),
               isPresented: Binding(get: { pendingDelete != nil },
                                    set: { if !$0 { pendingDelete = nil } }),
               presenting: pendingDelete) { host in
            Button(String(localized: "Delete"), role: .destructive) {
                store.delete(id: host.id)
                pendingDelete = nil
            }
            Button(String(localized: "Cancel"), role: .cancel) { pendingDelete = nil }
        } message: { host in
            Text(String(localized: "\(host.name) and its saved password will be removed from this device."))
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
    @Published var deviceId: String
    @Published var password = ""
    @Published var trustedHostKey: String
    /// 公钥来自已配对 Mac 的加密通道(而非手工粘贴)时,确认弹窗这样说明来源。
    @Published private(set) var fetchedHostKey: String?
    var hostKeyFromPairedMac: Bool {
        fetchedHostKey != nil && RemoteSSHTrust.normalizedPublicKey(trustedHostKey) == fetchedHostKey
    }
    @Published var fetchingHostKey = false
    @Published var hostKeyFetchResult: String?
    private let originalTrustedEndpoint: String?
    @Published var testResult: String?
    @Published var testing = false
    @Published var failShake = 0
    @Published var okSweep = 0
    @Published var pubkey: String?
    @Published var hasStoredPassword = false

    init(sheetId: String, host: RemoteHost?) {
        draftId = host?.id ?? sheetId
        isEditing = host != nil
        name = host?.name ?? ""
        address = host?.host ?? ""
        port = host.map { String($0.port) } ?? "22"
        username = host?.username ?? ""
        deviceId = host?.deviceId ?? ""
        trustedHostKey = host?.trustedHostKey ?? ""
        originalTrustedEndpoint = host?.trustedHostKeyEndpoint
        pubkey = RemoteHostStore.devicePublicKeyLine()
        hasStoredPassword = host.map { RemoteHostStore.password(hostId: $0.id)?.isEmpty == false } ?? false
    }

    var draft: RemoteHost {
        RemoteHost(
            id: draftId,
            name: name.trimmingCharacters(in: .whitespaces),
            host: address.trimmingCharacters(in: .whitespaces),
            port: Int(port) ?? 22,
            username: username.trimmingCharacters(in: .whitespaces),
            deviceId: deviceId.isEmpty ? nil : deviceId,
            trustedHostKey: RemoteSSHTrust.normalizedPublicKey(trustedHostKey),
            trustedHostKeyEndpoint: RemoteSSHTrust.endpoint(host: address, port: Int(port) ?? 22)
        )
    }

    var canSave: Bool {
        guard let numericPort = Int(port), (1...65535).contains(numericPort) else { return false }
        return !draft.name.isEmpty && !draft.host.isEmpty && !draft.username.isEmpty
            && (trustedHostKey.isEmpty || RemoteSSHExecutor.isValidHostKey(trustedHostKey))
    }

    var needsTrustConfirmation: Bool {
        !trustedHostKey.isEmpty && (originalTrustedEndpoint != draft.trustedHostKeyEndpoint
            || RemoteHostStore.shared.hosts.first(where: { $0.id == draftId })?.trustedHostKey != draft.trustedHostKey)
    }

    func runTest() {
        var candidate = draft
        let pw = password
        // A typed password is tested under a throwaway id so Cancel really
        // writes nothing — testing a wrong password used to overwrite the
        // saved, working one.
        if !pw.isEmpty { candidate.id = "test-" + UUID().uuidString.lowercased() }
        testing = true
        testResult = nil
        Task {
            if !pw.isEmpty { RemoteHostStore.setPassword(pw, hostId: candidate.id) }
            let result = await RemoteSSHExecutor.shared.test(host: candidate)
            if !pw.isEmpty { RemoteHostStore.deletePassword(hostId: candidate.id) }
            await MainActor.run {
                self.testing = false
                self.testResult = String(result.output.prefix(400))
                if result.output.contains("LEO_OK") { self.okSweep += 1 } else { self.failShake += 1 }
            }
        }
    }

    /// 已配对的 Mac 在远控通道里公布自己的 sshd 公钥;这条通道已经过设备授权和 TLS 身份绑定,
    /// 比手工抄 /etc/ssh 省事且不会抄错。仍需用户确认后才保存为固定身份。
    var pairedGatewayHost: GatewayHost? {
        guard !deviceId.isEmpty else { return nil }
        return GatewayHostStore.shared.activeHosts.first { $0.device?.deviceId == deviceId }
    }

    func fetchHostKeyFromPairedMac() {
        guard let host = pairedGatewayHost, let client = GatewayHostStore.shared.client(for: host) else {
            hostKeyFetchResult = String(localized: "所属设备尚未配对或已停用，无法读取。")
            return
        }
        fetchingHostKey = true
        hostKeyFetchResult = nil
        Task { @MainActor in
            defer { fetchingHostKey = false }
            do {
                // The client session waits for connectivity for up to an hour; the
                // user is watching a spinner here, so cap it.
                let keys = try await withThrowingTaskGroup(of: [String].self) { group in
                    group.addTask { try await client.capabilities().sshHostKeys }
                    group.addTask { try await Task.sleep(for: .seconds(15)); throw URLError(.timedOut) }
                    let first = try await group.next()!
                    group.cancelAll()
                    return first
                }
                guard let key = keys.first(where: { $0.hasPrefix("ssh-ed25519 ") }) ?? keys.first else {
                    hostKeyFetchResult = String(localized: "这台 Mac 的 LeoPhoneAgent 版本还不提供 SSH 公钥，请升级到 1.3.5 或手工粘贴。")
                    return
                }
                trustedHostKey = key
                fetchedHostKey = key
                hostKeyFetchResult = String(localized: "已从 \(host.name) 读取公钥，保存时确认即可。")
            } catch {
                let reason = (error as? URLError)?.code == .timedOut
                    ? String(localized: "15 秒内没有回应：检查手机网络，或那台 Mac 是否在线。")
                    : error.localizedDescription
                hostKeyFetchResult = String(localized: "读取失败：\(reason)")
            }
        }
    }

    func forgetPassword() {
        RemoteHostStore.deletePassword(hostId: draftId)
        hasStoredPassword = false
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
    @State private var confirmingTrust = false

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
                    Picker("设备", selection: $model.deviceId) {
                        Text("独立 SSH 主机").tag("")
                        ForEach(GatewayHostStore.shared.hosts.filter { $0.device != nil }) { host in
                            Text(host.name).tag(host.device!.deviceId)
                        }
                    }
                } header: {
                    Text("所属设备")
                } footer: {
                    Text("仅合并设备展示，SSH 和远控仍分别验证授权。")
                }
                Section {
                    if model.pairedGatewayHost != nil {
                        Button {
                            model.fetchHostKeyFromPairedMac()
                        } label: {
                            if model.fetchingHostKey { ProgressView() }
                            else { Label("从已配对的 Mac 读取公钥", systemImage: "key.radiowaves.forward") }
                        }
                        .disabled(model.fetchingHostKey)
                        if let result = model.hostKeyFetchResult {
                            Text(result).font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    TextField("ssh-ed25519 AAAA…", text: $model.trustedHostKey, axis: .vertical)
                        .autocorrectionDisabled().textInputAutocapitalization(.never)
                        .font(.caption.monospaced())
                    if model.needsTrustConfirmation {
                        Text("保存时需要确认此地址的服务器身份；更换密钥必须重新从可信控制台核对。")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                } header: {
                    Text("已核实的 SSH 服务器公钥")
                } footer: {
                    Text("上面选了所属设备时，可直接从那台 Mac 的已配对加密通道读取；否则在目标电脑的可信终端读取 /etc/ssh/ssh_host_ed25519_key.pub，核对后粘贴整行公钥。直连目前仅支持 Ed25519；网关 OpenSSH 仍可校验其他有效公钥。不要粘贴私钥。留空会保留主机配置，但禁止 SSH 连接。")
                }
                Section {
                    SecureField(String(localized: "Password (optional — leave empty for key auth)"), text: $model.password)
                    if model.hasStoredPassword {
                        Button(String(localized: "Forget saved password"), role: .destructive) {
                            model.forgetPassword()
                        }
                    }
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
                    .disabled(!model.canSave || model.trustedHostKey.isEmpty)
                    if let testResult = model.testResult {
                        Text(testResult)
                            .font(.caption.monospaced())
                            .foregroundStyle(testResult.contains("LEO_OK") ? .green : .red)
                            .leoShake(trigger: model.failShake)
                            .leoShineSweep(trigger: model.okSweep)
                    }
                }
            }
            .alert("确认 SSH 服务器身份", isPresented: $confirmingTrust) {
                Button("已从可信渠道核对，保存") { model.save(); dismiss() }
                Button("取消", role: .cancel) { }
            } message: {
                if model.hostKeyFromPairedMac {
                    Text("将此公钥固定到 \(model.draft.host):\(model.draft.port)。公钥来自已配对 Mac 的加密远控通道（设备授权 + TLS 身份绑定），服务器密钥不匹配时会拒绝连接。")
                } else {
                    Text("将此公钥固定到 \(model.draft.host):\(model.draft.port)。服务器密钥不匹配时会拒绝连接，包括经其他主机跳转。请确认已在目标电脑的可信控制台核对公钥。")
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
                        if model.needsTrustConfirmation { confirmingTrust = true }
                        else { model.save(); dismiss() }
                    }
                    .disabled(!model.canSave)
                }
            }
        }
    }
}
