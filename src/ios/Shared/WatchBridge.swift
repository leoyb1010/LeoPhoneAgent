//
//  WatchBridge.swift
//  MinisApp
//
//  [T-watch-companion] iPhone side of the Apple Watch companion.
//
//  The watch is a voice device: you speak, it shows (and can read out) the
//  answer. Everything else — task lists, schedules, session browsing — lives
//  on the phone. Two ways an answer comes back:
//    • iPhone in reach: the wrist records, the phone transcribes and runs the
//      full agent, the final text returns over WatchConnectivity.
//    • iPhone out of reach (cellular watch): the watch dictates and calls the
//      user's model directly with a config this file hands it ahead of time
//      (see `WatchStandalone`).
//
//  App Group UserDefaults do NOT cross from iPhone to Watch — an App Group is
//  shared between processes on ONE device — so everything here goes over
//  WatchConnectivity. Inert when no watch is paired, so shipping it costs nothing.
//

import CryptoKit
import Foundation
#if canImport(WatchConnectivity)
import WatchConnectivity
#endif
import Speech

private let logger = AppLogger(category: "WatchBridge")

/// Keys shared with the watch target. Kept as plain strings so the watch app
/// can depend on this contract without importing app code.
enum WatchPayloadKey {
    static let kind = "kind"
    static let state = "state"
    static let title = "title"
    static let status = "status"
    static let activeCount = "activeCount"
    static let updatedAt = "updatedAt"
    static let requestId = "requestId"
    static let text = "text"
    static let sessionId = "sessionId"

    static let kindStatus = "status"
    static let kindAsk = "ask"                // watch → phone: run a prompt
    static let kindAskAudio = "askAudio"      // watch → phone: raw audio to transcribe
    static let kindAskReply = "askReply"      // phone → watch: final answer
    static let kindCancelAsk = "cancelAsk"    // watch → phone: stop the run behind a request
    static let kindWake = "wake"              // watch → phone: recording started, get ready
    // [T-leogateway] Remote-gateway approvals. The wrist is the fastest place
    // to unblock a Mac that is waiting on a yes/no.
    static let kindApprovalRequest = "approvalRequest"   // phone → watch
    static let kindApprovalReply = "approvalReply"       // watch → phone
    static let choices = "choices"
    static let choice = "choice"
    /// CommandRisk raw value; the wrist colors the card and asks for a crown
    /// turn before allowing a high-risk command.
    static let risk = "risk"
    // [T-watch-standalone] phone → watch (transferUserInfo): the model the
    // watch calls directly when the phone is out of reach.
    static let kindStandaloneConfig = "standaloneConfig"
}

// MARK: - Standalone answers

/// [T-watch-standalone] Which model a cellular watch calls on its own.
///
/// Only API-key providers that speak OpenAI Chat Completions or Anthropic
/// Messages qualify: OAuth tokens need refreshing on the phone, and the watch
/// has to stay a small, dependable client. The first usable member of the
/// default model group wins, so the wrist answers with the same model the
/// phone would pick.
enum WatchStandalone {
    static let enabledKey = "watch.standalone.enabled"

    /// On unless the user turns it off: answering from a cellular watch is
    /// the point of the feature. Turning it off deletes the key on the watch.
    static var isEnabled: Bool {
        get { UserDefaults.standard.object(forKey: enabledKey) as? Bool ?? true }
        set { UserDefaults.standard.set(newValue, forKey: enabledKey) }
    }

    struct Config: Equatable {
        let format: String          // "openai" | "anthropic"
        let endpoint: String
        let model: String
        let modelName: String
        let providerName: String
        let userAgent: String?
        let apiKey: String
    }

    enum Unavailable: Error, Equatable {
        case disabled
        case noDefaultModel
        case noSupportedModel

        var explanation: String {
            switch self {
            case .disabled: return String(localized: "已关闭。手表离开 iPhone 时不会自己回答。")
            case .noDefaultModel: return String(localized: "还没有默认模型分组。")
            case .noSupportedModel:
                return String(localized: "默认分组里没有 API Key 方式、OpenAI 兼容或 Anthropic 接口的模型。订阅登录（OAuth）的模型只能经 iPhone 使用。")
            }
        }
    }

