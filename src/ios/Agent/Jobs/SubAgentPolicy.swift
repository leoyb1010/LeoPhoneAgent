import Foundation

// [T-subagent] Pure rules for sub agents (`subagent_task`), ported from upstream
// iOS 1.14 (`HelperRunner` / `AgentJobRegistry` constants) and adapted to
// LeoBot's policy decisions. Everything here is dependency-free so the hostless
// logic-test target can pin it; the app-side runner reads its limits from here
// rather than hard-coding them a second time.
//
// Policy (decided before the port, see the upstream port plan):
//   · depth 1 — a child may not delegate, and may not reach remote execution /
//     Mac fleet / worker sessions either (they would let it escape the parent's
//     approval scope or create visible sessions);
//   · approvals — a child inherits the PARENT session's approval scope; prompts
//     surface in the parent with the child's name, never in the hidden session;
//   · full auto — a child counts as an agent turn only while its turn is
//     actually running (1.57.1's "requires a running turn" rule);
//   · hidden — child sessions stay off every system surface and never sync.

enum SubAgentLimits {
    /// Including the built-in one. The roster is injected into the main
    /// conversation every turn, so this bound is the per-request cost bound.
    static let maxCount = 10
    static let nameMaxLength = 40
    static let descriptionMaxLength = 200
    static let instructionsMaxLength = 4000

    /// Running children across the whole app.
    static let maxConcurrentChildJobs = 3
    /// Delegations waiting for a slot. Past this a delegation is refused.
    static let maxQueuedDelegations = 10
    /// Delegations that may START from one assistant message; the rest queue.
    static let maxPerAssistantTurn = 3

    static let defaultMinutes = 10
    static let maxMinutes = 60
    /// Tool-round ceiling, the same as the main chat's own cap.
    static let maxTurns = 200
    /// Rounds before the cliff at which the child is told how many remain.
    static let turnWarningLead = 3
    /// Seconds the child gets after its budget to answer the wrap-up prompt.
    static let wrapUpGraceSeconds: TimeInterval = 90
    /// Seconds a running tool may keep going after the budget before it is
    /// stopped so the wrap-up turn can start.
    static let wrapUpToolPatience: TimeInterval = 20
    /// A job running longer than any budget it could have been given is
    /// treated as stuck for UI purposes (the composer must never pin on Stop).
    static var stuckAfter: TimeInterval {
        TimeInterval(maxMinutes * 60) + wrapUpGraceSeconds + 300
    }

    /// Budget actually used for a requested `max_minutes` (nil = default).
    static func clampedMinutes(_ requested: Int?) -> Int {
        max(1, min(maxMinutes, requested ?? defaultMinutes))
    }
}

/// Where a sub agent's model came from (persisted as `model_origin`).
enum HelperModelOrigin: String {
    case pinned
    case inherited
    case defaultGroup = "default_group"
    case subGroup = "sub_group"
}

enum SubAgentModelChoice: String {
    case sameAsParent = "same_as_me"
    case defaultModel = "default_model"
    case subModel = "sub_model"

    static func parse(_ raw: String?) -> SubAgentModelChoice {
        guard let raw, let v = SubAgentModelChoice(rawValue: raw.lowercased()) else { return .sameAsParent }
        return v
    }
}

/// The tool's wire contract.
enum SubAgentTool {
    static let name = "subagent_task"

    enum Action: String, CaseIterable {
        case delegate, status, steer, cancel, resume

        /// Unknown / absent → delegate (the model's most common intent).
        static func parse(_ raw: Any?) -> Action {
            guard let s = (raw as? String)?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(),
                  let a = Action(rawValue: s) else { return .delegate }
            return a
        }
    }

    /// Tools a child may never see or call. Delegation (depth 1), remote
    /// execution, Mac fleet and visible worker sessions.
    static let childForbiddenTools: Set<String> = [
        name,
        "remote_shell", "remote_agent",
        "dispatch_subtask", "check_subtasks", "collect_subtask",
        // [T-ask-user] only the parent conversation asks the user.
        "ask_user",
    ]

    static func isForbiddenForChild(_ toolName: String) -> Bool {
        childForbiddenTools.contains(toolName)
    }

    /// Filter a tool list for a child session.
    static func filterForChild<T>(_ tools: [T], name: (T) -> String) -> [T] {
        tools.filter { !isForbiddenForChild(name($0)) }
    }
}

/// Parsed `subagent_task action=delegate` arguments.
struct SubAgentDelegateArgs: Equatable {
    var title: String
    var task: String
    var context: String
    var agent: String?
    var minutes: Int
    var wait: Bool
    var modelChoice: String?

