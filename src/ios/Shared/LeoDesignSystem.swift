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
        /// [F1] The one accent: teal, from the AccentColor asset (light #2A8282,
        /// dark #2E9C9C — white glyphs on it stay legible in both). `ChatColors`
        /// only forwards here; new code reads this token.
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
        /// [F2] Every composer (home, chat) — see `leoComposerChrome()`.
        static let composer: CGFloat = 26
    }

    enum TouchTarget {
        static let minimum: CGFloat = 44
    }

    /// [T-treasury-design] Long-form reading: comfortable leading and a capped
    /// measure so a paragraph never runs the full width of an iPad.
    enum Reading {
        static let maxWidth: CGFloat = 680
        static let lineSpacing: CGFloat = 6
    }

    /// One card anatomy for content lists (藏宝阁, 资料库): leading visual,
    /// title, source line, excerpt, meta row — all on the 8-pt rhythm.
    enum Card {
        /// Thumbnail / type tile in a list card.
        static let thumbnail: CGFloat = 56
        /// Type tile in a detail hero header.
        static let heroTile: CGFloat = 56
        /// Content inset inside the card surface.
        static let padding: CGFloat = Spacing.sm
        /// Gap between two cards.
        static let gap: CGFloat = Spacing.xs
        /// Vertical gap between the anatomy lines.
        static let lineGap: CGFloat = Spacing.xxs
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

    // [F4] Same tokens for call sites with no `accessibilityReduceMotion`
    // environment in reach (view models, UIKit-hosted views, helpers): they
    // read the system switch directly, so Reduce Motion still wins.
    @MainActor static var systemReduceMotion: Bool { UIAccessibility.isReduceMotionEnabled }

    @MainActor static func quickEase() -> Animation? { systemReduceMotion ? nil : .easeInOut(duration: quick) }
    @MainActor static func standardEase() -> Animation? { standardEase(reduceMotion: systemReduceMotion) }
    @MainActor static func emphasisEase() -> Animation? { systemReduceMotion ? nil : .easeInOut(duration: emphasis) }
    @MainActor static func panelEase() -> Animation? { panelEase(reduceMotion: systemReduceMotion) }
    @MainActor static func snappy() -> Animation? { snappy(reduceMotion: systemReduceMotion) }
    @MainActor static func spring(dampingFraction: Double = 0.82) -> Animation? {
        spring(reduceMotion: systemReduceMotion, dampingFraction: dampingFraction)
    }
}

/// Shared tactile press language for primary Agent actions. The control
/// compresses quickly under the finger and returns on the app's spring token;
/// Reduce Motion removes the scale entirely while preserving the tap target.
struct LeoSquishButtonStyle: ButtonStyle {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(reduceMotion ? 1 : (configuration.isPressed ? 0.94 : 1))
            .animation(
                reduceMotion
                    ? nil
                    : (configuration.isPressed
                       ? .easeOut(duration: 0.08)
                       : .spring(response: 0.36, dampingFraction: 0.68)),
                value: configuration.isPressed
            )
    }
}

extension View {
    /// A floating panel: toolbars, inline banners, the composer's accessory row.
    func leoGlassSurface(cornerRadius: CGFloat = LeoTheme.Radius.surface) -> some View {
        glassEffect(.regular, in: .rect(cornerRadius: cornerRadius))
    }


    /// [T-treasury-design] A content card as a List row: the surface lives in
    /// the row background (so swipe actions and selection keep working) and the
    /// content sits `Card.padding` inside it. `inset` is the card's distance
    /// from the container edge — 16 on phones, wider on large containers so
    /// the column stays centered (see `TreasuryGridLayout`).
    func leoListCardRow(inset: CGFloat = LeoTheme.Spacing.md) -> some View {
        let half = LeoTheme.Card.gap / 2
        let pad = LeoTheme.Card.padding
        return listRowInsets(EdgeInsets(top: half + pad, leading: inset + pad,
                                        bottom: half + pad, trailing: inset + pad))
            .listRowSeparator(.hidden)
            .listRowBackground(
                RoundedRectangle(cornerRadius: LeoTheme.Radius.surface, style: .continuous)
                    .fill(LeoTheme.ColorToken.surface)
                    .padding(.horizontal, inset)
                    .padding(.vertical, half)
            )
    }

    /// A plain List row aligned to the same column as `leoListCardRow`.
    func leoListPlainRow(inset: CGFloat = LeoTheme.Spacing.md,
                         top: CGFloat = LeoTheme.Spacing.xxs,
                         bottom: CGFloat = LeoTheme.Spacing.xxs) -> some View {
        listRowInsets(EdgeInsets(top: top, leading: inset, bottom: bottom, trailing: inset))
            .listRowSeparator(.hidden)
            .listRowBackground(Color.clear)
    }

