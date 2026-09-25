//
//  LeoCommands.swift
//  MinisApp
//
//  [T-ipad-menu-bar] The iPad menu bar and the hardware-keyboard shortcut
//  overlay (hold ⌘) come from these commands. They used to be zero-opacity
//  buttons inside the session list, which only fired while the list was on
//  screen — in portrait with the sidebar tucked away, ⌘F / ⌘K / ⌘1…9 did
//  nothing and nothing told you they existed.
//
//  Commands post to the frontmost window; ContentView (via WindowRegistry)
//  and the chat detail container decide whether they are the one to act.
//

import SwiftUI

/// Workspace-level actions, handled by the frontmost ContentView.
enum WorkspaceCommand: Equatable {
    case search
    case palette
    case settings
    case session(Int)        // 1-based position in the visible list

    fileprivate var userInfo: [String: Any] {
        switch self {
        case .search: return ["command": "search"]
        case .palette: return ["command": "palette"]
        case .settings: return ["command": "settings"]
        case .session(let index): return ["command": "session", "index": index]
        }
    }

    init?(userInfo: [AnyHashable: Any]?) {
        switch userInfo?["command"] as? String {
        case "search": self = .search
        case "palette": self = .palette
        case "settings": self = .settings
        case "session": self = .session(userInfo?["index"] as? Int ?? 1)
        default: return nil
        }
    }

    func post() {
        NotificationCenter.default.post(name: .workspaceCommand, object: nil, userInfo: userInfo)
    }
}

extension Notification.Name {
    static let workspaceCommand = Notification.Name("leo.workspaceCommand")
    /// Show / hide the chat inspector column (iPad split layout).
    static let toggleChatInspector = Notification.Name("leo.toggleChatInspector")
}

struct LeoCommands: Commands {
    var body: some Commands {
        CommandGroup(replacing: .newItem) {
            Button {
                NotificationCenter.default.post(name: .newChatRequested, object: nil)
            } label: {
                Label("新任务", systemImage: "square.and.pencil")
            }
            .keyboardShortcut("n", modifiers: .command)
        }
        CommandGroup(replacing: .appSettings) {
            Button {
                WorkspaceCommand.settings.post()
            } label: {
                Label("设置…", systemImage: "gear")
            }
            .keyboardShortcut(",", modifiers: .command)
        }
        CommandMenu("会话") {
            Button {
                WorkspaceCommand.search.post()
            } label: {
                Label("搜索会话", systemImage: "magnifyingglass")
            }
            .keyboardShortcut("f", modifiers: .command)
            Button {
                WorkspaceCommand.palette.post()
            } label: {
                Label("命令面板", systemImage: "command")
            }
            .keyboardShortcut("k", modifiers: .command)
            Divider()
            ForEach(1...9, id: \.self) { index in
                Button("第 \(index) 个会话") { WorkspaceCommand.session(index).post() }
                    .keyboardShortcut(KeyEquivalent(Character("\(index)")), modifiers: .command)
            }
        }
        CommandMenu("对话") {
            Button {
                ChatCommandTarget.stopActiveRun()
            } label: {
                Label("停止当前任务", systemImage: "stop.circle")
            }
            .keyboardShortcut(".", modifiers: .command)
            Button {
                NotificationCenter.default.post(name: .toggleChatInspector, object: nil)
            } label: {
                Label("显示或隐藏检查器", systemImage: "sidebar.right")
            }
            .keyboardShortcut("i", modifiers: [.command, .option])
        }
        SidebarCommands()
    }
}

/// The chat on screen in the frontmost window. `activeSessionId` is kept by
/// the chat view that is actually visible, so a stop never hits a chat the
/// user isn't looking at.
@MainActor
enum ChatCommandTarget {
    static func stopActiveRun() {
        guard let sid = AIChatViewModel.activeSessionId,
              let vm = ViewModelCache.shared.get(for: sid),
              vm.isProcessing else { return }
        vm.cancel()
        LeoHaptics.selection()
    }
}

