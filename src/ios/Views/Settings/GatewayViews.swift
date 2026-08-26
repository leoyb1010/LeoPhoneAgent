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
import UIKit

// MARK: - Settings

/// 正在编辑的草稿,进程级单例持有。
///
/// 这个表单的输入曾两次被吞:第一次是 draft 直接当 sheet item、父 List 重算
/// 时被顶掉;第二次把草稿交给编辑器 @StateObject 仍不够——宿主视图本身会被
/// 更上层(键盘出现、状态轮询)整个重建,视图内的一切 @State/@StateObject
/// 连同弹窗一起蒸发。教训:**正在输入的内容不能属于任何视图**。草稿放这里,
/// 视图重建一万次,sheet 会自动带着同一份草稿(文字原封不动)重新弹出。
@MainActor
final class GatewayEditorCoordinator: ObservableObject {
    static let shared = GatewayEditorCoordinator()
    @Published var draft: GatewayHostDraft?

    func beginNew() { draft = GatewayHostDraft() }
    func beginEdit(_ host: GatewayHost) { draft = GatewayHostDraft(host: host) }
    func end() { draft = nil }
}

/// 我的三台 Mac,经自营中继(跑在常开的 cortex 上)从任何网络可达。
/// 个人版:写死没有任何问题,新机器进舰队时加一行。
private let FLEET_PRESETS: [(name: String, machine: String)] = [
    ("MacBook Pro", "LeoyuandeMacBook-Pro-2"),
    ("Mac mini · cortex", "LeodeMac-mini-2"),
    ("Mac Studio", "LeoMac-Studio-2"),
]
private let RELAY_BASE = "https://mac-mini-cortex.tail23de22.ts.net/leoagent-relay/relay/api/m/"

struct GatewaySettingsView: View {
    @StateObject private var store = GatewayHostStore.shared
    @ObservedObject private var editor = GatewayEditorCoordinator.shared
    @State private var reachable: [String: Bool] = [:]
    @State private var showQuickSetup = false
    @State private var scanMessage: String?

