import Combine
import Foundation

private let logger = AppLogger(category: "HelperRunner")

// [T-subagent] The `subagent_task` tool, ported from upstream iOS 1.14
// `HelperRunner.swift` and adapted to LeoBot:
//   · delegate — hidden child session (depth 1), its own agent loop running
//     concurrently with the parent; `wait=true` blocks the parent turn and
//     returns the result as this tool call's result, otherwise the result
//     arrives later as an `<agent_callback>` user message
//     (`AgentJobRegistry.runThen`); the user speaking mid-wait moves the run
//     to the background;
//   · status / steer / cancel — inspect, course-correct or stop this
//     conversation's sub agents;
//   · resume — restart runs the previous process lost.
//
// The parent block's `content` always holds the JSON payload of the call (a
// running payload while it runs, the final payload after). The UI parses it;
// the live part (elapsed, current tool) comes from the registry and tracker.

extension AIChatViewModel {

    // MARK: - Entry point

    func executeSubAgentTask(args: [String: Any], toolUseId: String,
                             msgIdx: Int, blockIdx: Int) async -> (output: String, success: Bool) {
        switch SubAgentTool.Action.parse(args["action"]) {
        case .delegate:
            return await executeSubAgentDelegate(args: args, toolUseId: toolUseId,
                                                 msgIdx: msgIdx, blockIdx: blockIdx, fromQueue: false)
        case .status, .steer, .cancel:
            let r = executeSubAgentControl(args: args)
            writeSubAgentBlock(toolUseId: toolUseId, content: r.output)
            return r
        case .resume:
            let r = await executeResumeSubAgents(args: args)
            writeSubAgentBlock(toolUseId: toolUseId, content: r.output)
            return r
        }
    }

    /// Start a delegation that waited for a slot. Its tool call returned
    /// `status: queued` long ago, so it reports through the callback.
    @discardableResult
    func startQueuedSubAgent(args: [String: Any], toolUseId: String) async -> Bool {
        if let childId = args["__resume_child"] as? String {
            return await resumeInterruptedSubAgent(childSessionId: childId) == nil
        }
        guard let (m, b) = subAgentBlockIndices(toolUseId: toolUseId) else {
            logger.warning("[subagent] queued start abandoned — block \(toolUseId.prefix(12)) is gone")
            return false
        }
        var forced = args
        forced["wait"] = false
        let r = await executeSubAgentDelegate(args: forced, toolUseId: toolUseId, msgIdx: m, blockIdx: b, fromQueue: true)
        return r.success
    }

    // MARK: - Delegate

