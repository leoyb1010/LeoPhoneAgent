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

// 自营中继地址与机器预设原先写死在源码里（公开仓库会泄露私有 tailnet 主机名），
// 改由本机未跟踪的 Configs/LocalRelay.xcconfig 注入；未配置时一键添加显示明确状态，不发请求。

struct GatewaySettingsView: View {
    @StateObject private var store = GatewayHostStore.shared
    @ObservedObject private var sshStore = RemoteHostStore.shared
    @ObservedObject private var editor = GatewayEditorCoordinator.shared
    @State private var reachable: [String: Bool] = [:]
    @State private var showQuickSetup = false
    @State private var scanMessage: String?
    /// [T-link-problem] 正在跑的检测数,>0 时问题块的主按钮置灰(避免连点叠出多个探测)。
    @State private var activeRefreshes = 0
    /// [T-gateway-delete-confirm] 左滑删除待确认的机器。存机器本身,不存行号:
    /// 确认框弹着时列表可能因为刷新变动。删除会连同本机保存的访问密钥一起删掉。
    @State private var pendingDeleteHost: GatewayHost?
    /// [up-macsession] 远程机器页直达外部 agent 登录(Claude Code / Codex / Gemini…在 Mac 上没登录时)。
    @State private var agentLogin: GatewayAgentLoginTarget?
    /// 远程机器行上的「终端」打不开时的原因（没地址 / 没固定主机公钥 / 没钥匙）。
    @State private var terminalProblem: String?
    /// [F-mac-fleet-advanced] Mac 舰队默认关闭;开关只管入口显隐,不动已连接的机器。
    @AppStorage(MacFleetFeature.defaultsKey) private var macFleetEnabled = false

