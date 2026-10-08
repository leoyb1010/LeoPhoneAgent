import Foundation

private let logger = AppLogger(category: "SubAgents")

// [T-subagent] Every hook the sub agent feature needs inside AIChatViewModel,
// kept in one extension so the core files only carry one-line call sites.
// Upstream iOS 1.14 spread these across AIChatViewModel / +ToolDefinitions /
// +ProgrammaticPrompt; LeoBot keeps them isolated for parallel-lane merges.

/// Per-view-model sub agent state. A class held by one stored property on
/// AIChatViewModel (`subAgentState`) so the feature adds a single field there.
@MainActor
final class SubAgentVMState {
    /// Non-nil while this view model runs a sub agent (child) job.
    var config: SubAgentRunConfig?
    /// Budget expired: the next loop turn is the tool-less wrap-up turn.
    var wrapUpRequested = false
    var wrapUpInjected = false
    var warningInjected = false
    /// Course corrections queued by the parent, delivered at the next turn.
    var pendingSteerMessages: [String] = []
    /// True for the duration of a send() the user did not type (a child brief,
    /// a callback): suppresses haptics, input-mode learning and Siri donation.
    var isProgrammaticSend = false

    func resetForNewRun() {
        wrapUpRequested = false
        wrapUpInjected = false
        warningInjected = false
    }
}

extension AIChatViewModel {

    // MARK: - Identity

    /// A hidden sub agent (child) session — by its live config or, for a view
    /// model created any other way, by the persisted parent link.
    var isSubAgentChild: Bool {
        if subAgentState.config != nil { return true }
        guard let sid = sessionId else { return false }
        return ChildSessionIndex.contains(sid)
    }

    /// The session whose `/var/minis` workspace this view model's shell and
    /// file tools use. A child works in its PARENT's workspace, so what it
    /// writes is what the parent (and the user) can read.
    var subAgentFSSessionId: String? {
        subAgentState.config?.parentSessionId ?? sessionId
    }

    /// Where a sensitive-tool approval of this view model is asked: a child's
    /// goes to its parent conversation, labelled with the child's name.
    var subAgentApprovalRoute: SubAgentApprovalRoute {
        SubAgentApprovalRoute.route(sessionId: sessionId,
                                    parentSessionId: subAgentState.config?.parentSessionId,
                                    childName: subAgentState.config?.subAgentName)
    }

    // MARK: - Tools / prompt

    /// Hook in `makeAgentTools`: children lose the forbidden tools; a top-level
    /// conversation gains `subagent_task` when the feature is on.
    func applySubAgentTools(_ tools: [AgentToolDefinition]) -> [AgentToolDefinition] {
        if isSubAgentChild {
            return SubAgentTool.filterForChild(tools, name: \.name)
        }
        guard SubAgentSettings.isEnabled, remoteDeviceId == nil, !blocksSideEffectTools else { return tools }
        return tools + [SubAgentTool.definition(agentNames: SubAgentStore.shared.subAgents.map(\.name))]
    }

    /// Message for a child calling a tool it may not use (defence in depth:
    /// the tool is not even registered for a child).
    func subAgentForbiddenToolMessage(_ toolName: String) -> String? {
        guard isSubAgentChild, SubAgentTool.isForbiddenForChild(toolName) else { return nil }
        return "Sub agents cannot use \(toolName): delegation depth is 1 and remote execution is reserved for the parent conversation. Do the work with your own tools or report what is missing in your final answer."
    }

    /// Hook in `composeUserSystemPrompt` (stable part — no per-turn churn).
    var subAgentPromptFragment: String {
        if let cfg = subAgentState.config {
            return "\n\n" + SubAgentText.childBrief(title: cfg.title, maxTurns: cfg.maxTurns,
                                                    instructions: cfg.instructions)
        }
        guard !isSubAgentChild, SubAgentSettings.isEnabled, remoteDeviceId == nil, !blocksSideEffectTools else {
            return ""
        }
        return "\n\n" + Self.subAgentRosterSection()
    }

    /// The "which sub agent for which job" roster for the main conversation.
    static func subAgentRosterSection() -> String {
        let roster = SubAgentStore.shared.subAgents
        let store = ProviderConfigStore.shared
        var lines = ["## Sub agents",
                     "Available sub agents for \(SubAgentTool.name) (pass the name as `agent`):"]
        for def in roster {
            let desc = String(def.description.prefix(SubAgentLimits.descriptionMaxLength))
                .trimmingCharacters(in: .whitespacesAndNewlines)
            let model: String
            if let gid = def.modelGroupId, let group = store.group(for: gid) {
                model = "fixed — \(group.name)"
            } else {
                model = "Auto — you choose with model_choice"
            }
            lines.append("- \(def.name) — \(desc) Model: \(model).")
        }
        lines.append("Prefer a specific sub agent when its description matches; otherwise use the general one. <agent_callback> user messages are sub agent results written by the system, not by the user.")
        return lines.joined(separator: "\n")
    }

    // MARK: - Loop hook

