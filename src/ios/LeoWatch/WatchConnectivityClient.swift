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

struct WatchQuickTask: Identifiable, Hashable {
    let id: String
    let name: String
    let symbolName: String
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

    private var session: WCSession? {
        WCSession.isSupported() ? WCSession.default : nil
    }

    func activate() {
        guard let session else { return }
        session.delegate = self
        session.activate()
        apply(session.receivedApplicationContext)
    }

    /// Ask the phone to run a quick task. The phone owns the agent loop; the
    /// watch never tries to run one itself.
    func runQuickTask(_ task: WatchQuickTask) {
        guard let session, session.isReachable else {
            lastActionMessage = "iPhone 未连接"
            return
        }
        lastActionMessage = "正在启动…"
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
        if let ts = context["updatedAt"] as? TimeInterval {
            updatedAt = Date(timeIntervalSince1970: ts)
        }
        if let raw = context["quickTasks"] as? [[String]] {
            quickTasks = raw.compactMap { row in
                guard row.count >= 3 else { return nil }
                return WatchQuickTask(id: row[0], name: row[1], symbolName: row[2])
            }
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
}
