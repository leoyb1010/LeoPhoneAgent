import ActivityKit
import AppIntents
import SwiftUI
import WidgetKit

/// [V-rec] 录音的灵动岛 / 锁屏卡片:计时、电平、暂停 / 继续、标记重点、停止。
/// 计时用 `Text(timerInterval:)` 自己走,App 只在状态变化时推送。
@available(iOSApplicationExtension 16.2, *)
struct RecordingLiveActivityWidget: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: RecordingActivityAttributes.self) { context in
            RecordingActivityFamilyView(attributes: context.attributes, state: context.state)
                .leoWidgetLocale()
                .widgetURL(URL(string: "leophoneagent://recordings/recorder"))
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    Label {
                        Text(context.attributes.title).lineLimit(1)
                    } icon: {
                        Image(systemName: context.state.isPaused ? "pause.circle.fill" : "record.circle")
                            .foregroundStyle(context.state.isPaused ? Color.secondary : Color.red)
                    }
                    .font(.caption.bold())
                    .padding(.leading, 6)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    RecordingClock(state: context.state)
                        .font(.title3.monospacedDigit().weight(.semibold))
                        .padding(.trailing, 6)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    VStack(spacing: 8) {
                        RecordingLevelBar(level: context.state.isPaused ? 0 : context.state.level)
                            .frame(height: 6)
                        RecordingActivityControls(state: context.state)
                    }
                    .padding(.horizontal, 6)
                }
            } compactLeading: {
                RecordingStatusGlyph(state: context.state)
            } compactTrailing: {
                RecordingCompactClock(state: context.state)
            } minimal: {
                RecordingStatusGlyph(state: context.state)
            }
            .widgetURL(URL(string: "leophoneagent://recordings/recorder"))
        }
        // Apple Watch Smart Stack / CarPlay get their own small layout instead of
        // a squeezed lock-screen card (same as the agent card).
        .supplementalActivityFamilies([.small])
    }
}

/// [duo-island] One glyph that reads at any island size, including the narrow
/// side island of iPhone Duo: filled record dot while recording, pause bars when paused.
@available(iOSApplicationExtension 16.2, *)
private struct RecordingStatusGlyph: View {
    let state: RecordingActivityAttributes.ContentState
    @Environment(\.isLuminanceReduced) private var dimmed

    var body: some View {
        Image(systemName: state.isPaused ? "pause.fill" : "record.circle.fill")
            .foregroundStyle(state.isPaused ? Color.secondary : Color.red.opacity(dimmed ? 0.6 : 1))
            .accessibilityLabel(state.isPaused ? Text("暂停") : Text(state.statusText))
    }
}

/// [duo-island] Compact trailing clock, sized by its content instead of a fixed
/// width: an invisible template shaped like the current reading ("0:00", "00:00",
/// "0:00:00") gives the timer its intrinsic width, since a live timer text alone
/// stretches to fill the island. When the island is limited in width (several
/// activities, landscape, or the vertical side island of iPhone Duo) the digits
/// may shrink further rather than clip.
@available(iOSApplicationExtension 16.2, *)
private struct RecordingCompactClock: View {
    let state: RecordingActivityAttributes.ContentState
    @Environment(\.isDynamicIslandLimitedInWidth) private var limited

    var body: some View {
        Text(verbatim: Self.template(elapsed: state.elapsed))
            .hidden()
            .overlay(alignment: .trailing) {
                RecordingClock(state: state)
                    .lineLimit(1)
                    .minimumScaleFactor(limited ? 0.5 : 0.75)
            }
            .font(.caption2.monospacedDigit())
            .accessibilityElement(children: .combine)
    }

    /// Widest reading likely before the next push (pushes come on state changes,
    /// so leave a minute of headroom before each width step).
    static func template(elapsed: Double) -> String {
        elapsed < 540 ? "0:00" : (elapsed < 3540 ? "00:00" : "0:00:00")
    }
}

/// Lock screen / banner card, or the small layout on the watch / CarPlay.
@available(iOSApplicationExtension 16.2, *)
private struct RecordingActivityFamilyView: View {
    let attributes: RecordingActivityAttributes
    let state: RecordingActivityAttributes.ContentState
    @Environment(\.activityFamily) private var family

