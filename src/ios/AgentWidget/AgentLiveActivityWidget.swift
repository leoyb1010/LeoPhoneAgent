import ActivityKit
import SwiftUI
import WidgetKit

// MARK: - Home Screen task status

private struct AgentStatusEntry: TimelineEntry {
    let date: Date
    let snapshot: AgentWidgetSnapshot
}

private struct AgentStatusProvider: TimelineProvider {
    func placeholder(in context: Context) -> AgentStatusEntry {
        AgentStatusEntry(
            date: .now,
            snapshot: AgentWidgetSnapshot(
                updatedAt: .now,
                state: .running,
                activeCount: 1,
                sessionId: "preview",
                title: "Agent task",
                status: "Working",
                toolIcon: "sparkles",
                loopIteration: 2,
                privacyMode: false
            )
        )
    }

    func getSnapshot(in context: Context, completion: @escaping (AgentStatusEntry) -> Void) {
        completion(AgentStatusEntry(date: .now, snapshot: AgentWidgetSnapshotStore.load()))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<AgentStatusEntry>) -> Void) {
        let entry = AgentStatusEntry(date: .now, snapshot: AgentWidgetSnapshotStore.load())
        completion(Timeline(entries: [entry], policy: .never))
    }
}

struct AgentStatusWidget: Widget {
    static let kind = "LeoAgentStatusWidget"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: Self.kind, provider: AgentStatusProvider()) { entry in
            AgentStatusWidgetContainer(entry: entry)
        }
        .configurationDisplayName("Leo Task Status")
        .description("See active tasks and jump straight into voice input.")
        .supportedFamilies([.systemSmall, .systemMedium])
    }
}

private struct AgentStatusWidgetContainer: View {
    let entry: AgentStatusEntry

    @ViewBuilder
    var body: some View {
        if #available(iOSApplicationExtension 17.0, *) {
            AgentStatusWidgetView(entry: entry)
                .containerBackground(.fill.tertiary, for: .widget)
                .widgetURL(entry.snapshot.destinationURL)
        } else {
            AgentStatusWidgetView(entry: entry)
                .padding()
                .background(Color(uiColor: .secondarySystemBackground))
                .widgetURL(entry.snapshot.destinationURL)
        }
    }
}

private struct AgentStatusWidgetView: View {
    @Environment(\.widgetFamily) private var family
    let entry: AgentStatusEntry

    var body: some View {
        if family == .systemSmall {
            smallView
        } else {
            mediumView
        }
    }

    private var smallView: some View {
        VStack(alignment: .leading, spacing: 8) {
            header
            Spacer(minLength: 2)
            Image(systemName: entry.snapshot.state.symbol)
                .font(.title2.weight(.semibold))
                .foregroundStyle(entry.snapshot.state.tint)
            Text(entry.snapshot.primaryText)
                .font(.headline)
                .lineLimit(2)
            Text(entry.snapshot.secondaryText)
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(1)
        }
    }

