import Combine
import Foundation

/// 任务详情页的运行模型：运行中的 run、进度（当前工具、最近输出）与解析后的实时日志。
/// 事件驱动（WebSocket）为主，没有实时通道时由详情页轮询 live-runs 与日志增量。
@MainActor
final class PaperclipRunStream: ObservableObject {
    struct LogState: Equatable {
        var parser = PaperclipRunLogParser()
        /// 已从 REST 读到的字节偏移；nil 表示尚未读取。
        var restOffset: Int?
        /// 追加实时日志前的 REST 快照；REST 补齐时回到快照再写入，避免与实时片段重复。
        var restSnapshot: PaperclipRunLogParser?
        var lastSeq: Int?
        var loading = false
        var error: String?
        /// 本次读取因分段上限停止，服务器还有更多内容。
        var hasMore = false
        /// restSnapshot 之后追加的实时片段（带 seq）；REST 补齐后据 seq 重放尚未包含的部分。
        var liveTail: [LiveChunk] = []
        /// 日志接口 404：运行尚未产生日志或日志已被清理。不是错误，不再显示状态码。
        var missing = false
    }

    struct LiveChunk: Equatable {
        let seq: Int?
        let chunk: String
        let stream: String?
    }

    /// 需要由详情页执行的补拉。
    enum Followup: Hashable { case runs, issue, comments, fullComments, approvals }

    let client: PaperclipClient
    let reference: PaperclipTaskReference
    @Published private(set) var liveRuns: [PaperclipLiveRun] = []
    @Published private(set) var progress: [String: PaperclipRunProgress] = [:]
    @Published private(set) var logs: [String: LogState] = [:]
    /// 账号没有运行遥测权限（403）：只显示评论与运行历史，不再请求。
    @Published private(set) var telemetryForbidden = false
    @Published var expandedLogRunIDs: Set<String> = []
    private var resyncTasks: [String: Task<Void, Never>] = [:]
    /// reset() 时递增；迟到的网络结果发现代际变化即丢弃，不把旧账号数据写回。
    private var generation = 0

    init(client: PaperclipClient, reference: PaperclipTaskReference) {
        self.client = client
        self.reference = reference
    }

    var activeRuns: [PaperclipLiveRun] { liveRuns.filter(\.isActive) }
    var hasActiveRun: Bool { liveRuns.contains(where: \.isActive) }

    func reset() {
        generation += 1
        for task in resyncTasks.values { task.cancel() }
        resyncTasks = [:]
        liveRuns = []; progress = [:]; logs = [:]; expandedLogRunIDs = []
    }

    /// 重新读取运行中的 run。身份类错误抛给详情页统一处理；403 降级为只显示评论。
    func reloadLiveRuns() async throws {
        guard !telemetryForbidden else { return }
        let stamp = generation
        do {
            let rows = try await client.liveRuns(reference)
            guard stamp == generation else { return }
            apply(rows)
        } catch let error as PaperclipError {
            guard stamp == generation else { return }
            switch error.underlying {
            case .forbidden: telemetryForbidden = true; liveRuns = []
            case .signedOut, .identityChanged: throw error
            default: break // 网络抖动：保留上次结果，下一轮再试。
            }
        }
    }

    /// 合并 live-runs 结果；事件带来的进度更新更新时不被较旧的接口快照覆盖。
    func apply(_ rows: [PaperclipLiveRun]) {
        let wasActive = Set(activeRuns.map(\.id))
        liveRuns = rows.sorted { ($0.createdAt ?? "") < ($1.createdAt ?? "") }
        var next: [String: PaperclipRunProgress] = [:]
        for row in rows where row.isActive {
            var merged = row.progress
            if let existing = progress[row.id] {
                if (existing.lastEventAt ?? "") > (row.lastEventAt ?? "") { merged = existing }
                else { merged.phase = existing.phase; if merged.currentToolName == nil { merged.currentToolName = existing.currentToolName } }
            }
            next[row.id] = merged
        }
        progress = next
        // 结束的运行做一次最终日志补齐（已展开时）。
        for id in wasActive.subtracting(Set(activeRuns.map(\.id))) where expandedLogRunIDs.contains(id) {
            scheduleResync(id)
        }
    }