    /// Called at the top of every agent-loop turn. For a child it injects the
    /// wrap-up prompt (returning true = withdraw the tools for this turn), the
    /// turn-countdown warning and any pending steer. No-op for a parent.
    func prepareSubAgentTurn(turnCount: Int, msgIdx: inout Int) async -> Bool {
        guard let cfg = subAgentState.config else { return false }
        let state = subAgentState
        let directive = SubAgentTurnDirective.evaluate(
            turnCount: turnCount, cap: cfg.maxTurns,
            wrapUpRequested: state.wrapUpRequested,
            wrapUpAlreadyInjected: state.wrapUpInjected,
            warningAlreadyInjected: state.warningInjected)
        var dropTools = false
        if let reason = directive.wrapUp {
            state.wrapUpInjected = true
            dropTools = true
            appendToPendingUserTurn(SubAgentText.wrapUpPrompt(reason))
            logger.info("[subagent] wrap-up turn injected reason=\(reason == .budget ? "budget" : "turns") turn=\(turnCount + 1)")
        } else if let remaining = directive.warnRemaining {
            state.warningInjected = true
            appendToPendingUserTurn(SubAgentText.turnBudgetWarning(remaining: remaining))
        }
        if !state.pendingSteerMessages.isEmpty {
            let steers = state.pendingSteerMessages
            state.pendingSteerMessages.removeAll()
            let note = SubAgentText.steerNote(steers)
            // Persisted as a real user message in the child's own transcript so
            // the change of direction is explained when someone reads it.
            let steerMsg = AgentMessage(role: .user, parts: [.text(note)])
            let steerIdx = agentHistory.count
            agentHistory.append(steerMsg)
            let insertAt = (msgIdx >= 0 && msgIdx <= messages.count) ? msgIdx : messages.count
            messages.insert(ChatMessage(role: .user, content: note), at: insertAt)
            if insertAt <= msgIdx { msgIdx += 1 }
            if let pid = await persistAgentMessage(steerMsg), steerIdx < agentHistory.count {
                agentHistory[steerIdx].dbMessageId = pid
            }
            logger.info("[subagent] steer delivered count=\(steers.count) turn=\(turnCount + 1)")
        }
        return dropTools
    }

    private func appendToPendingUserTurn(_ note: String) {
        if let last = agentHistory.indices.last, agentHistory[last].role == .user {
            agentHistory[last].parts.append(.text(note))
        } else {
            agentHistory.append(AgentMessage(role: .user, parts: [.text(note)]))
        }
    }

    // MARK: - Programmatic prompts

    /// Start a turn in this (child) view model with text nobody typed.
    /// Returns true when a loop started.
    @discardableResult
    func submitSubAgentPrompt(_ text: String) -> Bool {
        guard remoteDeviceId == nil, !isProcessing, !isCompacting else { return false }
        subAgentState.isProgrammaticSend = true
        defer { subAgentState.isProgrammaticSend = false }
        withComposerSetAside {
            inputText = text
            send()
        }
        return isProcessing
    }

    enum SubAgentDelivery: String { case sent, queued, rejected }

    /// Deliver a sub agent callback into this (parent) conversation: a new
    /// turn when idle; otherwise queued so it lands once the running plan
    /// converges (it never interrupts the parent's current tool chain).
    @discardableResult
    func submitSubAgentCallback(_ text: String) -> SubAgentDelivery {
        guard remoteDeviceId == nil else { return .rejected }
        if !isProcessing && !isCompacting {
            return submitSubAgentPrompt(text) ? .sent : .rejected
        }
        var prompt = QueuedPrompt(text: text, attachments: [])
        prompt.deferUntilIdle = true
        promptQueue.append(prompt)
        let row = ChatMessage(role: .user, content: text, isQueued: true)
        row.queuedPromptId = prompt.id
        messages.append(row)
        scheduleCallbackRescue(promptId: prompt.id)
        return .queued
    }

    /// The loop's epilogue drains the queue, but a prompt that lands after the
    /// final drain and before `isProcessing` flips has no consumer. Re-check a
    /// few times and start it ourselves when the conversation is idle.
    private func scheduleCallbackRescue(promptId: UUID, attempt: Int = 0) {
        guard attempt < 30 else { return }
        Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 2_000_000_000)
            guard let self, let prompt = self.promptQueue.first(where: { $0.id == promptId }) else { return }
            if self.isProcessing || self.isCompacting {
                self.scheduleCallbackRescue(promptId: promptId, attempt: attempt + 1)
                return
            }
            self.removeQueuedPrompt(id: promptId)
            _ = self.submitSubAgentPrompt(prompt.text)
            logger.info("[subagent] callback rescued from an idle queue")
        }
    }

    /// True when the user (not a job) has something waiting in the queue.
    var hasUserQueuedPrompt: Bool { promptQueue.contains { !$0.deferUntilIdle } }

    // MARK: - Stop

    /// Hook at the top of `cancel()`: the user stopping a conversation stops
    /// its sub agents silently (Stop means the conversation goes quiet), and
    /// callbacks already queued behind the turn are withdrawn. Cancelling the
    /// child's turn Task also invalidates any approval it was waiting on.
    func subAgentHandleStop() {
        guard !isSubAgentChild, let sid = sessionId else { return }
        let registry = AgentJobRegistry.shared
        if registry.hasActiveChildren(parent: sid) {
            registry.cancelAll(parent: sid, reason: "user stopped the conversation", silent: true)
        }
        let callbacks = promptQueue.filter { $0.deferUntilIdle }.map(\.id)
        for id in callbacks { removeQueuedPrompt(id: id) }
    }
}
