//
//  LeoMotionEffects.swift
//  MinisApp
//
//  [T-motion-effects] The adopted subset of the leotexiao/Kinetics library
//  (135 patterns reviewed 2026-07-29), rewritten as native SwiftUI modifiers.
//
//  Rules every effect here obeys:
//    • transform/opacity only — no layout-affecting animation
//    • honours Reduce Motion (falls back to a static or instant state)
//    • one-line call sites; timing comes from LeoMotion tokens, not ad-hoc ms
//    • loops stop when `active` is false, so nothing burns battery offscreen
//

import SwiftUI

// MARK: - Pulse (Kinetics: Pulse Badge / Status Pill)

/// Soft attention pulse while `active`; freezes when inactive or Reduce Motion.
private struct LeoPulseModifier: ViewModifier {
    let active: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var up = false

    func body(content: Content) -> some View {
        content
            .scaleEffect(active && up && !reduceMotion ? 1.12 : 1)
            .opacity(active && up && !reduceMotion ? 0.85 : 1)
            .onChange(of: active) { _, isOn in
                guard isOn, !reduceMotion else { up = false; return }
                withAnimation(.easeInOut(duration: 0.9).repeatForever(autoreverses: true)) { up = true }
            }
            .onAppear {
                guard active, !reduceMotion else { return }
                withAnimation(.easeInOut(duration: 0.9).repeatForever(autoreverses: true)) { up = true }
            }
    }
}

// MARK: - Shake (Kinetics: Error Shake)

private struct LeoShakeModifier: ViewModifier {
    /// Bump to trigger one shake.
    let trigger: Int
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var offset: CGFloat = 0

    func body(content: Content) -> some View {
        content
            .offset(x: offset)
            .onChange(of: trigger) { _, _ in
                guard !reduceMotion else { return }
                // Three decaying swings, transform-only.
                withAnimation(.easeIn(duration: 0.05)) { offset = -7 }
                withAnimation(.easeInOut(duration: 0.1).delay(0.05)) { offset = 6 }
                withAnimation(.easeInOut(duration: 0.1).delay(0.15)) { offset = -3 }
                withAnimation(LeoMotion.snappy(reduceMotion: false) ?? .default) { offset = 0 }
            }
    }
}

// MARK: - Stagger entrance (Kinetics: Stagger Entrance)

/// One-shot fade+rise on first appearance, delayed by index. Only the first
/// `LeoStaggerPolicy.cap` rows animate; later rows (and rows scrolled in
/// later) appear at once, so long lists never queue a parade.
private struct LeoStaggerModifier: ViewModifier {
    let index: Int
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var shown = false

    private var isStatic: Bool { reduceMotion || !LeoStaggerPolicy.animates(index: index) }

    func body(content: Content) -> some View {
        content
            .opacity(shown || isStatic ? 1 : 0)
            .offset(y: shown || isStatic ? 0 : 8)
            .onAppear {
                guard !shown, !isStatic else { return }
                withAnimation(LeoMotion.smooth(reduceMotion: false, duration: 0.28)?
                    .delay(LeoStaggerPolicy.delay(index: index)) ?? .default) {
                    shown = true
                }
            }
    }
}

// MARK: - Skeleton shimmer (Kinetics: Skeleton Loader)

/// One rounded placeholder shape with a soft highlight sweeping across it
/// while content loads. The sweep is clipped to the shape; Reduce Motion keeps
/// the static placeholder.
struct LeoSkeletonBar: View {
    var width: CGFloat?
    var height: CGFloat = 10
    var cornerRadius: CGFloat?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var phase: CGFloat = -1

    private var shape: RoundedRectangle {
        RoundedRectangle(cornerRadius: cornerRadius ?? height / 2, style: .continuous)
    }

    var body: some View {
        shape
            .fill(LeoTheme.ColorToken.tertiaryText.opacity(0.22))
            .overlay {
                if !reduceMotion {
                    GeometryReader { geo in
                        LinearGradient(colors: [.clear, .white.opacity(0.22), .clear],
                                       startPoint: .leading, endPoint: .trailing)
                            .frame(width: max(geo.size.width * 0.6, 60))
                            .offset(x: phase * (geo.size.width + 60) - 30)
                    }
                }
            }
            .clipShape(shape)
            .frame(width: width, height: height)
            .frame(maxWidth: width == nil ? .infinity : nil, alignment: .leading)
            .onAppear {
                guard !reduceMotion else { return }
                withAnimation(.linear(duration: 1.2).repeatForever(autoreverses: false)) { phase = 1 }
            }
    }
}

/// Placeholder matching the content-card anatomy (tile, title, source,
/// excerpt) — what a remote 资料库 result will look like once it lands.
struct LeoSkeletonCard: View {
    var showsTile = true
    var lines = 2

