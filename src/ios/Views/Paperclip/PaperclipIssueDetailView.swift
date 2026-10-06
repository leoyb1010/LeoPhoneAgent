import Combine
import SwiftUI

@MainActor
final class PaperclipIssueDetailModel: ObservableObject {
    let client: PaperclipClient
    let reference: PaperclipTaskReference
    let runStream: PaperclipRunStream
    @Published var issue: PaperclipIssue?
    @Published var comments: [PaperclipComment] = [] { didSet { threadCache = nil } }
    @Published var runs: [PaperclipRun] = [] { didSet { threadCache = nil } }
    @Published var approvals: [PaperclipApproval] = []
    /// 写请求（回复、状态、审批）进行中；只有它会暂停只读刷新。
    @Published var busy = false
    /// 只读同步进行中（与写互不阻塞，不锁输入）。
    @Published private(set) var syncing = false
    @Published var error: String?
    @Published var lastRefreshed: Date?
    @Published private(set) var pendingStatus: PaperclipStatusExpectation?
    @Published private(set) var liveState: PaperclipLiveConnection.State?
    /// [A6] 回到前台或实时通道重连后的全量补拉完成时递增；视图据此核对待确认的回复草稿。
    @Published private(set) var recoveryChecks = 0
    private var statusKey: String { "leo.paperclip.status.v1." + reference.id }
    private var liveSubscriptions: Set<AnyCancellable> = []
    private var attachedLive: ObjectIdentifier?
    private var forwardRunStream: AnyCancellable?
    private var followups: Set<PaperclipRunStream.Followup> = []
    private var followupTask: Task<Void, Never>?
    private var pollCount = 0
    /// 同步进行中又收到的刷新请求（值为是否全量）。以前直接丢弃：发送后紧跟的刷新、重连后的全量补拉
    /// 若撞上正在进行的轮询就不会执行，刚发出的消息可能被旧的全量结果覆盖后消失到下一轮。
    private var queuedRefresh: Bool?
    /// 身份失效（record 清空数据）时递增；迟到的网络结果发现代际变化即丢弃，不把旧账号数据写回。
    private var epoch = 0
    /// 本机插入评论（发送回执、增量合并）的时间；全量结果不含它们时，晚于该次读取开始的保留，
    /// 早于读取开始的视为已删除。
    private var localInsertions: [String: Date] = [:]
    /// 线程条目缓存：评论或运行变化时失效。以前详情页每次重绘都对全部评论解析日期并排序。
    private var threadCache: (activeRunIDs: Set<String>, entries: [PaperclipThreadEntry])?
    /// 无实时通道且运行中时 3 秒轻量轮询，每 15 秒才做一次全量（任务、运行、审批）。
    private var lastHeavyPoll = Date.distantPast

    init(client: PaperclipClient, reference: PaperclipTaskReference) {
        self.client = client; self.reference = reference
        runStream = PaperclipRunStream(client: client, reference: reference)
        if let data = UserDefaults.standard.data(forKey: "leo.paperclip.status.v1." + reference.id) {
            pendingStatus = try? JSONDecoder().decode(PaperclipStatusExpectation.self, from: data)
        }
        // 只转发影响页面结构的低频变化（运行列表、权限、日志展开）；进度与日志片段由运行卡片自行观察，
        // 不再让整页随每条实时片段重绘。
        forwardRunStream = Publishers.Merge3(runStream.$liveRuns.map { _ in () },
                                             runStream.$telemetryForbidden.map { _ in () },
                                             runStream.$expandedLogRunIDs.map { _ in () })
            .dropFirst(3)
            .sink { [weak self] in self?.objectWillChange.send() }
    }

    var liveOpen: Bool { liveState == .open }

    func threadEntries(activeRunIDs: Set<String>) -> [PaperclipThreadEntry] {
        if let cache = threadCache, cache.activeRunIDs == activeRunIDs { return cache.entries }
        let entries = PaperclipThread.entries(comments: comments, runs: runs, activeRunIDs: activeRunIDs)
        threadCache = (activeRunIDs, entries)
        return entries
    }

    func changeStatus(_ expected: PaperclipStatusExpectation) async {
        guard !busy, pendingStatus == nil else { return }
        busy = true
        pendingStatus = expected
        if let data = try? JSONEncoder().encode(expected) { UserDefaults.standard.set(data, forKey: statusKey) }
        do {
            issue = try await client.setStatus(reference, status: expected.status, unblockAction: expected.unblockAction)
            pendingStatus = nil; UserDefaults.standard.removeObject(forKey: statusKey); error = nil
        } catch {
            record(error)
            if error as? PaperclipError != .uncertain { pendingStatus = nil; UserDefaults.standard.removeObject(forKey: statusKey) }
        }
        busy = false
    }
    func acknowledgeStatus() {
        guard !busy, let pendingStatus else { return }
        if let data = try? JSONEncoder().encode(pendingStatus) { UserDefaults.standard.set(data, forKey: statusKey + ".lastChecked") }
        self.pendingStatus = nil; UserDefaults.standard.removeObject(forKey: statusKey)
        error = nil
    }
    func verifyStatus() async {
        guard !busy, let expected = pendingStatus, expected.userID == reference.userID else { return }
        busy = true; defer { busy = false }
        do {
            let current = try await client.issue(reference)
            issue = current
            guard expected.matches(current) else { throw PaperclipError.statusNotConfirmed }
            pendingStatus = nil; UserDefaults.standard.removeObject(forKey: statusKey); error = nil
        } catch { record(error) }
    }

