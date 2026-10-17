//
//  LeoWatchIntents.swift
//  LeoWatch
//
//  [T-watch-action-button] App Intents exposed by the WATCH app itself, so
//  the Ultra's Action Button (and Siri on the wrist) can trigger us.
//

import AppIntents
import Foundation

// AskLeoIntent lives in AskLeoIntent.swift (shared with the LeoWatchWidget extension
// for the "问 Leo" control).

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
