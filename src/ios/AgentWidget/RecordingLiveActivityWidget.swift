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
            RecordingActivityCard(attributes: context.attributes, state: context.state)
                .padding(14)
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
                Image(systemName: context.state.isPaused ? "pause.fill" : "waveform")
                    .foregroundStyle(context.state.isPaused ? Color.secondary : Color.red)
            } compactTrailing: {
                RecordingClock(state: context.state)
                    .font(.caption2.monospacedDigit())
                    .frame(maxWidth: 52)
            } minimal: {
                Image(systemName: context.state.isPaused ? "pause.fill" : "waveform")
                    .foregroundStyle(context.state.isPaused ? Color.secondary : Color.red)
            }
            .widgetURL(URL(string: "leophoneagent://recordings/recorder"))
        }
    }
}

@available(iOSApplicationExtension 16.2, *)
private struct RecordingActivityCard: View {
    let attributes: RecordingActivityAttributes
    let state: RecordingActivityAttributes.ContentState

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Image(systemName: state.isPaused ? "pause.circle.fill" : "record.circle")
                    .font(.title3)
                    .foregroundStyle(state.isPaused ? Color.secondary : Color.red)
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
            RecordingLevelBar(level: state.isPaused ? 0 : state.level)
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
        if #available(iOSApplicationExtension 17.0, *) {
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
}
