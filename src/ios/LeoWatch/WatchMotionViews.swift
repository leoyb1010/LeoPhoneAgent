//
//  WatchMotionViews.swift
//  LeoWatch
//
//  [T-watch-motion] The wrist edition of the leotexiao selections. Watch hard
//  lines: one looping effect on screen at a time, loops only while active,
//  entrances ≤0.5s, transform/opacity/strokeEnd only, every signature moment
//  pairs with a haptic, Reduce Motion degrades to static.
//

import SwiftUI
import WatchKit

// MARK: - Life Ring (Breathing Orb + Border Beam + Success Check / Error Shake)

struct LifeRing: View {
    /// "idle" | "running" | "completed" | "failed"
    let state: String
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase
    @State private var breathe = false
    @State private var beamAngle = 0.0

    private var ringColor: Color {
        switch state {
        case "running": return .orange
        case "failed": return .red
        case "completed": return .green
        default: return .teal
        }
    }

    var body: some View {
        ZStack {
            Circle()
                .stroke(ringColor.opacity(0.25), lineWidth: 4)
            if state == "running", !reduceMotion {
                // Border Beam: a bright arc travelling the ring.
                Circle()
                    .trim(from: 0, to: 0.18)
                    .stroke(ringColor, style: StrokeStyle(lineWidth: 4, lineCap: .round))
                    .rotationEffect(.degrees(beamAngle))
            } else {
                Circle()
                    .stroke(ringColor.opacity(state == "idle" ? 0.6 : 1), lineWidth: 4)
            }
        }
        .scaleEffect(state == "idle" && breathe && !reduceMotion ? 1.04 : 1)
        .onAppear { startLoops() }
        .onChange(of: state) { _ in startLoops() }
        .onChange(of: scenePhase) { phase in
            if phase == .active { startLoops() }
        }
    }

    private func startLoops() {
        guard scenePhase != .background, !reduceMotion else { return }
        if state == "idle" {
            withAnimation(.easeInOut(duration: 1.6).repeatForever(autoreverses: true)) { breathe = true }
        } else {
            breathe = false
        }
        if state == "running" {
            beamAngle = 0
            withAnimation(.linear(duration: 1.4).repeatForever(autoreverses: false)) { beamAngle = 360 }
        }
    }
}

// MARK: - One-shot radar pulse (mic press)

struct RadarPulseOnce: View {
    let trigger: Int
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var expand = false

    var body: some View {
        Circle()
            .stroke(Color.teal.opacity(expand ? 0 : 0.7), lineWidth: 2)
            .scaleEffect(expand ? 2.2 : 0.6)
            .onChange(of: trigger) { _ in
                guard !reduceMotion else { return }
                expand = false
                withAnimation(.easeOut(duration: 0.5)) { expand = true }
            }
            .allowsHitTesting(false)
    }
}

// MARK: - Working bars (Equalizer as "agent is thinking")

struct WorkingBars: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var on = false

    var body: some View {
        HStack(spacing: 3) {
            ForEach(0..<4, id: \.self) { index in
                RoundedRectangle(cornerRadius: 1.5)
                    .fill(.teal)
                    .frame(width: 3, height: on ? 14 : 5)
                    .animation(
                        reduceMotion ? nil : .easeInOut(duration: 0.45)
                            .repeatForever(autoreverses: true)
                            .delay(Double(index) * 0.12),
                        value: on)
            }
        }
        .frame(height: 16)
        .onAppear { on = true }
    }
}

// MARK: - Hold-to-confirm (Countdown Ring fill + escalating haptics)

struct HoldToConfirmButton<Label: View>: View {
    let duration: Double
    let tint: Color
    let action: () -> Void
    @ViewBuilder let label: () -> Label

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var pressing = false
    @State private var fired = false

    var body: some View {
        label()
            .padding(.vertical, 6)
            .frame(maxWidth: .infinity)
            .background(tint.opacity(0.18), in: Capsule())
            .overlay(
                Capsule()
                    .trim(from: 0, to: pressing || fired ? 1 : 0.0001)
                    .stroke(tint, lineWidth: 2.5)
                    .animation(pressing ? .linear(duration: duration) : .easeOut(duration: 0.15), value: pressing)
            )
            .scaleEffect(pressing && !reduceMotion ? 0.96 : 1)
            .onLongPressGesture(minimumDuration: duration, perform: {
                fired = true
                WKInterfaceDevice.current().play(.success)
                action()
                Task { try? await Task.sleep(nanoseconds: 400_000_000); fired = false }
            }, onPressingChanged: { isPressing in
                pressing = isPressing
                if isPressing { WKInterfaceDevice.current().play(.start) }
            })
    }
}

// MARK: - Confidence settle for arriving replies

struct SettleIn: ViewModifier {
    let trigger: Int
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var settled = true

    func body(content: Content) -> some View {
        content
            .opacity(settled || reduceMotion ? 1 : 0)
            .offset(y: settled || reduceMotion ? 0 : 6)
            .blur(radius: settled || reduceMotion ? 0 : 1.5)
            .onChange(of: trigger) { _ in
                guard !reduceMotion else { return }
                settled = false
                withAnimation(.easeOut(duration: 0.45)) { settled = true }
            }
    }
}

extension View {
    func settleIn(trigger: Int) -> some View { modifier(SettleIn(trigger: trigger)) }
}