    var body: some View {
        List {
            if store.hosts.isEmpty {
                Section {
                    VStack(spacing: LeoTheme.Spacing.md) {
                        ZStack {
                            Circle()
                                .fill(Color.cyan.opacity(0.12))
                                .frame(width: 68, height: 68)
                            Image(systemName: "desktopcomputer.and.macbook")
                                .font(.system(size: 30, weight: .medium))
                                .foregroundStyle(.cyan)
                        }
                        .accessibilityHidden(true)

                        VStack(spacing: LeoTheme.Spacing.xs) {
                            Text("把已在线的机器装进口袋")
                                .font(.title3.bold())
                            Text("一把密钥读取中继 /machines。Mac 与已装本 App 的 Android 都会出现；三台 Mac 仍可作为快捷填充。")
                                .font(.subheadline)
                                .foregroundStyle(LeoTheme.ColorToken.secondaryText)
                                .multilineTextAlignment(.center)
                                .fixedSize(horizontal: false, vertical: true)
                        }

                        Button {
                            showQuickSetup = true
                        } label: {
                            Label("连接中继并发现机器", systemImage: "link.badge.plus")
                                .frame(maxWidth: .infinity, minHeight: LeoTheme.TouchTarget.minimum)
                        }
                        .buttonStyle(.borderedProminent)

                        Button {
                            editor.beginNew()
                        } label: {
                            Label("手动添加机器", systemImage: "plus")
                                .frame(maxWidth: .infinity, minHeight: LeoTheme.TouchTarget.minimum)
                        }
                        .buttonStyle(.bordered)
                        Button {
                            scanPairCode()
                        } label: {
                            Label("扫码加身体", systemImage: "qrcode.viewfinder")
                                .frame(maxWidth: .infinity, minHeight: LeoTheme.TouchTarget.minimum)
                        }
                        .buttonStyle(.bordered)
                    }
                    .padding(.vertical, LeoTheme.Spacing.sm)
                    .listRowBackground(Color.clear)
                    .listRowInsets(EdgeInsets())
                }

                Section("连接后可以") {
                    Label("远程运行 Codex、Claude Code、Grok，或指挥 Android 本机 Agent", systemImage: "terminal")
                    Label("直接审批、转向或停止正在跑的任务", systemImage: "checkmark.shield")
                    Label("这台 iPhone 或 iPad 休眠后，对面的机器继续执行", systemImage: "moon.zzz")
                }
            } else {
                Section("已连接的机器") {
                    ForEach(store.hosts) { host in
                        Button {
                            editor.beginEdit(host)
                        } label: {
                            GatewayHostRow(host: host, isReachable: reachable[host.id])
                        }
                        .buttonStyle(.plain)
                    }
                    .onDelete { offsets in
                        for index in offsets { store.delete(id: store.hosts[index].id) }
                    }
                }

                Section {
                    Button {
                        editor.beginNew()
                    } label: {
                        Label("添加机器", systemImage: "plus.circle")
                    }
                    Button {
                        scanPairCode()
                    } label: {
                        Label("扫码加身体", systemImage: "qrcode.viewfinder")
                    }
                } footer: {
                    Text("码里只有中继根和机器名，钥匙不进码。Mac 端可由 leocodebox 或 leoagent 承载。")
                }
            }
        }
        .navigationTitle(Text("远程机器"))
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await refresh() }
        .sheet(isPresented: $showQuickSetup) {
            QuickFleetSetupSheet { key, machines in
                if machines.isEmpty {
                    for preset in FLEET_PRESETS {
                        let host = GatewayHost(
                            id: preset.machine.lowercased(),
                            name: preset.name,
                            baseURL: "",
                            harnessURL: RELAY_BASE + preset.machine)
                        GatewayHostStore.saveAccessKey(key, hostId: host.id)
                        store.upsert(host)
                    }
                } else {
                    store.upsertDiscovered(machines, key: key)
                }
                showQuickSetup = false
                Task { await refresh() }
            } onCancel: {
                showQuickSetup = false
            }
            .interactiveDismissDisabled()
        }
        .sheet(isPresented: Binding(
            get: { editor.draft != nil },
            set: { if !$0 { editor.end() } }
        )) {
            if let draft = editor.draft {
                GatewayHostEditor(draft: draft) { saved in
                    store.upsert(saved)
                    editor.end()
                    Task { await refresh() }
                } onCancel: {
                    editor.end()
                }
                // 只能通过「保存 / 取消」离开:下滑手势静默丢弃输入
                // 和"自动消失"在用户眼里是同一种背叛。
                .interactiveDismissDisabled()
            }
        }
        .task { await refresh() }
        .alert("扫码", isPresented: Binding(
            get: { scanMessage != nil },
            set: { if !$0 { scanMessage = nil } }
        )) {
            Button("好", role: .cancel) { scanMessage = nil }
        } message: {
            Text(scanMessage ?? "")
        }
    }

    private func scanPairCode() {
        CameraOffloadBridge.scanCode { data, error in
            Task { @MainActor in
                if let error {
                    scanMessage = error as String
                    return
                }
                let raw = (data?["payload"] as? String) ?? ""
                guard let pair = RelayPairPayload.parse(raw) else {
                    scanMessage = "不是本 App 的配对码。码里应是中继根和机器名。"
                    return
                }
                if let join = pair.join, !join.isEmpty {
                    do {
                        let joined = try await RelayMachinesClient.join(apiRoot: pair.apiRoot, token: join)
                        store.upsertDiscovered([
                            RelayDiscoveredMachine(name: pair.machine, online: false, platform: nil, server: nil, version: nil)
                        ], key: joined.key, apiRoot: pair.apiRoot)
                        scanMessage = "已加入 \(pair.machine)"
                        Task { await refresh() }
                    } catch {
                        scanMessage = "短码已过期或无效，请让对端重新出示。"
                    }
                    return
                }
                guard let credential = RelayMachinesClient.credential(
                    matching: pair.apiRoot,
                    from: relayCredentialCandidates()
                ) else {
                    scanMessage = "这是旧码。请让对端出示带短码的新配对码，或先粘贴中继密钥。"
                    return
                }
                store.upsertDiscovered([
                    RelayDiscoveredMachine(name: pair.machine, online: false, platform: nil, server: nil, version: nil)
                ], key: credential.key, apiRoot: credential.apiRoot)
                scanMessage = "已加入 \(pair.machine)"
                Task { await refresh() }
            }
        }
    }

    private func refresh() async {
        // [T-relay-key-fallback] 同一个中继根下可能存着好几把密钥(每台主机一把)。
        // 逐把试,第一把成功就不再重复列举;第一把失效时后面的还有机会,
        // 而不是像以前那样整条发现链跟着 hosts[0] 一起死。
        var succeededRoots: [String] = []
        for credential in RelayMachinesClient.credentials(from: relayCredentialCandidates()) {
            if succeededRoots.contains(where: { RelayMachinesClient.sameApiRoot($0, credential.apiRoot) }) {
                continue
            }
            if let live = try? await RelayMachinesClient.list(apiRoot: credential.apiRoot, key: credential.key) {
                succeededRoots.append(credential.apiRoot)
                store.upsertDiscovered(live, key: credential.key, apiRoot: credential.apiRoot)
            }
        }
        for host in store.hosts {
            // 编辑期间不做后台探测:探测回写会触发整页重算。
            if editor.draft != nil { return }
            let ok = await GatewayHostStore.probe(host)
            reachable[host.id] = ok
            if ok { store.markSeen(id: host.id) }
        }
    }

    private func relayCredentialCandidates() -> [RelayCredentialCandidate] {
        store.hosts.map { host in
            RelayCredentialCandidate(
                harnessURL: host.harnessURL,
                key: GatewayHostStore.accessKey(hostId: host.id)
            )
        }
    }
}