    private var mediumView: some View {
        HStack(spacing: 16) {
            VStack(alignment: .leading, spacing: 8) {
                header
                Spacer(minLength: 2)
                Label(entry.snapshot.primaryText, systemImage: entry.snapshot.state.symbol)
                    .font(.headline)
                    .foregroundStyle(entry.snapshot.state.tint)
                    .lineLimit(1)
                Text(entry.snapshot.secondaryText)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
            Spacer(minLength: 8)
            Link(destination: URL(string: "leophoneagent://voice")!) {
                VStack(spacing: 6) {
                    Image(systemName: "mic.fill")
                        .font(.title3.weight(.semibold))
                    Text("Voice")
                        .font(.caption.weight(.semibold))
                }
                .foregroundStyle(.white)
                .frame(width: 64, height: 64)
                .background(Color.accentColor, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
            }
            .accessibilityLabel("Open voice input")
        }
    }

    private var header: some View {
        HStack(spacing: 6) {
            Image(systemName: "sparkles")
                .foregroundStyle(Color.accentColor)
            Text("LeoPhoneAgent")
                .font(.caption.weight(.semibold))
                .lineLimit(1)
            Spacer(minLength: 0)
            if entry.snapshot.activeCount > 1 {
                Text("\(entry.snapshot.activeCount)")
                    .font(.caption.monospacedDigit().weight(.semibold))
                    .foregroundStyle(.secondary)
            }
        }
    }
}

private extension AgentWidgetSnapshot {
    var destinationURL: URL {
        if !sessionId.isEmpty,
           let encoded = sessionId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed),
           let url = URL(string: "leophoneagent://sessions/\(encoded)") {
            return url
        }
        return URL(string: "leophoneagent://voice")!
    }

    var primaryText: String {
        if privacyMode {
            switch state {
            case .idle: return "Ready"
            case .running: return activeCount == 1 ? "1 task running" : "\(activeCount) tasks running"
            case .suspended: return "Task paused"
            case .completed: return "Task completed"
            case .failed: return "Task needs attention"
            }
        }
        return title.isEmpty ? state.fallbackTitle : title
    }

    var secondaryText: String {
        if privacyMode { return state.privacyStatus }
        if !status.isEmpty { return status }
        return state.privacyStatus
    }
}

private extension AgentWidgetSnapshot.State {
    var symbol: String {
        switch self {
        case .idle: return "mic.fill"
        case .running: return "sparkles"
        case .suspended: return "pause.circle.fill"
        case .completed: return "checkmark.circle.fill"
        case .failed: return "exclamationmark.circle.fill"
        }
    }

    var tint: Color {
        switch self {
        case .idle, .running: return .accentColor
        case .suspended: return .orange
        case .completed: return .green
        case .failed: return .red
        }
    }

    var fallbackTitle: String {
        switch self {
        case .idle: return "Ready"
        case .running: return "Working"
        case .suspended: return "Paused"
        case .completed: return "Completed"
        case .failed: return "Needs attention"
        }
    }

