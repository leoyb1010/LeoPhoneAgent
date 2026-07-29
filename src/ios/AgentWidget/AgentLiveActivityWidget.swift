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
        // [T-widget-selfheal] Was `.never`, which meant a snapshot written
        // just before the app got suspended stayed on screen indefinitely —
        // a task that died in the background kept reading "running" forever.
        // Re-reading on a slow cadence lets the view apply its staleness
        // rules even when the app never comes back to push an update.
        completion(Timeline(entries: [entry], policy: .after(Date().addingTimeInterval(10 * 60))))
    }
}

/// [T-widget-localization] Apply the app's in-app language choice inside the
/// widget process. The app switches language by swizzling `Bundle` in ITS
/// process; a widget renders in a separate extension that never sees that, so
/// without this a user running the app in 中文 still got a system-language
/// widget. SwiftUI resolves `LocalizedStringKey` against the environment
/// locale, so setting it here is enough.
private struct LeoWidgetLocaleModifier: ViewModifier {
    private let override = LeoWidgetLanguage.locale

    func body(content: Content) -> some View {
        if let override {
            content.environment(\.locale, override)
        } else {
            content
        }
    }
}

extension View {
    func leoWidgetLocale() -> some View { modifier(LeoWidgetLocaleModifier()) }
}

struct AgentStatusWidget: Widget {
    /// Same string as `LeoWidgetKind.status`, which is the one the app reloads
    /// against — keep exactly one definition so they cannot drift.
    static let kind = LeoWidgetKind.status

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: Self.kind, provider: AgentStatusProvider()) { entry in
            AgentStatusWidgetContainer(entry: entry)
                .leoWidgetLocale()
        }
        .configurationDisplayName("Leo Task Status")
        .description("See active tasks and jump straight into voice input.")
        // [T-widget-accessory] Lock Screen / StandBy families reuse the same
        // snapshot; the app already redacts it when Privacy Mode is on.
        .supportedFamilies([
            .systemSmall, .systemMedium,
            .accessoryCircular, .accessoryRectangular, .accessoryInline,
        ])
    }
}

private struct AgentStatusWidgetContainer: View {
    @Environment(\.widgetFamily) private var family
    let entry: AgentStatusEntry

    /// Accessory (Lock Screen / StandBy) families must NOT get an opaque
    /// container background — the system tints them itself.
    private var isAccessory: Bool {
        family == .accessoryCircular || family == .accessoryRectangular || family == .accessoryInline
    }

    @ViewBuilder
    var body: some View {
        if #available(iOSApplicationExtension 17.0, *) {
            if isAccessory {
                AgentStatusWidgetView(entry: entry)
                    .containerBackground(.clear, for: .widget)
                    .widgetURL(entry.snapshot.destinationURL)
            } else {
                AgentStatusWidgetView(entry: entry)
                    .containerBackground(.fill.tertiary, for: .widget)
                    .widgetURL(entry.snapshot.destinationURL)
            }
        } else {
            if isAccessory {
                AgentStatusWidgetView(entry: entry)
                    .widgetURL(entry.snapshot.destinationURL)
            } else {
                AgentStatusWidgetView(entry: entry)
                    .padding()
                    .background(Color(uiColor: .secondarySystemBackground))
                    .widgetURL(entry.snapshot.destinationURL)
            }
        }
    }
}

private struct AgentStatusWidgetView: View {
    @Environment(\.widgetFamily) private var family
    let entry: AgentStatusEntry

    var body: some View {
        switch family {
        case .accessoryCircular:
            accessoryCircularView
        case .accessoryRectangular:
            accessoryRectangularView
        case .accessoryInline:
            // Inline is a single tinted line; the system ignores styling.
            Label(inlineText, systemImage: entry.snapshot.state.symbol)
        case .systemSmall:
            smallView
        default:
            mediumView
        }
    }

    // MARK: Accessory families [T-widget-accessory]