/// 一键添加:三台机器内置,只收一次密钥。
private struct QuickFleetSetupSheet: View {
    let onDone: (String, [RelayDiscoveredMachine]) -> Void
    let onCancel: () -> Void
    @State private var key = ""
    @State private var testing = false
    @State private var result: String?
    @State private var copiedCommand = false
    @State private var discovered: [RelayDiscoveredMachine] = []

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    ForEach(FLEET_PRESETS, id: \.machine) { preset in
                        Label(preset.name, systemImage: "desktopcomputer")
                    }
                } header: {
                    Text("找不到中继列表时，可一键填这三台 Mac")
                } footer: {
                    Text("优先读 /machines。预设只是快捷填充，新 Android 上线不用改仓库字符串。")
                }
                Section {
                    SecureField("粘贴密钥", text: $key)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    Button {
                        UIPasteboard.general.string = "ssh leo@mac-mini-cortex \"cat ~/.leoagent/key\""
                        copiedCommand = true
                        LeoHaptics.notification(.success)
                    } label: {
                        Label(copiedCommand ? "已复制取密钥命令" : "复制取密钥命令",
                              systemImage: copiedCommand ? "checkmark.circle.fill" : "doc.on.doc")
                    }
                } header: {
                    Text("中继密钥(三台共用一把)")
                } footer: {
                    VStack(alignment: .leading, spacing: LeoTheme.Spacing.xs) {
                        Text("把复制的命令粘贴到 Mac 终端，再把返回的密钥粘贴到上方。")
                        Label("如果本机开着 Shadowrocket 等代理，请将 *.ts.net 设为直连。",
                              systemImage: "exclamationmark.triangle.fill")
                    }
                }
                Section {
                    Button {
                        testing = true
                        Task {
                            do {
                                let rows = try await RelayMachinesClient.list(key: key)
                                discovered = rows
                                result = rows.isEmpty
                                    ? "中继已通，但现在没有在线机器。仍可一键填三台 Mac。"
                                    : "发现 \(rows.count) 台：\(rows.map(\.name).joined(separator: "、"))"
                            } catch {
                                discovered = []
                                result = "连不上中继。若本机开着代理,把 *.ts.net 加直连或暂时关闭代理再试。"
                            }
                            testing = false
                        }
                    } label: {
                        HStack { Text("从中继发现机器"); Spacer(); if testing { ProgressView() } }
                    }
                    .disabled(key.trimmingCharacters(in: .whitespaces).count < 16)
                    if let result {
                        Text(result).font(.system(size: 13)).foregroundStyle(.secondary)
                    }
                }
            }
            .navigationTitle(Text("一键添加"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("取消") { onCancel() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(discovered.isEmpty ? "添加三台 Mac" : "添加发现的机器") {
                        onDone(key, discovered)
                    }
                    .disabled(key.trimmingCharacters(in: .whitespaces).count < 16)
                }
            }
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
    @Published var harnessURL: String
    @Published var accessKey: String
    let isNew: Bool
    // Carried through an edit untouched; rebuilding the host from the three
    // visible fields silently reset these two.
    private let isEnabled: Bool
    private let lastSeenAt: Date?

    init() {
        id = UUID().uuidString.lowercased()
        name = ""
        baseURL = "https://"
        harnessURL = ""
        accessKey = ""
        isNew = true
        isEnabled = true
        lastSeenAt = nil
    }

    init(host: GatewayHost) {
        id = host.id
        name = host.name
        baseURL = host.baseURL
        harnessURL = host.harnessURL ?? ""
        accessKey = GatewayHostStore.accessKey(hostId: host.id) ?? ""
        isNew = false
        isEnabled = host.isEnabled
        lastSeenAt = host.lastSeenAt
    }

    func makeHost() -> GatewayHost {
        let trimmedHarness = harnessURL.trimmingCharacters(in: .whitespaces)
        var trimmedEngine = baseURL.trimmingCharacters(in: .whitespaces)
        // 新建草稿的占位前缀没被填过 = 引擎留空。
        if trimmedEngine == "https://" { trimmedEngine = "" }
        return GatewayHost(id: id,
                           name: name.trimmingCharacters(in: .whitespaces),
                           baseURL: trimmedEngine,
                           harnessURL: trimmedHarness.isEmpty ? nil : trimmedHarness,
                           isEnabled: isEnabled,
                           lastSeenAt: lastSeenAt)
    }
}