    /// 处理一条已通过公司校验的事件，返回需要详情页补拉的内容。
    @discardableResult
    func handle(_ event: PaperclipLiveEvent) -> Set<Followup> {
        switch event.type {
        case "heartbeat.run.progress", "heartbeat.run.event":
            guard event.issueID == reference.issueID, let runID = event.runID else { return [] }
            var value = progress[runID] ?? PaperclipRunProgress()
            value.apply(event)
            progress[runID] = value
            // 尚未知道的运行（刚开始）：补拉 live-runs 拿到智能体与开始时间。
            return liveRuns.contains(where: { $0.id == runID }) ? [] : [.runs]
        case "heartbeat.run.queued", "heartbeat.run.status":
            guard event.issueID == reference.issueID else { return [] }
            return [.runs, .issue]
        case "heartbeat.run.log":
            guard event.issueID == reference.issueID, let runID = event.runID else { return [] }
            appendLiveLog(runID: runID, event: event)
            return liveRuns.contains(where: { $0.id == runID }) ? [] : [.runs]
        case "activity.logged":
            let entityType = event.string("entityType")
            let action = event.string("action") ?? ""
            if entityType == "issue", event.string("entityId") == reference.issueID {
                if action.contains("comment") {
                    // 删除、撤回只能通过全量读取反映。
                    let full = action.hasSuffix("deleted") || action.hasSuffix("cancelled")
                    return [full ? .fullComments : .comments, .issue]
                }
                return action.hasPrefix("issue.approval") ? [.issue, .approvals] : [.issue]
            }
            if entityType == "approval" || action.hasPrefix("approval.") { return [.approvals] }
            return []
        default:
            return []
        }
    }

    /// 实时日志：序号连续且未截断时直接追加；截断或缺序时用 log?offset 补齐。
    /// 日志面板未展开（尚未读取过）时忽略，展开时再从接口读取尾部。
    private func appendLiveLog(runID: String, event: PaperclipLiveEvent) {
        guard var state = logs[runID], state.restOffset != nil else { return }
        let seq = event.int("seq")
        // 修复重复：服务器先写日志再推事件，REST 读取可能已包含这条片段；seq 不大于已读最大序号即丢弃。
        if let seq, let restSeq = (state.restSnapshot ?? state.parser).maxSeq, seq <= restSeq { return }
        let truncated = event.bool("truncated") ?? false
        if truncated || (seq != nil && state.lastSeq != nil && seq != state.lastSeq.map { $0 &+ 1 }) {
            if let seq { state.lastSeq = seq }
            logs[runID] = state
            scheduleResync(runID)
            return
        }
        if state.restSnapshot == nil { state.restSnapshot = state.parser; state.liveTail = [] }
        let chunk = LiveChunk(seq: seq, chunk: event.string("chunk") ?? "", stream: event.string("stream"))
        state.parser.appendChunk(chunk.chunk, stream: chunk.stream)
        state.liveTail.append(chunk)
        if let seq { state.lastSeq = seq }
        logs[runID] = state
    }

    /// REST 补齐后重放尚未包含在读取内容中的实时片段（seq 大于已读最大序号）。
    /// 修复丢失：读取进行中到达的片段若晚于服务器读取时刻，以前会被 REST 结果整体覆盖、直到运行结束才出现。
    /// 旧服务器记录不带 seq 时无法判断，沿用原行为（以 REST 为准）。
    static func reconcile(_ fetched: PaperclipRunLogParser, liveTail: [LiveChunk])
        -> (parser: PaperclipRunLogParser, snapshot: PaperclipRunLogParser?, tail: [LiveChunk], lastSeq: Int?) {
        guard let restSeq = fetched.maxSeq else { return (fetched, nil, [], nil) }
        let pending = liveTail.filter { ($0.seq ?? Int.min) > restSeq }
        guard !pending.isEmpty else { return (fetched, nil, [], restSeq) }
        var parser = fetched
        for chunk in pending { parser.appendChunk(chunk.chunk, stream: chunk.stream) }
        return (parser, fetched, pending, max(restSeq, pending.compactMap(\.seq).max() ?? restSeq))
    }