    init(_ args: [String: Any]) {
        func str(_ k: String) -> String {
            (args[k] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        }
        // [T-r3-input-hardening] The title is shown on a one-line card and in
        // the job list; the brief is model-authored text that becomes the
        // child's first user message, so reserved envelope tags are escaped.
        title = ToolInputGuard.singleLineLabel(str("tool_title"), maxCharacters: 120)
        task = ReservedTagEscaper.escapeUserAuthored(str("task"))
        context = ReservedTagEscaper.escapeUserAuthored(str("context"))
        let a = str("agent")
        agent = a.isEmpty ? nil : a
        // [T-r3-tool-arg-clamp] `1e300` arrives as a Double; converting it with
        // Int(...) trapped. Only a finite, sane number is used — anything else
        // falls back to the default budget.
        let requested = ToolArgNumbers.plausibleInt(args["max_minutes"])
        minutes = SubAgentLimits.clampedMinutes(requested)
        // Background is the default; wait=true blocks the parent turn.
        if let b = args["wait"] as? Bool { wait = b }
        else if let s = args["wait"] as? String { wait = (s.lowercased() == "true") }
        else { wait = false }
        let mc = str("model_choice")
        modelChoice = mc.isEmpty ? nil : mc
    }

    var displayTitle: String { title.isEmpty ? ToolInputGuard.singleLineLabel(task, maxCharacters: 40) : title }

    /// The brief the child receives as its first user message.
    var childPrompt: String {
        context.isEmpty ? task : task + "\n\n--- Context from the delegating agent ---\n" + context
    }
}

/// Why a delegation is refused before any session is created.
enum SubAgentRejection: String, Equatable {
    case emptyTask = "empty_task"
    case depthLimit = "depth_limit"
    case noParentSession = "no_parent_session"
    case disabled = "subagents_disabled"
    case queueFull = "helper_limit"

    var detail: String {
        switch self {
        case .emptyTask: return "`task` is required and must describe the whole job."
        case .depthLimit: return "Sub agents cannot delegate further (max delegation depth is 1). Do the work yourself."
        case .noParentSession: return "This session cannot start sub agents."
        case .disabled: return "Sub agents are turned off in Settings."
        case .queueFull:
            return "\(SubAgentLimits.maxConcurrentChildJobs) sub agents are already running and the queue is full. Wait for some to finish, then delegate this task again — it was NOT queued."
        }
    }

    /// Checks that need nothing but the call site's own facts.
    static func precheck(task: String, isChild: Bool, hasSession: Bool, isRemote: Bool,
                         enabled: Bool) -> SubAgentRejection? {
        if isChild { return .depthLimit }
        if !enabled { return .disabled }
        if !hasSession || isRemote { return .noParentSession }
        if task.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return .emptyTask }
        return nil
    }
}

/// Concurrency + queue bookkeeping, independent of view models.
struct SubAgentSlots: Equatable {
    var running: Int = 0
    var queued: Int = 0

    var canStart: Bool { running < SubAgentLimits.maxConcurrentChildJobs }

    enum Admission: Equatable { case start, queue, refuse }

    /// Decide what happens to a new delegation. `positionInTurn` is its index
    /// among the delegate calls of one assistant message (0-based); a queued
    /// re-entry passes nil because it already served the per-turn allowance.
    func admit(positionInTurn: Int?) -> Admission {
        let overTurn = (positionInTurn ?? 0) >= SubAgentLimits.maxPerAssistantTurn
        if !overTurn && canStart { return .start }
        return queued < SubAgentLimits.maxQueuedDelegations ? .queue : .refuse
    }
}

/// What happens at the top of a child's loop turn.
struct SubAgentTurnDirective: Equatable {
    /// Take the tools away for this turn and inject the wrap-up prompt.
    var wrapUp: SubAgentWrapUpReason?
    /// Rounds remaining when the countdown warning is due.
    var warnRemaining: Int?

    static func evaluate(turnCount: Int, cap: Int = SubAgentLimits.maxTurns,
                         wrapUpRequested: Bool, wrapUpAlreadyInjected: Bool,
                         warningAlreadyInjected: Bool) -> SubAgentTurnDirective {
        var d = SubAgentTurnDirective()
        if !wrapUpAlreadyInjected, wrapUpRequested || turnCount >= cap - 1 {
            d.wrapUp = wrapUpRequested ? .budget : .turns
            return d
        }
        if !wrapUpAlreadyInjected, !warningAlreadyInjected {
            let remaining = cap - 1 - turnCount
            if remaining >= 1, remaining <= SubAgentLimits.turnWarningLead { d.warnRemaining = remaining }
        }
        return d
    }
}