    private func executeSubAgentDelegate(args: [String: Any], toolUseId: String,
                                         msgIdx: Int, blockIdx: Int,
                                         fromQueue: Bool) async -> (output: String, success: Bool) {
        let a = SubAgentDelegateArgs(args)

        func reject(_ reason: String, _ detail: String) -> (String, Bool) {
            let json = SubAgentRecovery.jsonString(["ok": false, "status": "rejected", "reason": reason, "detail": detail])
            logger.warning("[subagent] REJECTED \(reason)")
            writeSubAgentBlock(toolUseId: toolUseId, content: json)
            return (json, false)
        }

        if let r = SubAgentRejection.precheck(task: a.task, isChild: isSubAgentChild, hasSession: sessionId != nil,
                                              isRemote: remoteDeviceId != nil, enabled: SubAgentSettings.isEnabled) {
            return reject(r.rawValue, r.detail)
        }
        guard let parentSid = sessionId else {
            return reject(SubAgentRejection.noParentSession.rawValue, SubAgentRejection.noParentSession.detail)
        }

        // Position of this call among the delegations of THIS assistant
        // message: past the per-turn allowance it queues instead of starting.
        var position: Int?
        if !fromQueue, msgIdx < messages.count {
            let delegates = messages[msgIdx].blocks.enumerated().filter { _, b in
                guard case .delegateTool = b.kind else { return false }
                return SubAgentTool.Action.parse(Self.subAgentInputArgs(b)["action"]) == .delegate
            }
            position = delegates.firstIndex { $0.offset == blockIdx }
        }
        // Resolved before admission (synchronous) so the slot check and the
        // job registration below happen without an await in between: parallel
        // delegations of one turn cannot all pass the check and overshoot.
        let roster = SubAgentStore.shared.subAgents
        guard let subAgent = SubAgentRoster.resolve(name: a.agent, in: roster) else {
            return reject("unknown_agent", "No sub agent named \"\(a.agent ?? "")\". Available: \(roster.map(\.name).joined(separator: ", ")). Omit `agent` to use the general one.")
        }
        guard let resolution = SubAgentModelResolver.resolve(subAgent: subAgent, parent: self,
                                                             choice: SubAgentModelChoice.parse(a.modelChoice)) else {
            return reject("no_model", "No model is configured for a sub agent to run on.")
        }
        let registry = AgentJobRegistry.shared
        switch registry.slots.admit(positionInTurn: position) {
        case .refuse:
            return reject(SubAgentRejection.queueFull.rawValue, SubAgentRejection.queueFull.detail)
        case .queue:
            guard registry.enqueueDelegation(.init(parentSessionId: parentSid, args: args, toolUseId: toolUseId)) else {
                return reject(SubAgentRejection.queueFull.rawValue, SubAgentRejection.queueFull.detail)
            }
            let json = SubAgentRecovery.jsonString([
                "ok": true, "status": "queued", "title": a.displayTitle,
                "detail": "All \(SubAgentLimits.maxConcurrentChildJobs) slots are busy (or more than \(SubAgentLimits.maxPerAssistantTurn) delegations were made in one turn). This task is QUEUED and starts automatically; its result arrives as a new message. Do not re-delegate it.",
            ])
            writeSubAgentBlock(toolUseId: toolUseId, content: json)
            return (json, true)
        case .start:
            break
        }
        // Holds the slot from here on (a pending job counts as active).
        let job = registry.register(title: a.displayTitle, parentSessionId: parentSid, parentToolUseId: toolUseId,
                                    prompt: a.task, then: a.wait ? .none : .followUpParent)
        job.modelOrigin = resolution.origin.rawValue
        job.subAgentName = subAgent.name
        job.modelIdentity = HelperModelIdentity.make(resolution: resolution)

        // ── Child session ────────────────────────────────────────────────
        let session = await ChatStore.shared.createSession(
            modelId: resolution.entry.model.id,
            title: AgentJobRegistry.childSessionTitle(a.displayTitle, subAgentName: subAgent.isBuiltIn ? nil : subAgent.name),
            source: "subagent",
            parentSessionId: parentSid,
            parentToolUseId: toolUseId)
        let childId = session.id
        ProviderConfigStore.shared.setBinding(
            SessionModelBinding(sessionId: childId, primarySource: resolution.source), for: childId)
        let thinking = SubAgentModelResolver.seedChildThinkingLevel(
            childId: childId, parentSessionId: parentSid, resolution: resolution, subAgent: subAgent)

        let child = prepareSubAgentChild(childId: childId, job: job, subAgent: subAgent, title: a.displayTitle)
        await child.loadSession()
        child.memoryEnabled = false

        guard child.submitSubAgentPrompt(a.childPrompt) else {
            job.then = .none
            registry.finish(job.id, state: .failed, result: nil)
            return reject("child_start_failed", "The sub agent session did not start.")
        }
        registry.markRunning(job.id, sessionId: childId)
        let startedAt = Date()
        logger.info("[subagent] START job=\(job.id.prefix(8)) child=\(childId.prefix(8)) parent=\(parentSid.prefix(8)) origin=\(resolution.origin.rawValue) budget=\(a.minutes)m wait=\(a.wait)")

        let running = runningPayload(job: job, childId: childId, resolution: resolution,
                                     minutes: a.minutes, thinking: thinking, converted: false)
        writeSubAgentBlock(toolUseId: toolUseId, content: running)

        if !a.wait {
            startBackgroundSubAgent(job: job, child: child, childId: childId, toolUseId: toolUseId,
                                    resolution: resolution, minutes: a.minutes, startedAt: startedAt)
            return (running, true)
        }

        // ── Wait mode ────────────────────────────────────────────────────
        var finalStatus = "completed"
        var wrapUpAskedAt: Date?
        var toolStopped = false
        while child.isProcessing || !child.subAgentState.pendingSteerMessages.isEmpty {
            if Task.isCancelled || job.state != .running { break }
            if !child.isProcessing {
                // A steer arrived between turns: take another turn to deliver it.
                _ = child.submitSubAgentPrompt(SubAgentText.steerNudge)
            }
            if Date().timeIntervalSince(startedAt) >= TimeInterval(a.minutes * 60) {
                if let asked = wrapUpAskedAt {
                    let waited = Date().timeIntervalSince(asked)
                    if waited >= SubAgentLimits.wrapUpGraceSeconds {
                        finalStatus = "timeout"
                        child.cancel(queuePolicy: .discardQueuedPrompts)
                        break
                    }
                    if waited >= SubAgentLimits.wrapUpToolPatience, !toolStopped {
                        toolStopped = true
                        child.stopCurrentCommand()
                    }
                } else {
                    wrapUpAskedAt = Date()
                    child.subAgentState.wrapUpRequested = true
                }
            }
            // The user spoke while the parent waits: answer them now, the
            // sub agent's result follows as its own message.
            if hasUserQueuedPrompt {
                logger.info("[subagent] user follow-up while waiting — moving job \(job.id.prefix(8)) to the background")
                job.then = .followUpParent
                startBackgroundSubAgent(job: job, child: child, childId: childId, toolUseId: toolUseId,
                                        resolution: resolution, minutes: a.minutes, startedAt: startedAt,
                                        wrapUpAlreadyAsked: wrapUpAskedAt != nil)
                let converted = runningPayload(job: job, childId: childId, resolution: resolution,
                                               minutes: a.minutes, thinking: thinking, converted: true)
                writeSubAgentBlock(toolUseId: toolUseId, content: converted)
                return (converted, true)
            }
            // [B24] Wake on the child's start/stop or the user's next message
            // instead of polling every 500 ms; the cap keeps budget checks timely.
            await Self.awaitSubAgentChange(child, parent: self, upTo: 1.0)
        }
        if Task.isCancelled, child.isProcessing { child.cancel(queuePolicy: .discardQueuedPrompts) }
        var settle = 0
        while child.isProcessing, settle < 20 { try? await Task.sleep(nanoseconds: 100_000_000); settle += 1 }

        let childError = child.errorMessage ?? child.messages.last(where: { $0.role == .assistant })?.error
        if job.state == .cancelled || job.muted {
            finalStatus = "cancelled"
        } else if finalStatus == "completed" {
            if child.userDidCancel || Task.isCancelled { finalStatus = "cancelled" }
            else if childError != nil { finalStatus = "failed" }
        }
        let resultText = await AgentJobRegistry.lastAssistantText(sessionId: childId) ?? ""
        let reported = SubAgentOutcome.resolvedStatus(finalStatus, result: resultText)
        let jobState: AgentJobState = switch reported {
        case "completed": .done
        case "cancelled": .cancelled
        case "timeout": .timeout
        default: .failed
        }
        job.summaryLine = Self.subAgentSummaryLine(child: child)
        let userStopped = job.muted
        registry.finish(job.id, state: jobState, result: resultText)
        var payload = finalPayload(job: job, childId: childId, status: reported, loopStatus: finalStatus,
                                   result: resultText, resolution: resolution, errorText: childError)
        if userStopped {
            payload["note"] = "The user stopped this sub agent. Do not delegate it again unless the user asks."
        }
        let json = SubAgentRecovery.jsonString(payload)
        writeSubAgentBlock(toolUseId: toolUseId, content: json)
        logger.info("[subagent] END job=\(job.id.prefix(8)) status=\(reported) elapsed=\(Int(Date().timeIntervalSince(startedAt)))s")
        return (json, reported == "completed")
    }