    /// [A6] 恢复（回到前台、实时通道重连）后的只读核对：状态写入未知时自动核实一次（失败仍保持待核实、
    /// 不重发）；回复草稿由视图对照刚补拉的评论核对。
    func reconcileAfterRecovery() async {
        if pendingStatus != nil, !busy { await verifyStatus() }
        recoveryChecks += 1
    }

    /// 只读刷新：任务、评论、运行、审批、运行中 run 五个请求并行，各自独立更新，
    /// 一个失败不连累其他（以前串行，任一失败整次作废）。评论默认按最后一条增量读取。
    func refresh(full: Bool = false) async {
        guard !syncing else { queuedRefresh = (queuedRefresh ?? false) || full; return }
        syncing = true
        defer { syncing = false }
        var nextFull = full
        while true {
            await performRefresh(full: nextFull)
            guard let queued = queuedRefresh, !Task.isCancelled else { break }
            queuedRefresh = nil
            nextFull = queued
        }
    }

    private func performRefresh(full: Bool) async {
        let client = client, reference = reference, runStream = runStream
        let stamp = epoch
        let after = full ? nil : comments.last?.id
        let started = Date()
        async let issueResult = Self.capture { try await client.issue(reference) }
        async let commentResult = Self.capture { try await client.comments(reference, after: after) }
        async let runResult = Self.capture { try await client.runs(reference) }
        async let approvalResult = Self.capture { try await client.approvals(reference) }
        async let liveResult = Self.capture { try await runStream.reloadLiveRuns() }
        let (nextIssue, nextComments, nextRuns, nextApprovals, nextLive) =
            await (issueResult, commentResult, runResult, approvalResult, liveResult)
        guard !Task.isCancelled, stamp == epoch else { return }
        lastHeavyPoll = started
        var failure: Error?
        switch nextIssue {
        case .success(let value): issue = value
        case .failure(let error): failure = error
        }
        switch nextComments {
        case .success(let rows): applyComments(rows, after: after, fetchStarted: started)
        case .failure(let error): failure = failure ?? error
        }
        switch nextRuns {
        case .success(let rows): runs = rows
        case .failure(let error): failure = failure ?? Self.significant(error)
        }
        switch nextApprovals {
        case .success(let rows): approvals = rows
        case .failure(let error): failure = failure ?? Self.significant(error)
        }
        if case .failure(let error) = nextLive { failure = failure ?? error }
        if let failure { record(failure) } else { error = nil; lastRefreshed = Date() }
    }

    /// 周期轮询：评论增量合并，每 8 轮全量校准一次（反映编辑与删除）；无实时通道时补拉展开的日志。
    /// 无实时通道且运行中（3 秒节奏）时，两次全量之间只读评论增量与运行中 run：
    /// 以前每 3 秒并发 5 个请求（任务、评论、运行、审批、运行中），约 100 次/分钟。
    func poll(now: Date = Date()) async {
        if !liveOpen, runStream.hasActiveRun, now.timeIntervalSince(lastHeavyPoll) < PaperclipPollingPolicy.baseInterval {
            await lightRefresh()
        } else {
            pollCount += 1
            await refresh(full: pollCount.isMultiple(of: 8))
        }
        if !liveOpen { await runStream.refreshExpandedLogs() }
    }

    /// 轻量刷新：评论增量 + 运行中 run；运行集合变化（结束或新开始）时补读运行历史与任务状态。
    private func lightRefresh() async {
        guard !syncing else { return }
        syncing = true
        defer { syncing = false }
        let client = client, reference = reference, runStream = runStream
        let stamp = epoch
        let after = comments.last?.id
        let started = Date()
        let before = Set(runStream.activeRuns.map(\.id))
        async let commentResult = Self.capture { try await client.comments(reference, after: after) }
        async let liveResult = Self.capture { try await runStream.reloadLiveRuns() }
        let (nextComments, nextLive) = await (commentResult, liveResult)
        guard !Task.isCancelled, stamp == epoch else { return }
        var failure: Error?
        switch nextComments {
        case .success(let rows): applyComments(rows, after: after, fetchStarted: started)
        case .failure(let error): failure = error
        }
        if case .failure(let error) = nextLive { failure = failure ?? error }
        if let failure { record(failure); return }
        if Set(runStream.activeRuns.map(\.id)) != before {
            await reloadIssue(if: true)
            await reloadRuns(if: true, includeLive: false)
        }
        error = nil; lastRefreshed = Date()
    }

    /// 增量结果按 id 合并；全量结果替换，但保留读取开始之后本机插入、全量里还没有的评论（刚发出的回复）。
    private func applyComments(_ rows: [PaperclipComment], after: String?, fetchStarted: Date) {
        if after != nil {
            let known = Set(comments.map(\.id))
            for row in rows where !known.contains(row.id) { localInsertions[row.id] = Date() }
            comments = PaperclipCommentMerge.merge(comments, rows)
            return
        }
        let fetched = Set(rows.map(\.id))
        let newer = comments.filter { !fetched.contains($0.id) && (localInsertions[$0.id] ?? .distantPast) >= fetchStarted }
        localInsertions = localInsertions.filter { $0.value >= fetchStarted }
        comments = rows + newer
    }

    /// 回复成功后立即显示，不等下一轮同步。
    func appendSent(_ comment: PaperclipComment) {
        localInsertions[comment.id] = Date()
        comments = PaperclipCommentMerge.merge(comments, [comment])
    }

    private static func capture<T>(_ work: @MainActor () async throws -> T) async -> Result<T, Error> {
        do { return .success(try await work()) } catch { return .failure(error) }
    }

    /// 运行与审批需要额外权限：403 只是不显示，不算同步失败。
    private static func significant(_ error: Error) -> Error? {
        (error as? PaperclipError)?.underlying == .forbidden ? nil : error
    }

