//
//  WatchConnectivityClient.swift
//  LeoWatch
//
//  Watch side of the bridge. Mirrors the key contract in the phone's
//  WatchBridge.swift — kept as plain strings so neither target has to import
//  the other's code.
//
//  Every question goes one of two ways:
//    • iPhone reachable → the phone runs the full agent and sends the answer.
//    • iPhone out of reach → WatchStandaloneClient calls the model directly.
//

import Foundation
import WatchConnectivity
import WatchKit

enum WatchAskState: Equatable {
    case idle
    case waiting(requestId: String, startedAt: Date)
    case replied(text: String)
}

/// Where an answer came from — shown under the mic and in the history.
enum WatchAskRoute: String, Codable {
    case phone
    case direct
}

/// One wrist question and its answer, kept on the watch (latest 20).
struct WatchHistoryEntry: Codable, Identifiable, Equatable {
    let id: String
    let question: String
    let answer: String
    let route: WatchAskRoute
    let date: Date
    /// Phone session the answer belongs to, so a follow-up continues it.
    let sessionId: String?
}

/// [T-leogateway] A remote gateway approval mirrored to the wrist.
struct WatchApproval: Identifiable, Equatable {
    let runId: String
    let detail: String
    /// Rendered verbatim — the gateway narrows this set for risky commands,
    /// so a hardcoded button row would offer permissions it will reject.
    let choices: [String]
    var id: String { runId }
}

@MainActor
final class WatchConnectivityClient: NSObject, ObservableObject {
    static let shared = WatchConnectivityClient()

    @Published private(set) var state: String = "idle"
    @Published private(set) var status: String = ""
    @Published private(set) var updatedAt: Date = .distantPast
    @Published private(set) var isPhoneReachable = false
    @Published private(set) var lastActionMessage: String?
    @Published private(set) var history: [WatchHistoryEntry] = []
    @Published var askState: WatchAskState = .idle
    /// [T-leogateway] A remote gateway run is blocked waiting for a yes/no.
    /// The wrist is the fastest place to unblock it. Nil when nothing pends.
    @Published var pendingApproval: WatchApproval?
    /// Bumps when a reply lands, for the settle-in animation.
    @Published private(set) var replyPulse = 0

    private static let historyKey = "leo.watch.history.v1"
    private static let historyLimit = 20

    /// Set when a send to the phone failed while it claimed to be reachable.
    /// For a minute the wrist answers directly instead of retrying a phone
    /// that isn't answering; any message from the phone clears it.
    private var phoneFailedAt: Date?

    /// What the pending question was, so the answer can be filed with it.
    private var pendingQuestion: (requestId: String, text: String, route: WatchAskRoute)?
    private var directTask: Task<Void, Never>?

    private var session: WCSession? {
        WCSession.isSupported() ? WCSession.default : nil
    }

    override init() {
        super.init()
        if let data = UserDefaults.standard.data(forKey: Self.historyKey),
           let saved = try? JSONDecoder().decode([WatchHistoryEntry].self, from: data) {
            history = saved
        }
    }

    func activate() {
        guard let session else { return }
        session.delegate = self
        session.activate()
        apply(session.receivedApplicationContext)
        isPhoneReachable = session.isReachable
    }

    /// The route a question would take right now.
    var route: WatchAskRoute? {
        let phoneSuspect = phoneFailedAt.map { Date().timeIntervalSince($0) < 60 } ?? false
        if isPhoneReachable, !phoneSuspect { return .phone }
        return WatchStandaloneClient.shared.isReady ? .direct : (isPhoneReachable ? .phone : nil)
    }

    // MARK: - Ask

    /// Text question (dictation). Follow-ups continue the latest phone session
    /// or, when answering directly, reuse the last few turns as context.
    func ask(_ text: String) {
        let question = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !question.isEmpty else { return }
        switch route {
        case .phone: askPhone(question)
        case .direct: askDirect(question)
        case nil: fail("iPhone 不在身边，也没有可直连的模型。")
        }
    }

    private func askPhone(_ text: String) {
        guard let session, session.isReachable else { return askDirect(text) }
        let requestId = begin(text, route: .phone)
        var payload: [String: Any] = ["kind": "ask", "requestId": requestId, "text": text]
        if let sessionId = followUpSessionId { payload["sessionId"] = sessionId }
        session.sendMessage(payload, replyHandler: { reply in
            Task { @MainActor in
                if (reply["ok"] as? Bool) != true { self.phoneFailed(requestId, text: text, reason: "发送失败") }
            }
        }, errorHandler: { error in
            Task { @MainActor in self.phoneFailed(requestId, text: text, reason: error.localizedDescription) }
        })
        startWatchdog(requestId)
    }