    @MainActor
    static func resolve(store: ProviderConfigStore? = nil) -> Result<Config, Unavailable> {
        // A `.shared` default argument is evaluated outside the main actor (Swift 6 warning).
        let store = store ?? .shared
        guard isEnabled else { return .failure(.disabled) }
        guard let groupId = store.defaultPrimaryGroupId, let group = store.group(for: groupId) else {
            return .failure(.noDefaultModel)
        }
        for entryId in group.memberEntryIds {
            guard let entry = store.entry(for: entryId), !entry.isHidden,
                  let instance = store.instance(for: entry.providerInstanceId),
                  instance.isEnabled, instance.credentialType == .apiKey, !instance.azureMode,
                  let key = ProviderKeychainHelper.loadAPIKey(instanceId: instance.id), !key.isEmpty
            else { continue }
            let format: String
            let defaultBase: String
            let path: String
            switch instance.providerType {
            case .openAI:
                (format, defaultBase, path) = ("openai", "https://api.openai.com", "/chat/completions")
            case .openRouter:
                (format, defaultBase, path) = ("openai", "https://openrouter.ai/api", "/chat/completions")
            case .anthropic:
                (format, defaultBase, path) = ("anthropic", "https://api.anthropic.com", "/messages")
            default:
                continue
            }
            let (base, appendV1) = instance.resolvedBaseURL(default: defaultBase)
            let endpoint = URLBuilding.join(base, appendV1 ? "/v1" : "", path)
            return .success(Config(
                format: format,
                endpoint: endpoint,
                model: entry.baseModel.id,
                modelName: entry.model.displayName,
                providerName: instance.label,
                userAgent: instance.customUserAgent?.trimmingCharacters(in: .whitespacesAndNewlines),
                apiKey: key
            ))
        }
        return .failure(.noSupportedModel)
    }
}

#if canImport(WatchConnectivity)

@MainActor
final class WatchBridge: NSObject, ObservableObject {
    static let shared = WatchBridge()

    private var session: WCSession? {
        WCSession.isSupported() ? WCSession.default : nil
    }

    private var lastPushedSignature: String = ""
    /// Cheap fingerprint of what the standalone config depends on; the keychain
    /// is only read when it changes.
    private var lastStandaloneInputs: String = ""
    private var lastStandaloneSignature: String = ""

    func resetDedupe() { lastPushedSignature = "" }

    /// Last ask answer, folded into the application context as a fallback for
    /// when the live message can't be delivered (watch briefly unreachable).
    private var pendingAskReply: (id: String, text: String, sessionId: String)?

    /// Handlers keyed by approval id.
    ///
    /// A single slot broke as soon as two consoles were open: the second
    /// driver overwrote the first's closure, and a wrist answer for the first
    /// run then hit a handler that rejected it and returned silently, leaving
    /// that Mac blocked forever with no feedback anywhere.
    private var approvalHandlers: [String: (String) -> Void] = [:]

    func registerApprovalHandler(approvalId: String, handler: @escaping (String) -> Void) {
        approvalHandlers[approvalId] = handler
    }

    func unregisterApprovalHandler(approvalId: String) {
        approvalHandlers.removeValue(forKey: approvalId)
    }

    /// Dispatch a wrist answer to the driver that owns that exact approval.
    func resolveApproval(approvalId: String, choice: String) {
        guard let handler = approvalHandlers[approvalId] else { return }
        approvalHandlers.removeValue(forKey: approvalId)
        handler(choice)
    }

    /// Push a pending remote approval to the wrist.
    ///
    /// sendMessage only (no applicationContext fallback): an approval is
    /// worthless once stale, and the phone-side card remains the source of
    /// truth if the watch is unreachable.
    func sendApprovalRequest(approvalId: String, command: String?, reason: String?, choices: [String]) {
        guard let session, session.isReachable else { return }
        session.sendMessage([
            WatchPayloadKey.kind: WatchPayloadKey.kindApprovalRequest,
            WatchPayloadKey.requestId: approvalId,
            WatchPayloadKey.text: WatchTextSanitizer.plain(command ?? reason ?? ""),
            WatchPayloadKey.choices: choices,
            WatchPayloadKey.risk: (command.map(CommandRisk.assess) ?? .medium).rawValue,
        ], replyHandler: nil, errorHandler: { _ in })
    }

    /// Tell the wrist the card is gone (answered on the phone, or timed out).
    func clearApprovalRequest(approvalId: String) {
        unregisterApprovalHandler(approvalId: approvalId)
        guard let session, session.isReachable else { return }
        session.sendMessage([
            WatchPayloadKey.kind: WatchPayloadKey.kindApprovalRequest,
            WatchPayloadKey.requestId: approvalId,
            WatchPayloadKey.text: "",
            WatchPayloadKey.choices: [String](),
        ], replyHandler: nil, errorHandler: { _ in })
    }