    func record(_ error: Error) {
        self.error = PaperclipLabels.error(error)
        // 预检包装的登录过期/身份变化同样要清掉旧账号内容。
        let reason = (error as? PaperclipError)?.underlying
        if reason == .signedOut || reason == .identityChanged {
            epoch += 1
            issue = nil; comments = []; runs = []; approvals = []
            localInsertions = [:]
            runStream.reset()
            detachLive()
        }
    }

    // MARK: 实时通道

    /// 只接入同一配置、公司、用户的公司级通道；事件已在通道内校验公司。
    func attach(_ live: PaperclipLiveConnection?) {
        guard let live, live.matches(reference) else { detachLive(); return }
        guard attachedLive != ObjectIdentifier(live) else { return }
        detachLive()
        attachedLive = ObjectIdentifier(live)
        live.$state.sink { [weak self] state in self?.liveState = state }.store(in: &liveSubscriptions)
        live.events.sink { [weak self] event in self?.handle(event) }.store(in: &liveSubscriptions)
        live.reconnected.sink { [weak self] in
            // 服务器不重放断线期间的事件：每次连上都全量补拉，再自动核对未知结果的写入。
            Task {
                await self?.refresh(full: true)
                await self?.reconcileAfterRecovery()
            }
        }.store(in: &liveSubscriptions)
    }

    func detachLive() {
        liveSubscriptions.removeAll()
        attachedLive = nil
        liveState = nil
        followupTask?.cancel(); followupTask = nil
        followups = []
    }

    func handle(_ event: PaperclipLiveEvent) {
        let next = runStream.handle(event)
        guard !next.isEmpty else { return }
        followups.formUnion(next)
        scheduleFollowups()
    }

    /// 事件触发的补拉合并执行（300ms 内的事件只发一次请求）；写请求进行中则稍后再做。
    private func scheduleFollowups() {
        guard followupTask == nil else { return }
        followupTask = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .milliseconds(300))
            guard let self, !Task.isCancelled else { return }
            while self.busy {
                try? await Task.sleep(for: .milliseconds(500))
                if Task.isCancelled { return }
            }
            let work = self.followups
            self.followups = []
            self.followupTask = nil
            await self.perform(work)
        }
    }

    private func perform(_ work: Set<PaperclipRunStream.Followup>) async {
        // 各项补拉并行、互不连累。
        async let issueDone: Void = reloadIssue(if: work.contains(.issue))
        async let commentsDone: Void = reloadComments(if: work.contains(.comments) || work.contains(.fullComments),
                                                      full: work.contains(.fullComments))
        async let runsDone: Void = reloadRuns(if: work.contains(.runs))
        async let approvalsDone: Void = reloadApprovals(if: work.contains(.approvals))
        _ = await (issueDone, commentsDone, runsDone, approvalsDone)
    }

    // 事件补拉：每个结果写回前核对代际，身份失效后迟到的结果不写回。
    private func reloadIssue(if needed: Bool) async {
        guard needed else { return }
        let stamp = epoch
        do {
            let value = try await client.issue(reference)
            if stamp == epoch { issue = value }
        } catch { if stamp == epoch { recordIfIdentity(error) } }
    }

    private func reloadComments(if needed: Bool, full: Bool) async {
        guard needed else { return }
        let stamp = epoch
        let after = full ? nil : comments.last?.id
        let started = Date()
        do {
            let rows = try await client.comments(reference, after: after)
            if stamp == epoch { applyComments(rows, after: after, fetchStarted: started) }
        } catch { if stamp == epoch { recordIfIdentity(error) } }
    }

    private func reloadRuns(if needed: Bool, includeLive: Bool = true) async {
        guard needed else { return }
        let stamp = epoch
        do {
            let rows = try await client.runs(reference)
            if stamp == epoch { runs = rows }
        } catch { if stamp == epoch { recordIfIdentity(error) } }
        guard includeLive, stamp == epoch else { return }
        do { try await runStream.reloadLiveRuns() } catch { if stamp == epoch { recordIfIdentity(error) } }
    }

    private func reloadApprovals(if needed: Bool) async {
        guard needed else { return }
        let stamp = epoch
        do {
            let rows = try await client.approvals(reference)
            if stamp == epoch { approvals = rows }
        } catch { if stamp == epoch { recordIfIdentity(error) } }
    }

    /// 事件补拉失败只处理身份类错误；网络抖动交给下一轮同步，不打断阅读。
    private func recordIfIdentity(_ error: Error) {
        let reason = (error as? PaperclipError)?.underlying
        if reason == .signedOut || reason == .identityChanged { record(error) }
    }
}

struct PaperclipIssueDetailView: View {
    @StateObject private var model: PaperclipIssueDetailModel
    @State private var draft: PaperclipDraft
    @State private var decisionNote = ""
    @State private var statusDecision: PaperclipIssueStatus?
    @State private var pendingDecision: Decision?
    @State private var discardReply = false
    @State private var acknowledgeStatus = false
    @State private var lastChecked: PaperclipDraft?
    @State private var visible = false
    @State private var details = false
    @State private var logRun: PaperclipRun?
    @State private var positionedConversation = false
    @State private var revealID: String?
    /// [A6] 已提示过"服务器上还没有这条回复"的请求编号，每条草稿只提示一次。
    @State private var announcedMissingReply: UUID?
    /// 用户停在底部时，新消息、运行进度到达会自动跟随；往上翻阅时不打扰。
    @State private var nearBottom = true
    @State private var saveTask: Task<Void, Never>?
    @FocusState private var editingReply: Bool
    @FocusState private var editingDecision: Bool
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    private let draftKey: String
    private let agents: [PaperclipAgent]
    private let live: PaperclipLiveConnection?
    private let userLabel: String?
    // 只用于审批决定。状态修改走 PaperclipStatusDecisionSheet → changeStatus 的 pendingStatus 状态机。
    private struct Decision: Identifiable {
        let id = UUID()
        let approval: PaperclipApproval
        let approve: Bool
        var title: String { approve ? "确认批准此请求？" : "确认拒绝此请求？" }
    }

