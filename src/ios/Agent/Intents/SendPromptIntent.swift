import AppIntents
import Foundation
import UniformTypeIdentifiers
import UserNotifications

/// Sends a prompt to the LeoPhoneAgent AI agent and returns immediately with structured session info.
/// The agent continues running in the background — use Get Session Status to poll for completion.
struct SendPromptIntent: AppIntent {
    static var title: LocalizedStringResource = "Send Prompt"
    static var description = IntentDescription("Sends a prompt to the LeoBot AI agent. Returns session info immediately while the task runs in the background.")
    static var openAppWhenRun = false
    static var authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication
    static var supportedModes: IntentModes = [.background, .foreground(.deferred)]

    @Parameter(title: "Prompt", requestValueDialog: "What would you like to ask LeoBot?")
    var prompt: String

    @Parameter(title: "Attachments", description: "Images, videos, or files to attach to the prompt. Accepts output from previous Shortcuts actions (e.g. filtered photos or documents).",
               supportedContentTypes: [.image, .movie, .data],
               inputConnectionBehavior: .connectToPreviousIntentResult)
    var files: [IntentFile]?

    @Parameter(title: "Session", description: "Existing session to continue. Leave empty for a new session.")
    var session: SessionEntity?

    @Parameter(title: "Model", description: "Specify a model or model group to use. Leave empty to use the app default.")
    var model: ModelSelectionEntity?

    @Parameter(title: "Wait for Result", description: "When enabled, waits for the AI to finish and returns the full response. Use this to chain the result into subsequent Shortcuts actions.", default: false)
    var waitForResult: Bool

    /// [C4] 接「搜索藏宝阁」的结果:条目作为不可信资料上下文随提示发送(不显示在气泡里)。
    @Parameter(title: "藏宝阁条目", description: "可选。接上一步「搜索藏宝阁」的结果，Agent 会读取这些条目的内容。")
    var treasuryItems: [TreasuryItemEntity]?

