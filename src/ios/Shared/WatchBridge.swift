//
//  WatchBridge.swift
//  MinisApp
//
//  [T-watch-companion] iPhone side of the Apple Watch companion.
//
//  IMPORTANT correction to an earlier assumption: App Group UserDefaults do
//  NOT cross from iPhone to Watch — an App Group is shared between processes
//  on ONE device. So the widget snapshot the Home Screen reads is unreachable
//  from watchOS, and the companion needs WatchConnectivity instead. This file
//  is that transport.
//
//  Direction of travel:
//    • phone → watch  `updateApplicationContext` with the current agent
//      status. Last-value-wins semantics are exactly right for "what is the
//      agent doing"; a queue would just deliver stale frames.
//    • watch → phone  `sendMessage` naming a quick task to run, which lands
//      in the same runner the Home Screen widget uses.
//
//  Inert when no watch is paired, so shipping it costs nothing.
//

import Foundation
#if canImport(WatchConnectivity)
import WatchConnectivity
#endif

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
    static let quickTasks = "quickTasks"      // [[id, name, symbol]]
    static let taskId = "taskId"

    static let briefingTask = "briefingTask"
    static let briefingText = "briefingText"

    static let kindStatus = "status"
    static let kindRunQuickTask = "runQuickTask"
    static let kindStopAll = "stopAll"
}

#if canImport(WatchConnectivity)

@MainActor
final class WatchBridge: NSObject, ObservableObject {
    static let shared = WatchBridge()

    private var session: WCSession? {
        WCSession.isSupported() ? WCSession.default : nil
    }

    private var lastPushedSignature: String = ""

    func resetDedupe() { lastPushedSignature = "" }

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

        let snapshot = AgentWidgetSnapshotStore.load()
        let tasks = WidgetQuickTasksStore.load().prefix(4).map { [$0.id, $0.name, $0.symbolName] }

        let context: [String: Any] = [
            WatchPayloadKey.kind: WatchPayloadKey.kindStatus,
            WatchPayloadKey.state: snapshot.state.rawValue,
            WatchPayloadKey.title: snapshot.title,
            WatchPayloadKey.status: snapshot.status,
            WatchPayloadKey.activeCount: snapshot.activeCount,
            WatchPayloadKey.briefingTask: WidgetBriefingStore.load()?.taskName ?? "",
            WatchPayloadKey.briefingText: String((WidgetBriefingStore.load()?.summary ?? "").prefix(300)),
            WatchPayloadKey.updatedAt: snapshot.updatedAt.timeIntervalSince1970,
            WatchPayloadKey.quickTasks: tasks,
        ]

        // [T-watch-signature-count-only] Dedupe on the actual payload. The
        // signature only counted the tasks, so renaming a quick task or
        // changing its icon produced an identical signature and the watch kept
        // showing the old label indefinitely.
        let taskSignature = tasks.map { $0.joined(separator: "\u{1}") }.joined(separator: "\u{2}")
        let signature = "\(snapshot.state.rawValue)|\(snapshot.activeCount)|\(snapshot.title)|\(snapshot.status)|\(taskSignature)"
        guard signature != lastPushedSignature else { return }
        lastPushedSignature = signature

        do {
            try session.updateApplicationContext(context)
            logger.info("pushed status to watch state=\(snapshot.state.rawValue) active=\(snapshot.activeCount)")
        } catch {
            logger.error("watch context push failed: \(error.localizedDescription)")
        }
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

    /// Watch asked us to run a quick task. Route it through the same runner
    /// the widget button uses so badges, briefing capture and keep-alive all
    /// behave identically no matter which surface started the run.
    nonisolated func session(
        _ session: WCSession,
        didReceiveMessage message: [String: Any],
        replyHandler: @escaping ([String: Any]) -> Void
    ) {
        if (message[WatchPayloadKey.kind] as? String) == WatchPayloadKey.kindStopAll {
            Task { @MainActor in
                await WidgetIntentBridge.shared.stopAllTasks()
                WatchBridge.shared.resetDedupe()
                WatchBridge.shared.pushStatus()
            }
            replyHandler(["ok": true])
            return
        }
        guard (message[WatchPayloadKey.kind] as? String) == WatchPayloadKey.kindRunQuickTask,
              let taskId = message[WatchPayloadKey.taskId] as? String else {
            replyHandler(["ok": false])
            return
        }
        // [T-watch-reply-before-dispatch] The reply used to be sent here,
        // synchronously, before the task had even been looked up — so the watch
        // said "started on iPhone" for a task id that did not exist, or for a
        // run that failed immediately. Worse: a watch message often wakes the
        // iPhone app from not-running, and returning the reply releases the
        // process assertion that delivery holds, so the work could be suspended
        // before it began. Reply only once the run has actually been dispatched,
        // and report what really happened.
        Task { @MainActor in
            let started = await QuickTaskWidgetRunner.run(taskId: taskId)
            WatchBridge.shared.pushStatus()
            replyHandler(["ok": started])
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
}

#endif