// MARK: - Multi-window

/// [T-ipad-multiwindow] A session in a window of its own: the row's context
/// menu and dragging a row to the screen edge both carry the session as an
/// NSUserActivity.
enum SessionWindow {
    static let activityType = "com.leoyuan.leophoneagent.session"

    static var isSupported: Bool { UIApplication.shared.supportsMultipleScenes }

    static func activity(for sessionId: String) -> NSUserActivity {
        let activity = NSUserActivity(activityType: activityType)
        activity.userInfo = ["sessionId": sessionId]
        activity.targetContentIdentifier = sessionId
        return activity
    }

    static func sessionId(from activity: NSUserActivity) -> String? {
        activity.userInfo?["sessionId"] as? String
    }

    @MainActor
    static func open(_ sessionId: String) {
        var request = UISceneSessionActivationRequest(role: .windowApplication)
        request.userActivity = activity(for: sessionId)
        UIApplication.shared.activateSceneSession(for: request) { error in
            AppLogger(category: "Window").error("[Window] open session window failed: \(error.localizedDescription)")
        }
    }

    /// Drag payload for a session row; dropped at the screen edge it becomes a window.
    static func itemProvider(for sessionId: String?) -> NSItemProvider {
        let provider = NSItemProvider()
        if let sessionId { provider.registerObject(activity(for: sessionId), visibility: .all) }
        return provider
    }
}

/// Per-window glue that has to live inside the scene. Rides in ContentView's
/// existing window-capture background (no extra modifier on that deep chain):
/// opens the session a new-window request carries, and on iPadOS 27 asks
/// before closing a window whose task is still running. What a window shows
/// at launch stays with the app's own launch-screen setting.
struct SceneSessionHost: View {
    /// Real id of the session on screen; nil on home or an unsent draft.
    let sessionId: String?
    let sessionCount: Int
    let onWindow: (UIWindow) -> Void
    /// Shows the session in this window; false when it doesn't exist (yet).
    let open: (String) -> Bool

    /// A new-window request that arrived before the session list loaded.
    @State private var requestedSessionId: String?
    @State private var window: UIWindow?
    @ObservedObject private var activity = SessionActivityTracker.shared

    private var isRunning: Bool {
        sessionId.map { activity.activeSessions.contains($0) } ?? false
    }

    var body: some View {
        WindowCaptureView { captured in
            window = captured
            onWindow(captured)
            updateClosureConfirmation()
        }
        .frame(width: 0, height: 0)
        .onChange(of: sessionCount) { _, _ in openRequested() }
        // Keyed on WHICH session is running, so switching between two running
        // chats re-targets "stop and close" too.
        .onChange(of: isRunning ? sessionId : nil) { _, _ in updateClosureConfirmation() }
        .onContinueUserActivity(SessionWindow.activityType) { activity in
            requestedSessionId = SessionWindow.sessionId(from: activity)
            openRequested()
        }
    }

    /// Sessions load asynchronously; a request waits for the list.
    private func openRequested() {
        guard let id = requestedSessionId, sessionCount > 0 else { return }
        requestedSessionId = nil
        _ = open(id)
    }

    private func updateClosureConfirmation() {
        guard #available(iOS 27, *), let scene = window?.windowScene else { return }
        guard isRunning, let sid = sessionId else {
            scene.closureConfirmation = nil
            return
        }
        let stop = UIAlertAction(title: String(localized: "停止任务并关闭"), style: .default) { _ in
            ViewModelCache.shared.get(for: sid)?.cancel()
        }
        scene.closureConfirmation = UISceneClosureConfirmation(
            title: String(localized: "这个窗口的任务还在运行"),
            message: String(localized: "直接关闭，任务会在后台继续跑完并通知你；也可以先停止它。"),
            actions: [stop])
    }
}