    /// - Parameter sessionId: the phone session that produced the answer, so a
    ///   follow-up from the wrist continues it.
    func sendAskReply(requestId: String, text: String, sessionId: String = "") {
        // [T-automation-watch-isolation] Automation runs reuse this delivery
        // path but their answers belong to notifications, not the wrist.
        guard !requestId.hasPrefix("automation-") else { return }
        pendingAskReply = (requestId, text, sessionId)
        if let session, session.isReachable {
            session.sendMessage([
                WatchPayloadKey.kind: WatchPayloadKey.kindAskReply,
                WatchPayloadKey.requestId: requestId,
                WatchPayloadKey.text: text,
                WatchPayloadKey.sessionId: sessionId,
            ], replyHandler: nil, errorHandler: { _ in })
        }
        resetDedupe()
        pushStatus()
    }

    func activate() {
        guard let session else {
            logger.info("WatchConnectivity unsupported on this device")
            return
        }
        session.delegate = self
        session.activate()
        logger.info("WCSession activating")
    }

    /// Publishes the current agent status to the watch. Cheap and idempotent:
    /// identical payloads are dropped, because `updateApplicationContext`
    /// is rate-limited by the system and a redundant push wastes that budget.
    func pushStatus() {
        guard let session, session.activationState == .activated else { return }
        #if os(iOS)
        guard session.isPaired, session.isWatchAppInstalled else { return }
        #endif
        syncStandaloneConfigIfNeeded()

        let snapshot = AgentWidgetSnapshotStore.load()
        let context: [String: Any] = [
            WatchPayloadKey.kind: WatchPayloadKey.kindStatus,
            WatchPayloadKey.state: snapshot.state.rawValue,
            WatchPayloadKey.title: snapshot.title,
            WatchPayloadKey.status: snapshot.status,
            WatchPayloadKey.activeCount: snapshot.activeCount,
            "askReplyId": pendingAskReply?.id ?? "",
            "askReplyText": pendingAskReply?.text ?? "",
            "askReplySessionId": pendingAskReply?.sessionId ?? "",
            WatchPayloadKey.updatedAt: snapshot.updatedAt.timeIntervalSince1970,
        ]
        // The reply id is part of the signature: the fallback delivery of an
        // answer must go out even when the agent state itself didn't change.
        let signature = "\(snapshot.state.rawValue)|\(snapshot.activeCount)|\(snapshot.title)|\(snapshot.status)|\(pendingAskReply?.id ?? "")"
        guard signature != lastPushedSignature else { return }
        lastPushedSignature = signature

        do {
            try session.updateApplicationContext(context)
            logger.info("pushed status to watch state=\(snapshot.state.rawValue) active=\(snapshot.activeCount)")
        } catch {
            logger.error("watch context push failed: \(error.localizedDescription)")
        }
    }

    /// [T-watch-standalone] Hands the watch the model it calls when the phone
    /// is out of reach, or tells it to forget the key. `transferUserInfo` is
    /// queued and delivered even if the watch app isn't running; the payload
    /// travels over the system's encrypted watch channel and the watch moves
    /// the key into its own Keychain on arrival.
    func syncStandaloneConfigIfNeeded(force: Bool = false) {
        guard let session, session.activationState == .activated else { return }
        #if os(iOS)
        guard session.isPaired, session.isWatchAppInstalled else { return }
        #endif
        let store = ProviderConfigStore.shared
        let inputs = "\(WatchStandalone.isEnabled)|\(store.configRevision)|\(store.authRevision)|\(store.defaultPrimaryGroupId ?? "")"
        guard force || inputs != lastStandaloneInputs else { return }
        lastStandaloneInputs = inputs

        var payload: [String: Any] = [WatchPayloadKey.kind: WatchPayloadKey.kindStandaloneConfig]
        let signature: String
        switch WatchStandalone.resolve(store: store) {
        case .success(let config):
            let keyDigest = SHA256.hash(data: Data(config.apiKey.utf8)).map { String(format: "%02x", $0) }.joined()
            signature = [config.format, config.endpoint, config.model, config.modelName, config.userAgent ?? "", keyDigest].joined(separator: "|")
            payload["format"] = config.format
            payload["endpoint"] = config.endpoint
            payload["model"] = config.model
            payload["modelName"] = config.modelName
            payload["providerName"] = config.providerName
            payload["userAgent"] = config.userAgent ?? ""
            payload["apiKey"] = config.apiKey
        case .failure(let reason):
            signature = "none|\(reason)"
            payload["clear"] = true
            payload["reason"] = reason.explanation
        }
        guard force || signature != lastStandaloneSignature else { return }
        lastStandaloneSignature = signature
        // Only the newest config matters; drop any still queued.
        for transfer in session.outstandingUserInfoTransfers
        where (transfer.userInfo[WatchPayloadKey.kind] as? String) == WatchPayloadKey.kindStandaloneConfig {
            transfer.cancel()
        }
        session.transferUserInfo(payload)
        logger.info("standalone config sent to watch (clear=\(payload["clear"] != nil))")
    }
}

