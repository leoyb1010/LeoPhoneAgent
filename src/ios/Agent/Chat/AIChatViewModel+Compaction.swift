import Foundation

private let logger = AppLogger(category: "AIChatVM")

// MARK: - Context Compaction

extension AIChatViewModel {

    // MARK: - Context Compaction

    /// Check context usage against the model's policy thresholds.
    /// Resolves the entry via `resolveCurrentEntry()` — the SAME resolution the
    /// send path uses (availability re-routing, cachedSessionModelId fallback,
    /// default group) — so capacity is always judged against the model that
    /// will actually serve the request. The previous manual dig through
    /// `binding.primarySource` could disagree with the send path in two ways:
    /// a group's stale resolvedEntryId (member since disabled/hidden) judged
    /// capacity by the WRONG member's window, and sessions without a binding
    /// (e.g. iCloud-synced) skipped capacity checks entirely.
    func checkContextBeforeSend(site: String = "pre-send") -> ContextPolicy.CheckResult {
        guard let entry = resolveCurrentEntry() else { return .ok }
        let resolved = resolvedContextWindow(for: entry.model)
        let contextWindow = resolved.window
        guard contextWindow > 0 else { return .ok }

        let policy = ContextPolicy(contextWindow: contextWindow, isUserCap: resolved.isUserCap)
        // [T-ctx-measure-outbound] Judge the request that is about to go out:
        // the compaction-aware, trimmed outbound history plus system prompt and
        // tool schemas, scaled by the ratio the provider's own count gave us.
        // The old `chars / 3.5` over history alone read CJK at a third of its
        // size and ignored the system prompt, tools and reasoning echo.
        ensureContextFixedTokens()
        let m = contextMeasurement()
        let result = policy.check(estimatedTokens: m.measured, contextWindow: contextWindow)
        let markerInfo: String
        if let marker = cachedLatestMarker {
            let ageSec = Int(Date().timeIntervalSince(marker.createdAt))
            markerInfo = "marker=\(marker.id.prefix(8)) ageSec=\(ageSec) summaryChars=\(marker.summary.count)"
        } else {
            markerInfo = "marker=nil"
        }
        logger.info("[CtxMeter] decide site=\(site) model=\(entry.model.id) history=\(m.history) fixed=\(m.fixed) ratio=\(String(format: "%.3f", m.ratio))(\(m.source)) measured=\(m.measured) threshold=\(policy.compactThreshold) window=\(contextWindow) userCap=\(resolved.isUserCap) → \(String(describing: result)) | \(markerInfo) | agentHistory.count=\(self.agentHistory.count)")
        if result != .ok {
            DiagnosticRing.shared.record(.contextDecision, sessionId: sessionId, model: entry.model.id, entryId: "ctx.\(site)",
                                         message: "\(result) measured=\(m.measured) window=\(contextWindow) ratio=\(String(format: "%.2f", m.ratio))")
        }
        return result
    }

    // MARK: - Outbound context measurement [T-ctx-measure-outbound]

    /// The model the next request is judged for — the same resolution the send
    /// path and the capacity check use.
    func currentContextModelId() -> String? { resolveCurrentEntry()?.model.id }

    /// Calibration ratio for `modelId` (default: the current model).
    func contextCalibrationRatio(for modelId: String? = nil) -> Double {
        ContextSizeMeter.ratio(for: modelId ?? currentContextModelId(),
                               known: contextCalibrationRatios, lastLearned: lastLearnedCalibration)
    }

    /// Estimated size of the next request, calibrated. The one number every
    /// capacity decision reads (compact guard, offload, `max_tokens`).
    func measureOutboundContextTokens(ratio: Double? = nil) -> Int {
        contextMeasurement(ratio: ratio).measured
    }

    /// The measurement with its parts, for the [CtxMeter] logs.
    struct ContextMeasurement {
        let history: Int, fixed: Int, ratio: Double, source: String, measured: Int
    }

    /// Measures exactly what `effectiveAgentHistory()` will send — compaction
    /// slice plus incremental trim — without committing the trim watermark.
    func contextMeasurement(ratio override: Double? = nil) -> ContextMeasurement {
        let history = ContextSizeMeter.estimateTokens(outboundAgentHistory(commitTrim: false))
        let model = currentContextModelId()
        let ratio = override ?? contextCalibrationRatio(for: model)
        let source = override != nil ? "forced"
            : ContextSizeMeter.ratioSource(for: model, known: contextCalibrationRatios, lastLearned: lastLearnedCalibration)
        return ContextMeasurement(history: history, fixed: contextFixedTokens, ratio: ratio, source: source,
                                  measured: ContextSizeMeter.calibrated(history + contextFixedTokens, ratio: ratio))
    }

    /// The send-time capacity check runs before any agent loop has built this
    /// turn's system prompt. Without a fixed share the check would judge
    /// history alone; the loop replaces this with the exact figure for its
    /// own system prompt and tool list before its first request.
    func ensureContextFixedTokens() {
        guard contextFixedTokens == 0, let entry = resolveCurrentEntry() else { return }
        contextFixedTokens = ContextSizeMeter.estimateFixedTokens(
            systemPrompt: composeUserSystemPrompt(for: entry.model), tools: makeAgentTools())
    }

    /// Record the estimate of the request being dispatched, so the provider's
    /// count for it can calibrate the meter. Returns the calibrated size.
    @discardableResult
    func recordContextDispatch(history: [AgentMessage], model: LLMModel) -> Int {
        lastDispatchEstimate = ContextSizeMeter.estimateTokens(history) + contextFixedTokens
        lastDispatchModelId = model.id
        lastDispatchWindow = resolvedContextWindow(for: model).window
        lastDispatchRatio = contextCalibrationRatio(for: model.id)
        lastDispatchPredicted = ContextSizeMeter.calibrated(lastDispatchEstimate, ratio: lastDispatchRatio)
        return lastDispatchPredicted
    }

    /// Fold in the provider's count for the request recorded by
    /// `recordContextDispatch`, for the model that actually served it (a group
    /// fallback may have switched). Returns false when there was nothing to pair.
    @discardableResult
    func calibrateContextSize(reportedTokens: Int, servedModelId: String?) -> Bool {
        guard let sample = ContextSizeMeter.calibrationRatio(reported: reportedTokens,
                                                             estimated: lastDispatchEstimate) else { return false }
        let own = servedModelId.flatMap { contextCalibrationRatios[$0] }
        let updated = ContextSizeMeter.smoothed(previous: own, sample: sample)
        if let servedModelId { contextCalibrationRatios[servedModelId] = updated }
        lastLearnedCalibration = updated
        let err = lastDispatchPredicted > 0
            ? Double(lastDispatchPredicted - reportedTokens) / Double(reportedTokens) * 100 : 0
        logger.info("[CtxMeter] actual model=\(servedModelId ?? "?") predicted=\(self.lastDispatchPredicted) reported=\(reportedTokens) err=\(String(format: "%+.1f", err))% estimate=\(self.lastDispatchEstimate) sample=\(String(format: "%.3f", sample)) ratio=\(String(format: "%.3f", self.lastDispatchRatio))→\(String(format: "%.3f", updated))\(own == nil ? " (first own sample)" : "")")
        LeoPerf.record("ctx.actual", ms: 0, extra: [
            "model": servedModelId ?? "?", "predicted": lastDispatchPredicted, "reported": reportedTokens,
            "errPct": (err * 10).rounded() / 10, "ratio": (updated * 1000).rounded() / 1000,
        ])
        return true
    }

    /// A provider rejected the request as too long: ground truth that we
    /// under-read it. Raise this model's ratio until that request measures at
    /// least what the provider counted, so the retry compacts instead of being
    /// rejected again. Returns whether the error was a context-length rejection.
    @discardableResult
    func noteContextOverflow(errorText: String, modelId: String?) -> Bool {
        guard ContextSizeMeter.isContextOverflow(errorText) else { return false }
        let model = modelId ?? lastDispatchModelId ?? currentContextModelId()
        let window = lastDispatchWindow > 0
            ? lastDispatchWindow
            : (resolveCurrentEntry().map { resolvedContextWindow(for: $0.model).window } ?? 0)
        let current = contextCalibrationRatio(for: model)
        let requested = ContextSizeMeter.requestedTokens(inOverflowMessage: errorText)
        let raised = ContextSizeMeter.ratioAfterOverflow(current: current, estimated: lastDispatchEstimate,
                                                         requested: requested, window: window)
        if let model { contextCalibrationRatios[model] = raised }
        lastLearnedCalibration = raised
        // The ratio now rests on the provider's own count, so the uncalibrated
        // send-once is spent: firing it would re-send the rejected request.
        sentPastExtrapolatedLimitThisLoop = true
        logger.warning("[CtxMeter] rejected predicted=\(self.lastDispatchPredicted) — provider rejected the request as too long — calibration model=\(model ?? "?") \(String(format: "%.2f", current)) → \(String(format: "%.2f", raised)) (estimated=\(self.lastDispatchEstimate) statedTokens=\(requested.map(String.init) ?? "none") window=\(window))")
        DiagnosticRing.shared.record(.contextDecision, sessionId: sessionId, model: model, entryId: "ctx.overflow",
                                     message: "ratio \(String(format: "%.2f", current))→\(String(format: "%.2f", raised)) estimate=\(lastDispatchEstimate) window=\(window)")
        return true
    }