    var body: some View {
        List {
            Section {
                Toggle("Mac 舰队（高级）", isOn: $macFleetEnabled)
                    .onChange(of: macFleetEnabled) { _, on in
                        if on { MacLiveSessionsStore.shared.start() } else { MacLiveSessionsStore.shared.stop() }
                    }
            } footer: {
                Text("打开后显示首页「Mac 进行中」、Mac 控制台、/mac 和「发到 Mac」。审批通知、藏宝阁、Grok 登录不受影响。")
            }

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
                            Label("扫码添加机器", systemImage: "qrcode.viewfinder")
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
                        let problem = store.linkProblem(for: host.id)
                        VStack(alignment: .leading, spacing: LeoTheme.Spacing.xs) {
                            Button {
                                editor.beginEdit(host)
                            } label: {
                                VStack(alignment: .leading, spacing: 4) {
                                    GatewayHostRow(host: host, isReachable: reachable[host.id], relayE2E: store.relayE2E[host.id],
                                                   route: store.routeStatuses[host.id] ?? store.routeSelectors[host.id].flatMap {
                                                       $0.current.map { GatewayRouteStatus(direct: $0 == .direct, latencyMilliseconds: nil, failedAt: nil) }
                                                   },
                                                   path: store.routeSelectors[host.id], problem: problem)
                                    if store.fakeIPHosts.contains(host.id) {
                                        FakeIPHintCard()
                                    }
                                    if let deviceId = host.device?.deviceId,
                                       sshStore.hosts.contains(where: { $0.deviceId == deviceId }) {
                                        Label("SSH 已配置", systemImage: "terminal").font(.caption).foregroundStyle(.secondary)
                                    }
                                }
                            }
                            .buttonStyle(.plain)
                            // [T-link-problem] 失败时:是谁的问题 + 一个主按钮,技术细节折叠。
                            // 放在行按钮外面:嵌在 Button 里会和整行的点击(进入编辑)抢手势。
                            HStack(spacing: 14) {
                                GatewayAgentLoginMenu(host: host) { kind in
                                    agentLogin = GatewayAgentLoginTarget(host: host, kind: kind)
                                }
                                if !host.isAndroidBody {
                                    Button {
                                        terminalProblem = SSHTerminalLauncher.open(mac: host)
                                    } label: {
                                        Label("终端", systemImage: "apple.terminal")
                                            .font(.caption.weight(.medium))
                                    }
                                    .buttonStyle(.borderless)
                                    .accessibilityIdentifier("gateway.terminal")
                                    // [takeover] 这台 Mac 终端里的 Claude Code 会话,接到手机上继续。
                                    MacTerminalSessionsButton(hostIds: [host.id])
                                }
                            }
                            .padding(.leading, 20)
                            if let problem {
                                LeoLinkProblemView(
                                    problem: problem,
                                    isBusy: activeRefreshes > 0,
                                    onRetry: { Task { await refresh() } },
                                    onRescan: { scanPairCode() },
                                    onEditAddress: { editor.beginEdit(host) },
                                    onActed: { store.resumeLink(host.id) })
                                    .padding(.leading, 20)   // 与行内文字对齐(状态圆点 8 + 间距 12)
                            }
                        }
                    }
                    .onDelete { offsets in
                        if let index = offsets.first, store.hosts.indices.contains(index) {
                            pendingDeleteHost = store.hosts[index]
                        }
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
                        Label("扫码添加机器", systemImage: "qrcode.viewfinder")
                    }
                } footer: {
                    Text("扫描 Mac 出示的短时配对码。访问授权仅保存在本机。")
                }
            }
            Section("SSH 主机") {
                NavigationLink(destination: RemoteHostSettingsView()) {
                    Label("管理 SSH 连接", systemImage: "terminal")
                }
                ForEach(sshStore.hosts.filter { $0.deviceId == nil }) { host in
                    VStack(alignment: .leading) {
                        Text(host.name)
                        Text("仅配置 SSH，尚未关联远控设备").font(.caption).foregroundStyle(.secondary)
                    }
                }
            }
        }
        .navigationTitle(Text("我的设备"))
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await refresh() }
        .sheet(isPresented: $showQuickSetup) {
            QuickFleetSetupSheet { key, machines in
                // 表单在未配置中继地址时禁用了确认按钮；这里再兜底一次，绝不拼出空地址。
                guard let apiRoot = LeoRelayConfig.apiRoot else { showQuickSetup = false; return }
                if machines.isEmpty {
                    for preset in LeoRelayConfig.fleet {
                        let host = GatewayHost(
                            id: preset.machine.lowercased(),
                            name: preset.name,
                            baseURL: "",
                            harnessURL: RelayMachinesClient.harnessURL(for: preset.machine, apiRoot: apiRoot))
                        GatewayHostStore.saveAccessKey(key, hostId: host.id)
                        store.upsert(host)
                    }
                } else {
                    store.upsertDiscovered(machines, key: key, apiRoot: apiRoot, explicit: true)
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
        .sheet(item: $agentLogin) { target in
            if let client = store.client(for: target.host) {
                AgentLoginSheet(client: client, kind: target.kind) { ok in
                    if ok { Task { _ = try? await client.harnessKinds() } }   // 刷新登录状态
                }
            }
        }
        .alert("打不开终端", isPresented: Binding(get: { terminalProblem != nil }, set: { if !$0 { terminalProblem = nil } })) {
            Button("好", role: .cancel) {}
        } message: { Text(terminalProblem ?? "") }
        .task { await refresh() }
        // [T-link-problem] 从 Tailscale / 系统设置回来:还有问题在显示就重新检测一遍,不用再下拉刷新。
        .onReceive(NotificationCenter.default.publisher(for: UIApplication.didBecomeActiveNotification)) { _ in
            if !store.linkBook.problems.isEmpty { Task { await refresh() } }
        }
        .alert("扫码", isPresented: Binding(
            get: { scanMessage != nil },
            set: { if !$0 { scanMessage = nil } }
        )) {
            Button("好", role: .cancel) { scanMessage = nil }
        } message: {
            Text(scanMessage ?? "")
        }
        .alert("删除这台机器？", isPresented: Binding(
            get: { pendingDeleteHost != nil },
            set: { if !$0 { pendingDeleteHost = nil } }
        ), presenting: pendingDeleteHost) { host in
            Button("删除", role: .destructive) { store.delete(id: host.id) }
            Button("取消", role: .cancel) {}
        } message: { host in
            Text("「\(host.name)」和它保存在本机的访问密钥会一起删除。中继刷新时不会再自动加回来，要用时重新添加或扫码。")
        }
    }

    private func scanPairCode() {
        GatewayPairing.scan(store: store) { message, paired in
            scanMessage = message
            if paired { Task { await refresh() } }
        }
    }

    private func refresh() async {
        activeRefreshes += 1
        defer { activeRefreshes -= 1 }
        // [T-relay-key-fallback] 同一个中继根下可能存着好几把密钥(每台主机一把)。
        // 逐把试,第一把成功就不再重复列举;第一把失效时后面的还有机会,
        // 而不是像以前那样整条发现链跟着 hosts[0] 一起死。
        var succeededRoots: [String] = []
        // [T-link-problem] 中继这一层的结论:列表拉成功 → 记下在线的机器名;失败 → 记下原因
        // (同一个根下的每台机器是同一个问题:密钥被拒、中继连不上)。
        var liveByRoot: [String: Set<String>] = [:]
        var failureByRoot: [String: LeoLinkProblem] = [:]
        for credential in RelayMachinesClient.credentials(from: GatewayPairing.relayCredentialCandidates(store)) {
            if succeededRoots.contains(where: { RelayMachinesClient.sameApiRoot($0, credential.apiRoot) }) {
                continue
            }
            let root = Self.rootKey(credential.apiRoot)
            do {
                let live = try await RelayMachinesClient.list(apiRoot: credential.apiRoot, key: credential.key)
                succeededRoots.append(credential.apiRoot)
                failureByRoot[root] = nil
                liveByRoot[root] = Set(live.filter(\.online).map { $0.name.lowercased() })
                store.upsertDiscovered(live, key: credential.key, apiRoot: credential.apiRoot)
            } catch {
                // 页面被关掉时请求会被取消,那不是连接问题。
                if Task.isCancelled || LeoLinkProblem.isCancellation(error) { return }
                // 同一个根下后面的密钥还有机会(上面的 key-fallback):全都失败才算这个根的问题,记第一个原因。
                if failureByRoot[root] == nil {
                    failureByRoot[root] = LeoLinkProblem.from(
                        error: error, context: .init(.discovery, host: URL(string: credential.apiRoot)?.host))
                }
            }
        }
        for host in store.hosts {
            // 编辑期间不做后台探测:探测回写会触发整页重算。
            if editor.draft != nil { return }
            let problem = await diagnose(host, liveByRoot: liveByRoot, failureByRoot: failureByRoot)
            if Task.isCancelled { return }
            reachable[host.id] = problem == nil
            store.recordLinkProblem(problem, for: host.id)
            if problem == nil { store.markSeen(id: host.id) }
        }
    }

    /// 这台机器现在好不好,不好就是谁的问题。
    /// 经中继的机器先看中继这一层:列表拉失败 = 同一个问题(密钥被拒 / 连不上);
    /// 拉成功但它不在在线列表里 = 它没连着中继(原来的 /health 探测对中继机器只证明「中继在线」,
    /// 机器睡着了也会显示在线)。其余走原来的 /health 探测。
    private func diagnose(_ host: GatewayHost, liveByRoot: [String: Set<String>],
                          failureByRoot: [String: LeoLinkProblem]) async -> LeoLinkProblem? {
        if let root = RelayMachinesClient.apiRoot(fromHarnessURL: host.harnessURL) {
            let key = Self.rootKey(root)
            if let failure = failureByRoot[key] { return failure }
            if let live = liveByRoot[key] {
                let machine = Self.relayMachine(of: host)
                if !live.contains(machine) && !live.contains(host.id.lowercased()) {
                    return LeoLinkProblem.macOffline(machineName: host.name, detail: "不在中继的在线列表里: \(machine)")
                }
            }
        }
        return await GatewayHostStore.diagnose(host)
    }

    private static func rootKey(_ apiRoot: String) -> String {
        RelayMachinesClient.normalizeApiRoot(apiRoot).lowercased()
    }

    /// harnessURL 里 `/m/` 之后的机器名(小写)。
    private static func relayMachine(of host: GatewayHost) -> String {
        guard let raw = host.harnessURL, let range = raw.range(of: "/m/", options: .backwards) else { return host.id.lowercased() }
        return String(raw[range.upperBound...]).lowercased()
    }
}

/// 扫码配对:设置页的「扫码添加」和问题块的「重新扫码」共用。
/// 结果文案经 onResult 交给调用方显示(设置页用弹窗);paired == true 表示真的配上了,调用方该刷新。
@MainActor
enum GatewayPairing {
    static func scan(store: GatewayHostStore? = nil,
                     onResult: @escaping (_ message: String, _ paired: Bool) -> Void) {
        let store = store ?? GatewayHostStore.shared
        CameraOffloadBridge.scanCode { data, error in
            Task { @MainActor in
                if let error {
                    onResult(error as String, false)
                    return
                }
                let raw = (data?["payload"] as? String) ?? ""
                if let directPair = DirectPairPayload.parse(raw) {
                    do {
                        let host = try await store.pairDirect(directPair, name: UIDevice.current.name)
                        onResult("已加入 \(host.name)", true)
                    } catch {
                        // 配对码过期 / 无效 → 让 Mac 重新出示;连不上 → 说清是谁的问题(多半是 Tailscale)。
                        onResult(LeoLinkProblem.from(
                            error: error, context: .init(.pairing, host: URL(string: directPair.apiRoot)?.host)).message, false)
                    }
                    return
                }
                guard let pair = RelayPairPayload.parse(raw) else {
                    onResult("不是本 App 的配对码。码里应是中继根和机器名。", false)
                    return
                }
                if let join = pair.join, !join.isEmpty {
                    do {
                        let joined = try await RelayMachinesClient.join(apiRoot: pair.apiRoot, token: join)
                        store.upsertDiscovered([
                            RelayDiscoveredMachine(name: pair.machine, online: false, platform: nil, server: nil, version: nil)
                        ], key: joined.key, apiRoot: pair.apiRoot, explicit: true, e2eKey: pair.e2e)
                        onResult("已加入 \(pair.machine)", true)
                    } catch {
                        // 以前不论什么原因都说「短码已过期或无效」:没网、Tailscale 没开时这句话是错的。
                        onResult(LeoLinkProblem.from(
                            error: error, context: .init(.pairing, host: URL(string: pair.apiRoot)?.host)).message, false)
                    }
                    return
                }
                guard let credential = RelayMachinesClient.credential(
                    matching: pair.apiRoot,
                    from: relayCredentialCandidates(store)
                ) else {
                    onResult("这是旧码。请让对端出示带短码的新配对码，或先粘贴中继密钥。", false)
                    return
                }
                store.upsertDiscovered([
                    RelayDiscoveredMachine(name: pair.machine, online: false, platform: nil, server: nil, version: nil)
                ], key: credential.key, apiRoot: credential.apiRoot, explicit: true, e2eKey: pair.e2e)
                onResult("已加入 \(pair.machine)", true)
            }
        }
    }

    static func relayCredentialCandidates(_ store: GatewayHostStore) -> [RelayCredentialCandidate] {
        store.hosts.map { host in
            RelayCredentialCandidate(
                harnessURL: host.harnessURL,
                key: GatewayHostStore.accessKey(hostId: host.id)
            )
        }
    }
}

/// 一键添加:中继地址与机器预设来自本机构建配置,只收一次密钥。
private struct QuickFleetSetupSheet: View {
    let onDone: (String, [RelayDiscoveredMachine]) -> Void
    let onCancel: () -> Void
    @State private var key = ""
    @State private var testing = false
    @State private var result: String?
    /// [T-link-problem] 发现失败时:谁的问题 + 一个主按钮(替代原来那句「连不上中继…」)。
    @State private var problem: LeoLinkProblem?
    @State private var copiedCommand = false
    @State private var discovered: [RelayDiscoveredMachine] = []
    private let apiRoot = LeoRelayConfig.apiRoot
    private let fleet = LeoRelayConfig.fleet
    private let sshTarget = LeoRelayConfig.sshTarget

    var body: some View {
        NavigationStack {
            Form {
                if apiRoot == nil {
                    Section {
                        Label("未配置中继地址", systemImage: "exclamationmark.triangle.fill")
                            .foregroundStyle(.orange)
                    } footer: {
                        Text("此版本构建时没有写入自营中继地址，一键添加与中继发现不可用。可用扫码配对或手动添加设备。")
                    }
                }
                if !fleet.isEmpty {
                    Section {
                        ForEach(fleet, id: \.machine) { preset in
                            Label(preset.name, systemImage: "desktopcomputer")
                        }
                    } header: {
                        Text("找不到中继列表时，可一键填入以下 \(fleet.count) 台设备")
                    } footer: {
                        Text("列表来自中继上在线的机器；预设只是快捷填充。")
                    }
                }
                Section {
                    SecureField("粘贴密钥", text: $key)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    if let sshTarget {
                        Button {
                            UIPasteboard.general.string = "ssh \(sshTarget) \"cat ~/.leoagent/key\""
                            copiedCommand = true
                            LeoHaptics.notification(.success)
                        } label: {
                            Label(copiedCommand ? "已复制取密钥命令" : "复制取密钥命令",
                                  systemImage: copiedCommand ? "checkmark.circle.fill" : "doc.on.doc")
                        }
                    }
                } header: {
                    Text("中继密钥(所有设备共用一把)")
                } footer: {
                    VStack(alignment: .leading, spacing: LeoTheme.Spacing.xs) {
                        Text("把复制的命令粘贴到 Mac 终端，再把返回的密钥粘贴到上方。")
                        Label("连接失败时检查目标设备、授权和 Tailscale 可达性。",
                              systemImage: "exclamationmark.triangle.fill")
                    }
                }
                Section {
                    Button {
                        discover()
                    } label: {
                        HStack { Text("从中继发现机器"); Spacer(); if testing { ProgressView() } }
                    }
                    .disabled(apiRoot == nil || testing || key.trimmingCharacters(in: .whitespaces).count < 16)
                    if let problem {
                        LeoLinkProblemView(problem: problem, isBusy: testing, onRetry: { discover() })
                        // 原来这句提示保留:代理软件把 *.ts.net 拦了,表现和连不上中继一样。
                        Text("若这台 iPhone 开着代理，把 *.ts.net 设为直连或暂时关闭再试。")
                            .font(.caption)
                            .foregroundStyle(LeoTheme.ColorToken.secondaryText)
                    } else if let result {
                        Text(result).font(.system(size: 13)).foregroundStyle(.secondary)
                    }
                }
            }
            .navigationTitle(Text("一键添加"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("取消") { onCancel() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(discovered.isEmpty ? "添加预设设备" : "添加发现的机器") {
                        onDone(key, discovered)
                    }
                    .disabled(apiRoot == nil || (discovered.isEmpty && fleet.isEmpty)
                              || key.trimmingCharacters(in: .whitespaces).count < 16)
                }
            }
        }
    }
}

extension QuickFleetSetupSheet {
    fileprivate func discover() {
        testing = true
        problem = nil
        Task {
            do {
                guard let apiRoot else { throw RelayDiscoveryError.badURL }
                let rows = try await RelayMachinesClient.list(apiRoot: apiRoot, key: key)
                discovered = rows
                result = rows.isEmpty
                    ? (fleet.isEmpty ? "中继已通，但现在没有在线机器。" : "中继已通，但现在没有在线机器。仍可一键填入预设设备。")
                    : "发现 \(rows.count) 台：\(rows.map(\.name).joined(separator: "、"))"
            } catch {
                discovered = []
                result = nil
                problem = LeoLinkProblem.from(
                    error: error, context: .init(.discovery, host: apiRoot.flatMap { URL(string: $0)?.host }))
            }
            testing = false
        }
    }
}

private struct GatewayHostRow: View {
    let host: GatewayHost
    let isReachable: Bool?
    /// [e2e] 最近一次经中继的请求有没有端到端加密;nil = 还没走过中继。
    var relayE2E: GatewayHostStore.RelayE2EStatus? = nil
    var route: GatewayRouteStatus? = nil
    /// [fix-remote] 当前走的路（直连 / 中继 / SSH）与延迟。
    var path: MacRouteSelector? = nil
    /// [T-link-problem] 有问题时状态行写「谁的问题」,不再只有一句「连不上」。
    var problem: LeoLinkProblem? = nil

    var body: some View {
        HStack(spacing: 12) {
            Circle()
                .fill(isReachable == true ? Color.green : (isReachable == false ? Color.secondary.opacity(0.4) : Color.orange))
                .frame(width: 8, height: 8)
                .leoPulse(active: isReachable == nil)
            VStack(alignment: .leading, spacing: 2) {
                Text(host.name).font(.system(size: 16, weight: .medium))
                if let route {
                    HStack {
                        Text(!route.available ? "连接不可用" : (path?.current?.label ?? (route.direct ? "直连" : "中继")))
                        if let ms = path?.latencyMilliseconds ?? route.latencyMilliseconds { Text("\(ms) ms") }
                    }.font(.caption).foregroundStyle(.secondary)
                }
                // [up-device] 加密状态：本次还没走过中继时，用「这台 Mac 加密成功过」作初值，而不是什么都不显示。
                if let e2e = relayE2E ?? (host.relayE2EVerified == true ? .encrypted : nil) {
                    Label(e2e == .encrypted ? AppLocalized("端到端加密")
                            : e2e == .keyMismatch ? AppLocalized("钥匙不一致（直连一次即可修复）")
                            : AppLocalized("中继未加密"),
                          systemImage: e2e == .encrypted ? "lock.fill" : e2e == .keyMismatch ? "exclamationmark.lock" : "lock.open")
                        .font(.caption2)
                        .foregroundStyle(e2e == .encrypted ? Color.secondary : Color.orange)
                }
                // [up-device] 以前把 harness · resumable-events · … 原样打印给用户看；只留人话。
                if let summary = Self.capabilitySummary(host.device?.capabilities ?? []) {
                    Text(summary).font(.caption2).foregroundStyle(.secondary)
                }
                if let address = displayedAddress {
                    Text(address)
                        .font(.system(size: 12, design: .monospaced))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                } else {
                    // [T-gateway-row-relay] 中继发现的机器没有引擎地址,以前这里是一行空白。
                    // 走哪条路已经写在上面一行（直连 / 中继 + 延迟），这里只说在不在线。
                    Text(route == nil && host.harnessURL != nil ? AppLocalized("经中继 · \(statusText)") : statusText)
                        .font(.system(size: 12))
                        .foregroundStyle(.secondary)
                }
            }
            Spacer()
            Image(systemName: "chevron.right")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(.tertiary)
        }
        .contentShape(Rectangle())
    }

    /// Mac 广播的能力 → 用户看得懂的一句话；没有值得说的就不显示。
    static func capabilitySummary(_ capabilities: [String]) -> String? {
        let names: [(String, String)] = [
            ("approval-events", AppLocalized("手机审批")),
            ("resumable-events", AppLocalized("断线续传")),
            ("sync-replica-v1", AppLocalized("同步副本")),
            ("treasury-v1", AppLocalized("藏宝阁")),
        ]
        let parts = names.compactMap { capabilities.contains($0.0) ? $0.1 : nil }
        return parts.isEmpty ? nil : AppLocalized("支持：") + parts.joined(separator: " · ")
    }

    /// 引擎地址;没有时退到直连的编码会话地址。经中继的机器返回 nil(地址里带钥匙路径,也没什么可看的)。
    private var displayedAddress: String? {
        if !host.baseURL.isEmpty { return host.baseURL }
        if let harness = host.harnessURL, !harness.isEmpty,
           RelayMachinesClient.apiRoot(fromHarnessURL: harness) == nil {
            return harness
        }
        return nil
    }

    private var statusText: String {
        switch isReachable {
        case .some(true): return AppLocalized("在线")
        case .some(false): return problem?.owner.blame ?? AppLocalized("连不上")
        case .none: return AppLocalized("检测中…")
        }
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
    /// [fix-remote] SSH 兜底目标（tailnet 名 / 用户）；空 = 用 Mac 广播的或内置默认。
    @Published var sshHost: String
    @Published var sshUser: String
    @Published var sshPort: String
    /// 当前实际会用的目标（给占位提示看）。
    let sshPlaceholder: MacSSHTarget?
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
        sshHost = ""
        sshUser = ""
        sshPort = ""
        sshPlaceholder = nil
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
        sshHost = host.sshTargetOverride?.host ?? ""
        sshUser = host.sshTargetOverride?.user ?? ""
        sshPort = host.sshTargetOverride?.port.map(String.init) ?? ""
        sshPlaceholder = host.resolvedSSHTarget
        isNew = false
        isEnabled = host.isEnabled
        lastSeenAt = host.lastSeenAt
    }

    func makeHost() -> GatewayHost {
        let trimmedHarness = harnessURL.trimmingCharacters(in: .whitespaces)
        var trimmedEngine = baseURL.trimmingCharacters(in: .whitespaces)
        // 新建草稿的占位前缀没被填过 = 引擎留空。
        if trimmedEngine == "https://" { trimmedEngine = "" }
        var host = GatewayHost(id: id,
                               name: name.trimmingCharacters(in: .whitespaces),
                               baseURL: trimmedEngine,
                               harnessURL: trimmedHarness.isEmpty ? nil : trimmedHarness,
                               isEnabled: isEnabled,
                               lastSeenAt: lastSeenAt)
        let sshHostValue = sshHost.trimmingCharacters(in: .whitespaces)
        let sshUserValue = sshUser.trimmingCharacters(in: .whitespaces)
        if MacSSHTarget.valid(host: sshHostValue), MacSSHTarget.valid(user: sshUserValue) {
            let port = Int(sshPort.trimmingCharacters(in: .whitespaces)).flatMap(MacSSHTarget.validPort)
            host.sshTargetOverride = MacSSHTarget(host: sshHostValue, user: sshUserValue, port: port)
        }
        return host
    }
}

private struct GatewayHostEditor: View {
    /// [up-device] 已添加的机器默认收起地址 / 密钥 / SSH。
    @State private var showConnectionFields = false
    /// @ObservedObject 且对象由 GatewayEditorCoordinator 单例持有:本视图
    /// 被重建多少次都只是重新绑定同一份草稿,输入中的文字动不了。
    @ObservedObject var draft: GatewayHostDraft
    let onSave: (GatewayHost) -> Void
    let onCancel: () -> Void

    @State private var testResult: String?
    /// [T-link-problem] 测试失败时:谁的问题 + 一个主按钮(替代原来一行「连不上这台 Mac…」)。
    @State private var testProblem: LeoLinkProblem?
    @State private var isTesting = false

    /// 只收 https:访问密钥挂在每个请求的 Authorization 头上,而本 app 开了
    /// NSAllowsArbitraryLoads,一个手滑的 http:// 就等于把密钥明文撒在当前
    /// WiFi 上,系统层没有兜底。
    /// 地址合法就能测连通(/health 不用密钥);保存另见 canSave。
    private var canTest: Bool {
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

    /// [T-gateway-key-required] 「访问密钥(必填)」名副其实:没有密钥的机器什么都
    /// 做不了(client(for:) 直接返回 nil)。中继发现 / 扫码加入的机器,密钥在加入时
    /// 已写进钥匙串,打开编辑就带出来了,不用手动再填。
    private var canSave: Bool {
        canTest && !GatewayHostStore.normalizedAccessKey(draft.accessKey).isEmpty
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
                    Button {
                        Task { await test() }
                    } label: {
                        HStack {
                            Text("测试连接")
                            Spacer()
                            if isTesting { ProgressView() }
                        }
                    }
                    .disabled(!canTest || isTesting)
                    if let testProblem {
                        LeoLinkProblemView(problem: testProblem, isBusy: isTesting, onRetry: { Task { await test() } })
                    } else if let testResult {
                        Text(testResult).font(.system(size: 13)).foregroundStyle(.secondary)
                    }
                }

                // [C3] 这台 Mac 上的定时任务:列表、开关、立即运行、删除、从模板新建。
                if !draft.isNew, let saved = GatewayHostStore.shared.hosts.first(where: { $0.id == draft.id }),
                   !saved.isAndroidBody {
                    Section {
                        NavigationLink {
                            MacAutomationsView(host: saved)
                        } label: {
                            Label("定时任务", systemImage: "clock.badge.checkmark")
                        }
                        .accessibilityIdentifier("gateway.automations")
                    } footer: {
                        Text("在这台 Mac 上按计划自动运行的任务，手机锁屏或离线时照样跑。")
                    }
                }

                // [up-device] 已添加的 Mac：地址、密钥、SSH 这些开发者字段收进「连接信息」，默认收起。
                // 扫码添加的机器这些都是自动填的，绝大多数人不需要看。
                if draft.isNew || showConnectionFields {
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
                    TextField("https://主机名.example.ts.net:8645(可留空)", text: $draft.baseURL)
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
                    TextField(draft.sshPlaceholder?.host ?? "tailnet 名，例如 leomac-studio", text: $draft.sshHost)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    TextField(draft.sshPlaceholder?.user ?? "用户名", text: $draft.sshUser)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    TextField(draft.sshPlaceholder?.port.map { "端口 \($0)" } ?? "端口（默认 22）", text: $draft.sshPort)
                        .keyboardType(.numberPad)
                } header: {
                    Text("SSH 兜底（可选）")
                } footer: {
                    Text("直连和中继都连不上时，经 Tailscale 直接 SSH 到这台 Mac 跑命令行（没有审批与工具卡）。填了就优先用这里的；留空就用 Mac 自己报的地址或内置默认。端口留空按 Mac 报的或 22。")
                }

                } else {
                    Section {
                        Button {
                            withAnimation(LeoMotion.standardEase(reduceMotion: LeoMotion.systemReduceMotion)) { showConnectionFields = true }
                        } label: {
                            Label("连接信息（地址、密钥、SSH）", systemImage: "slider.horizontal.3")
                        }
                    } footer: {
                        Text("扫码添加的机器已自动填好，一般不用改。")
                    }
                }
            }
            .navigationTitle(Text(draft.isNew ? "添加 Mac" : draft.name.isEmpty ? "Mac" : draft.name))
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
        testResult = nil
        testProblem = nil
        let host = draft.makeHost()
        // 优先测编码会话地址(主用途);没填才测引擎地址。
        let harnessProbe = host.harnessBase.map {
            GatewayHost(id: host.id, name: host.name, baseURL: $0.absoluteString)
        }
        // 连不上:说清是谁的问题(Tailscale 没开 / 网络 / 中继 / Mac 不在线),而不是一句笼统的「检查地址和 Tailscale」。
        if let problem = await GatewayHostStore.diagnose(harnessProbe ?? host) {
            testProblem = problem
            return
        }
        guard !draft.accessKey.isEmpty else {
            testResult = "Mac 可以连通。还差访问密钥:去那台 Mac 终端运行 cat ~/.leoagent/key,把结果粘贴进来。"
            return
        }
        let base = harnessProbe?.url ?? host.url
        guard let url = base else {
            testProblem = LeoLinkProblem.from(error: GatewayError.badURL)
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
            testProblem = LeoLinkProblem.from(
                error: error, context: .init(.session, host: url.host, machineName: host.name))
        }
    }
}