    /// Configure (or re-configure, on resume) the child's view model.
    private func prepareSubAgentChild(childId: String, job: AgentJob, subAgent: SubAgentDefinition,
                                      title: String) -> AIChatViewModel {
        // [B24] Children live in the background pool: a burst of sub agents
        // must never evict the conversations the user opened.
        let (child, _) = ViewModelCache.shared.getOrCreate(for: childId, kind: .background)
        child.sessionSource = "subagent"
        child.subAgentState.config = SubAgentRunConfig(
            parentSessionId: job.parentSessionId, parentToolUseId: job.parentToolUseId, jobId: job.id,
            title: title, maxTurns: SubAgentLimits.maxTurns,
            subAgentId: subAgent.id, subAgentName: subAgent.name, instructions: subAgent.instructions)
        child.subAgentState.resetForNewRun()
        job.child = child
        return child
    }

    // MARK: - Background

    private func startBackgroundSubAgent(job: AgentJob, child: AIChatViewModel, childId: String,
                                         toolUseId: String, resolution: HelperModelResolution,
                                         minutes: Int, startedAt: Date, wrapUpAlreadyAsked: Bool = false) {
        let registry = AgentJobRegistry.shared
        job.completionHook = { [weak self] finished in
            guard let self else { return }
            let result = finished.resultText ?? ""
            let loopStatus = finished.state == .done ? "completed" : finished.state.rawValue
            let reported = SubAgentOutcome.resolvedStatus(loopStatus, result: result)
            finished.summaryLine = Self.subAgentSummaryLine(child: child)
            var payload = self.finalPayload(job: finished, childId: childId, status: reported, loopStatus: loopStatus,
                                            result: result, resolution: resolution,
                                            errorText: child.errorMessage)
            payload["delivered_as"] = "new message in this conversation"
            let json = SubAgentRecovery.jsonString(payload)
            let status: ToolBlockStatus = switch finished.state {
            case .done: .success
            case .cancelled: .cancelled
            case .timeout: .failed(message: "超时")
            default: .failed(message: "失败")
            }
            self.writeSubAgentBlock(toolUseId: toolUseId, content: json, status: status)
            self.persistFinalSubAgentResult(toolUseId: toolUseId, content: json, status: status,
                                            withholdFromHistory: finished.muted)
        }

        job.task = Task { @MainActor in
            let deadline = startedAt.addingTimeInterval(TimeInterval(minutes * 60))
            var timedOut = false
            // Run until the child is idle with no steer left to deliver, or the
            // budget expires.
            while !Task.isCancelled {
                if !child.isProcessing {
                    if child.subAgentState.pendingSteerMessages.isEmpty { break }
                    _ = child.submitSubAgentPrompt(SubAgentText.steerNudge)
                }
                if Date() >= deadline { timedOut = true; break }
                await Self.awaitSubAgentChange(child, parent: nil,
                                               upTo: min(2.0, deadline.timeIntervalSinceNow))
            }
            if Task.isCancelled { return }
            var state: AgentJobState = child.userDidCancel ? .cancelled : .done
            if timedOut, child.isProcessing {
                if !wrapUpAlreadyAsked { child.subAgentState.wrapUpRequested = true }
                if !(await Self.awaitSubAgentWrapUp(child)) {
                    child.cancel(queuePolicy: .discardQueuedPrompts)
                    _ = await Self.awaitSubAgentIdle(child, seconds: SubAgentLimits.wrapUpGraceSeconds)
                    state = .timeout
                }
            }
            guard job.isActive else { return }
            let text = await AgentJobRegistry.lastAssistantText(sessionId: childId)
            if state == .done, child.errorMessage != nil, (text ?? "").isEmpty { state = .failed }
            registry.finish(job.id, state: state, result: text)
        }
        logger.info("[subagent] BACKGROUND job=\(job.id.prefix(8)) child=\(childId.prefix(8)) budget=\(minutes)m")
    }