    @MainActor
    func perform() async throws -> some IntentResult & ReturnsValue<SendPromptResult> & ProvidesDialog {
        if let lockedId = session?.id, SessionLockStore.shared.isHiddenFromSystemSurfaces(lockedId) {
            throw SessionLockedIntentError.locked
        }
        // Ensure BackgroundKeepAliveManager is set up
        BackgroundKeepAliveManager.shared.setup()

        // [T-shortcuts-eager-keepalive] Arm keep-alive BEFORE any await. For an
        // existing session we already know the id; for a NEW session we don't
        // have one yet (ensureSessionReturningId will create it a moment later),
        // so we register a temporary placeholder id — enough to make the
        // activeSessions Set non-empty and flip isActive=true. Once the real
        // sessionId lands we re-arm with the real id and drop the placeholder.
        // This is strictly no-op unless enhancedBackgroundEffective is on.
        let placeholderSid: String? = (session == nil) ? "intent-eager:\(UUID().uuidString)" : nil
        let eagerInitialSid = session?.id ?? placeholderSid ?? ""
        var eagerArmed = false
        var eagerSkipReason: String? = nil
        if !eagerInitialSid.isEmpty {
            let r = BackgroundKeepAliveManager.shared.armEagerlyForShortcut(
                sessionId: eagerInitialSid, caller: "SendPromptIntent")
            eagerArmed = r.armed
            eagerSkipReason = r.skipReason
        }
        // [T-ios-session-status-mismatch] Guarantee the eager placeholder is
        // dropped no matter how this perform() exits (throw / early return /
        // ensureSessionReturningId returns without a sessionId). Without this,
        // a failed shortcut invocation leaves "intent-eager:<UUID>" stuck in
        // SessionActivityTracker.activeSessions forever — phantom "running"
        // session on the home spinner, inflated `chat.session.status`, Live
        // Activity count skew. Only the placeholder needs a safety net: the
        // real sessionId path (session != nil) is paired by the VM's
        // $isProcessing sink via loadSession + send(). setInactive is
        // idempotent so the explicit swap path (line ~93) is unaffected.
        defer {
            if let placeholder = placeholderSid, eagerArmed {
                SessionActivityTracker.shared.setInactive(placeholder,
                    source: "SendPromptIntent.eager.cleanupDefer")
            }
        }
        // [T-shortcuts-diag-and-pending] Snapshot state + mark pending. For a
        // new-session flow the sessionId here is the placeholder — that's fine
        // for diagnostics; the record is cleared by the completion path either
        // way and doesn't need to carry the eventual real id.
        let diagSessionId = eagerInitialSid.isEmpty ? "unknown" : eagerInitialSid
        ShortcutRunTracker.logPerformEntry(
            intent: "SendPromptIntent",
            sessionId: diagSessionId,
            eagerKeepAliveArmed: eagerArmed,
            eagerKeepAliveSkippedReason: eagerSkipReason
        )
        let pendingId = ShortcutRunTracker.markPending(
            intent: "SendPromptIntent",
            sessionId: diagSessionId,
            eagerKeepAliveArmed: eagerArmed,
            eagerKeepAliveSkippedReason: eagerSkipReason
        )

        // Headless run: external folder mounts are activated from the root view,
        // which this process may never build. Wait (bounded) so the agent sees
        // /var/minis/mounts on a cold or force-quit launch.
        await MountedFoldersManager.shared.ensureActivated(timeout: 12)
        let vm: AIChatViewModel
        let isNewSession: Bool
        if let session = session {
            let (cached, isNew) = ViewModelCache.shared.getOrCreate(for: session.id)
            vm = cached
            // A cached view model is already current (and may be the chat on
            // screen). loadSession() also marks the session as the one on
            // screen; it isn't.
            if isNew {
                let onScreen = AIChatViewModel.activeSessionId
                await vm.loadSession()
                AIChatViewModel.activeSessionId = onScreen
            }
            isNewSession = false
        } else {
            vm = ViewModelCache.shared.createDraft()
            isNewSession = true
        }

        // For new sessions, create the DB record first
        if isNewSession {
            vm.sessionSource = "shortcut"
            // Creating the session marks it as the one on screen, too.
            let onScreen = AIChatViewModel.activeSessionId
            await vm.ensureSessionReturningId()
            AIChatViewModel.activeSessionId = onScreen
            // [T-shortcuts-eager-keepalive] Real id now known — re-arm with it
            // (keeps activeSessions non-empty across the swap) and drop the
            // placeholder so it doesn't linger. Re-arm is idempotent when the
            // engine is already running.
            if let placeholder = placeholderSid, let realSid = vm.sessionId {
                BackgroundKeepAliveManager.shared.armEagerlyForShortcut(
                    sessionId: realSid, caller: "SendPromptIntent.swap")
                SessionActivityTracker.shared.setInactive(placeholder,
                    source: "SendPromptIntent.eager.placeholderSwap")
            }
        }

        // Do not overwrite the composer of a running session. A Shortcut can
        // wait for it, just as the dedicated follow-up action already does.
        if vm.isProcessing {
            for await processing in vm.$isProcessing.values where !processing { break }
        }
        try Task.checkCancellation()

        // Apply model override if specified (nil = use app default, backward-compatible)
        if let modelSelection = model, let sid = vm.sessionId {
            let store = ProviderConfigStore.shared
            if let binding = modelSelection.toSessionModelBinding(sessionId: sid, store: store) {
                store.setBinding(binding, for: sid)
            }
        }

        // Add file attachments if provided
        if let intentFiles = files {
            for file in intentFiles {
                let name = Self.resolvedFileName(for: file)
                vm.addDataAttachment(data: file.data, fileName: name)
            }
        }

        // Send the prompt
        // [T-widget-stop-eager-placeholder] Same check QuickTaskIntent has: a
        // Stop tapped during session creation could only see the placeholder
        // id, which has no view model — honour it here instead of starting the
        // run the user just asked to stop.
        if let placeholderSid, SessionActivityTracker.shared.takeEagerCancel(placeholderSid) {
            vm.cancel(queuePolicy: .discardQueuedPrompts)
            throw QuickTaskIntentError.cancelledBeforeStart
        }

        // [T-ios27-voice-only] Siri with no screen (AirPods, CarPlay, a locked
        // phone): the answer is heard, not read — ask for a short spoken reply.
        var voiceOnly = false
        if #available(iOS 27, *) { voiceOnly = systemContext.isVoiceOnly }
        let sid = vm.sessionId ?? "unknown"
        // [C4] 选中的藏宝阁条目 → 与「发给 Agent」同一个构造器生成的资料上下文。
        let treasuryContext = await Self.treasuryContext(for: treasuryItems)
        // [T-headless-draft] 这个对话若也开在界面上,VM 是同一个:只发这条提示,用户没发出的草稿原样留着。
        let runId = try vm.withComposerSetAside {
            vm.inputText = voiceOnly ? prompt + Self.voiceOnlyReminder : prompt
            vm.pendingTreasuryContext = treasuryContext
            return try Self.dispatchRun(vm: vm, sessionId: sid, pendingId: pendingId) { vm.send() }
        }

        // Resolve actual model from session binding (matches what the agent loop uses)
        var modelName = vm.selectedModel.displayName
        let store = ProviderConfigStore.shared
        if let binding = store.binding(for: sid) {
            switch binding.primarySource {
            case .group(_, let resolvedEntryId):
                if let entry = store.entry(for: resolvedEntryId) {
                    modelName = entry.model.displayName
                }
            case .directEntry(let modelEntryId, _):
                if let entry = store.entry(for: modelEntryId) {
                    modelName = entry.model.displayName
                }
            }
        }

        // Local notification: task started
        let promptPreview = String(prompt.prefix(50))
        ShortcutNotification.post(
            id: "shortcut-start-\(sid)",
            title: String(localized: "LeoBot 任务已开始"),
            body: "\(modelName): \(promptPreview)\(prompt.count > 50 ? "…" : "")",
            sessionId: sid
        )

        if waitForResult {
            let settle = {
                await Self.settleRun(
                    sessionId: sid, runId: runId, pendingId: pendingId,
                    title: String(localized: "LeoBot 任务"), notificationId: "shortcut-done")
            }
            // [T-ios27-long-running] iOS 27 lets a waiting shortcut outlive the
            // ~30 s intent budget instead of being cut off mid-answer.
            let settled: (outcome: AgentRunOutcome, text: String)
            if #available(iOS 27, *) {
                // [C12] 按工具步数汇报进度,系统据此延长运行时间。
                let progress = self.progress
                let reporter = Task { @MainActor in
                    await Self.reportToolProgress(progress, runId: runId, sessionId: sid)
                }
                defer { reporter.cancel() }
                settled = try await performBackgroundTask { await settle() }
            } else {
                settled = await settle()
            }
            let responseText = settled.text

            let result = SendPromptResult(
                sessionId: sid,
                modelName: modelName,
                status: settled.outcome.shortcutStatus,
                isNewSession: isNewSession,
                prompt: prompt,
                responseText: responseText,
                artifactFileNames: await SendPromptResult.artifactNames(for: sid),
                runId: runId
            )
            let spoken = voiceOnly ? String(VoiceTextSanitizer.sanitize(responseText).prefix(240)) : String(responseText.prefix(500))
            // [C11] 锁屏 + 隐私模式:不朗读正文(结果值仍完整交给下一步动作)。
            let dialog = SiriReplyPrivacy.dialogText(
                spoken, deviceLocked: !UIApplication.shared.isProtectedDataAvailable,
                privacyMode: SiriReplyPrivacy.privacyModeEnabled, voiceOnly: voiceOnly)
            return .result(value: result, dialog: "\(dialog)")
        }

