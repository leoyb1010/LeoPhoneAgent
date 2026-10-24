import Foundation

/// Stable, UI-independent phases for an agent run.
///
/// These values are deliberately coarser than the streaming implementation:
/// views, Live Activities, widgets and diagnostics should all describe the
/// same state without depending on provider-specific details.
enum AgentActivityPhase: String, Codable, CaseIterable, Sendable {
    case idle
    case preparing
    case thinking
    case usingTool = "using_tool"
    case waitingForPermission = "waiting_for_permission"
    case waitingForUser = "waiting_for_user"
    case suspended
    case completed
    case failed
    case cancelled
    case unverified

    var isTerminal: Bool {
        switch self {
        case .completed, .failed, .cancelled, .unverified: true
        default: false
        }
    }
}

enum AgentActivityEventKind: String, Codable, Sendable {
    case runStarted = "run_started"
    case phaseChanged = "phase_changed"
    case toolChanged = "tool_changed"
    case runFinished = "run_finished"
}

/// Privacy-safe reasons for phases that need additional explanation.
/// Raw values are stable diagnostic codes, never provider/user-generated text.
enum AgentActivityReason: String, Codable, CaseIterable, Sendable {
    case permissionApproval = "permission_approval"
    case autoApproved = "auto_approved"
    case browserTakeover = "browser_takeover"
    case backgroundTimeExpired = "background_time_expired"
    case unexpectedTermination = "unexpected_termination"
    case concurrencyLimit = "concurrency_limit"
    case userInterruption = "user_interruption"
    case responseLimit = "response_limit"
    case connectionDropped = "connection_dropped"
    case toolFailure = "tool_failure"
    case providerFailure = "provider_failure"
    case authenticationRequired = "authentication_required"
    case rateLimited = "rate_limited"
    case kernelUnavailable = "kernel_unavailable"
    /// [T-ask-user] The model asked the user a question and waits for the answer.
    case userQuestion = "user_question"
}

/// Recovery actions are intentionally coarse and contain no provider text.
/// They can be persisted or rendered without leaking task content.
enum AgentRecoveryAction: String, Codable, CaseIterable, Sendable {
    case retry
    case resume
    case reviewProvider = "review_provider"
    case retryKernel = "retry_kernel"
}

/// Maps transient error text to a stable privacy-safe reason and recovery path.
/// The raw text is inspected in memory only and is never written to Activity.
enum AgentActivityFailureClassifier {
    static func reason(for message: String?) -> AgentActivityReason {
        let text = (message ?? "").lowercased()
        // "ish" only as a whole word: as a substring it matched "establish",
        // "finish", "publish", "English" and sent network errors to the kernel path.
        if text.contains("kernel") || text.contains("rootfs") || containsWord(text, "ish") || text.contains("执行环境") {
            return .kernelUnavailable
        }
        if text.contains("unauthorized") || text.contains("authentication")
            || text.contains("api key") || text.contains("credential")
            || text.contains("401") || text.contains("403") || text.contains("登录") {
            return .authenticationRequired
        }
        if text.contains("rate limit") || text.contains("quota") || text.contains("429") || text.contains("限流") || text.contains("频繁") {
            return .rateLimited
        }
        if text.contains("timed out") || text.contains("timeout")
            || text.contains("offline") || text.contains("network")
            || text.contains("connection") || text.contains("网络") || text.contains("超时")
            || text.contains("连接") {
            return .connectionDropped
        }
        if text.contains("tool") || text.contains("command") || text.contains("process") {
            return .toolFailure
        }
        return .providerFailure
    }

    /// [r7] The run never started because no model is configured (first run,
    /// or every provider removed). Retrying can only fail the same way, so the
    /// chat error offers 「添加 AI 服务商」 instead of 重试. Matches the
    /// message in every shipped language, since old sessions keep the text
    /// they were written with.
    static func isMissingModel(_ message: String?) -> Bool {
        guard let message, !message.isEmpty else { return false }
        if message == AppLocalized("No model configured. Add a provider in Settings.") { return true }
        let text = message.lowercased()
        return text.contains("no model configured") || text.contains("未配置模型") || text.contains("未設定模型")
    }

    private static func containsWord(_ text: String, _ word: String) -> Bool {
        text.split { !$0.isLetter }.contains { $0 == word }
    }

    static func recoveryAction(for reason: AgentActivityReason) -> AgentRecoveryAction {
        switch reason {
        case .userInterruption, .responseLimit, .backgroundTimeExpired, .unexpectedTermination:
            return .resume
        case .authenticationRequired:
            return .reviewProvider
        case .kernelUnavailable:
            return .retryKernel
        default:
            return .retry
        }
    }
}

