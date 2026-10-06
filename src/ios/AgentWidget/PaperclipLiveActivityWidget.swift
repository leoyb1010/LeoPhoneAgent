import ActivityKit
import SwiftUI
import WidgetKit

/// [G2] Paperclip 工单的灵动岛与锁屏卡片：工单号、智能体、当前阶段、计时；终态显示结果。
/// 隐私模式下 App 不写入标题与阶段，这里只显示编号、智能体和状态。
@available(iOSApplicationExtension 16.2, *)
struct PaperclipLiveActivityWidget: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: PaperclipActivityAttributes.self) { context in
            PaperclipActivityCard(attributes: context.attributes, state: context.state, isStale: context.isStale)
                .padding(14)
                .widgetURL(URL(string: context.attributes.link))
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    Label(context.attributes.displayName, systemImage: "paperclip")
                        .font(.caption.bold())
                        .lineLimit(1)
                        .padding(.leading, 6)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    PaperclipActivityClock(state: context.state)
                        .font(.caption.monospacedDigit())
                        .padding(.trailing, 6)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    PaperclipActivityDetail(state: context.state, isStale: context.isStale)
                        .padding(.horizontal, 6)
                }
            } compactLeading: {
                Image(systemName: "paperclip")
                    .foregroundStyle(context.state.phase.tint)
            } compactTrailing: {
                if context.state.phase.isTerminal {
                    Image(systemName: context.state.phase.symbol).foregroundStyle(context.state.phase.tint)
                } else {
                    Text(context.state.startedAt, style: .timer)
                        .monospacedDigit()
                        .frame(maxWidth: 44)
                }
            } minimal: {
                Image(systemName: context.state.phase.isTerminal ? context.state.phase.symbol : "paperclip")
                    .foregroundStyle(context.state.phase.tint)
            }
            .widgetURL(URL(string: context.attributes.link))
        }
    }
}

@available(iOSApplicationExtension 16.2, *)
private struct PaperclipActivityCard: View {
    let attributes: PaperclipActivityAttributes
    let state: PaperclipActivityAttributes.ContentState
    let isStale: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Label(attributes.displayName, systemImage: "paperclip")
                    .font(.subheadline.bold())
                    .lineLimit(1)
                Spacer(minLength: 6)
                PaperclipActivityClock(state: state)
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.secondary)
            }
            if !state.title.isEmpty {
                Text(state.title).font(.callout.weight(.semibold)).lineLimit(2)
            }
            PaperclipActivityDetail(state: state, isStale: isStale)
        }
    }
}

@available(iOSApplicationExtension 16.2, *)
private struct PaperclipActivityDetail: View {
    let state: PaperclipActivityAttributes.ContentState
    let isStale: Bool

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: isStale && !state.phase.isTerminal ? "clock.arrow.circlepath" : state.phase.symbol)
                .foregroundStyle(state.phase.tint)
            Text(line).lineLimit(1)
            Spacer(minLength: 0)
        }
        .font(.caption)
        .foregroundStyle(.secondary)
    }

    private var line: String {
        if isStale && !state.phase.isTerminal { return "状态更新延迟 · 打开 App 查看" }
        let stage = state.phase == .running && !state.stage.isEmpty ? state.stage : state.phase.label
        return state.agentName.isEmpty ? stage : "\(state.agentName) · \(stage)"
    }
}

/// 运行中显示计时，终态显示总耗时。
@available(iOSApplicationExtension 16.2, *)
private struct PaperclipActivityClock: View {
    let state: PaperclipActivityAttributes.ContentState

    var body: some View {
        if let finishedAt = state.finishedAt {
            Text(Duration.seconds(max(0, finishedAt.timeIntervalSince(state.startedAt))).formatted(.time(pattern: .minuteSecond)))
        } else {
            Text(state.startedAt, style: .timer).multilineTextAlignment(.trailing)
        }
    }
}

private extension PaperclipActivityAttributes {
    var displayName: String { identifier.isEmpty ? "Paperclip 工单" : identifier }
}

private extension PaperclipActivityAttributes.ContentState.Phase {
    var tint: Color {
        switch self {
        case .queued: return .secondary
        case .running: return .teal
        case .succeeded: return .green
        case .failed: return .orange
        case .cancelled: return .gray
        }
    }
}
