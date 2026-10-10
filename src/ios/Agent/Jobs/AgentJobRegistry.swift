import Foundation

private let logger = AppLogger(category: "AgentJobRegistry")

// [T-subagent] Ported from upstream iOS 1.14 `AgentJobRegistry`, reduced to the
// sub agent producer (LeoBot has its own scheduled-task runner, so upstream's
// `minis-scheduled` triggers / cron / insurance notifications are not ported).
//
// The single in-process registry for every running sub agent. Deliberately NOT
// persisted: the app being killed empties it. A delegation the process lost is
// recognised afterwards from the parent's persisted tool_result (status
// "running" with no job behind it) and can be resumed (`action=resume`).

enum AgentJobState: String {
    case pending, running, done, cancelled, failed
    /// The wall-clock budget elapsed and the run was cut short.
    case timeout
}

/// What happens when a job's run finishes.
enum AgentJobThen: Equatable {
    /// Wait mode: the result returns as the tool call's own result.
    case none
    /// Background mode: post an `<agent_callback>` into the parent as a new turn.
    case followUpParent
}

/// Static facts about one delegation, snapshotted at start so a rename or
/// delete of the definition never rewrites an in-flight job.
struct SubAgentRunConfig {
    let parentSessionId: String
    let parentToolUseId: String
    let jobId: String
    let title: String
    let maxTurns: Int
    var subAgentId: String = SubAgentDefinition.builtInId
    var subAgentName: String = SubAgentDefinition.builtInName
    var instructions: String = ""
}

@MainActor
final class AgentJob: Identifiable {
    let id: String
    let title: String
    let parentSessionId: String
    let parentToolUseId: String
    let prompt: String?
    var then: AgentJobThen

    private(set) var state: AgentJobState = .pending
    /// The child session once created.
    var runSessionId: String?
    /// Strong reference to the child's view model for the life of the job, so
    /// a cache eviction can never orphan a running loop.
    var child: AIChatViewModel?
    var modelOrigin: String?
    var subAgentName: String?
    var missedSteers: [String] = []
    var wasResumed = false
    /// Set when the USER stopped this job (or its whole turn): its result must
    /// not drive the parent conversation on.
    var muted = false
    /// Set when the parent model cancelled it through `action=cancel`.
    var cancelledByParentModel = false
    var modelIdentity: HelperModelIdentity?
    var task: Task<Void, Never>?
    /// Producer hook run by `finish` before `then` (background helpers write
    /// the final JSON into the parent's tool block with it).
    var completionHook: ((AgentJob) -> Void)?
    var summaryLine: String?
    let createdAt = Date()
    private(set) var startedAt: Date?
    private(set) var finishedAt: Date?
    private(set) var resultText: String?

    fileprivate init(id: String, title: String, parentSessionId: String, parentToolUseId: String,
                     prompt: String?, then: AgentJobThen) {
        self.id = id
        self.title = title
        self.parentSessionId = parentSessionId
        self.parentToolUseId = parentToolUseId
        self.prompt = prompt
        self.then = then
    }

    fileprivate func markRunning(sessionId: String) {
        state = .running
        startedAt = startedAt ?? Date()
        runSessionId = sessionId
    }

    fileprivate func markFinished(_ final: AgentJobState, result: String?) {
        state = final
        finishedAt = Date()
        resultText = result
        task?.cancel()
        task = nil
    }

    var isActive: Bool { state == .running || state == .pending }

    /// Running far past any budget it could have been given. Used only to
    /// stop a wedged job from pinning the composer to Stop.
    var looksStuck: Bool {
        guard isActive else { return false }
        return Date().timeIntervalSince(startedAt ?? createdAt) > SubAgentLimits.stuckAfter
    }

    var elapsed: TimeInterval? {
        guard let s = startedAt else { return nil }
        return (finishedAt ?? Date()).timeIntervalSince(s)
    }