    /// Re-derive calibration from the loaded transcript: each assistant turn
    /// that recorded BOTH its report and our estimate of the same request.
    /// Only ratios are carried over, never a raw size, so a compaction or
    /// revert done since cannot make the next decision stale. Reloading the
    /// SAME session keeps what this view model already learned (a ratio raised
    /// by a rejection exists only in memory). Returns true when a pair was found.
    @discardableResult
    func seedContextCalibration() -> Bool {
        let sameSession = sessionId != nil && calibrationSessionId == sessionId
        let learned: ContextSizeMeter.CalibrationState? = sameSession
            ? .init(ratios: contextCalibrationRatios, lastLearned: lastLearnedCalibration, fixedTokens: contextFixedTokens)
            : nil
        let samples = messages.compactMap { msg -> ContextSizeMeter.CalibrationSample? in
            guard msg.role == .assistant, let usage = msg.usage else { return nil }
            return .init(reported: usage.latestContextTokens, estimated: usage.estimatedRequestTokens,
                         fixedTokens: usage.estimatedFixedTokens, modelId: usage.calibrationModelId)
        }
        let seeded = ContextSizeMeter.replayCalibration(samples)
        let state = learned.map { seeded.carryingOver($0) } ?? seeded
        contextCalibrationRatios = state.ratios
        lastLearnedCalibration = state.lastLearned
        contextFixedTokens = state.fixedTokens
        lastDispatchEstimate = 0
        lastDispatchModelId = nil
        lastDispatchWindow = 0
        if !sameSession {
            // A spent valve and per-marker warm-up decisions are evidence about
            // THIS session; they must not carry into another one.
            sentPastExtrapolatedLimitThisLoop = false
            warmUpDropByMarker = [:]
        }
        calibrationSessionId = sessionId
        logger.info("[CtxMeter] seed session=\(self.sessionId?.prefix(8) ?? "nil") samples=\(seeded.samples) keptInMemory=\(learned?.ratios.count ?? 0) ratios=\(state.ratios.map { "\($0.key)=\(String(format: "%.3f", $0.value))" }.sorted().joined(separator: ","))")
        return seeded.samples > 0
    }

    /// [T-ctx-warmup-fit] Trim a compaction's warm-up turns so the request fits
    /// under the compact line. Only runs over budget, so a normal compaction's
    /// request (and its prompt-cache prefix) is unchanged. Drops whole user-TEXT
    /// turns from the oldest end. Works in raw-estimate units so it can be
    /// called from inside the measurement without recursing into it.
    ///
    /// `decided` is false when there was nothing to measure against yet (no
    /// entry, unknown window, fixed share not seeded): the caller must not cache
    /// that as this marker's answer.
    func trimWarmUpToFit(_ warmUp: [AgentMessage], rest: [AgentMessage], summaryText: String) -> (kept: [AgentMessage], decided: Bool) {
        guard !warmUp.isEmpty else { return (warmUp, true) }
        guard let entry = resolveCurrentEntry() else { return (warmUp, false) }
        let resolved = resolvedContextWindow(for: entry.model)
        guard resolved.window > 0, contextFixedTokens > 0 else { return (warmUp, false) }
        let policy = ContextPolicy(contextWindow: resolved.window, isUserCap: resolved.isUserCap)
        let line = policy.compactThreshold > 0 ? policy.compactThreshold : resolved.window
        let budget = Int(Double(line) / contextCalibrationRatio(for: entry.model.id)) - contextFixedTokens
        let restTokens = ContextSizeMeter.estimateTokens(rest) + ContextSizeMeter.estimateTokens(summaryText)
        guard ContextSizeMeter.estimateTokens(warmUp) + restTokens >= budget else { return (warmUp, true) }

        let drop = ContextSizeMeter.warmUpDrop(
            sizes: warmUp.map { ContextSizeMeter.estimateTokens(message: $0) },
            startsTurn: warmUp.map { IncrementalContextTrimmer.startsUserTurn($0) },
            restTokens: restTokens, budget: budget)
        logger.info("[CtxMeter] warmup trimmed to fit: kept \(warmUp.count - drop)/\(warmUp.count) message(s) (budget=\(budget) raw tokens)")
        return (Array(warmUp.dropFirst(drop)), true)
    }

    /// Compaction can do no more for this request (budget spent, no progress,
    /// or no anchor). Above the compact THRESHOLD is still sendable — that line
    /// sits below the window by design — and an over-the-window verdict that
    /// rests only on the ratio gets one real request.
    func settleWithoutCompacting() -> (step: ContextPolicy.InLoopStep, measurement: ContextMeasurement) {
        let m = contextMeasurement()
        let window = resolveCurrentEntry().map { resolvedContextWindow(for: $0.model).window } ?? 0
        let step = ContextPolicy.inLoopStep(verdict: .needsCompact, measured: m.measured, rawTokens: m.history + m.fixed,
                                            window: window, canCompact: false, ratio: m.ratio,
                                            uncalibratedSendUsed: sentPastExtrapolatedLimitThisLoop)
        return (step, m)
    }

    // MARK: - Incremental trimming [T-ctx-incremental-trim]

    /// The history the next request carries: compaction slice → incremental
    /// trim (when enabled) → orphan repair. `commitTrim` advances the stored
    /// watermark; measurement passes false so measuring never moves it (the
    /// plan is deterministic, so the send path then produces the same result).
    func outboundAgentHistory(commitTrim: Bool) -> [AgentMessage] {
        let sliced = effectiveAgentHistoryUncounted()
        let trimmed = applyIncrementalTrim(sliced, commit: commitTrim)
        return Self.dropOrphanedToolParts(trimmed)
    }

    func applyIncrementalTrim(_ sliced: [AgentMessage], commit: Bool) -> [AgentMessage] {
        guard IncrementalContextTrimmer.isEnabled else {
            if commit { lastContextTrimPlan = .none }
            return sliced
        }
        let previousKey = contextTrimWatermarkSessionId == sessionId ? contextTrimWatermarkKey : nil
        let plan = IncrementalContextTrimmer.plan(history: sliced, previousKey: previousKey,
                                                  underPressure: contextUnderTrimPressure(sliced))
        if commit {
            if plan.advanced {
                logger.info("[CtxTrim] watermark → \(plan.watermarkKey?.prefix(8) ?? "nil") boundary=\(plan.boundary) fold=\(plan.foldBoundary) saved≈\(plan.savedTokens) tok (slice=\(sliced.count))")
            }
            contextTrimWatermarkKey = plan.watermarkKey
            contextTrimWatermarkSessionId = sessionId
            lastContextTrimPlan = plan
        }
        guard plan.boundary > 0 else { return sliced }
        return IncrementalContextTrimmer.apply(sliced, boundary: plan.boundary, foldBoundary: plan.foldBoundary)
    }

    /// Near the offload line the watermark moves on any saving: a cache miss
    /// is cheaper than an offload or a compaction. Raw estimate of the
    /// untrimmed slice — the trimmed measurement would recurse into this.
    private func contextUnderTrimPressure(_ sliced: [AgentMessage]) -> Bool {
        guard let entry = resolveCurrentEntry() else { return false }
        let resolved = resolvedContextWindow(for: entry.model)
        guard resolved.window > 0 else { return false }
        let policy = ContextPolicy(contextWindow: resolved.window, isUserCap: resolved.isUserCap)
        let line = policy.offloadThreshold > 0 ? policy.offloadThreshold : Int(Double(resolved.window) * 0.7)
        let raw = ContextSizeMeter.calibrated(ContextSizeMeter.estimateTokens(sliced) + contextFixedTokens,
                                              ratio: contextCalibrationRatio(for: entry.model.id))
        return raw >= line
    }

    // MARK: - Outgoing tool pairing [T-ios-compact-orphan-toolcall]

    /// Last line of defence before a history slice becomes a provider request
    /// (see `OutgoingToolPairing.repair`). Logs loudly: an orphan reaching here
    /// is a bug upstream of it.
    static func dropOrphanedToolParts(_ history: [AgentMessage]) -> [AgentMessage] {
        let repaired = OutgoingToolPairing.repair(history)
        if repaired.orphanedResults + repaired.orphanedCalls > 0 {
            logger.warning("[CompactDiag] orphan tool parts in OUTGOING history — repaired. orphanedOutputs=\(repaired.orphanedResults) orphanedCalls=\(repaired.orphanedCalls) historyCount=\(history.count)")
        }
        return repaired.history
    }

    /// Legacy compatibility — returns true if any intervention is needed before send.
    func needsCompactBeforeSend() -> Bool {
        checkContextBeforeSend() != .ok
    }

