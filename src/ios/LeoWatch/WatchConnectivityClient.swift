//
//  WatchConnectivityClient.swift
//  LeoWatch
//
//  Watch side of the bridge. Mirrors the key contract in the phone's
//  WatchBridge.swift — kept as plain strings so neither target has to import
//  the other's code.
//

import Foundation
import WatchConnectivity
import WatchKit

struct WatchQuickTask: Identifiable, Hashable {
    let id: String
    let name: String
    let symbolName: String
}

struct WatchSessionItem: Identifiable, Hashable {
    let id: String
    let title: String
    let state: String
    let unread: Bool
}

struct WatchScheduledItem: Identifiable, Hashable {
    let id: String
    let name: String
    let timeText: String
    let enabled: Bool
}

enum WatchAskState: Equatable {
    case idle
    case waiting(requestId: String, startedAt: Date)
    case replied(text: String)
}

@MainActor
final class WatchConnectivityClient: NSObject, ObservableObject {
    static let shared = WatchConnectivityClient()

    @Published private(set) var state: String = "idle"
    @Published private(set) var title: String = ""
    @Published private(set) var status: String = ""
    @Published private(set) var activeCount: Int = 0
    @Published private(set) var updatedAt: Date = .distantPast
    @Published private(set) var quickTasks: [WatchQuickTask] = []
    @Published private(set) var lastActionMessage: String?
    @Published private(set) var briefingTask: String = ""
    @Published private(set) var briefingText: String = ""
    @Published private(set) var sessions: [WatchSessionItem] = []
    @Published private(set) var scheduled: [WatchScheduledItem] = []
    @Published var askState: WatchAskState = .idle
    /// Bumps when a reply lands, for the settle-in animation.
    @Published private(set) var replyPulse = 0

    private var session: WCSession? {
        WCSession.isSupported() ? WCSession.default : nil
    }

    func activate() {
        guard let session else { return }
        session.delegate = self
        session.activate()
        apply(session.receivedApplicationContext)
    }

    // MARK: - Ask (the wrist's core interaction)

    func ask(_ text: String, sessionId: String? = nil) {
        guard let session, session.isReachable else {
            lastActionMessage = "iPhone 不可达"
            WKInterfaceDevice.current().play(.failure)
            return
        }
        let requestId = UUID().uuidString
        askState = .waiting(requestId: requestId, startedAt: Date())
        WKInterfaceDevice.current().play(.start)
        var payload: [String: Any] = ["kind": "ask", "requestId": requestId, "text": text]
        if let sessionId { payload["sessionId"] = sessionId }
        session.sendMessage(payload, replyHandler: { reply in
            Task { @MainActor in
                if (reply["ok"] as? Bool) != true {
                    self.askState = .idle
                    self.lastActionMessage = "发送失败"
                    WKInterfaceDevice.current().play(.failure)
                }
            }
        }, errorHandler: { error in
            Task { @MainActor in
                self.askState = .idle
                self.lastActionMessage = error.localizedDescription
                WKInterfaceDevice.current().play(.failure)
            }
        })
        // Watchdog: give the phone 3 minutes, then stop showing the spinner.
        Task { [requestId] in
            try? await Task.sleep(nanoseconds: 185_000_000_000)
            if case .waiting(let id, _) = self.askState, id == requestId {
                self.askState = .replied(text: "iPhone 未在时限内回复。任务可能仍在运行，可稍后在 iPhone 上查看。")
                self.replyPulse += 1
            }
        }
    }

    /// Product-voice path: raw audio to the phone, transcription + agent run
    /// happen there. Envelope = one JSON header line + 0x0A + AAC bytes.
    func askAudio(_ audio: Data, sessionId: String? = nil) {
        guard let session, session.isReachable else {
            lastActionMessage = "iPhone 不可达"
            WKInterfaceDevice.current().play(.failure)
            return
        }
        let requestId = UUID().uuidString
        askState = .waiting(requestId: requestId, startedAt: Date())
        var header: [String: Any] = ["kind": "askAudio", "requestId": requestId]
        if let sessionId { header["sessionId"] = sessionId }
        guard let headerData = try? JSONSerialization.data(withJSONObject: header) else { return }
        var envelope = headerData
        envelope.append(0x0A)
        envelope.append(audio)
        session.sendMessageData(envelope, replyHandler: nil, errorHandler: { error in
            Task { @MainActor in
                self.askState = .idle
                self.lastActionMessage = "发送失败: \(error.localizedDescription)"
                WKInterfaceDevice.current().play(.failure)
            }
        })
        Task { [requestId] in
            try? await Task.sleep(nanoseconds: 185_000_000_000)
            if case .waiting(let id, _) = self.askState, id == requestId {
                self.askState = .replied(text: "iPhone 未在时限内回复。任务可能仍在运行，可稍后在 iPhone 上查看。")
                self.replyPulse += 1
            }
        }
    }