    /// [B24] Suspend until the child's `isProcessing` or the parent's prompt
    /// queue changes, the task is cancelled, or `seconds` pass — whichever is
    /// first. Callers re-check their conditions after it returns.
    static func awaitSubAgentChange(_ child: AIChatViewModel, parent: AIChatViewModel?,
                                    upTo seconds: TimeInterval) async {
        guard seconds > 0, !Task.isCancelled else { return }
        let wakeup = SubAgentWakeup()
        var subscriptions: [AnyCancellable] = [child.$isProcessing.dropFirst().sink { _ in wakeup.fire() }]
        if let parent {
            subscriptions.append(parent.$promptQueue.dropFirst().sink { _ in wakeup.fire() })
        }
        await withTaskCancellationHandler {
            await wakeup.wait(upTo: seconds)
        } onCancel: {
            Task { @MainActor in wakeup.fire() }
        }
        subscriptions.forEach { $0.cancel() }
    }

    static func awaitSubAgentIdle(_ child: AIChatViewModel, seconds: TimeInterval) async -> Bool {
        let deadline = Date().addingTimeInterval(seconds)
        while child.isProcessing, Date() < deadline {
            try? await Task.sleep(nanoseconds: 250_000_000)
        }
        return !child.isProcessing
    }

    /// Budget over: the next loop turn is the tool-less wrap-up; a child stuck
    /// inside one long tool call gets that tool stopped after a short patience.
    static func awaitSubAgentWrapUp(_ child: AIChatViewModel) async -> Bool {
        if await awaitSubAgentIdle(child, seconds: SubAgentLimits.wrapUpToolPatience) { return true }
        if child.isProcessing { child.stopCurrentCommand() }
        return await awaitSubAgentIdle(child, seconds: SubAgentLimits.wrapUpGraceSeconds - SubAgentLimits.wrapUpToolPatience)
    }

