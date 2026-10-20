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
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @State private var phase: CGFloat = -1

    private var shape: RoundedRectangle {
        RoundedRectangle(cornerRadius: cornerRadius ?? height / 2, style: .continuous)
    }

    var body: some View {
        shape
            .fill(LeoTheme.ColorToken.tertiaryText.opacity(0.22))
            .overlay {
                if !reduceMotion, !reduceTransparency {
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
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @State private var phase: CGFloat = -1
    /// 只在扫光那 0.7s 里挂 GeometryReader + 渐变：每个工具胶囊都常驻一份太贵。
    @State private var sweeping = false

    func body(content: Content) -> some View {
        content.overlay {
            if sweeping {
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
            }
        }
        .onChange(of: trigger) { _, _ in
            guard !reduceMotion, !reduceTransparency else { return }
            phase = -1
            sweeping = true
            withAnimation(.easeInOut(duration: 0.7)) {
                phase = 1
            } completion: {
                sweeping = false
            }
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

// MARK: - [WP-42] Thinking shimmer (Inferno `shimmer` equivalent, no shader)

/// A soft highlight sweeping through the text itself while the model thinks — replaces the
/// bare "思考中…" label. Hand-written instead of Inferno's Metal shader: one gradient masked
/// by the content, transform-only, one period = `LeoMotion.beat`. Reduce Motion: static text.
private struct LeoThinkingShimmerModifier: ViewModifier {
    let active: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @State private var phase: CGFloat = -1

    func body(content: Content) -> some View {
        content
            .overlay {
                // 降低透明度时也不扫光（半透明高光正是要去掉的东西）。
                if active, !reduceTransparency, LeoMotionPolicy.fallback(reduceMotion: reduceMotion) == .full {
                    GeometryReader { geo in
                        LinearGradient(colors: [.clear, .white.opacity(0.75), .clear],
                                       startPoint: .leading, endPoint: .trailing)
                            .frame(width: max(geo.size.width * 0.45, 24))
                            .offset(x: phase * (geo.size.width + 24) - 12)
                    }
                    .mask(content)
                    .allowsHitTesting(false)
                    .onAppear {
                        phase = -1
                        withAnimation(.linear(duration: LeoMotion.beat).repeatForever(autoreverses: false)) { phase = 1 }
                    }
                }
            }
    }
}

// MARK: - [WP-42] Done flash (Pow `.changeEffect(.shine)` equivalent)

/// One shine + a 4% pop the moment work finishes (running → success). Never on first
/// appearance, so scrolling through history stays still. Reduce Motion: no movement.
private struct LeoDoneModifier: ViewModifier {
    let finished: Bool
    var haptic = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var appeared = false
    @State private var shine = 0
    @State private var popped = false

    func body(content: Content) -> some View {
        content
            .scaleEffect(popped ? 1.04 : 1)
            .leoShineSweep(trigger: shine)
            .onAppear { appeared = true }
            .onChange(of: finished) { was, now in
                guard LeoMotionPolicy.shouldFlashDone(wasFinished: was, isFinished: now, hasAppeared: appeared) else { return }
                if haptic { LeoHaptics.notification(.success) }
                guard LeoMotionPolicy.fallback(reduceMotion: reduceMotion) == .full else { return }
                shine += 1
                withAnimation(.spring(response: 0.18, dampingFraction: 0.6)) { popped = true }
                withAnimation(.spring(response: LeoMotion.springResponse, dampingFraction: 0.82).delay(0.12)) { popped = false }
            }
    }
}

// MARK: - [WP-42] Send flight

/// Source / destination of the "message flies from the composer into its bubble" move.
/// Both ends must live in the same SwiftUI hierarchy (matchedGeometryEffect). Reduce Motion:
/// no geometry matching, the bubble simply fades in.
private struct LeoSendFlightModifier<ID: Hashable>: ViewModifier {
    let id: ID
    let namespace: Namespace.ID
    let isSource: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func body(content: Content) -> some View {
        if LeoMotionPolicy.fallback(reduceMotion: reduceMotion) == .full {
            content.matchedGeometryEffect(id: id, in: namespace, isSource: isSource)
        } else {
            content
        }
    }
}

// MARK: - [WP-42] Breathing dot & status strip

/// The "running" dot: breathes once per `beat`. Reduce Motion: solid dot.
struct LeoBreathingDot: View {
    var color: Color = LeoTheme.ColorToken.accent
    var size: CGFloat = 7
    var active = true
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var low = false

    var body: some View {
        Circle()
            .fill(color)
            .frame(width: size, height: size)
            .opacity(active && low && !reduceMotion ? 0.35 : 1)
            .onAppear { start() }
            .onChange(of: active) { _, _ in start() }
            .accessibilityHidden(true)
    }

    private func start() {
        guard active, !reduceMotion else { low = false; return }
        withAnimation(.easeInOut(duration: LeoMotion.beat / 2).repeatForever(autoreverses: true)) { low = true }
    }
}

/// The 2pt left status strip every tool / task card shares (same anatomy as the Mac
/// timeline cards): running = accent breathing, waiting = attention, done = success,
/// failed = destructive, cancelled = tertiary.
struct LeoStatusStrip: View {
    let status: LeoMotionPolicy.StripStatus
    var height: CGFloat = 16
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var low = false

    var body: some View {
        if status != .hidden {
            Capsule()
                .fill(color)
                .frame(width: 2, height: height)
                .opacity(status.breathes && low && !reduceMotion ? 0.35 : 1)
                .animation(LeoMotion.standardEase(reduceMotion: reduceMotion), value: status)
                .onAppear { breathe() }
                .onChange(of: status) { _, _ in breathe() }
                .accessibilityHidden(true)
        }
    }

    private var color: Color {
        switch status {
        case .running: return LeoTheme.ColorToken.accent
        case .waiting: return LeoTheme.ColorToken.attention
        case .success: return LeoTheme.ColorToken.success
        case .failure: return LeoTheme.ColorToken.destructive
        case .cancelled, .hidden: return LeoTheme.ColorToken.tertiaryText
        }
    }

    private func breathe() {
        guard status.breathes, !reduceMotion else { low = false; return }
        withAnimation(.easeInOut(duration: LeoMotion.beat / 2).repeatForever(autoreverses: true)) { low = true }
    }
}

extension AnyTransition {
    /// [WP-42] Pow `.movingParts.pop` equivalent: scale-in from 85% with a fade. Reduce Motion: fade only.
    static func leoPop(reduceMotion: Bool) -> AnyTransition {
        LeoMotionPolicy.fallback(reduceMotion: reduceMotion) == .full
            ? .scale(scale: 0.85).combined(with: .opacity)
            : .opacity
    }

    /// [WP-42] Card entering from the bottom edge (approval cards). Reduce Motion: fade only.
    static func leoRiseIn(reduceMotion: Bool) -> AnyTransition {
        LeoMotionPolicy.fallback(reduceMotion: reduceMotion) == .full
            ? .move(edge: .bottom).combined(with: .opacity)
            : .opacity
    }
}

extension View {
    /// [WP-42] Highlight sweeping through the text while `active` (thinking headers).
    func leoThinkingShimmer(active: Bool) -> some View { modifier(LeoThinkingShimmerModifier(active: active)) }
    /// [WP-42] One shine + pop when `finished` flips to true (never on first appearance).
    func leoDone(finished: Bool, haptic: Bool = false) -> some View {
        modifier(LeoDoneModifier(finished: finished, haptic: haptic))
    }
    /// [WP-42] matchedGeometry flight between composer and bubble; nothing under Reduce Motion.
    func leoSendFlight<ID: Hashable>(id: ID, in namespace: Namespace.ID, isSource: Bool) -> some View {
        modifier(LeoSendFlightModifier(id: id, namespace: namespace, isSource: isSource))
    }
}
