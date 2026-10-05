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
            PaperclipWorkspaceView(onReturnToLocal: { selected = IOSExecutionBackend.local.rawValue }, makeStore: makeStore)
                .environment(\.locale, Locale(identifier: "zh_Hans_CN"))
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
    @State private var composing = false
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
    var body: some View {
        NavigationStack {
            List {
                workspaceSummary
                if let error = store.error {
                    Section {
                        DisclosureGroup {
                            Text(error).font(.footnote).textSelection(.enabled)
                        } label: {
                            Label(store.user == nil ? "连接未完成" : "同步失败，保留已加载任务", systemImage: "exclamationmark.triangle")
                                .font(.subheadline).foregroundStyle(.secondary)
                        }
                        Button(store.user == nil ? "检查服务器连接" : "重试同步") { Task { await refresh() } }.disabled(store.busy)
                    }
                }
                if let user = store.user, let client = store.client {
                    if !store.companyID.isEmpty {
                        Section {
                            HStack {
                                Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
                                TextField("搜索已加载的任务", text: $query)
                                    .focused($searching).submitLabel(.search)
                                    .accessibilityIdentifier("paperclip.search")
                                if !query.isEmpty {
                                    Button { query = "" } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary) }
                                        .buttonStyle(.borderless).accessibilityLabel("清除搜索")
                                }
                            }
                        }
                        Section("任务会话") {
                            if filtered.isEmpty {
                                if store.busy { ProgressView("正在加载任务…") }
                                else if !query.isEmpty { Text("没有匹配任务，试试其他关键词。").foregroundStyle(.secondary) }
                                else {
                                    VStack(alignment: .leading, spacing: 12) {
                                        Text("想让服务器帮你做什么？").font(.headline)
                                        Text("在下方输入要求，发送后创建一个服务器任务。").font(.subheadline).foregroundStyle(.secondary)
                                        Button("开始新任务", systemImage: "plus") { focusRequest += 1 }
                                            .accessibilityIdentifier("paperclip.createEmpty")
                                    }.padding(.vertical, 8)
                                }
                            }
                            ForEach(filtered) { issue in
                                NavigationLink {
                                    PaperclipIssueDetailView(client: client, reference: client.reference(for: issue, userID: user.id))
                                } label: {
                                    VStack(alignment: .leading, spacing: 5) {
                                        Text(issue.title).font(.headline)
                                        if let description = issue.description, !description.isEmpty {
                                            Text(description).font(.subheadline).foregroundStyle(.secondary).lineLimit(2)
                                        }
                                        HStack {
                                            if let identifier = issue.identifier { Text(identifier) }
                                            Text(PaperclipLabels.status(issue.status))
                                            Text("优先级：\(PaperclipLabels.priority(issue.priority))")
                                        }.font(.caption).foregroundStyle(.secondary)
                                    }
                                }.accessibilityIdentifier("paperclip.issue.\(issue.id)")
                            }
                            if store.hasMore {
                                Button("加载更多任务") { Task { await store.refresh(loadMore: true) } }.disabled(store.busy)
                            }
                        }
                    }
                }
            }
            .navigationTitle("服务器任务")
            .navigationBarTitleDisplayMode(.inline)
            .scrollDismissesKeyboard(.interactively)
            .safeAreaInset(edge: .bottom, spacing: 0) {
                if let client = store.client, let user = store.user, !store.companyID.isEmpty {
                    PaperclipCreateIssueView(client: client, companyID: store.companyID, userID: user.id,
                        agents: store.agents, focusRequest: focusRequest, composing: $composing) { issue in
                            guard store.client === client, store.user?.id == user.id, store.companyID == issue.companyId else { return }
                            createdReference = client.reference(for: issue, userID: user.id)
                            await store.refresh()
                        }
                        .id(store.identityKey)
                }
            }
            .navigationDestination(item: $createdReference) { reference in
                if let client = store.client {
                    PaperclipIssueDetailView(client: client, reference: reference)
                }
            }
            .refreshable { await refresh() }
            .onAppear { listVisible = true }
            .onDisappear { listVisible = false }
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("本机", systemImage: "iphone") { onReturnToLocal() }
                        .accessibilityIdentifier("paperclip.returnLocal")
                }
                ToolbarItemGroup(placement: .topBarTrailing) {
                    Button { settings = true } label: { Label("服务器设置", systemImage: "gearshape") }
                        .accessibilityIdentifier("paperclip.settings")
                    Button { searching = false; focusRequest += 1 } label: { Label("新建任务", systemImage: "plus") }
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
            guard scenePhase == .active else { return }
            while !Task.isCancelled {
                do { try await Task.sleep(for: .seconds(15)) } catch { return }
                if listVisible && !settings && !composing && !searching && store.user != nil { await store.refresh() }
            }
        }
    }

    private func refresh() async {
        if store.user == nil { await store.connect() } else { await store.refresh() }
    }

    private var workspaceSummary: some View {
        Section {
            if store.user != nil {
                HStack {
                    VStack(alignment: .leading, spacing: 4) {
                        if store.companies.count > 1 {
                            Picker("公司", selection: Binding(get: { store.companyID }, set: { id in Task { await store.selectCompany(id) } })) {
                                ForEach(store.companies) { Text($0.name).tag($0.id) }
                            }.labelsHidden().disabled(store.busy)
                        } else {
                            Text(store.companies.first?.name ?? "尚未加入公司").font(.headline)
                        }
                        Text(store.selectedProfile?.name ?? "服务器").font(.caption).foregroundStyle(.secondary)
                    }
                    Spacer()
                    if store.busy { ProgressView().accessibilityLabel("正在同步") }
                    else {
                        Button { Task { await refresh() } } label: { Image(systemName: "arrow.clockwise") }
                            .buttonStyle(.borderless).accessibilityLabel("刷新任务")
                    }
                }
                if store.companies.isEmpty {
                    Text("当前账号尚无可访问的公司，请在服务器网页完成公司设置。").font(.footnote).foregroundStyle(.secondary)
                }
            } else {
                VStack(alignment: .leading, spacing: 12) {
                    Text(store.selectedProfile?.name ?? "连接你的 Paperclip 服务器").font(.headline)
                    Text(store.busy ? "正在验证连接…" : "登录后即可查看和处理服务器任务。")
                        .font(.subheadline).foregroundStyle(.secondary)
                    Button(store.selectedProfile == nil ? "添加服务器" : "登录与连接", systemImage: "network") { settings = true }
                        .accessibilityIdentifier("paperclip.openConnection")
                }.padding(.vertical, 6)
            }
        }
    }
}

