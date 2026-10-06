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
}

/// The chat in the window you're using, published by ChatDetailContainer.
/// `AIChatViewModel.activeSessionId` is the last chat opened in ANY window.
struct ChatWindowTarget {
    let sessionId: String?
    let inspectorVisible: Binding<Bool>
}

extension FocusedValues {
    @Entry var chatWindow: ChatWindowTarget?
}

struct LeoCommands: Commands {
    @FocusedValue(\.chatWindow) private var chatWindow

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
                ChatCommandTarget.stopRun(sessionId: chatWindow?.sessionId)
            } label: {
                Label("停止当前任务", systemImage: "stop.circle")
            }
            .keyboardShortcut(".", modifiers: .command)
            Button {
                withAnimation(LeoMotion.standardEase(reduceMotion: UIAccessibility.isReduceMotionEnabled)) {
                    chatWindow?.inspectorVisible.wrappedValue.toggle()
                }
            } label: {
                Label("显示或隐藏检查器", systemImage: "sidebar.right")
            }
            .keyboardShortcut("i", modifiers: [.command, .option])
            .disabled(chatWindow == nil)
        }
        SidebarCommands()
    }
}

/// ⌘. stops the chat in the window you're using; a narrow window has no
/// inspector container, so it falls back to the last chat opened.
@MainActor
enum ChatCommandTarget {
    static func stopRun(sessionId: String?) {
        guard let sid = sessionId ?? AIChatViewModel.activeSessionId,
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
    static let activityType = SessionHandoff.activityType

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

    /// The app's own scene delegate keeps activities from SwiftUI's
    /// `.onContinueUserActivity` (same as URLs, see SceneDelegate), so it hands
    /// a window's session over here, keyed by that window's scene session.
    @MainActor private static var requests: [String: String] = [:]
    static let requestPosted = Notification.Name("leo.sessionWindowRequest")

    /// Called by SceneDelegate for new and existing windows. False when the
    /// activity isn't a session window.
    @MainActor
    static func accept(_ activity: NSUserActivity, in scene: UIScene) -> Bool {
        guard activity.activityType == activityType, let id = sessionId(from: activity) else { return false }
        requests[scene.session.persistentIdentifier] = id
        NotificationCenter.default.post(name: requestPosted, object: scene)
        return true
    }

    @MainActor
    static func takeRequest(for scene: UIScene?) -> String? {
        guard let key = scene?.session.persistentIdentifier else { return nil }
        return requests.removeValue(forKey: key)
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
    /// The session on screen (a draft's own id until it has a real one); nil on home.
    let sessionId: String?
    let sessionCount: Int
    let onWindow: (UIWindow) -> Void
    /// Shows the session in this window; false when it doesn't exist (yet).
    let open: (String) -> Bool
    /// [E7] true while a request (Handoff from another device) waits for its session to sync in.
    var onWaitingChange: (Bool) -> Void = { _ in }

    /// A new-window request that arrived before the session list loaded.
    @State private var requestedSessionId: String?
    @State private var window: UIWindow?
    @ObservedObject private var activity = SessionActivityTracker.shared

    /// The run this window would stop. A new chat's run is tracked under its
    /// real id, which a narrow window never gets handed.
    private var runningId: String? {
        guard let sid = sessionId else { return nil }
        let real = activity.draftAliases[sid] ?? sid
        return activity.activeSessions.contains(real) ? real : nil
    }

    var body: some View {
        WindowCaptureView { captured in
            window = captured
            onWindow(captured)
            updateClosureConfirmation()
            takeRequest()   // a new window's request arrives before its views exist
        }
        .frame(width: 0, height: 0)
        // 下一轮再试:ContentView 的 id→会话缓存在同一轮的另一个 onChange 里才重建,
        // 先于它判断会把刚同步到的会话当成"还没到"(E7 接力会一直等到超时)。
        .onChange(of: sessionCount) { _, _ in DispatchQueue.main.async { openRequested() } }
        // Keyed on WHICH session is running, so switching between two running
        // chats re-targets "stop and close" too.
        .onChange(of: runningId) { _, _ in updateClosureConfirmation() }
        .onReceive(NotificationCenter.default.publisher(for: SessionWindow.requestPosted)) { note in
            guard let scene = note.object as? UIScene, scene === window?.windowScene else { return }
            takeRequest()
        }
    }

    private func takeRequest() {
        guard let id = SessionWindow.takeRequest(for: window?.windowScene) else { return }
        requestedSessionId = id
        openRequested()
    }

    /// Sessions load asynchronously; a request waits for the list (and for the
    /// session itself, when it isn't in the list yet).
    private func openRequested() {
        guard let id = requestedSessionId else { return }
        guard sessionCount > 0, open(id) else {
            // 列表还没加载(冷启动的新窗口请求)不算等同步,不闪"正在同步"。
            if sessionCount > 0 { onWaitingChange(true) }
            // 同步迟迟不到(另一台设备没开 iCloud、会话已删):一分钟后放弃,不让提示一直挂着。
            DispatchQueue.main.asyncAfter(deadline: .now() + 60) {
                guard requestedSessionId == id else { return }
                requestedSessionId = nil
                onWaitingChange(false)
            }
            return
        }
        requestedSessionId = nil
        onWaitingChange(false)
    }

    private func updateClosureConfirmation() {
        guard #available(iOS 27, *), let scene = window?.windowScene else { return }
        guard let sid = runningId else {
            scene.closureConfirmation = nil
            return
        }
        let onScreen = sessionId
        let stop = UIAlertAction(title: String(localized: "停止任务并关闭"), style: .default) { _ in
            (ViewModelCache.shared.get(for: sid) ?? onScreen.flatMap { ViewModelCache.shared.get(for: $0) })?.cancel()
        }
        scene.closureConfirmation = UISceneClosureConfirmation(
            title: String(localized: "这个窗口的任务还在运行"),
            message: String(localized: "直接关闭，任务会在后台继续跑完并通知你；也可以先停止它。"),
            actions: [stop])
    }
}