    /// Compact then send the pending message.
    func compactAndSend() {
        showCompactBeforeSendPrompt = false
        let text = pendingSendText ?? ""
        let atts = pendingSendAttachments
        let treasuryContext = pendingSendTreasuryContext
        pendingSendTreasuryContext = nil
        pendingSendText = nil
        pendingSendRawText = nil
        pendingSendPastedBlocks = []
        pendingSendAttachments = []

        // Show the message as queued immediately
        let queuedPrompt = QueuedPrompt(text: text, attachments: atts, treasuryContext: treasuryContext)
        promptQueue.append(queuedPrompt)
        let chatMsg = ChatMessage(role: .user, content: text, isQueued: true)
        chatMsg.queuedPromptId = queuedPrompt.id
        chatMsg.inputAttachments = atts
        messages.append(chatMsg)
        scrollToBottomSignal.send()

        // Find the last active non-queued message as compact target
        let activeMessages = messages.filter {
            $0.role != .compactDivider && $0.role != .systemInfo && !$0.isCompactedHistory && !$0.isQueued
        }
        guard activeMessages.count > 1, let lastActive = activeMessages.last else {
            // Not enough to compact — send the queued message directly
            promptQueue.removeAll { $0.id == queuedPrompt.id }
            messages.removeAll { $0.queuedPromptId == queuedPrompt.id }
            let sendParked = { [self] in
                inputText = text
                attachments = atts
                pendingTreasuryContext = treasuryContext
                skipCompactCheck = true
                send()
            }
            // [T-draft-headless] A draft back in the composer (a headless send
            // was parked here) is not part of this message. The usual empty
            // composer keeps send()'s edit-in-progress handling as before.
            if currentComposerDraft.isEmpty { sendParked() } else { withComposerSetAside(sendParked) }
            return
        }

        let target = lastActive
        let requestId = UUID()
        compactAndSendRequestId = requestId
        compactTask = Task {
            defer {
                if self.compactAndSendRequestId == requestId { self.compactAndSendRequestId = nil }
            }
            await compactBefore(target.id)
            // Drain the queued prompt(s) through the SAME path normal
            // streaming uses (drainQueuedPrompts clears `isQueued` on every
            // matching placeholder and runs the agent loop) — see
            // T-ios-queued-prompt-stale-style-after-compact for why send()
            // is wrong here. On SUCCESS compactBefore's tail has already
            // scheduled the drain (postCompactDrainPending dedups this call
            // into a no-op); this backstop covers compactBefore's failure
            // exits, where the user's compact-and-send message must still go
            // out — that's this path's long-standing behavior, unlike
            // /compact whose failure leaves the queue untouched.
            // [T-compact-queued-drain]
            guard !Task.isCancelled else { return }
            self.schedulePostCompactDrain()
        }
    }

    /// [T-compact-queued-drain] Spawn the post-compact queue drain on
    /// `currentTask` so prompts enqueued DURING a compact actually run once it
    /// finishes. Every compact completion funnels through here:
    /// compactBefore's success tail (covers compactAll → /compact, the
    /// long-press Compact-Before menu, compactAndSend, and the debug RPC) plus
    /// compactAndSend's failure backstop. Running on `currentTask` — not
    /// inline in the (already state-reset) compact task — keeps Stop working:
    /// cancel() cancels currentTask, and the tail guard mirrors the
    /// stop-handover rule from T-stop-with-queue-render-desync (2d037aa5).
    /// `postCompactDrainPending` dedups the two schedulers; drainQueuedPrompts'
    /// own reentrancy guard stays the last line of defense.
    func schedulePostCompactDrain() {
        guard !promptQueue.isEmpty else { return }
        guard !postCompactDrainPending else { return }
        postCompactDrainPending = true
        logger.info("[Compact] scheduling post-compact drain — \(self.promptQueue.count) queued prompt(s)")
        currentTask = Task { @MainActor [weak self] in
            guard let self else { return }
            defer { self.postCompactDrainPending = false }
            self.errorMessage = nil
            self.isProcessing = true
            self.beginBackgroundProcessing()
            await self.drainQueuedPrompts()
            // Stop during the drained run hands state ownership to cancel()
            // (and possibly a fresh resumeQueueAfterCancel task) — don't
            // clobber it from the superseded task.
            guard !Task.isCancelled else { return }
            self.isProcessing = false
            self.endBackgroundProcessing()
        }
    }

    /// Cancel the compact-before-send prompt, restoring text to input.
    func cancelCompactBeforeSend() {
        showCompactBeforeSendPrompt = false
        if currentComposerDraft.isEmpty {
            // Restore the folded composer (tokens + chips), not the expanded body.
            inputText = pendingSendRawText ?? pendingSendText ?? ""
            pastedBlocks = pendingSendPastedBlocks
            attachments = pendingSendAttachments
        } else {
            // [T-draft-headless] The user's draft is back in the composer (the
            // parked prompt came from a headless send): keep it and add the
            // parked message after it, expanded so paste tokens can't collide.
            if let parked = pendingSendText, !parked.isEmpty {
                inputText += (inputText.isEmpty ? "" : "\n") + parked
            }
            attachments += pendingSendAttachments
        }
        pendingTreasuryContext = ComposerDraftSnapshot.mergedTreasuryContext(pendingTreasuryContext, pendingSendTreasuryContext)
        pendingSendTreasuryContext = nil
        pendingSendText = nil
        pendingSendRawText = nil
        pendingSendPastedBlocks = []
        pendingSendAttachments = []
    }

    /// Number of recent user-text turns kept verbatim as inference anchors when
    /// compactAll runs. The summary stands in for everything older; the LLM
    /// still sees the last N user-text turns + their assistant replies + tool
    /// I/O so it can answer follow-ups that need verbatim detail (specific
    /// commands, exact strings) rather than the summary's distilled form.
    static let compactKeepRecentUserTurns: Int = 3

    /// Phase 2.5 self-heal: when a marker's `lastCompactedMessageId` no longer
    /// resolves in rawMessages (id orphaned by a v1→v2 sync migration or by a
    /// row delete), recompute the anchor by createdAt.
    ///
    /// Rule: anchor = the latest raw message whose `createdAt < marker.createdAt`
    /// AND whose id is present as a `dbMessageId` in `historyDbIds`. The
    /// agentHistory-presence filter is critical: `effectiveAgentHistory()`
    /// resolves the marker via `agentHistory.lastIndex(where: dbMessageId ==
    /// lcmId)` on every send, so a healed lcmId that's not in agentHistory
    /// would re-trigger the degraded "keep last N user turns" path, making
    /// the heal cosmetic only. Pass an empty `historyDbIds` to disable the
    /// filter (returns first match by createdAt alone).
    ///
    /// Falls back to `nil` only when no qualifying raw message predates the
    /// marker (rare: session wiped down to messages newer than the marker, or
    /// every predating raw has lost its dbMessageId binding in agentHistory).
    static func anchorByCreatedAt(in rawMessages: [RawMessage], markerCreatedAt: Date, historyDbIds: Set<String>) -> RawMessage? {
        rawMessages.last { raw in
            guard raw.createdAt < markerCreatedAt else { return false }
            return historyDbIds.isEmpty || historyDbIds.contains(raw.id)
        }
    }

    /// Locate a UI message whose source-sort-order range contains the given
    /// raw message's sortOrder. Used in Phase 2.5 to map an anchor raw back
    /// to its UI row, accounting for Phase 2's folding of multi-row assistant
    /// continuations into a single UI message (sourceSortOrder = first raw's
    /// sortOrder, lastSourceSortOrder = last raw's sortOrder).
    static func uiIndexForAnchorRaw(_ anchor: RawMessage, in uiMessages: [ChatMessage]) -> Int? {
        uiMessages.firstIndex { ui in
            guard let first = ui.sourceSortOrder else { return false }
            let last = ui.lastSourceSortOrder ?? first
            return anchor.sortOrder >= first && anchor.sortOrder <= last
        }
    }

    /// Build a healed v2 marker that preserves identity (`id`, `sessionId`,
    /// `summary`, `createdAt`, `compactedCount`) but swaps `lastCompactedMessageId`
    /// to the recomputed anchor and zeroes legacy fields. Future loads will
    /// resolve through the corrected lcmId directly without re-running the
    /// createdAt fallback.
    static func rewriteMarkerForHeal(_ marker: CompactMarker, newAnchor: RawMessage, lastRaw: RawMessage?) -> CompactMarker {
        let pastEnd = (lastRaw?.sortOrder ?? 0) + 1
        return CompactMarker(
            id: marker.id,
            sessionId: marker.sessionId,
            summary: marker.summary,
            firstKeptSortOrder: pastEnd,
            compactedCount: marker.compactedCount,
            createdAt: marker.createdAt,
            uiBoundarySortOrder: pastEnd,
            boundaryMessageId: nil,
            firstKeptMessageId: nil,
            lastCompactedMessageId: newAnchor.id,
            version: 2
        )
    }

    /// Compact all active history. Equivalent to "compact from the last active
    /// message" — under v2 semantics that single rule covers both /compact and
    /// long-press → "compact from here". Anchor = last active ChatMessage;
    /// everything from session-start (or prev marker's anchor + 1) up through
    /// the anchor is folded into a new marker's summary; agentHistory is not
    /// mutated. The kept tail (live anchor for the next turn) is whatever the
    /// user types next — there is no "auto-keep last N user turns" magic.
    func compactAll() {
        guard !isProcessing else {
            appendSystemInfo(String(localized: "正在回复时不能压缩。"), icon: "arrow.down.right.and.arrow.up.left")
            return
        }
        let activeMessages = messages.filter {
            $0.role != .compactDivider && $0.role != .systemInfo && !$0.isCompactedHistory
        }
        guard activeMessages.count > 1 else {
            appendSystemInfo(String(localized: "消息还不够多，不用压缩。"), icon: "arrow.down.right.and.arrow.up.left")
            return
        }
        guard let lastActive = activeMessages.last else { return }
        // includesBoundary=false: same path as long-press compactBefore. The
        // flag is preserved on the API for ABI compat with older v1 callers
        // but is ignored by the v2 anchor calculation.
        compactTask = Task { await compactBefore(lastActive.id, includesBoundary: false) }
    }

