import AppIntents
import Foundation

private let logger = AppLogger(category: "AskMinisIntent")

/// Siri-facing "ask LeoPhoneAgent" entry point. Unlike `SendPromptIntent` (which runs
/// headless with `openAppWhenRun = false` for Shortcuts automations), this
/// intent OPENS the app and routes to the session so the user lands in the live
/// conversation — matching the "Hey Siri, ask LeoPhoneAgent to …" experience.
///
/// It reuses the exact normal send pipeline (`AIChatViewModel.send()`) and the
/// existing `.openSessionFromIntent` navigation path — no separate agent logic.
/// New session when `session` is nil; follow-up when a `SessionEntity` is given.
struct AskMinisIntent: AppIntent {
    static var title: LocalizedStringResource = "Ask LeoPhoneAgent"
    static var description = IntentDescription("Opens LeoPhoneAgent, sends your prompt, and shows the conversation. Starts a new session, or continues an existing one when you pick a session.")

    // Open the app and land in the conversation (the Siri experience). The send
    // itself still goes through the normal in-app pipeline.
    static var openAppWhenRun = true

    @Parameter(title: "Prompt", requestValueDialog: "What would you like to ask LeoPhoneAgent?")
    var prompt: String

    @Parameter(title: "Session", description: "Existing session to continue. Leave empty to start a new session.")
    var session: SessionEntity?

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog {
        // Same eager keep-alive discipline as SendPromptIntent: arm before any
        // await so an intent-woken process isn't suspended before the send path
        // flips isActive. No-op unless enhancedBackgroundEffective is on.
        BackgroundKeepAliveManager.shared.setup()
        let placeholderSid: String? = (session == nil) ? "intent-eager:\(UUID().uuidString)" : nil
        let eagerInitialSid = session?.id ?? placeholderSid ?? ""
        var eagerArmed = false
        if !eagerInitialSid.isEmpty {
            eagerArmed = BackgroundKeepAliveManager.shared.armEagerlyForShortcut(
                sessionId: eagerInitialSid, caller: "AskMinisIntent").armed
        }
        defer {
            if let placeholder = placeholderSid, eagerArmed {
                SessionActivityTracker.shared.setInactive(placeholder,
                    source: "AskMinisIntent.eager.cleanupDefer")
            }
        }

        // Resolve / create the target VM through the shared cache — identical to
        // SendPromptIntent so both paths converge on one send pipeline.
        let vm: AIChatViewModel
        if let session = session {
            let (cached, _) = ViewModelCache.shared.getOrCreate(for: session.id)
            vm = cached
            await vm.loadSession()
        } else {
            vm = ViewModelCache.shared.createDraft()
            vm.sessionSource = "siri"
            await vm.ensureSessionReturningId()
            if let placeholder = placeholderSid, let realSid = vm.sessionId {
                BackgroundKeepAliveManager.shared.armEagerlyForShortcut(
                    sessionId: realSid, caller: "AskMinisIntent.swap")
                SessionActivityTracker.shared.setInactive(placeholder,
                    source: "AskMinisIntent.eager.placeholderSwap")
            }
        }

        // If the session is mid-run, let it settle before appending (mirrors
        // FollowUpSessionIntent) so we don't send into an in-flight turn.
        if vm.isProcessing {
            for await processing in vm.$isProcessing.values where !processing { break }
        }

        // [T-widget-stop-eager-placeholder] Same check QuickTaskIntent has: a
        // Stop tapped during session creation could only see the placeholder
        // id, which has no view model — honour it here instead of starting the
        // run the user just asked to stop.
        if let placeholderSid, SessionActivityTracker.shared.takeEagerCancel(placeholderSid) {
            vm.cancel(queuePolicy: .discardQueuedPrompts)
            throw QuickTaskIntentError.cancelledBeforeStart
        }

        vm.inputText = prompt
        vm.send()

        let sid = vm.sessionId ?? session?.id ?? ""
        logger.info("AskMinis send sid=\(sid.prefix(8)) new=\(session == nil)")

        // Route the (now-open) app to this session. Same event ContentView and
        // the cold-launch buffer already consume for notification taps / deep
        // links — no new navigation surface.
        if !sid.isEmpty {
            NotificationNavigationStore.shared.setPending(sid)
            NotificationCenter.default.post(
                name: .openSessionFromIntent,
                object: nil,
                userInfo: ["sessionId": sid]
            )
        }

        return .result(dialog: "On it — opening LeoPhoneAgent.")
    }
}