        // Async mode: return immediately, notify on completion in background
        Task { @MainActor in
            _ = await Self.settleRun(
                sessionId: sid, runId: runId, pendingId: pendingId,
                title: String(localized: "LeoBot 任务"), notificationId: "shortcut-done")
        }

        let result = SendPromptResult(
            sessionId: sid,
            modelName: modelName,
            status: "Running",
            isNewSession: isNewSession,
            prompt: prompt,
            runId: runId
        )

        return .result(value: result, dialog: "Task started with \(modelName). I'll notify you when it's done.")
    }

    /// [C4] 把选中的藏宝阁条目做成不可信资料上下文;没有条目或都已删除时为 nil。
    @MainActor
    static func treasuryContext(for entities: [TreasuryItemEntity]?) async -> String? {
        guard let entities, !entities.isEmpty else { return nil }
        let wanted = Set(entities.map(\.id))
        let items = Array(CollectionStore.load().filter { wanted.contains($0.id) }.prefix(20))
        guard !items.isEmpty else { return nil }
        let context = await TreasuryContextBuilder.build(items: items)
        return context.isEmpty ? nil : context
    }

    /// [C12] 每 2 秒按本次运行已用的工具步数更新 Progress(总数 = 步数 + 1,未完成时不会满格)。
    @available(iOS 27, *)
    @MainActor
    static func reportToolProgress(_ progress: Progress, runId: String, sessionId: String) async {
        while !Task.isCancelled {
            let steps = AgentActivityLog.shared.recent(limit: 200, sessionId: sessionId)
                .filter { $0.runId == runId && $0.kind == .toolChanged }.count
            progress.totalUnitCount = Int64(steps + 1)
            progress.completedUnitCount = Int64(steps)
            try? await Task.sleep(for: .seconds(2))
        }
    }

    /// Appended to a voice-only prompt; stripped from what the chat displays.
    static let voiceOnlyReminder = "\n\n<system-reminder>This request came through Siri with no screen — the reply will be read aloud. Do the task as usual, but answer in plain spoken language: no Markdown, lists, tables or code, lead with the answer, about three short sentences unless the user asked for detail.</system-reminder>"

    /// Ensures the IntentFile has a usable filename with a correct extension.
    /// Shortcuts often passes files with no extension (e.g. "IMG_1234") or a
    /// generic name like "Photo". This uses the IntentFile's UTType to append
    /// a proper extension when the filename lacks one.
    static func resolvedFileName(for file: IntentFile) -> String {
        let name = file.filename
        let ext = (name as NSString).pathExtension.lowercased()
        // Already has a known extension — use as-is
        if !ext.isEmpty { return name }
        // Derive extension from the IntentFile's declared UTType
        if let type = file.type,
           let preferred = type.preferredFilenameExtension {
            return "\(name).\(preferred)"
        }
        return name
    }

    /// Register the run before asynchronous compaction/kernel startup so the
    /// result remains correlated even when the intent's process is suspended.
    @MainActor
    static func dispatchRun(vm: AIChatViewModel, sessionId: String, pendingId: String,
                            action: () -> Void) throws -> String {
        var accepted = false
        defer {
            if !accepted { ShortcutRunTracker.markCompleted(recordId: pendingId, reason: "not_started") }
        }
        try Task.checkCancellation()
        guard !vm.isProcessing else { throw QuickTaskIntentError.sessionBusy }
        let tracker = SessionActivityTracker.shared
        tracker.setActive(sessionId, source: "Intent.dispatch")
        guard let runId = tracker.currentRunId(for: sessionId) else {
            throw QuickTaskIntentError.notStarted
        }
        action()
        guard vm.isProcessing || vm.isCompacting || vm.compactAndSendRequestId != nil else {
            tracker.setInactive(sessionId, finalPhase: .failed,
                                reason: .providerFailure, source: "Intent.notStarted")
            throw QuickTaskIntentError.notStarted
        }
        // [T-full-auto] 经 App Intent 派发的任务,日志来源记为快捷指令(定时任务会先声明)。放在真正开跑之后:
        // send() 会先清掉旧标签;被"忙"拒掉的那次也不会留下标签。同一个主线程回合里,工具还没来得及执行。
        TaskSourceRegistry.tagIntentRun(sessionId: sessionId)
        accepted = true
        return runId
    }

    @MainActor
    static func waitForRun(runId: String, timeout: TimeInterval = 15 * 60) async -> AgentRunOutcome {
        let deadline = ContinuousClock.now.advanced(by: .seconds(timeout))
        while true {
            let outcome = AgentRunOutcome(state: AgentActivityLog.shared.runState(runId: runId),
                                          expectedRunId: runId)
            guard outcome.shouldKeepObserving, !Task.isCancelled,
                  ContinuousClock.now < deadline else { return outcome }
            do { try await Task.sleep(for: .seconds(1)) }
            catch { return outcome } // observation cancelled, not the actual run
        }
    }

    @MainActor
    static func settleRun(sessionId: String, runId: String,
                          pendingId: String, title: String,
                          notificationId: String) async -> (outcome: AgentRunOutcome, text: String) {
        let outcome = await waitForRun(runId: runId)
        if AgentActivityLog.shared.runState(runId: runId)?.phase.isTerminal == true
            || outcome == .waitingForUser || outcome == .suspended {
            ShortcutRunTracker.markCompleted(recordId: pendingId, reason: outcome.rawValue)
        }
        let response = outcome == .succeeded
            ? await AgentRunResultReader.text(sessionId: sessionId, runId: runId) : ""
        let text = response.isEmpty ? outcome.summary : response
        // A timeout only stops this observer. It cannot fabricate a completion
        // notification or mutate the state of the still-running task.
        if !outcome.shouldKeepObserving {
            ShortcutNotification.post(id: "\(notificationId)-\(runId)",
                                      title: "\(title) · \(outcome.statusLabel)",
                                      body: String(text.prefix(200)), sessionId: sessionId)
        }
        return (outcome, text)
    }
}

