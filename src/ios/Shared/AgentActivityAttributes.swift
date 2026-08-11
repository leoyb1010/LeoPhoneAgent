import ActivityKit
import AppIntents
import Foundation

/// A privacy-aware, app-group snapshot for the ordinary Home Screen widget.
/// WidgetKit decides when to render this value; second-by-second progress stays
/// in the Live Activity, which is the system surface intended for live state.
struct AgentWidgetSnapshot: Codable, Hashable {
    enum State: String, Codable {
        case idle
        case running
        case suspended
        case completed
        case failed
    }

    var updatedAt: Date
    var state: State
    var activeCount: Int
    var sessionId: String
    var title: String
    var status: String
    var toolIcon: String
    var loopIteration: Int
    var privacyMode: Bool

    static let idle = AgentWidgetSnapshot(
        updatedAt: .distantPast,
        state: .idle,
        activeCount: 0,
        sessionId: "",
        title: "",
        status: "",
        toolIcon: "sparkles",
        loopIteration: 0,
        privacyMode: true
    )
}

/// Widget kind identifiers shared between the main app (WidgetCenter reloads)
/// and the widget extension (configuration kinds). Keep in sync with
/// AgentStatusWidget.kind which predates this enum.
enum LeoWidgetKind {
    static let status = "LeoAgentStatusWidget"
    static let quickTasks = "LeoQuickTasksWidget"
    static let recentSessions = "LeoRecentSessionsWidget"
    static let briefing = "LeoBriefingWidget"
    static let todayOverview = "LeoTodayOverviewWidget"
    static let memory = "LeoMemoryWidget"
    static let iPadConsole = "LeoAgentConsoleWidget"
    static let artifacts = "LeoArtifactsWidget"
}

/// [T-widget-localization] The app's in-app language picker works by swizzling
/// `Bundle.localizedString` in the app process. A widget renders in a separate
/// extension process that never sees that swizzle, so without this the widget
/// always followed the *system* language even when the app was set to another.
///
/// The app mirrors its choice here; each widget view applies it as
/// `.environment(\.locale, …)`, which is what SwiftUI resolves
/// `LocalizedStringKey` against.
enum LeoWidgetLanguage {
    static let storageKey = "leo.appLanguage.v1"

    /// Empty string means "follow the system", matching the app's own
    /// `appLanguage` convention.
    static func save(_ code: String) {
        guard let defaults = UserDefaults(suiteName: AgentWidgetSnapshotStore.appGroupIdentifier) else { return }
        defaults.set(code, forKey: storageKey)
    }

    /// nil = follow the system locale.
    static var locale: Locale? {
        guard let defaults = UserDefaults(suiteName: AgentWidgetSnapshotStore.appGroupIdentifier),
              let code = defaults.string(forKey: storageKey), !code.isEmpty else { return nil }
        return Locale(identifier: code)
    }

    /// [T-widget-string-localized] `String(localized:)` resolves against the
    /// process bundle's PREFERRED language (= the system language in a widget
    /// extension) and ignores the SwiftUI environment locale — so every
    /// String-building code path in the widget stayed in the system language
    /// while `Text(key)` followed the app's override, producing a mixed-language
    /// widget whenever the two differed. This resolves against the app-chosen
    /// language's own .lproj, the same way the app's Bundle swizzle does.
    static func string(_ key: String.LocalizationValue) -> String {
        guard let defaults = UserDefaults(suiteName: AgentWidgetSnapshotStore.appGroupIdentifier),
              let code = defaults.string(forKey: storageKey), !code.isEmpty,
              let path = Bundle.main.path(forResource: code, ofType: "lproj"),
              let bundle = Bundle(path: path) else {
            return String(localized: key)
        }
        return String(localized: key, bundle: bundle)
    }
}

/// [T-widget-artifacts] Recently produced artifacts, mirrored for the widget
/// process. Only metadata crosses — the files themselves stay in the app
/// container, and the widget links back into the owning session rather than
/// trying to render them.
struct WidgetArtifactItem: Codable, Hashable, Identifiable {
    var id: String
    var title: String
    var kind: String
    var sessionId: String
    var updatedAt: Date
    /// SF Symbol chosen from the artifact kind, resolved app-side so the
    /// widget needs no knowledge of ArtifactKind.
    var symbolName: String
}

enum WidgetArtifactsStore {
    static let storageKey = "leoWidgetArtifacts.v1"