enum SubAgentWrapUpReason: Equatable { case turns, budget }

/// Messages the child reads. Kept in English: the model, not the user, reads them.
enum SubAgentText {
    static func wrapUpPrompt(_ reason: SubAgentWrapUpReason) -> String {
        let why = reason == .turns ? "You have used all of your tool rounds." : "Your time budget is up."
        return """
        [\(why) Tools are no longer available for this turn.]
        Write your final answer NOW from what you already have. It must contain the complete deliverable itself — the full report, document, list or answer the task asked for — not a description of what you did, not a pointer to a file, not a request for more time. Mark anything you could not verify as unverified. This message is returned to the parent agent verbatim.
        """
    }

    static func turnBudgetWarning(remaining: Int) -> String {
        "[Budget check: \(remaining) tool \(remaining == 1 ? "round" : "rounds") left before tools are withdrawn.] "
            + "Stop investigating now and spend what is left on finishing: if the task asked you to write a file or produce an artifact, do it in the next round, then write your final answer. "
            + "Remember the final message must contain the complete deliverable itself, not a pointer to it."
    }

    static func steerNote(_ steers: [String]) -> String {
        steers.map { "[Course correction from the delegating agent] \($0)" }.joined(separator: "\n")
    }

    static let steerNudge = "The delegating agent has sent you a course correction. Read it and continue."

    static let resumeNotice = """
    [This run was interrupted and has been resumed. The tool results above are still valid, but all live state is gone: browser tabs are closed, shell processes have ended, and anything unsaved is lost. Files in the workspace are still there. Continue from what the transcript already establishes — reopen pages or re-run commands when you need them, and do not assume anything is still open.]
    """

    /// What the parent reads when the child ended without any text.
    static func emptyResultNote(status: String) -> String {
        "(the sub agent ended with status \(status) before writing a final answer; there is no deliverable — re-delegate with a narrower task or a larger budget rather than reading its transcript)"
    }

    /// Child brief appended to its system prompt (stable for the whole run).
    static func childBrief(title: String, maxTurns: Int, instructions: String) -> String {
        var s = """
        ## Sub agent mode
        You are running as a sub agent inside LeoBot on an iOS device. A parent agent delegated ONE focused task to you: "\(title)". You cannot see the parent conversation and it cannot see yours; everything you need is in the task text. Work the task to completion with your tools, then finish with a single clear final answer — that final message is returned verbatim to the parent agent as the result, and it is the ONLY thing the parent receives. So the final message must contain the complete deliverable itself (the full report, list, code or answer), never a summary of what you did or a pointer to a file. If you produced a file, paste its full content into the final message as well. Do not ask the parent or the user questions; make reasonable assumptions and state them. Your shell and file tools work in the parent conversation's workspace, so files you write are visible to the parent.
        You cannot delegate to other sub agents and cannot use remote hosts. Sensitive actions still need the user's approval, which is asked in the parent conversation.
        You have at most \(maxTurns) tool rounds; on the last one tools are withdrawn and you must write the deliverable from what you have, so start writing before you run out. If the task genuinely exceeds what you can do, end your final message with a line `[ESCALATE] <one-line reason>`.
        """
        let trimmed = instructions.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty {
            s += "\n\n--- Sub agent instructions (set by the user) ---\n" + trimmed
        }
        return s
    }
}

/// Run outcome classification shared by the wait and background paths.
enum SubAgentOutcome {
    static let noDeliverableStatus = "no_deliverable"

    /// A clean exit that wrote nothing is not "completed".
    static func resolvedStatus(_ status: String, result: String) -> String {
        guard status == "completed" else { return status }
        return result.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? noDeliverableStatus : status
    }

    /// A few words naming why a run failed, from the child's error text.
    static func errorKind(_ raw: String?) -> String? {
        guard let raw = raw?.trimmingCharacters(in: .whitespacesAndNewlines), !raw.isEmpty else { return nil }
        let s = raw.lowercased()
        if s.contains("context") && (s.contains("length") || s.contains("window") || s.contains("too long")) {
            return "上下文超限"
        }
        if s.contains("rate limit") || s.contains("429") || s.contains("too many requests") { return "触发限流" }
        if s.contains("quota") || s.contains("insufficient") || s.contains("credit") || s.contains("billing") {
            return "额度用尽"
        }
        if s.contains("overload") || s.contains("529") || s.contains("503") || s.contains("unavailable") {
            return "服务商繁忙"
        }
        if s.contains("timed out") || s.contains("timeout") { return "超时" }
        if s.contains("unauthor") || s.contains("401") || s.contains("403")
            || s.contains("api key") || s.contains("credential") {
            return "鉴权失败"
        }
        if s.contains("offline") || s.contains("network") || s.contains("connection")
            || s.contains("host") || s.contains("internet") {
            return "网络错误"
        }
        if s.contains("cancel") { return "已取消" }
        return nil
    }