    private var accessoryCircularView: some View {
        ZStack {
            if #available(iOSApplicationExtension 16.0, *) {
                AccessoryWidgetBackground()
            }
            VStack(spacing: 1) {
                Image(systemName: entry.snapshot.state.symbol)
                    .font(.system(size: 15, weight: .semibold))
                if entry.snapshot.activeCount > 0 {
                    Text("\(entry.snapshot.activeCount)")
                        .font(.system(size: 11, weight: .bold).monospacedDigit())
                }
            }
        }
        .accessibilityLabel("LeoPhoneAgent \(entry.snapshot.primaryText)")
    }

    private var accessoryRectangularView: some View {
        VStack(alignment: .leading, spacing: 1) {
            HStack(spacing: 4) {
                Image(systemName: entry.snapshot.state.symbol)
                    .font(.caption2.weight(.semibold))
                Text(entry.snapshot.primaryText)
                    .font(.caption.weight(.semibold))
                    .lineLimit(1)
            }
            Text(entry.snapshot.secondaryText)
                .font(.caption2)
                .lineLimit(2)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var inlineText: String {
        entry.snapshot.activeCount > 0
            ? "\(entry.snapshot.primaryText) · \(entry.snapshot.activeCount)"
            : entry.snapshot.primaryText
    }

    private var smallView: some View {
        VStack(alignment: .leading, spacing: 8) {
            header
            Spacer(minLength: 2)
            Image(systemName: entry.snapshot.state.symbol)
                .font(.title2.weight(.semibold))
                .foregroundStyle(entry.snapshot.state.tint)
                .widgetAccentable()
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
                    .widgetAccentable()
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

extension AgentWidgetSnapshot {
    /// [T-widget-selfheal] A "running" snapshot that nobody has touched for
    /// this long almost certainly belongs to a task the system suspended or
    /// killed — the app would have written a terminal state otherwise. The
    /// widget says "may be stale" rather than claiming live progress.
    static let stalenessThreshold: TimeInterval = 12 * 60

    var isPossiblyStale: Bool {
        (state == .running || state == .suspended)
            && Date().timeIntervalSince(updatedAt) > Self.stalenessThreshold
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
        if isPossiblyStale { return String(localized: "Status may be stale · Open the app") }
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
                        HStack(spacing: 5) {
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
                            // [T-la-stop-button] Stop, right where the count is.
                            if context.state.activeSessionCount > 0 {
                                StopTasksPill()
                            }
                        }
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

/// [T-la-stop-button] Cancel every running task straight from the Live
/// Activity. The Lock Screen is where a user notices a run they no longer
/// want, and until now the only way to stop it was to unlock, open the app
/// and find the session. Mirrors AudioTogglePill's shape so the two controls
/// sit together without looking bolted on.
@available(iOSApplicationExtension 16.2, *)
struct StopTasksPill: View {
    private var glyph: some View {
        Image(systemName: "stop.fill")
            .font(.caption2.bold())
            .foregroundStyle(.white)
            .frame(width: 20, height: 16)
            .padding(.horizontal, 4)
            .padding(.vertical, 2)
            .background(.red.opacity(0.55), in: Capsule())
    }

    var body: some View {
        if #available(iOSApplicationExtension 17.0, *) {
            Button(intent: StopAllTasksFromWidgetIntent()) {
                glyph
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Stop all tasks")
        } else {
            // Pre-17 has no interactive Live Activity; showing a dead button
            // would be worse than showing nothing.
            EmptyView()
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
                // [T-la-stop-button] Only while work is actually in flight.
                if !state.allCompleted, state.activeSessionCount > 0 {
                    StopTasksPill()
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

// MARK: - Shared deep-link helpers for the launcher widgets

private func quickTaskURL(_ id: String) -> URL {
    let encoded = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id
    return URL(string: "leophoneagent://quick-task/\(encoded)") ?? URL(string: "leophoneagent://new")!
}

private func sessionURL(_ id: String) -> URL {
    let encoded = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id
    return URL(string: "leophoneagent://sessions/\(encoded)") ?? URL(string: "leophoneagent://new")!
}

private let newChatURL = URL(string: "leophoneagent://new")!

// MARK: - Quick-task launcher widget [T-widget-quick-tasks]

private struct QuickTasksEntry: TimelineEntry {
    let date: Date
    let tasks: [WidgetQuickTaskItem]
}

private let quickTasksPlaceholder: [WidgetQuickTaskItem] = [
    .init(id: "morningBriefing", name: String(localized: "Morning Briefing"), symbolName: "sunrise.fill"),
    .init(id: "dailyNews", name: String(localized: "Today's Headlines"), symbolName: "newspaper.fill"),
    .init(id: "clipboardAssistant", name: String(localized: "Clipboard Assistant"), symbolName: "doc.on.clipboard.fill"),
    .init(id: "checkWeather", name: String(localized: "Check Weather"), symbolName: "cloud.sun.fill"),
]

private struct QuickTasksProvider: TimelineProvider {
    func placeholder(in context: Context) -> QuickTasksEntry {
        QuickTasksEntry(date: .now, tasks: quickTasksPlaceholder)
    }

    func getSnapshot(in context: Context, completion: @escaping (QuickTasksEntry) -> Void) {
        let stored = WidgetQuickTasksStore.load()
        completion(QuickTasksEntry(date: .now, tasks: stored.isEmpty ? quickTasksPlaceholder : stored))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<QuickTasksEntry>) -> Void) {
        let stored = WidgetQuickTasksStore.load()
        let entry = QuickTasksEntry(date: .now, tasks: stored.isEmpty ? quickTasksPlaceholder : stored)
        completion(Timeline(entries: [entry], policy: .never))
    }
}

struct QuickTasksWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: LeoWidgetKind.quickTasks, provider: QuickTasksProvider()) { entry in
            QuickTasksWidgetContainer(entry: entry)
                .leoWidgetLocale()
        }
        .configurationDisplayName("Quick Tasks")
        .description("Start a frequent task in one tap, or jump into a new chat.")
        .supportedFamilies([.systemSmall, .systemMedium])
    }
}

private struct QuickTasksWidgetContainer: View {
    @Environment(\.widgetFamily) private var family
    let entry: QuickTasksEntry

    private var smallURL: URL {
        entry.tasks.first.map { quickTaskURL($0.id) } ?? newChatURL
    }

    @ViewBuilder
    var body: some View {
        if #available(iOSApplicationExtension 17.0, *) {
            inner.containerBackground(.fill.tertiary, for: .widget)
        } else {
            inner
                .padding()
                .background(Color(uiColor: .secondarySystemBackground))
        }
    }

    @ViewBuilder
    private var inner: some View {
        if family == .systemSmall {
            // The small family has no room for per-task controls, so the whole
            // tile runs the first task on iOS 17+ and deep-links otherwise.
            if #available(iOSApplicationExtension 17.0, *), let first = entry.tasks.first {
                Button(intent: RunQuickTaskFromWidgetIntent(taskId: first.id)) {
                    QuickTasksSmallView(entry: entry)
                }
                .buttonStyle(.plain)
            } else {
                QuickTasksSmallView(entry: entry)
                    .widgetURL(smallURL)
            }
        } else {
            QuickTasksMediumView(entry: entry)
        }
    }
}

private struct QuickTasksSmallView: View {
    let entry: QuickTasksEntry

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Image(systemName: "sparkles")
                    .foregroundStyle(Color.accentColor)
                Text("LeoPhoneAgent")
                    .font(.caption.weight(.semibold))
                    .lineLimit(1)
            }
            Spacer(minLength: 2)
            if let first = entry.tasks.first {
                Image(systemName: first.symbolName)
                    .font(.title2.weight(.semibold))
                    .foregroundStyle(Color.accentColor)
                Text(first.name)
                    .font(.headline)
                    .lineLimit(2)
                Text(first.lastRunState == .running ? String(localized: "Running in background…") : String(localized: "Tap to run"))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else {
                Image(systemName: "plus.message.fill")
                    .font(.title2.weight(.semibold))
                    .foregroundStyle(Color.accentColor)
                Text("New Chat")
                    .font(.headline)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
    }
}

private struct QuickTasksMediumView: View {
    let entry: QuickTasksEntry

    var body: some View {
        HStack(spacing: 14) {
            Link(destination: newChatURL) {
                VStack(spacing: 6) {
                    Image(systemName: "plus.message.fill")
                        .font(.title3.weight(.semibold))
                    Text("New Chat")
                        .font(.caption.weight(.semibold))
                }
                .foregroundStyle(.white)
                .frame(width: 64, height: 64)
                .background(Color.accentColor, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
            }
            .accessibilityLabel("Start a new chat")

            VStack(spacing: 8) {
                ForEach(rows, id: \.self) { row in
                    HStack(spacing: 8) {
                        ForEach(row) { task in
                            QuickTaskChip(task: task)
                        }
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    /// Up to four tasks, two per row.
    private var rows: [[WidgetQuickTaskItem]] {
        let items = Array(entry.tasks.prefix(4))
        return stride(from: 0, to: items.count, by: 2).map {
            Array(items[$0..<min($0 + 2, items.count)])
        }
    }
}

/// [T-widget-run-in-place] One task chip. On iOS 17+ the chip is a real
/// button that runs the task in the background (the intent is routed to the
/// app's process because it conforms to LiveActivityIntent); on iOS 16 it
/// falls back to the deep link that opens the app with the prompt prefilled.
private struct QuickTaskChip: View {
    let task: WidgetQuickTaskItem

    var body: some View {
        if #available(iOSApplicationExtension 17.0, *) {
            Button(intent: RunQuickTaskFromWidgetIntent(taskId: task.id)) {
                chipLabel
            }
            .buttonStyle(.plain)
        } else {
            Link(destination: quickTaskURL(task.id)) {
                chipLabel
            }
        }
    }

    private var chipLabel: some View {
        HStack(spacing: 5) {
            Image(systemName: runStateSymbol ?? task.symbolName)
                .font(.caption.weight(.semibold))
                .foregroundStyle(runStateTint)
                // [T-widget-tinted-mode] In the Home Screen's tinted / dark
                // icon modes WidgetKit desaturates everything that is not
                // marked accentable, so an unmarked widget collapses into one
                // flat colour and loses its hierarchy entirely.
                .widgetAccentable()
            Text(task.name)
                .font(.caption.weight(.medium))
                .lineLimit(1)
                .minimumScaleFactor(0.8)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 9)
        .background(Color(uiColor: .quaternarySystemFill), in: Capsule())
    }

    /// Only override the task's own glyph while there is something to report.
    private var runStateSymbol: String? {
        switch task.lastRunState {
        case .idle: return nil
        case .running: return "hourglass"
        case .succeeded: return "checkmark.circle.fill"
        case .failed: return "exclamationmark.triangle.fill"
        }
    }

    private var runStateTint: Color {
        switch task.lastRunState {
        case .idle, .running: return Color.accentColor
        case .succeeded: return .green
        case .failed: return .orange
        }
    }
}

// MARK: - Recent sessions widget [T-widget-recent-sessions]

private struct RecentSessionsEntry: TimelineEntry {
    let date: Date
    let sessions: [WidgetRecentSessionItem]
}

private struct RecentSessionsProvider: TimelineProvider {
    func placeholder(in context: Context) -> RecentSessionsEntry {
        RecentSessionsEntry(date: .now, sessions: [
            .init(id: "a", title: String(localized: "Trip planning"), updatedAt: .now.addingTimeInterval(-600)),
            .init(id: "b", title: String(localized: "Weekly health report"), updatedAt: .now.addingTimeInterval(-7200)),
            .init(id: "c", title: String(localized: "Web page summary"), updatedAt: .now.addingTimeInterval(-86400)),
        ])
    }

    func getSnapshot(in context: Context, completion: @escaping (RecentSessionsEntry) -> Void) {
        completion(RecentSessionsEntry(date: .now, sessions: WidgetRecentSessionsStore.load()))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<RecentSessionsEntry>) -> Void) {
        completion(Timeline(
            entries: [RecentSessionsEntry(date: .now, sessions: WidgetRecentSessionsStore.load())],
            policy: .never
        ))
    }
}

struct RecentSessionsWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: LeoWidgetKind.recentSessions, provider: RecentSessionsProvider()) { entry in
            RecentSessionsWidgetContainer(entry: entry)
                .leoWidgetLocale()
        }
        .configurationDisplayName("Recent Sessions")
        .description("Jump back into a recent chat, or start a new one.")
        .supportedFamilies([.systemMedium, .systemLarge])
    }
}

private struct RecentSessionsWidgetContainer: View {
    let entry: RecentSessionsEntry

    @ViewBuilder
    var body: some View {
        if #available(iOSApplicationExtension 17.0, *) {
            RecentSessionsView(entry: entry)
                .containerBackground(.fill.tertiary, for: .widget)
        } else {
            RecentSessionsView(entry: entry)
                .padding()
                .background(Color(uiColor: .secondarySystemBackground))
        }
    }
}

private struct RecentSessionsView: View {
    @Environment(\.widgetFamily) private var family
    let entry: RecentSessionsEntry

    private var visibleSessions: [WidgetRecentSessionItem] {
        Array(entry.sessions.prefix(family == .systemLarge ? 7 : 3))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Image(systemName: "sparkles")
                    .foregroundStyle(Color.accentColor)
                Text("Recent Sessions")
                    .font(.caption.weight(.semibold))
                Spacer(minLength: 0)
                Link(destination: newChatURL) {
                    Image(systemName: "plus.circle.fill")
                        .font(.title3)
                        .foregroundStyle(Color.accentColor)
                }
                .accessibilityLabel("Start a new chat")
            }

            if visibleSessions.isEmpty {
                Spacer()
                Text("No sessions yet. Tap + to start one.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity)
                Spacer()
            } else {
                ForEach(visibleSessions) { session in
                    Link(destination: sessionURL(session.id)) {
                        HStack(spacing: 8) {
                            Image(systemName: "bubble.left.fill")
                                .font(.caption)
                                .foregroundStyle(Color.accentColor)
                            Text(session.title)
                                .font(.subheadline.weight(.medium))
                                .lineLimit(1)
                            Spacer(minLength: 4)
                            Text(session.updatedAt, style: .relative)
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                        }
                        .padding(.vertical, family == .systemLarge ? 4 : 2)
                        .contentShape(Rectangle())
                    }
                }
                Spacer(minLength: 0)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}

// MARK: - Daily briefing widget [T-widget-briefing]

private struct BriefingEntry: TimelineEntry {
    let date: Date
    let briefing: WidgetBriefing?
}

private struct BriefingProvider: TimelineProvider {
    private var sample: WidgetBriefing {
        WidgetBriefing(
            generatedAt: .now,
            taskName: String(localized: "Morning Briefing"),
            sessionId: "preview",
            summary: String(localized: "Partly cloudy clearing later, 18–26°C — good for going out.\nProduct review at 10:00.\nHeadline: a new on-device model was announced.")
        )
    }

    func placeholder(in context: Context) -> BriefingEntry {
        BriefingEntry(date: .now, briefing: sample)
    }

    func getSnapshot(in context: Context, completion: @escaping (BriefingEntry) -> Void) {
        completion(BriefingEntry(date: .now, briefing: WidgetBriefingStore.load() ?? sample))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<BriefingEntry>) -> Void) {
        completion(Timeline(entries: [BriefingEntry(date: .now, briefing: WidgetBriefingStore.load())], policy: .never))
    }
}

struct BriefingWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: LeoWidgetKind.briefing, provider: BriefingProvider()) { entry in
            BriefingWidgetContainer(entry: entry)
                .leoWidgetLocale()
        }
        .configurationDisplayName("Daily Briefing")
        .description("Shows the result of the agent's latest task, and regenerates it in one tap.")
        .supportedFamilies([.systemMedium, .systemLarge])
    }
}

private struct BriefingWidgetContainer: View {
    let entry: BriefingEntry

    @ViewBuilder
    var body: some View {
        if #available(iOSApplicationExtension 17.0, *) {
            BriefingWidgetView(entry: entry)
                .containerBackground(.fill.tertiary, for: .widget)
        } else {
            BriefingWidgetView(entry: entry)
                .padding()
                .background(Color(uiColor: .secondarySystemBackground))
        }
    }
}

private struct BriefingWidgetView: View {
    @Environment(\.widgetFamily) private var family
    let entry: BriefingEntry

    /// Which quick task the "regenerate" control runs. Falls back to the
    /// morning-briefing built-in when the stored card predates the id.
    private static let briefingTaskId = "morningBriefing"

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            header
            if let briefing = entry.briefing {
                Text(briefing.summary)
                    .font(family == .systemLarge ? .subheadline : .caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(family == .systemLarge ? 9 : 4)
                    .frame(maxWidth: .infinity, alignment: .leading)
                Spacer(minLength: 0)
                HStack {
                    Text(briefing.generatedAt, style: .relative)
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                    Spacer()
                    Link("Read more", destination: sessionURL(briefing.sessionId))
                        .font(.caption2.weight(.semibold))
                }
            } else {
                Spacer(minLength: 0)
                Text("No briefing yet. Tap below to have the agent generate one now, or schedule it every morning in Shortcuts.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Spacer(minLength: 0)
                regenerateControl
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    private var header: some View {
        HStack(spacing: 6) {
            Image(systemName: "sunrise.fill")
                .foregroundStyle(Color.accentColor)
            Text(entry.briefing?.taskName ?? String(localized: "Daily Briefing"))
                .font(.caption.weight(.semibold))
                .lineLimit(1)
            if let briefing = entry.briefing, !briefing.isFromToday {
                Text("· Not today")
                    .font(.caption2)
                    .foregroundStyle(.orange)
            }
            Spacer(minLength: 0)
            if entry.briefing != nil {
                regenerateControl
            }
        }
    }

    @ViewBuilder
    private var regenerateControl: some View {
        if #available(iOSApplicationExtension 17.0, *) {
            Button(intent: RunQuickTaskFromWidgetIntent(taskId: Self.briefingTaskId)) {
                Label("Generate", systemImage: "arrow.clockwise")
                    .font(.caption2.weight(.semibold))
                    .labelStyle(.titleAndIcon)
                    .padding(.horizontal, 9)
                    .padding(.vertical, 5)
                    .background(Color.accentColor.opacity(0.15), in: Capsule())
            }
            .buttonStyle(.plain)
        } else {
            Link(destination: quickTaskURL(Self.briefingTaskId)) {
                Label("Generate", systemImage: "arrow.clockwise")
                    .font(.caption2.weight(.semibold))
            }
        }
    }
}

// MARK: - Today overview widget [T-widget-today]

private struct TodayEntry: TimelineEntry {
    let date: Date
    let usage: WidgetUsageSummary
}

private struct TodayProvider: TimelineProvider {
    private var sample: WidgetUsageSummary {
        WidgetUsageSummary(
            updatedAt: .now,
            todayTasks: 6,
            todayTokens: 128_400,
            cacheHitRate: 71.5,
            topModel: "Claude",
            recentDays: (0..<7).map {
                .init(day: Date().addingTimeInterval(Double(-$0) * 86400),
                      tokens: [42, 88, 51, 130, 76, 99, 128][$0] * 1000)
            }.reversed()
        )
    }

    func placeholder(in context: Context) -> TodayEntry { TodayEntry(date: .now, usage: sample) }

    func getSnapshot(in context: Context, completion: @escaping (TodayEntry) -> Void) {
        let stored = WidgetUsageStore.load()
        completion(TodayEntry(date: .now, usage: stored.updatedAt == .distantPast ? sample : stored))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<TodayEntry>) -> Void) {
        completion(Timeline(entries: [TodayEntry(date: .now, usage: WidgetUsageStore.load())], policy: .never))
    }
}

struct TodayOverviewWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: LeoWidgetKind.todayOverview, provider: TodayProvider()) { entry in
            TodayWidgetContainer(entry: entry)
                .leoWidgetLocale()
        }
        .configurationDisplayName("Today at a Glance")
        .description("Tasks run today, tokens used, and cache hit rate.")
        .supportedFamilies([.systemSmall, .systemMedium])
    }
}