    /// Find the agentHistory index of the Nth-from-last user message that has
    /// visible text content (i.e. a user the user actually typed, not a
    /// tool_result-only synthetic row). Returns nil if fewer than `n` such
    /// messages exist.
    ///
    /// Used by compactAll to anchor "keep last N user turns" — we cut at the
    /// returned index, so everything strictly before it is the compacted
    /// range; from it onward stays as live inference anchors.
    func indexOfNthFromLastUserText(_ n: Int) -> Int? {
        indexOfNthFromLastUserText(n, upToIncluding: agentHistory.count - 1)
    }

    /// Variant that walks back from `upToIncluding` (an absolute agentHistory
    /// index) instead of the tail. Used by v2 effectiveAgentHistory to find
    /// the start of "last N user-text turns leading INTO the compact anchor."
    func indexOfNthFromLastUserText(_ n: Int, upToIncluding endIdx: Int) -> Int? {
        guard n > 0, endIdx >= 0, endIdx < agentHistory.count else { return nil }
        var seen = 0
        for i in stride(from: endIdx, through: 0, by: -1) {
            let msg = agentHistory[i]
            guard msg.role == .user else { continue }
            let hasText = msg.parts.contains { part in
                if case .text(let t) = part, !t.isEmpty { return true }
                return false
            }
            guard hasText else { continue }
            seen += 1
            if seen == n { return i }
        }
        return nil
    }

    /// Result of a bounded walk-back. `priorIdx` is the agentHistory index
    /// the caller should use as the start of preAnchor; `nil` means even the
    /// first user turn including anchor would exceed `maxMessages`, so
    /// preAnchor should be empty.
    struct WalkBackResult {
        let priorIdx: Int?
        let userTextTurnsFound: Int
        let messageCount: Int
        let stopReason: String  // "userTextTargetMet" | "messageCapWouldExceed" | "reachedStart"
    }

    /// Walk back from `anchorIdx` toward 0, deciding ONLY at user-message
    /// boundaries whether to include the next round. Stops when:
    /// - we've collected `maxUserTextTurns` user-text turns (success), OR
    /// - including the next user round would push total messages over
    ///   `maxMessages` (cap reason — don't split a user/assistant/tool round
    ///   in the middle, otherwise a tool_use would be orphaned without its
    ///   tool_result), OR
    /// - we hit index 0 (start of history).
    ///
    /// A "round" runs from one user message up to (but not including) the
    /// previous user message — i.e. assistant + tool_use/tool_result messages
    /// that follow a user message belong to that user's round.
    func walkBackUserTurnsBounded(
        anchorIdx: Int,
        maxUserTextTurns: Int,
        maxMessages: Int
    ) -> WalkBackResult {
        guard anchorIdx >= 0, anchorIdx < agentHistory.count else {
            return WalkBackResult(priorIdx: nil, userTextTurnsFound: 0, messageCount: 0, stopReason: "invalidAnchor")
        }
        var acceptedPriorIdx: Int? = nil
        var acceptedUserTextTurns = 0
        var acceptedMessageCount = 0

        // Scan strictly right-to-left. When we hit a user message, evaluate
        // "would accepting [thisUser ... anchorIdx] still fit?"
        for i in stride(from: anchorIdx, through: 0, by: -1) {
            let msg = agentHistory[i]
            guard msg.role == .user else { continue }
            let candidateMessageCount = anchorIdx - i + 1
            if candidateMessageCount > maxMessages {
                // Including this user round would exceed cap. Stop — keep
                // last accepted priorIdx (which is on an earlier-found user,
                // closer to anchor).
                return WalkBackResult(
                    priorIdx: acceptedPriorIdx,
                    userTextTurnsFound: acceptedUserTextTurns,
                    messageCount: acceptedMessageCount,
                    stopReason: "messageCapWouldExceed"
                )
            }
            // Accept this user as the new tentative priorIdx.
            acceptedPriorIdx = i
            acceptedMessageCount = candidateMessageCount
            let hasText = msg.parts.contains { part in
                if case .text(let t) = part, !t.isEmpty { return true }
                return false
            }
            if hasText {
                acceptedUserTextTurns += 1
                if acceptedUserTextTurns >= maxUserTextTurns {
                    return WalkBackResult(
                        priorIdx: acceptedPriorIdx,
                        userTextTurnsFound: acceptedUserTextTurns,
                        messageCount: acceptedMessageCount,
                        stopReason: "userTextTargetMet"
                    )
                }
            }
        }
        return WalkBackResult(
            priorIdx: acceptedPriorIdx,
            userTextTurnsFound: acceptedUserTextTurns,
            messageCount: acceptedMessageCount,
            stopReason: "reachedStart"
        )
    }

    /// Wrap a compact summary in the `<context-summary>` envelope used both
    /// by the standalone `summaryAsAgentMessage` form (legacy) and by v2's
    /// inline injection into the next user message's content array.
    static func compactSummaryWrappedText(_ summary: String) -> String {
        """
        <context-summary>
        The following is a summary of the earlier conversation that was compacted to save context space.
        Treat it as background context only. The user's most recent message (below or in the next turn) takes precedence — if it changes the task, the goal, or any numbers/scope, follow the new instruction and do not resume the old plan from this summary. Do not re-run discovery (reading memory, scanning skills, re-reading files) unless the new instruction requires it.

        \(summary)
        </context-summary>
        """
    }

    /// UI counterpart to `indexOfNthFromLastUserText` — used by Phase 2.5
    /// restore when the marker's lcmId is orphaned (DB rows the marker
    /// referenced have since been deleted / re-indexed by a sync migration).
    /// Returns the UI message index of the nth-from-last user message; the
    /// divider is placed before this index so the kept tail stays active and
    /// only the prefix is grayed. Returns 0 (no graying) when there are
    /// fewer than `keepUserTurns` user messages — same conservative behavior
    /// as compactBefore on tiny sessions.
    static func uiAnchorIndexForKeptTail(in messages: [ChatMessage], keepUserTurns n: Int) -> Int {
        guard n > 0, !messages.isEmpty else { return 0 }
        var seen = 0
        for i in stride(from: messages.count - 1, through: 0, by: -1) {
            let m = messages[i]
            // Only count user messages with non-empty content; matches the
            // agentHistory rule (skip tool-result-only user turns).
            guard m.role == .user, !m.content.isEmpty else { continue }
            seen += 1
            if seen == n { return i }
        }
        return 0
    }

    /// Compact all messages before the specified chat message.
    ///
    /// Phase B model (rule 1/2):
    ///   - Range = [prevMarker.firstKeptMessageId ..< userClickedBoundaryId) in agentHistory
    ///     (if no prevMarker, range = [0 ..< userClickedBoundaryId))
    ///   - Generate new summary via LLM using `previousSummary = cachedLatestMarker?.summary`
    ///     (merge strategy — new summary covers all history, old marker becomes archive)
    ///   - Write new marker with firstKeptMessageId + lastCompactedMessageId
    ///   - agentHistory is NOT mutated. Summary is injected at inference time via
    ///     effectiveAgentHistory().
    ///   - cachedLatestMarker is updated so subsequent agent loop iterations see it.

    /// Revert the most recent compact for this session.
    ///
    /// Drops the latest CompactMarker (its summary is discarded), refreshes
    /// the cached marker to whatever's left (if any), and triggers a UI
    /// rebuild. Effect by design:
    ///   - If a previous (older) marker exists, the divider snaps back to that
    ///     marker's anchor — the session shows what it looked like one
    ///     compact-step ago.
    ///   - If no previous marker exists, the session goes back to "no
    ///     compaction" — every message becomes active, the divider disappears,
    ///     and full agentHistory flows to the model again.
    ///
    /// Safe to call while idle. Refuses to run mid-stream so we don't yank
    /// context out from under an active agent loop.
    @MainActor
    func revertCompact() async {
        guard let sessionId else { return }
        guard !isProcessing else {
            logger.info("[Compact] revert refused: session is processing")
            appendSystemInfo(String(localized: "正在回复时不能撤销压缩。"), icon: "arrow.uturn.backward")
            return
        }
        // A manual compaction runs without a live turn. Reverting under it
        // deleted the current marker just before the compaction wrote a new one
        // summarising the pre-revert context.
        guard !isCompacting else {
            logger.info("[Compact] revert refused: compaction in progress")
            appendSystemInfo(String(localized: "正在压缩时不能撤销压缩。"), icon: "arrow.uturn.backward")
            return
        }
        guard let marker = cachedLatestMarker else {
            logger.info("[Compact] revert: no marker to revert")
            appendSystemInfo(String(localized: "这个对话没有压缩过，不用撤销。"), icon: "arrow.uturn.backward")
            return
        }

        logger.info("[Compact] ━━━ REVERT ━━━ session=\(sessionId.prefix(8)) markerId=\(marker.id.prefix(8)) v=\(marker.version) lcmId=\(marker.lastCompactedMessageId?.prefix(8) ?? "nil")")

        let deleted = await ChatStore.shared.deleteCompactMarker(id: marker.id)
        guard deleted else {
            logger.error("[Compact] revert: deleteCompactMarker returned false (marker.id=\(marker.id.prefix(8)))")
            appendSystemInfo(String(localized: "撤销失败：找不到压缩标记。"), icon: "arrow.uturn.backward")
            return
        }

        // Refresh cached marker to the next-most-recent one (or nil).
        let next = await ChatStore.shared.latestCompactMarker(sessionId: sessionId)
        self.cachedLatestMarker = next

        // Rebuild UI message list from DB to reflect the new (or absent)
        // marker. loadSession() re-runs Phase 2.5 restore against the
        // remaining markers, which will either:
        //   - find the previous marker and place the divider at its anchor, or
        //   - find no marker and ungray everything (no divider rendered).
        //
        // We deliberately DON'T inject a "Reverted ..." systemInfo row here.
        // The divider itself already conveys the post-revert state (either
        // the previous marker re-emerges as "N messages compacted", or all
        // dividers disappear when the last marker is gone). A separate
        // notice next to the divider is visually redundant — same anchor,
        // two stacked rows saying overlapping things.
        await loadSession()
        if let next {
            logger.info("[Compact] revert DONE: now showing previous marker id=\(next.id.prefix(8)) v=\(next.version)")
        } else {
            logger.info("[Compact] revert DONE: no remaining markers, full history active")
        }
    }

