import Foundation
import UIKit
import BackgroundTasks

private let logger = AppLogger(category: "AIChatVM")

// MARK: - Background Task + Background Status Timer

extension AIChatViewModel {

    // MARK: - Background Task

    func beginBackgroundProcessing() {
        guard backgroundTaskID == .invalid else { return }
        let continuedKey = continuedProcessingSessionKey ?? sessionId ?? draftId ?? UUID().uuidString
        continuedProcessingSessionKey = continuedKey
        if #available(iOS 26.0, *) {
            AgentContinuedProcessingManager.shared.begin(
                sessionKey: continuedKey,
                title: "LeoPhoneAgent task",
                subtitle: "Preparing",
                onExpiration: { [weak self] in
                    guard let self else { return }
                    logger.warning("[Background][Continued] system expiration session=\(continuedKey.prefix(8))")
                    self.backgroundSuspended = true
                    SessionActivityTracker.shared.updateActivityPhase(
                        continuedKey,
                        phase: .suspended,
                        reason: .backgroundTimeExpired
                    )
                    BackgroundInterruptionTracker.shared.recordInterruption()
                    self.stopCurrentCommand()
                    self.endBackgroundProcessing()
                }
            )
        }
        let remaining = UIApplication.shared.backgroundTimeRemaining
        let remainingStr = remaining > 99999 ? "unlimited" : String(format: "%.1fs", remaining)
        let sessions = SessionActivityTracker.shared.activeSessions.count
        logger.info("[BKA][BGTask] Beginning 'AgentLoop' remaining=\(remainingStr) sessions=\(sessions)")
        backgroundSuspended = false
        backgroundTaskID = UIApplication.shared.beginBackgroundTask(withName: "AgentLoop") { [weak self] in
            guard let self else { return }
            let expRemaining = UIApplication.shared.backgroundTimeRemaining
            let expRemainingStr = expRemaining > 99999 ? "unlimited" : String(format: "%.1fs", expRemaining)
            logger.warning("[BKA][BGTask] Expiry handler fired — id=\(self.backgroundTaskID.rawValue) remaining=\(expRemainingStr) sessions=\(SessionActivityTracker.shared.activeSessions.count) silentAudio=\(BackgroundKeepAliveManager.shared.silentAudioIsPlaying) keepAliveEffective=\(BackgroundKeepAliveManager.shared.enhancedBackgroundEffective)")
            // The FINITE UIApplication background task is expiring. This is a
            // separate mechanism from the silent-audio (`audio` background mode)
            // keep-alive: when keep-alive is active the process stays alive
            // regardless of this task's clock, so expiring it must NOT kill the
            // running shell / delay countdown — doing so was severing long
            // `delay:` tool waits (and any in-flight command) even though the
            // app was in no danger of termination. Instead, just re-arm a fresh
            // finite task to reset the clock and let the agent loop continue.
            let continuedProcessingActive: Bool = {
                guard #available(iOS 26.0, *) else { return false }
                return AgentContinuedProcessingManager.shared.isActive(sessionKey: continuedKey)
            }()
            if BackgroundKeepAliveManager.shared.enhancedBackgroundEffective || continuedProcessingActive {
                logger.info("[Background] Finite task expiring with an active background execution grant; re-arming")
                // End only the expiring task id (no completion notification),
                // then immediately request a new one. Order matters: capture the
                // old id, invalidate, re-begin.
                let expiringId = self.backgroundTaskID
                self.backgroundTaskID = .invalid
                if expiringId != .invalid {
                    UIApplication.shared.endBackgroundTask(expiringId)
                }
                self.beginBackgroundProcessing()
                return
            }
            // No keep-alive backing us — the system really will terminate the
            // app. Suspend instead of cancelling: kill the running shell command
            // so the OS doesn't terminate us, but keep the Task alive so we can
            // resume when foregrounded.
            logger.warning("[Background] Task expiring (no keep-alive) — suspending agent loop")
            self.backgroundSuspended = true
            if let activityKey = self.sessionId ?? self.draftId {
                SessionActivityTracker.shared.updateActivityPhase(
                    activityKey,
                    phase: .suspended,
                    reason: .backgroundTimeExpired
                )
            }
            if !BackgroundKeepAliveManager.shared.enhancedBackgroundEffective {
                BackgroundInterruptionTracker.shared.recordInterruption()
                // [T-session-paused-badge-active-false-positive] The PAUSED badge
                // is now driven solely by `canResume` (see AIChatViewModel's
                // canResume didSet) — the authoritative interrupted flag — so it
                // tracks genuine interruption + resolution uniformly. No explicit
                // push here: a background-suspended in-flight loop sets canResume
                // on the next session load / cleanup, which raises the badge.
                // [T-tool-bg-suspended-hint] Stamp the tool blocks that are
                // in-flight RIGHT NOW — these are the ones the OS is about to
                // suspend. They'll be force-finalized to .cancelled (here via
                // stopCurrentCommand / later via the safety net or session
                // reload); the flag lets the chat capsule show the yellow ⓘ
                // hint only for genuine background suspensions. Follows the same
                // gate as the BackgroundInterruptionTracker banner.
                for msg in self.messages where msg.role == .assistant {
                    for block in msg.blocks {
                        switch block.toolStatus {
                        case .streaming, .running:
                            block.wasBackgroundSuspended = true
                        default:
                            break
                        }
                    }
                }
            }
            // Scope the kill to THIS session — see [T-bg-expiry-cross-session-kill].
            self.stopCurrentCommand(scope: .thisSessionOnly)
            // Must end the background task to avoid termination.
            self.endBackgroundProcessing()
        }
        logger.info("[BKA][BGTask] started id=\(self.backgroundTaskID.rawValue) sessions=\(sessions)")
        startBackgroundStatusTimer()
    }

    func endBackgroundProcessing() {
        let continuedKey = continuedProcessingSessionKey ?? sessionId ?? draftId ?? ""
        let completionHasError = messages.last?.error != nil || errorMessage != nil
        if #available(iOS 26.0, *), !continuedKey.isEmpty {
            AgentContinuedProcessingManager.shared.finish(
                sessionKey: continuedKey,
                success: !completionHasError && !backgroundSuspended
            )
        }
        continuedProcessingSessionKey = nil
        // [T-ios-session-unread-badge / T-ios-unread-dot-reappears] Mark unread
        // when this session finished off-screen and produced NEW content. The
        // red dot means "this session finished and you haven't opened it yet".
        //
        // This funnel is hit from ~15 sites (normal completions, kernel-failure
        // early-returns, cancel cleanup, the bgTask-expiration handler,
        // resumeQueueAfterCancel, …). Pushing unconditionally re-added the dot
        // on late/duplicate calls that carried no new content — e.g. the user
        // reads and leaves the session, then a background keep-alive bgTask
        // expires and its handler calls endBackgroundProcessing(), re-badging a
        // session the user already read. Gate on the assistant-turn count
        // actually having grown since we last badged, so only a run that truly
        // produced a new assistant completion re-marks unread.
        if let sid = sessionId, !sid.isEmpty {
            let assistantTurns = agentHistory.reduce(0) { $0 + ($1.role == .assistant ? 1 : 0) }
            let hasNewCompletion = assistantTurns > lastBadgedAssistantTurnCount
            if Self.activeSessionId == sid {
                // User is looking at this session right now — they see the
                // completion, so never badge, but DO advance the baseline so a
                // later off-screen call for this same turn can't re-badge it.
                lastBadgedAssistantTurnCount = max(lastBadgedAssistantTurnCount, assistantTurns)
            } else if hasNewCompletion {
                lastBadgedAssistantTurnCount = assistantTurns
                SessionBadgeStore.shared.pushFront(.unread, for: sid)
            }
        }

        guard backgroundTaskID != .invalid else { return }
        stopBackgroundStatusTimer()
        let remaining = UIApplication.shared.backgroundTimeRemaining
        let remainingStr = remaining > 99999 ? "unlimited" : String(format: "%.1fs", remaining)
        logger.info("[BKA][BGTask] Ending id=\(self.backgroundTaskID.rawValue) remaining=\(remainingStr) sessions=\(SessionActivityTracker.shared.activeSessions.count) silentAudio=\(BackgroundKeepAliveManager.shared.silentAudioIsPlaying)")

        // Post local notification if task completed in background.
        // Await Live Activity "completed" state update BEFORE posting the
        // notification so the lock-screen capsule shows the checkmark when
        // the notification arrives, not "Responding · streaming".
        do {
            let sid = sessionId ?? ""
            let wasBackground = UIApplication.shared.applicationState != .active
            let hasError = completionHasError
            let responseSummary: String = {
                let assistantTurns = agentHistory.filter { $0.role == .assistant }
                logger.info("[BackgroundNotification] building responseSummary from agentHistory: totalMsgs=\(agentHistory.count) assistantTurns=\(assistantTurns.count) wasBackground=\(wasBackground) hasError=\(hasError)")

                func textFromTurn(_ msg: AgentMessage) -> String {
                    let raw = msg.parts.compactMap { part -> String? in
                        if case .text(let t) = part { return t }
                        return nil
                    }.joined(separator: "\n")
                    return MarkdownStripper.plainText(raw)
                }

                func hasToolUse(_ msg: AgentMessage) -> Bool {
                    msg.parts.contains { if case .toolUse = $0 { return true }; return false }
                }

                for (idx, msg) in assistantTurns.enumerated() {
                    let hasTools = hasToolUse(msg)
                    let txt = textFromTurn(msg)
                    logger.info("[BackgroundNotification] agentTurns[\(idx)] hasToolUse=\(hasTools) textLen=\(txt.count)")
                }

                if let pure = assistantTurns.last(where: { !hasToolUse($0) }) {
                    let t = textFromTurn(pure)
                    if !t.isEmpty {
                        logger.info("[BackgroundNotification] source=pure-text-turn(agentHistory) length=\(t.count)")
                        return String(t.prefix(200))
                    }
                }
                if let any = assistantTurns.last(where: { !textFromTurn($0).isEmpty }) {
                    let t = textFromTurn(any)
                    logger.info("[BackgroundNotification] source=any-text-turn(agentHistory) length=\(t.count)")
                    return String(t.prefix(200))
                }
                logger.info("[BackgroundNotification] source=fallback")
                return "Task completed."
            }()
            logger.info("[BackgroundNotification] responseSummary ready length=\(responseSummary.count) wasBackground=\(wasBackground)")
            let fallbackTitle = messages.first(where: { $0.role == .user })?.content.prefix(60).description ?? "Agent task"
            let bgTaskID = backgroundTaskID
            backgroundTaskID = .invalid
            let otherActive = SessionActivityTracker.shared.activeSessions
                .filter { $0 != sid }
            logger.info("[BKA][BGTask] otherActive=\(otherActive.count) ids=[\(otherActive.map { $0.prefix(8) }.joined(separator: ","))] before Task")
            Task {
                if otherActive.isEmpty {
                    await AgentLiveActivityManager.shared.finishActivity(
                        lastMessages: sid.isEmpty ? [:] : [sid: responseSummary]
                    )
                } else {
                    AgentLiveActivityManager.shared.markSessionCompleted(
                        sessionId: sid,
                        lastMessage: responseSummary
                    )
                }
                let sessionTitle: String
                if let session = await ChatStore.shared.getSession(sid),
                   let t = session.title, !t.isEmpty {
                    sessionTitle = t
                } else {
                    sessionTitle = fallbackTitle
                }
                BackgroundKeepAliveManager.shared.postBackgroundTaskNotification(
                    sessionTitle: sessionTitle, responseSummary: responseSummary, sessionId: sid, isError: hasError, wasBackground: wasBackground
                )
                await MainActor.run {
                    UIApplication.shared.endBackgroundTask(bgTaskID)
                }
            }
        }
    }

    // MARK: - Background Status Timer

    /// Starts a periodic timer that logs tool execution status while backgrounded.
    /// Only emits logs when the app is actually in the background.
    func startBackgroundStatusTimer() {
        stopBackgroundStatusTimer()
        let timer = Timer.scheduledTimer(withTimeInterval: 5.0, repeats: true) { [weak self] timer in
            guard let self else { timer.invalidate(); return }
            // Only log when actually in background
            guard UIApplication.shared.applicationState != .active else { return }
            let remaining = UIApplication.shared.backgroundTimeRemaining
            guard remaining < 99999 else {
                // Background task ended — stop timer
                timer.invalidate()
                self.backgroundStatusTimer = nil
                return
            }
            let remainingStr = String(format: "%.1fs", remaining)
            let status = self.backgroundToolStatusSummary()
            // Escalate to WARN once we're inside the last 15s — past this
            // point iOS is liable to suspend the process at any moment, so
            // any subsequent log noise is ranked accordingly. Below 60s
            // we keep the existing 5s cadence; we don't need finer
            // granularity until we're closer to expiry.
            if remaining < 15 {
                logger.warning("[Background] ⏱ remaining: \(remainingStr) (CRITICAL <15s) | \(status)")
            } else {
                logger.info("[Background] ⏱ remaining: \(remainingStr) | \(status)")
            }
        }
        RunLoop.current.add(timer, forMode: .common)
        backgroundStatusTimer = timer
    }

    func stopBackgroundStatusTimer() {
        backgroundStatusTimer?.invalidate()
        backgroundStatusTimer = nil
    }

    /// Builds a one-line summary of current tool execution state for background logging.
    func backgroundToolStatusSummary() -> String {
        // Find the active assistant message (last one being processed)
        guard let assistantMsg = messages.last, assistantMsg.role == .assistant else {
            return "no active tool"
        }

        // Find the most recent tool block
        guard let toolBlock = assistantMsg.blocks.last(where: { $0.kind != .text }) else {
            return "streaming text (\(assistantMsg.blocks.last?.content.count ?? 0) chars)"
        }

        let toolName: String
        switch toolBlock.kind {
        case .text: toolName = "text"
        case .thinking: toolName = "thinking"
        case .shellTool: toolName = "shell"
        case .fileReadTool: toolName = "file_read"
        case .fileWriteTool: toolName = "file_write"
        case .fileEditTool: toolName = "file_edit"
        case .browserTool: toolName = "browser"
        case .readImageTool: toolName = "read_image"
        case .memoryTool: toolName = "memory"
        case .info: toolName = "info"
        }

        let elapsed: String
        if let start = toolBlock.toolStartTime {
            elapsed = String(format: "%.1fs", Date().timeIntervalSince(start))
        } else {
            elapsed = "?"
        }

        let statusStr: String
        switch toolBlock.toolStatus {
        case .streaming(let bytes):
            statusStr = "streaming(\(bytes)B)"
        case .running:
            statusStr = "running"
        case .success:
            statusStr = "success"
        case .failed:
            statusStr = "failed"
        case .cancelled:
            statusStr = "cancelled"
        case .none:
            statusStr = "pending"
        }

        let outputInfo = toolBlock.content.isEmpty ? "" : " outputBytes=\(toolBlock.content.utf8.count)"

        // Browser-specific info
        var browserInfo = ""
        if case .browserTool = toolBlock.kind {
            if let bm = browserTabPool.activeManager {
                browserInfo = " hasURL=\(!bm.currentURL.isEmpty)"
                if bm.isLoading {
                    browserInfo += " loading=true"
                }
            }
        }

        // Running command PID info
        var pidInfo = ""
        if !runningCommandPids.isEmpty {
            let pidList = runningCommandPids.sorted().map(String.init).joined(separator: ",")
            pidInfo = " pids=[\(pidList)]"
        }

        let summary = "tool=\(toolName) status=\(statusStr) elapsed=\(elapsed)\(pidInfo)\(outputInfo)\(browserInfo)"
        SessionActivityTracker.shared.currentToolStatus = "\(toolName): \(statusStr)"
        if let sid = self.sessionId {
            SessionActivityTracker.shared.updateToolInfo(sessionId: sid, toolName: toolName, toolStatus: statusStr)
            if #available(iOS 26.0, *) {
                let iteration = SessionActivityTracker.shared.sessionToolInfo[sid]?.loopIteration ?? 0
                AgentContinuedProcessingManager.shared.update(
                    sessionKey: continuedProcessingSessionKey ?? sid,
                    subtitle: toolName.replacingOccurrences(of: "_", with: " ").capitalized,
                    loopIteration: iteration
                )
            }
        }
        return summary
    }

    /// Called from the agent loop after a tool result is collected.
    /// If the background task was expired, this suspends the loop until
    /// the app returns to the foreground, then re-registers a background task
    /// so the next iteration can proceed.
    func waitIfBackgroundSuspended() async {
        // If enhanced background keep-alive is active, skip suspension entirely
        if BackgroundKeepAliveManager.shared.enhancedBackgroundEffective { return }
        guard backgroundSuspended else { return }

        // If the app is already in the foreground (user returned before we got here),
        // just clear the flag, re-register background task, and continue.
        if UIApplication.shared.applicationState == .active {
            logger.info("[Background] App already active — resuming immediately")
            backgroundSuspended = false
            if let activityKey = sessionId ?? draftId {
                SessionActivityTracker.shared.updateActivityPhase(
                    activityKey,
                    phase: .preparing
                )
            }
            beginBackgroundProcessing()
            return
        }

        logger.info("[Background] Agent loop suspended — waiting for foreground")

        // Listen for foreground notification to resume
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            self.foregroundContinuation = continuation
            self.foregroundObserver = NotificationCenter.default.addObserver(
                forName: UIApplication.willEnterForegroundNotification,
                object: nil,
                queue: .main
            ) { [weak self] _ in
                guard let self else { return }
                logger.info("[Background] Foreground notification — resuming agent loop")
                self.backgroundSuspended = false
                // Re-register a background task for the continued work
                self.beginBackgroundProcessing()
                if let c = self.foregroundContinuation {
                    self.foregroundContinuation = nil
                    c.resume()
                }
                if let obs = self.foregroundObserver {
                    NotificationCenter.default.removeObserver(obs)
                    self.foregroundObserver = nil
                }
            }
        }
        if let activityKey = sessionId ?? draftId {
            SessionActivityTracker.shared.updateActivityPhase(
                activityKey,
                phase: .preparing
            )
        }
    }

    /// Pauses the agent loop when the user activates browser takeover.
    /// The loop suspends here until the user dismisses the browser sheet.
    func waitIfBrowserTakeover() async {
        guard browserTakeoverActive else { return }
        logger.info("[Takeover] Agent loop pausing for browser takeover")
        if let activityKey = sessionId ?? draftId {
            SessionActivityTracker.shared.updateActivityPhase(
                activityKey,
                phase: .waitingForUser,
                reason: .browserTakeover
            )
        }
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            self.takeoverContinuation = continuation
        }
        logger.info("[Takeover] Agent loop resumed from browser takeover")
        if let activityKey = sessionId ?? draftId {
            SessionActivityTracker.shared.updateActivityPhase(
                activityKey,
                phase: .usingTool
            )
        }

        // Take a screenshot so the agent sees what the user did during takeover
        let screenshotInput = BrowserActionInput(
            action: .screenshot, url: nil, selector: nil, text: nil,
            coordinateX: nil, coordinateY: nil, direction: nil, amount: nil,
            script: nil, userAgent: nil, maxDepth: nil, tabId: nil
        )
        if let result = try? await browserTabPool.execute(action: screenshotInput),
           let b64 = result.base64Image,
           let data = Data(base64Encoded: b64) {
            // Persist the takeover screenshot the same way browser_use
            // does so request-level budget elision can point the model
            // back at it via read_image.
            let timestamp = Int(Date().timeIntervalSince1970)
            let screenshotFilename = "takeover_\(timestamp).jpg"
            let sid = sessionId ?? "unknown"
            let persistDir = Self.minisBrowserPersistentDir(for: sid)
            try? FileManager.default.createDirectory(at: persistDir, withIntermediateDirectories: true)
            let persistPath = persistDir.appendingPathComponent(screenshotFilename)
            try? data.write(to: persistPath)
            let linuxPath = "\(Self.minisBrowserLinuxDir)/\(screenshotFilename)"

            // Inject a user message with the takeover screenshot so the model sees the current state
            let takeoverNote = "[Browser takeover] The user manually operated the browser. Here is a screenshot of the current browser state after their interaction."
            let msg = AgentMessage(role: .user, parts: [
                .text(takeoverNote),
                .imageData(data: data, mimeType: "image/jpeg", linuxPath: linuxPath)
            ])
            agentHistory.append(msg)
        }
    }

    /// Waits for the user to finish a mid-action browser takeover.
    /// Called after `browserTabPool.execute(action:)` when `browserTakeoverActive` is true.
    /// Returns a fresh screenshot result after the user finishes, or nil on timeout.
    func waitForMidActionTakeover() async -> BrowserActionResult? {
        logger.info("[Takeover] Mid-action: pausing browser action for user takeover")
        if let activityKey = sessionId ?? draftId {
            SessionActivityTracker.shared.updateActivityPhase(
                activityKey,
                phase: .waitingForUser,
                reason: .browserTakeover
            )
        }

        // Start 5-minute timeout
        let timeoutTask = Task {
            try? await Task.sleep(nanoseconds: 5 * 60 * 1_000_000_000)
            guard !Task.isCancelled else { return }
            await MainActor.run {
                logger.info("[Takeover] Mid-action takeover timed out after 5 minutes")
                self.browserTakeoverActive = false
                if let c = self.midActionTakeoverContinuation {
                    self.midActionTakeoverContinuation = nil
                    c.resume()
                }
            }
        }
        self.takeoverTimeoutTask = timeoutTask

        // Suspend until the user finishes or timeout fires
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            self.midActionTakeoverContinuation = continuation
        }

        // Clean up timeout — if cancel() is a no-op, the timeout already fired
        let timedOut = timeoutTask.isCancelled == false
        timeoutTask.cancel()
        self.takeoverTimeoutTask = nil

        logger.info("[Takeover] Mid-action: resumed (timedOut=\(timedOut))")
        if let activityKey = sessionId ?? draftId {
            SessionActivityTracker.shared.updateActivityPhase(
                activityKey,
                phase: .usingTool
            )
        }

        // Take a fresh screenshot so the agent sees the user's changes
        let screenshotInput = BrowserActionInput(
            action: .screenshot, url: nil, selector: nil, text: nil,
            coordinateX: nil, coordinateY: nil, direction: nil, amount: nil,
            script: nil, userAgent: nil, maxDepth: nil, tabId: nil
        )
        if let result = try? await browserTabPool.execute(action: screenshotInput) {
            return result
        }
        return nil
    }

    /// Called when the user dismisses the browser takeover sheet.
    func resumeFromBrowserTakeover() {
        browserTakeoverActive = false
        // Cancel mid-action timeout
        takeoverTimeoutTask?.cancel()
        takeoverTimeoutTask = nil
        // Resume mid-action continuation if active
        if let c = midActionTakeoverContinuation {
            midActionTakeoverContinuation = nil
            c.resume()
        }
        // Resume between-turn continuation if active
        if let c = takeoverContinuation {
            takeoverContinuation = nil
            c.resume()
        }
    }

    /// - Parameter scope: `.allSessions` (default) matches the user-facing
    ///   stop button — one tap cancels every in-flight shell, including a
    ///   concurrent tool batch. `.thisSessionOnly` is for the background
    ///   expiry path: [T-bg-expiry-cross-session-kill] that path used to call
    ///   the broad variant, so ONE session running out of background time
    ///   killed the shells of every OTHER running session too, which reads as
    ///   tasks being interrupted at random.
    enum StopScope {
        case allSessions
        case thisSessionOnly
    }

    /// [T-bg-expiry-cross-session-kill] Default is `.thisSessionOnly`.
    ///
    /// Every caller of this method is a per-session action — a Stop tap in one
    /// chat, one session's background expiry, one bubble's cancel button — and
    /// a view model *is* a session. Defaulting to `.allSessions` meant tapping
    /// Stop in chat A silently killed the shells of chats B and C, which is
    /// the single biggest source of "my task got interrupted for no reason".
    /// Concurrent tool batches are within one session, so the batch is still
    /// cancelled whole. `.allSessions` remains for a deliberate stop-everything
    /// caller, which today reaches each session through its own view model.
    func stopCurrentCommand(scope: StopScope = .thisSessionOnly) {
        // A tool can be in several cancellable states:
        //   - one or more live iSH processes (runningCommandPids non-empty),
        //   - a pre-execution delay countdown (toolDelayWaitActive),
        //   - an in-flight browser_use load (a tab is mid-navigation).
        // Any of these is a valid stop target. [T-ios-browser-tool-stop-button]
        // Browser tools don't go through iSH, so without the hasLoadingTab arm
        // the per-bubble stop button was a NOOP for a hung `navigate` — it bailed
        // here because runningCommandPids was empty. Bail only when NONE apply,
        // so random taps don't poison the flag for a future real invocation.
        let browserLoading = browserTabPool.hasLoadingTab
        let browserActionActive = browserTabPool.hasActiveAgentAction
        guard !runningCommandPids.isEmpty || toolDelayWaitActive || browserLoading || browserActionActive else { return }
        commandCancelledByUser = true
        // Stop any in-flight browser page loads. stopLoading() resolves the
        // manager's navigationContinuation, so the awaited browserTabPool
        // .execute(action:) returns and the hung tool call completes.
        if browserLoading {
            let n = browserTabPool.stopAllLoading()
            logger.info("⏹️ stopCurrentCommand — stopped \(n) loading browser tab(s)")
        }
        if browserActionActive {
            let n = browserTabPool.cancelAllAgentActions()
            logger.info("⏹️ stopCurrentCommand — cancelled \(n) browser action(s)")
        }
        // Stop the running shells — concurrent tool execution can have many in
        // flight at once and a stop should cancel the whole batch, but only
        // this session's. [T-concurrent-tools 2026-05-25]
        if !runningCommandPids.isEmpty {
            // The coordinator's no-argument stopCurrentCommand() means "kill
            // every in-flight pid across EVERY session"; the sessionId overload
            // is scoped. Concurrent batches live inside one session, so the
            // scoped call still cancels the entire batch.
            let sid = sessionId
            switch scope {
            case .allSessions:
                Task { await ISHExecutionCoordinator.shared.stopCurrentCommand() }
            case .thisSessionOnly:
                if let sid {
                    Task { await ISHExecutionCoordinator.shared.stopCurrentCommand(sessionId: sid) }
                }
                // No session id ⇒ nothing of OURS can be running (pids only
                // exist under a real sid) — the old fallback killed every
                // other session's shells instead, which is the exact opposite
                // of "this session only".
            }
        }
        runningCommandPids.removeAll()
        commandStartTime = nil
    }

    func clearChat() {
        messages.removeAll()
        agentHistory.removeAll()
        toolSnapshots.removeAll()
        errorMessage = nil
        cachedLatestMarker = nil
        toolLoopDetector.reset()

        if let sessionId {
            Task { await ISHExecutionCoordinator.shared.sessionDidTerminate(sessionId: sessionId) }
            BrowserTabPool.deletePersistedData(for: sessionId)
            BrowserUseOffloadBridge.releasePool(forSession: sessionId)
            Task {
                await ChatStore.shared.deleteMessages(sessionId: sessionId)
                await ChatStore.shared.deleteCompactMarkers(sessionId: sessionId)
            }
        }
    }

}