    /// Identity and shape only, never the title (it is the user's task text).
    var logLabel: String {
        "job \(id.prefix(8)) parent=\(parentSessionId.prefix(8)) state=\(state.rawValue)"
    }
}

@MainActor
final class AgentJobRegistry: ObservableObject {
    static let shared = AgentJobRegistry()

    /// A delegation that arrived while all slots were busy. Stored as the
    /// original tool arguments: a queued run re-resolves the definition, model
    /// and limits against the state true when it actually starts.
    struct QueuedDelegation {
        let parentSessionId: String
        let args: [String: Any]
        let toolUseId: String
        let queuedAt = Date()
    }

    @Published private(set) var jobs: [String: AgentJob] = [:]
    @Published private(set) var queuedDelegations: [QueuedDelegation] = []
    private var jobBySession: [String: String] = [:]
    private var loopEndObserver: Any?

    private init() {
        // A child view model is never the one on screen, so every child loop
        // end posts this — the backstop that closes a background job whose
        // watcher did not.
        loopEndObserver = NotificationCenter.default.addObserver(
            forName: .sessionAgentLoopDidEnd, object: nil, queue: .main
        ) { [weak self] note in
            guard let sid = note.object as? String else { return }
            Task { @MainActor [weak self] in self?.sessionLoopDidEnd(sid) }
        }
    }

    // MARK: - Register / query

    func register(title: String, parentSessionId: String, parentToolUseId: String,
                  prompt: String?, then: AgentJobThen) -> AgentJob {
        let job = AgentJob(id: UUID().uuidString, title: title, parentSessionId: parentSessionId,
                           parentToolUseId: parentToolUseId, prompt: prompt, then: then)
        jobs[job.id] = job
        logger.info("[Jobs] REGISTER \(job.logLabel) then=\(String(describing: then))")
        return job
    }

    func job(id: String) -> AgentJob? { jobs[id] }

    func list() -> [AgentJob] { jobs.values.sorted { $0.createdAt > $1.createdAt } }

    func activeChildren(parent parentSessionId: String) -> [AgentJob] {
        jobs.values.filter { $0.parentSessionId == parentSessionId && $0.isActive }
            .sorted { $0.createdAt < $1.createdAt }
    }

    func job(forChild childSessionId: String) -> AgentJob? {
        jobs.values.first { $0.runSessionId == childSessionId && $0.isActive }
    }

    func isJobAlive(childSessionId: String) -> Bool { job(forChild: childSessionId) != nil }

    /// True while `parent` still has a sub agent working or waiting for a slot.
    func hasActiveChildren(parent parentSessionId: String) -> Bool {
        if queuedCount(parent: parentSessionId) > 0 { return true }
        return jobs.values.contains { $0.parentSessionId == parentSessionId && $0.isActive && !$0.looksStuck }
    }

    /// How many of `parent`'s children have a loop turn running RIGHT NOW. The
    /// full-auto source rule counts a child as an agent turn only then.
    func runningChildTurns(parent parentSessionId: String) -> Int {
        jobs.values.filter {
            $0.parentSessionId == parentSessionId && $0.state == .running && ($0.child?.isProcessing ?? false)
        }.count
    }

    /// The cache must keep these view models resident.
    func pinsSession(_ sessionId: String) -> Bool {
        if hasActiveChildren(parent: sessionId) { return true }
        return jobs.values.contains { $0.runSessionId == sessionId && $0.isActive }
    }

    /// Pending jobs count too: a delegation holds its slot from registration
    /// (before its child session exists) so parallel calls cannot overshoot.
    var runningChildJobCount: Int { jobs.values.filter { $0.isActive }.count }

    var slots: SubAgentSlots { SubAgentSlots(running: runningChildJobCount, queued: queuedDelegations.count) }

    var canStartChildJob: Bool { slots.canStart }

    // MARK: - Queue