    @MainActor
    /// - allowDuringProcessing: normally compaction is a user-initiated action
    ///   that must not run mid-turn (the `!isProcessing` guard). The agent loop's
    ///   in-loop auto-compact [T-chat-auto-compact-inloop] passes true: it runs
    ///   WHILE processing, between iterations, and relies on the same
    ///   `isCompacting` re-entrancy guard below. compactBefore only reads/rewrites
    ///   agentHistory + the compact cache, which the loop consumes fresh via
    ///   effectiveAgentHistory() on its next API call — so no special resume
    ///   handoff is needed.
    func compactBefore(_ chatMessageId: UUID, includesBoundary: Bool = false,
                        allowDuringProcessing: Bool = false) async {
        guard allowDuringProcessing || !isProcessing else {
            logger.info("[Compact] Cannot compact while processing")
            appendSystemInfo(String(localized: "正在回复时不能压缩。"), icon: "arrow.down.right.and.arrow.up.left")
            return
        }
        guard !isCompacting else {
            logger.info("[Compact] Compaction already in progress")
            return
        }
        guard let sessionId else { return }
        // In-loop compaction runs inside a live turn: that turn still owns
        // isProcessing (Stop, the Live Activity) and drains its own queue.
        let wasProcessing = isProcessing
        // [T-ios-compact-model-fallback] Per-RUN state: a model that was out of
        // quota an hour ago may be fine now. `isCompacting` makes runs
        // non-overlapping, so a plain reset here is safe.
        compactFailedEntryIds.removeAll()

        // Find the boundary UI message.
        guard let boundaryIndex = messages.firstIndex(where: { $0.id == chatMessageId }) else { return }
        guard boundaryIndex > 0 else { return }
        let boundaryUIMsg = messages[boundaryIndex]

        ensureContextFixedTokens()
        let compactMeasuredBefore = measureOutboundContextTokens()
        logger.info("[Compact] ━━━ BEGIN compactBefore (Phase B id-first) ━━━")
        logger.info("[Compact] session=\(sessionId.prefix(8)) boundaryIndex=\(boundaryIndex) totalUIMessages=\(self.messages.count) totalHistory=\(self.agentHistory.count)")

        // Collect active UI messages before the boundary (for count/display only).
        let toCompactUI = messages[0..<boundaryIndex].filter {
            $0.role != .compactDivider && $0.role != .systemInfo && !$0.isCompactedHistory
        }
        guard !toCompactUI.isEmpty else {
            logger.info("[Compact] No active UI messages before boundary — aborting")
            return
        }

        // ───── Resolve boundary's dbMessageId (firstKeptMessageId for the new marker) ─────
        //
        // Priority 1: UI msg's sourceSortOrder → look up raw.id from DB
        //   (used for messages loaded from prior sessions)
        // Priority 2: Match the boundary UI message to an agentHistory entry by timestamp
        //   proximity — fall back to the last agentHistory entry of the same role
        //   at or before the UI boundary index (covers in-session messages where
        //   sourceSortOrder is not yet populated).
        //
        // When includesBoundary=true (compactAll), we don't need a real fkmId for
        // the marker, but we still need to locate the boundary in agentHistory to
        // size the compacted range.
        let allRaw = await ChatStore.shared.loadMessages(sessionId: sessionId)
        var firstKeptMessageId: String? = nil
        if let bso = boundaryUIMsg.sourceSortOrder,
           let rawMsg = allRaw.first(where: { $0.sortOrder == bso }) {
            firstKeptMessageId = rawMsg.id
        }

        // Fallback for in-session messages without sourceSortOrder: map UI →
        // agentHistory by scanning agentHistory in order for an entry whose role
        // matches and whose dbMessageId corresponds to a raw row persisted recently.
        // We take the LAST such entry to bias toward the end of history.
        if firstKeptMessageId == nil {
            if let lastMatching = agentHistory.last(where: { $0.dbMessageId != nil }) {
                firstKeptMessageId = lastMatching.dbMessageId
                logger.info("[Compact] boundaryUIMsg.sourceSortOrder was nil — falling back to last agentHistory entry with dbMessageId=\(lastMatching.dbMessageId?.prefix(8) ?? "?")")
            }
        }

        let boundaryIdx: Int
        if let fkmId = firstKeptMessageId,
           let idx = agentHistory.firstIndex(where: { $0.dbMessageId == fkmId }) {
            boundaryIdx = idx
        } else if includesBoundary {
            // compactAll: no boundary needed — compact the entire history.
            boundaryIdx = agentHistory.count
            logger.info("[Compact] compactAll with no resolvable boundary — compacting full agentHistory (\(self.agentHistory.count) entries)")
        } else {
            logger.error("[Compact] firstKeptMessageId=\(firstKeptMessageId?.prefix(8) ?? "nil") not present in agentHistory (count=\(self.agentHistory.count))")
            appendSystemInfo(String(localized: "无法压缩：找不到压缩的起点。"), icon: "arrow.down.right.and.arrow.up.left")
            return
        }

        // ───── v2 anchor calculation ─────
        //
        // anchorIdx = the agentHistory index of the message that becomes this
        // marker's anchor. Semantics: "everything from the previous marker's
        // anchor (exclusive) up to and including agentHistory[anchorIdx] is
        // folded into this marker's summary."
        //
        // - compactBefore(X, includesBoundary: false): user long-pressed X
        //   meaning "fold everything up through this point." anchor = X.
        //   (Old code treated X as "first kept"; v2 unifies on "anchor is the
        //   last compacted message" so summary timing is consistent with
        //   compactAll.)
        // - compactAll: walk back N user-text turns; the message strictly
        //   before that point is the anchor (everything before/including it
        //   is folded; the last N user-text turns + their replies stay live).
        // v2 unified semantics: marker.anchor = the message the caller pointed
        // at (`chatMessageId`). Everything from session-start (or the previous
        // marker's anchor + 1) up to and including this message is folded.
        // `includesBoundary` is accepted for ABI compatibility but no longer
        // changes anchor calculation — both /compact (compactAll → last active
        // message) and long-press → "compact from here" go through the same
        // code path.
        let anchorIdx = boundaryIdx
        logger.info("[Compact] anchorIdx=\(anchorIdx) (caller-supplied message becomes the marker anchor; includesBoundary=\(includesBoundary) ignored in v2)")
        let endExclusive = anchorIdx + 1   // [start, anchorIdx] inclusive
        let fkmId: String = firstKeptMessageId ?? ""

        // Resolve compact range START.
        //
        // Merge strategy: always start from 0 so the LLM sees a contiguous
        // replay of all history (plus the previous summary) and produces a single
        // coherent new summary. Previous marker's range is implicitly re-processed,
        // but `previousSummaryText` is passed into generateCompactSummaryWithSplitting
        // so the LLM uses the compact form of old content and only reads the new
        // increment in full detail.
        let startIdx = 0

        guard startIdx < endExclusive else {
            logger.info("[Compact] empty range — aborting (startIdx=\(startIdx) endExclusive=\(endExclusive))")
            return
        }

        logger.info("[Compact] range: startIdx=\(startIdx) endExclusive=\(endExclusive) historyCount=\(endExclusive - startIdx)")

        isCompacting = true
        isProcessing = true

        // Sweep stale compact-status rows from prior attempts (e.g. a leftover
        // "Compaction failed: ..." or "Compaction cancelled." systemInfo from
        // a previous run). They are in-memory only (never persisted to DB)
        // and become misleading the moment the user retries — without this
        // sweep the chat shows the old failure message right next to the
        // new one. Only systemInfo rows are removed; .compactDivider rows
        // (real prior successful compactions) are preserved here and replaced
        // later only when this attempt succeeds.
        messages.removeAll { msg in
            msg.role == .systemInfo
                && msg.systemIcon == "arrow.down.right.and.arrow.up.left"
        }

        // Insert a systemInfo loading message
        let statusMsg = ChatMessage(role: .systemInfo, content: String(localized: "正在压缩对话…"))
        statusMsg.systemIcon = "arrow.down.right.and.arrow.up.left"
        statusMsg.isCompactLoading = true
        messages.append(statusMsg)

        defer {
            isCompacting = false
            if !wasProcessing { isProcessing = false }
            compactTask = nil
        }

        // Slice to compact. Skip messages already folded by the previous
        // marker (its anchor + everything before).
        //
        // v2 semantics: prev.lastCompactedMessageId IS the anchor, and the
        // prev marker covers [0, prevAnchorIdx] inclusive — so our new range
        // must start at prevAnchorIdx + 1.
        //
        // v1 fallback: prev.firstKeptMessageId points to the FIRST KEPT
        // (post-compact) message, so v1 range starts AT that index (it was
        // exclusive on the right side of the compacted range).
        var effectiveStartIdx = startIdx
        if let prev = cachedLatestMarker {
            let prevAnchorOrFirstKept: String?
            let v1FallbackStartAtPrevIdx: Bool
            if prev.version >= 2, let anchor = prev.lastCompactedMessageId {
                prevAnchorOrFirstKept = anchor
                v1FallbackStartAtPrevIdx = false   // v2: start AFTER prev anchor
            } else {
                prevAnchorOrFirstKept = prev.firstKeptMessageId ?? prev.boundaryMessageId
                v1FallbackStartAtPrevIdx = true     // v1: prev.firstKept IS our start
            }
            if let prevId = prevAnchorOrFirstKept,
               let prevIdx = agentHistory.firstIndex(where: { $0.dbMessageId == prevId }) {
                let proposedStart = v1FallbackStartAtPrevIdx ? prevIdx : (prevIdx + 1)
                if proposedStart < endExclusive {
                    effectiveStartIdx = proposedStart
                    logger.info("[Compact] prev marker found (v\(prev.version)); effectiveStartIdx=\(effectiveStartIdx) (prevAnchor/firstKept=\(prevId.prefix(8)) at idx=\(prevIdx))")
                } else {
                    logger.info("[Compact] prev marker (id=\(prevId.prefix(8))) at idx=\(prevIdx) already covers our range (proposedStart=\(proposedStart) >= endExclusive=\(endExclusive)) — aborting")
                    statusMsg.content = String(localized: "这之前的内容已经压缩过了。")
                    statusMsg.isCompactLoading = false
                    return
                }
            }
        }

        guard effectiveStartIdx < endExclusive else {
            logger.info("[Compact] empty effective range — aborting (effectiveStartIdx=\(effectiveStartIdx) endExclusive=\(endExclusive))")
            statusMsg.content = String(localized: "没有可压缩的内容。")
            statusMsg.isCompactLoading = false
            return
        }

        let toCompact = Array(agentHistory[effectiveStartIdx..<endExclusive])
        let historyCount = toCompact.count

        // Merge-strategy previousSummary: the old summary (from the cached marker) is passed
        // to the LLM so it can fold prior compressed history into the new summary.
        let previousSummaryText: String? = cachedLatestMarker?.summary

        // Generate summary via LLM (auto-splits if too large for context window)
        let summary: String
        do {
            try Task.checkCancellation()
            summary = try await generateCompactSummaryWithSplitting(
                messages: toCompact,
                statusMsg: statusMsg,
                previousSummary: previousSummaryText
            )
            try Task.checkCancellation()
        } catch is CancellationError {
            logger.info("[Compact] Cancelled by user")
            statusMsg.content = String(localized: "已取消压缩。")
            statusMsg.isCompactLoading = false
            return
        } catch {
            // Reaching here means the segment retry is EXHAUSTED (or the error
            // is one splitting cannot fix — offline, timeout, quota on every
            // candidate). Say which, so the message never claims a retry that
            // did not happen.
            let didSegment = Self.isSegmentRetryableError(error)
            logger.error("[Compact] Summary generation failed (segmented=\(didSegment)) type=\(String(describing: type(of: error)))")
            DiagnosticRing.shared.record(.contextDecision, sessionId: sessionId, entryId: "ctx.compact.failed",
                                         error: error, message: didSegment ? "segmented" : "not segmented")
            typedErrorRetry = (error.localizedDescription, .compaction(chatMessageId, includesBoundary: includesBoundary))
            errorMessage = error.localizedDescription
            statusMsg.content = didSegment
                ? String(localized: "压缩失败(已分段重试):\(error.localizedDescription)")
                : String(localized: "压缩失败：\(error.localizedDescription)")
            statusMsg.isCompactLoading = false
            return
        }

        // ───── Compute marker fields (v2) ─────
        //
        // v2 model: lastCompactedMessageId is the ONLY anchor — a real,
        // persisted, UI-visible message id. agentHistory[lcmIdx + 1...] is the
        // active region (anchor + new msgs). All v1 multi-field bookkeeping
        // (firstKeptMessageId, boundaryMessageId, sortOrder fallbacks) is
        // skipped on the read side; we still persist them here so a downgrade
        // / older device that hits this row reads sensible defaults.
        //
        // Walk back from endExclusive looking for the first agentHistory entry
        // that already has a persisted dbMessageId AND is present in DB. This
        // avoids the past failure mode where lcmId pointed at a transient
        // row id that was never persisted (or was deleted by a later prune).
        var lcmIdResolved: String? = nil
        var lcmHistoryIdx: Int? = nil
        do {
            // [T-ios-compact-stale-index] Clamp to the CURRENT end of
            // agentHistory: the summary await can run for minutes, during which
            // the user can delete messages. `endExclusive - 1` would then index
            // past the end and trap.
            var i = min(endExclusive, agentHistory.count) - 1
            if i != endExclusive - 1 {
                logger.warning("[Compact] agentHistory shrank during summary generation (endExclusive=\(endExclusive) → count=\(self.agentHistory.count)); clamping the marker walk-back")
            }
            while i >= 0 {
                if let id = agentHistory[i].dbMessageId,
                   allRaw.contains(where: { $0.id == id }) {
                    lcmIdResolved = id
                    lcmHistoryIdx = i
                    break
                }
                i -= 1
            }
        }
        guard let lastCompactedMessageId = lcmIdResolved else {
            logger.error("[Compact] Cannot write v2 marker: no agentHistory entry in [0..\(endExclusive)) has a persisted dbMessageId. Aborting compact.")
            statusMsg.content = String(localized: "压缩失败：没能把标记挂到已保存的消息上。")
            statusMsg.isCompactLoading = false
            return
        }
        if lcmHistoryIdx != endExclusive - 1 {
            logger.warning("[Compact] v2 marker lcm anchor walked back from idx=\(endExclusive - 1) to idx=\(lcmHistoryIdx ?? -1) (closest persisted message). Some unsynced tail entries will fall on the active side of the divider.")
        }

        // Legacy fields are written with neutral / past-the-end values for
        // cross-version compatibility. Older builds reading this v2 row will
        // see boundary fallbacks pointing past the live tail (= "everything
        // compacted, nothing kept" — graceful degradation, never overlap).
        // New builds (v2) ignore these and use lastCompactedMessageId only.
        let legacyPastEndSortOrder = (allRaw.last?.sortOrder ?? 0) + 1

        let marker = CompactMarker(
            id: UUID().uuidString,
            sessionId: sessionId,
            summary: summary,
            firstKeptSortOrder: legacyPastEndSortOrder,
            compactedCount: historyCount,
            createdAt: Date(),
            uiBoundarySortOrder: legacyPastEndSortOrder,
            boundaryMessageId: nil,
            firstKeptMessageId: nil,
            lastCompactedMessageId: lastCompactedMessageId,
            version: 2
        )
        logger.info("[Compact] Persisting v2 marker: id=\(marker.id.prefix(8)) lcmId=\(lastCompactedMessageId.prefix(8)) lcmHistoryIdx=\(lcmHistoryIdx ?? -1)/agentHistory.count=\(self.agentHistory.count) historyCount=\(historyCount) includesBoundary=\(includesBoundary)")
        await ChatStore.shared.insertCompactMarker(marker)

        // Phase B: update cache so effectiveAgentHistory() starts using the new summary immediately.
        self.cachedLatestMarker = marker

        // Phase B: do NOT mutate agentHistory. It stays full; summary is synthesized
        // at inference time via effectiveAgentHistory().
        logger.info("[Compact] agentHistory untouched (Phase B): \(self.agentHistory.count) entries")

        // Update UI: remove the loading statusMsg, remove old dividers, then insert
        // a new divider. The divider goes AFTER the last compacted UI message
        // (= the UI row matching marker.lastCompactedMessageId). Anything above
        // the divider is grayed; anything below stays active (the kept tail
        // for compactAll, or the user's clicked boundary onward for compactBefore).
        //
        // Old dividers from earlier compact passes are removed unconditionally —
        // a session shows at most one compact divider (the latest marker).
        messages.removeAll { $0.id == statusMsg.id }
        let dividersBefore = messages.filter { $0.role == .compactDivider }.count
        messages.removeAll { $0.role == .compactDivider }
        // Also drop any stale compact-status systemInfo rows that survived
        // (shouldn't normally happen — start-of-run sweep already removed them
        // — but defends against any code path that appended one between then
        // and now). Belt-and-suspenders for the "two markers" report.
        messages.removeAll { msg in
            msg.role == .systemInfo
                && msg.systemIcon == "arrow.down.right.and.arrow.up.left"
        }

        // Locate divider insert position. v2: divider goes immediately AFTER
        // the UI row matching the marker's anchor (lastCompactedMessageId) —
        // anchor row + everything before it become grayed history; everything
        // below stays active.
        let dividerInsertIdx: Int
        if let lcmRaw = allRaw.first(where: { $0.id == lastCompactedMessageId }),
           let uiIdx = messages.firstIndex(where: { $0.sourceSortOrder == lcmRaw.sortOrder }) {
            dividerInsertIdx = uiIdx + 1
        } else if let bIdx = messages.firstIndex(where: { $0.id == chatMessageId }) {
            // Anchor's UI row not yet present (in-session messages without
            // sourceSortOrder). Fall back to the user-clicked boundary +1
            // since v2 includes the clicked message in the compacted range.
            dividerInsertIdx = bIdx + 1
        } else {
            dividerInsertIdx = messages.count
        }

        let compactedUICount = messages[0..<dividerInsertIdx].filter {
            $0.role != .systemInfo && !$0.isCompactedHistory
        }.count
        let divider = ChatMessage(role: .compactDivider, content: String(localized: "已压缩 \(compactedUICount) 条消息"))
        divider.compactSummary = summary
        messages.insert(divider, at: dividerInsertIdx)

        // Gray out everything above the divider; the kept tail (below divider) stays active.
        var grayedCount = 0
        for i in 0..<dividerInsertIdx {
            if messages[i].role != .compactDivider && messages[i].role != .systemInfo {
                messages[i].isCompactedHistory = true
                grayedCount += 1
            }
        }
        logger.info("[Compact] UI update: divider at index \(dividerInsertIdx), grayed \(grayedCount) messages, removed \(dividersBefore) old dividers")

        // Log final state
        let keptUIMessages = messages.filter { !$0.isCompactedHistory && $0.role != .compactDivider && $0.role != .systemInfo }
        logger.info("[Compact] ━━━ COMPLETE ━━━")
        logger.info("[Compact] Summary: \(summary.count) chars, \(historyCount) history entries compacted")
        logger.info("[Compact] UI: \(toCompactUI.count) messages compacted (grayed), \(keptUIMessages.count) active messages kept")
        logger.info("[Compact] History (Phase B): \(self.agentHistory.count) entries total (unchanged, summary synthesized via effectiveAgentHistory)")
        logger.info("[Compact] DB: v2 marker anchorMessageId=\(lastCompactedMessageId.prefix(8)) (legacy fields nil)")

        // Unconditionally offload large tool results/file_write content in the
        // kept messages. After compaction, the remaining turns may still contain
        // heavy tool output that would bloat the context on the next API call.
        let activeModel: LLMModel
        if let binding = ProviderConfigStore.shared.binding(for: sessionId) {
            let eid: String
            switch binding.primarySource {
            case .directEntry(let id, _): eid = id
            case .group(_, let id): eid = id
            }
            activeModel = ProviderConfigStore.shared.entry(for: eid)?.model ?? selectedModel
        } else {
            activeModel = selectedModel
        }
        offloadContextIfNeeded(model: activeModel, lastContextTokens: 0, force: true)

        let compactMeasuredAfter = measureOutboundContextTokens()
        logger.info("[CtxMeter] compacted marker=\(marker.id.prefix(8)) measured \(compactMeasuredBefore)→\(compactMeasuredAfter)")
        LeoPerf.record("ctx.compacted", ms: 0, extra: ["before": compactMeasuredBefore, "after": compactMeasuredAfter,
                                                      "inLoop": wasProcessing, "entries": historyCount])
        DiagnosticRing.shared.record(.contextDecision, sessionId: sessionId, entryId: "ctx.compacted",
                                     message: "measured \(compactMeasuredBefore)→\(compactMeasuredAfter) inLoop=\(wasProcessing)")

        // Scroll to bottom so the user sees the compact divider and retained messages.
        forceScrollToBottom.send()

        // [T-compact-queued-drain] Success tail: run any prompts that were
        // enqueued while the compact was in flight. Previously only the
        // compactAndSend caller drained — /compact (compactAll) and the
        // long-press Compact-Before path left queued messages stuck in the
        // dashed "queued" style forever after "N messages compacted". The
        // drain task starts after this function returns, i.e. after the defer
        // above has reset isCompacting/isProcessing/compactTask to a clean
        // idle state. Failure exits intentionally don't drain (messages stay
        // queued and user-cancellable). A live turn drains its own queue.
        if !wasProcessing { schedulePostCompactDrain() }
    }

