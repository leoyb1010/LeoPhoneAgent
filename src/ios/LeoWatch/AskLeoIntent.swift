//
//  AskLeoIntent.swift
//  LeoWatch + LeoWatchWidget
//
//  [T-watch-action-button] Opens the watch app and starts a voice question. [WP-44]
//  Split out of LeoWatchIntents.swift so the widget extension can offer it as the
//  "问 Leo" Control; `openAppWhenRun` makes the system run it in the app process.
//

import AppIntents
import Foundation

struct AskLeoIntent: AppIntent {
    static let pendingKey = "leo.watch.pendingVoiceAsk"
    static let requested = Notification.Name("leo.watch.askRequested")

    static var title: LocalizedStringResource = "问 Leo"
    static var description = IntentDescription("打开 LeoBot 并开始语音提问。")
    static var openAppWhenRun = true

    @MainActor
    func perform() async throws -> some IntentResult {
        // The flag covers a cold launch; the post covers an app already in front.
        UserDefaults.standard.set(true, forKey: Self.pendingKey)
        NotificationCenter.default.post(name: Self.requested, object: nil)
        return .result()
    }
}