    static func load() -> [WidgetArtifactItem] {
        guard let defaults = UserDefaults(suiteName: AgentWidgetSnapshotStore.appGroupIdentifier),
              let data = defaults.data(forKey: storageKey),
              let items = try? JSONDecoder().decode([WidgetArtifactItem].self, from: data) else {
            return []
        }
        return items
    }

    static func save(_ items: [WidgetArtifactItem]) {
        guard let defaults = UserDefaults(suiteName: AgentWidgetSnapshotStore.appGroupIdentifier),
              let data = try? JSONEncoder().encode(items) else { return }
        defaults.set(data, forKey: storageKey)
    }
}

/// [T-widget-quick-tasks] One tappable quick task on the Home Screen widget.
/// Mirrored from QuickTaskStore (main app) into the App Group whenever the
/// catalog or composer pins change.
struct WidgetQuickTaskItem: Codable, Hashable, Identifiable {
    /// [T-widget-run-in-place] Outcome of the most recent widget-initiated
    /// run, rendered as a micro badge next to the task.
    enum RunState: String, Codable {
        case idle
        case running
        case succeeded
        case failed
    }

    var id: String
    var name: String
    var symbolName: String
    var lastRunState: RunState = .idle
    var lastRunAt: Date? = nil

    // [T-codable-default-not-a-fallback] A property default does NOT make the
    // synthesised `init(from:)` tolerant: Swift emits `decode(_:forKey:)` for a
    // non-Optional property, which throws `keyNotFound` when the key is absent.
    // The old comment claimed otherwise, so the next field added this way would
    // have made every stored snapshot fail to decode — the widget silently
    // falling back to placeholder tasks until the app was opened. Decode
    // explicitly so added fields really are backwards-compatible.
    init(id: String, name: String, symbolName: String,
         lastRunState: RunState = .idle, lastRunAt: Date? = nil) {
        self.id = id
        self.name = name
        self.symbolName = symbolName
        self.lastRunState = lastRunState
        self.lastRunAt = lastRunAt
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = try c.decode(String.self, forKey: .name)
        symbolName = try c.decode(String.self, forKey: .symbolName)
        lastRunState = (try? c.decode(RunState.self, forKey: .lastRunState)) ?? .idle
        lastRunAt = try? c.decode(Date.self, forKey: .lastRunAt)
    }
}

enum WidgetQuickTasksStore {
    static let storageKey = "leoWidgetQuickTasks.v1"

    static func load() -> [WidgetQuickTaskItem] {
        guard let defaults = UserDefaults(suiteName: AgentWidgetSnapshotStore.appGroupIdentifier),
              let data = defaults.data(forKey: storageKey),
              let items = try? JSONDecoder().decode([WidgetQuickTaskItem].self, from: data) else {
            return []
        }
        return items
    }

    static func save(_ items: [WidgetQuickTaskItem]) {
        guard let defaults = UserDefaults(suiteName: AgentWidgetSnapshotStore.appGroupIdentifier),
              let data = try? JSONEncoder().encode(items) else { return }
        defaults.set(data, forKey: storageKey)
    }

    /// [T-widget-run-in-place] Records the outcome of a widget-initiated run
    /// so the button can show ⏳ / ✅ / ⚠️ without opening the app. Preserves
    /// the rest of the mirrored catalog.
    static func updateRunState(id: String, state: WidgetQuickTaskItem.RunState) {
        var items = load()
        guard let index = items.firstIndex(where: { $0.id == id }) else { return }
        items[index].lastRunState = state
        items[index].lastRunAt = Date()
        save(items)
    }
}

/// [T-widget-briefing] Result summary of the most recent completed task,
/// rendered as a "daily briefing" card. Written by the app when a task
/// finishes; the widget only reads.
struct WidgetBriefing: Codable, Hashable {
    var generatedAt: Date
    var taskName: String
    var sessionId: String
    var summary: String

    var isFromToday: Bool {
        Calendar.current.isDateInToday(generatedAt)
    }
}

/// [T-widget-briefing-pending] Sessions launched from a widget that still owe
/// a briefing card. Persisted (not held in a Task) because the observer that
/// used to wait for completion dies the moment iOS suspends the app — which
/// is exactly what happens on the runs this feature exists for. Whoever sees
/// the session finish (tracker callback, or the next foreground sweep)
/// resolves the entry.
enum WidgetPendingBriefingStore {
    static let storageKey = "leoWidgetPendingBriefing.v1"

