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

    var isTerminal: Bool {
        switch self {
        case .completed, .failed, .cancelled: true
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
        if text.contains("kernel") || text.contains("rootfs") || text.contains("ish") {
            return .kernelUnavailable
        }
        if text.contains("unauthorized") || text.contains("authentication")
            || text.contains("api key") || text.contains("credential")
            || text.contains("401") || text.contains("403") {
            return .authenticationRequired
        }
        if text.contains("rate limit") || text.contains("quota") || text.contains("429") {
            return .rateLimited
        }
        if text.contains("timed out") || text.contains("timeout")
            || text.contains("offline") || text.contains("network")
            || text.contains("connection") {
            return .connectionDropped
        }
        if text.contains("tool") || text.contains("command") || text.contains("process") {
            return .toolFailure
        }
        return .providerFailure
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

    init(
        id: String = UUID().uuidString,
        runId: String,
        sessionId: String,
        at: Date = Date(),
        kind: AgentActivityEventKind,
        phase: AgentActivityPhase,
        toolName: String? = nil,
        reason: AgentActivityReason? = nil
    ) {
        self.id = id
        self.runId = runId
        self.sessionId = sessionId
        self.at = at
        self.kind = kind
        self.phase = phase
        self.toolName = toolName
        self.reason = reason
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
        case "text":                            return "bubble.left"
        case "thinking":                        return "lightbulb.max"
        case "code_interpret":                  return "chevron.left.forwardslash.chevron.right"
        default:                                return "ellipsis.circle"
        }
    }

    static func displayName(for toolName: String) -> String {
        switch toolName {
        case "browser", "browser_use":          return "Browser"
        case "shell", "shell_execute":          return "Shell"
        case "file_read":                       return "Read File"
        case "file_write":                      return "Write File"
        case "file_edit":                       return "Edit File"
        case "read_image":                      return "Read Image"
        case "memory":                          return "Memory"
        case "text":                            return "Responding"
        case "thinking":                        return "Thinking"
        case "code_interpret":                  return "Code"
        default:                                return "Working"
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