// MARK: - iOS 26 user-initiated continued processing

/// Bridges an already-running Agent loop to iOS 26's system-supported
/// continued-processing grant. The grant improves lock-screen continuity and
/// reports system progress, but every expiration still flows through the
/// existing suspend-and-resume path because iOS can revoke it under pressure.
@available(iOS 26.0, *)
@MainActor
final class AgentContinuedProcessingManager {
    static let shared = AgentContinuedProcessingManager()

    private final class Run {
        let sessionKey: String
        let identifier: String
        let expiration: () -> Void
        var task: BGContinuedProcessingTask?
        var lastProgress: Int64 = 1

        init(sessionKey: String, identifier: String, expiration: @escaping () -> Void) {
            self.sessionKey = sessionKey
            self.identifier = identifier
            self.expiration = expiration
        }
    }

    private var runs: [String: Run] = [:]

    private init() {}

    func begin(
        sessionKey: String,
        title: String,
        subtitle: String,
        onExpiration: @escaping () -> Void
    ) {
        guard !sessionKey.isEmpty, runs[sessionKey] == nil else { return }
        let identifier = "com.leoyuan.leophoneagent.agent.\(UUID().uuidString)"
        let run = Run(sessionKey: sessionKey, identifier: identifier, expiration: onExpiration)
        runs[sessionKey] = run

        let registered = BGTaskScheduler.shared.register(
            forTaskWithIdentifier: identifier,
            using: nil
        ) { [weak self] task in
            guard let continuedTask = task as? BGContinuedProcessingTask else {
                task.setTaskCompleted(success: false)
                return
            }
            Task { @MainActor [weak self] in
                self?.attach(continuedTask, identifier: identifier)
            }
        }
        guard registered else {
            runs.removeValue(forKey: sessionKey)
            logger.warning("[Background][Continued] registration rejected")
            return
        }

        let request = BGContinuedProcessingTaskRequest(
            identifier: identifier,
            title: title,
            subtitle: subtitle
        )
        request.strategy = .queue
        do {
            try BGTaskScheduler.shared.submit(request)
            logger.info("[Background][Continued] submitted session=\(sessionKey.prefix(8))")
        } catch {
            runs.removeValue(forKey: sessionKey)
            logger.warning("[Background][Continued] submit failed code=\((error as NSError).code)")
        }
    }