    private func handleAskReply(requestId: String, text: String) {
        // Only accept the reply we are actually waiting for — the old check
        // let ANY reply through when idle (phone-side automations buzzed the
        // wrist with answers nobody asked for here).
        guard case .waiting(let id, _) = askState, id == requestId else { return }
        askState = .replied(text: text)
        replyPulse += 1
        WKInterfaceDevice.current().play(.success)
    }

    // MARK: - Session actions

    func requestTranscript(sessionId: String, completion: @escaping (String) -> Void) {
        guard let session, session.isReachable else {
            completion("iPhone 不可达，无法加载对话。")
            return
        }
        session.sendMessage(["kind": "transcript", "sessionId": sessionId], replyHandler: { reply in
            Task { @MainActor in completion((reply["text"] as? String) ?? "加载失败") }
        }, errorHandler: { error in
            Task { @MainActor in completion("加载失败: \(error.localizedDescription)") }
        })
    }

    func stopSession(_ sessionId: String) {
        sendSimple(["kind": "stopSession", "sessionId": sessionId], success: "已停止该任务")
    }

    func runScheduled(_ id: String) {
        sendSimple(["kind": "scheduledRun", "sessionId": id], success: "已启动")
    }

    func toggleScheduled(_ id: String) {
        sendSimple(["kind": "scheduledToggle", "sessionId": id], success: "已切换")
    }

    func noteTooShort() {
        lastActionMessage = "太短了，请再说一次"
    }

    func stopAll() {
        sendSimple(["kind": "stopAll"], success: "已发送停止指令")
    }

    private func sendSimple(_ payload: [String: Any], success: String) {
        guard let session, session.isReachable else {
            lastActionMessage = "iPhone 不可达"
            return
        }
        session.sendMessage(payload, replyHandler: { _ in
            Task { @MainActor in self.lastActionMessage = success }
        }, errorHandler: { error in
            Task { @MainActor in self.lastActionMessage = "失败: \(error.localizedDescription)" }
        })
    }

    func runQuickTask(_ task: WatchQuickTask) {
        guard let session, session.isReachable else {
            lastActionMessage = "iPhone 未连接"
            return
        }
        lastActionMessage = "正在启动…"
        WKInterfaceDevice.current().play(.start)
        session.sendMessage(
            ["kind": "runQuickTask", "taskId": task.id],
            replyHandler: { [weak self] reply in
                Task { @MainActor in
                    let ok = (reply["ok"] as? Bool) ?? false
                    self?.lastActionMessage = ok ? "已在 iPhone 上启动" : "启动失败"
                }
            },
            errorHandler: { [weak self] error in
                Task { @MainActor in
                    self?.lastActionMessage = error.localizedDescription
                }
            }
        )
    }

    fileprivate func apply(_ context: [String: Any]) {
        guard !context.isEmpty else { return }
        state = (context["state"] as? String) ?? "idle"
        title = (context["title"] as? String) ?? ""
        status = (context["status"] as? String) ?? ""
        activeCount = (context["activeCount"] as? Int) ?? 0
        briefingTask = (context["briefingTask"] as? String) ?? ""
        briefingText = (context["briefingText"] as? String) ?? ""
        if let ts = context["updatedAt"] as? TimeInterval {
            updatedAt = Date(timeIntervalSince1970: ts)
        }
        if let raw = context["quickTasks"] as? [[String]] {
            quickTasks = raw.compactMap { row in
                guard row.count >= 3 else { return nil }
                return WatchQuickTask(id: row[0], name: row[1], symbolName: row[2])
            }
        }
        if let raw = context["sessions"] as? [[String]] {
            sessions = raw.compactMap { row in
                guard row.count >= 4 else { return nil }
                return WatchSessionItem(id: row[0], title: row[1], state: row[2], unread: row[3] == "1")
            }
        }
        if let raw = context["scheduled"] as? [[String]] {
            scheduled = raw.compactMap { row in
                guard row.count >= 4 else { return nil }
                return WatchScheduledItem(id: row[0], name: row[1], timeText: row[2], enabled: row[3] == "1")
            }
        }
        // Fallback delivery for an ask answer that missed the live message.
        if case .waiting(let id, _) = askState,
           let replyId = context["askReplyId"] as? String, replyId == id,
           let text = context["askReplyText"] as? String, !text.isEmpty {
            handleAskReply(requestId: replyId, text: text)
        }
    }

    fileprivate func applyMessage(_ message: [String: Any]) {
        if (message["kind"] as? String) == "askReply" {
            let id = (message["requestId"] as? String) ?? ""
            let text = (message["text"] as? String) ?? ""
            handleAskReply(requestId: id, text: text)
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
        Task { @MainActor in WatchConnectivityClient.shared.apply(context) }
    }

    nonisolated func session(_ session: WCSession, didReceiveApplicationContext applicationContext: [String: Any]) {
        Task { @MainActor in WatchConnectivityClient.shared.apply(applicationContext) }
    }

    nonisolated func session(_ session: WCSession, didReceiveMessage message: [String: Any]) {
        Task { @MainActor in WatchConnectivityClient.shared.applyMessage(message) }
    }
}
