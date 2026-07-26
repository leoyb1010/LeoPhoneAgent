import AppIntents
import Foundation
import UserNotifications

/// Legacy action retained so shortcuts created before 1.0.12 keep their stored
/// AppEnum parameter and continue running.
struct QuickTaskIntent: AppIntent {
    static var title: LocalizedStringResource = "Quick Task (Compatibility)"
    static var description = IntentDescription("Runs a quick task saved by an earlier LeoPhoneAgent version. New shortcuts should use Quick Task.")
    static var openAppWhenRun = false

    @Parameter(title: "Task")
    var task: QuickTask

    @Parameter(title: "Attachments", description: "Images, videos, or files to attach to the task. Accepts output from previous Shortcuts actions (e.g. filtered photos or documents).",
               supportedTypeIdentifiers: ["public.image", "public.movie", "public.data"],
               inputConnectionBehavior: .connectToPreviousIntentResult)
    var files: [IntentFile]?

    @Parameter(title: "Model", description: "Specify a model or model group to use. Leave empty to use the app default.")
    var model: ModelSelectionEntity?

    @Parameter(title: "Wait for Result", description: "When enabled, waits for the AI to finish and returns the full response for use in subsequent actions.", default: false)
    var waitForResult: Bool

    @MainActor
    func perform() async throws -> some IntentResult & ReturnsValue<SendPromptResult> & ProvidesDialog {
        let definition = QuickTaskStore.shared.definition(for: task.rawValue)
            ?? QuickTaskDefinition.builtIn(id: task.rawValue)
            ?? QuickTaskDefinition(
                id: task.rawValue,
                name: "Quick Task",
                prompt: task.prompt,
                symbolName: "bolt.fill",
                isBuiltIn: true,
                sortOrder: 0
            )
        return try await Self.execute(
            definition: definition,
            files: files,
            model: model,
            waitForResult: waitForResult,
            inputValues: [:]
        )
    }

    @MainActor
    static func execute(
        definition: QuickTaskDefinition,
        files: [IntentFile]?,
        model: ModelSelectionEntity?,
        waitForResult: Bool,
        inputValues: [String: String]
    ) async throws -> some IntentResult & ReturnsValue<SendPromptResult> & ProvidesDialog {
        BackgroundKeepAliveManager.shared.setup()

        // [T-shortcuts-eager-keepalive] Arm keep-alive BEFORE the ensureSession
        // await. QuickTask always starts a new session, so we don't have the
        // real id yet — register a placeholder, then swap to the real id once
        // ensureSessionReturningId returns. No-op unless the user has
        // enhancedBackgroundEffective on.
        let placeholderSid = "intent-eager:\(UUID().uuidString)"
        let eagerResult = BackgroundKeepAliveManager.shared.armEagerlyForShortcut(
            sessionId: placeholderSid, caller: "QuickTaskIntent")
        // [T-ios-session-status-mismatch] Guarantee the placeholder is dropped
        // from SessionActivityTracker no matter how this perform() exits (throw,
        // early return, ensureSessionReturningId failure). Without this, a
        // failed intent leaves "intent-eager:<UUID>" in activeSessions forever
        // → home spinner permanently on, ground-truth `chat.session.status`
        // reports phantom running sessions, Live Activity count inflates.
        // The successful swap path calls setInactive(placeholder) explicitly
        // BEFORE this defer runs; setInactive on an already-removed id is a
        // no-op, so this is idempotent.
        defer {
            if eagerResult.armed {
                SessionActivityTracker.shared.setInactive(placeholderSid,
                    source: "QuickTaskIntent.eager.cleanupDefer")
            }
        }
        // [T-shortcuts-diag-and-pending] Snapshot + mark pending under the
        // placeholder id (final id is created moments later; the marker is
        // cleared by the completion path either way).
        ShortcutRunTracker.logPerformEntry(
            intent: "QuickTaskIntent",
            sessionId: placeholderSid,
            eagerKeepAliveArmed: eagerResult.armed,
            eagerKeepAliveSkippedReason: eagerResult.skipReason
        )
        let pendingId = ShortcutRunTracker.markPending(
            intent: "QuickTaskIntent",
            sessionId: placeholderSid,
            eagerKeepAliveArmed: eagerResult.armed,
            eagerKeepAliveSkippedReason: eagerResult.skipReason
        )

        let vm = ViewModelCache.shared.createDraft()
        vm.sessionSource = "shortcut"
        await vm.ensureSessionReturningId()
        // [T-shortcuts-eager-keepalive] Real id now known — re-arm with it and
        // drop the placeholder.
        if let realSid = vm.sessionId {
            BackgroundKeepAliveManager.shared.armEagerlyForShortcut(
                sessionId: realSid, caller: "QuickTaskIntent.swap")
            SessionActivityTracker.shared.setInactive(placeholderSid,
                source: "QuickTaskIntent.eager.placeholderSwap")
        }

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
                let name = SendPromptIntent.resolvedFileName(for: file)
                vm.addDataAttachment(data: file.data, fileName: name)
            }
        }

        let renderedPrompt = definition.renderedPrompt(inputValues: inputValues)
        vm.inputText = renderedPrompt
        vm.send()

        let sid = vm.sessionId ?? "unknown"

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

        // Notification: started
        let taskName = definition.name
        ShortcutNotification.post(
            id: "shortcut-start-\(sid)",
            title: "LeoPhoneAgent: \(taskName)",
            body: "\(modelName) is working on it…",
            sessionId: sid
        )

        if waitForResult {
            // Synchronous mode: wait for the agent to finish
            for await processing in vm.$isProcessing.values {
                if !processing { break }
            }

            // [T-shortcuts-diag-and-pending] Loop finished.
            ShortcutRunTracker.markCompleted(recordId: pendingId, reason: "waitForResult.done")

            let responseText = SendPromptIntent.extractResponseText(from: vm)

            ShortcutNotification.post(
                id: "shortcut-done-\(sid)",
                title: "LeoPhoneAgent: \(taskName) Done",
                body: "\(modelName): \(String(responseText.prefix(200)))",
                sessionId: sid
            )

            let result = SendPromptResult(
                sessionId: sid,
                modelName: modelName,
                status: "Completed",
                isNewSession: true,
                prompt: renderedPrompt,
                responseText: responseText,
                outputMode: definition.outputMode.rawValue,
                artifactFileNames: await SendPromptResult.artifactNames(for: sid)
            )
            return .result(value: result, dialog: "\(responseText.prefix(500))")
        }

        // Async mode: return immediately
        let capturedModelName = modelName
        let capturedSid = sid
        let capturedTaskName = taskName
        let capturedPendingId = pendingId
        Task { @MainActor in
            for await processing in vm.$isProcessing.values {
                if !processing { break }
            }

            // [T-shortcuts-diag-and-pending] Loop finished.
            ShortcutRunTracker.markCompleted(recordId: capturedPendingId, reason: "async.done")

            let summary = String(SendPromptIntent.extractResponseText(from: vm).prefix(200))

            ShortcutNotification.post(
                id: "shortcut-done-\(capturedSid)",
                title: "LeoPhoneAgent: \(capturedTaskName) Done",
                body: "\(capturedModelName): \(summary)",
                sessionId: capturedSid
            )
        }

        let result = SendPromptResult(
            sessionId: sid,
            modelName: modelName,
            status: "Running",
            isNewSession: true,
            prompt: renderedPrompt,
            outputMode: definition.outputMode.rawValue
        )

        return .result(value: result, dialog: "\(taskName) started with \(modelName).")
    }

}

