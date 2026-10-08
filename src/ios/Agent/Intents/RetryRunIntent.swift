import AppIntents
import Foundation
import UniformTypeIdentifiers

/// Retries (re-runs) from a specific user message in a session.
/// At runtime, shows a picker of user messages from the selected session,
/// then deletes all messages after the chosen one and re-runs the agent.
@available(iOS 17.0, *)
struct RetryRunIntent: AppIntent {
    static var title: LocalizedStringResource = "Retry Run"
    static var description = IntentDescription("Re-runs the AI agent from a specific user message in a session. Presents a list of user messages to choose from, then retries from that point.")
    static var openAppWhenRun = false
    static var authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication
    static var supportedModes: IntentModes = [.background, .foreground(.deferred)]

    @Parameter(title: "Session")
    var session: SessionEntity

    @Parameter(title: "Message")
    var message: UserMessageEntity?

    @Parameter(title: "Attachments", description: "Images, videos, or files to replace existing attachments. Accepts output from previous Shortcuts actions. If empty, keeps original attachments.",
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

        // [T-shortcuts-eager-keepalive] Arm keep-alive BEFORE any await so
        // iOS doesn't suspend the AppIntent-woken process before the normal
        // setActive path (buried behind vm.send() → currentTask → await
        // ensureSession()) has a chance to fire. No-op unless the user has
        // enhancedBackgroundEffective on.
        let eagerResult = BackgroundKeepAliveManager.shared.armEagerlyForShortcut(
            sessionId: session.id, caller: "RetryRunIntent")
        // [T-shortcuts-diag-and-pending] Snapshot state and mark pending; the
        // completion path clears it.
        ShortcutRunTracker.logPerformEntry(
            intent: "RetryRunIntent",
            sessionId: session.id,
            eagerKeepAliveArmed: eagerResult.armed,
            eagerKeepAliveSkippedReason: eagerResult.skipReason
        )
        let pendingId = ShortcutRunTracker.markPending(
            intent: "RetryRunIntent",
            sessionId: session.id,
            eagerKeepAliveArmed: eagerResult.armed,
            eagerKeepAliveSkippedReason: eagerResult.skipReason
        )

        // Headless run: external folder mounts are activated from the root view,
        // which this process may never build. Wait (bounded) so the agent sees
        // /var/minis/mounts on a cold or force-quit launch.
        await MountedFoldersManager.shared.ensureActivated(timeout: 12)
        let (vm, isNew) = ViewModelCache.shared.getOrCreate(for: session.id)
        if isNew {
            await vm.loadSession()
        }

        // Wait if session is currently processing
        if vm.isProcessing {
            for await processing in vm.$isProcessing.values {
                if !processing { break }
            }
        }

        // Find user messages
        let userMessages = vm.messages.filter { $0.role == .user }
        guard !userMessages.isEmpty else {
            // [T-shortcuts-diag-and-pending] Early-return before any agent
            // work — clear the pending marker so the next foreground scan
            // doesn't flag this as orphaned.
            ShortcutRunTracker.markCompleted(recordId: pendingId, reason: "earlyReturn.noUserMessages")
            // [T-ios-session-status-mismatch] The eager setActive above added
            // this session id to the tracker before we knew we'd bail. The VM
            // sink pairs setActive/setInactive on $isProcessing transitions,
            // but we're returning without ever flipping isProcessing → the
            // sink never fires setInactive and the tracker leaks a phantom
            // "running" session (home spinner stuck, chat.session.status
            // false-positive). Drop it here.
            if eagerResult.armed {
                SessionActivityTracker.shared.setInactive(session.id,
                    source: "RetryRunIntent.eager.earlyReturnNoUserMessages")
            }
            return .result(
                value: SendPromptResult(sessionId: session.id, modelName: "N/A", status: "Error", isNewSession: false),
                dialog: "No user messages found in this session."
            )
        }

        // Build entity list from this session's user messages
        let sessionTitle = session.displayName
        let entities = userMessages.enumerated().map { idx, msg -> UserMessageEntity in
            UserMessageEntity(
                id: "\(session.id):\(idx)",
                sessionId: session.id,
                preview: UserMessageEntity.preview(for: msg.content),
                index: idx + 1,
                sessionTitle: sessionTitle
            )
        }

        // Resolve which message to retry from
        let chosenEntity: UserMessageEntity
        if let provided = message {
            chosenEntity = provided
        } else if entities.count == 1 {
            chosenEntity = entities[0]
        } else {
            // Runtime disambiguation — shows the correct session's messages
            chosenEntity = try await $message.requestDisambiguation(
                among: entities,
                dialog: IntentDialog("Which message do you want to retry from?")
            )
        }

        // Map entity index back to ChatMessage. Entity indices come from the
        // database and can drift from this list, and retrying truncates
        // history after the target — so the index must also agree on the
        // text, and a message that can't be found is an error, never "the
        // last one". The entity's label is built by the same helper (with its
        // "…"), or every message longer than 80 characters fails to match.
        func preview(of msg: ChatMessage) -> String {
            UserMessageEntity.preview(for: msg.content)
        }
        let targetIdx = chosenEntity.index - 1
        let indexed = (targetIdx >= 0 && targetIdx < userMessages.count) ? userMessages[targetIdx] : nil
        guard let targetMessage = indexed.flatMap({ preview(of: $0) == chosenEntity.preview ? $0 : nil })
                ?? userMessages.last(where: { preview(of: $0) == chosenEntity.preview }) else {
            abandon(pendingId: pendingId, eagerArmed: eagerResult.armed, reason: "earlyReturn.messageNotFound")
            return .result(
                value: SendPromptResult(sessionId: session.id, modelName: "N/A", status: "Error", isNewSession: false),
                dialog: "That message is no longer in this session. Nothing was retried."
            )
        }

        let promptPreview = String(targetMessage.content.prefix(50))
        let laterCount = vm.messages.count - 1 - (vm.messages.lastIndex(where: { $0.id == targetMessage.id }) ?? vm.messages.count - 1)
        do {
            try await requestConfirmation(
                actionName: .continue,
                dialog: IntentDialog("Retry from “\(promptPreview)”? The \(laterCount) message(s) after it will be removed."))
        } catch {
            abandon(pendingId: pendingId, eagerArmed: eagerResult.armed, reason: "earlyReturn.confirmationDeclined")
            throw error
        }

        // Convert intent files to InputAttachments for replacement (if provided)
        var replacementAttachments: [InputAttachment]? = nil
        if let intentFiles = files, !intentFiles.isEmpty {
            // Stage files via the VM's cache, then detach them for retryFromMessage
            let countBefore = vm.attachments.count
            for file in intentFiles {
                let name = SendPromptIntent.resolvedFileName(for: file)
                vm.addDataAttachment(data: file.data, fileName: name)
            }
            replacementAttachments = Array(vm.attachments.dropFirst(countBefore))
            vm.attachments.removeSubrange(countBefore...)
        }

        // Retry from that message (replacement attachments override the original ones)
        let sid = vm.sessionId ?? session.id
        let runId = try SendPromptIntent.dispatchRun(vm: vm, sessionId: sid, pendingId: pendingId) {
            vm.retryFromMessage(targetMessage.id, replacementAttachments: replacementAttachments)
        }

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

        ShortcutNotification.post(
            id: "shortcut-retry-\(sid)",
            title: String(localized: "LeoBot：正在重试"),
            body: "\(modelName): \(promptPreview)\(targetMessage.content.count > 50 ? "…" : "")",
            sessionId: sid
        )

        if waitForResult {
            let settled = await SendPromptIntent.settleRun(
                sessionId: sid, runId: runId, pendingId: pendingId,
                title: String(localized: "LeoBot 重试"), notificationId: "shortcut-retry-done")
            let responseText = settled.text

            let result = SendPromptResult(
                sessionId: sid,
                modelName: modelName,
                status: settled.outcome.shortcutStatus,
                isNewSession: false,
                prompt: targetMessage.content,
                responseText: responseText,
                artifactFileNames: await SendPromptResult.artifactNames(for: sid),
                runId: runId
            )
            return .result(value: result, dialog: "\(responseText.prefix(500))")
        }

        // Async mode
        Task { @MainActor in
            _ = await SendPromptIntent.settleRun(
                sessionId: sid, runId: runId, pendingId: pendingId,
                title: String(localized: "LeoBot 重试"), notificationId: "shortcut-retry-done")
        }

        let result = SendPromptResult(
            sessionId: sid,
            modelName: modelName,
            status: "Retrying",
            isNewSession: false,
            prompt: targetMessage.content,
            runId: runId
        )

        return .result(value: result, dialog: "Retrying from message: \(promptPreview)\(targetMessage.content.count > 50 ? "…" : "")")
    }

    /// Bail-out before any agent work: clear the pending marker and the
    /// eager "running" registration, or the home spinner sticks.
    @MainActor
    private func abandon(pendingId: String, eagerArmed: Bool, reason: String) {
        ShortcutRunTracker.markCompleted(recordId: pendingId, reason: reason)
        if eagerArmed {
            SessionActivityTracker.shared.setInactive(session.id, source: "RetryRunIntent.eager.\(reason)")
        }
    }

    static var parameterSummary: some ParameterSummary {
        Summary("Retry \(\.$session) from \(\.$message)")
    }
}