    var privacyStatus: String {
        switch self {
        case .idle: return "Tap to speak"
        case .running: return "Open for live progress"
        case .suspended: return "Open to resume"
        case .completed: return "Open result"
        case .failed: return "Open recovery options"
        }
    }
}

@available(iOSApplicationExtension 16.2, *)
struct AgentLiveActivityWidget: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: AgentActivityAttributes.self) { context in
            AgentLockScreenView(
                attributes: context.attributes,
                state: context.state
            )
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    HStack(spacing: 3) {
                        Image(systemName: "sparkles")
                            .font(.caption2)
                        Text(context.state.soulName.isEmpty ? "LeoPhoneAgent" : context.state.soulName)
                            .font(.caption.bold())
                    }
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(.white.opacity(0.15), in: Capsule())
                    .padding(.leading, 8)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    if context.state.allCompleted {
                        HStack(spacing: 3) {
                            Image(systemName: "checkmark.circle.fill")
                                .font(.caption)
                                .foregroundStyle(.green)
                            Text("\(context.state.sessions.count)")
                                .font(.caption.bold())
                        }
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(.green.opacity(0.18), in: Capsule())
                        .padding(.trailing, 8)
                    } else {
                        HStack(spacing: 3) {
                            Text("\(context.state.activeSessionCount)")
                                .font(.caption.bold())
                                .contentTransition(.numericText())
                            Text(context.state.activeSessionCount == 1 ? "session" : "sessions")
                                .font(.caption.bold())
                        }
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(.white.opacity(0.15), in: Capsule())
                        .padding(.trailing, 8)
                    }
                }
                DynamicIslandExpandedRegion(.bottom) {
                    if let session = context.state.currentSession {
                        VStack(alignment: .leading, spacing: 5) {
                            HStack(spacing: 0) {
                                Image(systemName: "bubble.left.fill")
                                    .font(.caption)
                                    .foregroundStyle(.blue)
                                    .padding(.trailing, 5)
                                Text(session.title)
                                    .font(.callout.bold())
                                    .lineLimit(1)
                                if context.state.activeSessionCount > 1 {
                                    Text("\(context.state.carouselIndex + 1)/\(context.state.activeSessionCount)")
                                        .font(.caption.monospacedDigit())
                                        .foregroundStyle(.tertiary)
                                        .padding(.leading, 4)
                                }
                                Spacer(minLength: 6)
                                // [T-ios-live-activity-soft-finish] Hide the
                                // running timer once the task is completed — the
                                // soft-finished state is a resting view, so the
                                // .timer must stop ticking (it kept counting up
                                // even after "Completed" showed). Matches the Lock
                                // Screen view's guard.
                                if !session.isCompleted {
                                    Text("00:00")
                                        .font(.caption2.monospacedDigit())
                                        .hidden()
                                        .padding(.horizontal, 6)
                                        .padding(.vertical, 2)
                                        .overlay {
                                            Text(context.attributes.startDate, style: .timer)
                                                .font(.caption2.monospacedDigit())
                                                .multilineTextAlignment(.center)
                                                .foregroundStyle(.secondary)
                                        }
                                        .background(.white.opacity(0.12), in: Capsule())
                                } else if let finishedAt = context.state.finishedAt {
                                    // [T-ios-live-activity-privacy-duration]
                                    // Resting state: static total run time in
                                    // the slot the live timer occupied.
                                    Text(totalRunTime(from: context.attributes.startDate, to: finishedAt))
                                        .font(.caption2.monospacedDigit())
                                        .foregroundStyle(.secondary)
                                        .padding(.horizontal, 6)
                                        .padding(.vertical, 2)
                                        .background(.white.opacity(0.12), in: Capsule())
                                }
                            }
                            if session.isCompleted {
                                HStack(alignment: .top, spacing: 5) {
                                    Image(systemName: "checkmark.circle.fill")
                                        .font(.caption)
                                        .foregroundStyle(.green)
                                    if !session.lastMessage.isEmpty {
                                        Text(session.lastMessage)
                                            .font(.caption)
                                            .foregroundStyle(.secondary)
                                            .lineLimit(1)
                                    }
                                    Spacer()
                                    // [T-ios-live-activity-privacy-mode] Loop count is
                                    // agent activity metadata — hidden in Privacy Mode.
                                    if !context.state.privacyMode {
                                        Text("Loop \(session.loopIteration)")
                                            .font(.caption2.monospacedDigit())
                                            .foregroundStyle(.tertiary)
                                    }
                                }
                            } else {
                                HStack(spacing: 5) {
                                    Image(systemName: session.toolIcon)
                                        .font(.caption)
                                        .foregroundStyle(.blue)
                                        .id(session.toolIcon)
                                        .transition(.opacity.animation(.easeInOut(duration: 0.35)))
                                    Text(session.toolStatus)
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                        .lineLimit(1)
                                        .contentTransition(.interpolate)
                                    Spacer()
                                    if !context.state.privacyMode {
                                        Text("Loop \(session.loopIteration)")
                                            .font(.caption2.monospacedDigit())
                                            .foregroundStyle(.tertiary)
                                    }
                                }
                            }
                        }
                        .padding(.leading, 8)
                        .padding(.trailing, 8)
                        .padding(.top, 4)
                    }
                }
            } compactLeading: {
                HStack(spacing: 3) {
                    Image(systemName: "list.bullet.circle")
                        .font(.callout)
                    Text("\(context.state.activeSessionCount)")
                        .font(.callout.bold())
                        .contentTransition(.numericText())
                }
            } compactTrailing: {
                CompactTrailingView(state: context.state)
            } minimal: {
                MinimalIconView(state: context.state)
            }
        }
    }
}

// MARK: - Audio Toggle Pill (T-ios-live-activity-audio-toggle)

/// Small capsule matching the Agent-identity pill's styling, showing the current
/// play/pause state of the app's audio narration. On iOS 17+ it's an interactive
/// `Button(intent:)` that toggles playback without opening the app; on iOS 16.x
/// (no `Button(intent:)` in Live Activities) it degrades to a status-only glyph.
@available(iOSApplicationExtension 16.2, *)
struct AudioTogglePill: View {
    let isPlaying: Bool

