//
//  SiriReplyPrivacy.swift
//  MinisApp
//
//  [C11] Siri 朗读遵守「任务状态隐私」:设备锁着且隐私开启时,对话框只说
//  "做完了，打开 App 查看";解锁时,或车载 / 耳机这类只有声音的场景
//  (isVoiceOnly,本来就是说给你一个人听)照常朗读。
//  与通知正文的处理一致(SendPromptIntent.swift · ShortcutNotification.post)。
//

import Foundation

enum SiriReplyPrivacy {
    static let hiddenReply = "做完了，打开 App 查看。"

    /// 与通知、灵动岛共用同一个开关,默认开启。
    static var privacyModeEnabled: Bool {
        UserDefaults.standard.object(forKey: "liveActivityPrivacyMode") as? Bool ?? true
    }

    static func shouldHide(deviceLocked: Bool, privacyMode: Bool, voiceOnly: Bool) -> Bool {
        deviceLocked && privacyMode && !voiceOnly
    }

    static func dialogText(_ text: String, deviceLocked: Bool, privacyMode: Bool, voiceOnly: Bool) -> String {
        shouldHide(deviceLocked: deviceLocked, privacyMode: privacyMode, voiceOnly: voiceOnly) ? hiddenReply : text
    }
}

/// Which models the Shortcuts/Siri picker may OFFER. A disabled provider means
/// "stop using this account", so its models are not offered for new
/// automations; an id already picked still resolves (see ModelSelectionEntityQuery).
enum ShortcutModelOffer {
    static func isOfferable(isHidden: Bool, providerEnabled: Bool?) -> Bool {
        !isHidden && providerEnabled == true
    }
}