    func isActive(sessionKey: String) -> Bool {
        // A queued request is not an execution grant yet. Only let the finite
        // UIKit task re-arm after the scheduler has actually delivered a
        // BGContinuedProcessingTask; otherwise normal expiration must suspend.
        runs[sessionKey]?.task != nil
    }

    func update(sessionKey: String, subtitle: String, loopIteration: Int) {
        guard let run = runs[sessionKey] else { return }
        let measured = Int64(min(92, max(Int(run.lastProgress), 8 + (loopIteration * 8))))
        run.lastProgress = measured
        guard let task = run.task else { return }
        task.progress.completedUnitCount = measured
        task.updateTitle("LeoPhoneAgent task", subtitle: subtitle.isEmpty ? "Working" : subtitle)
    }

    func finish(sessionKey: String, success: Bool) {
        guard let run = runs.removeValue(forKey: sessionKey) else { return }
        BGTaskScheduler.shared.cancel(taskRequestWithIdentifier: run.identifier)
        if let task = run.task {
            task.progress.completedUnitCount = success ? 100 : max(1, run.lastProgress)
            task.setTaskCompleted(success: success)
        }
        logger.info("[Background][Continued] finished session=\(sessionKey.prefix(8)) success=\(success)")
    }

    private func attach(_ task: BGContinuedProcessingTask, identifier: String) {
        guard let run = runs.values.first(where: { $0.identifier == identifier }) else {
            task.setTaskCompleted(success: false)
            return
        }
        run.task = task
        task.progress.totalUnitCount = 100
        task.progress.completedUnitCount = run.lastProgress
        task.expirationHandler = { [weak self, weak run] in
            Task { @MainActor in
                guard let self, let run,
                      self.runs.removeValue(forKey: run.sessionKey) != nil else { return }
                run.task?.setTaskCompleted(success: false)
                run.expiration()
            }
        }
        logger.info("[Background][Continued] running session=\(run.sessionKey.prefix(8))")
    }
}