    /// "Reachable" only means the phone is connected, not that the app on it
    /// answers. When the send fails, ask the same question directly if we can.
    private func phoneFailed(_ requestId: String, text: String, reason: String) {
        guard case .waiting(let id, _) = askState, id == requestId else { return }
        phoneFailedAt = Date()
        if WatchStandaloneClient.shared.isReady {
            askState = .idle
            askDirect(text)
        } else {
            fail(reason)
        }
    }

    private func askDirect(_ text: String) {
        let requestId = begin(text, route: .direct)
        let context = recentContext
        directTask = Task {
            do {
                let answer = try await WatchStandaloneClient.shared.ask(text, history: context)
                self.finish(requestId: requestId, text: answer, sessionId: nil)
            } catch is CancellationError {
                // cancelAsk() already reset the state.
            } catch {
                self.finish(requestId: requestId, text: error.localizedDescription, sessionId: nil, failed: true)
            }
        }
    }

    /// Product-voice path: raw audio to the phone, transcription + agent run
    /// happen there. Envelope = one JSON header line + 0x0A + AAC bytes.
    func askAudio(_ audio: Data) {
        guard let session, session.isReachable else {
            return fail("iPhone 不可达，改用听写提问。")
        }
        let requestId = begin(nil, route: .phone)
        var header: [String: Any] = ["kind": "askAudio", "requestId": requestId]
        if let sessionId = followUpSessionId { header["sessionId"] = sessionId }
        guard let headerData = try? JSONSerialization.data(withJSONObject: header) else { return }
        var envelope = headerData
        envelope.append(0x0A)
        envelope.append(audio)
        session.sendMessageData(envelope, replyHandler: nil, errorHandler: { error in
            Task { @MainActor in
                self.phoneFailedAt = Date()
                self.fail("iPhone 没有响应：\(error.localizedDescription)")
            }
        })
        startWatchdog(requestId)
    }

    /// Stop waiting — and stop the work behind it, on the phone or here.
    func cancelAsk() {
        guard case .waiting(let requestId, _) = askState else { return }
        askState = .idle
        pendingQuestion = nil
        directTask?.cancel()
        directTask = nil
        if let session, session.isReachable {
            session.sendMessage(["kind": "cancelAsk", "requestId": requestId], replyHandler: nil, errorHandler: { _ in })
        }
        WKInterfaceDevice.current().play(.stop)
    }

    func noteTooShort() {
        lastActionMessage = "太短了，请再说一次"
    }

    func noteMicUnavailable() {
        lastActionMessage = "麦克风不可用。请在手表的「设置 › 隐私与安全性 › 麦克风」里允许 LeoPhoneAgent。"
    }

    private func begin(_ text: String?, route: WatchAskRoute) -> String {
        let requestId = UUID().uuidString
        askState = .waiting(requestId: requestId, startedAt: Date())
        pendingQuestion = (requestId, text ?? "（语音）", route)
        lastActionMessage = nil
        WKInterfaceDevice.current().play(.start)
        return requestId
    }

    private func fail(_ message: String) {
        askState = .idle
        pendingQuestion = nil
        lastActionMessage = message
        WKInterfaceDevice.current().play(.failure)
    }

    /// Give the phone 3 minutes, then stop showing the spinner.
    private func startWatchdog(_ requestId: String) {
        Task { [requestId] in
            try? await Task.sleep(nanoseconds: 185_000_000_000)
            if case .waiting(let id, _) = self.askState, id == requestId {
                self.finish(requestId: requestId,
                            text: "iPhone 未在时限内回复。任务可能仍在运行，可稍后在 iPhone 上查看。",
                            sessionId: nil, failed: true)
            }
        }
    }

    private func finish(requestId: String, text: String, sessionId: String?, failed: Bool = false) {
        // Only accept the answer we are actually waiting for — phone-side
        // automations reuse the delivery path and must not buzz the wrist.
        guard case .waiting(let id, _) = askState, id == requestId else { return }
        askState = .replied(text: text)
        replyPulse += 1
        WKInterfaceDevice.current().play(failed ? .failure : .success)
        if !failed, let pending = pendingQuestion, pending.requestId == requestId {
            record(WatchHistoryEntry(id: requestId, question: pending.text, answer: text,
                                     route: pending.route, date: Date(), sessionId: sessionId))
        }
        pendingQuestion = nil
        directTask = nil
    }

    // MARK: - History

    private func record(_ entry: WatchHistoryEntry) {
        history.insert(entry, at: 0)
        if history.count > Self.historyLimit { history.removeLast(history.count - Self.historyLimit) }
        if let data = try? JSONEncoder().encode(history) {
            UserDefaults.standard.set(data, forKey: Self.historyKey)
        }
    }