private struct TodayWidgetContainer: View {
    let entry: TodayEntry

    @ViewBuilder
    var body: some View {
        if #available(iOSApplicationExtension 17.0, *) {
            TodayWidgetView(entry: entry)
                .containerBackground(.fill.tertiary, for: .widget)
                .widgetURL(URL(string: "leophoneagent://settings/usage")!)
        } else {
            TodayWidgetView(entry: entry)
                .padding()
                .background(Color(uiColor: .secondarySystemBackground))
                .widgetURL(URL(string: "leophoneagent://settings/usage")!)
        }
    }
}

private struct TodayWidgetView: View {
    @Environment(\.widgetFamily) private var family
    let entry: TodayEntry

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Image(systemName: "chart.bar.fill")
                    .widgetAccentable()
                    .foregroundStyle(Color.accentColor)
                Text("Today")
                    .font(.caption.weight(.semibold))
                Spacer(minLength: 0)
            }

            HStack(alignment: .lastTextBaseline, spacing: 4) {
                Text("\(entry.usage.todayTasks)")
                    .font(.title.weight(.bold).monospacedDigit())
                Text("tasks")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            HStack(alignment: .lastTextBaseline, spacing: 4) {
                Text(compactTokens(entry.usage.todayTokens))
                    .font(.title3.weight(.semibold).monospacedDigit())
                Text("Token")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }

            if family != .systemSmall {
                Spacer(minLength: 2)
                sparkline
                HStack(spacing: 10) {
                    if entry.usage.cacheHitRate > 0 {
                        Label(String(format: String(localized: "Cache %.0f%%"), entry.usage.cacheHitRate), systemImage: "bolt.fill")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                    if !entry.usage.topModel.isEmpty {
                        Text(entry.usage.topModel)
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                }
            }
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    /// Seven-day token bars. Heights are relative to the busiest day so the
    /// shape stays readable regardless of absolute volume.
    private var sparkline: some View {
        let days = entry.usage.recentDays.suffix(7)
        let peak = max(days.map(\.tokens).max() ?? 1, 1)
        return HStack(alignment: .bottom, spacing: 3) {
            ForEach(Array(days.enumerated()), id: \.offset) { _, bucket in
                RoundedRectangle(cornerRadius: 1.5, style: .continuous)
                    .fill(Color.accentColor.opacity(0.65))
                    .frame(height: max(3, 26 * CGFloat(bucket.tokens) / CGFloat(peak)))
            }
        }
        .frame(height: 26)
    }

    private func compactTokens(_ value: Int) -> String {
        if value >= 1_000_000 { return String(format: "%.1fM", Double(value) / 1_000_000) }
        if value >= 1_000 { return String(format: "%.1fK", Double(value) / 1_000) }
        return "\(value)"
    }
}

// MARK: - Memory lens widget [T-widget-memory]

private struct MemoryEntry: TimelineEntry {
    let date: Date
    let snapshot: WidgetMemorySnapshot
}

private struct MemoryProvider: TimelineProvider {
    private var sample: WidgetMemorySnapshot {
        WidgetMemorySnapshot(
            updatedAt: .now,
            todayCount: 3,
            latestEntry: String(localized: "Preference: weekly reports as bullet points, conclusion first."),
            isRedacted: false
        )
    }

    func placeholder(in context: Context) -> MemoryEntry { MemoryEntry(date: .now, snapshot: sample) }

    func getSnapshot(in context: Context, completion: @escaping (MemoryEntry) -> Void) {
        let stored = WidgetMemoryStore.load()
        completion(MemoryEntry(date: .now, snapshot: stored.updatedAt == .distantPast ? sample : stored))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<MemoryEntry>) -> Void) {
        completion(Timeline(entries: [MemoryEntry(date: .now, snapshot: WidgetMemoryStore.load())], policy: .never))
    }
}

struct MemoryWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: LeoWidgetKind.memory, provider: MemoryProvider()) { entry in
            MemoryWidgetContainer(entry: entry)
                .leoWidgetLocale()
        }
        .configurationDisplayName("Memory Card")
        .description("What the agent remembered today.")
        .supportedFamilies([.systemSmall, .systemMedium, .accessoryRectangular])
    }
}

