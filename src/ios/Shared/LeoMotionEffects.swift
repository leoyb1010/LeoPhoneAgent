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
            .onChange(of: active) { isOn in
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
            .onChange(of: trigger) { _ in
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

/// One-shot fade+rise on first appearance, delayed by index. Capped so long
/// lists never queue a parade; scrolling reuse is unaffected because the
/// state flips once and stays.
private struct LeoStaggerModifier: ViewModifier {
    let index: Int
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var shown = false

    func body(content: Content) -> some View {
        content
            .opacity(shown || reduceMotion ? 1 : 0)
            .offset(y: shown || reduceMotion ? 0 : 8)
            .onAppear {
                guard !shown else { return }
                let delay = Double(min(index, 8)) * 0.04
                withAnimation(LeoMotion.smooth(reduceMotion: reduceMotion, duration: 0.28)?.delay(delay) ?? .default) {
                    shown = true
                }
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
        .onChange(of: trigger) { _ in
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
}