@available(iOS 27, *)
extension SendPromptIntent: LongRunningIntent {}

/// Helper for posting local notifications from Shortcuts intents.
/// Tapping the notification opens the associated session.
enum ShortcutNotification {
    /// Category ID for shortcut task notifications — enables tap-to-open-session.
    static let categoryId = "SHORTCUT_TASK"

    static func post(id: String, title: String, body: String, sessionId: String) {
        // Respect the global task notifications toggle
        guard UserDefaults.standard.object(forKey: "backgroundNotificationsEnabled") == nil
                || UserDefaults.standard.bool(forKey: "backgroundNotificationsEnabled") else { return }

        let center = UNUserNotificationCenter.current()

        // Request permission if needed (no-op if already granted)
        center.requestAuthorization(options: [.alert, .sound, .badge]) { _, _ in }

        LeoNotificationCategories.register()

        let content = UNMutableNotificationContent()
        content.title = title
        // Task Status Privacy (on by default) promises no prompt or reply text here;
        // a Face-ID-locked session never shows its reply on the lock screen either.
        let privacy = UserDefaults.standard.object(forKey: "liveActivityPrivacyMode") as? Bool ?? true
        let hidden = privacy || SessionLockStore.isHiddenFromSystemSurfaces(sessionId)
        content.body = hidden ? String(localized: "打开 App 查看") : body
        content.sound = .default
        content.categoryIdentifier = categoryId
        content.userInfo = ["sessionId": sessionId]
        content.applyFocusQuiet()

        // Increment app badge count
        let current = UIApplication.shared.applicationIconBadgeNumber
        content.badge = NSNumber(value: current + 1)
        UIApplication.shared.applicationIconBadgeNumber = current + 1

        let request = UNNotificationRequest(
            identifier: id,
            content: content,
            trigger: nil  // deliver immediately
        )
        center.add(request)
    }
}