    /// One outstanding briefing. Ordered by `addedAt`, because the store has to
    /// answer both "which of these is newest" and "which do I drop when full".
    struct Entry: Codable, Hashable {
        var sessionId: String
        var taskName: String
        var addedAt: Date
        /// "scheduled" for ScheduledTaskRunner-launched runs (drives the
        /// completion notification); nil/other for widget-launched. Optional →
        /// old persisted entries decode unchanged.
        var origin: String? = nil
    }

    /// [T-pending-briefing-order] Was `[String: String]` capped with
    /// `Dictionary(uniqueKeysWithValues: Array(map).suffix(10))`. Dictionary
    /// iteration order comes from the hash seed, which Swift randomises per
    /// process — so the cap discarded an ARBITRARY entry, with a real chance of
    /// throwing away the one just added, and "the most recent briefing" was
    /// likewise whichever the hash happened to yield last. Both need time.
    static func loadEntries() -> [Entry] {
        guard let defaults = UserDefaults(suiteName: AgentWidgetSnapshotStore.appGroupIdentifier) else { return [] }
        if let data = defaults.data(forKey: storageKey),
           let entries = try? JSONDecoder().decode([Entry].self, from: data) {
            return entries.sorted { $0.addedAt < $1.addedAt }
        }
        // Migrate the old shape once. No timestamps existed, so they all get
        // "now" and simply behave as equally-old from here on.
        if let map = defaults.dictionary(forKey: storageKey) as? [String: String] {
            let migrated = map.map { Entry(sessionId: $0.key, taskName: $0.value, addedAt: Date()) }
            save(migrated)
            return migrated
        }
        return []
    }

    /// sessionId → task display name, kept for existing call sites.
    static func load() -> [String: String] {
        Dictionary(loadEntries().map { ($0.sessionId, $0.taskName) }, uniquingKeysWith: { _, latest in latest })
    }

    private static func save(_ entries: [Entry]) {
        guard let defaults = UserDefaults(suiteName: AgentWidgetSnapshotStore.appGroupIdentifier),
              let data = try? JSONEncoder().encode(entries) else { return }
        defaults.set(data, forKey: storageKey)
    }

    static func add(sessionId: String, taskName: String, origin: String? = nil) {
        var entries = loadEntries().filter { $0.sessionId != sessionId }
        entries.append(Entry(sessionId: sessionId, taskName: taskName, addedAt: Date(), origin: origin))
        // Bound the list — a run that never produces a reply must not pile up.
        // Dropping the OLDEST is now well-defined.
        if entries.count > 10 { entries = Array(entries.suffix(10)) }
        save(entries)
    }

    static func remove(sessionId: String) {
        save(loadEntries().filter { $0.sessionId != sessionId })
    }
}

enum WidgetBriefingStore {
    static let storageKey = "leoWidgetBriefing.v1"

    static func load() -> WidgetBriefing? {
        guard let defaults = UserDefaults(suiteName: AgentWidgetSnapshotStore.appGroupIdentifier),
              let data = defaults.data(forKey: storageKey) else { return nil }
        return try? JSONDecoder().decode(WidgetBriefing.self, from: data)
    }

    static func save(_ briefing: WidgetBriefing) {
        guard let defaults = UserDefaults(suiteName: AgentWidgetSnapshotStore.appGroupIdentifier),
              let data = try? JSONEncoder().encode(briefing) else { return }
        defaults.set(data, forKey: storageKey)
    }
}

/// [T-widget-today] Rolling usage summary for the "today" widget. Token counts
/// come from the same aggregation the Usage screen uses.
struct WidgetUsageSummary: Codable, Hashable {
    /// One bucket per day, oldest first, at most 7 entries.
    struct DayBucket: Codable, Hashable {
        var day: Date
        var tokens: Int
    }

    var updatedAt: Date
    var todayTasks: Int
    var todayTokens: Int
    /// 0–100, computed over cache-capable models only.
    var cacheHitRate: Double
    var topModel: String
    var recentDays: [DayBucket]

    static let empty = WidgetUsageSummary(
        updatedAt: .distantPast,
        todayTasks: 0,
        todayTokens: 0,
        cacheHitRate: 0,
        topModel: "",
        recentDays: []
    )
}

enum WidgetUsageStore {
    static let storageKey = "leoWidgetUsage.v1"

    static func load() -> WidgetUsageSummary {
        guard let defaults = UserDefaults(suiteName: AgentWidgetSnapshotStore.appGroupIdentifier),
              let data = defaults.data(forKey: storageKey),
              let value = try? JSONDecoder().decode(WidgetUsageSummary.self, from: data) else {
            return .empty
        }
        return value
    }