private struct MemoryWidgetContainer: View {
    @Environment(\.widgetFamily) private var family
    let entry: MemoryEntry

    private var isAccessory: Bool { family == .accessoryRectangular }

    @ViewBuilder
    var body: some View {
        if #available(iOSApplicationExtension 17.0, *) {
            MemoryWidgetView(entry: entry)
                .containerBackground(isAccessory ? AnyShapeStyle(.clear) : AnyShapeStyle(.fill.tertiary), for: .widget)
                .widgetURL(URL(string: "leophoneagent://settings/memory")!)
        } else {
            MemoryWidgetView(entry: entry)
                .padding(isAccessory ? 0 : 16)
                .background(isAccessory ? Color.clear : Color(uiColor: .secondarySystemBackground))
                .widgetURL(URL(string: "leophoneagent://settings/memory")!)
        }
    }
}

private struct MemoryWidgetView: View {
    @Environment(\.widgetFamily) private var family
    let entry: MemoryEntry

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(spacing: 5) {
                Image(systemName: "brain.head.profile")
                    .foregroundStyle(family == .accessoryRectangular ? Color.primary : Color.accentColor)
                Text(entry.snapshot.todayCount > 0 ? String(localized: "Memories today \(entry.snapshot.todayCount)") : String(localized: "Memory"))
                    .font(.caption.weight(.semibold))
                Spacer(minLength: 0)
            }
            if entry.snapshot.isRedacted {
                Text("Hidden (Privacy Mode)")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            } else if entry.snapshot.latestEntry.isEmpty {
                Text("No memories yet. Ask the agent to remember something and it will show up here.")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(3)
            } else {
                Text(entry.snapshot.latestEntry)
                    .font(family == .systemSmall ? .caption2 : .caption)
                    .foregroundStyle(family == .accessoryRectangular ? .primary : .secondary)
                    .lineLimit(family == .accessoryRectangular ? 2 : 4)
            }
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}

