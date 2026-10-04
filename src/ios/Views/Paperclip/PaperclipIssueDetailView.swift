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
    enum StatusResult { case confirmed, uncertain, rejected }
    func changeStatus(_ expected: PaperclipStatusExpectation) async -> StatusResult {
        guard !busy else { return .rejected }
        busy = true
        do {
            issue = try await client.setStatus(reference, status: expected.status, unblockAction: expected.unblockAction)
            error = nil
        } catch {
            record(error)
            busy = false
            return error as? PaperclipError == .uncertain ? .uncertain : .rejected
        }
        busy = false
        await refresh()
        return .confirmed
    }
    /// 未知回执恢复只允许GET，不能把核实按钮变成第二次PATCH。
    func verifyStatus(_ expected: PaperclipStatusExpectation) async -> Bool {
        guard !busy else { return false }
        guard expected.userID == reference.userID else { record(PaperclipError.identityChanged); return false }
        busy = true
        defer { busy = false }
        do {
            let current = try await client.issue(reference)
            issue = current
            guard expected.matches(current) else { error = PaperclipError.statusNotConfirmed.errorDescription; return false }
            error = nil
            lastRefreshed = Date()
            return true
        } catch { record(error); return false }
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
    @State private var showStatusPicker = false
    @State private var lastChecked: PaperclipDraft?
    @Environment(\.scenePhase) private var scenePhase
    private let draftKey: String
    private struct Decision: Identifiable {
        let id = UUID()
        let approval: PaperclipApproval
        let approve: Bool
        var title: String { approve ? "确认批准此请求？" : "确认拒绝此请求？" }
    }

    init(client: PaperclipClient, reference: PaperclipTaskReference) {
        _model = StateObject(wrappedValue: PaperclipIssueDetailModel(client: client, reference: reference))
        let key = PaperclipDraft.key(profile: client.profile, companyID: reference.companyID, userID: reference.userID, issueID: reference.issueID)
        draftKey = key
        _draft = State(initialValue: PaperclipDraft.load(key: key))
        _lastChecked = State(initialValue: PaperclipDraft.lastChecked(key: key))
    }
    var body: some View {
        List {
            if let error = model.error {
                Section("操作提示") { Text(error).foregroundStyle(.red).textSelection(.enabled) }
            }
            if let issue = model.issue {
                Section("任务") {
                    Text(issue.title).font(.title3.weight(.semibold)).textSelection(.enabled)
                    if let identifier = issue.identifier { Text(identifier).font(.caption).foregroundStyle(.secondary) }
                    Text("状态：\(PaperclipLabels.status(issue.status))")
                    Text("优先级：\(PaperclipLabels.priority(issue.priority))").foregroundStyle(.secondary)
                    if let description = issue.description, !description.isEmpty { Text(description).textSelection(.enabled) }
                    Button {
                        showStatusPicker = true
                    } label: {
                        Text("更改任务状态").frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(.tint)
                    .disabled(model.busy)
                    .accessibilityIdentifier("paperclip.changeStatus")
                }
                attributionSection
                commentsSection
                replySection
                runsSection
                approvalsSection
            } else {
                if model.busy { ProgressView("正在加载任务…") }
                attributionSection
            }
        }
        .scrollDismissesKeyboard(.interactively)
        .navigationTitle("服务器任务详情")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .primaryAction) { Button("刷新") { Task { await model.refresh() } }.disabled(model.busy) } }
        .refreshable { await model.refresh() }
        .task { await model.refresh() }
        .task(id: scenePhase) {
            guard scenePhase == .active else { return }
            while !Task.isCancelled {
                do { try await Task.sleep(for: .seconds(15)) } catch { return }
                await model.refresh()
            }
        }
        .onDisappear { if !draft.body.isEmpty { draft.save(key: draftKey) } }
        .sheet(isPresented: $showStatusPicker) { PaperclipStatusPickerView(model: model) }
        .alert(item: $pendingDecision) { decision in
            Alert(title: Text(decision.title), message: Text("请先阅读完整审批内容。此决定将以当前人类用户身份发送到绑定的服务器。"),
                primaryButton: .default(Text("确认")) { Task { await apply(decision) } }, secondaryButton: .cancel(Text("取消")))
        }
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
    private var attributionSection: some View {
        Section {
            DisclosureGroup {
                Text(model.reference.origin.absoluteString).font(.caption).textSelection(.enabled)
                Text("组织编号：\(model.reference.companyID)").font(.caption).textSelection(.enabled)
                Text("用户编号：\(model.reference.userID)").font(.caption).textSelection(.enabled)
                if let date = model.lastRefreshed {
                    Text("最近同步：\(date.formatted(date: .omitted, time: .standard))").font(.caption).foregroundStyle(.secondary)
                }
                Text("本任务固定在此服务器、组织和用户身份下执行，不会自动迁移到其他后端。")
                    .font(.footnote).foregroundStyle(.secondary)
            } label: {
                Label("归属：\(model.client.profile.name)", systemImage: "server.rack")
                    .font(.subheadline).frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
            }.accessibilityIdentifier("paperclip.attribution")
        }
    }

    private var commentsSection: some View {
        Section("任务对话") {
            if model.comments.isEmpty { Text("暂无回复").foregroundStyle(.secondary) }
            ForEach(model.comments) { comment in
                VStack(alignment: .leading, spacing: 6) {
                    Text(comment.authorLabel).font(.caption).foregroundStyle(.secondary)
                    Text(comment.body).textSelection(.enabled)
                    if let time = comment.createdAt { Text(time).font(.caption2).foregroundStyle(.secondary) }
                }.padding(.vertical, 4)
            }
        }
    }
    private var replySection: some View {
        Section("发送回复") {
            TextField("补充要求或回复任务", text: $draft.body, axis: .vertical).lineLimit(3...8)
                .disabled(model.busy || draft.submitted).accessibilityIdentifier("paperclip.replyBody")
            if draft.submitted {
                Text("上次提交结果待核对，重试会沿用同一请求编号。请先刷新查看对话。")
                    .font(.footnote).foregroundStyle(.secondary)
                Button("放弃本机回复草稿", role: .destructive) { discardReply = true }.disabled(model.busy)
            }
            if let lastChecked { PaperclipCheckedDraftView(draft: lastChecked) }
            Button(draft.submitted ? "重试同一回复" : "发送到服务器") { Task { await reply() } }
                .disabled(model.busy || draft.body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                .accessibilityIdentifier("paperclip.sendReply")
        }
    }
    private var runsSection: some View {
        Section("运行记录") {
            if model.runs.isEmpty { Text("尚无运行记录。任务已创建不代表智能体已经开始执行。") .foregroundStyle(.secondary) }
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
                DisclosureGroup("\(approval.title) · \(PaperclipLabels.status(approval.status))") {
                    Text("审批编号：\(approval.id)").font(.caption).textSelection(.enabled)
                    Text("申请者：\(approval.requestedByUserId ?? approval.requestedByAgentId ?? "未提供")").font(.caption).textSelection(.enabled)
                    Text("以下内容由服务器提供，请完整核对后决定。").font(.footnote).foregroundStyle(.secondary)
                    Text(approval.payloadText).font(.system(.caption, design: .monospaced)).textSelection(.enabled)
                    if let note = approval.decisionNote { Text("决定说明：\(note)") }
                    if approval.status == "pending" {
                        TextField("决定说明（可选）", text: $decisionNote, axis: .vertical).disabled(model.busy)
                        Button("批准") { pendingDecision = Decision(approval: approval, approve: true) }.disabled(model.busy)
                            .accessibilityIdentifier("paperclip.approve.\(approval.id)")
                        Button("拒绝", role: .destructive) { pendingDecision = Decision(approval: approval, approve: false) }.disabled(model.busy)
                            .accessibilityIdentifier("paperclip.reject.\(approval.id)")
                    }
                }.accessibilityIdentifier("paperclip.approval.\(approval.id)")
            }
        }
    }
    private func reply() async {
        guard !model.busy else { return }
        model.busy = true
        if !draft.submitted { draft.firstSubmittedAt = Date() }
        draft.submitted = true
        draft.save(key: draftKey)
        do {
            _ = try await model.client.reply(model.reference, body: draft.body, requestID: draft.requestID)
            draft = PaperclipDraft()
            PaperclipDraft.clear(key: draftKey)
            model.error = nil
        } catch { model.record(error); model.busy = false; return }
        model.busy = false
        await model.refresh()
    }
    private func apply(_ decision: Decision) async {
        guard !model.busy else { return }
        model.busy = true
        do {
            _ = try await model.client.resolve(model.reference, approval: decision.approval, approve: decision.approve, note: decisionNote)
            decisionNote = ""
            model.error = nil
        } catch { model.record(error); model.busy = false; return }
        model.busy = false
        await model.refresh()
    }
}