    init(client: PaperclipClient, reference: PaperclipTaskReference, agents: [PaperclipAgent] = [],
         live: PaperclipLiveConnection? = nil, userLabel: String? = nil) {
        _model = StateObject(wrappedValue: PaperclipIssueDetailModel(client: client, reference: reference))
        let key = PaperclipDraft.key(profile: client.profile, companyID: reference.companyID, userID: reference.userID, issueID: reference.issueID)
        draftKey = key
        self.agents = agents
        self.live = live
        self.userLabel = userLabel
        _draft = State(initialValue: PaperclipDraft.load(key: key))
        _lastChecked = State(initialValue: PaperclipDraft.lastChecked(key: key))
    }

    private var stream: PaperclipRunStream { model.runStream }

    private func agent(_ id: String?) -> PaperclipAgent? {
        guard let id else { return nil }
        return agents.first { $0.id == id }
    }

    /// 运行中卡片：优先用 live-runs（带进度与头像），没有遥测权限时用 runs 中仍在运行的记录。
    private var activeRuns: [PaperclipActiveRunDisplay] {
        let origin = model.client.profile.origin
        var result = stream.activeRuns.map { run in
            PaperclipActiveRunDisplay(id: run.id, status: run.status, agentID: run.agentId,
                agentName: run.agentName ?? agent(run.agentId)?.name ?? "智能体",
                avatarPath: PaperclipAvatarPath.normalized(run.avatarUrl ?? agent(run.agentId)?.avatarUrl, origin: origin),
                startedAt: PaperclipDates.parse(run.startedAt ?? run.createdAt))
        }
        let known = Set(result.map(\.id))
        for run in model.runs where run.isActive && !known.contains(run.runId) && (stream.telemetryForbidden || stream.liveRuns.isEmpty) {
            result.append(PaperclipActiveRunDisplay(id: run.runId, status: run.status, agentID: run.agentId,
                agentName: agent(run.agentId)?.name ?? "智能体",
                avatarPath: PaperclipAvatarPath.normalized(agent(run.agentId)?.avatarUrl, origin: origin),
                startedAt: PaperclipDates.parse(run.startedAt ?? run.createdAt)))
        }
        return result
    }

    var body: some View {
        // 每次重绘只计算一次运行中卡片（以前一次重绘里重复计算五六次，每次都解析头像地址与时间）。
        let active = activeRuns
        return ScrollViewReader { proxy in
            conversation(active: active, proxy: proxy)
            .background(LeoTheme.ColorToken.background)
            .safeAreaInset(edge: .bottom, spacing: 0) { if model.issue != nil { replySection(active: active) } }
            .navigationTitle(model.issue?.identifier ?? "任务对话")
            .navigationBarTitleDisplayMode(.inline)
            .scrollDismissesKeyboard(.interactively)
            .onAppear { visible = true; model.attach(live) }
            .task(id: live.map(ObjectIdentifier.init)) { model.attach(live) }
            .toolbar { toolbar }
            .sheet(isPresented: $details) { propertiesPanel }
            .sheet(item: $statusDecision) { status in PaperclipStatusDecisionSheet(model: model, selected: status) }
            .sheet(item: $logRun) { run in
                NavigationStack {
                    PaperclipRunLogPage(stream: stream, run: run, agentName: agent(run.agentId)?.name ?? "智能体",
                                        livePush: { [model = model] in model.liveOpen })
                }
            }
            .refreshable { await model.refresh(full: true) }
            .task(id: scenePhase) { await pollLoop() }
            .onDisappear {
                visible = false
                let pending = saveTask != nil
                saveTask?.cancel(); saveTask = nil
                if pending || !draft.body.isEmpty { draft.save(key: draftKey) }
            }
            .onChange(of: draft.body) { _, _ in scheduleDraftSave() }
            // [A6] 未知结果的回复：评论到达（含实时推送）时静默确认；恢复后的核对没找到才提示一次。
            .onChange(of: model.comments) { _, _ in reconcileReply(announceMissing: false) }
            .onChange(of: model.recoveryChecks) { _, _ in reconcileReply(announceMissing: true) }
            .alert(item: Binding(get: { details ? nil : pendingDecision }, set: { pendingDecision = $0 })) { decisionAlert($0) }
            .confirmationDialog("解除只保存人工核对记录，不会撤销或重发服务器操作", isPresented: $acknowledgeStatus, titleVisibility: .visible) {
                Button("已核对，解除待核实状态", role: .destructive) { model.acknowledgeStatus() }
                Button("取消" as String, role: .cancel) {}
            }
            .confirmationDialog("放弃草稿不会撤销服务器可能已接收的回复", isPresented: $discardReply, titleVisibility: .visible) {
                Button("已核对，解除待提交状态", role: .destructive) {
                    draft.archive(key: draftKey)
                    lastChecked = draft
                    draft = PaperclipDraft()
                    model.error = nil
                }
                Button("取消" as String, role: .cancel) {}
            } message: { Text("回复可能已经在服务器生效，请先核对。解除只保存本机核对记录，不会重新发送。") }
        }
    }