    var body: some View {
        if family == .small {
            HStack(spacing: 8) {
                RecordingStatusGlyph(state: state)
                    .font(.title3)
                VStack(alignment: .leading, spacing: 1) {
                    Text(attributes.title)
                        .font(.caption.bold())
                        .lineLimit(1)
                    RecordingClock(state: state)
                        .font(.caption2.monospacedDigit())
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
        } else {
            RecordingActivityCard(attributes: attributes, state: state)
                .padding(14)
        }
    }
}

@available(iOSApplicationExtension 16.2, *)
private struct RecordingActivityCard: View {
    let attributes: RecordingActivityAttributes
    let state: RecordingActivityAttributes.ContentState
    /// [duo-aod] Always-On (iPhone Duo outer display, Pro models): dim the accents.
    @Environment(\.isLuminanceReduced) private var dimmed

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Image(systemName: state.isPaused ? "pause.circle.fill" : "record.circle")
                    .font(.title3)
                    .foregroundStyle(state.isPaused ? Color.secondary : Color.red.opacity(dimmed ? 0.6 : 1))
                VStack(alignment: .leading, spacing: 2) {
                    Text(attributes.title)
                        .font(.subheadline.bold())
                        .lineLimit(1)
                    HStack(spacing: 4) {
                        Text(state.statusText)
                        if state.highlightCount > 0 {
                            Text("· \(state.highlightCount) 个重点")
                        }
                    }
                    .font(.caption)
                    .foregroundStyle(.secondary)
                }
                Spacer(minLength: 6)
                RecordingClock(state: state)
                    .font(.title2.monospacedDigit().weight(.semibold))
            }
            // The live level means nothing on a dimmed screen that refreshes rarely.
            RecordingLevelBar(level: state.isPaused || dimmed ? 0 : state.level)
                .frame(height: 6)
            RecordingActivityControls(state: state)
        }
    }
}

/// 运行中自己走秒;暂停时显示定格的时长。
@available(iOSApplicationExtension 16.2, *)
private struct RecordingClock: View {
    let state: RecordingActivityAttributes.ContentState

    var body: some View {
        if state.isPaused {
            Text(Self.format(state.elapsed))
        } else {
            Text(timerInterval: state.timerReferenceDate...Date.distantFuture, countsDown: false)
                .multilineTextAlignment(.trailing)
        }
    }

    static func format(_ seconds: Double) -> String {
        let total = Int(max(0, seconds.isFinite ? seconds : 0))
        let h = total / 3600, m = (total % 3600) / 60, s = total % 60
        return h > 0 ? String(format: "%d:%02d:%02d", h, m, s) : String(format: "%d:%02d", m, s)
    }
}

private struct RecordingLevelBar: View {
    let level: Double

    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                Capsule().fill(Color.secondary.opacity(0.2))
                Capsule().fill(Color.red.opacity(0.8))
                    .frame(width: max(4, geo.size.width * CGFloat(min(1, max(0, level)))))
            }
        }
        .accessibilityHidden(true)
    }
}

@available(iOSApplicationExtension 16.2, *)
private struct RecordingActivityControls: View {
    let state: RecordingActivityAttributes.ContentState

    var body: some View {
        HStack(spacing: 10) {
            Button(intent: RecordingMarkIntent()) {
                Label("标记", systemImage: "flag.fill")
            }
            .tint(.orange)
            .disabled(state.isPaused)
            Button(intent: RecordingTogglePauseIntent()) {
                Label(state.isPaused ? LocalizedStringKey("继续") : LocalizedStringKey("暂停"), systemImage: state.isPaused ? "play.fill" : "pause.fill")
            }
            .tint(.gray)
            Button(intent: RecordingStopIntent()) {
                Label("停止", systemImage: "stop.fill")
            }
            .tint(.red)
        }
        .font(.caption.weight(.semibold))
        .buttonStyle(.bordered)
        .labelStyle(.titleAndIcon)
    }
}