/// [T-notification-tap-vs-launch-session] Cold-launch handoff for a
/// notification-tap navigation. On a cold launch the delegate's `didReceive`
/// fires before ContentView has mounted its `.onReceive(.openSessionFromIntent)`
/// subscriber, so the posted NotificationCenter event is simply lost — and the
/// Launch Session preference (e.g. "New Chat") then opens a fresh session
/// instead of the tapped one. The delegate buffers the target here;
/// ContentView's launch `.task` consumes it with top priority, and the warm
/// path (`.onReceive` did navigate) marks it handled so the launch-screen
/// logic yields either way.
@MainActor
final class NotificationNavigationStore {
    static let shared = NotificationNavigationStore()

    private var pendingSessionId: String?
    private var pendingSetAt: Date?
    private var handledAt: Date?
    /// A Mac session tapped in a notification (host + the Mac's session id).
    private var pendingMac: (target: [String: String], at: Date)?

    func setPendingMac(_ target: [String: String]) {
        // Mac 控制台也在本机工作区里呈现；冷启动缓冲时一并切回本机。
        IOSExecutionBackend.selectLocal()
        pendingMac = (target, Date())
    }

    /// Cold-launch consume, same 30 s rule as `takePending()`.
    func takePendingMac() -> [String: String]? {
        defer { pendingMac = nil }
        guard let pendingMac, Date().timeIntervalSince(pendingMac.at) < 30 else { return nil }
        return pendingMac.target
    }

