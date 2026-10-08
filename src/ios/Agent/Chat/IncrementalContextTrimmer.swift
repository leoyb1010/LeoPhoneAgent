import Foundation

/// [T-ctx-incremental-trim] Send-time, reversible trimming of OLD history.
///
/// Compaction is the big hammer: one LLM call, a summary, and the cached prompt
/// prefix is gone. Most of what fills a long agent session, though, is not the
/// conversation itself but its by-products — reasoning trails the model will
/// never look at again, multi-kilobyte tool outputs from many turns ago. This
/// trims those from the copy of the history that is about to be SENT; the
/// stored `agentHistory` and the database are never touched, so turning the
/// feature off (or reverting a compaction) restores everything verbatim.
///
/// Three tiers, applied only to messages before the WATERMARK:
///   1. `reasoningContent` of old assistant turns is set to "" — present but
///      empty. Our OpenAI-compatible path echoes the field whenever it is
///      non-nil ("presence is the trigger"), and Mimo / DeepSeek V4 / Kimi
///      reject a tool-call turn whose field is missing but accept "" (it is what
///      they emit for non-thinking turns; DeepSeek only requires the echo on
///      tool-call turns of the CURRENT exchange). A nil stays nil.
///   2. Large tool results are cut to head + tail with a hint telling the model
///      how to get the rest back.
///   3. Tool call/result pairs well before the watermark are folded to one-line
///      stubs. Ids, names and pairing are kept, so no provider sees an orphan.
/// User text, assistant text, images and the compaction summary are never
/// changed.
///
/// Prompt cache: a provider cache (Anthropic breakpoints on the last two user
/// messages, DeepSeek/Kimi/OpenAI automatic prefix caching) survives only while
/// the request prefix is byte-identical. The trimmed form of a message depends
/// on the watermark alone, and the watermark only ever sits on a user-turn
/// start (where the cache breakpoints are) and only moves when doing so frees
/// at least `chunkMinTokens` — so the prefix changes once per chunk instead of
/// every turn, and never inside a tool loop (the user turns do not move there).
enum IncrementalContextTrimmer {

    // MARK: Feature flag

    static let enabledKey = "leo.context.incrementalTrim"

    /// Default ON; the setting writes `false` to turn it off.
    static var isEnabled: Bool {
        UserDefaults.standard.object(forKey: enabledKey) as? Bool ?? true
    }

    // MARK: Configuration

    struct Config: Equatable {
        /// User turns kept verbatim at the tail: the current one and the one before it.
        var keepRecentUserTurns = 2
        /// Pairs this many user turns before the watermark (and older) are folded.
        var foldLagUserTurns = 4
        /// Tool results longer than this are cut to head + tail.
        var largeToolResultChars = 4_000
        var headChars = 1_500
        var tailChars = 500
        /// Folded tool-call string arguments keep this many characters.
        var foldArgPreviewChars = 160
        /// The watermark only moves when that frees at least this many tokens
        /// (unless the context is under pressure).
        var chunkMinTokens = 6_000

        static let standard = Config()
    }

    static let truncationMarker = "[context-trim:"
    static let foldMarker = "[folded tool result]"

    // MARK: Plan

    struct Plan: Equatable {
        /// Messages `[0, boundary)` get tiers 1–2.
        var boundary: Int
        /// Messages `[0, foldBoundary)` also get tier 3.
        var foldBoundary: Int
        /// Identity of the user-turn message the watermark sits on (nil = none).
        var watermarkKey: String?
        /// The watermark moved forward on this plan.
        var advanced: Bool
        /// Estimated tokens the plan removes from the request.
        var savedTokens: Int

        static let none = Plan(boundary: 0, foldBoundary: 0, watermarkKey: nil, advanced: false, savedTokens: 0)
    }

    /// A user message that starts a turn: has non-empty text and carries no
    /// tool result (tool results are user-role too; cutting before one would
    /// separate it from its call).
    static func startsUserTurn(_ msg: AgentMessage) -> Bool {
        guard msg.role == .user else { return false }
        var hasText = false
        for part in msg.parts {
            switch part {
            case .toolResult: return false
            case .text(let t): if !t.isEmpty { hasText = true }
            default: break
            }
        }
        return hasText
    }

    /// Stable identity of a message across requests: its DB id once persisted.
    /// The fallback (role + index) only has to survive the current turn — the
    /// watermark message is at least one user turn old, so it is persisted.
    static func key(of msg: AgentMessage, at index: Int) -> String {
        msg.dbMessageId ?? "idx:\(index)"
    }