private struct PaperclipServerSettingsView: View {
    @ObservedObject var store: PaperclipWorkspaceStore
    @Environment(\.dismiss) private var dismiss
    @State private var addProfile = false
    @State private var login = false
    @State private var clearLogin = false
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
                        if store.user != nil { Button("清除本机登录", role: .destructive) { clearLogin = true }.disabled(store.busy) }
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
            .confirmationDialog("清除这台设备上此服务器配置的登录？", isPresented: $clearLogin, titleVisibility: .visible) {
                Button("清除本机登录", role: .destructive) { Task { await store.clearLogin() } }
                Button("取消", role: .cancel) {}
            } message: { Text("这会清除此配置的浏览器登录数据，服务器上的任务和本机会话不会删除。") }
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
                ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() } }
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
    @Binding var composing: Bool
    let onCreated: (PaperclipIssue) async -> Void
    @FocusState private var focused: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var draft: PaperclipDraft
    @State private var busy = false
    @State private var error: String?
    @State private var discard = false
    @State private var lastChecked: PaperclipDraft?
    @State private var showDetails = false
    @State private var showReceipt = false
    private let draftKey: String

    init(client: PaperclipClient, companyID: String, userID: String, agents: [PaperclipAgent],
         focusRequest: Int, composing: Binding<Bool>, onCreated: @escaping (PaperclipIssue) async -> Void) {
        self.client = client; self.companyID = companyID; self.userID = userID; self.agents = agents
        self.focusRequest = focusRequest; _composing = composing; self.onCreated = onCreated
        let key = PaperclipDraft.key(profile: client.profile, companyID: companyID, userID: userID)
        draftKey = key
        _draft = State(initialValue: PaperclipDraft.load(key: key))
        _lastChecked = State(initialValue: PaperclipDraft.lastChecked(key: key))
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Menu {
                    Picker("执行者", selection: $draft.agentID) {
                        Text("暂不分配 · 待规划").tag("")
                        ForEach(agents.filter { $0.status != "terminated" }) { Text($0.name).tag($0.id) }
                    }
                } label: {
                    Label(agents.first(where: { $0.id == draft.agentID })?.name ?? "暂不分配 · 待规划", systemImage: "person.crop.circle")
                        .font(.subheadline).lineLimit(1)
                        .padding(.horizontal, 10).padding(.vertical, 6)
                        .background(Color(.tertiarySystemFill), in: Capsule())
                }.disabled(busy || draft.submitted)
                Spacer()
                Button { showDetails = true } label: { Image(systemName: "slider.horizontal.3") }
                    .accessibilityLabel("任务补充说明与提交目标")
                if draft.submitted || lastChecked != nil {
                    Button(draft.submitted ? "待核对" : "核对记录") { showReceipt = true }.font(.caption)
                }
            }
            HStack(alignment: .bottom, spacing: 10) {
                TextField("发消息，创建服务器任务…", text: $draft.title, axis: .vertical)
                    .font(.body).lineSpacing(4).lineLimit(1...5).focused($focused)
                    .disabled(busy || draft.submitted).accessibilityIdentifier("paperclip.taskTitle")
                Button { Task { await submit() } } label: {
                    if busy { ProgressView() }
                    else { Image(systemName: draft.submitted ? "arrow.clockwise.circle.fill" : "arrow.up.circle.fill").font(.title) }
                }
                .disabled(busy || !draft.canRetryCreate() || draft.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                .accessibilityLabel(draft.submitted ? "重试同一提交" : "发送并创建服务器任务")
                .accessibilityIdentifier("paperclip.submitTask")
                .tint(.primary)
            }
            if let error { Text(error).font(.caption).foregroundStyle(.red).lineLimit(2) }
        }
        .modifier(PaperclipComposerPanel())
        .animation(reduceMotion ? nil : .easeOut(duration: 0.16), value: busy)
        .onAppear { updateComposing() }
        .onChange(of: focusRequest) { _, _ in focused = true }
        .onChange(of: focused) { _, _ in updateComposing() }
        .onChange(of: draft.title) { _, _ in draft.save(key: draftKey); updateComposing() }
        .onChange(of: draft.body) { _, _ in draft.save(key: draftKey); updateComposing() }
        .onChange(of: draft.agentID) { _, _ in draft.save(key: draftKey) }
        .onChange(of: showDetails) { _, _ in updateComposing() }
        .onChange(of: showReceipt) { _, _ in updateComposing() }
        .onChange(of: busy) { _, _ in updateComposing() }
        .onDisappear { if !draft.title.isEmpty || !draft.body.isEmpty { draft.save(key: draftKey) }; composing = false }
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
                        Text("公司编号：\(companyID)").font(.caption)
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
                Button("取消", role: .cancel) {}
            } message: { Text("操作可能已经在服务器生效，请先核对。解除只保存本机核对记录，不会重新发送；新任务需要你再次明确提交。") }
            }
        }
    }
    private func updateComposing() {
        // 保存的草稿或待核对回执不是编辑焦点；只读同步不会修改或重发它们。
        composing = busy || !PaperclipPollingPolicy.canRefresh(active: true, statusSheetOpen: showDetails || showReceipt, replyFocused: focused)
    }
    private func submit() async {
        guard !busy, draft.canRetryCreate() else { return }
        busy = true
        let wasPreviouslySubmitted = draft.submitted
        draft.markSubmitted()
        draft.save(key: draftKey)
        do {
            let issue = try await client.create(companyID: companyID, userID: userID,
                title: draft.title, description: draft.body, agentID: draft.agentID.isEmpty ? nil : draft.agentID, requestID: draft.requestID)
            PaperclipDraft.clear(key: draftKey)
            draft = PaperclipDraft()
            focused = false
            await onCreated(issue)
        } catch {
            draft.recordFailure(error, wasPreviouslySubmitted: wasPreviouslySubmitted)
            draft.save(key: draftKey)
            self.error = PaperclipLabels.error(error)
        }
        busy = false
        updateComposing()
    }
}

/// 首页与任务对话共用原生输入面板，随系统外观与键盘安全区适配。
struct PaperclipComposerPanel: ViewModifier {
    func body(content: Content) -> some View {
        content
            .padding(.horizontal, 14).padding(.vertical, 12)
            .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 22))
            .overlay { RoundedRectangle(cornerRadius: 22).strokeBorder(Color.primary.opacity(0.07), lineWidth: 0.5) }
            .shadow(color: .black.opacity(0.035), radius: 8, y: 3)
            .padding(.horizontal, 14).padding(.vertical, 8)
            .background(Color(.systemGroupedBackground))
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
