import SwiftUI

/// [F3] The app's one empty state: a quiet symbol, a one-line Chinese title,
/// an optional hint and at most one primary action. Works as a List row (it
/// hides its own separator and background) or as a plain view.
///
/// Rule: say what is missing and how to fill it; the page's own "+" or
/// toolbar stays the main entry, so `action` is only for a shortcut the page
/// doesn't already show.
struct LeoEmptyState: View {
    let systemImage: String
    let title: String
    var message: String?
    var actionTitle: String?
    var actionSystemImage: String?
    var action: (() -> Void)?
    /// UI-test identifier for the action button.
    var actionIdentifier: String?

    var body: some View {
        VStack(spacing: LeoTheme.Spacing.sm) {
            Image(systemName: systemImage)
                .font(.system(size: 30, weight: .regular))
                .foregroundStyle(LeoTheme.ColorToken.accent)
                .frame(width: 60, height: 60)
                .background(LeoTheme.ColorToken.accent.opacity(0.10), in: Circle())
                .accessibilityHidden(true)
            Text(title)
                .font(.headline)
                .foregroundStyle(LeoTheme.ColorToken.primaryText)
                .multilineTextAlignment(.center)
            if let message, !message.isEmpty {
                Text(message)
                    .font(.subheadline)
                    .foregroundStyle(LeoTheme.ColorToken.secondaryText)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let actionTitle, let action {
                // Custom capsule, not .borderedProminent: system button styles
                // render unreliably inside a clear-background List row.
                Button(action: action) {
                    Group {
                        if let actionSystemImage {
                            Label(actionTitle, systemImage: actionSystemImage)
                        } else {
                            Text(actionTitle)
                        }
                    }
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.white)
                    .padding(.horizontal, LeoTheme.Spacing.md)
                    .frame(minHeight: LeoTheme.TouchTarget.minimum)
                    .background(LeoTheme.ColorToken.accent, in: Capsule())
                    .contentShape(Capsule())
                }
                .buttonStyle(LeoSquishButtonStyle())
                .accessibilityIdentifier(actionIdentifier ?? "")
                .padding(.top, LeoTheme.Spacing.xxs)
            }
        }
        .frame(maxWidth: 420)
        .frame(maxWidth: .infinity)
        .padding(.horizontal, LeoTheme.Spacing.lg)
        .padding(.vertical, LeoTheme.Spacing.xl)
        .accessibilityElement(children: .contain)
        .listRowSeparator(.hidden)
        .listRowBackground(Color.clear)
    }
}