/// Explicit queue behavior for the chat Stop control. Keeping this policy as a
/// pure type makes the otherwise subtle difference testable and prevents a UI
/// label from drifting away from execution behavior.
enum AgentQueueStopPolicy: String, Codable, CaseIterable, Sendable {
    case continueQueuedPrompts = "continue_queued_prompts"
    case discardQueuedPrompts = "discard_queued_prompts"

    var shouldResumeQueue: Bool { self == .continueQueuedPrompts }
}

/// Explicitly names the only meaningful transitions of the legacy processing
/// Bool. This keeps start/stop side effects on their proven two-edge contract
/// while the richer persisted activity phase is introduced alongside it.
enum AgentProcessingTransition: Equatable, Sendable {
    case unchanged
    case started
    case stopped

    init(previous: Bool, current: Bool) {
        switch (previous, current) {
        case (false, true): self = .started
        case (true, false): self = .stopped
        default: self = .unchanged
        }
    }
}

struct AgentActivityEvent: Identifiable, Codable, Equatable, Sendable {
    let id: String
    let runId: String
    let sessionId: String
    let at: Date
    let kind: AgentActivityEventKind
    let phase: AgentActivityPhase
    let toolName: String?
    let reason: AgentActivityReason?
    let resultMessageId: String?

    init(
        id: String = UUID().uuidString,
        runId: String,
        sessionId: String,
        at: Date = Date(),
        kind: AgentActivityEventKind,
        phase: AgentActivityPhase,
        toolName: String? = nil,
        reason: AgentActivityReason? = nil,
        resultMessageId: String? = nil
    ) {
        self.id = id
        self.runId = runId
        self.sessionId = sessionId
        self.at = at
        self.kind = kind
        self.phase = phase
        self.toolName = toolName
        self.reason = reason
        self.resultMessageId = resultMessageId
    }
}

/// Device-local durable state for one agent run.
///
/// This is intentionally separate from synced chat data. It contains only
/// stable identifiers and privacy-safe phase metadata, so a process restart can
/// recognize a run that never reached a terminal transition without persisting
/// prompts, model output or tool arguments.
struct AgentRunState: Identifiable, Codable, Equatable, Sendable {
    let runId: String
    let sessionId: String
    let startedAt: Date
    let updatedAt: Date
    let phase: AgentActivityPhase
    let toolName: String?
    let reason: AgentActivityReason?
    var resultMessageId: String? = nil

    var id: String { runId }
    var isResumable: Bool {
        phase == .waitingForUser || phase == .suspended
    }

    var needsUnexpectedTerminationRecovery: Bool {
        !phase.isTerminal && phase != .waitingForUser
    }

    func recoveringAfterUnexpectedTermination(at date: Date = Date()) -> AgentRunState {
        guard needsUnexpectedTerminationRecovery else { return self }
        return AgentRunState(
            runId: runId,
            sessionId: sessionId,
            startedAt: startedAt,
            updatedAt: date,
            phase: .waitingForUser,
            toolName: toolName,
            reason: .unexpectedTermination
        )
    }
}

/// A receipt is tied to one durable run, never to the presence of reply text
/// or to a session's processing Bool (which also stops on failure/cancellation).
enum AgentRunOutcome: String, Codable, Sendable {
    case unknown, running, awaitingApproval, waitingForUser, suspended
    case succeeded, failed, cancelled

    init(state: AgentRunState?, expectedRunId: String) {
        guard let state, state.runId == expectedRunId else { self = .unknown; return }
        switch state.phase {
        case .completed: self = .succeeded
        case .failed: self = .failed
        case .cancelled: self = .cancelled
        case .waitingForPermission: self = .awaitingApproval
        case .waitingForUser: self = .waitingForUser
        case .suspended: self = .suspended
        case .idle, .unverified: self = .unknown
        default: self = .running
        }
    }

    var isTerminal: Bool { self == .succeeded || self == .failed || self == .cancelled }
    var canPublishBriefing: Bool { self == .succeeded }
    var shouldKeepObserving: Bool { self == .running || self == .awaitingApproval }

    /// Preserve the existing successful Shortcut status while adding accurate
    /// non-success outcomes for clients that branch on this field.
    var shortcutStatus: String {
        switch self {
        case .succeeded: "Completed"
        case .failed: "Failed"
        case .cancelled: "Cancelled"
        case .suspended: "Suspended"
        case .waitingForUser: "Waiting for User"
        case .awaitingApproval: "Awaiting Approval"
        case .running: "Running"
        case .unknown: "Unknown"
        }
    }