    private var glyph: some View {
        // Speaker glyphs, not the generic transport play/pause pair: this control
        // governs SPEECH (read-aloud), and a speaker reads as "voice" where
        // play/pause reads as "media player". State-indicating (what IS happening),
        // matching how Apple's own audio controls behave — wave = currently
        // speaking, slash = muted/paused.
        Image(systemName: isPlaying ? "speaker.wave.2.fill" : "speaker.slash.fill")
            .font(.caption2.bold())
            .foregroundStyle(.white)
            // The two speaker glyphs have different intrinsic widths (the wave
            // variant is wider), so a fixed 16pt box would clip one of them and
            // make the capsule jump on toggle. Give it room and center.
            .frame(width: 20, height: 16)
            .padding(.horizontal, 4)
            .padding(.vertical, 2)
            .background(.white.opacity(0.15), in: Capsule())
            // Swap the glyph with a fade so the icon flips smoothly when the
            // toggle intent lands. `.id` forces the transition per state.
            .id(isPlaying)
            .transition(.opacity.animation(.easeInOut(duration: 0.2)))
    }

    var body: some View {
        if #available(iOSApplicationExtension 17.0, *) {
            Button(intent: AudioTogglePlaybackIntent()) {
                glyph
            }
            .buttonStyle(.plain)
        } else {
            glyph
        }
    }
}

// MARK: - Lock Screen View

@available(iOSApplicationExtension 16.2, *)
struct AgentLockScreenView: View {
    let attributes: AgentActivityAttributes
    let state: AgentActivityAttributes.ContentState

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                HStack(spacing: 3) {
                    Image(systemName: "sparkles")
                        .font(.caption2)
                    Text(state.soulName.isEmpty ? "LeoPhoneAgent" : state.soulName)
                        .font(.caption.bold())
                }
                .padding(.horizontal, 6)
                .padding(.vertical, 2)
                .background(.white.opacity(0.15), in: Capsule())
                // [T-ios-live-activity-audio-toggle] Audio play/pause control on
                // the Lock Screen too, beside the identity capsule.
                if state.isAudioLoaded {
                    AudioTogglePill(isPlaying: state.isAudioPlaying)
                }
                Spacer()
                if state.allCompleted {
                    HStack(spacing: 3) {
                        Image(systemName: "checkmark.circle.fill")
                            .font(.caption)
                            .foregroundStyle(.green)
                        Text("\(state.sessions.count) completed")
                            .font(.caption.bold())
                    }
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(.green.opacity(0.18), in: Capsule())
                } else {
                    HStack(spacing: 3) {
                        Text("\(state.activeSessionCount)")
                            .font(.caption.bold())
                            .contentTransition(.numericText())
                        Text(state.activeSessionCount == 1 ? "session" : "sessions")
                            .font(.caption.bold())
                    }
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(.white.opacity(0.15), in: Capsule())
                }
            }

            if let session = state.currentSession {
                VStack(alignment: .leading, spacing: 4) {
                    HStack(spacing: 5) {
                        Image(systemName: "bubble.left.fill")
                            .font(.caption)
                            .foregroundStyle(.blue)
                        Text(session.title)
                            .font(.subheadline.bold())
                            .lineLimit(1)
                        if state.activeSessionCount > 1 {
                            Text("\(state.carouselIndex + 1)/\(state.activeSessionCount)")
                                .font(.caption2.monospacedDigit())
                                .foregroundStyle(.tertiary)
                        }
                        Spacer(minLength: 6)
                        if !session.isCompleted {
                            Text("00:00")
                                .font(.caption2.monospacedDigit())
                                .hidden()
                                .padding(.horizontal, 6)
                                .padding(.vertical, 2)
                                .overlay {
                                    Text(attributes.startDate, style: .timer)
                                        .font(.caption2.monospacedDigit())
                                        .multilineTextAlignment(.center)
                                        .foregroundStyle(.secondary)
                                }
                                .background(.white.opacity(0.12), in: Capsule())
                        } else if let finishedAt = state.finishedAt {
                            // [T-ios-live-activity-privacy-duration] Static
                            // total run time in the resting state.
                            Text(totalRunTime(from: attributes.startDate, to: finishedAt))
                                .font(.caption2.monospacedDigit())
                                .foregroundStyle(.secondary)
                                .padding(.horizontal, 6)
                                .padding(.vertical, 2)
                                .background(.white.opacity(0.12), in: Capsule())
                        }
                    }
                    if session.isCompleted {
                        HStack(alignment: .top, spacing: 5) {
                            Image(systemName: "checkmark.circle.fill")
                                .font(.caption)
                                .foregroundStyle(.green)
                            if !session.lastMessage.isEmpty {
                                Text(session.lastMessage)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                    .lineLimit(1)
                            }
                        }
                    } else {
                        HStack(spacing: 5) {
                            Image(systemName: session.toolIcon)
                                .font(.caption)
                                .foregroundStyle(.blue)
                                .id(session.toolIcon)
                                .transition(.opacity.animation(.easeInOut(duration: 0.35)))
                            Text(session.toolStatus)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                                .contentTransition(.interpolate)
                            Spacer()
                            // [T-ios-live-activity-privacy-mode] Hide loop count.
                            if !state.privacyMode {
                                Text("Loop \(session.loopIteration)")
                                    .font(.caption2.monospacedDigit())
                                    .foregroundStyle(.tertiary)
                            }
                        }
                    }
                }
            }
        }
        .padding()
    }
}

