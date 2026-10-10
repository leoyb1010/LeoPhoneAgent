//
//  AIChatViewModel+AskUser.swift
//  MinisApp
//
//  [T-ask-user] The live half of the ask-user card: the paused wait, the
//  notification, the composer routing and the resume after a relaunch. The
//  rules themselves are pure (`AskUserState.swift`).
//
//  Waiting state on disk: the assistant step that called ask_user is saved
//  before tools run ([T-persist-before-tools]); a saved conversation that ends
//  with that step and no result IS a waiting question. In memory, the live
//  turn waits on `AskUserCenter`; after a kill the card is answered through
//  `resumeDormantAskUser`, which writes the result and resumes the same turn.
//
//  Logs carry ids and counts only — never the question or the answer.
//

import Foundation
import SwiftUI
import UIKit
@preconcurrency import UserNotifications

private let askLogger = AppLogger(category: "AskUser")

/// Card progress kept outside the cell (cells are reused while scrolling).
struct AskUserDraft: Equatable {
    var step = 0
    var answers: [AskUserAnswerInput] = []
    var otherOpen = false
    var text = ""
}

@MainActor
final class AskUserCenter: ObservableObject {
    static let shared = AskUserCenter()

    private struct Live {
        var machine: AskUserMachine
        let sessionId: String?
        let argsJSON: String
        let continuation: CheckedContinuation<AskUserOutcome, Never>
        var notified = false
    }

    private var live: [String: Live] = [:]
    /// Dormant questions already answered in this process (resume in flight).
    private(set) var resolvedIds: Set<String> = []
    /// How each question of this process ended — the card shows the answer at
    /// once, before the tool result lands on the block.
    private(set) var outcomes: [String: AskUserOutcome] = [:]
    /// Parsed requests by tool use id (not published: a cache, not state).
    var requests: [String: AskUserRequest] = [:]
    @Published var drafts: [String: AskUserDraft] = [:]
    /// Bumped on every wait start / resolution so cards re-read their state.
    @Published private(set) var revision = 0
    private var backgroundObserver: NSObjectProtocol?

    private init() {
        // A question asked on screen, then the user leaves: tell them where it is.
        backgroundObserver = NotificationCenter.default.addObserver(
            forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main
        ) { _ in
            MainActor.assumeIsolated {
                let center = AskUserCenter.shared
                for id in center.live.keys { center.notifyIfNeeded(id) }
            }
        }
    }

    func isWaiting(_ toolUseId: String) -> Bool { live[toolUseId] != nil }

    func waitingToolUseId(sessionId: String?) -> String? {
        guard let sessionId else { return nil }
        return live.first { $0.value.sessionId == sessionId }?.key
    }

    /// Pause until the user answers (or Stop cancels the turn).
    func wait(toolUseId: String, sessionId: String?, request: AskUserRequest, argsJSON: String,
              onWaiting: @escaping @MainActor () -> Void = {}) async -> AskUserOutcome {
        await withTaskCancellationHandler {
            await withCheckedContinuation { (cont: CheckedContinuation<AskUserOutcome, Never>) in
                if Task.isCancelled {
                    cont.resume(returning: .cancelled(.stopped))
                    return
                }
                live[toolUseId] = Live(machine: AskUserMachine(toolUseId: toolUseId, request: request),
                                       sessionId: sessionId, argsJSON: argsJSON, continuation: cont)
                revision &+= 1
                onWaiting()
                setWaitingPhase(sessionId, waiting: true)
                askLogger.info("[AskUser] WAIT tool=\(toolUseId.suffix(8)) sid=\(sessionId?.prefix(8) ?? "nil") questions=\(request.questions.count)")
                let onScreen = sessionId != nil && AIChatViewModel.activeSessionId == sessionId
                if UIApplication.shared.applicationState != .active || !onScreen {
                    notifyIfNeeded(toolUseId)
                }
            }
        } onCancel: {
            Task { @MainActor in AskUserCenter.shared.submit(toolUseId, .stop) }
        }
    }

