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

import SafariServices
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
    /// [T-fleet] hostId → reachable for the current saved host configuration.
    @State private var reachability: [String: Bool] = [:]
    @State private var pendingDelete: RemoteHost?
    @AppStorage(RemoteHostStore.autoTmuxKey) private var autoTmux = true

    var body: some View {
        List {
            Section {
                ForEach(store.hosts) { host in
                    HStack(spacing: 12) {
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
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        // 列表里一键打开交互终端（没固定公钥时终端页会给出说明）。
                        Button {
                            SSHTerminalLauncher.open(host: host)
                        } label: {
                            Image(systemName: "terminal")
                                .font(.body.weight(.medium))
                                .frame(width: 34, height: 34)
                                .background(Circle().fill(Color.accentColor.opacity(0.12)))
                        }
                        .buttonStyle(.borderless)
                        .accessibilityLabel(Text("打开终端"))
                    }
                    .contextMenu {
                        Button { SSHTerminalLauncher.open(host: host) } label: { Label("打开终端", systemImage: "terminal") }
                        Button { sheetItem = .edit(host) } label: { Label("编辑", systemImage: "pencil") }
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
            Section {
                NavigationLink {
                    SSHKeysView()
                } label: {
                    Label("SSH 钥匙", systemImage: "key.horizontal")
                }
                Toggle(isOn: $autoTmux) {
                    Label("终端自动 tmux", systemImage: "rectangle.split.3x1")
                }
            } header: {
                Text("终端")
            } footer: {
                Text("打开终端时自动进入 tmux 会话 leobot：断线、切到后台再回来都会接着原来的窗口。主机没装 tmux 时直接给普通 shell。")
            }
        }
        .navigationTitle(Text("Remote Hosts"))
        .task(id: store.hosts) { await refreshReachability() }
        .sheet(item: $sheetItem) { item in
            RemoteHostEditSheet(sheetId: item.id, host: item.host)
        }
        .alert(AppLocalized("Delete this host?"),
               isPresented: Binding(get: { pendingDelete != nil },
                                    set: { if !$0 { pendingDelete = nil } }),
               presenting: pendingDelete) { host in
            Button(AppLocalized("Delete"), role: .destructive) {
                store.delete(id: host.id)
                pendingDelete = nil
            }
            Button(AppLocalized("Cancel"), role: .cancel) { pendingDelete = nil }
        } message: { host in
            Text(AppLocalized("\(host.name) and its saved password will be removed from this device."))
        }
    }

    /// 并行探测：几台机器一起测，谁先回来先更新谁。不先清成灰色 —— 刷新期间保留上次结果，
    /// 以前逐台串行、还先全部清空，离线机器每台 4 秒超时，后面的点要灰很久。
    private func refreshReachability() async {
        let hosts = store.hosts
        reachability = reachability.filter { id, _ in hosts.contains { $0.id == id } }
        await withTaskGroup(of: (RemoteHost, Bool).self) { group in
            for host in hosts {
                group.addTask { (host, await RemoteSSHExecutor.probe(host: host)) }
            }
            for await (host, ok) in group {
                // Network.framework may complete an earlier probe after task cancellation.
                guard !Task.isCancelled, store.hosts.contains(host) else { continue }
                reachability[host.id] = ok
            }
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
    /// 已存密码被服务器拒绝过（只标记、没删）。
    @Published var passwordRejected = false
    /// 这次的公钥是连上去现读的（TOFU），确认弹窗里说明要核对指纹。
    @Published private(set) var hostKeyFromTOFU = false

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
        passwordRejected = host.map { RemoteHostStore.isPasswordRejected(hostId: $0.id) } ?? false
    }

    var fingerprint: String? {
        RemoteSSHTrust.normalizedPublicKey(trustedHostKey).flatMap(RemoteSSHText.fingerprint(publicKeyLine:))
    }

    /// 「重新读取指纹」：有已配对的 Mac 就从加密通道读；否则连上去读服务器出示的公钥（TOFU），
    /// 不发送任何凭据。两种都只是填进草稿，保存时还要用户确认一次才固定。
    func refetchHostKey() {
        if pairedGatewayHost != nil {
            fetchHostKeyFromPairedMac()
            return
        }
        let address = draft.host, port = draft.port, user = draft.username
        guard !address.isEmpty, (1...65535).contains(port) else {
            hostKeyFetchResult = AppLocalized("先填好地址和端口。")
            return
        }
        fetchingHostKey = true
        hostKeyFetchResult = nil
        Task { @MainActor in
            defer { fetchingHostKey = false }
            do {
                let key = try await RemoteSSHExecutor.fetchHostKey(host: address, port: port, username: user.isEmpty ? "leo" : user)
                trustedHostKey = key
                fetchedHostKey = nil
                hostKeyFromTOFU = true
                hostKeyFetchResult = AppLocalized("已读到 \(address) 出示的公钥，保存前请核对指纹。")
            } catch {
                hostKeyFetchResult = AppLocalized("读取失败：\(error.localizedDescription)")
            }
        }
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
            hostKeyFetchResult = AppLocalized("所属设备尚未配对或已停用，无法读取。")
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
                    hostKeyFetchResult = AppLocalized("这台 Mac 的 LeoBot 版本还不提供 SSH 公钥，请升级到 1.3.5 或手工粘贴。")
                    return
                }
                trustedHostKey = key
                fetchedHostKey = key
                hostKeyFromTOFU = false
                hostKeyFetchResult = AppLocalized("已从 \(host.name) 读取公钥，保存时确认即可。")
            } catch {
                let reason = (error as? URLError)?.code == .timedOut
                    ? AppLocalized("15 秒内没有回应：检查手机网络，或那台 Mac 是否在线。")
                    : error.localizedDescription
                hostKeyFetchResult = AppLocalized("读取失败：\(reason)")
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
        var host = draft
        // 端口转发规则在子页面里直接写进存储；以存储里的为准，别被打开编辑页时的旧值覆盖。
        host.portForwards = RemoteHostStore.shared.hosts.first(where: { $0.id == draftId })?.portForwards
        RemoteHostStore.shared.upsert(host, password: password.isEmpty ? nil : password)
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
                Section(AppLocalized("Host")) {
                    TextField(AppLocalized("Name (e.g. My Mac)"), text: $model.name)
                    TextField(AppLocalized("Address (IP or hostname)"), text: $model.address)
                        .autocorrectionDisabled().textInputAutocapitalization(.never)
                        .keyboardType(.URL)
                    TextField(AppLocalized("Port"), text: $model.port)
                        .keyboardType(.numberPad)
                    TextField(AppLocalized("Username"), text: $model.username)
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
                    Button {
                        model.refetchHostKey()
                    } label: {
                        if model.fetchingHostKey { ProgressView() }
                        else if model.pairedGatewayHost != nil {
                            Label("从已配对的 Mac 读取公钥", systemImage: "key.radiowaves.forward")
                        } else {
                            Label("重新读取指纹", systemImage: "arrow.triangle.2.circlepath")
                        }
                    }
                    .disabled(model.fetchingHostKey)
                    if let result = model.hostKeyFetchResult {
                        Text(result).font(.caption).foregroundStyle(.secondary)
                    }
                    if let fingerprint = model.fingerprint {
                        LabeledContent("指纹") {
                            Text(fingerprint).font(.caption2.monospaced()).textSelection(.enabled)
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
                    SecureField(AppLocalized("Password (optional — leave empty for key auth)"), text: $model.password)
                    if model.passwordRejected && model.password.isEmpty {
                        Label("已存的密码被服务器拒绝过（没有删除）。重新填一次，或改用钥匙登录。", systemImage: "exclamationmark.triangle")
                            .font(.caption).foregroundStyle(.orange)
                    }
                    if model.hasStoredPassword {
                        Button(AppLocalized("Forget saved password"), role: .destructive) {
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
                if model.isEditing, let saved = RemoteHostStore.shared.hosts.first(where: { $0.id == model.draftId }) {
                    Section {
                        Button {
                            SSHTerminalLauncher.open(host: saved)
                        } label: {
                            Label("打开终端", systemImage: "terminal")
                        }
                        NavigationLink {
                            SSHPortForwardView(hostId: saved.id)
                        } label: {
                            Label("端口转发", systemImage: "arrow.left.arrow.right")
                        }
                    } footer: {
                        Text("终端与端口转发用的是已保存的配置；改了地址、端口或公钥请先保存。")
                    }
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
                } else if model.hostKeyFromTOFU {
                    Text("这是刚连上 \(model.draft.host):\(model.draft.port) 时服务器出示的公钥。\n指纹 \(model.fingerprint ?? "?")\n确认是你自己的机器（可在那台电脑上运行 ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub 对照）后再固定。")
                } else {
                    Text("将此公钥固定到 \(model.draft.host):\(model.draft.port)。服务器密钥不匹配时会拒绝连接，包括经其他主机跳转。请确认已在目标电脑的可信控制台核对公钥。")
                }
            }
            .navigationTitle(Text(model.isEditing ? "Edit Host" : "Add Host"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(AppLocalized("Cancel")) {
                        // A pre-save Test stored the typed password under the
                        // draft id; cancelling must not strand it in Keychain.
                        if !model.isEditing { RemoteHostStore.deletePassword(hostId: model.draftId) }
                        dismiss()
                    }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(AppLocalized("Save")) {
                        if model.needsTrustConfirmation { confirmingTrust = true }
                        else { model.save(); dismiss() }
                    }
                    .disabled(!model.canSave)
                }
            }
        }
    }
}

// MARK: - SSH 钥匙

/// 设备钥匙 + 导入的私钥，选一把做默认（连所有主机时用它；没有可用的导入钥匙就回到设备钥匙）。
struct SSHKeysView: View {
    @State private var identities = RemoteHostStore.identities()
    @State private var defaultId = RemoteHostStore.defaultIdentityId
    @State private var devicePublicKey = RemoteHostStore.devicePublicKeyLine()
    @State private var importing = false
    @State private var copiedId: String?

    var body: some View {
        List {
            Section {
                if let devicePublicKey {
                    keyRow(id: nil, name: AppLocalized("这台 iPhone（设备钥匙）"), kind: "ed25519", publicKey: devicePublicKey)
                } else {
                    Button {
                        RemoteHostStore.ensureDeviceKey()
                        devicePublicKey = RemoteHostStore.devicePublicKeyLine()
                    } label: {
                        Label("生成设备钥匙", systemImage: "key.fill")
                    }
                }
                ForEach(identities) { identity in
                    keyRow(id: identity.id, name: identity.name, kind: identity.kind.rawValue, publicKey: identity.publicKeyLine)
                }
                .onDelete { offsets in
                    for index in offsets { RemoteHostStore.deleteIdentity(id: identities[index].id) }
                    reload()
                }
                Button {
                    importing = true
                } label: {
                    Label("导入私钥", systemImage: "square.and.arrow.down")
                }
            } footer: {
                Text("点选一把作为默认钥匙。私钥和口令只存在本机钥匙串，不同步、不上传；口令导入时问一次，之后不再询问。把对应公钥加进主机的 ~/.ssh/authorized_keys 即可免密码登录。")
            }
        }
        .navigationTitle(Text("SSH 钥匙"))
        .sheet(isPresented: $importing, onDismiss: reload) { SSHKeyImportSheet() }
    }

    private func keyRow(id: String?, name: String, kind: String, publicKey: String) -> some View {
        Button {
            RemoteHostStore.defaultIdentityId = id
            defaultId = RemoteHostStore.defaultIdentityId
        } label: {
            HStack(spacing: 12) {
                Image(systemName: defaultId == id ? "checkmark.circle.fill" : "circle")
                    .foregroundStyle(defaultId == id ? Color.accentColor : Color.secondary)
                    .font(.title3)
                VStack(alignment: .leading, spacing: 2) {
                    Text(name).foregroundStyle(.primary)
                    Text("\(kind) · \(RemoteSSHText.fingerprint(publicKeyLine: publicKey) ?? "")")
                        .font(.caption2.monospaced())
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
                Spacer(minLength: 0)
                Button {
                    UIPasteboard.general.string = publicKey
                    copiedId = id ?? "device"
                } label: {
                    Image(systemName: copiedId == (id ?? "device") ? "checkmark" : "doc.on.doc")
                }
                .buttonStyle(.borderless)
                .accessibilityLabel(Text("复制公钥"))
            }
        }
    }

    private func reload() {
        identities = RemoteHostStore.identities()
        defaultId = RemoteHostStore.defaultIdentityId
    }
}

private struct SSHKeyImportSheet: View {
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var pem = ""
    @State private var passphrase = ""
    @State private var needsPassphrase = false
    @State private var errorText: String?
    @State private var makeDefault = true

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("名称（例如 GitHub、工作机）", text: $name)
                    TextField("-----BEGIN OPENSSH PRIVATE KEY-----", text: $pem, axis: .vertical)
                        .font(.caption.monospaced())
                        .lineLimit(6...14)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
                    Button {
                        if let text = UIPasteboard.general.string { pem = text }
                    } label: {
                        Label("从剪贴板粘贴", systemImage: "doc.on.clipboard")
                    }
                } footer: {
                    Text("支持 OpenSSH 格式的 ed25519 / rsa 私钥（ssh-keygen 默认格式）。")
                }
                if needsPassphrase {
                    Section("口令") {
                        SecureField("私钥口令", text: $passphrase)
                    }
                }
                Section {
                    Toggle("设为默认钥匙", isOn: $makeDefault)
                }
                if let errorText {
                    Section { Text(errorText).font(.caption).foregroundStyle(.red) }
                }
            }
            .onChange(of: pem) { _, newValue in
                needsPassphrase = (try? SSHPrivateKeyInfo.parse(newValue))?.encrypted ?? needsPassphrase
                errorText = nil
            }
            .navigationTitle(Text("导入私钥"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(AppLocalized("Cancel")) { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(AppLocalized("导入")) { importKey() }
                        .disabled(pem.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
        }
    }

    private func importKey() {
        do {
            let identity = try RemoteHostStore.importIdentity(
                name: name.trimmingCharacters(in: .whitespaces), pem: pem, passphrase: passphrase)
            if makeDefault { RemoteHostStore.defaultIdentityId = identity.id }
            dismiss()
        } catch SSHIdentityImportError.needsPassphrase {
            needsPassphrase = true
            errorText = SSHIdentityImportError.needsPassphrase.localizedDescription
        } catch {
            errorText = error.localizedDescription
        }
    }
}

// MARK: - 端口转发

/// 本地端口 ← 远程 host:port（direct-tcpip）。开着时可在 App 内的 Safari 页打开 http://127.0.0.1:<本地端口>。
struct SSHPortForwardView: View {
    let hostId: String
    @ObservedObject private var store = RemoteHostStore.shared
    @ObservedObject private var manager = SSHPortForwardManager.shared
    @State private var localPort = ""
    @State private var remoteHost = "127.0.0.1"
    @State private var remotePort = ""

    private var host: RemoteHost? { store.hosts.first { $0.id == hostId } }
    private var rules: [SSHPortForwardRule] { host?.portForwards ?? [] }

    var body: some View {
        Form {
            Section {
                if rules.isEmpty {
                    Text("还没有规则。比如 Mac 上跑着 dev server 在 3000 端口：本地 3000 ← 127.0.0.1:3000。")
                        .font(.footnote).foregroundStyle(.secondary)
                }
                ForEach(rules) { rule in row(rule) }
                    .onDelete { offsets in
                        var next = rules
                        for index in offsets { manager.stop(next[index].id) }
                        next.remove(atOffsets: offsets)
                        store.setPortForwards(next, hostId: hostId)
                    }
            } footer: {
                Text("只在 LeoBot 前台期间有效：切到后台会暂停，回来自动恢复。用下面的「在 Safari 打开」在 App 内预览，不会把 LeoBot 推到后台。")
            }
            Section("添加转发") {
                TextField("本地端口（例如 3000）", text: $localPort).keyboardType(.numberPad)
                TextField("远程主机", text: $remoteHost)
                    .autocorrectionDisabled().textInputAutocapitalization(.never).keyboardType(.URL)
                TextField("远程端口", text: $remotePort).keyboardType(.numberPad)
                Button {
                    addRule()
                } label: {
                    Label("添加", systemImage: "plus.circle.fill")
                }
                .disabled(newRule == nil)
            }
        }
        .navigationTitle(Text("端口转发"))
        .animation(.easeInOut(duration: 0.2), value: manager.states)
    }

    private func row(_ rule: SSHPortForwardRule) -> some View {
        let state = manager.states[rule.id]
        return VStack(alignment: .leading, spacing: 6) {
            Toggle(isOn: Binding(
                get: { state != nil && !isFailed(state) },
                set: { on in
                    if on, let host { manager.start(host: host, rule: rule) } else { manager.stop(rule.id) }
                })) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("127.0.0.1:\(String(rule.localPort)) ← \(rule.remoteHost):\(String(rule.remotePort))")
                        .font(.callout.monospaced())
                    Text(statusText(state)).font(.caption).foregroundStyle(statusColor(state))
                }
            }
            if state == .active, let url = URL(string: "http://127.0.0.1:\(rule.localPort)") {
                Button {
                    BackupOpenRouter.topViewController()?.present(SFSafariViewController(url: url), animated: true)
                } label: {
                    Label("在 Safari 打开 http://127.0.0.1:\(String(rule.localPort))", systemImage: "safari")
                        .font(.subheadline)
                }
                .buttonStyle(.borderless)
            }
        }
        .padding(.vertical, 2)
    }

    private func isFailed(_ state: SSHPortForwardManager.State?) -> Bool {
        if case .failed = state { return true }
        return false
    }

    private func statusText(_ state: SSHPortForwardManager.State?) -> String {
        switch state {
        case nil: return AppLocalized("已关闭")
        case .starting: return AppLocalized("连接中…")
        case .active: return AppLocalized("转发中")
        case .failed(let message): return message
        }
    }

    private func statusColor(_ state: SSHPortForwardManager.State?) -> Color {
        switch state {
        case .active: return .green
        case .failed: return .red
        default: return .secondary
        }
    }

    private var newRule: SSHPortForwardRule? {
        guard let local = Int(localPort), (1024...65535).contains(local),
              let remote = Int(remotePort), (1...65535).contains(remote),
              MacSSHTarget.valid(host: remoteHost.trimmingCharacters(in: .whitespaces)),
              !rules.contains(where: { $0.localPort == local }) else { return nil }
        return SSHPortForwardRule(localPort: local, remoteHost: remoteHost.trimmingCharacters(in: .whitespaces), remotePort: remote)
    }

    private func addRule() {
        guard let rule = newRule else { return }
        store.setPortForwards(rules + [rule], hostId: hostId)
        localPort = ""
        remotePort = ""
        if let host { manager.start(host: host, rule: rule) }
    }
}