private struct GatewayHostEditor: View {
    /// @ObservedObject 且对象由 GatewayEditorCoordinator 单例持有:本视图
    /// 被重建多少次都只是重新绑定同一份草稿,输入中的文字动不了。
    @ObservedObject var draft: GatewayHostDraft
    let onSave: (GatewayHost) -> Void
    let onCancel: () -> Void

    @State private var testResult: String?
    @State private var isTesting = false

    /// 只收 https:访问密钥挂在每个请求的 Authorization 头上,而本 app 开了
    /// NSAllowsArbitraryLoads,一个手滑的 http:// 就等于把密钥明文撒在当前
    /// WiFi 上,系统层没有兜底。
    private var canSave: Bool {
        guard !draft.name.trimmingCharacters(in: .whitespaces).isEmpty else { return false }
        // 两个地址至少填一个;填了的必须是合法 https。
        let engine = draft.baseURL.trimmingCharacters(in: .whitespaces)
        let harness = draft.harnessURL.trimmingCharacters(in: .whitespaces)
        let engineEmpty = engine.isEmpty || engine == "https://"
        if engineEmpty && harness.isEmpty { return false }
        if !engineEmpty {
            guard let url = URL(string: engine), url.host != nil,
                  url.scheme?.lowercased() == "https" else { return false }
        }
        if !harness.isEmpty {
            guard let harnessURL = URL(string: harness), harnessURL.host != nil,
                  harnessURL.scheme?.lowercased() == "https" else { return false }
        }
        return true
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("比如 MacBook / cortex", text: $draft.name)
                        .textInputAutocapitalization(.never)
                } header: {
                    Text("名称")
                }