    func isQueued(toolUseId: String) -> Bool { queuedDelegations.contains { $0.toolUseId == toolUseId } }

    func queuedCount(parent parentSessionId: String) -> Int {
        queuedDelegations.filter { $0.parentSessionId == parentSessionId }.count
    }

    func enqueueDelegation(_ item: QueuedDelegation) -> Bool {
        guard queuedDelegations.count < SubAgentLimits.maxQueuedDelegations else {
            logger.warning("[Jobs] delegation queue full — refusing \(item.toolUseId.prefix(12))")
            return false
        }
        queuedDelegations.append(item)
        logger.info("[Jobs] QUEUED delegation tool=\(item.toolUseId.prefix(12)) depth=\(self.queuedDelegations.count)")
        return true
    }

    func dropQueuedDelegations(parent parentSessionId: String, reason: String) {
        let before = queuedDelegations.count
        queuedDelegations.removeAll { $0.parentSessionId == parentSessionId }
        if before != queuedDelegations.count {
            logger.info("[Jobs] dropped \(before - self.queuedDelegations.count) queued delegation(s) for \(parentSessionId.prefix(8)) — \(reason)")
        }
    }

    /// Start queued delegations while slots are free (one per call; the run it
    /// starts registers asynchronously, and its finish drains again).
    func drainQueuedDelegations() {
        guard canStartChildJob, let next = queuedDelegations.first else { return }
        queuedDelegations.removeFirst()
        guard let parent = ViewModelCache.shared.get(for: next.parentSessionId) else {
            logger.warning("[Jobs] queued delegation dropped — parent \(next.parentSessionId.prefix(8)) is gone")
            drainQueuedDelegations()
            return
        }
        let item = next
        logger.info("[Jobs] STARTING queued delegation tool=\(item.toolUseId.prefix(12)) waited=\(Int(Date().timeIntervalSince(item.queuedAt)))s")
        Task { @MainActor in
            guard await ChatStore.shared.sessionExists(id: item.parentSessionId) else { return }
            _ = await parent.startQueuedSubAgent(args: item.args, toolUseId: item.toolUseId)
        }
    }

    // MARK: - Lifecycle

    func markRunning(_ jobId: String, sessionId: String) {
        guard let job = jobs[jobId] else { return }
        job.markRunning(sessionId: sessionId)
        jobBySession[sessionId] = jobId
        logger.info("[Jobs] RUNNING \(job.logLabel) child=\(sessionId.prefix(8))")
    }

    /// Close a job with its final state, run its completion hook and `then`,
    /// and start whatever was queued. Idempotent.
    func finish(_ jobId: String, state final: AgentJobState, result: String?) {
        guard let job = jobs[jobId], job.isActive else { return }
        if let child = job.child, !child.subAgentState.pendingSteerMessages.isEmpty {
            // A steer the child never reached must be reported, not dropped.
            job.missedSteers = child.subAgentState.pendingSteerMessages
            child.subAgentState.pendingSteerMessages.removeAll()
        }
        job.markFinished(final, result: result)
        if let sid = job.runSessionId {
            jobBySession[sid] = nil
            // The child's model binding / inference config only matter while
            // it runs (a resume re-resolves them); keep the provider config lean.
            ProviderConfigStore.shared.forgetSession(sid)
        }
        if let child = job.child {
            job.modelIdentity?.merge(EffectiveModelRecord.make(entryId: child.keepAliveEntry?.id ?? ""))
            child.subAgentState.config = nil
            child.browserTabPool.releaseAllTabs()
        }
        logger.info("[Jobs] FINISH \(job.logLabel) elapsed=\(Int(job.elapsed ?? 0))s result=\(result?.count ?? 0)ch")
        job.completionHook?(job)
        job.completionHook = nil
        job.child = nil
        // [B24] The result is in the parent's block now: drop the child's VM
        // (render state + cache entry) instead of keeping a finished
        // transcript resident. Skipped while it is on screen or still busy.
        if let sid = job.runSessionId {
            ViewModelCache.shared.releaseIfIdle(sessionId: sid, reason: "sub agent finished")
        }
        runThen(for: job)
        drainQueuedDelegations()
        pruneFinished()
    }

