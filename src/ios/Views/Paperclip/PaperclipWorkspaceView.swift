import SwiftUI

/// 后端选择仅影响当前工作区；本机会话、记忆、工具和远程 Mac 控制台保留原语义。
struct IOSWorkspaceRootView<LocalContent: View>: View {
    @AppStorage("leo.ios.executionBackend.v1") private var selected = IOSExecutionBackend.local.rawValue
    @ViewBuilder let localContent: () -> LocalContent
    var body: some View {
        Group {
            if selected == IOSExecutionBackend.paperclip.rawValue {
                PaperclipWorkspaceView().environment(\.locale, Locale(identifier: "zh_Hans_CN"))
            }
            else { localContent() }
        }
        .safeAreaInset(edge: .top, spacing: 0) {
            Picker("执行后端", selection: $selected) {
                ForEach(IOSExecutionBackend.allCases, id: \.rawValue) { Text($0.title).tag($0.rawValue) }
            }
            .pickerStyle(.segmented)
            .accessibilityIdentifier("paperclip.backend")
            .padding(.horizontal).padding(.vertical, 6)
            .background(.regularMaterial)
        }
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

@MainActor
struct PaperclipWorkspaceView: View {
    @StateObject private var store: PaperclipWorkspaceStore
    init(store: PaperclipWorkspaceStore? = nil) {
        _store = StateObject(wrappedValue: store ?? PaperclipWorkspaceStore())
    }
    @State private var addProfile = false
    @State private var login = false
    @State private var create = false
    @State private var clearLogin = false
    @State private var query = ""
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
                connectionSection
                if let error = store.error {
                    Section("连接提示") {
                        Text(error).foregroundStyle(.red).textSelection(.enabled)
                        Button("重新验证连接") { Task { await store.connect() } }.disabled(store.busy)
                    }
                }
                if let user = store.user, let client = store.client {
                    Section {
                        if store.companies.isEmpty {
                            Text("当前账号没有可访问的公司。请在服务器网页中完成公司设置或联系管理员。")
                        } else {
                            Picker("公司", selection: Binding(get: { store.companyID }, set: { id in Task { await store.selectCompany(id) } })) {
                                ForEach(store.companies) { Text($0.name).tag($0.id) }
                            }.disabled(store.busy)
                        }
                    } header: { Text("当前用户：\(user.label)") }
                    if !store.companyID.isEmpty {
                        Section("服务器任务") {
                            if filtered.isEmpty {
                                Text(store.busy ? "正在加载任务…" : "暂无匹配任务，可创建一个新任务。")
                                    .foregroundStyle(.secondary)
                            }
                            ForEach(filtered) { issue in
                                NavigationLink {
                                    PaperclipIssueDetailView(client: client, reference: client.reference(for: issue, userID: user.id))
                                } label: {
                                    VStack(alignment: .leading, spacing: 5) {
                                        Text(issue.title).font(.headline)
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
                Section("执行方式") {
                    Text("服务器任务在 Paperclip 上执行。本机会话、记忆和工具仍留在本机工作区，切换不会迁移已有任务。")
                        .font(.footnote).foregroundStyle(.secondary)
                    Text("列表显示服务器确认的数据；前台每 15 秒刷新。发送失败不会自动重发，也不会改用本机。")
                        .font(.footnote).foregroundStyle(.secondary)
                }
            }
            .navigationTitle("Paperclip 工作区")
            .modifier(PaperclipTaskSearch(isEnabled: store.user != nil && !store.companyID.isEmpty, query: $query))
            .refreshable { if store.user == nil { await store.connect() } else { await store.refresh() } }
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Button { create = true } label: { Label("新建服务器任务", systemImage: "plus") }
                        .disabled(store.user == nil || store.companyID.isEmpty || store.busy)
                        .accessibilityIdentifier("paperclip.create")
                }
                ToolbarItem(placement: .topBarLeading) {
                    if store.busy { ProgressView("正在同步") }
                    else { Button("刷新") { Task { if store.user == nil { await store.connect() } else { await store.refresh() } } } }
                }
            }
            .sheet(isPresented: $addProfile) { PaperclipAddProfileView(store: store) }
            .sheet(isPresented: $login) {
                if let profile = store.selectedProfile { PaperclipLoginView(profile: profile) { await store.connect() } }
            }
            .sheet(isPresented: $create, onDismiss: { Task { await store.refresh() } }) {
                if let client = store.client, let user = store.user {
                    PaperclipCreateIssueView(client: client, companyID: store.companyID, userID: user.id, agents: store.agents)
                }
            }
            .confirmationDialog("清除这台设备上此服务器配置的登录？", isPresented: $clearLogin, titleVisibility: .visible) {
                Button("清除本机登录", role: .destructive) { Task { await store.clearLogin() } }
                Button("取消", role: .cancel) {}
            } message: { Text("这会清除此配置的浏览器登录数据，服务器上的任务和本机会话不会删除。") }
        }
        .id(store.identityKey)
        // 连接任务放在重置导航路径的 id 之外，退出登录不会意外触发重新登录。
        .task(id: store.selectedID) { if store.selectedProfile != nil { await store.connect() } }
        .task(id: scenePhase) {
            guard scenePhase == .active else { return }
            while !Task.isCancelled {
                do { try await Task.sleep(for: .seconds(15)) } catch { return }
                if store.user != nil { await store.refresh() }
            }
        }
    }

    private var connectionSection: some View {
        Section("独立服务器") {
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
    @Environment(\.dismiss) private var dismiss
    @State private var draft: PaperclipDraft
    @State private var busy = false
    @State private var error: String?
    @State private var discard = false
    @State private var lastChecked: PaperclipDraft?
    private let draftKey: String

    init(client: PaperclipClient, companyID: String, userID: String, agents: [PaperclipAgent]) {
        self.client = client; self.companyID = companyID; self.userID = userID; self.agents = agents
        let key = PaperclipDraft.key(profile: client.profile, companyID: companyID, userID: userID)
        draftKey = key
        _draft = State(initialValue: PaperclipDraft.load(key: key))
        _lastChecked = State(initialValue: PaperclipDraft.lastChecked(key: key))
    }
    var body: some View {
        NavigationStack {
            Form {
                Section("任务内容") {
                    TextField("任务标题", text: $draft.title).accessibilityIdentifier("paperclip.taskTitle")
                    TextField("说明、目标和验收条件", text: $draft.body, axis: .vertical).lineLimit(5...12)
                    Picker("执行代理", selection: $draft.agentID) {
                        Text("暂不分配（待规划）").tag("")
                        ForEach(agents.filter { $0.status != "terminated" }) { Text($0.name).tag($0.id) }
                    }
                }.disabled(busy || draft.submitted)
                Section("提交目标") {
                    Text(client.profile.name)
                    Text(client.profile.origin.absoluteString).font(.caption)
                    Text("公司编号：\(companyID)").font(.caption)
                    Text("指定代理后将创建待处理任务，服务器按自己的调度和审批规则执行。")
                        .font(.footnote).foregroundStyle(.secondary)
                }
                if draft.submitted {
                    Section("待核对提交") {
                        Text("这份草稿已经提交过，请先在任务列表核对结果。6天内重试会使用原请求编号，由服务器去重。")
                        if !draft.canRetryCreate() {
                            Text("首次提交已超过安全重试窗口，或提交时间无法确认。请先在服务器核对任务，再决定是否放弃这份草稿。")
                                .foregroundStyle(.orange)
                        }
                        Button("放弃本机草稿", role: .destructive) { discard = true }.disabled(busy)
                    }
                }
                if let lastChecked { PaperclipCheckedDraftView(draft: lastChecked) }
                if let error { Text(error).foregroundStyle(.red) }
                Button(busy ? "正在提交…" : (draft.submitted ? "重试同一提交" : "创建服务器任务")) { Task { await submit() } }
                    .disabled(busy || !draft.canRetryCreate() || draft.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    .accessibilityIdentifier("paperclip.submitTask")
            }
            .scrollDismissesKeyboard(.interactively)
            .navigationTitle("新建服务器任务")
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("关闭") { draft.save(key: draftKey); dismiss() }.disabled(busy) } }
            .interactiveDismissDisabled(busy)
            .onDisappear { if !draft.title.isEmpty { draft.save(key: draftKey) } }
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
    private func submit() async {
        guard !busy, draft.canRetryCreate() else { return }
        busy = true
        if !draft.submitted { draft.firstSubmittedAt = Date() }
        draft.submitted = true
        draft.save(key: draftKey)
        do {
            _ = try await client.create(companyID: companyID, userID: userID,
                title: draft.title, description: draft.body, agentID: draft.agentID.isEmpty ? nil : draft.agentID, requestID: draft.requestID)
            PaperclipDraft.clear(key: draftKey)
            draft = PaperclipDraft()
            dismiss()
        } catch { self.error = PaperclipLabels.error(error) }
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


private struct PaperclipTaskSearch: ViewModifier {
    let isEnabled: Bool
    @Binding var query: String
    @ViewBuilder func body(content: Content) -> some View {
        if isEnabled { content.searchable(text: $query, prompt: "搜索已加载的任务") }
        else { content }
    }
}
