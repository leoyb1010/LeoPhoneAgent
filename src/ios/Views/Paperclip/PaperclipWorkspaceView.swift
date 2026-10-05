import SwiftUI

/// 两个工作区各自拥有导航栈；切换不会销毁本机的会话与未发送草稿。
struct IOSWorkspaceRootView<LocalContent: View>: View {
    @AppStorage("leo.ios.executionBackend.v1") private var selected = IOSExecutionBackend.local.rawValue
    private let makeStore: @MainActor () -> PaperclipWorkspaceStore
    @ViewBuilder let localContent: () -> LocalContent

    init(makeStore: @escaping @MainActor () -> PaperclipWorkspaceStore = { PaperclipWorkspaceStore() },
         @ViewBuilder localContent: @escaping () -> LocalContent) {
        self.makeStore = makeStore
        self.localContent = localContent
    }

    var body: some View {
        TabView(selection: $selected) {
            localContent()
                .toolbar(.hidden, for: .tabBar)
                .tag(IOSExecutionBackend.local.rawValue)
                .tabItem { Label("本机", systemImage: "iphone") }
            // 不再强制 zh_Hans_CN：日期、数字跟随用户当前语言区域；中文文案本身是字面量。
            PaperclipWorkspaceView(onReturnToLocal: { selected = IOSExecutionBackend.local.rawValue }, makeStore: makeStore)
                .toolbar(.hidden, for: .tabBar)
                .tag(IOSExecutionBackend.paperclip.rawValue)
                .tabItem { Label("服务器任务", systemImage: "network") }
        }
        // 入口位于各工作区的导航栏，不能在所有页面上方再插入一条控制栏。
        .toolbar(.hidden, for: .tabBar)
    }
}

struct PaperclipBackendSettingsView: View {
    @AppStorage("leo.ios.executionBackend.v1") private var selected = IOSExecutionBackend.local.rawValue
    var body: some View {
        Form {
            Section("iOS 执行后端") {
                Picker("工作区", selection: $selected) {
                    ForEach(IOSExecutionBackend.allCases, id: \.rawValue) { Text($0.title).tag($0.rawValue) }
                }
                Text("本机是默认选项。切换工作区不会移动已有会话、记忆或工具；每项服务器任务始终绑定创建它的服务器、公司和用户。")
                Text("Paperclip 在你独立部署的服务器上执行。连接超时或登录过期时会停止并提示，不会回退到本机。")
            }
        }.navigationTitle("执行后端")
    }
}

struct PaperclipWorkspaceView: View {
    let onReturnToLocal: () -> Void
    @StateObject private var store: PaperclipWorkspaceStore

    init(onReturnToLocal: @escaping () -> Void = {},
         makeStore: @escaping @MainActor () -> PaperclipWorkspaceStore = { PaperclipWorkspaceStore() }) {
        self.onReturnToLocal = onReturnToLocal
        _store = StateObject(wrappedValue: makeStore())
    }
    @State private var settings = false
    @State private var creating = false
    @State private var focusRequest = 0
    @State private var createdReference: PaperclipTaskReference?
    @State private var query = ""
    @State private var listVisible = false
    @FocusState private var searching: Bool
    @Environment(\.scenePhase) private var scenePhase

    private var filtered: [PaperclipIssue] {
        let value = query.trimmingCharacters(in: .whitespacesAndNewlines)
        return value.isEmpty ? store.issues : store.issues.filter {
            $0.title.localizedCaseInsensitiveContains(value) || ($0.identifier?.localizedCaseInsensitiveContains(value) ?? false)
        }
    }