    /// A question within 20 minutes of the last answer continues that thread.
    private var isFollowUp: Bool {
        guard let last = history.first else { return false }
        return Date().timeIntervalSince(last.date) < 20 * 60
    }

    private var followUpSessionId: String? {
        isFollowUp ? history.first?.sessionId : nil
    }

    /// Last three turns, oldest first, for a direct follow-up.
    private var recentContext: [(question: String, answer: String)] {
        guard isFollowUp else { return [] }
        return history.prefix(3).reversed().map { ($0.question, $0.answer) }
    }

    // MARK: - Approvals

    /// Answer a pending gateway approval from the wrist.
    func answerApproval(choice: String) {
        guard let approval = pendingApproval else { return }
        // Reachability FIRST. Clearing the card and playing a success haptic
        // before knowing the phone can hear us tells the user "handled" while
        // the Mac stays blocked — the worst possible lie for this control.
        guard let session, session.isReachable else {
            WKInterfaceDevice.current().play(.failure)
            lastActionMessage = "iPhone 不可达,请在手机上处理"
            return
        }
        pendingApproval = nil
        WKInterfaceDevice.current().play(choice == "deny" ? .failure : .success)
        session.sendMessage([
            "kind": "approvalReply",
            "requestId": approval.runId,
            "choice": choice,
        ], replyHandler: nil, errorHandler: { _ in })
    }

    // MARK: - Inbound

    fileprivate func apply(_ context: [String: Any]) {
        guard !context.isEmpty else { return }
        phoneFailedAt = nil
        state = (context["state"] as? String) ?? "idle"
        status = (context["status"] as? String) ?? ""
        if let ts = context["updatedAt"] as? TimeInterval {
            updatedAt = Date(timeIntervalSince1970: ts)
        }
        // Fallback delivery for an ask answer that missed the live message.
        if case .waiting(let id, _) = askState,
           let replyId = context["askReplyId"] as? String, replyId == id,
           let text = context["askReplyText"] as? String, !text.isEmpty {
            finish(requestId: replyId, text: text, sessionId: context["askReplySessionId"] as? String)
        }
    }

    fileprivate func applyMessage(_ message: [String: Any]) {
        phoneFailedAt = nil
        switch message["kind"] as? String {
        case "approvalRequest":
            let runId = (message["requestId"] as? String) ?? ""
            let choices = (message["choices"] as? [String]) ?? []
            let detail = (message["text"] as? String) ?? ""
            // Empty choices = the phone answered it; withdraw the card rather
            // than leaving a dead prompt on the wrist.
            if runId.isEmpty || choices.isEmpty {
                if pendingApproval?.runId == runId || runId.isEmpty { pendingApproval = nil }
            } else {
                pendingApproval = WatchApproval(runId: runId, detail: detail, choices: choices)
                WKInterfaceDevice.current().play(.notification)
            }
        case "askReply":
            finish(requestId: (message["requestId"] as? String) ?? "",
                   text: (message["text"] as? String) ?? "",
                   sessionId: message["sessionId"] as? String)
        default:
            break
        }
    }
}

extension WatchConnectivityClient: WCSessionDelegate {
    nonisolated func session(
        _ session: WCSession,
        activationDidCompleteWith activationState: WCSessionActivationState,
        error: Error?
    ) {
        let context = session.receivedApplicationContext
        let reachable = session.isReachable
        Task { @MainActor in
            WatchConnectivityClient.shared.apply(context)
            WatchConnectivityClient.shared.isPhoneReachable = reachable
        }
    }

    nonisolated func sessionReachabilityDidChange(_ session: WCSession) {
        let reachable = session.isReachable
        Task { @MainActor in
            WatchConnectivityClient.shared.isPhoneReachable = reachable
            WatchConnectivityClient.shared.phoneFailedAt = nil
        }
    }

    nonisolated func session(_ session: WCSession, didReceiveApplicationContext applicationContext: [String: Any]) {
        Task { @MainActor in WatchConnectivityClient.shared.apply(applicationContext) }
    }

    nonisolated func session(_ session: WCSession, didReceiveMessage message: [String: Any]) {
        Task { @MainActor in WatchConnectivityClient.shared.applyMessage(message) }
    }

    /// [T-watch-standalone] The direct-answer config (or "forget it").
    nonisolated func session(_ session: WCSession, didReceiveUserInfo userInfo: [String: Any] = [:]) {
        guard (userInfo["kind"] as? String) == "standaloneConfig" else { return }
        Task { @MainActor in WatchStandaloneClient.shared.apply(userInfo) }
    }
}