    /// Buffer a tap target (called from didReceive before posting the event).
    func setPending(_ sessionId: String) {
        // 推送、Spotlight、Siri 打开会话的冷启动缓冲点：持久化本机工作区，避免落在隐藏的服务器页。
        IOSExecutionBackend.selectLocal()
        pendingSessionId = sessionId
        pendingSetAt = Date()
    }

    /// One-shot consume for the cold-launch path. Entries older than 30s are
    /// stale (a warm tap that `.onReceive` already navigated for) and ignored.
    func takePending() -> String? {
        defer { pendingSessionId = nil; pendingSetAt = nil }
        guard let sid = pendingSessionId,
              let t = pendingSetAt,
              Date().timeIntervalSince(t) < 30 else { return nil }
        return sid
    }

    /// Warm path: `.onReceive` navigated directly — drop the buffered copy so
    /// a later launch can't replay it, and remember when it happened so an
    /// in-flight launch `.task` (post arrived during its await) doesn't
    /// clobber the navigation with the Launch Session default.
    func markHandled() {
        pendingSessionId = nil
        pendingSetAt = nil
        pendingMac = nil
        handledAt = Date()
    }

    /// True when a notification navigation happened moments ago — the
    /// launch-screen logic must not override it.
    var handledRecently: Bool {
        guard let t = handledAt else { return false }
        return Date().timeIntervalSince(t) < 10
    }
}

/// Handles notification tap → navigates to the session.
final class ShortcutNotificationDelegate: NSObject, UNUserNotificationCenterDelegate {
    static let shared = ShortcutNotificationDelegate()

    /// Call once at app startup to register as delegate. MUST run inside
    /// `application(_:didFinishLaunchingWithOptions:)` — if the delegate isn't
    /// set by the time didFinishLaunching returns, iOS does not deliver the
    /// cold-launch notification tap to `didReceive` at all (the SwiftUI
    /// `.onAppear` registration alone was too late, which is why tapping a
    /// notification on a killed app used to land on the Launch Session
    /// default instead of the tapped session).
    func register() {
        UNUserNotificationCenter.current().delegate = self
        // 审批按钮、回复框的类别启动即注册,锁屏与横幅上才有按钮。
        LeoNotificationCategories.register()
    }