// MARK: - Console

struct GatewayConsoleView: View {
    let host: GatewayHost
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
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
                .transition(reduceMotion ? .opacity : .move(edge: .bottom).combined(with: .opacity))
            }
            if let unsent = driver.unsentPrompt {
                Button("Restore unsent text") {
                    input = input.isEmpty ? unsent : unsent + "\n\n" + input
                    driver.unsentPrompt = nil
                }
                .font(.footnote)
                .padding(.horizontal, 14)
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
        .animation(LeoMotion.smooth(reduceMotion: reduceMotion), value: driver.pendingApproval?.runId)
        .onAppear { driver.reattachIfNeeded() }
        .onDisappear { driver.cancelLocalStream() }
        .onChange(of: driver.unsentPrompt) { _, text in
            guard let text, input.isEmpty else { return }
            input = text
            driver.unsentPrompt = nil
        }
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
                            Text(driver.statusLabel)
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
    /// 最后一条正文还在流式写入:Markdown 渲染器对未闭合的表格尾巴特殊处理。
    var isStreaming = false

    var body: some View {
        switch item.kind {
        case .assistantText:
            // 和聊天页同一个 Markdown 渲染器:代码块、表格、链接、选择复制都一致。
            // messageId 让流式更新复用同一个渲染器(只增量重排),不是每帧整段重新解析。
            SelectableMarkdownView(markdown: item.text, isStreaming: isStreaming, messageId: item.id)
                .fixedSize(horizontal: false, vertical: true)
                .modifier(MinisOpenURLHandler())
                .frame(maxWidth: .infinity, alignment: .leading)

        case .reasoning:
            Text(item.text)
                .font(.system(size: 13, design: .monospaced))
                .foregroundStyle(.secondary)
                .padding(10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 8))

        case .tool(let name, let isRunning, let isError, let duration):
            GatewayToolRow(item: item, name: name, isRunning: isRunning, isError: isError, duration: duration)

        case .notice where item.prominent:
            Label {
                Text(item.text).font(.system(size: 13)).foregroundStyle(.primary)
            } icon: {
                Image(systemName: "info.circle.fill").foregroundStyle(.orange)
            }
            .padding(10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.orange.opacity(0.1), in: RoundedRectangle(cornerRadius: 8))

        case .notice where item.text.hasPrefix("→ "):
            // [up-console] 用户发出的指令：和本机会话一样，右侧气泡，而不是一行灰色小字。
            HStack {
                Spacer(minLength: 48)
                Text(String(item.text.dropFirst(2)))
                    .font(.body)
                    .foregroundStyle(.primary)
                    .textSelection(.enabled)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 9)
                    .background(Color.primary.opacity(0.06), in: RoundedRectangle(cornerRadius: LeoTheme.Radius.bubble, style: .continuous))
            }
            .frame(maxWidth: .infinity, alignment: .trailing)
            .accessibilityLabel(Text("你：\(String(item.text.dropFirst(2)))"))

        case .notice:
            Text(item.text)
                .font(.footnote)
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

/// 工具行:收起时一行(名字 + 命令摘要 + 用时),点开看完整命令和输出。
private struct GatewayToolRow: View {
    let item: GatewayTranscriptItem
    let name: String
    let isRunning: Bool
    let isError: Bool
    let duration: Double?
    @State private var expanded = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// 完整命令:Mac / CLI 给了完整输入就用它,否则就是摘要本身(收起时只显示一行,展开后全显示)。
    private var command: String { item.detail ?? item.text }
    private var canExpand: Bool { !command.isEmpty || !(item.output ?? "").isEmpty }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button {
                guard canExpand else { return }
                withAnimation(LeoMotion.smooth(reduceMotion: reduceMotion, duration: LeoMotion.standard)) { expanded.toggle() }
            } label: {
                HStack(spacing: 8) {
                    Image(systemName: isRunning ? "gearshape.2" : (isError ? "exclamationmark.triangle" : "checkmark.circle"))
                        .font(.system(size: 13))
                        .foregroundStyle(isError ? .red : (isRunning ? .orange : .green))
                        .leoPulse(active: isRunning)
                    Text(name).font(.system(size: 13, weight: .medium, design: .monospaced))
                    if !item.text.isEmpty, !expanded {
                        Text(item.text)
                            .font(.system(size: 12, design: .monospaced))
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                            .truncationMode(.middle)
                    }
                    Spacer(minLength: 4)
                    if let duration {
                        Text(String(format: "%.2fs", duration))
                            .font(.system(size: 11, design: .monospaced))
                            .foregroundStyle(.tertiary)
                    }
                    if canExpand {
                        Image(systemName: "chevron.right")
                            .font(.system(size: 10, weight: .semibold))
                            .foregroundStyle(.tertiary)
                            .rotationEffect(.degrees(expanded ? 90 : 0))
                    }
                }
                .padding(.vertical, 6)
                .padding(.horizontal, 10)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityHint(canExpand ? Text(expanded ? "收起" : "展开完整命令和输出") : Text(""))

            if expanded {
                VStack(alignment: .leading, spacing: 8) {
                    if !command.isEmpty { block(title: "命令", text: command) }
                    if let output = item.output, !output.isEmpty {
                        block(title: "输出", text: output, tint: isError ? .red : nil)
                    } else if !isRunning {
                        Text("Mac 没有回传这一步的输出。")
                            .font(.system(size: 11)).foregroundStyle(.tertiary)
                    }
                }
                .padding(.horizontal, 10)
                .padding(.bottom, 10)
                .transition(reduceMotion ? .opacity : .opacity.combined(with: .move(edge: .top)))
            }
        }
        .background(Color.secondary.opacity(0.07), in: RoundedRectangle(cornerRadius: 8))
        .clipShape(RoundedRectangle(cornerRadius: 8))
    }

    private func block(title: LocalizedStringKey, text: String, tint: Color? = nil) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title).font(.system(size: 11, weight: .semibold)).foregroundStyle(.secondary)
            // 长输出限高,自己滚;横向不折行时也能看全。
            ScrollView([.vertical, .horizontal]) {
                Text(text)
                    .font(.system(size: 12, design: .monospaced))
                    .foregroundStyle(tint ?? .primary)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: true, vertical: true)
                    .padding(8)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .frame(maxHeight: 240)
            .fixedSize(horizontal: false, vertical: true)
            .background(Color(.tertiarySystemFill), in: RoundedRectangle(cornerRadius: 6))
        }
    }
}

