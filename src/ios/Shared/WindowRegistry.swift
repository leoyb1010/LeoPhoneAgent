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
//  App-wide notifications describe an intent with no window context, so exactly
//  one window has to claim them: the one the user is driving. Windows register
//  on appear and re-claim when their scene becomes active, so "most recently
//  focused" wins — deterministic, and never zero windows (the fallback below
//  keeps a single-window app working even if registration is somehow missed).
//
//  Purely in-window navigation must NOT go through notifications at all; see
//  `ContentView.jumpToSession`.
//

import Foundation

@MainActor
final class WindowRegistry: ObservableObject {
    static let shared = WindowRegistry()

    @Published private(set) var activeWindowId: UUID?
    private var registered: [UUID] = []

    func register(_ id: UUID) {
        if !registered.contains(id) { registered.append(id) }
        activeWindowId = id
    }

    func unregister(_ id: UUID) {
        registered.removeAll { $0 == id }
        if activeWindowId == id { activeWindowId = registered.last }
    }

    func markActive(_ id: UUID) {
        guard registered.contains(id) else { return register(id) }
        activeWindowId = id
    }

    /// True when `id` should act on an app-wide notification. Also true when
    /// nothing is registered or only one window exists, so the single-window
    /// case is unaffected.
    func isPrimary(_ id: UUID) -> Bool {
        registered.count <= 1 || activeWindowId == nil || activeWindowId == id
    }
}