    /// Resolve a live question. False when it isn't waiting or the event was
    /// ignored (duplicate / invalid answer).
    @discardableResult
    func submit(_ toolUseId: String, _ event: AskUserMachine.Event) -> Bool {
        guard var entry = live[toolUseId], let outcome = entry.machine.handle(event) else { return false }
        live.removeValue(forKey: toolUseId)
        drafts.removeValue(forKey: toolUseId)
        outcomes[toolUseId] = outcome
        clearNotification(toolUseId)
        setWaitingPhase(entry.sessionId, waiting: false)
        revision &+= 1
        askLogger.info("[AskUser] RESOLVED tool=\(toolUseId.suffix(8)) outcome=\(Self.label(outcome))")
        entry.continuation.resume(returning: outcome)
        return true
    }

    /// First answer of a dormant question wins; later ones are ignored.
    func claimDormant(_ toolUseId: String) -> Bool {
        let inserted = resolvedIds.insert(toolUseId).inserted
        if inserted {
            drafts.removeValue(forKey: toolUseId)
            clearNotification(toolUseId)
            revision &+= 1
        }
        return inserted
    }

    static func label(_ outcome: AskUserOutcome) -> String {
        switch outcome {
        case .answered(let a, let s): return "answered(\(a.count),\(s.rawValue))"
        case .cancelled(let r): return "cancelled(\(r.rawValue))"
        }
    }

    // MARK: Phase (Live Activity / home attention bar / session rows)

    private func setWaitingPhase(_ sessionId: String?, waiting: Bool) {
        guard let sessionId else { return }
        let tracker = SessionActivityTracker.shared
        guard tracker.isActive(sessionId) else { return }
        tracker.updateActivityPhase(sessionId, phase: waiting ? .waitingForUser : .usingTool,
                                    reason: waiting ? .userQuestion : nil)
        BackgroundKeepAliveManager.shared.updateLiveActivityIfNeeded(source: "askUser")
    }

    // MARK: Notification

    private func notifyIfNeeded(_ toolUseId: String) {
        guard var entry = live[toolUseId], !entry.notified else { return }
        entry.notified = true
        live[toolUseId] = entry
        let request = entry.machine.request
        let sessionId = entry.sessionId
        // A Face ID–locked conversation shows nothing and offers no buttons.
        let locked = sessionId.map { SessionLockStore.shared.isHiddenFromSystemSurfaces($0) } ?? false

        let content = UNMutableNotificationContent()
        content.title = String(localized: "有个问题等你回答")
        if locked {
            content.body = String(localized: "打开 LeoBot 查看问题。")
        } else if let first = request.questions.first {
            content.body = request.isMultiStep
                ? String(localized: "共 \(request.questions.count) 个问题：\(first.prompt)")
                : first.prompt
        }
        content.sound = .default
        content.interruptionLevel = .timeSensitive
        var info: [String: Any] = [AskUserNotification.toolUseKey: toolUseId]
        if let sessionId { info["sessionId"] = sessionId }
        if !locked { info[AskUserNotification.argsKey] = entry.argsJSON }
        content.userInfo = info

        let notificationRequest = { () -> UNNotificationRequest in
            UNNotificationRequest(identifier: Self.notificationId(toolUseId), content: content, trigger: nil)
        }
        let center = UNUserNotificationCenter.current()
        let specs = locked ? [] : AskUserNotification.actions(for: request, labels: Self.labels)
        guard !specs.isEmpty else {
            center.add(notificationRequest())
            return
        }
        let categoryId = AskUserNotification.categoryId(toolUseId: toolUseId)
        content.categoryIdentifier = categoryId
        let category = UNNotificationCategory(identifier: categoryId, actions: specs.map(Self.action), intentIdentifiers: [])
        let built = notificationRequest()
        // Register the per-question buttons, then post (set replaces the whole set:
        // keep every other category).
        center.getNotificationCategories { existing in
            center.setNotificationCategories(existing.filter { $0.identifier != categoryId }.union([category]))
            center.add(built)
        }
    }