                Section {
                    TextField("https://…/leoagent-relay/relay/api/m/机器名", text: $draft.harnessURL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .font(.system(size: 14, design: .monospaced))
                } header: {
                    Text("编码会话地址")
                } footer: {
                    Text("推荐用「一键添加」自动填好中继地址;手动填时必须 https。控制 Claude Code / Codex / Grok 走这个地址。")
                }

                Section {
                    TextField("https://主机名.tail23de22.ts.net:8645(可留空)", text: $draft.baseURL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .font(.system(size: 14, design: .monospaced))
                } header: {
                    Text("引擎地址(端口 8645,可选)")
                } footer: {
                    Text("这台 Mac 上如果还跑着通用 Agent 引擎,填它的地址;只控编码 CLI 的话留空即可。")
                }

                Section {
                    SecureField("粘贴密钥", text: $draft.accessKey)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                } header: {
                    Text("访问密钥(必填)")
                } footer: {
                    Text("就是那台 Mac 上 ~/.leoagent/key 文件的内容,每台 Mac 各不相同。在那台 Mac 的终端里运行 cat ~/.leoagent/key 复制过来。只存在本机钥匙串,不会同步 iCloud。")
                }

                Section {
                    Button {
                        Task { await test() }
                    } label: {
                        HStack {
                            Text("测试连接")
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
            .navigationTitle(Text(draft.isNew ? "添加 Mac" : "编辑 Mac"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消") { onCancel() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("保存") {
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
        // 优先测编码会话地址(主用途);没填才测引擎地址。
        let harnessProbe = host.harnessBase.map {
            GatewayHost(id: host.id, name: host.name, baseURL: $0.absoluteString)
        }
        guard await GatewayHostStore.probe(harnessProbe ?? host) else {
            testResult = "连不上这台 Mac。检查地址拼写,以及本机上的 Tailscale 是否已打开。"
            return
        }
        guard !draft.accessKey.isEmpty else {
            testResult = "Mac 可以连通。还差访问密钥:去那台 Mac 终端运行 cat ~/.leoagent/key,把结果粘贴进来。"
            return
        }
        let base = harnessProbe?.url ?? host.url
        guard let url = base else {
            testResult = "地址无效。"
            return
        }
        let client = LeoAgentClient(baseURL: url, apiKey: draft.accessKey,
                                    harnessBaseURL: host.harnessBase)
        do {
            let caps = try await client.capabilities()
            if caps.platform == "leoagent" {
                // 1.63+ 起 harness 由 leocodebox 接管(协议同构);标出承载方
                // 便于灰度期分辨这台 Mac 切没切。
                let hostedBy = caps.server == "leocodebox" ? "由 leocodebox 承载," : ""
                testResult = "连接成功。\(hostedBy)密钥有效,审批\(caps.has("approval_events") ? "可用" : "不可用")。保存即可开始使用。"
            } else {
                testResult = "连接成功(\(caps.platform))。"
            }
        } catch {
            testResult = "密钥被拒绝或服务异常:\(error.localizedDescription)"
        }
    }
}

// MARK: - Console

struct GatewayConsoleView: View {
    let host: GatewayHost
    @StateObject private var driver: GatewayRunDriver
    @State private var input = ""
    @FocusState private var inputFocused: Bool

    init(host: GatewayHost, client: LeoAgentClient) {
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
        .onAppear { driver.reattachIfNeeded() }
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
            TextField("让这台 Mac 干点什么…", text: $input, axis: .vertical)
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

struct GatewayItemView: View {
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
                    VStack(spacing: LeoTheme.Spacing.md) {
                        Image(systemName: "desktopcomputer.trianglebadge.exclamationmark")
                            .font(.system(size: 34, weight: .medium))
                            .foregroundStyle(.tint)
                        VStack(spacing: LeoTheme.Spacing.xs) {
                            Text("还没有可指挥的 Mac")
                                .font(.headline)
                            Text("先连接 Mac，就能从这里直接运行编码任务、审批和叫停。")
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                                .multilineTextAlignment(.center)
                        }
                        NavigationLink {
                            GatewaySettingsView()
                        } label: {
                            Label("去连接 Mac", systemImage: "link.badge.plus")
                                .frame(maxWidth: .infinity, minHeight: LeoTheme.TouchTarget.minimum)
                        }
                        .buttonStyle(.borderedProminent)
                    }
                    .padding(.vertical, LeoTheme.Spacing.lg)
                    .frame(maxWidth: .infinity)
                    .listRowBackground(Color.clear)
                }
            }
            ForEach(store.activeHosts) { host in
                if let client = store.client(for: host) {
                    // 编码会话是主用途,放前面。
                    NavigationLink {
                        HarnessLauncherView(host: host, client: client)
                    } label: {
                        Label("在 \(host.name) 上跑编码任务", systemImage: "terminal")
                    }
                    if host.url != nil {
                        NavigationLink {
                            GatewayConsoleView(host: host, client: client)
                        } label: {
                            Label("\(host.name) 的引擎对话", systemImage: "desktopcomputer")
                        }
                    }
                } else {
                    Label {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(host.name)
                            Text("缺访问密钥,去「设置 → 远程机器」补上").font(.system(size: 12)).foregroundStyle(.secondary)
                        }
                    } icon: {
                        Image(systemName: "desktopcomputer.trianglebadge.exclamationmark")
                    }
                }
            }
        }
        .navigationTitle(Text("Mac 控制台"))
        .navigationBarTitleDisplayMode(.inline)
    }
}

// MARK: - Harness (coding CLIs on the Mac)

/// Pick a coding CLI and a directory, then drive it from the phone.
///
/// The picker only lists what the Mac actually has installed — the server
/// reports what it can locate, so there is never a choice that fails on use.
struct HarnessLauncherView: View {
    let host: GatewayHost
    let client: LeoAgentClient

    @State private var kinds: [HarnessKind] = []
    @State private var selected: HarnessKind?
    @State private var cwd = "~"
    @State private var prompt = ""
    @State private var loadError: String?
    @State private var isLoading = true
    @State private var liveSessions: [HarnessSessionSummary] = []

    var body: some View {
        List {
            // Mac 上进行中的会话:随时点进接管(回放 + 实时跟随)。
            // 这是"第二具身体"的核心——桌面开的活,手机拿起来就能继续。
            if !liveSessions.isEmpty {
                Section {
                    ForEach(liveSessions) { session in
                        NavigationLink {
                            HarnessConsoleView(
                                driver: HarnessSessionDriver(
                                    client: client,
                                    harness: HarnessKind(key: session.harness, name: session.name),
                                    cwd: session.cwd),
                                firstPrompt: "",
                                attachSessionId: session.id)
                        } label: {
                            HStack(spacing: 10) {
                                Image(systemName: session.waitingForApproval
                                    ? "hand.raised.fill" : "terminal")
                                    .foregroundStyle(session.waitingForApproval ? .orange : .secondary)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(session.name).font(.system(size: 15))
                                    if let window = session.windowLabel, !window.isEmpty {
                                        Text(window)
                                            .font(.system(size: 12))
                                            .foregroundStyle(.secondary)
                                            .lineLimit(1)
                                    }
                                    Text(session.cwd)
                                        .font(.system(size: 11, design: .monospaced))
                                        .foregroundStyle(.secondary)
                                        .lineLimit(1).truncationMode(.head)
                                }
                                Spacer()
                                Text(sessionStatusLabel(session.status))
                                    .font(.system(size: 11))
                                    .foregroundStyle(session.waitingForApproval ? .orange : .secondary)
                            }
                        }
                    }
                } header: {
                    Text("进行中的会话")
                } footer: {
                    Text("这台 Mac 上正在跑的任务,点进去即可查看、审批、继续下指令。")
                }
            }

            Section {
                if isLoading {
                    HStack { ProgressView(); Text("正在检测装了哪些 CLI…").foregroundStyle(.secondary) }
                } else if kinds.isEmpty {
                    // 引擎也回 /v1/capabilities,只是没有 harnesses 字段——
                    // 这里为空通常是地址填成了引擎端口,不是真没装 CLI。
                    Text("在 \(host.name) 上没找到可控的编码 CLI。若那台 Mac 的 LeoAgent 服务在跑,检查「编码会话地址」是否填了 8647 端口。")
                        .font(.system(size: 14)).foregroundStyle(.secondary)
                } else {
                    ForEach(kinds) { kind in
                        Button {
                            selected = kind
                        } label: {
                            HStack {
                                Image(systemName: "terminal")
                                Text(kind.name)
                                Spacer()
                                if selected?.key == kind.key {
                                    Image(systemName: "checkmark").foregroundStyle(.tint)
                                }
                            }
                        }
                        .buttonStyle(.plain)
                    }
                }
                if let loadError {
                    Text(loadError).font(.system(size: 13)).foregroundStyle(.red)
                }
            } header: {
                Text("选一个编码 CLI")
            } footer: {
                Text("它们跑在 \(host.name) 上你指定的目录里。可以在这里或手表上转向、审批、叫停。")
            }

            Section {
                TextField("~/项目目录,比如 ~/Documents/demo", text: $cwd)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .font(.system(size: 14, design: .monospaced))
            } header: {
                Text("工作目录")
            }

            Section {
                TextField("要它做什么?", text: $prompt, axis: .vertical)
                    .lineLimit(2...6)
            } header: {
                Text("第一条指令")
            }

            Section {
                if let selected {
                    NavigationLink {
                        HarnessConsoleView(
                            driver: HarnessSessionDriver(client: client, harness: selected, cwd: cwd),
                            firstPrompt: prompt)
                    } label: {
                        Label("开始干活", systemImage: "play.circle")
                    }
                    .disabled(prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
        }
        .navigationTitle(Text("编码任务"))
        .navigationBarTitleDisplayMode(.inline)
        .task {
            do {
                kinds = try await client.harnessKinds()
                selected = kinds.first
            } catch {
                loadError = error.localizedDescription
            }
            isLoading = false
            // 进行中会话列表:失败不挡住新建流程,静默降级。
            if let sessions = try? await client.harnessSessions() {
                liveSessions = sessions.filter {
                    !["orphaned", "completed", "failed", "cancelled"].contains($0.status)
                }
            }
        }
        .refreshable {
            if let sessions = try? await client.harnessSessions() {
                liveSessions = sessions.filter {
                    !["orphaned", "completed", "failed", "cancelled"].contains($0.status)
                }
            }
        }
    }

    private func sessionStatusLabel(_ status: String) -> String {
        switch status {
        case "running", "starting": return "运行中"
        case "idle": return "待命"
        case "waiting_for_approval": return "等审批"
        default: return status
        }
    }
}

/// Live view of one coding CLI working on the Mac.
struct HarnessConsoleView: View {
    @StateObject var driver: HarnessSessionDriver
    let firstPrompt: String
    /// 非空 = 接管 Mac 上已存在的会话(回放 + 跟随),而不是新建。
    var attachSessionId: String? = nil
    var thinking: String? = nil
    @State private var input = ""
    @State private var started = false

    var body: some View {
        VStack(spacing: 0) {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 12) {
                        ForEach(driver.items) { item in
                            GatewayItemView(item: item).id(item.id)
                        }
                        // "idle" means the CLI finished a turn and is waiting
                        // for the operator — a typing indicator there would
                        // promise progress that is not happening.
                        if driver.isRunning && driver.pendingApproval == nil
                            && driver.status != "idle" {
                            HStack(spacing: 8) {
                                LeoTypingIndicator()
                                Text(driver.status)
                                    .font(.system(size: 12, design: .monospaced))
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }
                    .padding(16)
                }
                .onChange(of: driver.items.count) { _ in
                    guard let last = driver.items.last else { return }
                    withAnimation { proxy.scrollTo(last.id, anchor: .bottom) }
                }
            }

            if let approval = driver.pendingApproval {
                GatewayApprovalCard(approval: approval) { choice in
                    driver.respond(to: approval, choice: choice)
                }
            }

            // [T-composer-send-dead] 状态可见:连接中给进度,出错给原因。
            // 以前 lastError 只存不显,失败对用户表现为"点了没反应"。
            if driver.status == "starting" {
                HStack(spacing: 6) {
                    ProgressView().controlSize(.mini)
                    Text("正在连接 Mac…(发送会排队,连上即发)")
                        .font(.caption).foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 14).padding(.vertical, 4)
            } else if let err = driver.lastError, driver.status == "failed" || driver.status == "pending" {
                Text(err)
                    .font(.caption).foregroundStyle(.red)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 14).padding(.vertical, 4)
            }

            HStack(spacing: 10) {
                TextField("继续下指令…", text: $input, axis: .vertical)
                    .lineLimit(1...4)
                    .textFieldStyle(.plain)
                    .padding(.horizontal, 12).padding(.vertical, 9)
                    .background(Color.secondary.opacity(0.12), in: RoundedRectangle(cornerRadius: 18))
                Button {
                    // Clear only after the driver accepted it; steering during
                    // the starting window used to eat the text silently.
                    if driver.steer(input) { input = "" }
                } label: {
                    Image(systemName: "arrow.up.circle.fill").font(.system(size: 28))
                }
                .disabled(input.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
            .padding(.horizontal, 14).padding(.vertical, 10)
            .background(.bar)
        }
        .navigationTitle(Text(driver.harness.name))
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                if driver.isRunning {
                    Button { driver.stop() } label: {
                        Image(systemName: "stop.circle.fill").foregroundStyle(.red)
                    }
                }
            }
        }
        .onAppear {
            // Start once; coming back to this view resumes the stream at the
            // last seq instead of launching a second session.
            if !started {
                started = true
                if let attachSessionId {
                    driver.attach(existingSessionId: attachSessionId)
                } else {
                    driver.start(prompt: firstPrompt, thinking: thinking)
                }
            } else { driver.resumeIfNeeded() }
        }
        .onDisappear { driver.detach() }
    }
}

// MARK: - [T-mac-composer] 对话框直达 Mac

/// 对话框"指挥 Mac"选中的目标:哪台 Mac + 哪个 CLI。
struct ComposerMacTarget: Identifiable {
    static let clis: [(String, String)] = [
        ("claude", "Claude Code"), ("codex", "Codex"), ("grok", "Grok"),
    ]
    let host: GatewayHost
    let cliKey: String
    let cliName: String
    var id: String { host.id + cliKey }
}

/// 全屏 Mac 对话:复用控制台的 HarnessConsoleView,套一层导航 + 关闭按钮。
struct ComposerMacChatCover: View {
    let target: ComposerMacTarget
    let onClose: () -> Void

    var body: some View {
        NavigationStack {
            if let client = GatewayHostStore.shared.client(for: target.host) {
                HarnessConsoleView(
                    driver: HarnessSessionDriver(
                        client: client,
                        harness: HarnessKind(key: target.cliKey, name: target.cliName),
                        cwd: "~"),
                    firstPrompt: "")
                .navigationTitle("\(target.host.name) · \(target.cliName)")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("关闭", action: onClose)
                    }
                }
            } else {
                VStack(spacing: 12) {
                    Text("缺少访问密钥").font(.headline)
                    Text("去 设置 → 远程机器 里补上这台机器的密钥。")
                        .font(.footnote).foregroundStyle(.secondary)
                    Button("关闭", action: onClose)
                }
            }
        }
    }
}