    /// Pointer hover on iPad: a soft highlight shaped like the card.
    func leoCardHover(cornerRadius: CGFloat = LeoTheme.Radius.surface) -> some View {
        contentShape(.hoverEffect, RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
            .hoverEffect(.highlight)
    }

    /// Long-form text: reading leading and a capped, centered measure.
    func leoReadingMeasure() -> some View {
        lineSpacing(LeoTheme.Reading.lineSpacing)
            .frame(maxWidth: LeoTheme.Reading.maxWidth, alignment: .leading)
            .frame(maxWidth: .infinity, alignment: .center)
    }
}

/// [T-treasury-design] The one status/metadata capsule: privacy, offline,
/// source, version, locator. Tint fill is a touch stronger in Dark Mode so the
/// capsule doesn't vanish on a dark surface.
struct LeoCapsuleBadge: View {
    let text: String
    var systemImage: String?
    var tint: Color = LeoTheme.ColorToken.secondaryText
    /// Monospaced digits for version / size chips.
    var monospaced = false
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        HStack(spacing: 3) {
            if let systemImage {
                Image(systemName: systemImage)
                    .imageScale(.small)
                    .accessibilityHidden(true)
            }
            Text(verbatim: text)
                .lineLimit(1)
                .monospacedDigit()
                .fontDesign(monospaced ? .monospaced : .default)
        }
        .font(.caption2.weight(.semibold))
        .foregroundStyle(tint)
        .padding(.horizontal, LeoTheme.Spacing.xs - 1)
        .padding(.vertical, 3)
        .background(tint.opacity(colorScheme == .dark ? 0.20 : 0.12), in: Capsule())
        .overlay(Capsule().strokeBorder(tint.opacity(colorScheme == .dark ? 0.28 : 0.16), lineWidth: 0.5))
    }
}

/// [T-treasury-design] The leading type tile of a card or a detail hero.
struct LeoIconTile: View {
    let systemImage: String
    var tint: Color = LeoTheme.ColorToken.accent
    var size: CGFloat = LeoTheme.Card.thumbnail
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        Image(systemName: systemImage)
            .font(.system(size: size * 0.4, weight: .medium))
            .foregroundStyle(tint)
            .frame(width: size, height: size)
            .background(tint.opacity(colorScheme == .dark ? 0.22 : 0.12),
                        in: RoundedRectangle(cornerRadius: size * 0.24, style: .continuous))
            .accessibilityHidden(true)
    }
}

/// [T-treasury-design] Section header for content lists: small caps-weight
/// title, optional count, aligned to the card column.
struct LeoSectionHeader: View {
    let title: String
    var count: Int?
    var systemImage: String?

    var body: some View {
        HStack(spacing: LeoTheme.Spacing.xs - 2) {
            if let systemImage {
                Image(systemName: systemImage).imageScale(.small).accessibilityHidden(true)
            }
            Text(verbatim: title)
            if let count {
                Text(verbatim: "\(count)")
                    .monospacedDigit()
                    .foregroundStyle(LeoTheme.ColorToken.tertiaryText)
            }
            Spacer(minLength: 0)
        }
        .font(.footnote.weight(.semibold))
        .foregroundStyle(LeoTheme.ColorToken.secondaryText)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
    }
}

/// [T-treasury-design] Wrapping row for chips and meta lines: at large
/// Dynamic Type sizes the chips flow onto a second line instead of clipping.
struct LeoFlowLayout: Layout {
    var spacing: CGFloat = LeoTheme.Spacing.xs - 2
    var lineSpacing: CGFloat = LeoTheme.Spacing.xxs

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let rows = arrange(width: proposal.width ?? .infinity, subviews: subviews)
        let width = rows.map(\.width).max() ?? 0
        let height = rows.map(\.height).reduce(0, +) + lineSpacing * CGFloat(max(0, rows.count - 1))
        return CGSize(width: proposal.width.map { min($0, width) } ?? width, height: height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var y = bounds.minY
        for row in arrange(width: bounds.width, subviews: subviews) {
            var x = bounds.minX
            for index in row.indices {
                let size = subviews[index].sizeThatFits(.init(width: bounds.width, height: nil))
                subviews[index].place(at: CGPoint(x: x, y: y + (row.height - size.height) / 2),
                                      proposal: .init(width: min(size.width, bounds.width), height: size.height))
                x += size.width + spacing
            }
            y += row.height + lineSpacing
        }
    }

    private struct Row { var indices: [Int] = []; var width: CGFloat = 0; var height: CGFloat = 0 }

    private func arrange(width: CGFloat, subviews: Subviews) -> [Row] {
        var rows: [Row] = []
        var current = Row()
        for index in subviews.indices {
            let size = subviews[index].sizeThatFits(.init(width: width.isFinite ? width : nil, height: nil))
            let needed = current.indices.isEmpty ? size.width : current.width + spacing + size.width
            if !current.indices.isEmpty && needed > width {
                rows.append(current)
                current = Row()
            }
            current.width = current.indices.isEmpty ? min(size.width, width) : current.width + spacing + size.width
            current.height = max(current.height, size.height)
            current.indices.append(index)
        }
        if !current.indices.isEmpty { rows.append(current) }
        return rows
    }
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

    /// [T-treasury-design] Content actions worth feeling: the user did
    /// something to their data and should know it landed. Browsing, scrolling
    /// and opening stay silent.
    enum ContentAction {
        case saved
        case archived
        case deleted
        case copied
    }

    static func content(_ action: ContentAction) {
        switch action {
        case .saved: notification(.success)
        case .archived: impact(.soft)
        case .deleted: impact(.rigid)
        case .copied: selection()
        }
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