    private func grouped(_ issues: [PaperclipIssue]) -> [(PaperclipIssueGroup, [PaperclipIssue])] {
        let buckets = Dictionary(grouping: issues) { PaperclipIssueGroup.group($0, running: store.liveIssueIDs.contains($0.id)) }
        return PaperclipIssueGroup.allCases.compactMap { group in
            guard let rows = buckets[group], !rows.isEmpty else { return nil }
            return (group, rows)
        }
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    content
                }
                .padding(.horizontal, LeoTheme.Spacing.md)
                .padding(.bottom, LeoTheme.Spacing.lg)
                .frame(maxWidth: 760)
                .frame(maxWidth: .infinity)
            }
            .background(LeoTheme.ColorToken.groupedBackground)
            .navigationTitle("服务器任务")
            .navigationBarTitleDisplayMode(.inline)
            .scrollDismissesKeyboard(.interactively)
            .safeAreaInset(edge: .bottom, spacing: 0) {
                if let client = store.client, let user = store.user, !store.companyID.isEmpty {
                    PaperclipCreateIssueView(client: client, companyID: store.companyID, userID: user.id,
                        agents: store.agents, focusRequest: focusRequest, creating: $creating) { issue in
                            guard store.client === client, store.user?.id == user.id, store.companyID == issue.companyId else { return }
                            createdReference = client.reference(for: issue, userID: user.id)
                            await store.refresh()
                        }
                        .id(store.identityKey)
                }
            }
            .navigationDestination(item: $createdReference) { reference in
                if let client = store.client {
                    detail(client: client, reference: reference)
                }
            }
            .refreshable { await refresh() }
            .onAppear { listVisible = true; store.setListVisible(true) }
            .onDisappear { listVisible = false; store.setListVisible(false) }
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("本机", systemImage: "iphone") { onReturnToLocal() }
                        .accessibilityIdentifier("paperclip.returnLocal")
                }
                ToolbarItemGroup(placement: .topBarTrailing) {
                    Button { settings = true } label: { Label("服务器设置", systemImage: "gearshape") }
                        .accessibilityIdentifier("paperclip.settings")
                    Button { searching = false; focusRequest += 1 } label: { Label("新建任务", systemImage: "square.and.pencil") }
                        .disabled(store.user == nil || store.companyID.isEmpty)
                        .accessibilityIdentifier("paperclip.create")
                }
            }
        }
        .id(store.identityKey)
        .onChange(of: store.identityKey) { _, _ in createdReference = nil }
        .sheet(isPresented: $settings) { PaperclipServerSettingsView(store: store) }
        // 连接任务放在重置导航路径的 id 之外，退出登录不会意外触发重新登录。
        .task(id: store.selectedID) { if store.selectedProfile != nil { await store.connect() } }
        .task(id: scenePhase) {
            // 进入后台主动断开实时通道；回到前台立即刷新、重新确认身份并连接，再进入周期（以前先睡 15 秒）。
            // 短暂的 inactive（下拉通知中心、多任务切换）不断开，避免反复重连。
            if scenePhase == .background { await store.setForeground(false) }
            guard scenePhase == .active else { return }
            await store.setForeground(true)
            var lastPoll = Date()
            var failureInterval: Double?
            while !Task.isCancelled {
                do { try await Task.sleep(for: .seconds(1)) } catch { return }
                let interval = failureInterval ?? (store.liveState == .open ? PaperclipPollingPolicy.liveSafetyInterval : PaperclipPollingPolicy.baseInterval)
                guard Date().timeIntervalSince(lastPoll) >= interval else { continue }
                // 只在创建请求进行中暂停；搜索、输入、设置页打开都不再暂停只读同步。
                guard listVisible, store.user != nil,
                      PaperclipPollingPolicy.canRefresh(active: true, mutating: creating) else { continue }
                await store.refresh()
                lastPoll = Date()
                // 失败指数退避（上限 2 分钟），成功复位，避免离线时持续耗电。
                failureInterval = store.error == nil ? nil : PaperclipPollingPolicy.nextInterval(after: failureInterval ?? interval, succeeded: false)
            }
        }
    }

    private func detail(client: PaperclipClient, reference: PaperclipTaskReference) -> some View {
        PaperclipIssueDetailView(client: client, reference: reference, agents: store.agents,
                                 live: store.live, userLabel: store.user?.label)
    }

    private func refresh() async {
        if store.user == nil { await store.connect() } else { await store.refresh() }
    }

    @ViewBuilder private var content: some View {
        if let user = store.user, let client = store.client {
            PaperclipListToolbar(store: store, query: $query, searching: $searching)
                .padding(.top, LeoTheme.Spacing.xs)
                .padding(.bottom, LeoTheme.Spacing.md)
            if let error = store.error {
                PaperclipNotice(text: "同步失败，保留已加载任务。" + error, actionTitle: "重试") { Task { await refresh() } }
                    .padding(.bottom, LeoTheme.Spacing.md)
            }
            if store.companies.isEmpty {
                PaperclipNotice(text: "当前账号尚无可访问的公司，请在服务器网页完成公司设置。", systemImage: "building.2", tint: .secondary)
            } else if filtered.isEmpty {
                emptyState
            } else {
                ForEach(grouped(filtered), id: \.0) { group, rows in
                    HStack(spacing: 6) {
                        Text(group.title).font(.footnote.weight(.semibold)).foregroundStyle(.secondary)
                        Text("\(rows.count)").font(.caption2.weight(.semibold).monospacedDigit())
                            .foregroundStyle(.secondary)
                            .padding(.horizontal, 6).padding(.vertical, 1)
                            .background(Color.primary.opacity(0.06), in: Capsule())
                    }
                    .padding(.top, LeoTheme.Spacing.sm)
                    .padding(.bottom, LeoTheme.Spacing.xs)
                    .padding(.leading, 4)
                    .accessibilityAddTraits(.isHeader)
                    ForEach(rows) { issue in
                        NavigationLink {
                            detail(client: client, reference: client.reference(for: issue, userID: user.id))
                        } label: {
                            PaperclipIssueCard(issue: issue, assignee: store.agents.first { $0.id == issue.assigneeAgentId },
                                               running: store.liveIssueIDs.contains(issue.id), client: client)
                        }
                        .buttonStyle(LeoSquishButtonStyle())
                        .padding(.bottom, 10)
                        .accessibilityIdentifier("paperclip.issue.\(issue.id)")
                    }
                }
                if store.hasMore {
                    Button { Task { await store.refresh(loadMore: true) } } label: {
                        Text("加载更多任务").font(.subheadline.weight(.semibold)).frame(maxWidth: .infinity).frame(minHeight: 40)
                    }
                    .buttonStyle(.bordered)
                    .disabled(store.busy)
                }
            }
        } else {
            if let error = store.error {
                PaperclipNotice(text: error, actionTitle: store.selectedProfile == nil ? nil : "检查连接") { Task { await refresh() } }
                    .padding(.top, LeoTheme.Spacing.md)
            }
            PaperclipConnectCard(title: store.selectedProfile?.name ?? "连接你的 Paperclip 服务器", busy: store.busy,
                                 hasProfile: store.selectedProfile != nil) { settings = true }
                .padding(.top, LeoTheme.Spacing.lg)
        }
    }

    @ViewBuilder private var emptyState: some View {
        if store.busy && store.issues.isEmpty {
            HStack(spacing: 10) { ProgressView(); Text("正在加载任务…").foregroundStyle(.secondary) }
                .frame(maxWidth: .infinity).padding(.top, 60)
        } else if !query.isEmpty {
            Text("没有匹配任务，试试其他关键词。").font(.subheadline).foregroundStyle(.secondary)
                .frame(maxWidth: .infinity).padding(.top, 40)
        } else {
            VStack(spacing: 12) {
                Image(systemName: "sparkles.rectangle.stack").font(.largeTitle).foregroundStyle(LeoTheme.ColorToken.accent)
                Text("想让服务器帮你做什么？").font(.title3.weight(.semibold))
                Text("在下方输入要求，发送后创建一个服务器任务，执行过程会实时显示。")
                    .font(.subheadline).foregroundStyle(.secondary).multilineTextAlignment(.center)
                Button("开始新任务", systemImage: "plus") { focusRequest += 1 }
                    .buttonStyle(.bordered)
                    .accessibilityIdentifier("paperclip.createEmpty")
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 48)
        }
    }
}