    private func clearNotification(_ toolUseId: String) {
        let center = UNUserNotificationCenter.current()
        let ids = [Self.notificationId(toolUseId)]
        center.removeDeliveredNotifications(withIdentifiers: ids)
        center.removePendingNotificationRequests(withIdentifiers: ids)
        let categoryId = AskUserNotification.categoryId(toolUseId: toolUseId)
        center.getNotificationCategories { existing in
            guard existing.contains(where: { $0.identifier == categoryId }) else { return }
            center.setNotificationCategories(existing.filter { $0.identifier != categoryId })
        }
    }

    private static func notificationId(_ toolUseId: String) -> String { "ask-user-\(toolUseId)" }

    static var labels: AskUserNotification.Labels {
        AskUserNotification.Labels(yes: String(localized: "是"), no: String(localized: "否"),
                                   other: String(localized: "其他（自己填）"), answer: String(localized: "回答"))
    }

    /// Answering can make the agent act, so every button needs the phone unlocked.
    private static func action(_ spec: AskUserNotification.ActionSpec) -> UNNotificationAction {
        if spec.isTextInput {
            return UNTextInputNotificationAction(identifier: spec.id, title: spec.title, options: [.authenticationRequired],
                                                 textInputButtonTitle: String(localized: "发送"),
                                                 textInputPlaceholder: String(localized: "你的回答…"))
        }
        return UNNotificationAction(identifier: spec.id, title: spec.title, options: [.authenticationRequired])
    }
}

// MARK: - Notification response

/// A button on the ask-user notification answers without opening the app.
enum AskUserNotificationResponder {
    /// Returns true when it handled the response (and owns `completion`).
    static func handle(response: UNNotificationResponse, completion: @escaping () -> Void) -> Bool {
        let info = response.notification.request.content.userInfo
        guard let toolUseId = info[AskUserNotification.toolUseKey] as? String,
              let sessionId = info["sessionId"] as? String,
              let argsJSON = info[AskUserNotification.argsKey] as? String,
              let request = AskUserRequest.parse(json: argsJSON) else { return false }
        let typed = (response as? UNTextInputNotificationResponse)?.userText
        guard let inputs = AskUserNotification.answerInput(actionId: response.actionIdentifier,
                                                           typedText: typed, request: request) else {
            return false   // the body tap: open the chat to the card (sessionId path)
        }
        Task { @MainActor in
            defer { completion() }
            guard !SessionLockStore.shared.isHiddenFromSystemSurfaces(sessionId) else { return }
            if AskUserCenter.shared.submit(toolUseId, .answer(inputs, source: .notification)) { return }
            // The app was killed while the question waited: load the chat and
            // resume the same turn from the saved step.
            BackgroundKeepAliveManager.shared.setup()
            _ = BackgroundKeepAliveManager.shared.armEagerlyForShortcut(sessionId: sessionId, caller: "AskUserNotification")
            let (vm, isNew) = ViewModelCache.shared.getOrCreate(for: sessionId)
            if isNew {
                let onScreen = AIChatViewModel.activeSessionId
                await vm.loadSession()
                AIChatViewModel.activeSessionId = onScreen
            }
            let ok = vm.answerAskUser(toolUseId: toolUseId, inputs: inputs, source: .notification)
            askLogger.info("[AskUser] notification answer tool=\(toolUseId.suffix(8)) resumed=\(ok)")
        }
        return true
    }
}

// MARK: - View model

extension AIChatViewModel {

    /// Only an attended conversation asks (see AskUserTool.isOffered).
    var askUserIsOffered: Bool {
        AskUserTool.isOffered(isSubAgentChild: isSubAgentChild, blocksSideEffectTools: blocksSideEffectTools,
                              sessionSource: sessionSource, isRemoteReadOnly: remoteDeviceId != nil)
    }

    /// Hook in `composeUserSystemPrompt` (stable part).
    var askUserPromptFragment: String {
        askUserIsOffered ? "\n\n" + AskUserTool.promptGuidance : ""
    }