/// 避免 Menu 在 List 中出现整行可访问节点与小范围实际触点不一致。
/// 选择页的每一行都能点击，并在最终确认前展示服务端修改后果。
private struct PaperclipStatusPickerView: View {
    @ObservedObject var model: PaperclipIssueDetailModel
    @Environment(\.dismiss) private var dismiss
    @State private var selected: PaperclipIssueStatus
    @State private var unblockAction = ""
    @State private var pendingVerification: PaperclipStatusExpectation?
    init(model: PaperclipIssueDetailModel) {
        self.model = model
        _selected = State(initialValue: PaperclipIssueStatus(rawValue: model.issue?.status ?? "") ?? .backlog)
    }
    var body: some View {
        NavigationStack {
            List {
                Section("选择新状态") {
                    ForEach(PaperclipIssueStatus.allCases) { status in
                        Button { selected = status } label: {
                            HStack {
                                Text(status.title)
                                Spacer()
                                if selected == status { Image(systemName: "checkmark").accessibilityLabel("已选择") }
                            }.frame(maxWidth: .infinity).contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityIdentifier("paperclip.status.\(status.rawValue)")
                        .disabled(model.busy || pendingVerification != nil)
                    }
                }
                if selected == .blocked {
                    Section("解除阻塞说明") {
                        TextField("解除阻塞需要做什么", text: $unblockAction, axis: .vertical).lineLimit(2...6)
                            .disabled(model.busy || pendingVerification != nil).accessibilityIdentifier("paperclip.unblockAction")
                        Text("请明确填写所需行动，不能留空。负责人将绑定为本任务当前用户；说明上限为2000个字符。")
                            .font(.footnote).foregroundStyle(.secondary)
                    }
                }
                Section("确认服务器操作") {
                    Text("将任务改为「\(selected.title)」。这会修改服务器记录，并可能影响服务器调度。")
                    if let error = model.error { Text(error).foregroundStyle(.red) }
                    if let pendingVerification {
                        Text("上次提交结果尚未确认，目标和说明已锁定。这里只读取服务器核实，不会重新发送。也可取消后刷新任务，再作新的决定。")
                            .font(.footnote).foregroundStyle(.orange)
                        Button(model.busy ? "正在核实…" : "核实状态") {
                            Task { if await model.verifyStatus(pendingVerification) { dismiss() } }
                        }
                        .disabled(model.busy)
                        .accessibilityIdentifier("paperclip.verifyStatus")
                    } else {
                        Button(model.busy ? "正在更新…" : "确认更改状态") {
                            do {
                                let expected = try PaperclipStatusExpectation(status: selected, userID: model.reference.userID, unblockAction: unblockAction)
                                Task {
                                    switch await model.changeStatus(expected) {
                                    case .confirmed: dismiss()
                                    case .uncertain: pendingVerification = expected
                                    case .rejected: break
                                    }
                                }
                            } catch { model.record(error) }
                        }
                        .disabled(model.busy || selected.rawValue == model.issue?.status || (selected == .blocked && PaperclipUnblockAction.normalized(unblockAction) == nil))
                        .accessibilityIdentifier("paperclip.confirmStatus")
                    }
                }
            }
            .scrollDismissesKeyboard(.interactively)
            .navigationTitle("更改任务状态")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() }.disabled(model.busy) } }
            .interactiveDismissDisabled(model.busy)
        }
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