/// The approval card. Buttons come from the gateway's own `choices` array —
/// it narrows the set for risky commands (a "smart denied" one only ever
/// offers once/deny), so a hardcoded four-button row would offer permissions
/// the server would then reject.
extension GatewayApprovalRequest {
    /// The owner's words for a CLI's approval choice (the card, the transcript).
    static func title(forChoice choice: String) -> String {
        switch choice {
        case "once": return AppLocalized("Allow Once")
        case "session": return AppLocalized("Allow This Session")
        case "always": return AppLocalized("Always Allow")
        case "deny": return AppLocalized("Deny")
        default: return choice
        }
    }
}

struct GatewayApprovalCard: View {
    let approval: GatewayApprovalRequest
    let onChoose: (String) -> Void

    /// [remote-ctl-ios] 计划审批(ExitPlanMode):显示计划正文,按钮叫「批准计划并执行 / 不批准」。
    private var isPlan: Bool { HarnessApprovalPresentation.isPlan(tool: approval.tool) }
    /// 只渲染事件给出的选项。
    private var choices: [String] { HarnessApprovalPresentation.visibleChoices(approval.choices, tool: approval.tool) }

    private func label(for choice: String) -> String {
        if isPlan {
            if choice == "once" { return AppLocalized("批准计划并执行") }
            if choice == "deny" { return AppLocalized("不批准") }
        }
        return GatewayApprovalRequest.title(forChoice: choice)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 8) {
                Image(systemName: isPlan ? "list.bullet.clipboard.fill" : "hand.raised.fill").foregroundStyle(.orange)
                if isPlan {
                    Text("计划等你批准").font(.system(size: 15, weight: .semibold))
                } else {
                    Text("Approval needed").font(.system(size: 15, weight: .semibold))
                }
                Spacer()
            }
            if isPlan {
                let plan = HarnessApprovalPresentation.planText(plan: approval.extras["plan"], description: approval.reason)
                if !plan.isEmpty { HarnessPlanBody(text: plan) }
            } else if let reason = approval.reason, !reason.isEmpty {
                Text(reason).font(.system(size: 13)).foregroundStyle(.secondary)
            }
            if !isPlan, let command = approval.command, !command.isEmpty {
                Text(command)
                    .font(.system(size: 13, design: .monospaced))
                    .textSelection(.enabled)
                    .padding(10)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color(.tertiarySystemFill), in: RoundedRectangle(cornerRadius: 6))
            }
            // 两行两列:四个按钮挤一行时「本次会话允许」会被截成「本次会…」。单数个时最后一个占满一行。
            let choices = self.choices
            let rows = stride(from: 0, to: choices.count, by: 2).map {
                Array(choices[$0..<min($0 + 2, choices.count)])
            }
            VStack(spacing: 8) {
                ForEach(rows, id: \.self) { row in
                    HStack(spacing: 8) {
                        ForEach(row, id: \.self) { choice in
                            Button {
                                LeoHaptics.impact(choice == "deny" ? .medium : .light)
                                onChoose(choice)
                            } label: {
                                Text(label(for: choice))
                                    .font(.system(size: 14, weight: .medium))
                                    .lineLimit(1)
                                    .minimumScaleFactor(0.8)
                                    .frame(maxWidth: .infinity, minHeight: 24)
                                    .padding(.vertical, 6)
                            }
                            .buttonStyle(.borderedProminent)
                            .tint(choice == "deny" ? .red : .accentColor)
                        }
                    }
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
                        if host.isAndroidBody {
                            Label("给 \(host.name) 派任务", systemImage: "terminal")
                        } else {
                            Label("在 \(host.name) 上跑编码任务", systemImage: "terminal")
                        }
                    }
                    if host.url != nil {
                        NavigationLink {
                            GatewayConsoleView(host: host, client: client)
                        } label: {
                            Label("\(host.name) 的引擎对话", systemImage: "desktopcomputer")
                        }
                    }
                } else {
                    NavigationLink {
                        GatewaySettingsView()
                    } label: {
                        Label {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(host.name)
                                Text("缺访问密钥,点这里去「远程机器」补上").font(.system(size: 12)).foregroundStyle(.secondary)
                            }
                        } icon: {
                            Image(systemName: "desktopcomputer.trianglebadge.exclamationmark")
                        }
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
    /// [T-link-problem] 加载 CLI 列表失败:谁的问题 + 一个主按钮(替代原来一行红字)。
    @State private var linkProblem: LeoLinkProblem?
    @State private var pairMessage: String?
    @State private var isLoading = true
    @State private var liveSessions: [HarnessSessionSummary] = []
    @State private var loginTarget: HarnessKind?
    /// [remote-ctl-ios] 这台 Mac 报的能力与模型列表;没报 models 的旧 Mac 不显示模型选择。
    @State private var features: HarnessFeatures?
    @State private var catalog: HarnessModelCatalog?
    /// nil = Mac 自动选择。
    @State private var modelChoice: String?
    @State private var effortChoice: String?

    private var chosenModel: HarnessModelOption? { catalog?.models.first { $0.id == modelChoice } }

    /// 选了模型用它的强度;没选用 Mac 默认模型的。
    private var effortOptions: [String] {
        guard let catalog else { return [] }
        return (chosenModel ?? catalog.option(for: catalog.defaultModel))?.efforts ?? []
    }

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
                                attachSessionId: session.id,
                                attachStatus: session.status)
                        } label: {
                            HStack(spacing: 10) {
                                Image(systemName: session.waitingForApproval
                                    ? "hand.raised.fill" : "terminal")
                                    .foregroundStyle(session.waitingForApproval ? .orange : .secondary)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(session.displayTitle).font(.system(size: 15)).lineLimit(1)
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
                    Text("Mac 上的会话")
                } footer: {
                    Text("正在跑的,和最近在 Mac 上开的 LeoBot 任务。点进去即可查看、审批、接着下指令。")
                }
            }

            Section {
                if isLoading {
                    HStack { ProgressView(); Text("正在检测装了哪些 CLI…").foregroundStyle(.secondary) }
                } else if kinds.isEmpty && linkProblem == nil {
                    // 引擎也回 /v1/capabilities,只是没有 harnesses 字段——
                    // 这里为空通常是地址填成了引擎端口,不是真没装 CLI。
                    Text("在 \(host.name) 上没找到可控的编码 CLI。若那台 Mac 的 LeoAgent 服务在跑,检查「编码会话地址」是否填了 8647 端口。")
                        .font(.system(size: 14)).foregroundStyle(.secondary)
                } else {
                    ForEach(kinds) { kind in
                        Button {
                            selected = kind
                        } label: {
                            HStack(alignment: .firstTextBaseline) {
                                Image(systemName: kind.symbol)
                                    .frame(width: 20)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(kind.displayName)
                                    // 装不上的照样列出，灰显并写明 Mac 给的原因（怎么装、装在哪）。
                                    if let line = kind.statusLine {
                                        Text(line)
                                            .font(.system(size: 12))
                                            .foregroundStyle(.secondary)
                                            .fixedSize(horizontal: false, vertical: true)
                                    }
                                }
                                Spacer()
                                // [fix-remote] Mac 上这个 agent 没登录：在手机上直接网页登录。
                                if kind.canLogin, kind.loggedIn != true {
                                    Button(kind.loggedIn == false ? "登录" : "重新登录") { loginTarget = kind }
                                        .buttonStyle(.bordered)
                                        .controlSize(.small)
                                }
                                if selected?.key == kind.key {
                                    Image(systemName: "checkmark").foregroundStyle(.tint)
                                }
                            }
                            .opacity(kind.available ? 1 : 0.45)
                        }
                        .buttonStyle(.plain)
                        .disabled(!kind.available)
                    }
                }
                if let linkProblem {
                    LeoLinkProblemView(
                        problem: linkProblem,
                        isBusy: isLoading,
                        onRetry: { Task { await load() } },
                        onRescan: {
                            GatewayPairing.scan { message, paired in
                                if paired { Task { await load() } } else { pairMessage = message }
                            }
                        },
                        onActed: { GatewayHostStore.shared.resumeLink(host.id) })
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

            if features?.listsModels == true, let catalog, !catalog.models.isEmpty {
                Section {
                    Picker(selection: $modelChoice) {
                        Text("自动（Mac 决定）").tag(String?.none)
                        ForEach(catalog.groups) { group in
                            Section(group.providerName) {
                                ForEach(group.models) { option in
                                    Text(option.name).tag(Optional(option.id))
                                }
                            }
                        }
                    } label: {
                        Text("模型")
                    }
                    if features?.has(HarnessFeatures.effort) == true, !effortOptions.isEmpty {
                        Picker(selection: $effortChoice) {
                            Text("自动").tag(String?.none)
                            ForEach(effortOptions, id: \.self) { effort in
                                Text(HarnessEffort.title(effort)).tag(Optional(effort))
                            }
                        } label: {
                            Text("推理强度")
                        }
                    }
                } header: {
                    Text("模型（可选）")
                } footer: {
                    Text("不选就由 Mac 自动决定。")
                }
                .onChange(of: modelChoice) { _, _ in
                    if let effortChoice, !effortOptions.contains(effortChoice) { self.effortChoice = nil }
                }
            }

            Section {
                if let selected {
                    NavigationLink {
                        HarnessConsoleView(
                            driver: HarnessSessionDriver(client: client, harness: selected, cwd: cwd),
                            firstPrompt: prompt,
                            createModel: chosenModel?.ref,
                            createEffort: effortChoice)
                    } label: {
                        Label("开始干活", systemImage: "play.circle")
                    }
                    .disabled(prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
        }
        .navigationTitle(Text("编码任务"))
        .navigationBarTitleDisplayMode(.inline)
        .sheet(item: $loginTarget) { kind in
            AgentLoginSheet(client: client, kind: kind) { ok in if ok { Task { await load() } } }
        }
        .task { await load() }
        .pairingResultAlert($pairMessage)
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
        case "available": return "在 Mac 上,可接着做"
        default: return status
        }
    }

    private func load() async {
        isLoading = true
        linkProblem = nil
        let store = GatewayHostStore.shared
        do {
            kinds = try await client.harnessKinds()
            selected = kinds.first(where: \.available)
            store.recordLinkProblem(nil, for: host.id)
        } catch {
            if !LeoLinkProblem.isCancellation(error) {
                let problem = LeoLinkProblem.from(
                    error: error, context: .init(.session, host: client.harnessBaseURL?.host, machineName: host.name))
                linkProblem = problem
                // 要用户处理的问题同时让这台主机的后台轮询暂停(见 MacLiveSessionsStore)。
                if problem.pausesAutoReconnect { store.recordLinkProblem(problem, for: host.id) }
            }
        }
        isLoading = false
        // [remote-ctl-ios] harnessKinds 已顺手记下能力;报了 models 才去拿模型列表。
        features = HarnessFeatureCache.shared.features(for: client.hostId ?? host.id)
        if features?.listsModels == true, catalog == nil {
            catalog = try? await client.harnessModels()
        }
        // 进行中会话列表:失败不挡住新建流程,静默降级。
        if let sessions = try? await client.harnessSessions() {
            liveSessions = sessions.filter {
                !["orphaned", "completed", "failed", "cancelled"].contains($0.status)
            }
            // 工作目录默认:这台 Mac 上次选的 / 最近用的(用户已经改过就不动)。
            if cwd == "~" {
                cwd = HarnessLaunchDefaults.cwd(hostId: host.id, saved: HomeMacDispatchTarget.load(),
                                                recentCwds: sessions.sorted { $0.seq > $1.seq }.map(\.cwd))
            }
        }
    }
}

