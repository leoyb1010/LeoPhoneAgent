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
    @Environment(\.scenePhase) private var scenePhase
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
    }
    var body: some View {
        List {
            Section("任务归属") {
                Text(model.client.profile.name).font(.headline)
                Text(model.reference.origin.absoluteString).font(.caption).textSelection(.enabled)
                Text("公司编号：\(model.reference.companyID)").font(.caption)
                Text("用户编号：\(model.reference.userID)").font(.caption)
                if let date = model.lastRefreshed { Text("最近同步：\(date.formatted(date: .omitted, time: .standard))").font(.caption).foregroundStyle(.secondary) }
            }
            if let error = model.error {
                Section("操作提示") { Text(error).foregroundStyle(.red).textSelection(.enabled) }
            }
            if let issue = model.issue {
                Section("任务") {
                    Text(issue.title).font(.title3.weight(.semibold)).textSelection(.enabled)
                    if let identifier = issue.identifier { Text(identifier).font(.caption).foregroundStyle(.secondary) }
                    Text("状态：\(PaperclipLabels.status(issue.status))")
                    Text("优先级：\(PaperclipLabels.priority(issue.priority))")
                    if let description = issue.description, !description.isEmpty { Text(description).textSelection(.enabled) }
                    Menu("更改任务状态") {
                        ForEach(PaperclipIssueStatus.allCases) { status in
                            Button(status.title) { pendingDecision = Decision(status: status, approval: nil, approve: false) }
                                .disabled(status.rawValue == issue.status)
                        }
                    }.disabled(model.busy)
                }
                commentsSection
                replySection
                runsSection
                approvalsSection
            } else if model.busy { ProgressView("正在加载任务…") }
        }
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
        .alert(item: $pendingDecision) { decision in
            Alert(title: Text(decision.title), message: Text(decision.approval == nil
                ? "这会修改服务器上的任务状态，并可能影响服务器调度。"
                : "请先阅读完整审批内容。此决定将以当前人类用户身份发送到绑定的服务器。"),
                primaryButton: .default(Text("确认")) { Task { await apply(decision) } }, secondaryButton: .cancel(Text("取消")))
        }
        .confirmationDialog("放弃草稿不会撤销服务器可能已接收的回复", isPresented: $discardReply, titleVisibility: .visible) {
            Button("已核对，放弃草稿", role: .destructive) { draft = PaperclipDraft(); PaperclipDraft.clear(key: draftKey) }
            Button("取消", role: .cancel) {}
        }
    }
    private var commentsSection: some View {
        Section("任务对话") {
            if model.comments.isEmpty { Text("暂无回复").foregroundStyle(.secondary) }
            ForEach(model.comments) { comment in
                VStack(alignment: .leading, spacing: 6) {
                    Text(comment.authorUserId == nil ? "代理回复" : "用户回复").font(.caption).foregroundStyle(.secondary)
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
            Button(draft.submitted ? "重试同一回复" : "发送到服务器") { Task { await reply() } }
                .disabled(model.busy || draft.body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                .accessibilityIdentifier("paperclip.sendReply")
        }
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
                DisclosureGroup("\(approval.title) · \(PaperclipLabels.status(approval.status))") {
                    Text("审批编号：\(approval.id)").font(.caption).textSelection(.enabled)
                    Text("以下内容由服务器提供，请完整核对后决定。").font(.footnote).foregroundStyle(.secondary)
                    Text(approval.payloadText).font(.system(.caption, design: .monospaced)).textSelection(.enabled)
                    if let note = approval.decisionNote { Text("决定说明：\(note)") }
                    if approval.status == "pending" {
                        TextField("决定说明（可选）", text: $decisionNote, axis: .vertical).disabled(model.busy)
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
            _ = try await model.client.reply(model.reference, body: draft.body, requestID: draft.requestID)
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
                _ = try await model.client.resolve(model.reference, approvalID: approval.id, approve: decision.approve, note: decisionNote)
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
    @State private var error: String?
    @State private var busy = false
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                Text("运行编号：\(run.runId)").font(.caption)
                Text("显示服务器日志开头最多 64 KB。日志是服务器原始输出，可能包含英文。")
                    .font(.footnote).foregroundStyle(.secondary)
                if let error { Text(error).foregroundStyle(.red) }
                if busy { ProgressView("正在读取日志…") }
                Text(content.isEmpty && !busy ? "暂无日志内容" : content)
                    .font(.system(.caption, design: .monospaced)).textSelection(.enabled)
            }.frame(maxWidth: .infinity, alignment: .leading).padding()
        }
        .navigationTitle("运行日志")
        .toolbar { Button("刷新") { Task { await load() } }.disabled(busy) }
        .task { await load() }
    }
    private func load() async {
        guard !busy else { return }
        busy = true
        do { content = try await client.runLog(reference, runID: run.runId); error = nil }
        catch { self.error = PaperclipLabels.error(error); content = "" }
        busy = false
    }
}