    /// Called when user taps the notification (app in foreground or background).
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        // [T-siri-approval-notify] Mac 审批通知的按钮:不开 app,直接经
        // 中继送回决定。handle 返回 true 时它接管了 completionHandler。
        if HarnessApprovalNotifier.handle(response: response, completion: completionHandler) {
            return
        }
        if NotificationQuickReply.handle(response: response, completion: completionHandler) {
            return
        }
        let userInfo = response.notification.request.content.userInfo
        // [T-approval-vocab] 本机敏感操作的审批按钮:在锁屏 / 手表上直接裁决。
        if let decision = SensitiveToolGate.decision(forNotificationAction: response.actionIdentifier),
           let idString = userInfo["sensitiveToolApprovalId"] as? String,
           let requestId = UUID(uuidString: idString) {
            Task { @MainActor in
                SensitiveToolGate.shared.resolve(decision, requestId: requestId)
                completionHandler()
            }
            return
        }
        if let sessionId = userInfo["sessionId"] as? String {
            Task { @MainActor in
                // A notification outlives its session: tapping one for a
                // deleted chat would open an empty ghost chat.
                guard await ChatStore.shared.sessionExists(id: sessionId) else { return }
                // Held behind the app lock; buffer first (cold-launch
                // consumer), then post (warm-path consumer). Whichever runs
                // marks the other's copy dead.
                SessionLockStore.shared.runWhenUnlocked {
                    NotificationNavigationStore.shared.setPending(sessionId)
                    NotificationCenter.default.post(
                        name: .openSessionFromIntent,
                        object: nil,
                        userInfo: ["sessionId": sessionId]
                    )
                }
            }
        } else if let link = userInfo["paperclipURL"] as? String, let url = URL(string: link) {
            // [G5] Paperclip 工单完成通知：走 G7 深链打开该工单。
            Task { @MainActor in AppURLEntry.open(url, source: "paperclipNotification") }
        } else if let macSessionId = userInfo["harnessSessionId"] as? String, !macSessionId.isEmpty {
            // A Mac's "waiting for you" / "done": open that Mac session, not just the app.
            let target = ["macSessionId": macSessionId,
                          "hostId": userInfo["hostId"] as? String ?? "",
                          "machine": userInfo["machine"] as? String ?? ""]
            let openMac: @MainActor () -> Void = {
                SessionLockStore.shared.runWhenUnlocked {
                    NotificationNavigationStore.shared.setPendingMac(target)
                    NotificationCenter.default.post(name: .openSessionFromIntent, object: nil, userInfo: target)
                }
            }
            // [E5] 从手机对话派出的任务完成:回到那个对话(结果由回前台补齐写进 MacResultInbox,打开时显示并滚到底)。
            // 没带对话 id,或那个对话已经删了:照旧打开 Mac 任务。
            if let phoneSessionId = HarnessFullAuto.phoneSessionValue(userInfo["phoneSessionId"] as? String) {
                Task { @MainActor in
                    guard await ChatStore.shared.sessionExists(id: phoneSessionId) else { openMac(); return }
                    SessionLockStore.shared.runWhenUnlocked {
                        NotificationNavigationStore.shared.setPending(phoneSessionId)
                        NotificationCenter.default.post(name: .openSessionFromIntent, object: nil,
                                                        userInfo: ["sessionId": phoneSessionId])
                    }
                }
            } else {
                Task { @MainActor in openMac() }
            }
        }
        completionHandler()
    }

    /// Only called while the app is in the foreground.
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        let info = notification.request.content.userInfo
        LeoPerf.pushArrived(info)
        // [T-presence] You're looking at that very session: keep it in the
        // list, but no banner or sound over what's already on screen.
        let sessionId = (info["sessionId"] ?? info["harnessSessionId"] ?? info["session_id"]) as? String
        if let sessionId, !sessionId.isEmpty,
           sessionId == AIChatViewModel.activeSessionId
            || HarnessLiveActivityBridge.onScreenSessionIds.contains(sessionId) {
            completionHandler([.list])
            return
        }
        // [T-presence-quiet] 正在用 App:横幅会从灵动岛 / 屏幕顶上压住正在看的内容(用户 2026-09-26 反馈)。
        // 只有别的任务在等你批准才弹(不响)—— 不批它就一直卡着;完成、快捷指令结果这类只进通知中心。
        let category = notification.request.content.categoryIdentifier
        if category == HarnessApprovalNotifier.categoryId || category == SensitiveToolGate.notifyCategoryId {
            completionHandler([.banner, .list])
        } else {
            completionHandler([.list])
        }
    }
}

// MARK: - Notification categories

