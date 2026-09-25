//
//  WatchMotionViews.swift
//  LeoWatch
//
//  [T-watch-motion] The wrist edition of the leotexiao selections. Watch hard
//  lines: one looping effect on screen at a time, loops only while active,
//  entrances ≤0.5s, transform/opacity/strokeEnd only, every signature moment
//  pairs with a haptic, Reduce Motion and Always On (wrist down, luminance
//  reduced) degrade to static.
//

import SwiftUI
import WatchKit

// MARK: - Life Ring (Breathing Orb + Border Beam + Success Check / Error Shake)

struct LifeRing: View {
    /// "idle" | "running" | "completed" | "failed"
    let state: String
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.isLuminanceReduced) private var isLuminanceReduced
    @Environment(\.scenePhase) private var scenePhase
    @State private var breathe = false
    @State private var beamAngle = 0.0

    private var still: Bool { reduceMotion || isLuminanceReduced }

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
            if state == "running", !still {
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
        .scaleEffect(state == "idle" && breathe && !still ? 1.04 : 1)
        .onAppear { startLoops() }
        .onChange(of: state) { _ in startLoops() }
        .onChange(of: scenePhase) { phase in
            if phase == .active { startLoops() }
        }
        .onChange(of: still) { _ in startLoops() }
    }

    private func startLoops() {
        breathe = false
        beamAngle = 0
        guard scenePhase != .background, !still else { return }
        if state == "idle" {
            withAnimation(.easeInOut(duration: 1.6).repeatForever(autoreverses: true)) { breathe = true }
        }
        if state == "running" {
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
    @Environment(\.isLuminanceReduced) private var isLuminanceReduced

    var body: some View {
        // The looping bars are their own view so each wrist raise starts a
        // fresh loop, and Always On drops the loop entirely.
        if reduceMotion || isLuminanceReduced {
            Bars(on: false, animated: false)
        } else {
            LoopingBars()
        }
    }

    private struct LoopingBars: View {
        @State private var on = false
        var body: some View {
            Bars(on: on, animated: true).onAppear { on = true }
        }
    }

    private struct Bars: View {
        let on: Bool
        let animated: Bool
        var body: some View {
            HStack(spacing: 3) {
                ForEach(0..<4, id: \.self) { index in
                    RoundedRectangle(cornerRadius: 1.5)
                        .fill(.teal)
                        .frame(width: 3, height: on ? 14 : 5)
                        .animation(
                            animated ? .easeInOut(duration: 0.45)
                                .repeatForever(autoreverses: true)
                                .delay(Double(index) * 0.12) : nil,
                            value: on)
                }
            }
            .frame(height: 16)
        }
    }
}

// MARK: - Live level bars (recording — real metering, the honest Equalizer)

struct LiveLevelBars: View {
    let level: Double

    var body: some View {
        HStack(spacing: 3) {
            ForEach(0..<5, id: \.self) { index in
                RoundedRectangle(cornerRadius: 1.5)
                    .fill(.red)
                    .frame(width: 3, height: 5 + CGFloat(level) * CGFloat([18, 26, 32, 26, 18][index]))
            }
        }
        .frame(height: 34)
        .animation(.linear(duration: 0.08), value: level)
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