extension WatchBridge: WCSessionDelegate {
    nonisolated func session(
        _ session: WCSession,
        activationDidCompleteWith activationState: WCSessionActivationState,
        error: Error?
    ) {
        if let error {
            logger.error("WCSession activation failed: \(error.localizedDescription)")
            return
        }
        logger.info("WCSession activated state=\(activationState.rawValue)")
        Task { @MainActor in
            // [T-watch-signature-reset] A just-paired watch has an EMPTY
            // application context; if the signature happened to match the last
            // push to the previous watch, the dedupe skipped the send and the
            // new watch stayed blank until the agent state next changed.
            WatchBridge.shared.resetDedupe()
            WatchBridge.shared.syncStandaloneConfigIfNeeded(force: true)
            WatchBridge.shared.pushStatus()
        }
    }

    #if os(iOS)
    nonisolated func sessionDidBecomeInactive(_ session: WCSession) {}

    nonisolated func sessionDidDeactivate(_ session: WCSession) {
        // Re-activate so a switched watch keeps working.
        Task { @MainActor in WatchBridge.shared.resetDedupe() }
        session.activate()
    }
    #endif

    /// [T-watch-native-voice] Audio envelope from the wrist: JSON header line
    /// + 0x0A + AAC. Transcribed with the SAME system speech stack the app's
    /// voice mode uses, then handed to the ordinary ask runner.
    nonisolated func session(_ session: WCSession, didReceiveMessageData messageData: Data) {
        guard let newline = messageData.firstIndex(of: 0x0A),
              let header = try? JSONSerialization.jsonObject(with: messageData[..<newline]) as? [String: Any],
              (header["kind"] as? String) == WatchPayloadKey.kindAskAudio else { return }
        let requestId = (header[WatchPayloadKey.requestId] as? String) ?? UUID().uuidString
        let sessionId = header[WatchPayloadKey.sessionId] as? String
        let audio = Data(messageData[messageData.index(after: newline)...])
        Task { @MainActor in
            let url = FileManager.default.temporaryDirectory
                .appendingPathComponent("watch-ask-\(requestId).m4a")
            do {
                try audio.write(to: url)
                let text = try await WatchBridge.transcribe(url: url)
                try? FileManager.default.removeItem(at: url)
                guard !text.isEmpty else {
                    WatchBridge.shared.sendAskReply(requestId: requestId, text: "没有听清，请再说一次。")
                    return
                }
                await WatchAskRunner.run(requestId: requestId, prompt: text, sessionId: sessionId)
            } catch {
                try? FileManager.default.removeItem(at: url)
                WatchBridge.shared.sendAskReply(requestId: requestId, text: "语音识别失败：\(error.localizedDescription)")
            }
        }
    }

    /// Messages sent without a reply handler land here, not in the variant
    /// below — cancelAsk and wake are sent that way, and used to be dropped.
    nonisolated func session(_ session: WCSession, didReceiveMessage message: [String: Any]) {
        self.session(session, didReceiveMessage: message, replyHandler: { _ in })
    }

    /// Queued delivery from the wrist: an approval answered while the phone
    /// was out of reach. Each approval resolves once, so a reply that also
    /// arrived live is ignored here.
    nonisolated func session(_ session: WCSession, didReceiveUserInfo userInfo: [String: Any] = [:]) {
        guard (userInfo[WatchPayloadKey.kind] as? String) == WatchPayloadKey.kindApprovalReply else { return }
        self.session(session, didReceiveMessage: userInfo, replyHandler: { _ in })
    }