    static func save(_ summary: WidgetUsageSummary) {
        guard let defaults = UserDefaults(suiteName: AgentWidgetSnapshotStore.appGroupIdentifier),
              let data = try? JSONEncoder().encode(summary) else { return }
        defaults.set(data, forKey: storageKey)
    }
}

/// [T-widget-memory] Latest memory entries for the memory-lens widget.
/// Respects Privacy Mode: when redacted the app writes placeholder text
/// rather than skipping the write, so the widget still shows a live count.
struct WidgetMemorySnapshot: Codable, Hashable {
    var updatedAt: Date
    var todayCount: Int
    var latestEntry: String
    var isRedacted: Bool

    static let empty = WidgetMemorySnapshot(
        updatedAt: .distantPast,
        todayCount: 0,
        latestEntry: "",
        isRedacted: false
    )
}

enum WidgetMemoryStore {
    static let storageKey = "leoWidgetMemory.v1"

    static func load() -> WidgetMemorySnapshot {
        guard let defaults = UserDefaults(suiteName: AgentWidgetSnapshotStore.appGroupIdentifier),
              let data = defaults.data(forKey: storageKey),
              let value = try? JSONDecoder().decode(WidgetMemorySnapshot.self, from: data) else {
            return .empty
        }
        return value
    }

    static func save(_ snapshot: WidgetMemorySnapshot) {
        guard let defaults = UserDefaults(suiteName: AgentWidgetSnapshotStore.appGroupIdentifier),
              let data = try? JSONEncoder().encode(snapshot) else { return }
        defaults.set(data, forKey: storageKey)
    }
}

// MARK: - Widget → app intent bridge [T-widget-run-in-place]

/// Lets the Home Screen widget run a quick task WITHOUT opening the app.
///
/// The conformance is `LiveActivityIntent` on purpose: the system performs
/// those in the **app's process**, whereas a plain `AppIntent` tapped in a
/// widget runs inside the widget extension — which compiles three files and
/// can never reach the agent loop. Starting a task does start a Live Activity
/// (BackgroundKeepAliveManager.reevaluate), so this is an honest use of the
/// protocol rather than a loophole.
/// Stops every running agent task from the Home Screen console.
/// Same `LiveActivityIntent` reasoning as `RunQuickTaskFromWidgetIntent`:
/// cancelling tears down the Live Activity, and the work can only be
/// cancelled inside the app's process.
@available(iOS 17.0, *)
struct StopAllTasksFromWidgetIntent: LiveActivityIntent {
    static let title: LocalizedStringResource = "Stop Running Tasks"
    static let description = IntentDescription("Cancels every running LeoPhoneAgent task.")
    static let openAppWhenRun = false

    func perform() async throws -> some IntentResult {
        await WidgetIntentBridge.shared.stopAllTasks()
        return .result()
    }
}

@available(iOS 17.0, *)
struct RunQuickTaskFromWidgetIntent: LiveActivityIntent {
    /// [T-widget-intent-discoverability] Widget-button plumbing, not a user
    /// action. Left discoverable it showed up in the Shortcuts app as a third
    /// near-identical "Quick Task" entry whose only parameter was a free-text
    /// box wanting an internal id — mistyping it failed silently. The two
    /// real actions (RunQuickTaskIntent / QuickTaskIntent) stay discoverable
    /// and take a proper QuickTaskEntity.
    static var isDiscoverable: Bool { false }

    static let title: LocalizedStringResource = "Run Quick Task"
    static let description = IntentDescription("Runs a LeoPhoneAgent quick task in the background.")
    /// Stay out of the way: the point of the widget button is not opening the app.
    static let openAppWhenRun = false

    @Parameter(title: "Task")
    var taskId: String

    init() {}

    init(taskId: String) {
        self.taskId = taskId
    }

    func perform() async throws -> some IntentResult {
        await WidgetIntentBridge.shared.runQuickTask(id: taskId)
        return .result()
    }
}

/// Indirection that lets the intent above (compiled into BOTH targets) reach
/// app-only code. The app installs the handler at launch; inside the widget
/// extension it stays nil, which is harmless because the system routes
/// `LiveActivityIntent` to the app process.
final class WidgetIntentBridge: @unchecked Sendable {
    /// [T-control-center] Where a Control Center button should land.
    enum ControlDestination: String, Sendable {
        case newChat
        case voice
        case camera
    }

    static let shared = WidgetIntentBridge()
    private init() {}