    /// Whether a sub agent result that has just arrived may drive the parent
    /// on to another turn. A user stop on the parent or on the agent's card
    /// mutes it: Stop means the conversation goes quiet.
    static func mayDriveParent(parentCancelled: Bool, jobMuted: Bool) -> Bool {
        !parentCancelled && !jobMuted
    }
}

/// Where a child's sensitive-tool approval is asked and keyed.
struct SubAgentApprovalRoute: Equatable {
    /// Session the prompt is attributed to (and whose session grants apply).
    let sessionId: String?
    /// Shown in the prompt so the user knows which agent asks; nil for the
    /// conversation's own turns.
    let requester: String?

    static func route(sessionId: String?, parentSessionId: String?, childName: String?) -> SubAgentApprovalRoute {
        guard let parent = parentSessionId else {
            return SubAgentApprovalRoute(sessionId: sessionId, requester: nil)
        }
        let name = childName?.trimmingCharacters(in: .whitespacesAndNewlines)
        return SubAgentApprovalRoute(sessionId: parent,
                                     requester: "子代理「\((name?.isEmpty ?? true) ? "通用子代理" : name!)」")
    }
}

/// The 1.57.1 full-auto source rule, extended to sub agents: an offload call
/// keyed to a conversation counts as an agent turn when that conversation's own
/// turn OR one of its children's turns is actually running right now.
enum SubAgentFullAutoSource {
    static func turnActive(sessionActive: Bool, runningChildTurns: Int) -> Bool {
        sessionActive || runningChildTurns > 0
    }
}

/// Recognising delegations left behind by a previous process. The registry is
/// in memory by design, so a block persisted as "running" with no live job
/// behind it is an interrupted run (resumable); one persisted as "queued" with
/// nothing in the in-memory queue never started.
enum SubAgentRecovery {
    enum BlockState: Equatable { case live, interrupted(childSessionId: String), neverStarted, settled }

    static func state(payload: [String: Any]?, isControlCall: Bool,
                      isJobAlive: (String) -> Bool, isQueued: Bool) -> BlockState {
        guard let payload, !isControlCall else { return .settled }
        switch payload["status"] as? String {
        case "running":
            guard let child = payload["child_session_id"] as? String, !child.isEmpty else { return .settled }
            return isJobAlive(child) ? .live : .interrupted(childSessionId: child)
        case "queued":
            return isQueued ? .live : .neverStarted
        default:
            return .settled
        }
    }

    static func parseJSON(_ content: String) -> [String: Any]? {
        guard content.hasPrefix("{"), let data = content.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        return obj
    }

    static func jsonString(_ obj: [String: Any]) -> String {
        guard JSONSerialization.isValidJSONObject(obj),
              let data = try? JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys]),
              let s = String(data: data, encoding: .utf8) else { return "{}" }
        return s
    }
}

/// Every child session id known to this process, readable from any thread.
///
/// `SessionLockStore.isHiddenFromSystemSurfaces` (main-actor and nonisolated
/// variants), the background notification gate, Spotlight and the session
/// concurrency gate all consult it, so a child never reaches a system surface
/// even when the caller only has an id. Seeded from the database on open and
/// kept current by session create / delete.
final class ChildSessionIndex: @unchecked Sendable {
    static let shared = ChildSessionIndex()
    private let lock = NSLock()
    private var ids: Set<String> = []

    func contains(_ sessionId: String) -> Bool {
        lock.lock(); defer { lock.unlock() }
        return ids.contains(sessionId)
    }

    func insert(_ sessionId: String) {
        lock.lock(); ids.insert(sessionId); lock.unlock()
    }

    func remove(_ sessionId: String) {
        lock.lock(); ids.remove(sessionId); lock.unlock()
    }

    func replaceAll(_ newIds: Set<String>) {
        lock.lock(); ids = newIds; lock.unlock()
    }

    var isEmpty: Bool {
        lock.lock(); defer { lock.unlock() }
        return ids.isEmpty
    }

    static func contains(_ sessionId: String) -> Bool { shared.contains(sessionId) }
}

/// User-facing switch for the whole feature. On by default.
enum SubAgentSettings {
    static let enabledKey = "subagents.enabled"

    static var isEnabled: Bool {
        get { UserDefaults.standard.object(forKey: enabledKey) as? Bool ?? true }
        set { UserDefaults.standard.set(newValue, forKey: enabledKey) }
    }
}

