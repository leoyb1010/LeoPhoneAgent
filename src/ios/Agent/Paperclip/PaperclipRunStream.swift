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

    init(client: PaperclipClient, reference: PaperclipTaskReference) {
        self.client = client
        self.reference = reference
    }

    var activeRuns: [PaperclipLiveRun] { liveRuns.filter(\.isActive) }
    var hasActiveRun: Bool { liveRuns.contains(where: \.isActive) }

    func reset() {
        for task in resyncTasks.values { task.cancel() }
        resyncTasks = [:]
        liveRuns = []; progress = [:]; logs = [:]; expandedLogRunIDs = []
    }

    /// 重新读取运行中的 run。身份类错误抛给详情页统一处理；403 降级为只显示评论。
    func reloadLiveRuns() async throws {
        guard !telemetryForbidden else { return }
        do {
            let rows = try await client.liveRuns(reference)
            apply(rows)
        } catch let error as PaperclipError {
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
        let truncated = event.bool("truncated") ?? false
        if truncated || (seq != nil && state.lastSeq != nil && seq != state.lastSeq! + 1) {
            if let seq { state.lastSeq = seq }
            logs[runID] = state
            scheduleResync(runID)
            return
        }
        if state.restSnapshot == nil { state.restSnapshot = state.parser }
        state.parser.appendChunk(event.string("chunk") ?? "", stream: event.string("stream"))
        if let seq { state.lastSeq = seq }
        logs[runID] = state
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
                parser.feedNDJSON(chunk.content, startsMidRecord: startsMidRecord && pages == 0)
                pages += 1
                guard let next = chunk.nextOffset, next > offset else {
                    offset += chunk.content.utf8.count
                    hasMore = false
                    break
                }
                offset = next
                hasMore = true
            }
            if !hasActiveRun || !liveRuns.contains(where: { $0.id == runID && $0.isActive }) { parser.flush() }
            state = logs[runID] ?? state
            state.parser = parser
            state.restSnapshot = nil
            state.restOffset = offset
            state.hasMore = hasMore
            state.error = nil
        } catch {
            state = logs[runID] ?? state
            let reason = (error as? PaperclipError)?.underlying
            state.error = reason == .forbidden ? "当前账号没有查看运行日志的权限。" : PaperclipLabels.error(error)
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