// MARK: - Minimal Icon (multi-Activity collapsed state)

/// When several Live Activities collapse into per-app minimal dots, this is the
/// single icon iOS shows for ours. It alternates each refresh between the
/// most-recently-invoked tool's icon and the session-count badge, so the user
/// gets both "what's running right now" and "how many tasks" over time.
@available(iOSApplicationExtension 16.2, *)
struct MinimalIconView: View {
    let state: AgentActivityAttributes.ContentState

    var body: some View {
        if state.minimalShowsTool && !state.latestToolIcon.isEmpty {
            Image(systemName: state.latestToolIcon)
                .font(.caption)
                .foregroundStyle(.blue)
                .id(state.latestToolIcon)
                .transition(.opacity.animation(.easeInOut(duration: 0.35)))
        } else {
            ZStack {
                Image(systemName: "list.bullet.circle")
                    .font(.caption)
                Text("\(state.activeSessionCount)")
                    .font(.system(size: 7, weight: .bold).monospacedDigit())
                    .offset(x: 6, y: -6)
            }
        }
    }
}

// MARK: - Compact Trailing

@available(iOSApplicationExtension 16.2, *)
struct CompactTrailingView: View {
    let state: AgentActivityAttributes.ContentState

    var body: some View {
        let icon = state.currentSession?.toolIcon ?? "ellipsis.circle"
        Image(systemName: icon)
            .font(.body)
            .foregroundStyle(.blue)
            .id(icon)
            .transition(.opacity.animation(.easeInOut(duration: 0.35)))
    }
}

// MARK: - Duration formatting

/// [T-ios-live-activity-privacy-duration] Static "total run time" string for
/// the completed resting state (e.g. "3m 12s", "1h 5m"). System formatter →
/// localized unit abbreviations without any catalog dependency.
@available(iOSApplicationExtension 16.2, *)
func totalRunTime(from start: Date, to end: Date) -> String {
    let formatter = DateComponentsFormatter()
    let interval = end.timeIntervalSince(start)
    formatter.allowedUnits = interval >= 3600 ? [.hour, .minute] : [.minute, .second]
    formatter.unitsStyle = .abbreviated
    return formatter.string(from: max(0, interval)) ?? ""
}

// MARK: - ContentState helpers

@available(iOS 16.2, *)
extension AgentActivityAttributes.ContentState {
    var currentSession: LiveSessionSnapshot? {
        guard !sessions.isEmpty else { return nil }
        let idx = carouselIndex % sessions.count
        return sessions[idx]
    }

    var distinctToolIcons: [String] {
        var seen = Set<String>()
        var result: [String] = []
        for s in sessions {
            if seen.insert(s.toolIcon).inserted {
                result.append(s.toolIcon)
            }
        }
        return result
    }
}
