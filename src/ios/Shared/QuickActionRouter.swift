//
//  QuickActionRouter.swift
//  MinisApp
//
//  Home-screen Quick Actions (long-press app icon → "New Chat",
//  "Chat with Voice", "Chat with Camera").
//
//  Two responsibilities:
//   1. Register the three `UIApplicationShortcutItem`s once at app
//      launch (dynamic registration so they can be added / removed
//      without touching Info.plist).
//   2. Receive `UIApplicationShortcutItem` events from the AppDelegate
//      (both cold-launch via launchOptions and warm tap via
//      `application(_:performActionFor:completionHandler:)`) and route
//      them to the rest of the app:
//        - All three open a new chat session by posting
//          `.newChatRequested` (the existing ContentView observer).
//        - Voice + Camera also stash a pending `ChatLaunchAction` that
//          `AIChatView.onAppear` consumes once to start speech /
//          present the camera sheet.
//

import Foundation
import UIKit

private let logger = AppLogger(category: "QuickAction")

/// One-shot action consumed by `AIChatView` when a new chat opens from
/// a Home Screen shortcut.
enum ChatLaunchAction: Equatable {
    case startVoice
    case openCamera
    case prefillQuickTask(id: String)
    /// Opens a fresh, device-local conversation with the Home prompt ready
    /// in the composer. Sending remains explicit so the user can still add a
    /// file, change the model, or edit the request before the Agent runs it.
    case prefillPrompt(String)
}

@MainActor
final class QuickActionRouter: ObservableObject {
    static let shared = QuickActionRouter()

    /// Monotonically incremented whenever a shortcut requests a new
    /// chat. ContentView observes this so it can react to cold-launch
    /// shortcuts where `.newChatRequested` may post before the
    /// `.onReceive` subscription is attached. Notifications + this
    /// counter form a belt-and-braces wakeup path.
    @Published private(set) var newChatTrigger: Int = 0

    private init() {}

    // MARK: - Shortcut item types (also referenced from AppDelegate)

    enum ShortcutType {
        static let newChat = "com.leoyuan.leophoneagent.newChat"
        static let voiceChat = "com.leoyuan.leophoneagent.voiceChat"
        static let cameraChat = "com.leoyuan.leophoneagent.cameraChat"
    }

    /// Install the dynamic shortcut items on the running app. Idempotent —
    /// can be called multiple times without growing the list. We always
    /// overwrite so removing / re-ordering only requires editing one
    /// place.
    static func registerShortcutItems() {
        let items: [UIApplicationShortcutItem] = [
            UIApplicationShortcutItem(
                type: ShortcutType.newChat,
                localizedTitle: String(localized: "shortcut.newChat.title"),
                localizedSubtitle: nil,
                icon: UIApplicationShortcutIcon(systemImageName: "bubble.left.and.bubble.right"),
                userInfo: nil
            ),
            UIApplicationShortcutItem(
                type: ShortcutType.voiceChat,
                localizedTitle: String(localized: "shortcut.voiceChat.title"),
                localizedSubtitle: nil,
                icon: UIApplicationShortcutIcon(systemImageName: "mic.fill"),
                userInfo: nil
            ),
            UIApplicationShortcutItem(
                type: ShortcutType.cameraChat,
                localizedTitle: String(localized: "shortcut.cameraChat.title"),
                localizedSubtitle: nil,
                icon: UIApplicationShortcutIcon(systemImageName: "camera.fill"),
                userInfo: nil
            ),
        ]
        UIApplication.shared.shortcutItems = items
        logger.info("registerShortcutItems installed=\(items.count)")
    }

    /// Entry point called by `AppDelegate` for both cold-launch
    /// shortcut items (via launchOptions) and warm taps. Returns true
    /// when the shortcut type was recognized, so the system can mark
    /// the request as handled.
    @discardableResult
    func handle(_ shortcutItem: UIApplicationShortcutItem) -> Bool {
        logger.info("handle shortcut type=\(shortcutItem.type)")
        switch shortcutItem.type {
        case ShortcutType.newChat:
            QuickActionWorkflow.shared.reset(reason: "newChat shortcut — no follow-up action")
            postNewChat()
            return true
        case ShortcutType.voiceChat:
            QuickActionWorkflow.shared.start(.startVoice)
            postNewChat()
            return true
        case ShortcutType.cameraChat:
            QuickActionWorkflow.shared.start(.openCamera)
            postNewChat()
            return true
        default:
            logger.warning("unknown shortcut type: \(shortcutItem.type)")
            return false
        }
    }

    /// Shared foreground entry used by the Home Screen widget and deep links.
    /// Recording starts in the app so iOS can present permissions and a clear
    /// recording state instead of attempting microphone work in an extension.
    func startVoiceChat() {
        logger.info("startVoiceChat from deep link")
        QuickActionWorkflow.shared.start(.startVoice)
        postNewChat()
    }

    /// [T-widget-quick-tasks] `leophoneagent://new` — plain new chat from a
    /// Home Screen widget. Mirrors the newChat Home Screen shortcut path.
    func startNewChat() {
        logger.info("startNewChat from deep link")
        QuickActionWorkflow.shared.reset(reason: "newChat deep link — no follow-up action")
        postNewChat()
    }

    /// [T-widget-quick-tasks] `leophoneagent://quick-task/<id>` — open a new
    /// chat with the quick task's prompt prefilled (same workflow the
    /// voice/camera shortcuts use).
    func startQuickTask(id: String) {
        logger.info("startQuickTask from deep link id=\(id)")
        QuickActionWorkflow.shared.start(.prefillQuickTask(id: id))
        postNewChat()
    }

    private func postNewChat() {
        // Bump the @Published counter — ContentView's `.onChange(of:
        // newChatTrigger)` + `.onAppear` belt-and-braces drives the
        // session creation. Do NOT also post `.newChatRequested`: that
        // legacy notification is consumed by a separate observer in
        // ContentView, so posting both makes `handleNewChatRequest`
        // run twice with two different fresh session ids — the
        // workflow's attached target then doesn't match the AIChatView
        // that actually ends up visible.
        newChatTrigger &+= 1
        logger.info("postNewChat trigger=\(newChatTrigger)")
    }
}
