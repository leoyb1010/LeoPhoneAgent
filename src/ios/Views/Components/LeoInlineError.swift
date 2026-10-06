import SwiftUI
import UIKit

/// [F3] The app's one inline error: what went wrong in plain words, an
/// optional 重试 and an optional close. Long-press copies the message.
/// Used by the chat's error banner and any page that shows a failed load in
/// place (rather than a modal alert).
struct LeoInlineError: View {
    let message: String
    var retryTitle: String = "重试"
    var retryDisabled = false
    var onRetry: (() -> Void)?
    var onDismiss: (() -> Void)?
    /// Banner: full-width strip with no rounded card (top of a screen).
    var style: Style = .card

    enum Style { case card, banner }

    var body: some View {
        HStack(alignment: .center, spacing: LeoTheme.Spacing.xs) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.footnote.weight(.semibold))
                .foregroundStyle(LeoTheme.ColorToken.destructive)
                .accessibilityHidden(true)
            Text(message)
                .font(.footnote)
                .foregroundStyle(LeoTheme.ColorToken.primaryText)
                .lineLimit(3)
                .frame(maxWidth: .infinity, alignment: .leading)
            if let onRetry {
                Button(action: onRetry) {
                    Label(retryTitle, systemImage: "arrow.clockwise")
                        .labelStyle(.titleAndIcon)
                        .font(.footnote.weight(.semibold))
                        .frame(minHeight: LeoTheme.TouchTarget.minimum)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.borderless)
                .disabled(retryDisabled)
            }
            if let onDismiss {
                Button(action: onDismiss) {
                    Image(systemName: "xmark")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(LeoTheme.ColorToken.secondaryText)
                        .frame(width: LeoTheme.TouchTarget.minimum, height: LeoTheme.TouchTarget.minimum)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(Text("关闭提示"))
            }
        }
        .padding(.leading, LeoTheme.Spacing.sm)
        .padding(.trailing, onDismiss == nil ? LeoTheme.Spacing.sm : 0)
        .background(background)
        .contentShape(Rectangle())
        .onLongPressGesture {
            UIPasteboard.general.string = message
            LeoHaptics.notification(.success)
        }
    }

    @ViewBuilder private var background: some View {
        switch style {
        case .card:
            RoundedRectangle(cornerRadius: LeoTheme.Radius.field, style: .continuous)
                .fill(LeoTheme.ColorToken.destructive.opacity(0.10))
        case .banner:
            Rectangle().fill(LeoTheme.ColorToken.destructive.opacity(0.10))
        }
    }
}