    /// 对话滚动区与自动跟随逻辑（从 body 拆出，避免类型检查超时）。
    private func conversation(active: [PaperclipActiveRunDisplay], proxy: ScrollViewProxy) -> some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                thread(active: active, proxy: proxy)
                Color.clear.frame(height: 1).id("paperclip.latest")
            }
            .padding(.horizontal, LeoTheme.Spacing.md)
            // 输入栏通过 safeAreaInset 计入滚动安全区（随其实际高度与键盘变化）；再留出呼吸空间，最后一张卡片不贴着输入栏。
            .padding(.bottom, LeoTheme.Spacing.lg)
            .frame(maxWidth: 760)
            .frame(maxWidth: .infinity)
        }
        .onScrollGeometryChange(for: Bool.self) { geometry in
            PaperclipScrollPosition.isNearBottom(offsetY: geometry.contentOffset.y, containerHeight: geometry.containerSize.height,
                                                 bottomInset: geometry.contentInsets.bottom, contentHeight: geometry.contentSize.height)
        } action: { _, value in nearBottom = value }
        .onChange(of: model.issue?.id) { _, _ in revealConversation(using: proxy) }
        // 新评论只追加在末尾：比较最后一条与条数，不再每次重绘复制全部 id。
        .onChange(of: model.comments.last?.id) { _, _ in revealConversation(using: proxy) }
        .onChange(of: model.comments.count) { _, _ in revealConversation(using: proxy) }
        .onChange(of: revealID) { _, _ in revealConversation(using: proxy) }
        .onChange(of: active.map(\.id)) { old, ids in
            // 新运行开始时滚到运行卡片；只针对新出现的运行，且仅当用户停在底部（往上翻阅时不打扰）。
            if let id = ids.last(where: { !old.contains($0) }), nearBottom || !positionedConversation {
                revealID = "run-card-" + id
            }
        }
        .onChange(of: editingReply) { _, focused in
            // 键盘弹出会缩小可见区：原本停在底部时，待键盘动画结束后跟随到底，最后一条不被输入栏遮住。
            guard focused, nearBottom, positionedConversation else { return }
            Task { @MainActor in
                try? await Task.sleep(for: .milliseconds(350))
                followLatest(proxy)
            }
        }
    }

    /// 前台时：立即刷新一次（以前先睡 15 秒），然后按节奏轮询。
    /// 只在写请求进行中暂停；输入框聚焦、面板打开都不再暂停只读刷新。
    private func pollLoop() async {
        guard scenePhase == .active else { return }
        await model.refresh(full: true)
        await model.reconcileAfterRecovery()
        var lastPoll = Date()
        var failureInterval: Double?
        while !Task.isCancelled {
            do { try await Task.sleep(for: .seconds(1)) } catch { return }
            // 每秒检查一次节奏：实时通道断开或运行开始时，立即切到更快的轮询。
            let interval = failureInterval ?? PaperclipPollingPolicy.detailInterval(liveOpen: model.liveOpen, runActive: !activeRuns.isEmpty)
            guard Date().timeIntervalSince(lastPoll) >= interval else { continue }
            guard PaperclipPollingPolicy.canRefresh(active: visible, mutating: model.busy) else { continue }
            await model.poll()
            lastPoll = Date()
            // 失败指数退避（上限 2 分钟），成功复位。
            failureInterval = model.error == nil ? nil : PaperclipPollingPolicy.nextInterval(after: failureInterval ?? interval, succeeded: false)
        }
    }

    // MARK: 线程

    @ViewBuilder private func thread(active activeRuns: [PaperclipActiveRunDisplay], proxy: ScrollViewProxy) -> some View {
        if let issue = model.issue {
            let entries = model.threadEntries(activeRunIDs: Set(activeRuns.map(\.id)))
            PaperclipIssueHeader(issue: issue, assignee: agent(issue.assigneeAgentId), client: model.client,
                                 liveState: model.liveState, runActive: !activeRuns.isEmpty)
                .padding(.bottom, LeoTheme.Spacing.md)
            if let error = model.error {
                PaperclipNotice(text: error, actionTitle: "重新同步") { Task { await model.refresh(full: true) } }
                    .padding(.bottom, LeoTheme.Spacing.sm)
            }
            if let expected = model.pendingStatus {
                PaperclipNotice(text: "状态改为「\(expected.status.title)」的结果待核实，可在属性面板核对。", systemImage: "questionmark.circle.fill",
                                actionTitle: "核实") { Task { await model.verifyStatus() } }
                    .padding(.bottom, LeoTheme.Spacing.sm)
            }
            if let description = issue.description, !description.isEmpty {
                PaperclipDescriptionCard(text: description).padding(.bottom, LeoTheme.Spacing.lg)
            }
            if model.comments.isEmpty && activeRuns.isEmpty && entries.isEmpty {
                emptyThread
            }
            ForEach(entries) { entry in
                entryView(entry)
            }
            ForEach(activeRuns) { run in
                PaperclipLiveRunCard(stream: stream, run: run, client: model.client) {
                    if positionedConversation && nearBottom { followLatest(proxy) }
                }
                    .id("run-card-" + run.id)
                    .padding(.top, LeoTheme.Spacing.sm)
                    .padding(.bottom, LeoTheme.Spacing.md)
                    .transition(.opacity.combined(with: .scale(scale: 0.98)))
            }
            ForEach(model.approvals) { approval in
                Group {
                    if approval.status == "pending" {
                        PaperclipApprovalCard(approval: approval, requester: requester(approval), note: $decisionNote,
                                              noteFocus: $editingDecision, busy: model.busy) { approve in
                            let decision = Decision(approval: approval, approve: approve)
                            // [A5] 全自动下一点即提交;提交后照常做指纹重读与回执核对(见 client.resolve)。
                            if PaperclipFullAuto.needsDecisionConfirmation(fullAuto: PaperclipFullAuto.isOn) {
                                pendingDecision = decision
                            } else {
                                Task { await apply(decision) }
                            }
                        }
                    } else {
                        PaperclipResolvedApprovalRow(approval: approval)
                    }
                }
                .padding(.vertical, LeoTheme.Spacing.xs)
            }
        } else if model.error != nil {
            PaperclipNotice(text: model.error ?? "", actionTitle: "重新同步") { Task { await model.refresh(full: true) } }
                .padding(.top, LeoTheme.Spacing.md)
        } else {
            HStack(spacing: 10) {
                ProgressView()
                Text("正在加载任务…").foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity)
            .padding(.top, 80)
        }
    }

    private var emptyThread: some View {
        VStack(spacing: 8) {
            Image(systemName: "bubble.left.and.text.bubble.right").font(.title2).foregroundStyle(.tertiary)
            Text("还没有对话消息").font(.subheadline.weight(.medium)).foregroundStyle(.secondary)
            Text("智能体开始处理后，过程与回复会实时出现在这里。").font(.footnote).foregroundStyle(.tertiary)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, LeoTheme.Spacing.xl)
    }

    @ViewBuilder private func entryView(_ entry: PaperclipThreadEntry) -> some View {
        switch entry {
        case .comment(let comment, let header, let footer):
            let isAgent = PaperclipThread.authorKey(comment).hasPrefix("agent:") && !(comment.authorAgentId ?? "").isEmpty
            Group {
                if isAgent {
                    PaperclipAgentMessage(comment: comment, agent: agent(comment.authorAgentId), client: model.client, showsHeader: header)
                } else {
                    PaperclipHumanMessage(comment: comment, mine: comment.authorUserId == model.reference.userID, showsFooter: footer)
                }
            }
            .padding(.top, header ? LeoTheme.Spacing.md : LeoTheme.Spacing.xs)
            .padding(.bottom, footer ? LeoTheme.Spacing.xs : 0)
            .transition(.opacity.combined(with: .move(edge: .bottom)))
        case .run(let run):
            Button { logRun = run } label: {
                PaperclipRunSummaryRow(run: run, agentName: agent(run.agentId)?.name ?? "智能体")
            }
            .buttonStyle(.plain)
            .padding(.vertical, LeoTheme.Spacing.xs)
        }
    }

    private func requester(_ approval: PaperclipApproval) -> String {
        if let id = approval.requestedByAgentId { return agent(id)?.name ?? "智能体" }
        if approval.requestedByUserId == model.reference.userID { return userLabel ?? "我" }
        return approval.requestedByUserId == nil ? "未提供" : "团队成员"
    }

    private func revealConversation(using proxy: ScrollViewProxy) {
        if let id = revealID {
            let exists = model.comments.contains(where: { $0.id == id }) || id.hasPrefix("run-card-")
            guard exists else { return }
            if reduceMotion { proxy.scrollTo(id, anchor: .bottom) }
            else { withAnimation(.easeOut(duration: 0.25)) { proxy.scrollTo(id, anchor: .bottom) } }
            revealID = nil
            positionedConversation = true
        } else if !positionedConversation && model.issue != nil {
            proxy.scrollTo("paperclip.latest", anchor: .bottom)
            positionedConversation = true
        } else if positionedConversation && nearBottom {
            followLatest(proxy)
        }
    }

    private func followLatest(_ proxy: ScrollViewProxy) {
        if reduceMotion { proxy.scrollTo("paperclip.latest", anchor: .bottom) }
        else { withAnimation(.easeOut(duration: 0.25)) { proxy.scrollTo("paperclip.latest", anchor: .bottom) } }
    }

    private func decisionAlert(_ decision: Decision) -> Alert {
        Alert(title: Text(decision.title), message: Text("请先阅读完整审批内容。此决定将以当前人类用户身份发送到绑定的服务器。"),
              primaryButton: .default(Text("确认")) { Task { await apply(decision) } }, secondaryButton: .cancel(Text(verbatim: "取消")))
    }

    // MARK: 工具栏与属性面板

    @ToolbarContentBuilder private var toolbar: some ToolbarContent {
        ToolbarItemGroup(placement: .topBarTrailing) {
            Button { details = true } label: { Image(systemName: "info.circle") }
                .accessibilityLabel(Text("任务属性与运行历史"))
                .accessibilityIdentifier("paperclip.properties")
            Menu {
                if model.pendingStatus != nil { Button("核实状态（不会重新发送）") { Task { await model.verifyStatus() } }.disabled(model.busy) }
                Button("刷新消息", systemImage: "arrow.clockwise") { Task { await model.refresh(full: true) } }
                if let issue = model.issue {
                    if model.pendingStatus != nil {
                        // 嵌套系统 Menu 的 disabled 状态不能作为待核实写入的入口边界。
                        Button("更改任务状态") {}.disabled(true)
                    } else {
                        Menu("更改任务状态") {
                            ForEach(PaperclipIssueStatus.allCases) { status in
                                Button(status.title) {
                                    guard !model.busy, model.pendingStatus == nil else { return }
                                    statusDecision = status
                                }.disabled(status.rawValue == issue.status)
                            }
                        }.disabled(model.busy)
                    }
                }
            } label: { Image(systemName: "ellipsis.circle") }
            .accessibilityLabel("任务操作").accessibilityIdentifier("paperclip.taskActions")
        }
    }

    private var propertiesPanel: some View {
        NavigationStack {
            List {
                if let issue = model.issue {
                    Section("属性") {
                        LabeledContent("状态") { PaperclipStatusCapsule(status: issue.status) }
                        LabeledContent("优先级", value: PaperclipLabels.priority(issue.priority))
                        LabeledContent("负责人") {
                            if let assignee = agent(issue.assigneeAgentId) {
                                HStack(spacing: 6) {
                                    PaperclipAvatar(client: model.client, path: PaperclipAvatarPath.normalized(assignee.avatarUrl, origin: model.client.profile.origin), name: assignee.name, size: 20)
                                    Text(assignee.name)
                                }
                            } else { Text("未分配") }
                        }
                        if let updated = PaperclipTimeText.short(issue.updatedAt) { LabeledContent("更新时间", value: updated) }
                    }
                }
                if let expected = model.pendingStatus {
                    Section("状态结果待核实") {
                        Text("原目标：\(expected.status.title)")
                        if let action = expected.unblockAction { Text(action) }
                        Button("核实状态（不会重新发送）") { Task { await model.verifyStatus() } }.disabled(model.busy)
                        Button("已人工核对，解除待核实状态") { acknowledgeStatus = true }.disabled(model.busy)
                    }
                }
                Section("运行历史") {
                    if model.runs.isEmpty { Text("尚无运行记录。任务已创建不代表智能体已经开始执行。").foregroundStyle(.secondary) }
                    ForEach(model.runs.sorted { ($0.createdAt ?? $0.startedAt ?? "") > ($1.createdAt ?? $1.startedAt ?? "") }) { run in
                        NavigationLink {
                            PaperclipRunLogPage(stream: stream, run: run, agentName: agent(run.agentId)?.name ?? "智能体",
                                                livePush: { [model = model] in model.liveOpen })
                        } label: {
                            HStack(spacing: 10) {
                                Circle().fill(PaperclipStatusStyle.color(run.status)).frame(width: 8, height: 8)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(PaperclipLabels.status(run.status)).font(.subheadline.weight(.medium))
                                    Text([agent(run.agentId)?.name, PaperclipTimeText.short(run.startedAt ?? run.createdAt)].compactMap { $0 }.joined(separator: " · "))
                                        .font(.caption).foregroundStyle(.secondary)
                                    if let reason = PaperclipLabels.runError(run.errorCode), run.status != "succeeded" {
                                        Text(reason).font(.caption).foregroundStyle(PaperclipStatusStyle.color(run.status))
                                    }
                                }
                            }
                        }
                    }
                }
                Section("服务器") {
                    LabeledContent("配置", value: model.client.profile.name)
                    Text(model.reference.origin.absoluteString).font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
                    if let date = model.lastRefreshed {
                        LabeledContent("最近同步", value: date.formatted(date: .omitted, time: .standard))
                    }
                }
                if let lastChecked { Section { PaperclipCheckedDraftView(draft: lastChecked) } }
            }
            .navigationTitle("任务属性").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("完成") { details = false } } }
            .alert(item: $pendingDecision) { decisionAlert($0) }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
    }

    // MARK: 输入栏

    /// 每次按键写 UserDefaults 太频繁：停顿 0.5 秒后保存；离开页面、提交前仍立即保存。
    private func scheduleDraftSave() {
        saveTask?.cancel()
        saveTask = Task { @MainActor in
            do { try await Task.sleep(for: .milliseconds(500)) } catch { return }
            draft.save(key: draftKey)
            saveTask = nil
        }
    }

    private func replySection(active activeRuns: [PaperclipActiveRunDisplay]) -> some View {
        PaperclipComposerBar(
            text: $draft.body, focus: $editingReply,
            placeholder: activeRuns.isEmpty ? "回复任务或补充要求…" : "补充要求，智能体会在对话中看到…",
            fieldIdentifier: "paperclip.replyBody", sendIdentifier: "paperclip.sendReply",
            sendLabel: draft.submitted ? "重试同一回复" : "发送到服务器",
            busy: model.busy,
            canSend: !model.busy && model.pendingStatus == nil && !draft.body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
            retry: draft.submitted,
            // 只读刷新可能在输入时完成，它从不改写草稿；只锁定已提交/结果未知的写入。
            fieldDisabled: draft.submitted || model.pendingStatus != nil,
            onSend: { Task { await reply() } }
        ) {
            if draft.submitted {
                HStack(spacing: 8) {
                    PaperclipChip(title: "上次回复待核对", systemImage: "clock.badge.questionmark", tint: LeoTheme.ColorToken.warning)
                    Spacer(minLength: 0)
                    Button("已核对，解除草稿锁定") { discardReply = true }
                        .font(.footnote.weight(.semibold)).disabled(model.busy)
                }
            } else if !activeRuns.isEmpty {
                PaperclipChip(title: "执行中也可继续发送，会追加到对话", systemImage: "text.bubble", tint: .secondary)
                    .accessibilityIdentifier("paperclip.appendHint")
            }
        }
    }

    private func reply() async {
        guard !model.busy, model.pendingStatus == nil else { return }
        saveTask?.cancel(); saveTask = nil
        // 发送即收起键盘，让线程立即可见（输入框在请求期间锁定，聚焦会被系统保留在禁用的输入框上）；
        // 只有服务器明确拒绝、草稿可编辑时才恢复焦点。
        editingReply = false
        model.busy = true
        let wasPreviouslySubmitted = draft.submitted
        draft.markSubmitted()
        draft.save(key: draftKey)
        let submitted = draft
        let outcome: PaperclipSendOutcome
        do {
            let sent = try await model.client.reply(model.reference, body: submitted.body, requestID: submitted.requestID)
            guard draft.requestID == submitted.requestID, draft.body == submitted.body else { model.busy = false; return }
            draft = PaperclipDraft()
            PaperclipDraft.clear(key: draftKey)
            model.error = nil
            model.appendSent(sent)
            revealID = sent.id
            outcome = .sent
            LeoHaptics.notification(.success)
        } catch {
            draft.recordFailure(error, wasPreviouslySubmitted: wasPreviouslySubmitted)
            draft.save(key: draftKey)
            model.record(error)
            outcome = PaperclipSendOutcome.failure(draftAfterFailure: draft)
            LeoHaptics.notification(.error)
        }
        // 发送成功后保持收起：以前焦点一直留在输入框，界面停在发送前的样子。
        editingReply = outcome.keepsComposerFocus
        model.busy = false
        if outcome == .sent { await model.refresh() }
    }

    /// [A6] 复用只读核对：已写入就解锁草稿；没找到保持锁定，不自动重发。
    private func reconcileReply(announceMissing: Bool) {
        switch PaperclipReplyCheck.check(draft, comments: model.comments, userID: model.reference.userID) {
        case .notPending: break
        case .confirmed:
            saveTask?.cancel(); saveTask = nil
            draft = PaperclipDraft()
            PaperclipDraft.clear(key: draftKey)
            model.error = nil
            announcedMissingReply = nil
        case .notFound:
            guard announceMissing, announcedMissingReply != draft.requestID else { return }
            announcedMissingReply = draft.requestID
            model.error = "上次回复在服务器上还没找到，草稿保持锁定，没有重新发送。确认没送到后可点「重试同一回复」（不会重复）。"
        }
    }

    private func apply(_ decision: Decision) async {
        guard !model.busy else { return }
        model.busy = true
        editingDecision = false
        do {
            _ = try await model.client.resolve(model.reference, approval: decision.approval, approve: decision.approve, note: decisionNote)
            decisionNote = ""
            model.error = nil
            LeoHaptics.notification(.success)
        } catch { model.record(error); model.busy = false; return }
        model.busy = false
        await model.refresh()
    }
}