// MARK: - iPad Agent console (systemExtraLarge) [T-widget-ipad-console]

private struct ConsoleEntry: TimelineEntry {
    let date: Date
    let status: AgentWidgetSnapshot
    let tasks: [WidgetQuickTaskItem]
    let sessions: [WidgetRecentSessionItem]
    let briefing: WidgetBriefing?
    let usage: WidgetUsageSummary
    let memory: WidgetMemorySnapshot
}

private struct ConsoleProvider: TimelineProvider {
    private func current() -> ConsoleEntry {
        ConsoleEntry(
            date: .now,
            status: AgentWidgetSnapshotStore.load(),
            tasks: WidgetQuickTasksStore.load(),
            sessions: WidgetRecentSessionsStore.load(),
            briefing: WidgetBriefingStore.load(),
            usage: WidgetUsageStore.load(),
            memory: WidgetMemoryStore.load()
        )
    }

    func placeholder(in context: Context) -> ConsoleEntry { current() }

    func getSnapshot(in context: Context, completion: @escaping (ConsoleEntry) -> Void) {
        completion(current())
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<ConsoleEntry>) -> Void) {
        // See [T-widget-selfheal] on AgentStatusProvider.
        completion(Timeline(entries: [current()], policy: .after(Date().addingTimeInterval(10 * 60))))
    }
}

