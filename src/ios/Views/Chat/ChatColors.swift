import SwiftUI

/// [F1] Compatibility layer only: every value forwards to `LeoTheme`, so the
/// chat and the rest of the app share one palette. New code reads
/// `LeoTheme.ColorToken` directly and must not add entries here.
enum ChatColors {
    static let background = LeoTheme.ColorToken.background
    static let secondaryBg = LeoTheme.ColorToken.surface
    static let inputIconBg = LeoTheme.ColorToken.surface
    static let inputIconBorder = Color(UIColor { $0.userInterfaceStyle == .dark ? UIColor(white: 0.35, alpha: 1) : UIColor(white: 0, alpha: 0) })
    static let inputBg = Color(UIColor { $0.userInterfaceStyle == .dark ? UIColor(white: 0.12, alpha: 1) : .white })
    static let inputBorder = LeoTheme.ColorToken.separator
    static let primaryText = LeoTheme.ColorToken.primaryText
    static let secondaryText = LeoTheme.ColorToken.secondaryText
    static let tertiaryText = LeoTheme.ColorToken.tertiaryText
    static let userBubble = Color(UIColor.tertiarySystemFill)
    static let toolBg = Color(UIColor.tertiarySystemGroupedBackground)
    static let toolBorder = LeoTheme.ColorToken.separator.opacity(0.5)
    /// 高亮用强调蓝；白字填充按钮用深一点的同系蓝。
    static let accent = LeoTheme.ColorToken.accent
    static let sendButton = LeoTheme.ColorToken.primaryButton
    static let sendButtonDisabled = Color(UIColor.quaternaryLabel)
}