    var runQuickTaskHandler: (@Sendable (String) async -> Void)?
    var controlDestinationHandler: (@Sendable (ControlDestination) async -> Void)?
    var stopAllTasksHandler: (@Sendable () async -> Void)?

    /// [T-widget-bridge-silent-nil] Every one of these used to be a bare
    /// `await handler?(…)`: with no handler installed the intent returned
    /// `.result()` and the user simply saw a widget button do nothing, with not
    /// one line in the log to explain it. The handlers are installed in
    /// `didFinishLaunching`, which does run before an intent is performed — but
    /// "should never happen" is exactly the failure worth being loud about,
    /// since the symptom is indistinguishable from a broken feature.
    func runQuickTask(id: String) async {
        guard let handler = runQuickTaskHandler else {
            Self.reportMissingHandler("runQuickTask(\(id))")
            return
        }
        await handler(id)
    }

    func stopAllTasks() async {
        guard let handler = stopAllTasksHandler else {
            Self.reportMissingHandler("stopAllTasks")
            return
        }
        await handler()
    }

    func openControlDestination(_ destination: ControlDestination) async {
        guard let handler = controlDestinationHandler else {
            Self.reportMissingHandler("openControlDestination(\(destination.rawValue))")
            return
        }
        await handler(destination)
    }

    private static func reportMissingHandler(_ what: String) {
        NSLog("[WidgetIntentBridge] no handler installed for %@ — the app process did not finish launching before the intent ran", what)
    }
}

/// [T-widget-recent-sessions] One row of the recent-sessions widget.
/// Mirrored from ContentView's session list into the App Group (the chat
/// database itself lives in Library/MinisChat and is unreachable from the
/// widget process).
struct WidgetRecentSessionItem: Codable, Hashable, Identifiable {
    var id: String
    var title: String
    var updatedAt: Date
}

enum WidgetRecentSessionsStore {
    static let storageKey = "leoWidgetRecentSessions.v1"

    static func load() -> [WidgetRecentSessionItem] {
        guard let defaults = UserDefaults(suiteName: AgentWidgetSnapshotStore.appGroupIdentifier),
              let data = defaults.data(forKey: storageKey),
              let items = try? JSONDecoder().decode([WidgetRecentSessionItem].self, from: data) else {
            return []
        }
        return items
    }

    static func save(_ items: [WidgetRecentSessionItem]) {
        guard let defaults = UserDefaults(suiteName: AgentWidgetSnapshotStore.appGroupIdentifier),
              let data = try? JSONEncoder().encode(items) else { return }
        defaults.set(data, forKey: storageKey)
    }
}

enum AgentWidgetSnapshotStore {
    static let appGroupIdentifier = "group.com.leoyuan.leophoneagent"
    static let storageKey = "leoAgentWidgetSnapshot.v1"

    static func load() -> AgentWidgetSnapshot {
        guard let defaults = UserDefaults(suiteName: appGroupIdentifier),
              let data = defaults.data(forKey: storageKey),
              let snapshot = try? JSONDecoder().decode(AgentWidgetSnapshot.self, from: data) else {
            return .idle
        }
        return snapshot
    }

    @discardableResult
    static func save(_ snapshot: AgentWidgetSnapshot) -> Bool {
        guard let defaults = UserDefaults(suiteName: appGroupIdentifier),
              let data = try? JSONEncoder().encode(snapshot) else { return false }
        defaults.set(data, forKey: storageKey)
        return true
    }
}

struct LiveSessionSnapshot: Codable, Hashable {
    var sessionId: String
    var title: String
    /// SF Symbol name for the current tool (e.g. "globe", "terminal", "doc.text").
    var toolIcon: String
    /// Human-readable tool status (e.g. "navigate...", "running...", "get_text...").
    var toolStatus: String
    var loopIteration: Int
    /// True once this session's task has finished. Drives the "completed" look
    /// (checkmark + last message) in the Live Activity. Defaulted so all
    /// existing snapshot construction sites compile unchanged.
    var isCompleted: Bool = false
    /// One-line summary of the final assistant reply, shown when `isCompleted`.
    var lastMessage: String = ""
}

@available(iOS 16.2, *)
struct AgentActivityAttributes: ActivityAttributes {
    var startDate: Date