    /// The same outcome in the owner's words, for notification titles
    /// (`shortcutStatus` stays English: Shortcuts branch on it).
    var statusLabel: String {
        switch self {
        case .succeeded: AppLocalized("已完成")
        case .failed: AppLocalized("失败")
        case .cancelled: AppLocalized("已取消")
        case .suspended: AppLocalized("已暂停")
        case .waitingForUser: AppLocalized("等你处理")
        case .awaitingApproval: AppLocalized("等你批准")
        case .running: AppLocalized("进行中")
        case .unknown: AppLocalized("结果未知")
        }
    }

    var summary: String {
        switch self {
        case .succeeded: AppLocalized("任务已完成。")
        case .failed: AppLocalized("任务失败，请打开对话查看原因。")
        case .cancelled: AppLocalized("任务已取消。")
        case .suspended: AppLocalized("任务已暂停，可回到应用继续。")
        case .waitingForUser: AppLocalized("任务需要你处理，请打开对话。")
        case .awaitingApproval: AppLocalized("任务正在等待审批。")
        case .running: AppLocalized("任务仍在运行，稍后可查看结果。")
        case .unknown: AppLocalized("暂时无法确认任务结果，请打开对话查看。")
        }
    }
}

struct AgentRunCompletion: Equatable, Sendable {
    let phase: AgentActivityPhase
    let reason: AgentActivityReason?
    var keepsRunActive: Bool { phase == .preparing }

    init(userCancelled: Bool, canResume: Bool, backgroundSuspended: Bool,
         failureText: String?, waitingReason: AgentActivityReason? = nil,
         nativeOutcome: AgentRunOutcome? = nil, continuesPendingWork: Bool = false) {
        if userCancelled {
            phase = .cancelled; reason = .userInterruption
        } else if continuesPendingWork {
            phase = .preparing; reason = nil
        } else if nativeOutcome == .unknown {
            phase = .unverified; reason = nil
        } else if backgroundSuspended {
            phase = .suspended; reason = .backgroundTimeExpired
        } else if canResume {
            phase = .waitingForUser; reason = waitingReason ?? .userInterruption
        } else if let failureText {
            phase = .failed; reason = AgentActivityFailureClassifier.reason(for: failureText)
        } else {
            phase = .completed; reason = nil
        }
    }
}

/// Pure derivation used by future chat, sidebar and Live Activity surfaces.
/// Order is intentional: a resumable interruption is more actionable than an
/// old tool name, and a concurrency suspension outranks generic processing.
struct AgentActivitySnapshot: Equatable, Sendable {
    let isProcessing: Bool
    let isSuspended: Bool
    let canResume: Bool
    let toolName: String?

    var phase: AgentActivityPhase {
        if canResume { return .waitingForUser }
        if isSuspended { return .suspended }
        guard isProcessing else { return .idle }
        switch toolName {
        case "thinking": return .thinking
        case "text": return .preparing
        case .some(let name) where !name.isEmpty: return .usingTool
        default: return .preparing
        }
    }
}

/// One source of truth for tool naming and symbols across the iOS product.
enum AgentToolPresentation {
    static func symbol(for toolName: String) -> String {
        switch toolName {
        case "browser", "browser_use":          return "globe"
        case "shell", "shell_execute":          return "terminal"
        case "file_read":                       return "doc.text"
        case "file_write":                      return "doc.text.fill"
        case "file_edit":                       return "pencil.line"
        case "read_image":                      return "photo"
        case "memory":                          return "brain.head.profile"
        case "treasury_search", "treasury_get", "treasury_save", "treasury_update": return "archivebox.fill"
        case "mail_search", "mail_read", "mail_folders", "mail_accounts": return "envelope.fill"
        case "text":                            return "bubble.left"
        case "thinking":                        return "lightbulb.max"
        case "code_interpret":                  return "chevron.left.forwardslash.chevron.right"
        case "ask_user":                        return "questionmark.bubble.fill"
        default:                                return "ellipsis.circle"
        }
    }

    static func displayName(for toolName: String) -> String {
        switch toolName {
        case "browser", "browser_use":          return AppLocalized("Browser")
        case "shell", "shell_execute":          return AppLocalized("Shell")
        case "file_read":                       return AppLocalized("Read File")
        case "file_write":                      return AppLocalized("Write File")
        case "file_edit":                       return AppLocalized("Edit File")
        case "read_image":                      return AppLocalized("Read Image")
        case "memory":                          return AppLocalized("Memory")
        case "treasury_search":                 return AppLocalized("Search Treasury")
        case "treasury_get":                    return AppLocalized("Read Treasury")
        case "treasury_save":                   return AppLocalized("Save to Treasury")
        case "treasury_update":                 return AppLocalized("Update Treasury")
        case "mail_search":                     return AppLocalized("Search Mail")
        case "mail_read":                       return AppLocalized("Read Mail")
        case "mail_folders", "mail_accounts":   return AppLocalized("Mail")
        case "text":                            return AppLocalized("Responding")
        case "thinking":                        return AppLocalized("Thinking…")
        case "code_interpret":                  return AppLocalized("Code")
        case "ask_user":                        return AppLocalized("等你回答")
        default:                                return AppLocalized("Working")
        }
    }