/// 扫码结果弹窗:Mac 控制台和编码任务页的「重新扫码」共用。
private extension View {
    func pairingResultAlert(_ message: Binding<String?>) -> some View {
        alert("扫码", isPresented: Binding(
            get: { message.wrappedValue != nil },
            set: { if !$0 { message.wrappedValue = nil } }
        )) {
            Button("好", role: .cancel) { message.wrappedValue = nil }
        } message: {
            Text(message.wrappedValue ?? "")
        }
    }
}

/// Live view of one coding CLI working on the Mac.
struct HarnessConsoleView: View {
    @StateObject var driver: HarnessSessionDriver
    let firstPrompt: String
    /// 非空 = 接管 Mac 上已存在的会话(回放 + 跟随),而不是新建。
    var attachSessionId: String? = nil
    /// 接管时列表里看到的状态(idle / available 直接显示空闲)。
    var attachStatus: String? = nil
    var thinking: String? = nil
    /// [remote-ctl-ios] 新建时选的模型 / 强度(nil = Mac 自动选择);只有报了对应能力的 Mac 才会收到。
    var createModel: HarnessModelRef? = nil
    var createEffort: String? = nil
    /// The Mac accepted the first prompt (a session exists): Home clears its draft
    /// only now, so a failed start closed right away doesn't lose the text.
    var onSessionCreated: (() -> Void)? = nil
    @State private var input = ""
    @State private var showSettings = false
    /// [remote-ctl-ios] 待发的图片(已压成 JPEG ≤ 5 MB,最多 4 张)。
    @State private var images: [HarnessComposerImage] = []
    @State private var started = false
    @State private var pairMessage: String?
    @State private var showAgentLogin = false
    @State private var showChanges = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// [WP-50 R0] 「Mac 画面」卡片:工具栏开关,记住上次的选择;只在卡片显示时轮询。
    @AppStorage("leo.macScreen.cardVisible") private var showScreen = false
    @StateObject private var screen = MacScreenPoller()