    private func scheduleResync(_ runID: String) {
        guard resyncTasks[runID] == nil else { return }
        resyncTasks[runID] = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .milliseconds(400))
            guard let self, !Task.isCancelled else { return }
            self.resyncTasks[runID] = nil
            await self.loadLog(runID: runID)
        }
    }

    /// 读取日志增量（首次从尾部 64KB 开始），每次最多 4 段，解析为可读文本。
    func loadLog(runID: String) async {
        var state = logs[runID] ?? LogState()
        guard !state.loading else { return }
        let stamp = generation
        state.loading = true
        logs[runID] = state
        var offset: Int
        var startsMidRecord = false
        if let rest = state.restOffset { offset = rest }
        else {
            let bytes = liveRuns.first(where: { $0.id == runID })?.logBytes ?? 0
            offset = max(0, bytes - 64_000)
            startsMidRecord = offset > 0
        }
        // 回到 REST 快照：实时追加的片段会包含在接下来读取的内容里。
        var parser = state.restSnapshot ?? state.parser
        var hasMore = false
        do {
            var pages = 0
            while pages < 4 {
                let chunk = try await client.runLog(reference, runID: runID, offset: offset)
                guard stamp == generation else { return }
                parser.feedNDJSON(chunk.content, startsMidRecord: startsMidRecord && pages == 0)
                pages += 1
                // 游标已在客户端校验(给出时不倒退、有内容必前进)。上游读到末尾时省略 nextOffset:
                // 这一页从 offset 读到了文件尾,下次从 offset + 本页字节数接着读。
                guard let next = chunk.nextOffset, next > offset else {
                    if chunk.nextOffset == nil { offset += chunk.content.utf8.count }
                    hasMore = false
                    break
                }
                offset = next
                hasMore = true
            }
            if !hasActiveRun || !liveRuns.contains(where: { $0.id == runID && $0.isActive }) { parser.flush() }
            state = logs[runID] ?? state
            let merged = Self.reconcile(parser, liveTail: state.liveTail)
            state.parser = merged.parser
            state.restSnapshot = merged.snapshot
            state.liveTail = merged.tail
            if let seq = merged.lastSeq { state.lastSeq = max(state.lastSeq ?? seq, seq) }
            state.restOffset = offset
            state.hasMore = hasMore
            state.error = nil
            state.missing = false
        } catch {
            // reset() 之后迟到的失败同样不写回。
            guard stamp == generation else { return }
            state = logs[runID] ?? state
            let reason = (error as? PaperclipError)?.underlying
            if reason == .http(404) {
                // 日志接口 404：运行尚未开始输出或日志已清理。降级为“暂无日志”，从头接收实时片段，运行中轮询会再试。
                state.missing = true
                state.error = nil
                if state.restOffset == nil { state.restOffset = 0 }
            } else {
                state.error = reason == .forbidden ? "当前账号没有查看运行日志的权限。" : PaperclipLabels.error(error)
            }
        }
        state.loading = false
        logs[runID] = state
    }

    /// 轮询路径：没有实时通道时，为已展开的运行拉取日志增量。
    func refreshExpandedLogs() async {
        let active = Set(activeRuns.map(\.id))
        for runID in expandedLogRunIDs where active.contains(runID) && logs[runID]?.restOffset != nil {
            await loadLog(runID: runID)
        }
    }

    func toggleLog(_ runID: String) {
        if expandedLogRunIDs.contains(runID) { expandedLogRunIDs.remove(runID); return }
        expandedLogRunIDs.insert(runID)
        if logs[runID]?.restOffset == nil { Task { await loadLog(runID: runID) } }
    }
}