    static func phase(for toolName: String) -> AgentActivityPhase {
        switch toolName {
        case "thinking": .thinking
        case "text": .preparing
        default: .usingTool
        }
    }
}

/// Progress reported to the system for a background agent run
/// (BGContinuedProcessingTask).
///
/// An agent run has no known length. The old estimate (8% per loop, capped at
/// 92%) froze after eleven iterations and between long iterations, and the
/// scheduler force-expires tasks that "appear stalled" — which is how long runs
/// ended in a system "failed" banner. This curve approaches 95% and then keeps
/// moving one unit per event, so progress changes exactly as long as work does.
enum ContinuedProcessingProgress {
    /// Large so the curve can keep creeping forward for days without hitting the end.
    static let scale: Int64 = 1_000_000

    /// Next value after one more unit of real work: always higher than
    /// `previous`, never the finished value.
    static func next(after previous: Int64, events: Int) -> Int64 {
        let curve = Int64(Double(scale) * 0.95 * (1 - exp(-Double(events) / 120)))
        return min(scale - 1, max(previous + 1, curve))
    }
}

// MARK: - Resting outcome [T-la-honest-outcome]

extension LiveSessionSnapshot.RestingOutcome {
    /// How a run rests on the Live Activity once it left the tracker, from the
    /// final phase `SessionActivityTracker.setInactive` recorded. Only a real
    /// ending gets a verdict: `.suspended` (background time ran out, resumes on
    /// its own) is `.paused`, never `.attention`.
    /// [leo] 以前「等你批准 / 可续跑的中断 / 结果没回执」全落进 `.attention`,
    /// 和真失败一个橙色感叹号。现在只有 `.failed` 才是 `.attention`。
    init(ending phase: AgentActivityPhase?, reason: AgentActivityReason? = nil) {
        switch phase {
        case .cancelled: self = .stopped
        case .suspended: self = .paused
        case .failed: self = .attention
        case .waitingForPermission: self = .waiting
        case .waitingForUser:
            self = reason == .userQuestion || reason == .permissionApproval ? .waiting : .interrupted
        case .unverified: self = .unknown
        default: self = .done
        }
    }
}

/// [leo] 一次运行怎么收尾的那句话 —— 灵动岛、桌面小组件、通知、系统后台进度条
/// 共用这一份,所以四处说法一致:「失败：网络中断」「等你批准」「已中断，回到 App 继续」…
/// 只用稳定的原因码拼,不带任何对话内容,隐私模式也能直接显示。
struct AgentRunEnding: Equatable, Sendable {
    let outcome: LiveSessionSnapshot.RestingOutcome
    let reason: AgentActivityReason?

    init(phase: AgentActivityPhase?, reason: AgentActivityReason?) {
        outcome = LiveSessionSnapshot.RestingOutcome(ending: phase, reason: reason)
        self.reason = reason
    }

    var isFailure: Bool { outcome == .attention }

    var label: String {
        switch outcome {
        case .attention:
            guard let why = reason.flatMap(Self.failureCause) else { return outcome.label }
            return AppLocalized("失败：\(why)")
        case .waiting:
            return reason == .userQuestion ? AppLocalized("等你回答") : AppLocalized("等你批准")
        default:
            return outcome.label
        }
    }

    /// 失败原因的短说法;nil = 说不清,只写「失败」。
    static func failureCause(_ reason: AgentActivityReason) -> String? {
        switch reason {
        case .connectionDropped: AppLocalized("网络中断")
        case .authenticationRequired: AppLocalized("服务商认证失败")
        case .rateLimited: AppLocalized("请求太频繁")
        case .kernelUnavailable: AppLocalized("执行环境不可用")
        case .toolFailure: AppLocalized("工具出错")
        case .providerFailure: AppLocalized("模型服务出错")
        case .responseLimit: AppLocalized("输出超出上限")
        case .backgroundTimeExpired: AppLocalized("后台时间用完")
        case .unexpectedTermination: AppLocalized("App 被系统结束")
        case .concurrencyLimit: AppLocalized("同时运行的任务太多")
        default: nil
        }
    }
}