    var body: some View {
        VStack(spacing: 0) {
            if showScreen {
                MacScreenCard(poller: screen, hostName: driver.macScreenClient.hostName)
                    .padding(.horizontal, 12).padding(.top, 8)
                    .transition(reduceMotion ? .opacity : .move(edge: .top).combined(with: .opacity))
            }
            if driver.showsSessionSettings {
                HarnessSessionHeader(driver: driver) { showSettings = true }
                Divider()
            }
            HarnessTranscript(driver: driver)

            if let approval = driver.pendingApproval {
                GatewayApprovalCard(approval: approval) { choice in
                    driver.respond(to: approval, choice: choice)
                }
                .transition(reduceMotion ? .opacity : .move(edge: .bottom).combined(with: .opacity))
            } else if let question = driver.pendingQuestion {
                // [remote-ctl-ios] 模型在问(AskUserQuestion):选项 + 补充文字,提交或跳过。
                HarnessQuestionCard(request: question,
                                    onSubmit: { driver.answer(question, answers: $0) },
                                    onDecline: { driver.decline(question) })
                    .id(question.questionId)
                    .transition(reduceMotion ? .opacity : .move(edge: .bottom).combined(with: .opacity))
            }

            // [up-console] 「日志已保存 / 状态未知」是给排障看的：一切正常时不占位，只在降级时提醒。
            if driver.journalStatus.state == "degraded" {
                Text(driver.journalStatus.label)
                    .font(.caption)
                    .foregroundStyle(Color.orange)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 14).padding(.vertical, 4)
                    .accessibilityValue("已保存 \(driver.journalStatus.durableSeq)，已收到 \(driver.journalStatus.latestSeq)，缺口 \(driver.journalStatus.missingRanges)")
            }

            // [A3] Mac 没认出这台 iPhone、本会话降级为逐项审批:在 Mac 上按步骤处理完,一点恢复全自动。
            if driver.fullAutoRefused && FullAutoGate.isOn {
                Button { driver.retryFullAuto() } label: {
                    Label("Mac 处理好了,恢复全自动", systemImage: "bolt.fill")
                        .font(.caption.weight(.semibold))
                }
                .buttonStyle(.bordered)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 14).padding(.vertical, 4)
                .accessibilityIdentifier("harness.retryFullAuto")
            }

