import SwiftUI

// [F2] One composer shell for home and chat.
//
// Each composer keeps its own content slot (home: execution target + model,
// chat: model capsule + tools); only the outside is
// shared: the 26pt continuous corner, the regular glass (no extra shadow —
// glass already separates itself from the content scrolling under it) and the
// 36pt round controls inside a 44pt hit target.
//
// Depends on nothing but SwiftUI and LeoDesignSystem.

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

    /// [WP-42] The composer shell inside a `GlassEffectContainer`: the id lets sibling glass
    /// (result banner, "Move to…" pill) emerge from / merge back into the shell instead of
    /// popping in as a separate pane.
    @ViewBuilder
    func leoComposerChrome(glassID: String, in namespace: Namespace.ID?) -> some View {
        if let namespace {
            leoComposerChrome().glassEffectID(glassID, in: namespace)
        } else {
            leoComposerChrome()
        }
    }

    /// [WP-42] Optional `glassEffectID` (no-op without a namespace).
    @ViewBuilder
    func leoGlassID(_ id: String, in namespace: Namespace.ID?) -> some View {
        if let namespace { glassEffectID(id, in: namespace) } else { self }
    }
}

enum LeoComposerGlass {
    /// Spacing at which neighbouring glass shapes start to blend (token-sized gap).
    static let containerSpacing: CGFloat = 12
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
                // [WP-42] Primary action = prominent glass tinted with the accent; disabled
                // stays a quiet grey disc (glass would read as tappable).
                if canSend {
                    Circle().fill(.clear)
                        .glassEffect(.regular.tint(LeoTheme.ColorToken.accent).interactive(), in: .circle)
                } else {
                    Circle().fill(Color.primary.opacity(0.12))
                }
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