    /// Build a text representation of messages for summarization.
    private func buildConversationTextForSummary(_ messages: [AgentMessage]) -> String {
        var lines: [String] = []
        for msg in messages {
            let role = msg.role == .user ? "User" : "Assistant"
            for part in msg.parts {
                switch part {
                case .text(let t):
                    if !t.isEmpty {
                        lines.append("[\(role)] \(t)")
                    }
                case .toolUse(_, let name, let input):
                    // Extract the most informative input fields for each tool type
                    var details: [String] = []
                    if let path = input["path"] as? String ?? input["file_path"] as? String {
                        details.append(path)
                    }
                    if let cmd = input["command"] as? String {
                        details.append(cmd)
                    }
                    if let dir = input["directory"] as? String, details.isEmpty {
                        details.append(dir)
                    }
                    if let content = input["content"] as? String, details.isEmpty {
                        details.append(String(content.prefix(200)))
                    }
                    lines.append("[Tool] \(name): \(details.joined(separator: " | "))")
                case .toolResult(_, let name, let content, let isError, _, _, _, _):
                    // Cap tool results to avoid bloating the summary input
                    let preview = String(content.prefix(500))
                    lines.append("[Result\(isError ? " ERROR" : "")] \(name): \(preview)")
                case .imageData:
                    lines.append("[\(role)] [Image attached]")
                }
            }
        }
        return lines.joined(separator: "\n")
    }