/// Primary quick-task action from 1.0.12 onward. AppEntity identifiers remain
/// stable while the task names and prompts can be edited in the app.
struct RunQuickTaskIntent: AppIntent {
    static var title: LocalizedStringResource = "Quick Task"
    static var description = IntentDescription("Runs a LeoPhoneAgent quick task from your editable task library.")
    static var openAppWhenRun = false

    @Parameter(title: "Task")
    var task: QuickTaskEntity

    @Parameter(title: "Attachments", description: "Images, videos, or files to attach to the task. Accepts output from previous Shortcuts actions.",
               supportedTypeIdentifiers: ["public.image", "public.movie", "public.data"],
               inputConnectionBehavior: .connectToPreviousIntentResult)
    var files: [IntentFile]?

    @Parameter(title: "Model", description: "Specify a model or model group to use. Leave empty to use the app default.")
    var model: ModelSelectionEntity?

    @Parameter(title: "Wait for Result", description: "When enabled, waits for the AI to finish and returns the full response for use in subsequent actions.", default: false)
    var waitForResult: Bool

    @Parameter(title: "Template Inputs", description: "Optional values for {{slots}}, one name=value pair per line.")
    var templateInputs: String?

    @MainActor
    func perform() async throws -> some IntentResult & ReturnsValue<SendPromptResult> & ProvidesDialog {
        let definition = QuickTaskStore.shared.definition(for: task.id)
            ?? QuickTaskDefinition(
                id: task.id,
                name: task.name,
                prompt: task.prompt,
                symbolName: task.symbolName,
                isBuiltIn: false,
                sortOrder: 0
            )
        return try await QuickTaskIntent.execute(
            definition: definition,
            files: files,
            model: model,
            waitForResult: waitForResult,
            inputValues: Self.parseTemplateInputs(templateInputs)
        )
    }

    private static func parseTemplateInputs(_ text: String?) -> [String: String] {
        guard let text else { return [:] }
        return text.split(whereSeparator: \.isNewline).reduce(into: [:]) { result, line in
            let parts = line.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
            guard parts.count == 2 else { return }
            let key = parts[0].trimmingCharacters(in: .whitespacesAndNewlines)
            let value = parts[1].trimmingCharacters(in: .whitespacesAndNewlines)
            if !key.isEmpty { result[key] = value }
        }
    }
}
