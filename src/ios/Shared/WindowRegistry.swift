//
//  WindowRegistry.swift
//  MinisApp
//
//  [T-multiwindow-notification-fanout] Decides which window handles a global
//  notification.
//
//  `Info.plist` declares `UIApplicationSupportsMultipleScenes`, so on iPad the
//  user can drag out a second window — and every window mounts its own
//  ContentView, each subscribed to the same `NotificationCenter.default`
//  publishers. A single ⌘N, Home Screen quick action or `leophoneagent://new`
//  deep link therefore ran `handleNewChatRequest()` twice (two draft sessions,
//  and a race in the QuickActionWorkflow singleton that left one window holding
//  an orphan), and one "open session" intent navigated both windows.
//
//  [T-windowregistry-staleness] The first design tracked "the active window"
//  from `scenePhase` changes and cleaned up in `onDisappear`. Both signals are
//  unreliable: Stage Manager keeps two scenes `.active` simultaneously, so
//  switching focus produces NO scenePhase change and the claim stayed with
//  whichever window mounted last — the other window's ⌘N was silently dropped;
//  and a scene the system destroys is not guaranteed an `onDisappear`, leaving
//  a dead id as the permanent claimant. This version therefore:
//    • registers each window WITH its UIWindow (held weakly) — a destroyed
//      window prunes itself, no teardown callback needed;
//    • listens to `UIWindow.didBecomeKeyNotification`, which fires on every
//      real focus change including Stage Manager switches;
//    • answers `isPrimary` deterministically even when the claim is stale:
//      exactly one live window wins, never zero and never both.
//
//  Purely in-window navigation must NOT go through notifications at all; see
//  `ContentView.jumpToSession`.
//

import SwiftUI
import UIKit

@MainActor
final class WindowRegistry: ObservableObject {
    static let shared = WindowRegistry()

    private struct Entry {
        let id: UUID
        weak var window: UIWindow?
    }

    private var entries: [Entry] = []
    private var activeWindowId: UUID?
    private var keyObserver: NSObjectProtocol?

    private init() {
        keyObserver = NotificationCenter.default.addObserver(
            forName: UIWindow.didBecomeKeyNotification, object: nil, queue: .main
        ) { [weak self] note in
            guard let window = note.object as? UIWindow else { return }
            MainActor.assumeIsolated {
                guard let self else { return }
                if let entry = self.entries.first(where: { $0.window === window }) {
                    self.activeWindowId = entry.id
                }
            }
        }
    }

    /// Register (or re-register) a window. `window` may be nil on the first
    /// call if the view hasn't landed in a window yet; a later call with the
    /// real window upgrades the entry.
    func register(_ id: UUID, window: UIWindow?) {
        prune()
        if let index = entries.firstIndex(where: { $0.id == id }) {
            if let window { entries[index] = Entry(id: id, window: window) }
        } else {
            entries.append(Entry(id: id, window: window))
        }
        if window != nil { attachedIds.insert(id) }
        // A freshly-registered window is what the user is looking at.
        activeWindowId = id
    }

    func unregister(_ id: UUID) {
        entries.removeAll { $0.id == id }
        if activeWindowId == id { activeWindowId = entries.last?.id }
    }

    func markActive(_ id: UUID) {
        guard entries.contains(where: { $0.id == id }) else {
            return register(id, window: nil)
        }
        activeWindowId = id
    }

    /// True when `id` should act on an app-wide notification. Guarantees:
    /// with 0 or 1 live windows every caller wins (single-window behaviour is
    /// untouched); with several, exactly one wins — the key window when we can
    /// see it, else the claimed one, else deterministically the first.
    func isPrimary(_ id: UUID) -> Bool {
        prune()
        guard entries.count > 1 else { return true }
        // Live truth first: whichever registered window is currently key.
        if let keyEntry = entries.first(where: { $0.window?.isKeyWindow == true }) {
            let won = keyEntry.id == id
            if !won { logDrop(id, reason: "key window is \(keyEntry.id)") }
            return won
        }
        if let activeWindowId, entries.contains(where: { $0.id == activeWindowId }) {
            let won = activeWindowId == id
            if !won { logDrop(id, reason: "claimed by \(activeWindowId)") }
            return won
        }
        // No live signal at all — pick deterministically rather than either
        // dropping everywhere or double-handling.
        let won = entries.first?.id == id
        if !won { logDrop(id, reason: "fallback to first registered") }
        return won
    }

    /// Ids that supplied a real window at some point. An entry whose weak
    /// window is nil is only "dead" if it once had one — a just-registered
    /// view that hasn't landed in a window yet must not be pruned.
    private var attachedIds: Set<UUID> = []

    private func prune() {
        let dead = entries.filter { $0.window == nil && attachedIds.contains($0.id) }.map(\.id)
        guard !dead.isEmpty else { return }
        entries.removeAll { dead.contains($0.id) }
        attachedIds.subtract(dead)
        if let activeWindowId, dead.contains(activeWindowId) {
            self.activeWindowId = entries.last?.id
        }
    }

    private func logDrop(_ id: UUID, reason: String) {
        NSLog("[WindowRegistry] window %@ ignored a global notification (%@)", String(id.uuidString.prefix(8)), reason)
    }
}

/// Hands the hosting UIWindow to its callback once the view lands in one (and
/// again if it moves). Zero-size, zero-cost.
struct WindowCaptureView: UIViewRepresentable {
    let onWindow: (UIWindow) -> Void

    func makeUIView(context: Context) -> CaptureView {
        let view = CaptureView()
        view.onWindow = onWindow
        return view
    }

    func updateUIView(_ uiView: CaptureView, context: Context) {}

    final class CaptureView: UIView {
        var onWindow: ((UIWindow) -> Void)?

        override func didMoveToWindow() {
            super.didMoveToWindow()
            if let window { onWindow?(window) }
        }
    }
}
