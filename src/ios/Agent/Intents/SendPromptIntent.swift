import AppIntents
import Foundation
import UniformTypeIdentifiers
import UserNotifications

/// Sends a prompt to the LeoPhoneAgent AI agent and returns immediately with structured session info.
/// The agent continues running in the background — use Get Session Status to poll for completion.
struct SendPromptIntent: AppIntent {
    static var title: LocalizedStringResource = "Send Prompt"
    static var description = IntentDescription("Sends a prompt to the LeoPhoneAgent AI agent. Returns session info immediately while the task runs in the background.")
    static var openAppWhenRun = false
    static var supportedModes: IntentModes = [.background, .foreground(.deferred)]

    @Parameter(title: "Prompt", requestValueDialog: "What would you like to ask LeoPhoneAgent?")
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

    @MainActor
    func perform() async throws -> some IntentResult & ReturnsValue<SendPromptResult> & ProvidesDialog {
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

        let vm: AIChatViewModel
        let isNewSession: Bool
        if let session = session {
            let (cached, _) = ViewModelCache.shared.getOrCreate(for: session.id)
            vm = cached
            await vm.loadSession()
            isNewSession = false
        } else {
            vm = ViewModelCache.shared.createDraft()
            isNewSession = true
        }

        // For new sessions, create the DB record first
        if isNewSession {
            vm.sessionSource = "shortcut"
            await vm.ensureSessionReturningId()
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
        vm.inputText = voiceOnly ? prompt + Self.voiceOnlyReminder : prompt
        let sid = vm.sessionId ?? "unknown"
        let runId = try Self.dispatchRun(vm: vm, sessionId: sid, pendingId: pendingId) { vm.send() }

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
            title: "LeoPhoneAgent Task Started",
            body: "\(modelName): \(promptPreview)\(prompt.count > 50 ? "…" : "")",
            sessionId: sid
        )

        if waitForResult {
            let settle = {
                await Self.settleRun(
                    sessionId: sid, runId: runId, pendingId: pendingId,
                    title: "LeoPhoneAgent Task", notificationId: "shortcut-done")
            }
            // [T-ios27-long-running] iOS 27 lets a waiting shortcut outlive the
            // ~30 s intent budget instead of being cut off mid-answer.
            let settled: (outcome: AgentRunOutcome, text: String)
            if #available(iOS 27, *) {
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
            return .result(value: result, dialog: "\(spoken)")
        }

        // Async mode: return immediately, notify on completion in background
        Task { @MainActor in
            _ = await Self.settleRun(
                sessionId: sid, runId: runId, pendingId: pendingId,
                title: "LeoPhoneAgent Task", notificationId: "shortcut-done")
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
                                      title: "\(title) · \(outcome.shortcutStatus)",
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
        content.body = body
        content.sound = .default
        content.categoryIdentifier = categoryId
        content.userInfo = ["sessionId": sessionId]

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

    /// Buffer a tap target (called from didReceive before posting the event).
    func setPending(_ sessionId: String) {
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
            DispatchQueue.main.async {
                // Buffer first (cold-launch consumer), then post (warm-path
                // consumer). Whichever runs marks the other's copy dead.
                NotificationNavigationStore.shared.setPending(sessionId)
                NotificationCenter.default.post(
                    name: .openSessionFromIntent,
                    object: nil,
                    userInfo: ["sessionId": sessionId]
                )
            }
        }
        completionHandler()
    }

    /// Show notification even when app is in foreground.
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
        if let sessionId, !sessionId.isEmpty, sessionId == AIChatViewModel.activeSessionId {
            completionHandler([.list])
            return
        }
        completionHandler([.banner, .sound])
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

    static func register() {
        let center = UNUserNotificationCenter.current()
        let ours = all
        let ids = Set(ours.map(\.identifier))
        center.getNotificationCategories { existing in
            center.setNotificationCategories(existing.filter { !ids.contains($0.identifier) }.union(ours))
        }
    }
}

/// [T-notification-reply] "Task finished" → reply right from the notification
/// (lock screen, banner, watch) without opening the app. The text goes into
/// the same session: sent now, or queued if that session is still running.
enum NotificationQuickReply {
    static let actionId = "LEO_QUICK_REPLY"

    static var action: UNTextInputNotificationAction {
        UNTextInputNotificationAction(identifier: actionId, title: String(localized: "回复"), options: [],
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
            BackgroundKeepAliveManager.shared.setup()
            let eager = BackgroundKeepAliveManager.shared.armEagerlyForShortcut(
                sessionId: sessionId, caller: "NotificationQuickReply")
            let (vm, isNew) = ViewModelCache.shared.getOrCreate(for: sessionId)
            if isNew { await vm.loadSession() }
            vm.inputText = text
            if vm.isProcessing {
                vm.enqueuePrompt()
                return
            }
            let pendingId = ShortcutRunTracker.markPending(
                intent: "NotificationQuickReply", sessionId: sessionId,
                eagerKeepAliveArmed: eager.armed, eagerKeepAliveSkippedReason: eager.skipReason)
            _ = try? SendPromptIntent.dispatchRun(vm: vm, sessionId: vm.sessionId ?? sessionId,
                                                  pendingId: pendingId) { vm.send() }
        }
        return true
    }
}
