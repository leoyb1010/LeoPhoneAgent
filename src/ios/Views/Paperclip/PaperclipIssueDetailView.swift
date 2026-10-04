import SwiftUI

@MainActor
final class PaperclipIssueDetailModel: ObservableObject {
    let client: PaperclipClient
    let reference: PaperclipTaskReference
    @Published var issue: PaperclipIssue?
    @Published var comments: [PaperclipComment] = []
    @Published var runs: [PaperclipRun] = []
    @Published var approvals: [PaperclipApproval] = []
    @Published var busy = false
    @Published var error: String?
    @Published var lastRefreshed: Date?
    init(client: PaperclipClient, reference: PaperclipTaskReference) { self.client = client; self.reference = reference }

    func refresh() async {
        guard !busy else { return }
        busy = true
        do {
            let nextIssue = try await client.issue(reference)
            let nextComments = try await client.comments(reference)
            let nextRuns = try await client.runs(reference)
            let nextApprovals = try await client.approvals(reference)
            guard !Task.isCancelled else { busy = false; return }
            issue = nextIssue; comments = nextComments; runs = nextRuns; approvals = nextApprovals
            lastRefreshed = Date()
            error = nil
        } catch { record(error) }
        busy = false
    }
    func record(_ error: Error) {
        self.error = PaperclipLabels.error(error)
        if error as? PaperclipError == .signedOut || error as? PaperclipError == .identityChanged {
            issue = nil; comments = []; runs = []; approvals = []
        }
    }
}

struct PaperclipIssueDetailView: View {
    @StateObject private var model: PaperclipIssueDetailModel
    @State private var draft: PaperclipDraft
    @State private var decisionNote = ""
    @State private var pendingDecision: Decision?
    @State private var discardReply = false
    @State private var lastChecked: PaperclipDraft?
    @State private var visible = false
    @State private var details = false
    @State private var positionedConversation = false
    @State private var revealCommentID: String?
    @State private var expandedApprovalIDs: Set<String> = []
    @FocusState private var editingReply: Bool
    @FocusState private var editingDecision: Bool
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    private let draftKey: String
    private struct Decision: Identifiable {
        let id = UUID()
        let status: PaperclipIssueStatus?
        let approval: PaperclipApproval?
        let approve: Bool
        var title: String { if let status { return "将任务设为「\(status.title)」？" }; return approve ? "确认批准此请求？" : "确认拒绝此请求？" }
    }