    /// The question of this chat that can still be answered after the live
    /// turn is gone (app killed / run stopped elsewhere): the saved tail is the
    /// step that asked, with no result yet.
    var dormantAskUserToolUseId: String? {
        guard !isProcessing, remoteDeviceId == nil,
              let tail = agentHistory.last, tail.role == .assistant, !tail.isInterrupted else { return nil }
        return AskUserPending.dormantCallId(tailIsAssistant: true, tailCalls: Self.askUserCalls(tail),
                                           resolvedIds: AskUserCenter.shared.resolvedIds)
    }

    static func askUserCalls(_ message: AgentMessage) -> [AskUserPending.Call] {
        message.parts.compactMap {
            if case .toolUse(let id, let name, _) = $0 { return AskUserPending.Call(id: id, name: name) }
            return nil
        }
    }

    /// Runs inside the tool dispatcher: show the card, wait, hand back the answer.
    func executeAskUser(args: [String: Any], toolUseId: String, msgIdx: Int, blockIdx: Int) async -> (output: String, success: Bool) {
        guard askUserIsOffered else {
            return ("Error: nobody is at the screen in this run, so ask_user is unavailable. Make the most reasonable choice yourself and state the assumption in your reply.", false)
        }
        let request: AskUserRequest
        switch AskUserRequest.parse(args) {
        case .success(let parsed): request = parsed
        case .failure(let error): return (error.modelMessage, false)
        }
        let argsJSON = (try? JSONSerialization.data(withJSONObject: args))
            .flatMap { String(data: $0, encoding: .utf8) } ?? "{}"
        if msgIdx < messages.count, blockIdx < messages[msgIdx].blocks.count {
            messages[msgIdx].blocks[blockIdx].content = ""
            if messages[msgIdx].blocks[blockIdx].toolInputArgs == nil {
                messages[msgIdx].blocks[blockIdx].toolInputArgs = argsJSON
            }
        }
        if UIApplication.shared.applicationState == .active { LeoHaptics.notification(.warning) }
        let outcome = await AskUserCenter.shared.wait(toolUseId: toolUseId, sessionId: sessionId,
                                                      request: request, argsJSON: argsJSON) { [weak self] in
            // Registered: the card can now show its buttons — re-measure the cell.
            self?.signalAskUserCard(toolUseId)
            self?.scrollToBottomSignal.send()
        }
        let result = AskUserResult.content(for: outcome)
        if msgIdx < messages.count, blockIdx < messages[msgIdx].blocks.count {
            messages[msgIdx].blocks[blockIdx].content = result.text
        }
        signalAskUserCard(toolUseId)
        return (result.text, !result.isError)
    }

    /// Card / notification answer. Live turn → resolves the wait; dormant
    /// question → writes the result and resumes the same turn.
    @discardableResult
    func answerAskUser(toolUseId: String, inputs: [AskUserAnswerInput], source: AskUserAnswerSource) -> Bool {
        if AskUserCenter.shared.isWaiting(toolUseId) {
            return AskUserCenter.shared.submit(toolUseId, .answer(inputs, source: source))
        }
        return resumeDormantAskUser(toolUseId: toolUseId, event: .answer(inputs, source: source))
    }

    /// A message typed while a question waits answers it; one with attachments
    /// closes the question and is sent as usual. True = the composer text was
    /// consumed as the answer.
    func routeComposerToAskUser(text: String, hasAttachments: Bool) -> Bool {
        let liveId = AskUserCenter.shared.waitingToolUseId(sessionId: sessionId)
        guard let id = liveId ?? dormantAskUserToolUseId else { return false }
        switch AskUserTool.composerRoute(hasWaitingQuestion: true, text: text, hasAttachments: hasAttachments) {
        case .none:
            return false
        case .dismissThenSend:
            if liveId != nil { AskUserCenter.shared.submit(id, .typedMessage(text, hasAttachments: true)) }
            return false
        case .answer:
            if liveId != nil { return AskUserCenter.shared.submit(id, .typedMessage(text, hasAttachments: false)) }
            return resumeDormantAskUser(toolUseId: id, event: .typedMessage(text, hasAttachments: false))
        }
    }