    /// Summarize messages, automatically splitting into chunks if a summary attempt fails.
    private func generateCompactSummaryWithSplitting(
        messages: [AgentMessage],
        statusMsg: ChatMessage,
        previousSummary: String? = nil,
        depth: Int = 0
    ) async throws -> String {
        var conversationText = buildConversationTextForSummary(messages)

        // Prepend previous summary so the LLM merges old + new into one summary
        if let prev = previousSummary {
            conversationText = "Previous context summary:\n\(prev)\n\nNew conversation to merge:\n\(conversationText)"
        }

        do {
            try Task.checkCancellation()
            return try await generateCompactSummary(conversationText: conversationText, statusMsg: statusMsg)
        } catch let error where Self.isSegmentRetryableError(error) && messages.count >= 2 && depth < 3 {
            // [T-compact-segment-retry-any-error] Split on ANY failure a smaller
            // request could fix — not only a recognised "context too large"
            // phrase. The old substring allow-list missed wordings such as
            // `context_length_exceeded … exceeds the context window`, and every
            // miss failed the compaction outright. depth < 3 bounds this at 8
            // leaf calls.
            let mid = messages.count / 2
            let firstHalf = Array(messages[..<mid])
            let secondHalf = Array(messages[mid...])

            logger.info("[Compact] Retry segments: splitting \(messages.count) messages into \(firstHalf.count) + \(secondHalf.count) (depth=\(depth))")
            statusMsg.content = String(localized: "正在压缩对话…(分段处理)")

            // The previous marker's summary rides with the OLDER half only:
            // dropping it here (as the code used to) silently erased every
            // earlier compaction from the new summary whenever a split happened.
            let summary1 = try await generateCompactSummaryWithSplitting(messages: firstHalf, statusMsg: statusMsg,
                                                                         previousSummary: previousSummary, depth: depth + 1)
            try Task.checkCancellation()
            let summary2 = try await generateCompactSummaryWithSplitting(messages: secondHalf, statusMsg: statusMsg, depth: depth + 1)
            try Task.checkCancellation()

            // Bisect-merge WITHOUT another LLM call. The old third "merge these
            // summaries" request was the one unprotected step: if it failed,
            // the two segments that had just succeeded were thrown away with
            // it. Each part is capped at 8192 output tokens, so two parts are
            // nowhere near a context boundary; ordered oldest-first, they carry
            // the "prefer the newer part" signal positionally.
            return summary1 + "\n\n" + summary2
        }
    }

    // MARK: - [T-ios-compact-model-fallback] Model fallback for compaction

    /// Candidate entries for a compact call, best first:
    ///   1. the 「压缩 / 标题」 slot (`resolveSubEntry`, which itself falls back to
    ///      the session model when no slot is set) — kept from LeoBot's
    ///      T-compact-slot so the cheap model the user picked does the work;
    ///   2. the session's main model;
    ///   3. the rest of the session's group via `ModelGroupRouter` (which skips
    ///      hidden / disabled / credential-less members), or — for a session
    ///      pinned to one entry — the default group's members.
    /// Entries that already failed in this run are dropped.
    private func compactFallbackCandidates() -> [ModelEntry] {
        let store = ProviderConfigStore.shared
        var ordered: [ModelEntry] = []
        var seen: Set<String> = []
        func add(_ entry: ModelEntry?) {
            guard let entry, !seen.contains(entry.id) else { return }
            seen.insert(entry.id)
            ordered.append(entry)
        }
        add(resolveSubEntry())
        let primary = resolveCurrentEntry()
        add(primary)

        let groupId: String?
        if let sid = sessionId, let binding = store.binding(for: sid),
           case .group(let gid, _) = binding.primarySource {
            groupId = gid
        } else {
            groupId = store.defaultPrimaryGroupId
        }
        if let groupId, let group = store.group(for: groupId), let start = primary ?? ordered.first {
            var cursor = start.id
            for _ in 0..<max(1, group.memberEntryIds.count) {
                guard let nextId = ModelGroupRouter.nextFallback(group: group, currentEntryId: cursor, store: store) else { break }
                cursor = nextId
                add(store.entry(for: nextId))
            }
        }

        let usable = ordered.filter { !compactFailedEntryIds.contains($0.id) }
        // Never return empty when something exists: retrying the first one
        // surfaces its real error instead of a synthetic "no model".
        return usable.isEmpty ? Array(ordered.prefix(1)) : usable
    }