/// Every actionable category, registered in one place.
///
/// `setNotificationCategories` replaces the whole set, and a category is
/// matched by identifier — so each post site used to re-register ITS category
/// with no actions, which is how buttons could vanish depending on which
/// notification fired last. All sites now call this one function.
enum LeoNotificationCategories {
    static let backgroundTaskId = "BACKGROUND_TASK"

    static var all: [UNNotificationCategory] {
        [
            HarnessApprovalNotifier.category,
            SensitiveToolGate.notificationCategory,
            UNNotificationCategory(identifier: backgroundTaskId, actions: [NotificationQuickReply.action],
                                   intentIdentifiers: []),
            UNNotificationCategory(identifier: ShortcutNotification.categoryId, actions: [NotificationQuickReply.action],
                                   intentIdentifiers: []),
        ]
    }

    /// 本 App 所有类别都在 `all` 里,直接写全量:不先读再并(两处同时「读-并-写」会互相覆盖,
    /// 冷启动时可能把审批按钮抹掉),也就不存在先后顺序问题。
    static func register() {
        UNUserNotificationCenter.current().setNotificationCategories(Set(all))
    }
}

/// [T-notification-reply] "Task finished" → reply right from the notification
/// (lock screen, banner, watch) without opening the app. The text goes into
/// the same session: sent now, or queued if that session is still running.
enum NotificationQuickReply {
    static let actionId = "LEO_QUICK_REPLY"

    static var action: UNTextInputNotificationAction {
        UNTextInputNotificationAction(identifier: actionId, title: String(localized: "回复"), options: [.authenticationRequired],
                                      textInputButtonTitle: String(localized: "发送"),
                                      textInputPlaceholder: String(localized: "接着说…"))
    }

    /// Returns true when it handled the response (and owns `completion`).
    static func handle(response: UNNotificationResponse, completion: @escaping () -> Void) -> Bool {
        guard response.actionIdentifier == actionId,
              let reply = response as? UNTextInputNotificationResponse,
              let sessionId = response.notification.request.content.userInfo["sessionId"] as? String
        else { return false }
        let text = String(reply.userText.trimmingCharacters(in: .whitespacesAndNewlines).prefix(20_000))
        guard !text.isEmpty else { completion(); return true }
        Task { @MainActor in
            defer { completion() }
            // Unlocking iPhone is not unlocking a Face ID–locked conversation.
            if SessionLockStore.shared.isHiddenFromSystemSurfaces(sessionId) {
                let note = UNMutableNotificationContent()
                note.title = String(localized: "没有发送")
                note.body = String(localized: "这个会话已用 Face ID 锁定，请在 App 里打开后回复。")
                try? await UNUserNotificationCenter.current().add(
                    UNNotificationRequest(identifier: "quick-reply-locked-\(sessionId)", content: note, trigger: nil))
                return
            }
            BackgroundKeepAliveManager.shared.setup()
            _ = BackgroundKeepAliveManager.shared.armEagerlyForShortcut(
                sessionId: sessionId, caller: "NotificationQuickReply")
            let (vm, isNew) = ViewModelCache.shared.getOrCreate(for: sessionId)
            if isNew {
                // loadSession() marks this session as the one on screen; it isn't.
                let onScreen = AIChatViewModel.activeSessionId
                await vm.loadSession()
                AIChatViewModel.activeSessionId = onScreen
            }
            // Send just the reply; an unsent draft in that chat (text, attachments,
            // folded pastes) stays where it was.
            var sent = true
            vm.withComposerSetAside {
                vm.inputText = text
                if vm.isProcessing {
                    vm.enqueuePrompt()
                } else {
                    // Not a Shortcut run: no pending record, which would come back as a
                    // false "automation may not have completed" warning on the next open.
                    sent = (try? SendPromptIntent.dispatchRun(vm: vm, sessionId: vm.sessionId ?? sessionId,
                                                              pendingId: UUID().uuidString) { vm.send() }) != nil
                }
            }
            if !sent {
                // A reply that didn't go out waits in the composer, after the draft.
                vm.inputText = vm.inputText.isEmpty ? text : vm.inputText + "\n" + text
            }
        }
        return true
    }
}