    /// The request a card shows: parsed once per call (cards re-render while
    /// a reply streams), from the block's saved args, else the saved call.
    func askUserRequest(for block: AssistantBlock) -> AskUserRequest? {
        let center = AskUserCenter.shared
        if let id = block.toolUseId, let cached = center.requests[id] { return cached }
        var request = AskUserRequest.parse(json: block.toolInputArgs)
        if request == nil, let id = block.toolUseId {
            search: for message in agentHistory.reversed() where message.role == .assistant {
                for part in message.parts {
                    if case .toolUse(let pid, _, let input) = part, pid == id {
                        if case .success(let parsed) = AskUserRequest.parse(input) { request = parsed }
                        break search
                    }
                }
            }
        }
        if let id = block.toolUseId, let request { center.requests[id] = request }
        return request
    }

    private func resumeDormantAskUser(toolUseId: String, event: AskUserMachine.Event) -> Bool {
        guard dormantAskUserToolUseId == toolUseId, let tail = agentHistory.last,
              let block = askUserBlock(toolUseId), let request = askUserRequest(for: block) else { return false }
        var machine = AskUserMachine(toolUseId: toolUseId, request: request)
        guard let outcome = machine.handle(event), case .answered = outcome,
              AskUserCenter.shared.claimDormant(toolUseId) else { return false }
        let result = AskUserResult.content(for: outcome)
        let calls = Self.askUserCalls(tail)
        let parts = AskUserPending.resumeResults(tailCalls: calls, askId: toolUseId,
                                                 content: result.text, isError: result.isError)
        let message = AgentMessage(role: .user, parts: parts.map {
            .toolResult(id: $0.id, name: $0.name, content: $0.content, isError: $0.isError)
        })
        let statuses = Dictionary(uniqueKeysWithValues: parts.map { ($0.id, $0.id == toolUseId ? "success" : "cancelled") })
        // In history now, so the question stops being dormant before any await.
        agentHistory.append(message)
        let historyIdx = agentHistory.count - 1
        block.content = result.text
        block.toolStatus = .success
        signalAskUserCard(toolUseId)
        askLogger.info("[AskUser] DORMANT answered tool=\(toolUseId.suffix(8)) outcome=\(AskUserCenter.label(outcome)) siblings=\(calls.count - 1)")
        Task { @MainActor [weak self] in
            guard let self else { return }
            if let raw = await self.buildRawMessage(message, toolStatuses: statuses) {
                await ChatStore.shared.appendMessage(raw)
                if historyIdx < self.agentHistory.count { self.agentHistory[historyIdx].dbMessageId = raw.id }
            }
            // Resume the same turn from the saved step.
            if let idx = AgentChatCorrectness.lastAssistantIndex(isAssistant: self.messages.map { $0.role == .assistant }) {
                self.committedBlockCount = self.messages[idx].blocks.count
            }
            self.canResume = true
            self.resume()
        }
        return true
    }

    private func askUserBlock(_ toolUseId: String) -> AssistantBlock? {
        for message in messages.reversed() where message.role == .assistant {
            if let block = message.blocks.last(where: { $0.toolUseId == toolUseId }) { return block }
        }
        return nil
    }

    /// The card changes height when it opens / resolves: re-measure its cell.
    func signalAskUserCard(_ toolUseId: String) {
        for message in messages.reversed() where message.role == .assistant {
            if let block = message.blocks.last(where: { $0.toolUseId == toolUseId }) {
                blockContentFilledSignal.send((messageId: message.id, blockId: block.id))
                return
            }
        }
    }
}

extension AssistantBlock {
    /// [T-ask-user] An ask_user call renders as the question card, not a capsule.
    var isAskUserBlock: Bool {
        if case .shellTool(let command) = kind { return command == AskUserTool.name }
        return false
    }
}