    /// Cancel one job. `silent` drops the parent callback (the USER stopped it:
    /// Stop means the conversation goes quiet).
    func cancel(jobId: String, reason: String, silent: Bool = false) {
        guard let job = jobs[jobId], job.isActive else { return }
        logger.info("[Jobs] CANCEL \(job.logLabel) reason=\(reason)\(silent ? " (silent)" : "")")
        if silent {
            job.muted = true
            job.then = .none
        }
        if let child = job.child, child.isProcessing {
            // Cancels the child's turn Task, which also invalidates any approval
            // it is waiting on (SensitiveToolGate's cancellation handler).
            child.cancel(queuePolicy: .discardQueuedPrompts)
        }
        finish(jobId, state: .cancelled, result: nil)
    }

    /// Cascade: the parent conversation was stopped or deleted.
    func cancelAll(parent parentSessionId: String, reason: String, silent: Bool) {
        dropQueuedDelegations(parent: parentSessionId, reason: reason)
        for job in activeChildren(parent: parentSessionId) {
            cancel(jobId: job.id, reason: reason, silent: silent)
        }
    }

    /// Stopping one agent's card stops every sibling of the same parent (a
    /// fanned-out turn the user stopped must not keep reporting in), silently,
    /// and drops what was still queued behind them. Returns the count.
    @discardableResult
    func cancelSiblings(ofChild childSessionId: String, reason: String) -> Int {
        guard let parent = jobs.values.first(where: { $0.runSessionId == childSessionId })?.parentSessionId else {
            return 0
        }
        // Drop the backlog FIRST: cancelling a job drains the queue.
        dropQueuedDelegations(parent: parent, reason: reason)
        let targets = activeChildren(parent: parent)
        for job in targets { cancel(jobId: job.id, reason: reason, silent: true) }
        return targets.count
    }

    /// Drop terminal jobs so the map does not grow without bound.
    func pruneFinished(olderThan age: TimeInterval = 3600) {
        let cutoff = Date().addingTimeInterval(-age)
        for (id, job) in jobs where !job.isActive {
            if (job.finishedAt ?? job.createdAt) < cutoff { jobs[id] = nil }
        }
    }

    // MARK: - Loop end → job end