    public struct ContentState: Codable, Hashable {
        var activeSessionCount: Int
        var sessions: [LiveSessionSnapshot]
        /// Index into `sessions` for the currently displayed session (rotates each update).
        var carouselIndex: Int
        var soulName: String
        /// SF Symbol for the most-recently-invoked tool across all sessions.
        /// The Dynamic Island minimal icon alternates between this tool icon
        /// and the session-count icon on each refresh. Empty when no tool is
        /// active yet. Defaulted so existing ContentState construction sites
        /// (end / cleanup states with no sessions) compile unchanged.
        var latestToolIcon: String = ""
        /// Drives the minimal-icon alternation: when true the minimal Dynamic
        /// Island shows `latestToolIcon`, otherwise the session-count badge.
        /// Flipped by the manager on every refresh so it alternates even with a
        /// single session (where `carouselIndex` would stay 0).
        var minimalShowsTool: Bool = false
        /// True when ALL tasks have finished and the Live Activity is in its
        /// "completed" resting state: it stops the carousel, shows a checkmark +
        /// each session's last message, and lingers (instead of ending instantly)
        /// until the user taps it and LeoPhoneAgent decides whether to dismiss it.
        /// [T-ios-live-activity-soft-finish]
        var allCompleted: Bool = false
        /// [T-ios-live-activity-audio-toggle] True while the global TTS/audio
        /// player (`GlobalAudioPlayer`) is actively playing a reply-narration or
        /// attachment audio. Drives the play/pause control shown beside the Agent
        /// identity capsule in the Dynamic Island expanded view. Defaulted so old
        /// encoded ContentStates (written before this field existed) still decode.
        var isAudioPlaying: Bool = false
        /// [T-ios-live-activity-audio-toggle] True whenever the audio player has a
        /// file loaded (playing OR paused). Distinguishes "audio present, show the
        /// control" from "no audio at all, hide it". When true but `isAudioPlaying`
        /// is false, the control shows a play (resume) glyph. Defaulted for
        /// backward-compatible decoding.
        var isAudioLoaded: Bool = false
        /// [T-ios-live-activity-audio-toggle] Short title of the current audio
        /// (the player's `fileName`), for optional display. Defaulted for decoding.
        var audioTitle: String = ""
        /// [T-ios-live-activity-privacy-duration] Wall-clock moment the LAST
        /// task finished, set only on the soft-finish (allCompleted) push. The
        /// widget renders `finishedAt − attributes.startDate` as a static
        /// "total run time" capsule in the completed resting state — the live
        /// `.timer` stops there, and Privacy Mode's redacted rows otherwise
        /// carry no informative content at all. Optional + defaulted so
        /// ContentStates encoded before this field existed still decode.
        var finishedAt: Date? = nil
        /// [T-ios-live-activity-privacy-mode] True when the user has turned on
        /// Privacy Mode. The manager already redacts the sensitive fields
        /// (session title / tool status / tool icon / last message / soul name)
        /// before pushing, so the widget mostly renders correctly without
        /// checking this. It is carried anyway so the view can suppress the few
        /// things data-redaction alone can't (e.g. forcing the neutral minimal
        /// icon). Defaulted so ContentStates encoded before this field existed
        /// still decode.
        var privacyMode: Bool = false
    }
}

// MARK: - Control Center intents [T-control-center]

/// Opens a brand-new chat from a Control Center button / Action Button.
/// `openAppWhenRun` is intentionally true: starting a conversation without
/// showing it would be a dead end.
@available(iOS 18.0, *)
struct OpenNewChatControlIntent: AppIntent {
    static let title: LocalizedStringResource = "New Chat"
    static let description = IntentDescription("Opens LeoPhoneAgent on a new conversation.")
    static let openAppWhenRun = true

    func perform() async throws -> some IntentResult {
        await WidgetIntentBridge.shared.openControlDestination(.newChat)
        return .result()
    }
}

@available(iOS 18.0, *)
struct StartVoiceControlIntent: AppIntent {
    static let title: LocalizedStringResource = "Voice Chat"
    static let description = IntentDescription("Opens LeoPhoneAgent and starts voice input.")
    static let openAppWhenRun = true

    func perform() async throws -> some IntentResult {
        await WidgetIntentBridge.shared.openControlDestination(.voice)
        return .result()
    }
}

@available(iOS 18.0, *)
struct StartCameraControlIntent: AppIntent {
    static let title: LocalizedStringResource = "Camera Chat"
    static let description = IntentDescription("Opens LeoPhoneAgent with the camera ready.")
    static let openAppWhenRun = true

    func perform() async throws -> some IntentResult {
        await WidgetIntentBridge.shared.openControlDestination(.camera)
        return .result()
    }
}