    nonisolated func session(
        _ session: WCSession,
        didReceiveMessage message: [String: Any],
        replyHandler: @escaping ([String: Any]) -> Void
    ) {
        let kind = message[WatchPayloadKey.kind] as? String
        let requestId = (message[WatchPayloadKey.requestId] as? String) ?? ""
        switch kind {
        case WatchPayloadKey.kindAsk:
            let text = (message[WatchPayloadKey.text] as? String) ?? ""
            let sessionId = message[WatchPayloadKey.sessionId] as? String
            replyHandler(["ok": !text.isEmpty])
            guard !text.isEmpty else { return }
            let id = requestId.isEmpty ? UUID().uuidString : requestId
            Task { @MainActor in
                await WatchAskRunner.run(requestId: id, prompt: text, sessionId: sessionId)
            }
        case WatchPayloadKey.kindCancelAsk:
            Task { @MainActor in
                let stopped = WatchAskRunner.cancel(requestId: requestId)
                replyHandler(["ok": stopped])
            }
        case WatchPayloadKey.kindWake:
            // Receiving it is the point: iOS has already woken the app.
            replyHandler(["ok": true])
        case WatchPayloadKey.kindApprovalReply:
            let choice = (message[WatchPayloadKey.choice] as? String) ?? ""
            replyHandler(["ok": !requestId.isEmpty && !choice.isEmpty])
            guard !requestId.isEmpty, !choice.isEmpty else { return }
            Task { @MainActor in
                WatchBridge.shared.resolveApproval(approvalId: requestId, choice: choice)
            }
        default:
            replyHandler(["ok": false])
        }
    }
}

#else

/// Stub so call sites don't need availability checks on platforms without
/// WatchConnectivity.
@MainActor
final class WatchBridge {
    static let shared = WatchBridge()
    func activate() {}
    func pushStatus() {}
    func syncStandaloneConfigIfNeeded(force: Bool = false) {}
}

#endif

// MARK: - Watch audio transcription

extension WatchBridge {
    /// File-based recognition through the same system engine the app's voice
    /// features use. Speech permission is the app's existing one.
    static func transcribe(url: URL) async throws -> String {
        let status = await withCheckedContinuation { continuation in
            SFSpeechRecognizer.requestAuthorization { continuation.resume(returning: $0) }
        }
        guard status == .authorized else {
            throw NSError(domain: "WatchAsk", code: 1, userInfo: [
                NSLocalizedDescriptionKey: "语音识别未授权，请在 iPhone 上授权后重试。"])
        }
        guard let recognizer = SFSpeechRecognizer(), recognizer.isAvailable else {
            throw NSError(domain: "WatchAsk", code: 2, userInfo: [
                NSLocalizedDescriptionKey: "语音识别当前不可用。"])
        }
        let request = SFSpeechURLRecognitionRequest(url: url)
        request.shouldReportPartialResults = false
        return try await withCheckedThrowingContinuation { continuation in
            var finished = false
            recognizer.recognitionTask(with: request) { result, error in
                guard !finished else { return }
                if let error {
                    finished = true
                    continuation.resume(throwing: error)
                } else if let result, result.isFinal {
                    finished = true
                    continuation.resume(returning: result.bestTranscription.formattedString)
                }
            }
        }
    }
}

// MARK: - Watch text sanitizer