/// iPad-only quadrant dashboard. `systemExtraLarge` exists solely on iPadOS,
/// so this configuration simply never offers itself on iPhone.
struct AgentConsoleWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: LeoWidgetKind.iPadConsole, provider: ConsoleProvider()) { entry in
            ConsoleWidgetContainer(entry: entry)
                .leoWidgetLocale()
        }
        .configurationDisplayName("Agent Console")
        .description("iPad only: task status, quick tasks, recent sessions and today's briefing in one panel.")
        .supportedFamilies([.systemExtraLarge])
    }
}

private struct ConsoleWidgetContainer: View {
    let entry: ConsoleEntry

    @ViewBuilder
    var body: some View {
        if #available(iOSApplicationExtension 17.0, *) {
            ConsoleWidgetView(entry: entry)
                .containerBackground(.fill.tertiary, for: .widget)
        } else {
            ConsoleWidgetView(entry: entry)
                .padding()
                .background(Color(uiColor: .secondarySystemBackground))
        }
    }
}

private struct ConsoleWidgetView: View {
    let entry: ConsoleEntry

    var body: some View {
        VStack(spacing: 12) {
            HStack(spacing: 12) {
                quadrant { statusPane }
                quadrant { quickTaskPane }
            }
            HStack(spacing: 12) {
                quadrant { sessionsPane }
                quadrant { usagePane }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func quadrant<Content: View>(@ViewBuilder content: () -> Content) -> some View {
        content()
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .padding(12)
            .background(Color(uiColor: .tertiarySystemFill), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
    }

    // Top-left: live status, plus the controls that matter while a task runs.
    private var statusPane: some View {
        VStack(alignment: .leading, spacing: 8) {
            paneHeader(String(localized: "Status"), systemImage: "sparkles")
            HStack(alignment: .top, spacing: 8) {
                Label(entry.status.primaryText, systemImage: entry.status.state.symbol)
                    .font(.title3.weight(.semibold))
                    .foregroundStyle(entry.status.state.tint)
                    .lineLimit(2)
                Spacer(minLength: 0)
                if entry.status.activeCount > 1 {
                    Text("\(entry.status.activeCount)")
                        .font(.caption.monospacedDigit().weight(.bold))
                        .foregroundStyle(.white)
                        .padding(.horizontal, 7)
                        .padding(.vertical, 3)
                        .background(entry.status.state.tint, in: Capsule())
                }
            }
            Text(entry.status.secondaryText)
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(2)
            Spacer(minLength: 0)
            HStack(spacing: 8) {
                // While work is in flight the most useful control is "stop",
                // so it replaces the new-chat button rather than crowding it.
                if isRunning {
                    stopControl
                } else {
                    Link(destination: newChatURL) {
                        Label("New Chat", systemImage: "plus.message.fill")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.white)
                            .padding(.horizontal, 12)
                            .padding(.vertical, 8)
                            .background(Color.accentColor, in: Capsule())
                    }
                }
                Link(destination: URL(string: "leophoneagent://voice")!) {
                    Image(systemName: "mic.fill")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.white)
                        .padding(8)
                        .background(Color.accentColor, in: Circle())
                }
                if isRunning, !entry.status.sessionId.isEmpty {
                    Link(destination: sessionURL(entry.status.sessionId)) {
                        Image(systemName: "arrow.up.forward")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(Color.accentColor)
                            .padding(8)
                            .background(Color.accentColor.opacity(0.15), in: Circle())
                    }
                    .accessibilityLabel("Open the running session")
                }
            }
        }
    }

    private var isRunning: Bool {
        entry.status.state == .running || entry.status.state == .suspended
    }

    @ViewBuilder
    private var stopControl: some View {
        if #available(iOSApplicationExtension 17.0, *) {
            Button(intent: StopAllTasksFromWidgetIntent()) {
                Label("Stop", systemImage: "stop.fill")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.white)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .background(Color.red, in: Capsule())
            }
            .buttonStyle(.plain)
        } else {
            Link(destination: newChatURL) {
                Label("New Chat", systemImage: "plus.message.fill")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.white)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .background(Color.accentColor, in: Capsule())
            }
        }
    }

    // Top-right: six runnable tasks.
    private var quickTaskPane: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 5) {
                Image(systemName: "bolt.fill")
                    .widgetAccentable()
                    .font(.caption2)
                    .foregroundStyle(Color.accentColor)
                Text("Quick Tasks")
                    .font(.caption.weight(.semibold))
                Spacer(minLength: 0)
                briefingGenerateControl
            }
            let items = Array(entry.tasks.prefix(6))
            if items.isEmpty {
                Text("Open the app once and your quick tasks will appear here.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else {
                ForEach(stride(from: 0, to: items.count, by: 2).map { Array(items[$0..<min($0 + 2, items.count)]) }, id: \.self) { row in
                    HStack(spacing: 8) {
                        ForEach(row) { task in
                            QuickTaskChip(task: task)
                        }
                        if row.count == 1 { Spacer() }
                    }
                }
            }
            Spacer(minLength: 0)
        }
    }

    // Bottom-left: recent sessions.
    private var sessionsPane: some View {
        VStack(alignment: .leading, spacing: 6) {
            paneHeader(String(localized: "Recent Sessions"), systemImage: "bubble.left.fill")
            if entry.sessions.isEmpty {
                Text("No sessions yet.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else {
                ForEach(Array(entry.sessions.prefix(5))) { session in
                    // Mark the session that is currently working so the pane
                    // doubles as "where is the agent right now".
                    let isLive = session.id == entry.status.sessionId && isRunning
                    Link(destination: sessionURL(session.id)) {
                        HStack(spacing: 6) {
                            Circle()
                                .fill(isLive ? entry.status.state.tint : Color.accentColor.opacity(0.7))
                                .frame(width: isLive ? 6 : 5, height: isLive ? 6 : 5)
                            Text(session.title)
                                .font(.caption)
                                .fontWeight(isLive ? .semibold : .regular)
                                .lineLimit(1)
                            Spacer(minLength: 4)
                            if isLive {
                                Image(systemName: "waveform")
                                    .font(.caption2)
                                    .foregroundStyle(entry.status.state.tint)
                            } else {
                                Text(session.updatedAt, style: .relative)
                                    .font(.caption2)
                                    .foregroundStyle(.secondary)
                                    .lineLimit(1)
                            }
                        }
                        .contentShape(Rectangle())
                    }
                }
            }
            Spacer(minLength: 0)
        }
    }

    // Bottom-right: usage. Numbers are always available (they come straight
    // from the token ledger), which makes this pane useful even when no task
    // has produced a briefing yet.
    private var usagePane: some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack(spacing: 5) {
                Image(systemName: "chart.bar.fill")
                    .widgetAccentable()
                    .font(.caption2)
                    .foregroundStyle(Color.accentColor)
                Text("Today's usage")
                    .font(.caption.weight(.semibold))
                Spacer(minLength: 0)
                if !entry.usage.topModel.isEmpty {
                    Text(entry.usage.topModel)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
            }

            HStack(alignment: .top, spacing: 14) {
                metric(String(localized: "Tasks"), value: "\(entry.usage.todayTasks)")
                metric("Token", value: compactTokens(entry.usage.todayTokens))
                if entry.usage.cacheHitRate > 0 {
                    metric(String(localized: "Cache"), value: String(format: "%.0f%%", entry.usage.cacheHitRate))
                }
                Spacer(minLength: 0)
            }

            // 7-day trend
            if !entry.usage.recentDays.isEmpty {
                VStack(alignment: .leading, spacing: 3) {
                    trendChart
                    Text("Tokens, last 7 days")
                        .font(.system(size: 9))
                        .foregroundStyle(.tertiary)
                }
            }

            Spacer(minLength: 0)

            // Briefing demoted to a single line: nice when present, never the
            // reason the pane looks empty.
            if let briefing = entry.briefing {
                Link(destination: sessionURL(briefing.sessionId)) {
                    HStack(spacing: 5) {
                        Image(systemName: "sunrise.fill")
                            .font(.system(size: 9))
                            .foregroundStyle(Color.accentColor)
                        Text(briefing.summary.replacingOccurrences(of: "\n", with: " "))
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                            .lineLimit(2)
                    }
                    .contentShape(Rectangle())
                }
            } else if entry.memory.todayCount > 0 {
                HStack(spacing: 5) {
                    Image(systemName: "brain.head.profile")
                        .font(.system(size: 9))
                        .foregroundStyle(Color.accentColor)
                    Text("\(entry.memory.todayCount) new memories today")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
        }
    }

    private func metric(_ label: String, value: String) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(value)
                .font(.title3.weight(.bold).monospacedDigit())
            Text(label)
                .font(.system(size: 9))
                .foregroundStyle(.secondary)
        }
    }

    /// Relative bars, tallest = busiest day, with today tinted.
    private var trendChart: some View {
        let days = Array(entry.usage.recentDays.suffix(7))
        let peak = max(days.map(\.tokens).max() ?? 1, 1)
        return HStack(alignment: .bottom, spacing: 4) {
            ForEach(Array(days.enumerated()), id: \.offset) { index, bucket in
                RoundedRectangle(cornerRadius: 2, style: .continuous)
                    .fill(index == days.count - 1
                          ? Color.accentColor
                          : Color.accentColor.opacity(0.35))
                    .frame(height: max(3, 34 * CGFloat(bucket.tokens) / CGFloat(peak)))
            }
        }
        .frame(height: 34)
    }

    private func compactTokens(_ value: Int) -> String {
        if value >= 1_000_000 { return String(format: "%.1fM", Double(value) / 1_000_000) }
        if value >= 1_000 { return String(format: "%.1fK", Double(value) / 1_000) }
        return "\(value)"
    }

    /// Prefer a task literally named like a briefing; otherwise fall back to
    /// the built-in id so the button still works on a customized catalog.
    private var briefingTask: WidgetQuickTaskItem? {
        entry.tasks.first { $0.id == "morningBriefing" } ?? entry.tasks.first
    }

    private var briefingTaskIsRunning: Bool {
        briefingTask?.lastRunState == .running
    }

    @ViewBuilder
    private var briefingGenerateControl: some View {
        let taskId = briefingTask?.id ?? "morningBriefing"
        if #available(iOSApplicationExtension 17.0, *) {
            Button(intent: RunQuickTaskFromWidgetIntent(taskId: taskId)) {
                Label(briefingTaskIsRunning ? String(localized: "Generating") : String(localized: "Generate"),
                      systemImage: briefingTaskIsRunning ? "hourglass" : "arrow.clockwise")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(Color.accentColor)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 4)
                    .background(Color.accentColor.opacity(0.15), in: Capsule())
            }
            .buttonStyle(.plain)
            .disabled(briefingTaskIsRunning)
        } else {
            Link(destination: quickTaskURL(taskId)) {
                Label("Generate", systemImage: "arrow.clockwise")
                    .font(.caption2.weight(.semibold))
            }
        }
    }

    private func paneHeader(_ title: String, systemImage: String) -> some View {
        HStack(spacing: 5) {
            Image(systemName: systemImage)
                .font(.caption2)
                .foregroundStyle(Color.accentColor)
            Text(title)
                .font(.caption.weight(.semibold))
                .lineLimit(1)
            Spacer(minLength: 0)
        }
    }
}

