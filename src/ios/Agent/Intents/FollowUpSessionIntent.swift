import AppIntents
import Foundation
import UniformTypeIdentifiers

private let logger = AppLogger(category: "FollowUpIntent")

/// Sends a follow-up prompt to an existing session, continuing the conversation.
struct FollowUpSessionIntent: AppIntent {
    static var title: LocalizedStringResource = "Follow Up Session"
    static var description = IntentDescription("Sends a follow-up prompt to an existing LOBE session, continuing the conversation with the AI agent.")
    static var openAppWhenRun = false
    static var authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication
    static var supportedModes: IntentModes = [.background, .foreground(.deferred)]

    @Parameter(title: "Session")
    var session: SessionEntity

    @Parameter(title: "Prompt", requestValueDialog: "What follow-up would you like to send?")
    var prompt: String

    @Parameter(title: "Attachments", description: "Images, videos, or files to attach to the prompt. Accepts output from previous Shortcuts actions (e.g. filtered photos or documents).",
               supportedContentTypes: [.image, .movie, .data],
               inputConnectionBehavior: .connectToPreviousIntentResult)
    var files: [IntentFile]?

    @Parameter(title: "Wait for Result", description: "When enabled, waits for the AI to finish and returns the full response for use in subsequent actions.", default: false)
    var waitForResult: Bool

    @MainActor
    func perform() async throws -> some IntentResult & ReturnsValue<SendPromptResult> & ProvidesDialog {
        if SessionLockStore.shared.isHiddenFromSystemSurfaces(session.id) {
            throw SessionLockedIntentError.locked
        }
        BackgroundKeepAliveManager.shared.setup()

        // [T-shortcuts-eager-keepalive] AppIntent-woken processes get very
        // little wall-clock time before iOS suspends them. The normal
        // setActive() sits behind vm.send() → currentTask → await
        // ensureSession() (2 actor hops + 2 SQLite writes), so the Combine
        // publisher never fires before suspend and silent-audio keep-alive
        // never starts. Arm it HERE, synchronously, before any await —
        // strictly no-op unless the user has enhancedBackgroundEffective on.
        let eagerResult = BackgroundKeepAliveManager.shared.armEagerlyForShortcut(
            sessionId: session.id, caller: "FollowUpSessionIntent")
        // [T-shortcuts-diag-and-pending] Snapshot everything relevant to a
        // future post-mortem AND write a persistent pending-run marker that
        // the completion observer below clears once the agent loop finishes.
        // If the process gets suspended without ever hitting that clear, the
        // record stays and the next foreground scan surfaces guidance.
        ShortcutRunTracker.logPerformEntry(
            intent: "FollowUpSessionIntent",
            sessionId: session.id,
            eagerKeepAliveArmed: eagerResult.armed,
            eagerKeepAliveSkippedReason: eagerResult.skipReason
        )
        let pendingId = ShortcutRunTracker.markPending(
            intent: "FollowUpSessionIntent",
            sessionId: session.id,
            eagerKeepAliveArmed: eagerResult.armed,
            eagerKeepAliveSkippedReason: eagerResult.skipReason
        )

        let (vm, isNew) = ViewModelCache.shared.getOrCreate(for: session.id)
        if isNew {
            // loadSession 会把它记成「屏幕上的会话」;追问是后台动作,还原成真正在看的那个。
            let onScreen = AIChatViewModel.activeSessionId
            await vm.loadSession()
            AIChatViewModel.activeSessionId = onScreen
        }

        // Wait if session is currently processing
        if vm.isProcessing {
            for await processing in vm.$isProcessing.values {
                if !processing { break }
            }
        }

        let sid = vm.sessionId ?? session.id
        // [T-headless-draft] 同一个 VM 可能正开在界面上:只发这次追问和它自己的附件,用户的草稿留着。
        let runId = try vm.withComposerSetAside {
            // Add file attachments if provided
            logger.info("📎 FollowUp files param: \(files == nil ? "nil" : "\(files!.count) files")")
            if let intentFiles = files {
                for (i, file) in intentFiles.enumerated() {
                    let name = SendPromptIntent.resolvedFileName(for: file)
                    let dataSize = file.data.count
                    logger.info("📎 FollowUp file[\(i)]: name=\(name) dataSize=\(dataSize) type=\(file.type?.identifier ?? "nil")")
                    vm.addDataAttachment(data: file.data, fileName: name)
                }
            }
            logger.info("📎 FollowUp vm.attachments after add: \(vm.attachments.count)")
            vm.inputText = prompt
            return try SendPromptIntent.dispatchRun(vm: vm, sessionId: sid, pendingId: pendingId) { vm.send() }
        }
        logger.info("📎 FollowUp send() called, isProcessing=\(vm.isProcessing)")

        // Resolve model name
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

        let promptPreview = String(prompt.prefix(50))
        ShortcutNotification.post(
            id: "shortcut-followup-\(sid)",
            title: String(localized: "LOBE：追问已发送"),
            body: "\(modelName): \(promptPreview)\(prompt.count > 50 ? "…" : "")",
            sessionId: sid
        )

        if waitForResult {
            let settled = await SendPromptIntent.settleRun(
                sessionId: sid, runId: runId, pendingId: pendingId,
                title: String(localized: "LOBE 追问"), notificationId: "shortcut-followup-done")
            let responseText = settled.text

            let result = SendPromptResult(
                sessionId: sid,
                modelName: modelName,
                status: settled.outcome.shortcutStatus,
                isNewSession: false,
                prompt: prompt,
                responseText: responseText,
                artifactFileNames: await SendPromptResult.artifactNames(for: sid),
                runId: runId
            )
            // [C11] 锁屏 + 隐私模式下不朗读正文;仅语音场景照常朗读。
            var voiceOnly = false
            if #available(iOS 27, *) { voiceOnly = systemContext.isVoiceOnly }
            let dialog = SiriReplyPrivacy.dialogText(
                String(responseText.prefix(500)), deviceLocked: !UIApplication.shared.isProtectedDataAvailable,
                privacyMode: SiriReplyPrivacy.privacyModeEnabled, voiceOnly: voiceOnly)
            return .result(value: result, dialog: "\(dialog)")
        }

        // Async mode: return immediately
        Task { @MainActor in
            _ = await SendPromptIntent.settleRun(
                sessionId: sid, runId: runId, pendingId: pendingId,
                title: String(localized: "LOBE 追问"), notificationId: "shortcut-followup-done")
        }

        let result = SendPromptResult(
            sessionId: sid,
            modelName: modelName,
            status: "Running",
            isNewSession: false,
            prompt: prompt,
            runId: runId
        )

        return .result(value: result, dialog: "Follow-up sent to \(session.displayName) with \(modelName).")
    }
}