/// [T-watch-plaintext] The wrist gets PLAIN text. Agent replies are Markdown;
/// a 45mm screen showing raw `##`/`**`/`[](…)` reads as garbage. One flatten
/// pass on the phone serves every watch surface (ask replies, transcripts,
/// briefing) so the watch app stays a dumb renderer.
enum WatchTextSanitizer {
    static func plain(_ input: String) -> String {
        var text = input
        // Fenced code: drop the fence lines, keep the content.
        text = text.replacingOccurrences(of: "```[a-zA-Z0-9]*\\n?", with: "", options: .regularExpression)
        // Images/links → their label.
        text = text.replacingOccurrences(of: "!?\\[([^\\]]*)\\]\\([^)]*\\)", with: "$1", options: .regularExpression)
        // Bold / italic / inline code markers.
        for marker in ["**", "__", "`"] {
            text = text.replacingOccurrences(of: marker, with: "")
        }
        var lines: [String] = []
        for rawLine in text.split(separator: "\n", omittingEmptySubsequences: false) {
            var line = String(rawLine)
            // Headings and blockquotes.
            line = line.replacingOccurrences(of: "^\\s*#{1,6}\\s*", with: "", options: .regularExpression)
            line = line.replacingOccurrences(of: "^\\s*>\\s?", with: "", options: .regularExpression)
            // Horizontal rules / table separator rows vanish.
            if line.range(of: "^\\s*[-=*_]{3,}\\s*$", options: .regularExpression) != nil { continue }
            if line.range(of: "^\\s*\\|?[\\s:|-]+\\|?\\s*$", options: .regularExpression) != nil, line.contains("-") { continue }
            // Bullets → middle dot; keep numbered lists as-is.
            line = line.replacingOccurrences(of: "^(\\s*)[-*+]\\s+", with: "$1· ", options: .regularExpression)
            // Table pipes → two spaces.
            if line.contains("|") {
                line = line.replacingOccurrences(of: "|", with: "  ")
                    .trimmingCharacters(in: .whitespaces)
            }
            lines.append(line)
        }
        var out = lines.joined(separator: "\n")
        // Deterministic collapse — regex replacement templates treat \n as a
        // literal 'n', which would have glued lines together.
        while out.contains("\n\n\n") {
            out = out.replacingOccurrences(of: "\n\n\n", with: "\n\n")
        }
        return out.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

/// [T-watch-ask] Runs a wrist-dictated prompt through the ordinary agent
/// loop (new session, or follow-up into an existing one) and delivers the
/// final assistant text back to the watch.
@MainActor
enum WatchAskRunner {
    /// Request id → session id of runs started from the wrist, so the watch
    /// can cancel the one it is waiting on.
    private static var running: [String: String] = [:]

    static func run(requestId: String, prompt: String, sessionId: String?) async {
        let previousActive = AIChatViewModel.activeSessionId
        let vm: AIChatViewModel
        if let sessionId, !sessionId.isEmpty {
            vm = ViewModelCache.shared.getOrCreate(for: sessionId).0
        } else {
            vm = ViewModelCache.shared.createDraft()
        }
        vm.sessionSource = "watch"
        await vm.ensureSessionReturningId()
        AIChatViewModel.activeSessionId = previousActive
        guard let sid = vm.sessionId else {
            deliver(requestId: requestId, text: "无法创建会话。")
            return
        }
        running[requestId] = sid
        defer { running.removeValue(forKey: requestId) }
        // The answer is read on a 45 mm screen and often spoken: ask for it in
        // that shape. Hidden from the chat bubble like every system reminder.
        vm.inputText = prompt + wristReminder
        vm.send()
        // Wait for the run to settle (same observation pattern as the widget
        // runner): give it up to 3 minutes, then report whatever exists.
        // Startup grace: the send registers as active a beat later — breaking
        // on the FIRST idle tick returned the PREVIOUS turn's text.
        var sawActive = false
        for tick in 0..<360 {
            try? await Task.sleep(nanoseconds: 500_000_000)
            let active = SessionActivityTracker.shared.activeSessions.contains(sid)
                || SessionActivityTracker.shared.isActive(sid)
            if active { sawActive = true; continue }
            if sawActive || tick >= 30 { break }   // ended, or never started within 15s
        }
        let reply = await lastAssistantText(sessionId: sid, limit: 2000)
        deliver(requestId: requestId,
                text: reply.isEmpty ? "任务已执行，但没有产生文本回复。可在 iPhone 上查看会话。" : reply,
                sessionId: sid)
        WatchBridge.shared.resetDedupe()
        WatchBridge.shared.pushStatus()
    }

    private static let wristReminder = "\n\n<system-reminder>This message was spoken on the user's Apple Watch. Do the task as usual, but write the final reply for a watch face that may read it aloud: plain Chinese text, no Markdown, tables or code blocks, lead with the answer, at most about 120 characters unless the user asked for detail.</system-reminder>"

    /// Stops the run behind a wrist request. False when it already finished.
    static func cancel(requestId: String) -> Bool {
        guard let sid = running[requestId], let vm = ViewModelCache.shared.get(for: sid) else { return false }
        vm.cancel(queuePolicy: .discardQueuedPrompts)
        return true
    }

    private static func lastAssistantText(sessionId: String, limit: Int) async -> String {
        let messages = await ChatStore.shared.loadMessages(sessionId: sessionId)
        guard let last = messages.last(where: { $0.role == .assistant }) else { return "" }
        let text = last.parts.compactMap { part -> String? in
            if case .text(let value) = part { return value }
            return nil
        }.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
        return String(text.prefix(limit))
    }

    private static func deliver(requestId: String, text: String, sessionId: String = "") {
        WatchBridge.shared.sendAskReply(requestId: requestId, text: WatchTextSanitizer.plain(text), sessionId: sessionId)
    }
}