    /// Decide where the watermark sits for this request. Pure.
    ///
    /// - `previousKey`: the watermark the last request used (nil when none).
    /// - `underPressure`: the context is near its offload line — move the
    ///   watermark as far as allowed regardless of chunk size, because a cache
    ///   miss is cheaper than a compaction.
    static func plan(history: [AgentMessage], previousKey: String?, underPressure: Bool,
                     config: Config = .standard) -> Plan {
        let turnStarts = history.indices.filter { startsUserTurn(history[$0]) }
        guard config.keepRecentUserTurns > 0, turnStarts.count > config.keepRecentUserTurns else {
            // Fewer than keep+1 user turns: nothing is old enough.
            return .none
        }
        let desired = turnStarts[turnStarts.count - config.keepRecentUserTurns]

        // Where the previous request had it. Not found (compaction reshaped the
        // slice, history was truncated) = start from no watermark.
        var current = 0
        if let previousKey,
           let idx = turnStarts.first(where: { key(of: history[$0], at: $0) == previousKey }) {
            current = min(idx, desired)
        }

        var boundary = current
        var advanced = false
        if desired > current {
            let gain = savings(history, from: current, to: desired, turnStarts: turnStarts, config: config)
            if underPressure ? gain > 0 : gain >= config.chunkMinTokens {
                boundary = desired
                advanced = true
            }
        }
        guard boundary > 0 else { return .none }
        let fold = foldBoundary(for: boundary, turnStarts: turnStarts, config: config)
        let saved = ContextSizeMeter.estimateTokens(Array(history[0..<boundary]))
            - ContextSizeMeter.estimateTokens(apply(Array(history[0..<boundary]), boundary: boundary,
                                                    foldBoundary: fold, config: config))
        return Plan(boundary: boundary, foldBoundary: fold,
                    watermarkKey: key(of: history[boundary], at: boundary),
                    advanced: advanced, savedTokens: max(0, saved))
    }

    static func foldBoundary(for boundary: Int, turnStarts: [Int], config: Config) -> Int {
        guard let pos = turnStarts.firstIndex(of: boundary) else { return 0 }
        let foldPos = pos - config.foldLagUserTurns
        return foldPos > 0 ? turnStarts[foldPos] : 0
    }

    /// Tokens freed by moving the watermark from `from` to `to`.
    private static func savings(_ history: [AgentMessage], from: Int, to: Int,
                                turnStarts: [Int], config: Config) -> Int {
        let before = apply(history, boundary: from,
                           foldBoundary: foldBoundary(for: from, turnStarts: turnStarts, config: config),
                           config: config)
        let after = apply(history, boundary: to,
                          foldBoundary: foldBoundary(for: to, turnStarts: turnStarts, config: config),
                          config: config)
        return ContextSizeMeter.estimateTokens(Array(before[0..<to]))
            - ContextSizeMeter.estimateTokens(Array(after[0..<to]))
    }

    // MARK: Apply

    /// The trimmed copy of `history`. Pure, idempotent, never touches messages
    /// at or after `boundary`.
    static func apply(_ history: [AgentMessage], boundary: Int, foldBoundary: Int,
                      config: Config = .standard) -> [AgentMessage] {
        guard boundary > 0 else { return history }
        var out = history
        for i in 0..<min(boundary, history.count) {
            var msg = history[i]
            let fold = i < foldBoundary
            if msg.role == .assistant, let rc = msg.reasoningContent, !rc.isEmpty {
                msg.reasoningContent = ""
            }
            var changed = false
            let parts = msg.parts.map { part -> AgentContentPart in
                switch part {
                case .toolResult(let id, let name, let content, let isError, let img, let mime, let url, let path):
                    let trimmed = fold
                        ? foldedResult(name: name, content: content, isError: isError)
                        : truncatedResult(content, config: config)
                    guard trimmed != content else { return part }
                    changed = true
                    return .toolResult(id: id, name: name, content: trimmed, isError: isError,
                                       imageData: img, imageMimeType: mime, pageURL: url, imageLinuxPath: path)
                case .toolUse(let id, let name, let input) where fold:
                    let folded = foldedInput(input, config: config)
                    guard let folded else { return part }
                    changed = true
                    return .toolUse(id: id, name: name, input: folded)
                default:
                    return part
                }
            }
            if changed { msg.parts = parts }
            out[i] = msg
        }
        return out
    }

    /// Tier 2: head + tail with a recovery hint. Shorter content is returned as is.
    static func truncatedResult(_ content: String, config: Config) -> String {
        guard content.count > config.largeToolResultChars,
              !content.hasPrefix(foldMarker) else { return content }
        let omitted = content.count - config.headChars - config.tailChars
        return String(content.prefix(config.headChars))
            + "\n\n\(truncationMarker) \(omitted) of \(content.count) characters omitted from this old tool result to save context. "
            + "Re-run the tool, or use file_read with offset/lines on the source file, if you need the omitted part.]\n\n"
            + String(content.suffix(config.tailChars))
    }