    // MARK: - Control (status / steer / cancel)

    func executeSubAgentControl(args: [String: Any]) -> (output: String, success: Bool) {
        guard let sid = sessionId else {
            return (SubAgentRecovery.jsonString(["ok": false, "error": "no_session"]), false)
        }
        let registry = AgentJobRegistry.shared
        let action = SubAgentTool.Action.parse(args["action"])
        let jobIdArg = (args["job_id"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        var jobs = registry.list().filter { $0.parentSessionId == sid }
        if !jobIdArg.isEmpty {
            jobs = jobs.filter { $0.id == jobIdArg || $0.id.hasPrefix(jobIdArg) }
            if jobs.isEmpty {
                return (SubAgentRecovery.jsonString(["ok": false, "error": "job_not_found", "job_id": jobIdArg]), false)
            }
        }
        switch action {
        case .cancel:
            guard !jobIdArg.isEmpty else {
                return (SubAgentRecovery.jsonString(["ok": false, "error": "job_id_required_for_cancel"]), false)
            }
            for job in jobs where job.isActive {
                job.cancelledByParentModel = true
                registry.cancel(jobId: job.id, reason: "cancelled by the parent model")
            }
        case .steer:
            guard !jobIdArg.isEmpty else {
                return (SubAgentRecovery.jsonString(["ok": false, "error": "job_id_required_for_steer"]), false)
            }
            let message = (args["message"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            guard !message.isEmpty else {
                return (SubAgentRecovery.jsonString(["ok": false, "error": "message_required_for_steer"]), false)
            }
            guard let job = jobs.first, job.isActive, let child = job.child else {
                return (SubAgentRecovery.jsonString([
                    "ok": false, "status": "rejected", "reason": "already_finished",
                    "detail": "That sub agent is no longer running — its result stands. Delegate a new task instead.",
                ]), false)
            }
            child.subAgentState.pendingSteerMessages.append(message)
            if !child.isProcessing { _ = child.submitSubAgentPrompt(SubAgentText.steerNudge) }
            return (SubAgentRecovery.jsonString([
                "ok": true, "status": "queued", "job_id": job.id, "agent": job.subAgentName ?? NSNull(),
                "detail": "Queued. The sub agent reads it at its next turn; a running tool call is not interrupted.",
            ]), true)
        default:
            break
        }
        let entries: [[String: Any]] = jobs.map { job in
            var d: [String: Any] = [
                "job_id": job.id, "title": job.title, "state": job.state.rawValue,
                "agent": job.subAgentName ?? NSNull(), "model_origin": job.modelOrigin ?? NSNull(),
                "elapsed_s": Int(job.elapsed ?? 0), "child_session_id": job.runSessionId ?? NSNull(),
                "delivery": job.then == .none ? "tool_result" : "new_message_when_done",
            ]
            if !job.missedSteers.isEmpty {
                d["missed_steer"] = job.missedSteers
            }
            if job.state == .running, let cid = job.runSessionId,
               let info = SessionActivityTracker.shared.sessionToolInfo[cid] {
                d["current_tool"] = info.toolName
                d["loop_iteration"] = info.loopIteration
            }
            if !job.isActive, let r = job.resultText { d["result"] = String(r.prefix(2000)) }
            return d
        }
        let interrupted = Self.interruptedSubAgentChildIds(in: self)
        let queued = registry.queuedCount(parent: sid)
        return (SubAgentRecovery.jsonString([
            "ok": true, "action": action.rawValue, "count": entries.count, "agents": entries,
            "queued": queued, "interrupted": interrupted,
            "note": "Running sub agents deliver their final result automatically as a new message; you do not need to poll."
                + (interrupted.isEmpty ? "" : " \(interrupted.count) were interrupted by an app restart; use action=resume to restart them."),
        ]), true)
    }

    // MARK: - Resume

    func executeResumeSubAgents(args: [String: Any]) async -> (output: String, success: Bool) {
        var targets: [String]
        if let one = (args["child_session_id"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines), !one.isEmpty {
            targets = [one]
        } else {
            targets = Self.interruptedSubAgentChildIds(in: self)
        }
        guard !targets.isEmpty else {
            return (SubAgentRecovery.jsonString(["ok": true, "resumed": 0, "detail": "No interrupted sub agents in this conversation."]), true)
        }
        var ok: [String] = []
        var failed: [[String: Any]] = []
        for childId in targets {
            if let why = await resumeInterruptedSubAgent(childSessionId: childId) {
                failed.append(["child_session_id": childId, "reason": why])
            } else {
                ok.append(childId)
            }
        }
        return (SubAgentRecovery.jsonString([
            "ok": !ok.isEmpty, "resumed": ok.count, "child_session_ids": ok,
            "failed": failed.isEmpty ? NSNull() : failed,
            "detail": ok.isEmpty ? "None could be resumed."
                : "\(ok.count) sub agent(s) restarted; each reports back as a new message. Do not re-delegate them.",
        ]), !ok.isEmpty)
    }

    /// Child session ids whose block still holds a "running" payload while no
    /// job backs it — the runs a previous process lost.
    static func interruptedSubAgentChildIds(in vm: AIChatViewModel) -> [String] {
        var out: [String] = []
        for msg in vm.messages where msg.role == .assistant {
            for b in msg.blocks {
                guard case .delegateTool = b.kind else { continue }
                let state = SubAgentRecovery.state(
                    payload: SubAgentRecovery.parseJSON(b.content),
                    isControlCall: SubAgentTool.Action.parse(subAgentInputArgs(b)["action"]) != .delegate,
                    isJobAlive: { AgentJobRegistry.shared.isJobAlive(childSessionId: $0) },
                    isQueued: b.toolUseId.map { AgentJobRegistry.shared.isQueued(toolUseId: $0) } ?? false)
                if case .interrupted(let child) = state, !out.contains(child) { out.append(child) }
            }
        }
        return out
    }

    /// Restart an interrupted sub agent from its own transcript, reporting back
    /// into the SAME parent block. Returns nil on success, or a short reason.
    @discardableResult
    func resumeInterruptedSubAgent(childSessionId childId: String) async -> String? {
        guard !isSubAgentChild else { return "a sub agent cannot resume another" }
        guard let parentSid = sessionId else { return "no session" }
        let registry = AgentJobRegistry.shared
        if registry.isJobAlive(childSessionId: childId) { return nil }
        guard let childSession = await ChatStore.shared.getSession(childId),
              childSession.parentSessionId == parentSid,
              let toolUseId = childSession.parentToolUseId else {
            return "that sub agent is not part of this conversation"
        }
        let payload = subAgentBlockIndices(toolUseId: toolUseId).flatMap { m, b in
            SubAgentRecovery.parseJSON(messages[m].blocks[b].content)
        }
        let title = (payload?["title"] as? String).flatMap { $0.isEmpty ? nil : $0 }
            ?? childSession.title ?? "子代理"
        let roster = SubAgentStore.shared.subAgents
        var subAgent = roster.first { $0.isBuiltIn } ?? SubAgentDefinition.makeBuiltIn()
        if let name = payload?["agent"] as? String, let named = roster.first(where: { $0.name == name }) {
            subAgent = named
        }
        guard let resolution = SubAgentModelResolver.resolve(subAgent: subAgent, parent: self) else {
            return "no model is configured to run it on"
        }
        guard registry.canStartChildJob else {
            _ = registry.enqueueDelegation(.init(parentSessionId: parentSid,
                                                 args: ["__resume_child": childId, "tool_title": title],
                                                 toolUseId: toolUseId))
            writeSubAgentBlock(toolUseId: toolUseId, content: SubAgentRecovery.jsonString([
                "ok": true, "status": "queued", "title": title,
                "detail": "All slots are busy; this resume is queued and starts when one frees.",
            ]))
            return nil
        }
        let job = registry.register(title: title, parentSessionId: parentSid, parentToolUseId: toolUseId,
                                    prompt: nil, then: .followUpParent)
        job.modelOrigin = resolution.origin.rawValue
        job.subAgentName = subAgent.name
        job.modelIdentity = HelperModelIdentity.make(resolution: resolution)
        job.wasResumed = true
        ProviderConfigStore.shared.setBinding(
            SessionModelBinding(sessionId: childId, primarySource: resolution.source), for: childId)
        let thinking = SubAgentModelResolver.seedChildThinkingLevel(
            childId: childId, parentSessionId: parentSid, resolution: resolution, subAgent: subAgent)
        let child = prepareSubAgentChild(childId: childId, job: job, subAgent: subAgent, title: title)
        if child.messages.isEmpty { await child.loadSession() }
        child.memoryEnabled = false
        guard child.submitSubAgentPrompt(SubAgentText.resumeNotice) else {
            job.then = .none
            registry.finish(job.id, state: .failed, result: nil)
            return "the sub agent session did not restart"
        }
        registry.markRunning(job.id, sessionId: childId)
        let minutes = SubAgentLimits.defaultMinutes
        writeSubAgentBlock(toolUseId: toolUseId,
                           content: runningPayload(job: job, childId: childId, resolution: resolution,
                                                   minutes: minutes, thinking: thinking, converted: false),
                           status: .running)
        startBackgroundSubAgent(job: job, child: child, childId: childId, toolUseId: toolUseId,
                                resolution: resolution, minutes: minutes, startedAt: Date())
        logger.info("[subagent] RESUME job=\(job.id.prefix(8)) child=\(childId.prefix(8))")
        return nil
    }

    // MARK: - Payloads

    private func runningPayload(job: AgentJob, childId: String, resolution: HelperModelResolution,
                                minutes: Int, thinking: ThinkingLevel?, converted: Bool) -> String {
        var payload: [String: Any] = [
            "ok": true, "status": "running", "job_id": job.id, "child_session_id": childId,
            "title": job.title, "agent": job.subAgentName ?? NSNull(),
            "model_used": resolution.modelLabel, "model_origin": resolution.origin.rawValue,
            "thinking_level": thinking?.rawValue ?? NSNull(),
            "budget_minutes": minutes,
            "note": converted
                ? "The user sent a new message while you were waiting, so this sub agent moved to the background. Answer the user now; its result arrives as a NEW <agent_callback> message when done."
                : "The sub agent is running in the background. Its result arrives as a NEW <agent_callback> message in this conversation — end this turn when you have nothing else to do; do not poll.",
        ]
        if job.wasResumed { payload["resumed"] = true }
        if resolution.modelGroupUnavailable { payload["model_group_unavailable"] = true }
        if let identity = job.modelIdentity { payload.merge(identity.payload()) { _, new in new } }
        return SubAgentRecovery.jsonString(payload)
    }

    private func finalPayload(job: AgentJob, childId: String, status: String, loopStatus: String,
                              result: String, resolution: HelperModelResolution,
                              errorText: String?) -> [String: Any] {
        var payload: [String: Any] = [
            "ok": status == "completed", "status": status,
            "result": result.isEmpty ? SubAgentText.emptyResultNote(status: loopStatus) : result,
            "title": job.title, "agent": job.subAgentName ?? NSNull(),
            "model_used": resolution.modelLabel, "model_origin": resolution.origin.rawValue,
            "escalation_requested": result.contains("[ESCALATE]"),
            "error_kind": SubAgentOutcome.errorKind(errorText) ?? NSNull(),
            "elapsed_s": Int(job.elapsed ?? 0), "child_session_id": childId, "job_id": job.id,
            "summary": job.summaryLine ?? "",
        ]
        if job.wasResumed {
            payload["resumed"] = true
            payload["resumed_note"] = "This run was interrupted and resumed; its live tool state was lost at that point."
        }
        if !job.missedSteers.isEmpty {
            payload["missed_steer"] = job.missedSteers
            payload["missed_steer_note"] = "The run ended before reading these — the result does not reflect them."
        }
        if resolution.modelGroupUnavailable { payload["model_group_unavailable"] = true }
        if let identity = job.modelIdentity { payload.merge(identity.payload()) { _, new in new } }
        return payload
    }

    /// "tools · turns · tokens" for the parent model, from the child's
    /// in-memory transcript and token counters.
    static func subAgentSummaryLine(child: AIChatViewModel) -> String {
        var counts: [String: Int] = [:]
        var order: [String] = []
        for msg in child.messages where msg.role == .assistant {
            for block in msg.blocks where block.toolStatus != nil {
                let name: String = switch block.kind {
                case .shellTool: "shell"
                case .fileReadTool: "file_read"
                case .fileWriteTool: "file_write"
                case .fileEditTool: "file_edit"
                case .browserTool: "browser_use"
                case .readImageTool: "read_image"
                case .memoryTool(let a): a
                case .delegateTool: SubAgentTool.name
                default: "other"
                }
                if counts[name] == nil { order.append(name) }
                counts[name, default: 0] += 1
            }
        }
        let tools = order.isEmpty ? "none" : order.map { "\($0)×\(counts[$0] ?? 0)" }.joined(separator: ", ")
        let s = child.sessionTokenStats
        func k(_ n: Int) -> String { n >= 1000 ? String(format: "%.1fk", Double(n) / 1000) : "\(n)" }
        return "tools \(tools) · turns \(s.loopCount) · tokens in \(k(s.input)) / out \(k(s.output))"
    }

    // MARK: - Block helpers

    static func subAgentInputArgs(_ block: AssistantBlock) -> [String: Any] {
        guard let raw = block.toolInputArgs, let data = raw.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return [:] }
        return obj
    }

    func subAgentBlockIndices(toolUseId: String) -> (Int, Int)? {
        for (m, msg) in messages.enumerated() where msg.role == .assistant {
            if let b = msg.blocks.firstIndex(where: { $0.toolUseId == toolUseId }) { return (m, b) }
        }
        return nil
    }

    /// Write into the parent block, located by tool_use id (indices go stale
    /// across later turns and reloads).
    func writeSubAgentBlock(toolUseId: String, content: String, status: ToolBlockStatus? = nil) {
        guard let (m, b) = subAgentBlockIndices(toolUseId: toolUseId) else { return }
        let block = messages[m].blocks[b]
        block.content = content
        if let status, block.toolStatus != status { block.toolStatus = status }
    }

    /// A background delegation returned `status: running` as its tool_result,
    /// and that is what got persisted. Rewrite it with the final payload — in
    /// the model-facing history (unless the user stopped it, which must not
    /// drive the conversation) and in the parent's DB row (always, so a reload
    /// shows the outcome rather than "interrupted").
    private func persistFinalSubAgentResult(toolUseId: String, content: String, status: ToolBlockStatus,
                                            withholdFromHistory: Bool) {
        let success: Bool = { if case .success = status { return true }; return false }()
        let statusText: String = {
            switch status {
            case .success: return "success"
            case .cancelled: return "cancelled"
            default: return "failed"
            }
        }()
        if !withholdFromHistory {
            for i in agentHistory.indices {
                for j in agentHistory[i].parts.indices {
                    if case .toolResult(let id, let name, _, _, let img, let mime, let url, let path) = agentHistory[i].parts[j],
                       id == toolUseId {
                        agentHistory[i].parts[j] = .toolResult(id: id, name: name, content: content, isError: !success,
                                                               imageData: img, imageMimeType: mime, pageURL: url,
                                                               imageLinuxPath: path)
                    }
                }
            }
        }
        guard let sid = sessionId else { return }
        Task { @MainActor in
            let raws = await ChatStore.shared.loadMessages(sessionId: sid)
            for raw in raws where raw.role == .user {
                guard raw.parts.contains(where: {
                    if case .toolResult(let tr) = $0 { return tr.toolUseId == toolUseId }
                    return false
                }) else { continue }
                let parts: [ContentPart] = raw.parts.map { part in
                    guard case .toolResult(let tr) = part, tr.toolUseId == toolUseId else { return part }
                    return .toolResult(ToolResult(toolUseId: tr.toolUseId, output: content, success: success,
                                                  mediaRef: tr.mediaRef, snapshot: tr.snapshot,
                                                  pageURL: tr.pageURL, status: statusText))
                }
                await ChatStore.shared.updateMessageParts(messageId: raw.id, parts: parts)
                return
            }
        }
    }
}

/// [B24] One-shot wake-up for `awaitSubAgentChange`. `@Published` emits in
/// willSet; resuming only enqueues the waiter, which runs after the property
/// has been assigned, so it always sees the new value.
@MainActor
final class SubAgentWakeup {
    private var continuation: CheckedContinuation<Void, Never>?
    private var fired = false
    private var timer: Task<Void, Never>?

    func fire() {
        fired = true
        timer?.cancel()
        timer = nil
        continuation?.resume()
        continuation = nil
    }

    func wait(upTo seconds: TimeInterval) async {
        guard !fired else { return }
        await withCheckedContinuation { (cont: CheckedContinuation<Void, Never>) in
            continuation = cont
            timer = Task { @MainActor [weak self] in
                try? await Task.sleep(nanoseconds: UInt64(max(0, seconds) * 1_000_000_000))
                self?.fire()
            }
        }
    }
}