private struct PaperclipServerSettingsView: View {
    @ObservedObject var store: PaperclipWorkspaceStore
    @Environment(\.dismiss) private var dismiss
    @State private var addProfile = false
    @State private var login = false
    @State private var clearLogin = false
    @State private var removeProfile = false
    @State private var website = false

    var body: some View {
        NavigationStack {
            Form {
                Section("服务器配置") {
                    if let profile = store.selectedProfile {
                        Picker("服务器配置", selection: Binding(get: { profile.id }, set: { store.select($0) })) {
                            ForEach(store.profiles) { Text($0.name).tag($0.id) }
                        }.disabled(store.busy)
                        Text(profile.origin.absoluteString).font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
                        Button(store.user == nil ? "网页登录" : "重新登录") { login = true }.disabled(store.busy)
                            .accessibilityIdentifier("paperclip.login")
                        if store.user != nil { Button("退出登录", role: .destructive) { clearLogin = true }.disabled(store.busy) }
                        Button("删除此服务器", role: .destructive) { removeProfile = true }.disabled(store.busy)
                            .accessibilityIdentifier("paperclip.removeProfile")
                    } else {
                        Text("先添加已独立部署的 Paperclip HTTPS 服务器，再用网页账号登录。")
                    }
                    Button("添加服务器配置") { addProfile = true }.disabled(store.busy)
                        .accessibilityIdentifier("paperclip.addProfile")
                }
                if let user = store.user {
                    Section("当前登录") {
                        LabeledContent("用户", value: user.label)
                        if let company = store.companies.first(where: { $0.id == store.companyID }) {
                            LabeledContent("公司", value: company.name)
                        }
                    }
                }
                if store.selectedProfile != nil {
                    Section("更多服务器能力") {
                        Button("打开服务器网页版", systemImage: "globe") { website = true }
                            .disabled(store.busy).accessibilityIdentifier("paperclip.openWebsite")
                        Text("费用、运行管理及模型配置由服务器网页提供。附件仅供查看，下载请使用浏览器。返回后会重新验证登录并同步任务。")
                            .font(.footnote).foregroundStyle(.secondary)
                    }
                }
                if let error = store.error {
                    Section("连接提示") {
                        Text(error).font(.footnote).foregroundStyle(.red).textSelection(.enabled)
                        Button("重新验证连接") { Task { await store.connect() } }.disabled(store.busy)
                    }
                }
                Section {
                    Text("任务在服务器上执行。本机会话和草稿保留在本机，切换工作区不会迁移任务。")
                        .font(.footnote).foregroundStyle(.secondary)
                }
            }
            .navigationTitle("服务器设置")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("完成") { dismiss() } } }
            .sheet(isPresented: $addProfile) { PaperclipAddProfileView(store: store) }
            .sheet(isPresented: $login) {
                if let profile = store.selectedProfile { PaperclipLoginView(profile: profile) { await store.connect() } }
            }
            .sheet(isPresented: $website, onDismiss: { Task { await store.connect() } }) {
                if let profile = store.selectedProfile { PaperclipWebsiteView(profile: profile) }
            }
            .confirmationDialog("退出此服务器的登录？", isPresented: $clearLogin, titleVisibility: .visible) {
                Button("退出登录", role: .destructive) { Task { await store.clearLogin() } }
                Button("取消" as String, role: .cancel) {}
            } message: { Text("会尝试通知服务器结束本次登录，然后清除此配置的浏览器登录数据。服务器上的任务和本机会话不会删除。") }
            .confirmationDialog("删除此服务器配置？", isPresented: $removeProfile, titleVisibility: .visible) {
                if let profile = store.selectedProfile {
                    Button("删除此服务器", role: .destructive) { Task { await store.remove(profile.id) } }
                }
                Button("取消" as String, role: .cancel) {}
            } message: { Text("会先退出服务器登录，再删除本机保存的地址、登录数据和此服务器的草稿记录。服务器上的任务不会删除。") }
        }
    }
}

