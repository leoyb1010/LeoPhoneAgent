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
    static var title: LocalizedStringResource = "问 Leo"
    static var description = IntentDescription("打开 LeoPhoneAgent 并开始语音提问。")
    static var openAppWhenRun = true

    @MainActor
    func perform() async throws -> some IntentResult {
        // The root view observes this flag and launches dictation on appear.
        UserDefaults.standard.set(true, forKey: "leo.watch.pendingVoiceAsk")
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