    init(client: PaperclipClient, reference: PaperclipTaskReference) {
        _model = StateObject(wrappedValue: PaperclipIssueDetailModel(client: client, reference: reference))
        let key = PaperclipDraft.key(profile: client.profile, companyID: reference.companyID, userID: reference.userID, issueID: reference.issueID)
        draftKey = key
        _draft = State(initialValue: PaperclipDraft.load(key: key))
        _lastChecked = State(initialValue: PaperclipDraft.lastChecked(key: key))
    }
    var body: some View {
        ScrollViewReader { proxy in
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 18) {
            if let error = model.error {
                VStack(alignment: .leading, spacing: 6) {
                    DisclosureGroup("操作未完成，点此查看原因") {
                        Text(error).font(.footnote).foregroundStyle(.red).textSelection(.enabled)
                    }
                    Button("重新同步") { Task { await model.refresh() } }.disabled(model.busy)
                }
            }
            if let issue = model.issue {
                VStack(alignment: .leading, spacing: 6) {
                    HStack {
                        if let identifier = issue.identifier { Text(identifier) }
                        Text(PaperclipLabels.status(issue.status))
                    }.font(.subheadline).foregroundStyle(.secondary)
                    Text(issue.title).font(.title3.weight(.semibold)).textSelection(.enabled)
                }
                if let description = issue.description, !description.isEmpty {
                    messageBubble(body: description, author: "任务说明", time: nil, mine: false)
                }
                commentsSection
            } else if model.busy { ProgressView("正在加载任务…") }
            Color.clear.frame(height: 1).id("paperclip.latest")
            }.padding(.horizontal, 16).padding(.vertical, 18)
        }
        .onChange(of: model.issue?.id) { _, _ in revealConversation(using: proxy) }
        .onChange(of: model.comments.map(\.id)) { _, _ in revealConversation(using: proxy) }
        .onChange(of: revealCommentID) { _, _ in revealConversation(using: proxy) }
        .background(Color(.systemGroupedBackground))
        .safeAreaInset(edge: .bottom, spacing: 0) { if model.issue != nil { replySection } }
        .navigationTitle(model.issue?.identifier ?? "任务对话")
        .navigationBarTitleDisplayMode(.inline)
        .scrollDismissesKeyboard(.interactively)
        .onAppear { visible = true }
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Button("刷新消息", systemImage: "arrow.clockwise") { Task { await model.refresh() } }.disabled(model.busy)
                    Button("任务信息、运行与审批", systemImage: "sidebar.right") { details = true }
                    if let issue = model.issue {
                        Menu("更改任务状态") {
                            ForEach(PaperclipIssueStatus.allCases) { status in
                                Button(status.title) { pendingDecision = Decision(status: status, approval: nil, approve: false) }
                                    .disabled(status.rawValue == issue.status)
                            }
                        }.disabled(model.busy)
                    }
                } label: { Image(systemName: "ellipsis.circle") }
                .accessibilityLabel("任务操作").accessibilityIdentifier("paperclip.taskActions")
            }
        }
        .sheet(isPresented: $details) {
            NavigationStack {
                List {
                    Section("任务归属") {
                        Text(model.client.profile.name).font(.headline)
                        Text(model.reference.origin.absoluteString).font(.caption).textSelection(.enabled)
                        Text("公司编号：\(model.reference.companyID)").font(.caption)
                        Text("用户编号：\(model.reference.userID)").font(.caption)
                        if let issue = model.issue { Text("优先级：\(PaperclipLabels.priority(issue.priority))") }
                        if let date = model.lastRefreshed { Text("最近同步：\(date.formatted(date: .omitted, time: .standard))").font(.caption).foregroundStyle(.secondary) }
                    }
                    runsSection
                    approvalsSection
                    if let lastChecked { Section { PaperclipCheckedDraftView(draft: lastChecked) } }
                }
                .navigationTitle("任务信息").navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .confirmationAction) { Button("完成") { details = false } } }
                .alert(item: $pendingDecision) { decisionAlert($0) }
            }
        }
        .refreshable { await model.refresh() }
        .task { await model.refresh() }
        .task(id: scenePhase) {
            guard scenePhase == .active else { return }
            while !Task.isCancelled {
                do { try await Task.sleep(for: .seconds(15)) } catch { return }
                if visible && !editingReply && !editingDecision && draft.body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                    && decisionNote.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                    && pendingDecision == nil && !discardReply && !details && expandedApprovalIDs.isEmpty {
                    await model.refresh()
                }
            }
        }
        .onDisappear { visible = false; if !draft.body.isEmpty { draft.save(key: draftKey) } }
        .onChange(of: draft.body) { _, _ in draft.save(key: draftKey) }
        .alert(item: Binding(get: { details ? nil : pendingDecision }, set: { pendingDecision = $0 })) { decisionAlert($0) }
        .confirmationDialog("放弃草稿不会撤销服务器可能已接收的回复", isPresented: $discardReply, titleVisibility: .visible) {
            Button("已核对，解除待提交状态", role: .destructive) {
                draft.archive(key: draftKey)
                lastChecked = draft
                draft = PaperclipDraft()
                model.error = nil
            }
            Button("取消", role: .cancel) {}
        } message: { Text("回复可能已经在服务器生效，请先核对。解除只保存本机核对记录，不会重新发送。") }
        }
    }
    private func revealConversation(using proxy: ScrollViewProxy) {
        if let id = revealCommentID, model.comments.contains(where: { $0.id == id }) {
            if reduceMotion { proxy.scrollTo(id, anchor: .bottom) }
            else { withAnimation(.easeOut(duration: 0.2)) { proxy.scrollTo(id, anchor: .bottom) } }
            revealCommentID = nil
            positionedConversation = true
        } else if !positionedConversation && model.issue != nil {
            proxy.scrollTo("paperclip.latest", anchor: .bottom)
            positionedConversation = true
        }
    }
    private func decisionAlert(_ decision: Decision) -> Alert {
        Alert(title: Text(decision.title), message: Text(decision.approval == nil
            ? "这会修改服务器上的任务状态，并可能影响服务器调度。"
            : "请先阅读完整审批内容。此决定将以当前人类用户身份发送到绑定的服务器。"),
            primaryButton: .default(Text("确认")) { Task { await apply(decision) } }, secondaryButton: .cancel(Text("取消")))
    }
    private var commentsSection: some View {
        VStack(alignment: .leading, spacing: 16) {
            if model.comments.isEmpty { Text("还没有任务消息。任务状态以服务器为准。").font(.footnote).foregroundStyle(.secondary) }
            ForEach(model.comments) { comment in
                messageBubble(body: comment.body,
                    author: comment.authorUserId == model.reference.userID ? "我" : (comment.authorAgentId != nil ? "执行者消息" : (comment.authorUserId != nil ? "用户消息" : "任务消息")),
                    time: comment.createdAt, mine: comment.authorUserId == model.reference.userID)
                    .id(comment.id)
            }
        }
    }
    private func messageBubble(body: String, author: String, time: String?, mine: Bool) -> some View {
        HStack(alignment: .top, spacing: 24) {
            if mine { Spacer(minLength: 24) }
            VStack(alignment: mine ? .trailing : .leading, spacing: 6) {
                Text(author).font(.caption).foregroundStyle(.secondary)
                Text(body).font(.body).lineSpacing(4).textSelection(.enabled).padding(14)
                    .foregroundStyle(mine ? Color.white : Color.primary)
                    .background(mine ? Color.indigo : Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 18))
                if let time {
                    Text(displayTime(time)).font(.caption2).foregroundStyle(.secondary)
                }
            }
            if !mine { Spacer(minLength: 24) }
        }.frame(maxWidth: .infinity, alignment: mine ? .trailing : .leading)
    }
    private func displayTime(_ value: String) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = formatter.date(from: value) { return date.formatted(date: .abbreviated, time: .shortened) }
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.date(from: value)?.formatted(date: .abbreviated, time: .shortened) ?? value
    }
    private var replySection: some View {
        VStack(alignment: .leading, spacing: 8) {
            if draft.submitted {
                HStack {
                    Text("上次回复待核对").font(.caption).foregroundStyle(.secondary)
                    Spacer()
                    Button("已核对，解除草稿锁定") { discardReply = true }.font(.caption).disabled(model.busy)
                }
            }
            HStack(alignment: .bottom, spacing: 10) {
            TextField("回复任务或补充要求…", text: $draft.body, axis: .vertical).lineLimit(1...5)
                .font(.body).lineSpacing(4)
                .focused($editingReply)
                .disabled(model.busy || draft.submitted).accessibilityIdentifier("paperclip.replyBody")
            Button { Task { await reply() } } label: {
                if model.busy { ProgressView() }
                else { Image(systemName: draft.submitted ? "arrow.clockwise.circle.fill" : "arrow.up.circle.fill").font(.title) }
            }
                .disabled(model.busy || draft.body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                .accessibilityLabel(draft.submitted ? "重试同一回复" : "发送到服务器")
                .accessibilityIdentifier("paperclip.sendReply")
                .tint(.primary)
            }
        }
        .modifier(PaperclipComposerPanel())
        .animation(reduceMotion ? nil : .easeOut(duration: 0.16), value: model.busy)
    }
    private var runsSection: some View {
        Section("运行记录") {
            if model.runs.isEmpty { Text("尚无运行记录。任务已创建不代表代理已经开始执行。") .foregroundStyle(.secondary) }
            ForEach(model.runs) { run in
                NavigationLink {
                    PaperclipRunLogView(client: model.client, reference: model.reference, run: run)
                } label: {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(PaperclipLabels.status(run.status)).font(.headline)
                        Text("运行编号：\(run.runId)").font(.caption).lineLimit(2)
                        if let time = run.startedAt { Text("开始时间：\(time)").font(.caption).foregroundStyle(.secondary) }
                        if let time = run.finishedAt { Text("结束时间：\(time)").font(.caption).foregroundStyle(.secondary) }
                    }
                }
            }
        }
    }
    private var approvalsSection: some View {
        Section("关联审批") {
            if model.approvals.isEmpty { Text("暂无关联审批").foregroundStyle(.secondary) }
            ForEach(model.approvals) { approval in
                DisclosureGroup("\(approval.title) · \(PaperclipLabels.status(approval.status))", isExpanded: Binding(
                    get: { expandedApprovalIDs.contains(approval.id) },
                    set: { expanded in
                        if expanded { expandedApprovalIDs.insert(approval.id) }
                        else { expandedApprovalIDs.remove(approval.id) }
                    }
                )) {
                    Text("审批编号：\(approval.id)").font(.caption).textSelection(.enabled)
                    Text("申请者：\(approval.requestedByUserId ?? approval.requestedByAgentId ?? "未提供")").font(.caption).textSelection(.enabled)
                    Text("以下内容由服务器提供，请完整核对后决定。").font(.footnote).foregroundStyle(.secondary)
                    Text(approval.payloadText).font(.system(.caption, design: .monospaced)).textSelection(.enabled)
                    if let note = approval.decisionNote { Text("决定说明：\(note)") }
                    if approval.status == "pending" {
                        TextField("决定说明（可选）", text: $decisionNote, axis: .vertical).focused($editingDecision).disabled(model.busy)
                        Button("批准") { pendingDecision = Decision(status: nil, approval: approval, approve: true) }.disabled(model.busy)
                        Button("拒绝", role: .destructive) { pendingDecision = Decision(status: nil, approval: approval, approve: false) }.disabled(model.busy)
                    }
                }
            }
        }
    }
    private func reply() async {
        guard !model.busy else { return }
        model.busy = true
        let wasPreviouslySubmitted = draft.submitted
        draft.markSubmitted()
        draft.save(key: draftKey)
        do {
            let sent = try await model.client.reply(model.reference, body: draft.body, requestID: draft.requestID)
            revealCommentID = sent.id
            draft = PaperclipDraft()
            PaperclipDraft.clear(key: draftKey)
            model.error = nil
        } catch {
            draft.recordFailure(error, wasPreviouslySubmitted: wasPreviouslySubmitted)
            draft.save(key: draftKey)
            model.record(error); model.busy = false; return
        }
        model.busy = false
        await model.refresh()
    }
    private func apply(_ decision: Decision) async {
        guard !model.busy else { return }
        model.busy = true
        do {
            if let status = decision.status { _ = try await model.client.setStatus(model.reference, status: status) }
            if let approval = decision.approval {
                _ = try await model.client.resolve(model.reference, approval: approval, approve: decision.approve, note: decisionNote)
                decisionNote = ""
            }
            model.error = nil
        } catch { model.record(error); model.busy = false; return }
        model.busy = false
        await model.refresh()
    }
}