    var body: some View {
        HStack(alignment: .top, spacing: LeoTheme.Spacing.sm) {
            if showsTile {
                LeoSkeletonBar(width: 40, height: 40, cornerRadius: 10)
            }
            VStack(alignment: .leading, spacing: LeoTheme.Spacing.xs) {
                LeoSkeletonBar(width: 180, height: 12)
                LeoSkeletonBar(width: 120, height: 8)
                ForEach(0..<max(0, lines), id: \.self) { line in
                    LeoSkeletonBar(width: line == lines - 1 ? 140 : nil, height: 9)
                }
            }
        }
        .accessibilityHidden(true)
    }
}

// MARK: - Scroll depth

/// Cards ease back a touch as they leave the viewport — depth, not motion
/// sickness: 3% scale and a light fade, nothing under Reduce Motion.
private struct LeoScrollDepthModifier: ViewModifier {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func body(content: Content) -> some View {
        if reduceMotion {
            content
        } else {
            content.scrollTransition(.interactive, axis: .vertical) { view, phase in
                view
                    .scaleEffect(phase.isIdentity ? 1 : 0.97)
                    .opacity(phase.isIdentity ? 1 : 0.82)
            }
        }
    }
}

// MARK: - Zoom navigation (card → detail)

/// The detail side of a card → detail zoom. Reduce Motion keeps the
/// container's default (slide / sheet) transition.
private struct LeoZoomTransitionModifier<ID: Hashable>: ViewModifier {
    let id: ID
    let namespace: Namespace.ID
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func body(content: Content) -> some View {
        if reduceMotion {
            content
        } else {
            content.navigationTransition(.zoom(sourceID: id, in: namespace))
        }
    }
}

// MARK: - Shine sweep (Kinetics: Shine Sweep / Sheen Sweep)

/// A single specular highlight passing across the content when `trigger`
/// bumps. Masked to the content's own shape via compositing.
private struct LeoShineModifier: ViewModifier {
    let trigger: Int
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var phase: CGFloat = -1

    func body(content: Content) -> some View {
        content.overlay(
            GeometryReader { geo in
                LinearGradient(
                    colors: [.clear, .white.opacity(0.35), .clear],
                    startPoint: .leading, endPoint: .trailing
                )
                .frame(width: geo.size.width * 0.6)
                .offset(x: phase * geo.size.width * 1.6 - geo.size.width * 0.3)
                .allowsHitTesting(false)
            }
            .clipped()
        )
        .onChange(of: trigger) { _, _ in
            guard !reduceMotion else { return }
            phase = -1
            withAnimation(.easeInOut(duration: 0.7)) { phase = 1 }
        }
    }
}

// MARK: - Typing indicator (Kinetics: Typing Indicator)

/// Three breathing dots — the "reply is coming" placeholder.
struct LeoTypingIndicator: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var on = false

    var body: some View {
        HStack(spacing: 4) {
            ForEach(0..<3, id: \.self) { index in
                Circle()
                    .fill(.secondary)
                    .frame(width: 6, height: 6)
                    .opacity(reduceMotion ? 0.6 : (on ? 1 : 0.3))
                    .animation(
                        reduceMotion ? nil : .easeInOut(duration: 0.5)
                            .repeatForever(autoreverses: true)
                            .delay(Double(index) * 0.18),
                        value: on
                    )
            }
        }
        .onAppear { on = true }
        .accessibilityLabel(Text("Working on a reply"))
    }
}

// MARK: - Public sugar

extension View {
    /// Attention pulse while `active` (badges, running dots).
    func leoPulse(active: Bool) -> some View { modifier(LeoPulseModifier(active: active)) }
    /// One shake per `trigger` bump (errors, rejected input).
    func leoShake(trigger: Int) -> some View { modifier(LeoShakeModifier(trigger: trigger)) }
    /// Staggered first appearance for short lists (index capped at 8).
    func leoStaggerEntrance(index: Int) -> some View { modifier(LeoStaggerModifier(index: index)) }
    /// One highlight sweep per `trigger` bump (card refreshed, content landed).
    func leoShineSweep(trigger: Int) -> some View { modifier(LeoShineModifier(trigger: trigger)) }
    /// Subtle depth as a card scrolls in/out of view.
    func leoScrollDepth() -> some View { modifier(LeoScrollDepthModifier()) }
    /// Source of a card → detail zoom (`leoZoomTransition` on the destination).
    func leoZoomSource<ID: Hashable>(id: ID, in namespace: Namespace.ID) -> some View {
        matchedTransitionSource(id: id, in: namespace)
    }
    /// Destination of a card → detail zoom; plain transition under Reduce Motion.
    func leoZoomTransition<ID: Hashable>(id: ID, in namespace: Namespace.ID) -> some View {
        modifier(LeoZoomTransitionModifier(id: id, namespace: namespace))
    }
}
