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
}

/// Single entry point for user-action feedback. Keep calls in View/UI code so
/// model and background execution remain deterministic and testable.
@MainActor
enum LeoHaptics {
    static func impact(_ style: UIImpactFeedbackGenerator.FeedbackStyle = .light) {
        let generator = UIImpactFeedbackGenerator(style: style)
        generator.prepare()
        generator.impactOccurred()
    }

    static func selection() {
        let generator = UISelectionFeedbackGenerator()
        generator.prepare()
        generator.selectionChanged()
    }

    static func notification(_ type: UINotificationFeedbackGenerator.FeedbackType) {
        let generator = UINotificationFeedbackGenerator()
        generator.prepare()
        generator.notificationOccurred(type)
    }
}