    private func sessionLoopDidEnd(_ sessionId: String) {
        guard let jobId = jobBySession[sessionId], let job = jobs[jobId], job.state == .running,
              job.then == .followUpParent else { return }
        // The background watcher normally closes the job; this is the backstop.
        // A steer that arrived between turns restarts the child instead.
        if let child = job.child, !child.subAgentState.pendingSteerMessages.isEmpty, !child.isProcessing {
            _ = child.submitSubAgentPrompt(SubAgentText.steerNudge)
            return
        }
        Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 1_500_000_000)
            guard let self, let job = self.jobs[jobId], job.state == .running,
                  !(job.child?.isProcessing ?? false) else { return }
            let text = await Self.lastAssistantText(sessionId: sessionId)
            let cancelled = job.child?.userDidCancel ?? false
            self.finish(jobId, state: cancelled ? .cancelled : .done, result: text)
        }
    }

    /// Last assistant text from the DB — the flushed truth.
    static func lastAssistantText(sessionId: String) async -> String? {
        let raws = await ChatStore.shared.loadMessages(sessionId: sessionId)
        func text(of raw: RawMessage) -> String {
            raw.parts.compactMap { part -> String? in
                if case .text(let t) = part { return t }
                return nil
            }.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
        }
        let assistants = raws.filter { $0.role == .assistant }
        guard let last = assistants.last else { return nil }
        let final = text(of: last)
        if !final.isEmpty { return final }
        guard let earlier = assistants.dropLast().reversed().map(text(of:)).first(where: { !$0.isEmpty }) else { return nil }
        return "(The agent did not write a final answer; this is its last message before the run ended.)\n" + earlier
    }

    // MARK: - then

    private func runThen(for job: AgentJob) {
        guard job.then == .followUpParent, !job.muted else { return }
        let parent = job.parentSessionId
        let result: String = {
            let r = job.resultText ?? ""
            return r.isEmpty ? SubAgentText.emptyResultNote(status: job.state.rawValue) : r
        }()
        let payload = Self.completionCallback(for: job, result: result).xml
        let jobId = job.id
        Task { @MainActor in
            // A parent deleted while its agent ran must not be resurrected.
            guard await ChatStore.shared.sessionExists(id: parent) else {
                logger.warning("[Jobs] callback \(jobId.prefix(8)) dropped — parent is gone")
                return
            }
            let (vm, fresh) = ViewModelCache.shared.getOrCreate(for: parent)
            if fresh { await vm.loadSession() }
            // Checked at delivery time: the stop can land during this hop.
            guard SubAgentOutcome.mayDriveParent(parentCancelled: false,
                                                 jobMuted: self.jobs[jobId]?.muted ?? false) else {
                logger.info("[Jobs] callback \(jobId.prefix(8)) dropped — stopped by the user")
                return
            }
            let outcome = vm.submitSubAgentCallback(payload)
            logger.info("[Jobs] callback \(jobId.prefix(8)) → parent \(parent.prefix(8)) outcome=\(outcome)")
        }
    }

    /// One sentence about the OTHER sub agents of `parentSessionId`.
    static func siblingSummary(parentSessionId: String, excluding jobId: String) -> String? {
        var running = 0, queued = 0
        for j in AgentJobRegistry.shared.jobs.values where j.id != jobId && j.parentSessionId == parentSessionId {
            switch j.state {
            case .running: running += 1
            case .pending: queued += 1
            default: break
            }
        }
        queued += AgentJobRegistry.shared.queuedCount(parent: parentSessionId)
        var parts: [String] = []
        if running > 0 { parts.append("\(running) still running") }
        if queued > 0 { parts.append("\(queued) queued") }
        guard !parts.isEmpty else { return nil }
        return "Other sub agents in this conversation: " + parts.joined(separator: ", ") + "."
    }

    static func completionCallback(for job: AgentJob, result: String) -> AgentCallback {
        let loopStatus = job.state == .done ? "completed" : job.state.rawValue
        let status = SubAgentOutcome.resolvedStatus(loopStatus, result: job.resultText ?? "")
        return AgentCallback(kind: .finished,
                             jobId: job.id,
                             childSessionId: job.runSessionId,
                             title: job.title,
                             status: status == "completed" ? "done" : status,
                             tier: job.modelOrigin,
                             elapsed: elapsedClock(job.elapsed),
                             summary: job.summaryLine,
                             body: result,
                             siblings: siblingSummary(parentSessionId: job.parentSessionId, excluding: job.id),
                             modelIdentity: job.modelIdentity,
                             agent: job.subAgentName)
    }

    static func elapsedClock(_ e: TimeInterval?) -> String? {
        guard let e else { return nil }
        let s = Int(e)
        return s >= 60 ? "\(s / 60)m\(String(format: "%02d", s % 60))s" : "\(s)s"
    }

    /// The child-session title (not shown in any list — children are hidden —
    /// but kept readable for the transcript sheet and diagnostics).
    nonisolated static func childSessionTitle(_ title: String, subAgentName: String?) -> String {
        if let name = subAgentName?.trimmingCharacters(in: .whitespacesAndNewlines), !name.isEmpty {
            return "子代理 · \(name) · \(title)"
        }
        return "子代理 · \(title)"
    }
}
