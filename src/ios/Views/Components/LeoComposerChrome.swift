import SwiftUI

// [F2] One composer shell for home, chat and Paperclip.
//
// Each composer keeps its own content slot (home: execution target + model,
// chat: model capsule + tools, Paperclip: agent picker); only the outside is
// shared: the 26pt continuous corner, the regular glass (no extra shadow —
// glass already separates itself from the content scrolling under it) and the
// 36pt round controls inside a 44pt hit target.
//
// Depends on nothing but SwiftUI and LeoDesignSystem, so the standalone
// Paperclip audit host (scripts/native-paperclip-audit) compiles it too.

enum LeoComposerMetrics {
    /// Visible diameter of the round send / mic / plus controls.
    static let control: CGFloat = 36
    /// Hit target around each control.
    static let hitTarget: CGFloat = LeoTheme.TouchTarget.minimum
    static let horizontalPadding: CGFloat = 12
    static let verticalPadding: CGFloat = 10
    /// Gap between the shell and the screen edge.
    static let outerPadding: CGFloat = 12
}

extension View {
    /// The shared composer surface. Apply to the composer's content stack
    /// after its inner padding.
    func leoComposerChrome() -> some View {
        glassEffect(.regular, in: .rect(cornerRadius: LeoTheme.Radius.composer, style: .continuous))
    }
}

/// The round send button every composer uses: teal when it can send, a quiet
/// grey disc otherwise; a spinner while `busy`.
struct LeoComposerSendButton: View {
    let canSend: Bool
    var busy = false
    var systemImage = "arrow.up"
    let label: Text
    var identifier: String = "composer.send"
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            ZStack {
                Circle().fill(canSend ? LeoTheme.ColorToken.accent : Color.primary.opacity(0.12))
                if busy {
                    ProgressView().controlSize(.small).tint(.white)
                } else {
                    Image(systemName: systemImage)
                        .font(.system(size: 15, weight: .bold))
                        .foregroundStyle(canSend ? Color.white : Color.secondary)
                }
            }
            .frame(width: LeoComposerMetrics.control, height: LeoComposerMetrics.control)
            .frame(width: LeoComposerMetrics.hitTarget, height: LeoComposerMetrics.hitTarget)
            .contentShape(Rectangle())
        }
        .buttonStyle(LeoSquishButtonStyle())
        .disabled(!canSend)
        .accessibilityLabel(label)
        .accessibilityIdentifier(identifier)
    }
}