private struct PaperclipStatusDecisionSheet: View {
    @ObservedObject var model: PaperclipIssueDetailModel
    let selected: PaperclipIssueStatus
    @State private var action = ""
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        NavigationStack {
            Form {
                Section { Text("将任务设为「\(selected.title)」？") }
                if selected == .blocked {
                    Section("解除受阻所需操作（可不填）") {
                        TextField("不填默认「\(PaperclipUnblockAction.defaultAction)」", text: $action, axis: .vertical).lineLimit(3...6)
                            .accessibilityIdentifier("paperclip.unblockAction")
                        Text("责任人是当前登录用户；不填就记为「\(PaperclipUnblockAction.defaultAction)」。最多 2000 个字符。")
                            .font(.footnote).foregroundStyle(.secondary)
                    }
                }
                if let error = model.error { Text(error).foregroundStyle(.red) }
                Button("确认更改状态") {
                    Task {
                        do {
                            let expected = try PaperclipStatusExpectation(status: selected, userID: model.reference.userID, unblockAction: action)
                            await model.changeStatus(expected)
                            if model.pendingStatus != nil || model.error == nil { dismiss() }
                        } catch { model.record(error) }
                    }
                }.disabled(model.busy || (selected == .blocked && PaperclipUnblockAction.resolved(action) == nil))
            }.navigationTitle("确认状态")
                .toolbar { ToolbarItem(placement: .cancellationAction) { Button("取消" as String) { dismiss() }.disabled(model.busy) } }
        }
    }
}

