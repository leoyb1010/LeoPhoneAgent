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
//    • iPhone out of reach, or "always answer on the watch" picked on the
//      phone → WatchStandaloneClient calls the model directly.
//

import Foundation
import UserNotifications
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
    /// "low" | "medium" | "high", assessed on the phone from the command.
    let risk: String
    var id: String { runId }
    var isHighRisk: Bool { risk == "high" }
}

@MainActor
final class WatchConnectivityClient: NSObject, ObservableObject {
    static let shared = WatchConnectivityClient()

    @Published private(set) var state: String = "idle"
    @Published private(set) var status: String = ""
    /// Tasks running on the phone right now (from its status push).
    @Published private(set) var activeCount = 0
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
    /// The last reply was an error message, not an answer: shown, not spoken.
    @Published private(set) var lastReplyFailed = false

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
        WatchStandaloneClient.shared.onBackgroundAnswer = { [weak self] requestId, question, result in
            self?.backgroundAnswered(requestId: requestId, question: question, result: result)
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
        let standalone = WatchStandaloneClient.shared
        if standalone.isReady, standalone.prefersDirect { return .direct }
        let phoneSuspect = phoneFailedAt.map { Date().timeIntervalSince($0) < 60 } ?? false
        if isPhoneReachable, !phoneSuspect { return .phone }
        return standalone.isReady ? .direct : (isPhoneReachable ? .phone : nil)
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
        directContext = (requestId, text, context)
        requestNotificationPermissionOnce()
        directTask = Task {
            do {
                let answer = try await WatchStandaloneClient.shared.ask(text, history: context)
                self.finish(requestId: requestId, text: answer, sessionId: nil)
            } catch is CancellationError {
                // cancelAsk() or the background hand-off took over.
            } catch WatchStandaloneError.network {
                // A flaky link: let the system retry it and bring the answer back.
                self.handOffToBackground(reason: "网络不稳，已转到后台，答案会送到通知里。")
            } catch {
                self.finish(requestId: requestId, text: error.localizedDescription, sessionId: nil, failed: true)
            }
        }
    }

    /// The direct question in flight, kept so it can move to the background.
    private var directContext: (requestId: String, text: String, history: [(question: String, answer: String)])?

    /// Called when the app leaves the foreground (and on network failure):
    /// the foreground request would die with the suspended app, so the same
    /// question continues as a background transfer.
    func handOffToBackground(reason: String? = nil) {
        guard let context = directContext, case .waiting(let id, _) = askState, id == context.requestId else { return }
        directTask?.cancel()
        directTask = nil
        do {
            try WatchStandaloneClient.shared.askInBackground(requestId: context.requestId, text: context.text,
                                                             history: context.history)
            directContext = nil   // handed off once; the next trip to the background must not upload it again
            if let reason { lastActionMessage = reason }
        } catch {
            finish(requestId: context.requestId, text: error.localizedDescription, sessionId: nil, failed: true)
        }
    }

    private func backgroundAnswered(requestId: String, question: String, result: Result<String, Error>) {
        let text: String
        let failed: Bool
        switch result {
        case .success(let answer): (text, failed) = (answer, false)
        case .failure(let error): (text, failed) = (error.localizedDescription, true)
        }
        if case .waiting(let id, _) = askState, id == requestId {
            finish(requestId: requestId, text: text, sessionId: nil, failed: failed)
        } else if !failed {
            // The app was relaunched just to receive this: file it anyway.
            record(WatchHistoryEntry(id: requestId, question: question, answer: text,
                                     route: .direct, date: Date(), sessionId: nil))
        }
        if WKApplication.shared().applicationState != .active {
            let content = UNMutableNotificationContent()
            content.title = failed ? "Leo 没能回答" : "Leo"
            content.body = failed ? text : String(text.prefix(180))
            content.sound = .default
            UNUserNotificationCenter.current().add(
                UNNotificationRequest(identifier: "answer-\(requestId)", content: content, trigger: nil))
        }
    }

    private func requestNotificationPermissionOnce() {
        let key = "leo.watch.notificationsRequested"
        guard !UserDefaults.standard.bool(forKey: key) else { return }
        UserDefaults.standard.set(true, forKey: key)
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { _, _ in }
    }

    /// Cheap nudge as recording starts: the phone app is awake by the time
    /// the audio arrives, which saves a second or two on the answer.
    func wakePhone() {
        guard let session, session.isReachable else { return }
        session.sendMessage(["kind": "wake"], replyHandler: nil, errorHandler: { _ in })
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
        directContext = nil
        directTask?.cancel()
        directTask = nil
        WatchStandaloneClient.shared.cancelBackground(requestId: requestId)
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
        lastReplyFailed = failed
        replyPulse += 1
        WKInterfaceDevice.current().play(failed ? .failure : .success)
        if !failed, let pending = pendingQuestion, pending.requestId == requestId {
            record(WatchHistoryEntry(id: requestId, question: pending.text, answer: text,
                                     route: pending.route, date: Date(), sessionId: sessionId))
        }
        pendingQuestion = nil
        directContext = nil
        directTask = nil
        lastActionMessage = nil   // "moved to the background" is over once the answer is here
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
    ///
    /// Live message when the phone is reachable; otherwise (or when the live
    /// send fails) the reply is queued with transferUserInfo and delivered the
    /// moment the phone is back. The phone resolves each approval once, so a
    /// reply that arrives on both channels is harmless. Never claim "handled"
    /// for a queued reply: the Mac stays blocked until it lands.
    func answerApproval(choice: String) {
        guard let approval = pendingApproval, let session else { return }
        pendingApproval = nil
        let payload: [String: Any] = ["kind": "approvalReply", "requestId": approval.runId, "choice": choice]
        if session.isReachable {
            WKInterfaceDevice.current().play(choice == "deny" ? .failure : .success)
            session.sendMessage(payload, replyHandler: { _ in }, errorHandler: { _ in
                Task { @MainActor in
                    session.transferUserInfo(payload)
                    WatchConnectivityClient.shared.lastActionMessage = "iPhone 没有回应，已排队，连上后生效。"
                }
            })
        } else {
            session.transferUserInfo(payload)
            WKInterfaceDevice.current().play(.click)
            lastActionMessage = "iPhone 暂时不可达，已排队，连上后生效。"
        }
    }

    // MARK: - Inbound

    fileprivate func apply(_ context: [String: Any]) {
        guard !context.isEmpty else { return }
        phoneFailedAt = nil
        state = (context["state"] as? String) ?? "idle"
        status = (context["status"] as? String) ?? ""
        activeCount = (context["activeCount"] as? Int) ?? 0
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
                pendingApproval = WatchApproval(runId: runId, detail: detail, choices: choices,
                                                risk: (message["risk"] as? String) ?? "medium")
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