    /// Tier 3: a one-line stub. Already-folded content is returned as is.
    static func foldedResult(name: String, content: String, isError: Bool) -> String {
        guard !content.hasPrefix(foldMarker) else { return content }
        let firstLine = content.split(whereSeparator: \.isNewline).first.map(String.init) ?? ""
        let preview = firstLine.count > 100 ? String(firstLine.prefix(100)) + "…" : firstLine
        return "\(foldMarker) \(name)\(isError ? " (error)" : ""): \(preview) (\(content.count) chars; re-run the tool if needed)"
    }

    /// Tier 3 for the call side: long string arguments (file_write content,
    /// long commands) are shortened. Keys are kept. nil = nothing to shorten.
    static func foldedInput(_ input: [String: Any], config: Config) -> [String: Any]? {
        var out = input
        var changed = false
        for (k, v) in input {
            guard let s = v as? String, s.count > config.foldArgPreviewChars + 40 else { continue }
            out[k] = String(s.prefix(config.foldArgPreviewChars)) + "… [\(s.count) chars folded]"
            changed = true
        }
        return changed ? out : nil
    }
}

/// [T-ios-compact-orphan-toolcall] Every tool result in an outgoing request must
/// have its call in the same request and vice versa, or OpenAI-compatible APIs
/// reject it ("No tool call found for function call output …") on every retry
/// and every fallback model. The full-history pass at the top of the agent loop
/// cannot catch this: compaction slices the history AFTER it runs.
enum OutgoingToolPairing {
    /// The identity two tool parts are PAIRED by. The OpenAI Responses path
    /// carries a combined `"<call_id>|<fc_id>"` id and matches on the call_id
    /// half on the wire, so this layer must too. Comparison only — parts keep
    /// their original ids.
    static func pairingKey(_ id: String) -> String {
        guard let pipe = id.firstIndex(of: "|") else { return id }
        return String(id[id.startIndex..<pipe])
    }

    static let interruptedPlaceholder = "Tool execution was interrupted by an unexpected error."

    /// - orphaned result → dropped (its call is gone, nothing can rebuild it);
    /// - orphaned call → an error result is synthesised right after its turn
    ///   (deleting the call would discard the assistant's own step).
    /// Calls in the FINAL assistant message are exempt: between "model asked
    /// for tools" and "results appended" they are legitimately unanswered.
    /// Messages emptied by the drop are removed.
    static func repair(_ history: [AgentMessage]) -> (history: [AgentMessage], orphanedResults: Int, orphanedCalls: Int) {
        var toolUseIds: Set<String> = []
        var toolResultIds: Set<String> = []
        for msg in history {
            for part in msg.parts {
                switch part {
                case .toolUse(let id, _, _): toolUseIds.insert(pairingKey(id))
                case .toolResult(let id, _, _, _, _, _, _, _): toolResultIds.insert(pairingKey(id))
                default: break
                }
            }
        }
        let orphanedResults = toolResultIds.subtracting(toolUseIds)
        var orphanedUses = toolUseIds.subtracting(toolResultIds)
        if let last = history.last, last.role == .assistant {
            for part in last.parts {
                if case .toolUse(let id, _, _) = part { orphanedUses.remove(pairingKey(id)) }
            }
        }
        guard !orphanedResults.isEmpty || !orphanedUses.isEmpty else { return (history, 0, 0) }

        var cleaned: [AgentMessage] = []
        cleaned.reserveCapacity(history.count)
        for var msg in history {
            let kept = msg.parts.filter { part in
                if case .toolResult(let id, _, _, _, _, _, _, _) = part {
                    return !orphanedResults.contains(pairingKey(id))
                }
                return true
            }
            if kept.isEmpty { continue }
            msg.parts = kept
            cleaned.append(msg)
            guard msg.role == .assistant else { continue }
            let unanswered = kept.compactMap { part -> (String, String)? in
                if case .toolUse(let id, let name, _) = part, orphanedUses.contains(pairingKey(id)) {
                    return (id, name)
                }
                return nil
            }
            if !unanswered.isEmpty {
                cleaned.append(AgentMessage(role: .user, parts: unanswered.map { id, name in
                    AgentContentPart.toolResult(id: id, name: name, content: interruptedPlaceholder, isError: true)
                }))
            }
        }
        return (cleaned, orphanedResults.count, orphanedUses.count)
    }
}