    /// Generate a compact summary, walking model candidates when one is
    /// exhausted or failing (quota, auth, provider error). Any other error
    /// (size, network, timeout, cancellation) belongs to the caller: splitting
    /// or aborting is the right response there.
    private func generateCompactSummary(conversationText: String, statusMsg: ChatMessage? = nil) async throws -> String {
        let candidates = compactFallbackCandidates()
        guard !candidates.isEmpty else {
            throw NSError(domain: "Compact", code: -1, userInfo: [NSLocalizedDescriptionKey: "No model available for summarization"])
        }
        var lastError: Error?
        for (idx, entry) in candidates.enumerated() {
            do {
                if idx > 0 {
                    logger.info("[Compact] falling back to candidate \(idx + 1)/\(candidates.count): \(entry.model.id)")
                    statusMsg?.content = String(localized: "正在用 \(entry.model.displayName) 压缩对话…")
                }
                return try await generateCompactSummaryOnce(conversationText: conversationText, entry: entry, statusMsg: statusMsg)
            } catch let error as LLMError where error.isFallbackable && !Self.isInputSizeRejection(error) {
                compactFailedEntryIds.insert(entry.id)
                lastError = error
                logger.warning("[Compact] candidate \(entry.model.id) failed (fallbackable): \(error.fallbackReason)")
                continue
            }
        }
        throw lastError ?? NSError(domain: "Compact", code: -2,
            userInfo: [NSLocalizedDescriptionKey: "All model candidates failed to summarize"])
    }

    /// A size rejection — our pre-flight below, or the provider's own
    /// context-length refusal — is a property of the INPUT, not of the model:
    /// hand it straight to the split path instead of re-sending the same
    /// oversized request to every other candidate.
    private static let preflightTooLargePrefix = "compact input too large"
    private static func isInputSizeRejection(_ error: LLMError) -> Bool {
        guard case .providerError(let message) = error else { return false }
        return message.hasPrefix(preflightTooLargePrefix) || ContextSizeMeter.isContextOverflow(message)
    }

    /// One compact attempt against one specific entry.
    private func generateCompactSummaryOnce(conversationText: String, entry: ModelEntry,
                                            statusMsg: ChatMessage? = nil) async throws -> String {
        let provider = try await Self.makeLLMProvider(for: entry)
        let contextWindow = effectiveContextWindow(for: entry.model)

        let systemPrompt = """
        You are a context compaction engine. Your summary will REPLACE the original messages in the \
        conversation context window. The agent will read your summary as past context, then proceed \
        based on the user's NEXT message — your summary is background, not a standing work order. \
        Write the summary in the same language the user used in the conversation.

        MUST PRESERVE (never omit or shorten):
        - All file paths, directory names, URLs, UUIDs, and identifiers — copy verbatim
        - Commands executed and their outcomes (success/failure/output)
        - What was requested and what was done (record as past events, not as ongoing goals)
        - Key decisions made and their rationale
        - Errors encountered and how they were resolved
        - Important constraints, rules, or user preferences mentioned
        - Any tool calls and their results that affect current state

        STRUCTURE:
        1. Start with a one-line description of what the conversation was about (use past tense — \
           "User asked X, agent did Y", NOT "Goal: X").
        2. Then a concise narrative of what happened, preserving technical details.
        3. End with a "What had been done so far" section listing completed work — NOT a "todo" \
           or "pending" list. Do not invent ongoing objectives or carry-over tasks from old turns; \
           if the user wants to continue, they will say so in their next message.

        PRIORITIZE recent context over older history — recent decisions and recent file/path \
        references are most useful for continuity.

        Do NOT translate or alter code snippets, file paths, identifiers, or error messages. \
        Be concise but never lose information the agent needs.
        """

        // [T-ios-compact-oversize-request] Budget the request BEFORE sending it.
        // The old `max(1024, min(8192, window - input))` quietly clamped an
        // impossible request back to 1024 and sent it anyway. Reserve room for
        // the summary; if the input cannot fit, throw a size error that the
        // split path handles (each half is re-checked here). Estimated by
        // character class, so CJK conversations are no longer read at a third
        // of their size.
        let compactOutputReserve = 1024
        let inputEstimate = ContextSizeMeter.estimateTokens(conversationText) + 800
        let maxOutputTokens: Int
        if contextWindow > 0 {
            let available = contextWindow - inputEstimate
            guard available >= compactOutputReserve else {
                logger.error("[Compact] pre-flight: input ~\(inputEstimate) tok exceeds window \(contextWindow) (needs \(compactOutputReserve) for output) — not sending")
                throw LLMError.providerError(
                    message: "\(Self.preflightTooLargePrefix): ~\(inputEstimate) tokens estimated against a \(contextWindow)-token window")
            }
            maxOutputTokens = min(8192, available)
        } else {
            maxOutputTokens = 4096
        }

        let compactUserMessage = """
        Compact this conversation into a context summary:

        \(conversationText)

        ---
        END OF CONVERSATION TO COMPACT.

        Now generate a structured context summary following the system prompt instructions. \
        Do NOT continue the conversation above — summarize it. Write everything in past tense, \
        framed as "what was discussed / what was done", NOT as an ongoing goal or todo list.
        """

        let stream = try await provider.streamMessage(
            messages: [LLMMessage(role: .user, content: compactUserMessage)],
            systemPrompt: systemPrompt,
            maxTokens: maxOutputTokens,
            temperature: nil   // let provider/model use its default
        )

        // [T-ios-compact-no-timeout] Two independent deadlines guard this
        // stream so `isCompacting` can never stick: the provider sessions only
        // set an inter-packet idle timeout (600s), so a stream that dribbles a
        // byte occasionally — or one frozen by app suspension — never trips
        // anything.
        //   stall   — 120s since the last chunk (matches the main stream's watchdog)
        //   overall — 900s wall-clock backstop; long summaries at ~40 tok/s
        //             legitimately take minutes while data flows.
        // Enforced by a SEPARATE watchdog task: the failure being fixed is a
        // stream that stops yielding, where an in-loop check never runs.
        // Wall-clock dates, so throttled background sleeps delay detection but
        // never corrupt the decision.
        let progress = CompactStreamProgress(overallLimit: Self.compactOverallLimit, stallLimit: Self.compactStallLimit)
        let consumeTask = Task { @MainActor () -> String in
            var text = ""
            var didTag = false
            for try await chunk in stream {
                try Task.checkCancellation()
                await progress.touch()
                // Tag the request the FIRST time the stream yields anything —
                // by then the provider has actually sent the wire request.
                #if DEBUG
                if !didTag {
                    LastAPIRequestBody.shared.tagLatest("compact")
                    didTag = true
                }
                #else
                _ = didTag
                #endif
                switch chunk {
                case .text(let delta):
                    text += delta
                    statusMsg?.content = String(localized: "正在压缩对话…(\(text.count) 字)")
                case .finished, .usage, .started:
                    break
                }
            }
            return text
        }
        let watchdog = Task {
            while true {
                try? await Task.sleep(nanoseconds: 5 * 1_000_000_000)
                if Task.isCancelled { return }
                if let breach = await progress.breach() {
                    await progress.recordBreach(breach)
                    await MainActor.run { consumeTask.cancel() }
                    return
                }
            }
        }
        let responseText: String
        do {
            // Propagate a user Stop (compactTask.cancel()) into the consumer.
            responseText = try await withTaskCancellationHandler {
                try await consumeTask.value
            } onCancel: {
                consumeTask.cancel()
            }
            watchdog.cancel()
        } catch {
            watchdog.cancel()
            // A cancellation raised BY the watchdog is a timeout, not a user stop.
            if let breach = await progress.breachReason() {
                logger.error("[Compact] summary stream timed out (\(breach.logLabel)) model=\(entry.model.id)")
                throw CompactStreamTimeout(breach: breach)
            }
            throw error
        }

        guard !responseText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw NSError(domain: "Compact", code: -2, userInfo: [NSLocalizedDescriptionKey: "LLM returned empty summary"])
        }

        return responseText.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Create an AgentMessage that injects a compact summary into the conversation context.
    /// Used by v1 markers (which still inject the summary as a standalone user
    /// turn). v2 markers prefer inline injection into the first post-anchor
    /// user message via `compactSummaryWrappedText`.
    static func summaryAsAgentMessage(_ summary: String) -> AgentMessage {
        AgentMessage(role: .user, parts: [.text(compactSummaryWrappedText(summary))])
    }
}