private struct PaperclipRunLogView: View {
    let client: PaperclipClient
    let reference: PaperclipTaskReference
    let run: PaperclipRun
    @State private var content = ""
    @State private var nextOffset = 0
    @State private var canReadMore = false
    @State private var error: String?
    @State private var busy = false
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                Text("运行编号：\(run.runId)").font(.caption)
                Text("日志每次读取最多64KB，可继续读取下一段。内容为服务器原始输出，可能包含英文；此页不会自动刷新。")
                    .font(.footnote).foregroundStyle(.secondary)
                if let error { Text(error).foregroundStyle(.red) }
                if busy { ProgressView("正在读取日志…") }
                Text(content.isEmpty && !busy ? "暂无日志内容" : content)
                    .font(.system(.caption, design: .monospaced)).textSelection(.enabled)
                if canReadMore {
                    Button("继续读取下一段日志") { Task { await load(reset: false) } }.disabled(busy)
                }
            }.frame(maxWidth: .infinity, alignment: .leading).padding()
        }
        .navigationTitle("运行日志")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { Button("刷新") { Task { await load() } }.disabled(busy) }
        .task { await load() }
    }
    private func load(reset: Bool = true) async {
        guard !busy else { return }
        busy = true
        let offset = reset ? 0 : nextOffset
        do {
            let chunk = try await client.runLog(reference, runID: run.runId, offset: offset)
            content = reset ? chunk.content : content + chunk.content
            nextOffset = chunk.nextOffset ?? offset
            canReadMore = !chunk.content.isEmpty && nextOffset > offset
            error = nil
        } catch { self.error = PaperclipLabels.error(error) }
        busy = false
    }
}