// MARK: - Control Center controls [T-control-center]

/// iOS 18 Control Center / Lock Screen / Action Button controls. Each is a
/// thin launcher — the heavy lifting stays in the app, reached through
/// WidgetIntentBridge.
@available(iOSApplicationExtension 18.0, *)
struct NewChatControl: ControlWidget {
    var body: some ControlWidgetConfiguration {
        StaticControlConfiguration(kind: "LeoNewChatControl") {
            ControlWidgetButton(action: OpenNewChatControlIntent()) {
                Label("New Chat", systemImage: "plus.message.fill")
            }
        }
        .displayName("New Chat")
        .description("Start a new chat in LeoPhoneAgent.")
    }
}

@available(iOSApplicationExtension 18.0, *)
struct VoiceChatControl: ControlWidget {
    var body: some ControlWidgetConfiguration {
        StaticControlConfiguration(kind: "LeoVoiceChatControl") {
            ControlWidgetButton(action: StartVoiceControlIntent()) {
                Label("Voice Chat", systemImage: "mic.fill")
            }
        }
        .displayName("Voice Chat")
        .description("Open LeoPhoneAgent and start voice input.")
    }
}

@available(iOSApplicationExtension 18.0, *)
struct CameraChatControl: ControlWidget {
    var body: some ControlWidgetConfiguration {
        StaticControlConfiguration(kind: "LeoCameraChatControl") {
            ControlWidgetButton(action: StartCameraControlIntent()) {
                Label("Camera Chat", systemImage: "camera.fill")
            }
        }
        .displayName("Camera Chat")
        .description("Open LeoPhoneAgent and open the camera.")
    }
}