// MARK: - Tool schema

extension SubAgentTool {
    /// The `subagent_task` definition. `agentNames` is the live roster so a
    /// rename takes effect on the next request and the model cannot invent one.
    static func definition(agentNames: [String]) -> AgentToolDefinition {
        AgentToolDefinition(
            name: name,
            description: "Delegate a self-contained task to a sub agent — its own isolated context and tool loop, in a hidden child session running concurrently with you — and inspect, steer or stop the ones you started. `action` defaults to `delegate`.\n\nDELEGATE work needing many rounds of exploration (reading lots of files or pages, trial-and-error), producing bulk output you only need a conclusion from, or splitting into independent sub-problems you can run in parallel (several calls in one turn). DO NOT delegate what you can finish in one or two tool calls, what needs the user's confirmation mid-way, or work depending on nuances of this conversation you cannot restate. A sub agent cannot see this conversation and has no memory: write `task` as a complete brief — goal, constraints, where things are, what exactly to return. It costs a full model run, so nothing trivial. Only \(SubAgentLimits.maxConcurrentChildJobs) run at once; extras return status=queued and start as slots free, so never re-delegate a queued task.\n\nwait=false (default) returns at once with status=running and a job_id; the result arrives later as a NEW user message wrapped in <agent_callback> (also on cancel/timeout/failure). Those callback messages are written by the system, not typed by the user. End your turn when you have nothing else to do — never poll in a loop. Sub agents share this conversation's workspace files and ask the user for approval of sensitive actions in this conversation.",
            parameters: [
                "tool_title": AgentToolParam(type: .string, description: "A concise 5-10 word summary shown to the user on the card (e.g. 'Survey repo test layout'). Use the same language as the user."),
                "action": AgentToolParam(type: .string, description: "\"delegate\" (default): start a sub agent on `task`. \"status\": report this conversation's sub agents (state, elapsed, model, finished results); `job_id` for one, omit for all. \"steer\": course-correct a RUNNING one without stopping it (see `message`). \"cancel\": stop the one named by `job_id`. \"resume\": restart runs the app lost when it was killed (they show as interrupted); `child_session_id` for one, omit for all.", enumValues: Action.allCases.map(\.rawValue)),
                "task": AgentToolParam(type: .string, description: "action=delegate only, required. The complete, self-contained brief: goal, success criteria, relevant paths/URLs, constraints, and exactly what to return. The sub agent sees nothing else."),
                "agent": AgentToolParam(type: .string, description: "action=delegate only. Which sub agent runs this task. Pick the one whose description matches the work; omit it to use the general one.", enumValues: agentNames.isEmpty ? nil : agentNames),
                "model_choice": AgentToolParam(type: .string, description: "action=delegate only, and only when the chosen sub agent is set to Auto. DEFAULT TO \"same_as_me\" (this conversation's model). \"default_model\": the user's default group — only when the task clearly needs more capability. \"sub_model\": the user's light group — only for clearly mechanical, well-bounded work.", enumValues: ["same_as_me", "default_model", "sub_model"]),
                "context": AgentToolParam(type: .string, description: "action=delegate only. Optional raw material to hand over verbatim (file excerpts, error output, a list of paths). Appended to the task."),
                "max_minutes": AgentToolParam(type: .integer, description: "action=delegate only. Wall-clock budget in minutes (default \(SubAgentLimits.defaultMinutes), maximum \(SubAgentLimits.maxMinutes)). When it runs out the sub agent is asked to write up what it has; status=timeout if it cannot."),
                "wait": AgentToolParam(type: .boolean, description: "action=delegate only. false (default): return at once; the result is posted here as a new message when done. true: block until it finishes and return the result here — only when the next step cannot proceed without it. If the user sends a message while you wait, the run moves to the background and the call returns status=running."),
                "job_id": AgentToolParam(type: .string, description: "action=status/steer/cancel. The job_id returned when the sub agent started (a prefix is accepted). Required for steer and cancel."),
                "message": AgentToolParam(type: .string, description: "action=steer only, required. The correction, phrased as an instruction to the running sub agent. Read at its next turn; if the run finishes first the result reports it as missed."),
                "child_session_id": AgentToolParam(type: .string, description: "action=resume only, optional. The child_session_id of one interrupted sub agent to restart. Omit to resume every interrupted one."),
            ],
            required: ["tool_title"],
            propertyOrdering: ["tool_title", "action", "task", "agent", "model_choice", "context", "max_minutes", "wait", "job_id", "message", "child_session_id"]
        )
    }
}