private struct PaperclipAddProfileView: View {
    @ObservedObject var store: PaperclipWorkspaceStore
    @Environment(\.dismiss) private var dismiss
    @State private var name = "我的服务器"
    @State private var address = ""
    @State private var error: String?
    var body: some View {
        NavigationStack {
            Form {
                TextField("配置名称", text: $name)
                TextField("HTTPS 服务器根地址", text: $address).keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
                    .accessibilityIdentifier("paperclip.serverURL")
                Text("填写例如 https://paperclip.example.com 的根地址。每份配置有独立登录容器；更换地址时创建新配置，旧任务不会转移。")
                    .font(.footnote).foregroundStyle(.secondary)
                if let error { Text(error).foregroundStyle(.red) }
            }
            .navigationTitle("添加服务器")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("取消" as String) { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("保存") {
                        do { try store.add(name: name, address: address); dismiss() }
                        catch { self.error = PaperclipLabels.error(error) }
                    }.disabled(address.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
        }
    }
}

private struct PaperclipCreateIssueView: View {
    let client: PaperclipClient
    let companyID: String
    let userID: String
    let agents: [PaperclipAgent]
    let focusRequest: Int
    /// 创建请求进行中（只读同步只在此期间暂停）。
    @Binding var creating: Bool
    let onCreated: (PaperclipIssue) async -> Void
    @FocusState private var focused: Bool
    @State private var draft: PaperclipDraft
    @State private var busy = false
    @State private var error: String?
    @State private var discard = false
    @State private var lastChecked: PaperclipDraft?
    @State private var showDetails = false
    @State private var showReceipt = false
    @State private var saveTask: Task<Void, Never>?
    private let draftKey: String

    init(client: PaperclipClient, companyID: String, userID: String, agents: [PaperclipAgent],
         focusRequest: Int, creating: Binding<Bool>, onCreated: @escaping (PaperclipIssue) async -> Void) {
        self.client = client; self.companyID = companyID; self.userID = userID; self.agents = agents
        self.focusRequest = focusRequest; _creating = creating; self.onCreated = onCreated
        let key = PaperclipDraft.key(profile: client.profile, companyID: companyID, userID: userID)
        draftKey = key
        _draft = State(initialValue: PaperclipDraft.load(key: key))
        _lastChecked = State(initialValue: PaperclipDraft.lastChecked(key: key))
    }

    private var assignee: PaperclipAgent? { agents.first { $0.id == draft.agentID } }

    var body: some View {
        PaperclipComposerBar(
            text: $draft.title, focus: $focused, placeholder: "发消息，创建服务器任务…",
            fieldIdentifier: "paperclip.taskTitle", sendIdentifier: "paperclip.submitTask",
            sendLabel: draft.submitted ? "重试同一提交" : "发送并创建服务器任务",
            busy: busy,
            canSend: !busy && draft.canRetryCreate() && !draft.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
            retry: draft.submitted, fieldDisabled: busy || draft.submitted,
            onSend: { Task { await submit() } }
        ) {
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 8) {
                    Menu {
                        Picker("执行者", selection: $draft.agentID) {
                            Text("暂不分配 · 待规划").tag("")
                            ForEach(agents.filter { $0.status != "terminated" }) { Text($0.name).tag($0.id) }
                        }
                    } label: {
                        HStack(spacing: 6) {
                            if let assignee {
                                PaperclipAvatar(client: client, path: PaperclipAvatarPath.normalized(assignee.avatarUrl, origin: client.profile.origin),
                                                name: assignee.name, size: 18)
                            } else {
                                Image(systemName: "person.crop.circle").font(.system(size: 13, weight: .semibold))
                            }
                            Text(assignee?.name ?? "暂不分配 · 待规划").font(.footnote.weight(.semibold)).lineLimit(1)
                            Image(systemName: "chevron.down").font(.system(size: 9, weight: .bold)).foregroundStyle(.secondary)
                        }
                        .foregroundStyle(.primary)
                        .padding(.horizontal, 10)
                        .frame(minHeight: 32)
                        .background(Color.primary.opacity(0.06), in: Capsule())
                        .contentShape(Capsule())
                    }
                    .disabled(busy || draft.submitted)
                    .accessibilityLabel(Text("执行者：\(assignee?.name ?? "暂不分配")"))
                    Button { showDetails = true } label: {
                        PaperclipChip(title: draft.body.isEmpty ? "补充说明" : "已补充说明", systemImage: "text.badge.plus",
                                      tint: draft.body.isEmpty ? .primary : LeoTheme.ColorToken.accent)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("任务补充说明与提交目标")
                    Spacer(minLength: 0)
                    if draft.submitted || lastChecked != nil {
                        Button { showReceipt = true } label: {
                            PaperclipChip(title: draft.submitted ? "待核对" : "核对记录", systemImage: "clock.badge.questionmark",
                                          tint: draft.submitted ? LeoTheme.ColorToken.warning : .secondary)
                        }
                        .buttonStyle(.plain)
                    }
                }
                if let error {
                    Text(error).font(.caption).foregroundStyle(LeoTheme.ColorToken.destructive).lineLimit(2)
                }
            }
        }
        .onChange(of: focusRequest) { _, _ in focused = true }
        .onChange(of: draft.title) { _, _ in scheduleDraftSave() }
        .onChange(of: draft.body) { _, _ in scheduleDraftSave() }
        .onChange(of: draft.agentID) { _, _ in scheduleDraftSave() }
        .onChange(of: busy) { _, value in creating = value }
        .onDisappear {
            let pending = saveTask != nil
            saveTask?.cancel(); saveTask = nil
            if pending || !draft.title.isEmpty || !draft.body.isEmpty { draft.save(key: draftKey) }
            creating = false
        }
        .sheet(isPresented: $showDetails) {
            NavigationStack {
                Form {
                    Section("补充说明") {
                        TextField("说明、目标和验收条件（可选）", text: $draft.body, axis: .vertical).lineLimit(5...12)
                            .disabled(busy || draft.submitted)
                    }
                    Section("提交目标") {
                        Text(client.profile.name)
                        Text(client.profile.origin.absoluteString).font(.caption).textSelection(.enabled)
                        Text("指定执行者后创建待处理任务，由服务器调度；未分配的任务保留在待规划列表。").font(.footnote).foregroundStyle(.secondary)
                    }
                }
                .navigationTitle("任务选项").navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .confirmationAction) { Button("完成") { showDetails = false } } }
            }
        }
        .sheet(isPresented: $showReceipt) {
            NavigationStack {
                Form {
                    if draft.submitted {
                        Section("待核对提交") {
                            Text(draft.canRetryCreate()
                                ? "这份草稿已经提交过，请先核对任务列表。服务器的创建去重键保留 7 天；客户端仅允许 6 天内重试，沿用原请求编号。"
                                : "这份提交已超出 6 天安全重试窗口，或缺少可信提交时间，不能再次发送。正文已保留，请先核对服务器任务列表。")
                            Text(draft.title).textSelection(.enabled)
                            Text(draft.body).textSelection(.enabled)
                            Button("放弃本机草稿", role: .destructive) { discard = true }.disabled(busy)
                        }
                    }
                    if let lastChecked { PaperclipCheckedDraftView(draft: lastChecked) }
                    if let error { Text(error).font(.footnote).foregroundStyle(.red).textSelection(.enabled) }
                }
                .navigationTitle("提交核对").navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .confirmationAction) { Button("完成") { showReceipt = false } } }
                .confirmationDialog("放弃草稿不会撤销服务器可能已接收的任务", isPresented: $discard, titleVisibility: .visible) {
                Button("已核对，解除待提交状态", role: .destructive) {
                    draft.archive(key: draftKey)
                    lastChecked = draft
                    draft = PaperclipDraft()
                    error = nil
                }
                Button("取消" as String, role: .cancel) {}
            } message: { Text("操作可能已经在服务器生效，请先核对。解除只保存本机核对记录，不会重新发送；新任务需要你再次明确提交。") }
            }
        }
    }
    /// 每次按键写 UserDefaults 太频繁：停顿 0.5 秒后保存；离开页面、提交前仍立即保存。
    private func scheduleDraftSave() {
        saveTask?.cancel()
        saveTask = Task { @MainActor in
            do { try await Task.sleep(for: .milliseconds(500)) } catch { return }
            draft.save(key: draftKey)
            saveTask = nil
        }
    }
    private func submit() async {
        guard !busy, draft.canRetryCreate() else { return }
        saveTask?.cancel(); saveTask = nil
        // 发送即收起键盘；仅在服务器明确拒绝、草稿可编辑时恢复焦点。
        focused = false
        busy = true
        let wasPreviouslySubmitted = draft.submitted
        draft.markSubmitted()
        draft.save(key: draftKey)
        do {
            let issue = try await client.create(companyID: companyID, userID: userID,
                title: draft.title, description: draft.body, agentID: draft.agentID.isEmpty ? nil : draft.agentID, requestID: draft.requestID)
            PaperclipDraft.clear(key: draftKey)
            draft = PaperclipDraft()
            focused = PaperclipSendOutcome.sent.keepsComposerFocus
            LeoHaptics.notification(.success)
            busy = false
            await onCreated(issue)
            return
        } catch {
            draft.recordFailure(error, wasPreviouslySubmitted: wasPreviouslySubmitted)
            draft.save(key: draftKey)
            self.error = PaperclipLabels.error(error)
            focused = PaperclipSendOutcome.failure(draftAfterFailure: draft).keepsComposerFocus
            LeoHaptics.notification(.error)
        }
        busy = false
    }
}

struct PaperclipCheckedDraftView: View {
    let draft: PaperclipDraft
    var body: some View {
        DisclosureGroup("上次人工核对的草稿记录") {
            Text("请求编号：\(draft.requestID.uuidString)").font(.caption).textSelection(.enabled)
            if let time = draft.firstSubmittedAt { Text("首次提交：\(time.formatted())").font(.caption) }
            else { Text("首次提交时间未记录").font(.caption) }
            if !draft.title.isEmpty { Text(draft.title).textSelection(.enabled) }
            Text(draft.body).textSelection(.enabled)
            Text("这里只保留本机诊断内容，不会发送。服务器是否已生效以服务器记录为准。")
                .font(.footnote).foregroundStyle(.secondary)
        }
    }
}