            // [fix-remote] 外部 agent 在 Mac 上没登录：失败卡下面直接给「去登录」。
            if driver.needsAgentLogin {
                Button { showAgentLogin = true } label: {
                    Label("去登录 \(driver.harness.displayName)", systemImage: "person.badge.key")
                        .font(.caption.weight(.semibold))
                }
                .buttonStyle(.borderedProminent)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 14).padding(.vertical, 4)
                .sheet(isPresented: $showAgentLogin) {
                    AgentLoginSheet(client: driver.macScreenClient, kind: driver.harness) { ok in
                        if ok { driver.clearAgentLoginSuggestion() }
                    }
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
            } else if let problem = driver.problem {
                // [T-link-problem] 是谁的问题 + 一个主按钮。要用户处理的问题(密钥被拒、Mac 撤销授权…)
                // 已经停了自动重连,点按钮才恢复;可重试的问题点「重试」立刻重连。
                LeoLinkProblemView(
                    problem: problem,
                    onRetry: { driver.resumeAfterProblem() },
                    onRescan: {
                        GatewayPairing.scan { message, paired in
                            if paired { driver.resumeAfterProblem() } else { pairMessage = message }
                        }
                    },
                    // 主按钮不是「重试」的瞬时问题(例如「打开 Tailscale」):点下的同时接着重连,
                    // 用户去处理的时候退避继续跑。要用户处理的问题等处理完(扫码成功)再恢复,
                    // 免得白敲一次又停下、块闪一下;「重试」本身就是 resumeAfterProblem。
                    onActed: (problem.pausesAutoReconnect || problem.primaryAction == .retry)
                        ? nil : { driver.resumeAfterProblem() })
                    .padding(.horizontal, 14).padding(.vertical, 4)
            } else if let err = driver.lastError {
                Text(err)
                    .font(.caption).foregroundStyle(.red)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 14).padding(.vertical, 4)
            }

            HarnessQuickActions(driver: driver, inputIsEmpty: input.isEmpty)

            if !images.isEmpty {
                HarnessAttachmentStrip(images: $images)
                    .background(.bar)
            }
            HStack(alignment: .bottom, spacing: 8) {
                if driver.showsModePicker {
                    HarnessModeMenu(driver: driver)
                        .transition(.opacity)
                }
                if driver.acceptsAttachments {
                    HarnessPhotoButton(images: $images)
                        .transition(.opacity)
                }
                TextField("继续下指令…", text: $input, axis: .vertical)
                    .lineLimit(1...4)
                    .textFieldStyle(.plain)
                    .padding(.horizontal, 12).padding(.vertical, 9)
                    .background(Color.secondary.opacity(0.12), in: RoundedRectangle(cornerRadius: 18))
                Button {
                    // Clear only after the driver accepted it; steering during
                    // the starting window used to eat the text silently.
                    let attachments = driver.acceptsAttachments ? images.map(\.attachment) : []
                    if driver.steer(input, attachments: attachments) {
                        input = ""
                        images = []
                    }
                } label: {
                    Image(systemName: "arrow.up.circle.fill").font(.system(size: 30))
                }
                .disabled(input.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                .accessibilityLabel(Text("发送"))
            }
            .padding(.horizontal, 12).padding(.vertical, 10)
            .background(.bar)
            .animation(LeoMotion.smooth(reduceMotion: reduceMotion), value: driver.showsModePicker)
        }
        .animation(LeoMotion.smooth(reduceMotion: reduceMotion), value: driver.pendingApproval?.approvalId)
        .animation(LeoMotion.smooth(reduceMotion: reduceMotion), value: driver.pendingQuestion?.questionId)
        .navigationTitle(Text(driver.harness.name))
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                if driver.showsChanges {
                    Button { showChanges = true } label: {
                        HarnessChangesBadge(count: driver.changes?.files.count ?? 0)
                    }
                    .accessibilityLabel(Text("改动"))
                    .accessibilityValue(Text("\(driver.changes?.files.count ?? 0) 个文件"))
                    .accessibilityIdentifier("harness.changes")
                }
            }
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    withAnimation(LeoMotion.smooth(reduceMotion: reduceMotion)) { showScreen.toggle() }
                } label: {
                    Image(systemName: showScreen ? "display.trianglebadge.exclamationmark" : "display")
                        .symbolVariant(showScreen ? .fill : .none)
                }
                .accessibilityLabel(showScreen ? Text("收起 Mac 画面") : Text("Mac 画面"))
                .accessibilityIdentifier("harness.macScreen")
            }
            ToolbarItem(placement: .topBarTrailing) {
                if driver.isRunning {
                    Button { driver.stop() } label: {
                        Image(systemName: "stop.circle.fill").foregroundStyle(.red)
                    }
                    .accessibilityLabel(Text("停止"))
                }
            }
        }
        .sheet(isPresented: $showChanges) {
            HarnessChangesSheet(driver: driver)
                .presentationDetents([.medium, .large])
                .presentationDragIndicator(.visible)
        }
        .sheet(isPresented: $showSettings) {
            HarnessSessionSettingsSheet(driver: driver)
                .presentationDetents([.medium, .large])
                .presentationDragIndicator(.visible)
        }
        .onAppear {
            screen.client = driver.macScreenClient
            // Start once; coming back to this view resumes the stream at the
            // last seq instead of launching a second session.
            if !started {
                started = true
                if let attachSessionId {
                    driver.attach(existingSessionId: attachSessionId, knownStatus: attachStatus)
                } else if !firstPrompt.isEmpty {
                    driver.start(prompt: firstPrompt, thinking: thinking, model: createModel, effort: createEffort)
                }
                // No first prompt (/mac): the first message creates the session,
                // so opening and closing leaves no empty session on the Mac.
            } else { driver.resumeIfNeeded() }
        }
        .onDisappear { driver.detach() }
        .pairingResultAlert($pairMessage)
        // 建任务失败(Mac 离线、钥匙不对):把第一条指令放回输入框,改一下或直接再发,不会丢。
        .onChange(of: driver.status) { newStatus in
            if newStatus == "pending", input.isEmpty, !firstPrompt.isEmpty { input = firstPrompt }
            if newStatus != "starting", newStatus != "pending", driver.sessionId != nil { onSessionCreated?() }
            // SSH 兜底跑完一轮也算送到了(没有 Mac 会话号)。
            if newStatus == "idle", driver.viaSSH { onSessionCreated?() }
        }
        // A follow-up that didn't reach the Mac comes back to the input, not lost.
        .onChange(of: driver.unsentText) { _, text in
            guard let text else { return }
            if input.isEmpty { input = text }
            driver.unsentText = nil
        }
    }
}

/// 会话流:流式时跟随到底;用户手动上滑就停止跟随(右下角出现「回到底部」),滑回底部自动恢复。
private struct HarnessTranscript: View {
    @ObservedObject var driver: HarnessSessionDriver
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var following = true
    @State private var userScrolling = false
    @State private var hasUnseen = false
    private static let bottomId = "harness.bottom"

    /// 内容变了的指纹:条数变化,或最后一条变长(流式正文、工具输出)都算。
    private var contentKey: Int {
        var hasher = Hasher()
        hasher.combine(driver.items.count)
        hasher.combine(driver.items.last?.text.count ?? 0)
        hasher.combine(driver.items.last?.output?.count ?? 0)
        hasher.combine(driver.status)
        hasher.combine(driver.pendingApproval?.approvalId)
        return hasher.finalize()
    }

    /// 还在写的那一条正文(Markdown 渲染器对未闭合的表格尾巴特殊处理)。
    private var streamingId: UUID? {
        guard driver.isRunning, driver.status == "running", let last = driver.items.last,
              case .assistantText = last.kind else { return nil }
        return last.id
    }

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 12) {
                    ForEach(driver.items) { item in
                        GatewayItemView(item: item, isStreaming: item.id == streamingId).id(item.id)
                    }
                    // "idle" means the CLI finished a turn and is waiting
                    // for the operator — a typing indicator there would
                    // promise progress that is not happening.
                    if driver.isRunning && driver.pendingApproval == nil
                        && driver.status != "idle" {
                        HStack(spacing: 8) {
                            LeoTypingIndicator()
                            Text(driver.statusLabel)
                                .font(.system(size: 12, design: .monospaced))
                                .foregroundStyle(.secondary)
                        }
                    }
                    Color.clear.frame(height: 1).id(Self.bottomId)
                }
                .padding(16)
            }
            .scrollDismissesKeyboard(.interactively)
            // 只有手指拖动 / 惯性滚动才改跟随状态:内容自己变长时离底部远了不算「用户上滑」。
            .onScrollPhaseChange { _, phase, context in
                userScrolling = phase == .interacting || phase == .decelerating
                if phase == .idle { setFollowing(Self.atBottom(context.geometry)) }
            }
            .onScrollGeometryChange(for: Bool.self, of: Self.atBottom) { _, atBottom in
                if atBottom { setFollowing(true) } else if userScrolling { setFollowing(false) }
            }
            .onChange(of: contentKey) { _, _ in
                guard following else { hasUnseen = true; return }
                // 不加动画:流式每 33ms 变长一次,动画叠在一起会抖。
                proxy.scrollTo(Self.bottomId, anchor: .bottom)
            }
            .onAppear { proxy.scrollTo(Self.bottomId, anchor: .bottom) }
            .overlay(alignment: .bottomTrailing) {
                if !following {
                    Button {
                        setFollowing(true)
                        withAnimation(LeoMotion.smooth(reduceMotion: reduceMotion)) {
                            proxy.scrollTo(Self.bottomId, anchor: .bottom)
                        }
                        LeoHaptics.selection()
                    } label: {
                        Image(systemName: "arrow.down")
                            .font(.system(size: 14, weight: .semibold))
                            .frame(width: 38, height: 38)
                            .background(.regularMaterial, in: Circle())
                            .overlay(alignment: .topTrailing) {
                                if hasUnseen {
                                    Circle().fill(Color.accentColor).frame(width: 9, height: 9)
                                        .offset(x: -2, y: 2)
                                }
                            }
                            .shadow(color: .black.opacity(0.12), radius: 6, y: 2)
                    }
                    .buttonStyle(.plain)
                    .padding(14)
                    .transition(reduceMotion ? .opacity : .scale(scale: 0.8).combined(with: .opacity))
                    .accessibilityLabel(Text("回到底部"))
                }
            }
            .animation(LeoMotion.snappy(reduceMotion: reduceMotion), value: following)
        }
    }

    private func setFollowing(_ value: Bool) {
        guard following != value else { return }
        following = value
        if value { hasUnseen = false }
    }

    private static func atBottom(_ geo: ScrollGeometry) -> Bool {
        geo.contentOffset.y + geo.containerSize.height >= geo.contentSize.height - 48
    }
}

/// 一轮结束后的快捷按钮:重试上一条 / 继续;先计划模式交出计划后多一个「按计划执行」。
private struct HarnessQuickActions: View {
    @ObservedObject var driver: HarnessSessionDriver
    let inputIsEmpty: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var visible: Bool {
        inputIsEmpty && driver.status == "idle" && driver.pendingApproval == nil && driver.lastUserText != nil
    }

    var body: some View {
        Group {
            if visible {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        if driver.offersExecutePlan {
                            chip("按计划执行", symbol: "play.fill", prominent: true) { driver.executePlan() }
                        }
                        if let last = driver.lastUserText {
                            chip("重试上一条", symbol: "arrow.clockwise", prominent: driver.lastTurnFailed) {
                                driver.steer(last)
                            }
                        }
                        chip("继续", symbol: "arrow.right", prominent: false) { driver.steer("继续") }
                    }
                    .padding(.horizontal, 14)
                    .padding(.vertical, 6)
                }
                .transition(reduceMotion ? .opacity : .move(edge: .bottom).combined(with: .opacity))
            }
        }
        .animation(LeoMotion.smooth(reduceMotion: reduceMotion), value: visible)
    }

    private func chip(_ title: LocalizedStringKey, symbol: String, prominent: Bool, action: @escaping () -> Void) -> some View {
        Button {
            LeoHaptics.impact(.light)
            action()
        } label: {
            Label(title, systemImage: symbol)
                .font(.footnote.weight(.medium))
                .padding(.horizontal, 12)
                .padding(.vertical, 7)
                .foregroundStyle(prominent ? Color.white : Color.primary)
                .background(prominent ? AnyShapeStyle(Color.accentColor) : AnyShapeStyle(Color.secondary.opacity(0.14)),
                            in: Capsule())
        }
        .buttonStyle(.plain)
    }
}

