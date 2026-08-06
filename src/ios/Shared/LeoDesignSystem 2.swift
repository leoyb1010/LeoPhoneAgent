import SwiftUI
import UIKit

/// Semantic design tokens for LeoPhoneAgent's native iOS surfaces.
///
/// The system intentionally relies on dynamic UIKit colors so light/dark mode,
/// increased contrast, and future platform appearance changes remain native.
enum LeoTheme {
    enum ColorToken {
        static let background = Color(uiColor: .systemBackground)
        static let groupedBackground = Color(uiColor: .systemGroupedBackground)
        static let surface = Color(uiColor: .secondarySystemBackground)
        static let elevatedSurface = Color(uiColor: .tertiarySystemBackground)
        static let primaryText = Color(uiColor: .label)
        static let secondaryText = Color(uiColor: .secondaryLabel)
        static let tertiaryText = Color(uiColor: .tertiaryLabel)
        static let separator = Color(uiColor: .separator)
        static let accent = Color.accentColor
        static let destructive = Color(uiColor: .systemRed)
        static let success = Color(uiColor: .systemGreen)
        static let warning = Color(uiColor: .systemOrange)
    }

    enum Spacing {
        static let xxs: CGFloat = 4
        static let xs: CGFloat = 8
        static let sm: CGFloat = 12
        static let md: CGFloat = 16
        static let lg: CGFloat = 24
        static let xl: CGFloat = 32
    }

    /// Shape rule: fields 12pt, content surfaces 16pt, message bubbles 18pt,
    /// and circular/pill controls use Capsule or Circle explicitly.
    enum Radius {
        static let field: CGFloat = 12
        static let surface: CGFloat = 16
        static let bubble: CGFloat = 18
    }

    enum TouchTarget {
        static let minimum: CGFloat = 44
    }
}

/// Motion values are derived from the existing app before visual tuning.
/// This keeps the first migration mechanically equivalent and preserves the
/// Composer height-correction timing assumptions tied to the 0.28s panel time.
enum LeoMotion {
    static let quick: Double = 0.12
    static let standard: Double = 0.20
    static let panel: Double = 0.28
    static let emphasis: Double = 0.35
    static let springResponse: Double = 0.30

    static func standardEase(reduceMotion: Bool) -> Animation? {
        reduceMotion ? nil : .easeInOut(duration: standard)
    }

    static func panelEase(reduceMotion: Bool) -> Animation? {
        reduceMotion ? nil : .easeInOut(duration: panel)
    }

    static func spring(reduceMotion: Bool, dampingFraction: Double = 0.82) -> Animation? {
        reduceMotion ? nil : .spring(response: springResponse, dampingFraction: dampingFraction)
    }

    /// [T-modern-motion-curves] `.snappy` for a control responding to a direct
    /// tap: same family as the system's own controls, so app motion and system
    /// motion stop disagreeing. Drop-in for the `.easeInOut(duration: 0.2)`
    /// this app used everywhere.
    static func snappy(reduceMotion: Bool) -> Animation? {
        reduceMotion ? nil : .snappy(duration: standard)
    }

    /// `.smooth` for content settling into place (list reflow, panel resize) —
    /// no overshoot, which matters when text is reflowing under the animation.
    static func smooth(reduceMotion: Bool, duration: Double = panel) -> Animation? {
        reduceMotion ? nil : .smooth(duration: duration)
    }
}

/// [T-liquid-glass-adoption] Liquid Glass surfaces.
///
/// The app had been paying the *cost* of Liquid Glass for a while — hard-coded
/// nav-bar band heights, iOS 26 spacing compensations, a pile of "why is this
/// clipped" comments — without using a single `glassEffect`, so it got the
/// layout churn and none of the look. Every custom surface was hand-drawn with
/// `Capsule()` / `RoundedRectangle` + `.plain` button style, which the system
/// pass cannot restyle.
///
/// These wrappers keep the adoption in one place: call sites say what a surface
/// *is*, not how it is drawn, so the visual language can move again later
/// without touching them.
enum LeoGlass {
}

extension View {
    /// A floating panel: toolbars, inline banners, the composer's accessory row.
    func leoGlassSurface(cornerRadius: CGFloat = LeoTheme.Radius.surface) -> some View {
        glassEffect(.regular, in: .rect(cornerRadius: cornerRadius))
    }


    /// An interactive glass surface that reacts to touch. Use for things the
}

/// Single entry point for user-action feedback. Keep calls in View/UI code so
/// model and background execution remain deterministic and testable.
@MainActor
enum LeoHaptics {
    /// [T-haptic-semantics] The agent's own state changes, as a small vocabulary
    /// the whole app shares.
    ///
    /// Before this there were five bare `UIFeedbackGenerator` calls scattered
    /// around and no notion of "a task finished" versus "a task needs you" — so
    /// the most useful moments in a background-agent app, the ones the user
    /// feels without looking, produced nothing at all.
    enum AgentEvent {
        case taskStarted
        case taskCompleted
        case taskFailed
        /// The run stopped and cannot continue without the user (permission
        /// prompt, confirmation, browser takeover).
    }

    static func agent(_ event: AgentEvent) {
        switch event {
        case .taskStarted: impact(.light)
        case .taskCompleted: notification(.success)
        case .taskFailed: notification(.error)
        }
    }

    static let enabledDefaultsKey = "leo.hapticsEnabled"

    private static var isEnabled: Bool {
        (UserDefaults.standard.object(forKey: enabledDefaultsKey) as? Bool) ?? true
    }

    static func impact(_ style: UIImpactFeedbackGenerator.FeedbackStyle = .light) {
        guard isEnabled else { return }
        let generator = UIImpactFeedbackGenerator(style: style)
        generator.prepare()
        generator.impactOccurred()
    }

    static func selection() {
        guard isEnabled else { return }
        let generator = UISelectionFeedbackGenerator()
        generator.prepare()
        generator.selectionChanged()
    }

    static func notification(_ type: UINotificationFeedbackGenerator.FeedbackType) {
        guard isEnabled else { return }
        let generator = UINotificationFeedbackGenerator()
        generator.prepare()
        generator.notificationOccurred(type)
    }
}