/// 单次运行的日志页：解析后的可读文本；运行中自动增量拉取并滚到底部。
private struct PaperclipRunLogPage: View {
    @ObservedObject var stream: PaperclipRunStream
    let run: PaperclipRun
    let agentName: String
    /// 实时通道是否在推送日志片段；推送时不再每 3 秒请求 REST。
    let livePush: () -> Bool

    private var active: Bool { stream.activeRuns.contains { $0.id == run.runId } }
    private var duration: String? {
        guard let start = PaperclipDates.parse(run.startedAt), let end = PaperclipDates.parse(run.finishedAt) else { return nil }
        return PaperclipDates.duration(end.timeIntervalSince(start))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 8) {
                PaperclipStatusCapsule(status: active ? "running" : run.status)
                Text(agentName).font(.subheadline.weight(.medium))
                if let duration { Text("耗时 \(duration)").font(.caption).foregroundStyle(.secondary) }
                Spacer(minLength: 0)
            }
            if run.status != "succeeded", let reason = PaperclipLabels.runError(run.errorCode) {
                PaperclipNotice(text: reason, systemImage: "exclamationmark.octagon.fill", tint: PaperclipStatusStyle.color(run.status))
            }
            PaperclipLogConsole(log: stream.logs[run.runId], live: active)
            if stream.logs[run.runId]?.hasMore == true {
                Button("继续读取更多日志") { Task { await stream.loadLog(runID: run.runId) } }
                    .font(.footnote.weight(.semibold))
                    .disabled(stream.logs[run.runId]?.loading == true)
            }
        }
        .padding(LeoTheme.Spacing.md)
        .frame(maxWidth: 760)
        .frame(maxWidth: .infinity)
        .navigationTitle("运行日志")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            Button { Task { await stream.loadLog(runID: run.runId) } } label: { Image(systemName: "arrow.clockwise") }
                .accessibilityLabel(Text("刷新日志"))
                .disabled(stream.logs[run.runId]?.loading == true)
        }
        .task {
            if stream.logs[run.runId]?.restOffset == nil { await stream.loadLog(runID: run.runId) }
            // 运行中每 3 秒增量拉取；实时通道已连接时片段由事件推送（缺序或截断自动补齐），不再重复请求。
            while active && !Task.isCancelled {
                do { try await Task.sleep(for: .seconds(PaperclipPollingPolicy.activeRunInterval)) } catch { return }
                if !livePush() { await stream.loadLog(runID: run.runId) }
            }
        }
    }
}