/// 输入框旁的权限模式胶囊。旧版 Mac(切换回 404)不显示,退回全自动开关。
private struct HarnessModeMenu: View {
    @ObservedObject var driver: HarnessSessionDriver
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        Menu {
            ForEach(HarnessMode.allCases, id: \.self) { mode in
                Button {
                    LeoHaptics.selection()
                    Task { await driver.setMode(mode) }
                } label: {
                    Text(mode.title)
                    Text(mode.subtitle)
                    Image(systemName: driver.mode == mode ? "checkmark" : mode.symbol)
                }
            }
        } label: {
            HStack(spacing: 4) {
                Image(systemName: driver.mode.symbol)
                    .font(.system(size: 11, weight: .semibold))
                    .contentTransition(.symbolEffect(.replace))
                Text(driver.mode.title)
                    .font(.system(size: 12, weight: .semibold))
                    .contentTransition(.opacity)
            }
            .foregroundStyle(driver.mode.tint)
            .padding(.horizontal, 10)
            .frame(height: 34)
            .background(driver.mode.tint.opacity(0.13), in: Capsule())
            .animation(LeoMotion.snappy(reduceMotion: reduceMotion), value: driver.mode)
        }
        .accessibilityLabel(Text("权限模式"))
        .accessibilityValue(Text(driver.mode.title))
        .accessibilityIdentifier("harness.mode")
    }
}

private struct HarnessChangesBadge: View {
    let count: Int

    var body: some View {
        Image(systemName: "plusminus.circle")
            .overlay(alignment: .topTrailing) {
                if count > 0 {
                    Text(count > 99 ? "99+" : "\(count)")
                        .font(.system(size: 10, weight: .bold))
                        .monospacedDigit()
                        .foregroundStyle(.white)
                        .padding(.horizontal, 4)
                        .frame(minWidth: 16, minHeight: 16)
                        .background(Color.accentColor, in: Capsule())
                        .offset(x: 9, y: -7)
                        .transition(.scale.combined(with: .opacity))
                }
            }
            .animation(.snappy, value: count)
    }
}

extension HarnessMode {
    /// 界面文案(跨端约定的显示名)。
    var title: String {
        switch self {
        case .plan: AppLocalized("先计划")
        case .guarded: AppLocalized("自主")
        case .build: AppLocalized("逐项确认")
        case .yolo: AppLocalized("全自动")
        }
    }

    var subtitle: String {
        switch self {
        case .plan: AppLocalized("只读分析，先交计划给你看")
        case .guarded: AppLocalized("常规操作自己做，危险的再问")
        case .build: AppLocalized("每一步改动都先问你")
        case .yolo: AppLocalized("全部放行，不再询问")
        }
    }

    var symbol: String {
        switch self {
        case .plan: "list.bullet.clipboard"
        case .guarded: "shield.lefthalf.filled"
        case .build: "hand.raised"
        case .yolo: "bolt.fill"
        }
    }

    var tint: Color {
        switch self {
        case .plan: .blue
        case .guarded: .accentColor
        case .build: .secondary
        case .yolo: LeoTheme.ColorToken.attention
        }
    }
}

// MARK: - [T-mac-composer] 对话框直达 Mac

/// 对话框"指挥 Mac"选中的目标:哪台 Mac + 哪个 CLI。
struct ComposerMacTarget: Identifiable {
    static let clis: [(String, String)] = [
        ("claude", "Claude Code"), ("codex", "Codex"), ("grok", "Grok"),
    ]

    /// 这台机器能开的任务类型:Android 机身只有它自己的 Agent;升级到 LeoPhoneAgent 1.2 的 Mac 把它自己的 Agent 排第一。
    /// [up-macsession] 与首页「指挥 Mac」一致的菜单项:全部列出,不可用灰显带原因,没登录的点了去登录。
    static func entries(for host: GatewayHost) -> [HarnessCatalog.MenuEntry] {
        HarnessCatalog.menuEntries(known: host.harnesses, runsLeoPhoneAgent: host.runsLeoPhoneAgent,
                                   isAndroidBody: host.isAndroidBody)
    }

    /// 只要能直接派任务的(确认框这类放不下灰显项的地方用)。
    static func clis(for host: GatewayHost) -> [(String, String)] {
        // [fix-remote] 以 Mac 上次报的列表为准（opencode / gemini / grok 都在），还没问过才用旧默认。
        HarnessCatalog.menuOptions(known: host.harnesses, runsLeoPhoneAgent: host.runsLeoPhoneAgent,
                                   isAndroidBody: host.isAndroidBody)
    }
    let host: GatewayHost
    let cliKey: String
    let cliName: String
    /// [E1] 「发到 Mac 接着做」:打开就带着这段任务描述开工(空 = 打开空白控制台)。
    var firstPrompt: String = ""
    /// [E5] 派出它的手机对话;完成推送带回,点通知回到那个对话。
    var phoneSessionId: String? = nil
    var id: String { host.id + cliKey }
}

/// [up-macsession] 「指挥 Mac」菜单内容:规则同首页(HarnessCatalog.menuEntries)。放进任意 `Menu { }` 里用。
struct ComposerMacAgentMenuItems: View {
    let host: GatewayHost
    let onPick: (HarnessCatalog.MenuEntry) -> Void
    let onLogin: (HarnessKind) -> Void

    var body: some View {
        let entries = ComposerMacTarget.entries(for: host)
        if !entries.contains(where: \.selectable) {
            Text("这台机器上暂时没有能用的 agent")
        }
        ForEach(entries) { entry in
            if entry.needsLogin {
                Button { onLogin(entry.kind) } label: {
                    Label(entry.name, systemImage: "person.badge.key")
                    if let note = entry.note { Text(note) }
                }
            } else {
                Button { onPick(entry) } label: {
                    Label(entry.name, systemImage: entry.kind.symbol)
                    if let note = entry.note { Text(note) }
                }
                .disabled(!entry.selectable)
            }
        }
    }
}

struct GatewayAgentLoginTarget: Identifiable {
    let host: GatewayHost
    let kind: HarnessKind
    var id: String { host.id + "/" + kind.key }
}

/// 远程机器行下的「外部 agent 登录」:列出这台 Mac 上能在手机登录的 agent,没登录的标出来。
private struct GatewayAgentLoginMenu: View {
    let host: GatewayHost
    let onLogin: (HarnessKind) -> Void

    var body: some View {
        let kinds = (host.harnesses ?? []).filter(\.canLogin)
        if !kinds.isEmpty {
            Menu {
                ForEach(kinds) { kind in
                    Button { onLogin(kind) } label: {
                        Label(kind.displayName, systemImage: kind.loggedIn == false ? "person.badge.key" : kind.symbol)
                        Text(kind.loggedIn == false ? "未登录" : (kind.loggedIn == true ? "已登录，可重新登录" : "登录状态未知"))
                    }
                }
            } label: {
                let missing = kinds.filter { $0.loggedIn == false }.count
                Label(missing > 0 ? AppLocalized("\(missing) 个 agent 未登录") : AppLocalized("外部 agent 登录"),
                      systemImage: "person.badge.key")
                    .font(.caption.weight(.medium))
                    .foregroundStyle(missing > 0 ? LeoTheme.ColorToken.attention : Color.accentColor)
            }
            .accessibilityIdentifier("gateway.agentLogin")
        }
    }
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
                        // [remote-ctl-ios] 与新建页 / 首页同一个默认目录(这台 Mac 上次选的或最近用的),不再写死 ~。
                        cwd: HarnessLaunchDefaults.cwd(
                            hostId: target.host.id, saved: HomeMacDispatchTarget.load(),
                            recentCwds: MacLiveSessionsStore.shared.rows
                                .filter { $0.hostId == target.host.id }
                                .sorted { $0.session.seq > $1.session.seq }
                                .map(\.session.cwd)),
                        phoneSessionId: target.phoneSessionId),
                    firstPrompt: target.firstPrompt)
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


/// [fix-remote] 直连被手机上的代理 App 截走（*.ts.net 解析成 198.18.x 的 fake-ip）：给出一键复制的小火箭规则。
struct FakeIPHintCard: View {
    @State private var copied = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Label("直连被代理 App 截走了", systemImage: "exclamationmark.shield")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.orange)
            Text("这台 Mac 的 Tailscale 地址被解析成了 198.18.x（小火箭等的 fake-ip），直连握手失败，只能走中继。在小火箭里加上这几条规则（ts.net 与 100.64.0.0/10 直连、不进隧道）就能直连：")
                .font(.caption)
                .foregroundStyle(.secondary)
            Text(FakeIPAdvisor.shadowrocketRules)
                .font(.system(size: 11, design: .monospaced))
                .textSelection(.enabled)
            Button {
                UIPasteboard.general.string = FakeIPAdvisor.shadowrocketRules
                copied = true
                LeoHaptics.notification(.success)
            } label: {
                Label(copied ? "已复制规则" : "复制小火箭规则", systemImage: copied ? "checkmark.circle.fill" : "doc.on.doc")
                    .font(.caption.weight(.semibold))
            }
            .buttonStyle(.bordered)
        }
        .padding(10)
        .background(Color.orange.opacity(0.08), in: RoundedRectangle(cornerRadius: 10))
    }
}