// MARK: - Artifacts widget [T-widget-artifacts]

private struct ArtifactsEntry: TimelineEntry {
    let date: Date
    let artifacts: [WidgetArtifactItem]
}

private struct ArtifactsProvider: TimelineProvider {
    private var sample: [WidgetArtifactItem] {
        [
            .init(id: "a", title: String(localized: "weekly-report.md"), kind: "document", sessionId: "s",
                  updatedAt: .now.addingTimeInterval(-900), symbolName: "doc.text.fill"),
            .init(id: "b", title: String(localized: "trend-chart.png"), kind: "image", sessionId: "s",
                  updatedAt: .now.addingTimeInterval(-3600), symbolName: "photo.fill"),
            .init(id: "c", title: String(localized: "scraper.py"), kind: "code", sessionId: "s",
                  updatedAt: .now.addingTimeInterval(-7200), symbolName: "chevron.left.forwardslash.chevron.right"),
            .init(id: "d", title: String(localized: "narration.m4a"), kind: "audio", sessionId: "s",
                  updatedAt: .now.addingTimeInterval(-86400), symbolName: "waveform"),
        ]
    }

    func placeholder(in context: Context) -> ArtifactsEntry {
        ArtifactsEntry(date: .now, artifacts: sample)
    }

    func getSnapshot(in context: Context, completion: @escaping (ArtifactsEntry) -> Void) {
        let stored = WidgetArtifactsStore.load()
        completion(ArtifactsEntry(date: .now, artifacts: stored.isEmpty ? sample : stored))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<ArtifactsEntry>) -> Void) {
        completion(Timeline(
            entries: [ArtifactsEntry(date: .now, artifacts: WidgetArtifactsStore.load())],
            policy: .after(Date().addingTimeInterval(10 * 60))
        ))
    }
}

struct ArtifactsWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: LeoWidgetKind.artifacts, provider: ArtifactsProvider()) { entry in
            ArtifactsWidgetContainer(entry: entry)
                .leoWidgetLocale()
                // [T-widget-small-link] systemSmall has exactly one tap target
                // and SwiftUI ignores per-row `Link` there, so the small size
                // used to just open the app with no destination at all. Give
                // the whole tile the newest artifact's session.
                .widgetURL(entry.artifacts.first.map { sessionURL($0.sessionId) } ?? newChatURL)
        }
        .configurationDisplayName("Recent artifacts")
        .description("Files, images and audio the agent produced. Tap to return to the session that made them.")
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge])
    }
}

private struct ArtifactsWidgetContainer: View {
    let entry: ArtifactsEntry

    @ViewBuilder
    var body: some View {
        if #available(iOSApplicationExtension 17.0, *) {
            ArtifactsWidgetView(entry: entry)
                .containerBackground(.fill.tertiary, for: .widget)
        } else {
            ArtifactsWidgetView(entry: entry)
                .padding()
                .background(Color(uiColor: .secondarySystemBackground))
        }
    }
}

private struct ArtifactsWidgetView: View {
    @Environment(\.widgetFamily) private var family
    let entry: ArtifactsEntry

    private var visible: [WidgetArtifactItem] {
        let cap: Int
        switch family {
        case .systemSmall: cap = 3
        case .systemLarge: cap = 8
        default: cap = 4
        }
        return Array(entry.artifacts.prefix(cap))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack(spacing: 6) {
                Image(systemName: "shippingbox.fill")
                    .foregroundStyle(Color.accentColor)
                Text("Recent artifacts")
                    .font(.caption.weight(.semibold))
                Spacer(minLength: 0)
                if entry.artifacts.count > visible.count {
                    Text("+\(entry.artifacts.count - visible.count)")
                        .font(.caption2.monospacedDigit())
                        .foregroundStyle(.secondary)
                }
            }

            if visible.isEmpty {
                Spacer(minLength: 0)
                Text("No artifacts yet. Files the Agent generates will show up here.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Spacer(minLength: 0)
            } else {
                ForEach(visible) { item in
                    Link(destination: sessionURL(item.sessionId)) {
                        HStack(spacing: 7) {
                            Image(systemName: item.symbolName)
                                .widgetAccentable()
                                .font(.caption)
                                .frame(width: 16)
                                .foregroundStyle(Color.accentColor)
                            Text(item.title)
                                .font(family == .systemSmall ? .caption2 : .caption)
                                .lineLimit(1)
                                .truncationMode(.middle)
                            Spacer(minLength: 4)
                            if family != .systemSmall {
                                Text(item.updatedAt, style: .relative)
                                    .font(.caption2)
                                    .foregroundStyle(.secondary)
                                    .lineLimit(1)
                            }
                        }
                        .contentShape(Rectangle())
                    }
                }
                Spacer(minLength: 0)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}
