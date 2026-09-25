//
//  LeoWatchIntents.swift
//  LeoWatch
//
//  [T-watch-action-button] App Intents exposed by the WATCH app itself, so
//  the Ultra's Action Button (and Siri on the wrist) can trigger us.
//

import AppIntents
import Foundation

struct AskLeoIntent: AppIntent {
    static let pendingKey = "leo.watch.pendingVoiceAsk"
    static let requested = Notification.Name("leo.watch.askRequested")

    static var title: LocalizedStringResource = "问 Leo"
    static var description = IntentDescription("打开 LeoPhoneAgent 并开始语音提问。")
    static var openAppWhenRun = true

    @MainActor
    func perform() async throws -> some IntentResult {
        // The flag covers a cold launch; the post covers an app already in front.
        UserDefaults.standard.set(true, forKey: Self.pendingKey)
        NotificationCenter.default.post(name: Self.requested, object: nil)
        return .result()
    }
}

struct LeoWatchShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: AskLeoIntent(),
            phrases: ["用 \(.applicationName) 提问", "让 \(.applicationName) 帮我"],
            shortTitle: "问 Leo",
            systemImageName: "mic.fill"
        )
    }
}
