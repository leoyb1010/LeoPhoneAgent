import Foundation

/// Determines offload / compact / exhausted thresholds based on model context window size.
///
/// Tiers:
/// - **< 32K**: No auto-offload, no auto-compact. Prompt "start new / clear" when full.
/// - **32K–64K**: Auto-offload when remaining ≤ 10K. No auto-compact (user can manually).
///   Prompt "start new / clear" when exhausted.
/// - **64K–128K**: Auto-offload when remaining ≤ 20K. Auto-compact when remaining ≤ 10K.
/// - **≥ 128K**: Auto-offload when remaining ≤ 40K. Auto-compact when remaining ≤ 20K.
struct ContextPolicy {
    /// Tokens used must exceed this to trigger auto-offload. 0 = offload disabled.
    let offloadThreshold: Int
    /// Target token count after offloading. 0 = offload everything eligible.
    let offloadTarget: Int
    /// Tokens used must exceed this to trigger auto-compact. 0 = auto-compact disabled.
    let compactThreshold: Int
    /// When true, reaching the limit shows "start new session / clear" instead of compact.
    let exhaustedOnly: Bool
    /// Whether user-initiated manual compact is allowed.
    let manualCompactAllowed: Bool

    /// [T-ctx-user-cap] A user-chosen group cap ("Limit Context Window") is NOT
    /// the same thing as a model's native window, and the tier table below only
    /// makes sense for the latter. The fixed 10K/20K/40K headroom subtractions —
    /// and disabling auto-compact under 64K — exist because a genuinely small
    /// model cannot afford a summary plus warm-up turns. When the user caps a 1M
    /// model at 32K none of that holds, so a user cap gets proportional
    /// thresholds (offload 70%, settle back to 55%, compact 85%) and always
    /// keeps auto-compact available.
    static let userCapOffloadFraction = 0.70
    static let userCapOffloadTargetFraction = 0.55
    static let userCapCompactFraction = 0.85

    init(contextWindow: Int, isUserCap: Bool = false) {
        if isUserCap {
            offloadThreshold = Int(Double(contextWindow) * Self.userCapOffloadFraction)
            offloadTarget = Int(Double(contextWindow) * Self.userCapOffloadTargetFraction)
            compactThreshold = Int(Double(contextWindow) * Self.userCapCompactFraction)
            exhaustedOnly = false
            manualCompactAllowed = true
            return
        }
        if contextWindow < 32_000 {
            // < 32K: no offload, no compact
            offloadThreshold = 0
            offloadTarget = 0
            compactThreshold = 0
            exhaustedOnly = true
            manualCompactAllowed = false
        } else if contextWindow < 64_000 {
            // 32K–64K: offload when remaining ≤ 10K, no auto-compact
            offloadThreshold = contextWindow - 10_000
            offloadTarget = contextWindow - 15_000
            compactThreshold = 0
            exhaustedOnly = true
            manualCompactAllowed = true
        } else if contextWindow < 128_000 {
            // 64K–128K: offload when remaining ≤ 20K, compact when remaining ≤ 10K
            offloadThreshold = contextWindow - 20_000
            offloadTarget = contextWindow - 30_000
            compactThreshold = contextWindow - 10_000
            exhaustedOnly = false
            manualCompactAllowed = true
        } else {
            // ≥ 128K: offload when remaining ≤ 40K, compact when remaining ≤ 20K
            offloadThreshold = contextWindow - 40_000
            offloadTarget = contextWindow - 60_000
            compactThreshold = contextWindow - 20_000
            exhaustedOnly = false
            manualCompactAllowed = true
        }
    }

    // MARK: - Pre-send Check

    /// Pre-send context check result.
    enum CheckResult {
        /// Context is fine, proceed normally.
        case ok
        /// Context is near capacity — auto-compact before sending.
        case needsCompact
        /// Context is exhausted — prompt user to start new session or clear chat.
        case exhausted
    }

    /// Evaluate current token usage against policy thresholds.
    func check(estimatedTokens: Int, contextWindow: Int) -> CheckResult {
        // Check compact threshold first (only for tiers that support auto-compact)
        if compactThreshold > 0, estimatedTokens >= compactThreshold {
            return .needsCompact
        }

        // [T-ctx-overflow-hard-stop] Already at or past the window. Whatever the
        // tier says about headroom is moot — the next request does not fit.
        // Compact if this tier can, otherwise report exhausted so the caller
        // prompts instead of sending a request that cannot succeed. Without
        // this an exhausted-only tier answered `.ok` past 100%.
        if contextWindow > 0, estimatedTokens >= contextWindow {
            return manualCompactAllowed ? .needsCompact : .exhausted
        }

        // For tiers where auto-compact is disabled, check if context is exhausted
        if exhaustedOnly {
            let exhaustedThreshold = offloadThreshold > 0
                ? offloadThreshold
                : Int(Double(contextWindow) * 0.90)
            if estimatedTokens >= exhaustedThreshold {
                return .exhausted
            }
        }

        return .ok
    }

    /// Whether auto-offload should trigger at the given token count.
    func shouldOffload(estimatedTokens: Int) -> Bool {
        offloadThreshold > 0 && estimatedTokens >= offloadThreshold
    }

    /// What the agent loop does with its next request (see `inLoopStep`).
    enum InLoopStep: Equatable {
        /// Under the compact line — send.
        case proceed
        /// Compact in place, then re-check.
        case compact
        /// Compaction can do no more, but the request fits the window — send.
        case sendWithinWindow
        /// Over the window only by the calibrated extrapolation — send once for the provider to decide.
        case sendUncalibratedOnce
        /// Does not fit and nothing left to try.
        case stop
    }

    /// [T-ctx-measure-outbound] The in-loop guard's decision table. Every branch
    /// that is not `.compact` or `.stop` exists to keep a session from wedging:
    /// above the compact line is still sendable, and an "over the window" that
    /// rests only on a ratio gets one real request, whose answer or rejection
    /// then corrects the ratio.
    ///
    /// `canCompact` = compaction budget left AND the last pass made progress.
    /// `rawTokens` = the same request with no calibration applied.
    /// A window of 0 (unknown) never stops a request.
    static func inLoopStep(verdict: CheckResult, measured: Int, rawTokens: Int, window: Int,
                           canCompact: Bool, ratio: Double, uncalibratedSendUsed: Bool) -> InLoopStep {
        switch verdict {
        case .ok: return .proceed
        case .exhausted: return .stop
        case .needsCompact:
            if canCompact { return .compact }
            if window <= 0 || measured < window { return .sendWithinWindow }
            if !uncalibratedSendUsed, ratio > 1.0, rawTokens < window { return .sendUncalibratedOnce }
            return .stop
        }
    }
}

// MARK: - Compact stream deadlines [T-ios-compact-no-timeout]

extension AIChatViewModel {
    /// No chunk for this long = the summary stream is dead.
    static let compactStallLimit: TimeInterval = 120
    /// Wall-clock backstop for a stream that dribbles just often enough to
    /// keep resetting the stall clock.
    static let compactOverallLimit: TimeInterval = 900

    /// [T-compact-segment-retry-any-error] Should a failed summary attempt be
    /// retried by splitting the input in half? Everything EXCEPT the cases where
    /// a smaller request cannot help: cancellation, network/offline, a watchdog
    /// timeout (the halves inherit the same deadlines), and quota/auth (the
    /// fallback loop has already walked every candidate by then).
    static func isSegmentRetryableError(_ error: Error) -> Bool {
        if error is CancellationError || error is CompactStreamTimeout { return false }
        if let llm = error as? LLMError {
            switch llm {
            case .cancelled, .networkError, .rateLimited, .invalidAPIKey, .transientError:
                return false
            case .providerError, .decodingError, .unknown:
                // providerError covers the context-length rejections that
                // splitting genuinely fixes.
                return true
            }
        }
        if (error as NSError).domain == NSURLErrorDomain { return false }
        return true
    }
}

/// The compact summary stream hit a watchdog deadline. Distinct from
/// `LLMError` so neither the split retry nor the model fallback re-runs a
/// request that already cost up to 15 minutes.
struct CompactStreamTimeout: LocalizedError {
    let breach: CompactStreamProgress.Breach
    var errorDescription: String? { breach.userMessage }
}

/// Tracks liveness of the compact summary stream so a watchdog can cut it off.
/// An actor because the consumer (main actor) and the watchdog both touch it.
actor CompactStreamProgress {
    enum Breach: Equatable, Sendable {
        case stalled(TimeInterval)
        case overall(TimeInterval)

        var logLabel: String {
            switch self {
            case .stalled(let s): return "stalled \(Int(s))s with no data"
            case .overall(let s): return "exceeded \(Int(s))s overall"
            }
        }

        /// A stall is usually the connection; an overrun usually means the
        /// input was too big to summarize in time.
        var userMessage: String {
            switch self {
            case .stalled(let s): return String(localized: "模型 \(Int(s)) 秒没有响应")
            case .overall(let s): return String(localized: "\(Int(s)) 秒内没有完成")
            }
        }
    }

    private let overallLimit: TimeInterval
    private let stallLimit: TimeInterval
    private let startedAt: Date
    private var lastChunkAt: Date
    private var recorded: Breach?
    private let now: @Sendable () -> Date

    init(overallLimit: TimeInterval, stallLimit: TimeInterval, now: @escaping @Sendable () -> Date = { Date() }) {
        self.overallLimit = overallLimit
        self.stallLimit = stallLimit
        self.now = now
        let t = now()
        self.startedAt = t
        self.lastChunkAt = t
    }

    /// Called for every chunk — resets the stall clock.
    func touch() { lastChunkAt = now() }

    /// Non-nil once a deadline has passed.
    func breach() -> Breach? {
        let t = now()
        let sinceChunk = t.timeIntervalSince(lastChunkAt)
        if sinceChunk >= stallLimit { return .stalled(sinceChunk) }
        let total = t.timeIntervalSince(startedAt)
        if total >= overallLimit { return .overall(total) }
        return nil
    }

    /// Remember why the consumer was cancelled, so the catch can tell a
    /// timeout apart from a user Stop (both arrive as CancellationError).
    func recordBreach(_ b: Breach) { recorded = b }
    func breachReason() -> Breach? { recorded }
}
