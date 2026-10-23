import ActivityKit
import Foundation
import UIKit
import os.log

private let logger = AppLogger(category: "LiveActivity")

@MainActor
final class AgentLiveActivityManager {
    static let shared = AgentLiveActivityManager()
    private init() {}

    private var currentActivity: Any?
    private var startTime: Date?

    /// [T-ios-live-activity-privacy-mode] Read-only view of the current task's
    /// start time, so Privacy Mode notifications can report elapsed duration
    /// ("1 task completed · 2m 15s") without introducing separate time tracking.
    /// nil when no Live Activity run is in flight.
    var taskStartTime: Date? { startTime }

    /// [T-siri-fleet] Mac 任务桥用:聊天任务的 activity 在跑时它不插队。
    /// 也算中继远程拉起、还在屏上的卡:App 被叫醒 / 回前台时 currentActivity 是 nil,
    /// 只看它会让桥再起一张本地卡,锁屏上就成了两张。
    var hasLiveActivity: Bool { currentActivity != nil || !relayActivities.isEmpty }

    /// 这个会话是不是已经有卡在屏上(本地起的或中继远程拉起的)。桥按会话判断要不要另起卡时用这个,
    /// 比 `hasLiveActivity` 准:中继的卡上没有这个会话时仍可以起。
    func hasActivity(forSessionId sessionId: String) -> Bool {
        guard Self.isActivityKitAvailable, !sessionId.isEmpty else { return false }
        if let local = currentActivity as? Activity<AgentActivityAttributes>,
           local.content.state.sessions.contains(where: { $0.sessionId == sessionId }) {
            return true
        }
        return relayActivities.contains { activity in
            activity.content.state.sessions.contains { $0.sessionId == sessionId }
        }
    }

    /// 中继 push-to-start 拉起、还没结束的卡(不归 currentActivity 管)。
    private var relayActivities: [Activity<AgentActivityAttributes>] {
        guard Self.isActivityKitAvailable else { return [] }
        let localId = (currentActivity as? Activity<AgentActivityAttributes>)?.id
        return Activity<AgentActivityAttributes>.activities.filter {
            $0.attributes.origin == AgentActivityAttributes.relayOrigin
                && $0.activityState == .active && $0.id != localId
        }
    }
    private var carouselIndex: Int = 0
    private var updateCount: Int = 0
    /// Toggled on every Live Activity refresh to alternate the Dynamic Island
    /// minimal icon between the latest-tool icon and the session-count badge.
    private var minimalShowsTool: Bool = false
    private var lastPushedState: Any?
    private var lastPushDate: Date = .distantPast
    private var pendingState: Any?
    private var pendingPushWorkItem: DispatchWorkItem?

    /// [WP-41] 这张卡要不要带 update token(Mac 任务卡要,中继据此在 App 不在时远程更新)。
    /// 由 `startActivity(sessions:remotePush:)` 设定;后台补启沿用。
    private var remotePush = false
    private var pushTokenTask: Task<Void, Never>?
    private var currentPushToken: String?
    private var registeredTokenSessions: Set<String> = []
    /// 正在登记(含退避重试)的会话集合,同样的状态推送不重复发起。
    private var registeringTokenSessions: Set<String>?

    private var requestPushType: PushType? { remotePush ? .token : nil }

    /// `Activity.request` 在 app 刚滑到后台的瞬间会以「Target is not foreground」失败。这是已知且有补救的
    /// 预期情况([la-foreground] 下一次离开前台时会重新起卡),不是故障,不该占 ERROR 位
    /// (真机 4 天 20 条 ERROR;ERROR 不受日志限流,看日志时还会被当成真问题)。
    nonisolated static func isNotForegroundFailure(_ error: Error) -> Bool {
        "\(error.localizedDescription) \(error)".lowercased().contains("not foreground")
    }

    /// [T-ios-live-activity-soft-finish] True after `finishActivity()` flips the
    /// Live Activity to its completed resting state but leaves it on screen. The
    /// next foreground return ends it (`dismissFinishedActivityOnForeground`).
    /// Cleared by start/end so a fresh task never inherits a stale "finished" flag.
    private var awaitingDismissal = false
    private var isFinishing = false

    private static let isActivityKitAvailable: Bool = {
        #if targetEnvironment(macCatalyst)
        return false
        #else
        if ProcessInfo.processInfo.isiOSAppOnMac {
            return false
        }
        // [T-ipad16-activitykit-crash] ActivityKit is WEAK-linked
        // (LC_LOAD_WEAK_DYLIB) and Live Activities came to iPad only with
        // iPadOS 17. `#available(iOS 16.2, *)` passes on iPadOS 16.2, so gated
        // code ran there and the first ActivityKit call / generic-metadata
        // instantiation dereferenced a NULL weak symbol: 1.9 crashed calling
        // a null function pointer (pc=0 via Combine), 1.10 crashed in
        // swift_getTypeByMangledName resolving Activity<AgentActivityAttributes>
        // from _endActivity (user report: iPad8,11 @ iPadOS 16.2, 100% on send).
        //
        // [T-ipad16-liveactivity-restore-crash GH#82] The dlopen probe alone
        // did NOT stop the crash on that iPad (builds 51→54, identical
        // swift_getTypeByMangledName stack, now firing from the foreground
        // session-restore task → cleanupStaleActivities): a framework binary
        // can be present in the dyld shared cache — dlopen returns a handle —
        // on a system where the Activity machinery itself is absent/broken.
        // The iPadOS 17+ requirement is now met by the deployment target
        // (iOS 27), so the remaining gate is: the ActivityKit.Activity class
        // descriptor symbol must actually resolve — if it doesn't,
        // instantiating Activity<AgentActivityAttributes> metadata is what crashes.
        guard let handle = dlopen("/System/Library/Frameworks/ActivityKit.framework/ActivityKit", RTLD_LAZY) else {
            logger.info("[LiveActivity][probe] unavailable: dlopen failed")
            return false
        }
        guard dlsym(handle, "$s11ActivityKit0A0CMn") != nil else {
            logger.info("[LiveActivity][probe] unavailable: Activity descriptor symbol missing")
            return false
        }
        return true
        #endif
    }()

    /// Shared "can this device show Live Activities at all" check — the same
    /// hardened runtime probe the manager gates every ActivityKit call on
    /// (macCatalyst/iOS-on-Mac excluded, iPad requires iPadOS 17+, framework
    /// binary loadable AND Activity descriptor symbol present). UI that offers
    /// Live Activity preferences should hide behind this so users can't toggle
    /// a switch that does nothing on their device. [T-ipad16-liveactivity-restore-crash]
    static var isLiveActivitySupported: Bool { isActivityKitAvailable }

    func cleanupStaleActivities(source: String = "?") {
        guard Self.isActivityKitAvailable else {
            logger.info("[LiveActivity][cleanup src=\(source)] skipped: ActivityKit unavailable")
            return
        }
        _cleanupStaleActivities(source: source)
    }

    /// [T-live-activity-toggle] User preference gate (Settings → Background →
    /// Live Activity, default ON). Gates the CREATE/UPDATE entry points only;
    /// end/cleanup/finish stay allowed so flipping the switch off (or a stale
    /// activity from before the switch was off) always tears down cleanly.
    private static var isUserEnabled: Bool {
        (UserDefaults.standard.object(forKey: "liveActivityEnabled") as? Bool) ?? true
    }

    /// - Parameter remotePush: [WP-41] 请求 `.token` 推送类型并把 update token 登记到中继
    ///   (Mac 任务卡)。聊天任务卡保持纯本地。
    func startActivity(sessions: [LiveSessionSnapshot], remotePush: Bool = false) {
        guard Self.isActivityKitAvailable, Self.isUserEnabled else { return }
        // [la-foreground] In the app: no card. `leaveForeground` starts it when
        // the user switches away (a task started in the conversation lands here).
        guard !isAppInForeground else {
            logger.info("[LiveActivity][start] held: app in foreground — starts when it leaves")
            return
        }
        self.remotePush = remotePush
        _startActivity(sessions: sessions)
    }

    func updateActivity(sessions: [LiveSessionSnapshot]) {
        guard Self.isActivityKitAvailable else { return }
        let action = LiveActivityPresencePolicy.decide(
            appActive: isAppInForeground, taskRunning: !sessions.isEmpty || Self.isAudioActive(),
            followed: true, enabled: Self.isUserEnabled, existingActivity: currentActivity != nil)
        switch action {
        case .none:
            return
        case .endImmediately:
            // Foreground (or switched off) with a card up: take it down now.
            endAll(reason: "update")
        case .start, .keep, .endWithFinalState:
            // A finished run is ended by `finishActivity`; here only the running
            // state is pushed (or the card restarted while the app is away).
            _updateActivity(sessions: sessions)
        }
    }

    func endActivity() {
        guard Self.isActivityKitAvailable else { return }
        _endActivity()
    }

    /// [T-ios-live-activity-multisession-dismiss] Mark a single session as
    /// completed while other sessions are still running. Updates the Live
    /// Activity in place — the completed session shows a checkmark + last
    /// message, while remaining sessions continue refreshing normally.
    func markSessionCompleted(sessionId: String, lastMessage: String) {
        guard Self.isActivityKitAvailable, Self.isUserEnabled else { return }
        _markSessionCompleted(sessionId: sessionId, lastMessage: lastMessage)
    }

    /// [T-ios-live-activity-soft-finish] Soft-finish: when the last task ends,
    /// DON'T tear the Live Activity down. Flip it to a "completed" resting state
    /// (checkmark + each session's last message, carousel frozen) and leave it on
    /// the Lock Screen / Dynamic Island. It's dismissed later — when the user taps
    /// it and LeoPhoneAgent comes to the foreground (see `dismissFinishedActivityOnForeground`).
    /// Falls back to a hard end if there's no prior running snapshot to complete.
    /// [la-foreground] Now the completed state is the activity's END content
    /// (default dismissal); only while the reply is still read aloud does it stay
    /// live as before. In the foreground there is no card, so this is a hard end.
    func finishActivity(lastMessages: [String: String] = [:]) async {
        guard Self.isActivityKitAvailable else { return }
        // Disabled → no soft-finish card; fall through to a hard end so any
        // activity left over from before the switch was flipped is removed.
        // [la-foreground] Finished while the user is in the app: nothing to rest.
        guard LiveActivityPresencePolicy.decide(
            appActive: isAppInForeground, taskRunning: false, followed: true,
            enabled: Self.isUserEnabled, existingActivity: true) == .endWithFinalState else {
            _endActivity()
            return
        }
        await _finishActivity(lastMessages: lastMessages)
    }

    /// [T-ios-delete-session-live-activity] Called when a session is deleted.
    /// Removes the session from the Live Activity so the Dynamic Island / Lock
    /// Screen never keeps showing content from a deleted conversation: if other
    /// sessions are still represented the activity updates in place without the
    /// deleted one; otherwise it ends immediately (dismissalPolicy .immediate).
    func handleSessionDeleted(_ sessionId: String) {
        guard Self.isActivityKitAvailable else { return }
        _handleSessionDeleted(sessionId)
    }

    /// Called on foreground return (after the first frame). [la-foreground] The
    /// scene-activation hook already ended every card; this is the backstop. It
    /// no longer restarts a card for sessions still running — in the app there
    /// is none; `leaveForeground` brings it back when the user switches away.
    func dismissFinishedActivityOnForeground() {
        guard Self.isActivityKitAvailable, isAppInForeground else { return }
        endAll(reason: "foregroundFrame")
    }

    // MARK: - [la-foreground] Foreground gate
    //
    // The card shows only while work is running AND no LeoBot scene is
    // foreground-active (`LiveActivityPresencePolicy`). ActivityKit only lets an
    // app START an activity while it is foreground, so the start happens in the
    // resign-active transition; updates and the final end work from the background.

    /// True from "the last LeoBot scene resigned active" until "a LeoBot scene
    /// became active". Kept from the scene notifications rather than read from
    /// `activationState` at decision time: inside `willDeactivate` the leaving
    /// scene can still report `.foregroundActive`.
    private var leftForeground = false
    private var presenceObserversInstalled = false
    private var presenceBackgroundTask: UIBackgroundTaskIdentifier = .invalid
    /// Cards ended with their final state and the default dismissal (still on the
    /// Lock Screen). Ended `.immediate` when the user comes back.
    /// `Any`, like `currentActivity`: no ActivityKit generic metadata in stored
    /// state ([T-ipad16-activitykit-crash]).
    private var finalStateActivities: [Any] = []

    /// Some LeoBot scene is foreground-active: the user is in the app (on iPad,
    /// any window counts). A process launched straight into the background
    /// never saw a scene activate and reads as not foreground.
    var isAppInForeground: Bool {
        !leftForeground && UIApplication.shared.applicationState != .background
    }

    /// Idempotent; called from `BackgroundKeepAliveManager.setup()`.
    func installPresenceObservers() {
        guard !presenceObserversInstalled else { return }
        presenceObserversInstalled = true
        let center = NotificationCenter.default
        center.addObserver(forName: UIScene.didActivateNotification, object: nil, queue: .main) { [weak self] note in
            let scene = note.object as? UIScene
            MainActor.assumeIsolated { self?.sceneDidActivate(scene) }
        }
        // [duo-fold] A settling departure resolves at once when the app really goes away.
        center.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.resolvePendingDeparture(trigger: "background") }
        }
        if #available(iOS 27.1, *) {
            for case let windowScene as UIWindowScene in UIApplication.shared.connectedScenes {
                observeHinge(in: windowScene)
            }
        }
        // Handled synchronously on purpose: a Task hop could land after
        // didEnterBackground, when `Activity.request` fails ("Target is not foreground").
        center.addObserver(forName: UIScene.willDeactivateNotification, object: nil, queue: .main) { [weak self] note in
            let scene = note.object as? UIScene
            MainActor.assumeIsolated { self?.sceneWillDeactivate(scene) }
        }
    }

    private func sceneDidActivate(_ scene: UIScene?) {
        if let pending = pendingDeparture {
            // [duo-fold] The scene came back (fold/unfold finished on the other
            // display): the app never left, so no card was started.
            pending.cancel()
            pendingDeparture = nil
            logger.info("[LiveActivity][presence] display move settled: still foreground, no card")
            endPresenceBackgroundTask()
        }
        leftForeground = false
        if #available(iOS 27.1, *), let windowScene = scene as? UIWindowScene {
            observeHinge(in: windowScene)
        }
        guard Self.isActivityKitAvailable else { return }
        endAll(reason: "sceneDidActivate")
    }

    private func sceneWillDeactivate(_ scene: UIScene?) {
        let others = UIApplication.shared.connectedScenes.filter { $0 !== scene }
        let departure = LiveActivityPresencePolicy.departure(
            otherActive: others.contains { $0.activationState == .foregroundActive },
            otherVisible: others.contains { $0.activationState == .foregroundInactive })
        switch departure {
        case .stayForeground:
            return
        case .leaveNow:
            beginDeparture(reason: "sceneWillDeactivate")
        case .recheckNextTurn:
            DispatchQueue.main.async { [weak self] in
                guard let self, !UIApplication.shared.leoIsInUse else { return }
                self.beginDeparture(reason: "sceneWillDeactivate+recheck")
            }
        }
    }

    // MARK: [duo-fold] Display moves (see LiveActivityPresencePolicy.departureStart)

    /// A departure right after hinge movement, waiting to see whether the scene
    /// comes back on the other display. `leftForeground` stays false meanwhile,
    /// so nothing else starts a card during the wait.
    private var pendingDeparture: DispatchWorkItem?
    /// Last hinge angle/status change (iPhone Duo; nil on every other device).
    private var lastHingeMovement: Date?
    private var lastHinge: (status: Int, angle: Double)?
    private let hingeObservedWindows = NSHashTable<UIWindow>.weakObjects()
    private var presenceTaskGeneration = 0

    /// No LeoBot scene is left in the foreground. Start the card now, or — when
    /// the hinge just moved — after the settle delay unless the scene comes back.
    private func beginDeparture(reason: String) {
        guard !leftForeground, pendingDeparture == nil else { return }
        guard Self.isActivityKitAvailable, Self.isUserEnabled,
              case .settle(let delay) = LiveActivityPresencePolicy.departureStart(
                lastHingeMovement: lastHingeMovement, now: Date()) else {
            leaveForeground(reason: reason)
            return
        }
        // Hold the process while we wait (the assertion outlives the delay).
        beginPresenceBackgroundTask()
        logger.info("[LiveActivity][presence] hinge moved: settling \(delay)s before starting (\(reason)) \(DisplayContext.current)")
        let item = DispatchWorkItem { [weak self] in
            MainActor.assumeIsolated { self?.resolvePendingDeparture(trigger: "timer") }
        }
        pendingDeparture = item
        DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: item)
    }

    private func resolvePendingDeparture(trigger: String) {
        guard let item = pendingDeparture else { return }
        item.cancel()
        pendingDeparture = nil
        switch LiveActivityPresencePolicy.settle(reactivated: UIApplication.shared.leoIsInUse) {
        case .cancel:
            logger.info("[LiveActivity][presence] display move settled (\(trigger)): still foreground, no card")
            endPresenceBackgroundTask()
        case .start:
            leaveForeground(reason: "displayMove+\(trigger)")
        }
    }

    @available(iOS 27.1, *)
    private func observeHinge(in scene: UIWindowScene) {
        guard let window = scene.windows.first(where: { $0.windowLevel == .normal }) ?? scene.windows.first,
              !hingeObservedWindows.contains(window) else { return }
        hingeObservedWindows.add(window)
        window.addInteraction(UIHingeInteraction { [weak self] _, update in
            guard let hinge = update.hinge else { return }
            let status = hinge.status.rawValue, angle = Double(hinge.angle)
            MainActor.assumeIsolated { self?.hingeUpdated(status: status, angle: angle) }
        })
    }

    /// Records movement only (status change or > ~2°); the first reading is a baseline.
    private func hingeUpdated(status: Int, angle: Double) {
        defer { lastHinge = (status, angle) }
        guard let last = lastHinge else { return }
        if last.status != status || abs(last.angle - angle) > 0.035 {
            lastHingeMovement = Date()
            FoldSignal.noteHingeMovement()
        }
    }

    private func beginPresenceBackgroundTask() {
        presenceTaskGeneration += 1
        let generation = presenceTaskGeneration
        if presenceBackgroundTask == .invalid {
            presenceBackgroundTask = UIApplication.shared.beginBackgroundTask(withName: "LiveActivityStart") { [weak self] in
                MainActor.assumeIsolated { self?.endPresenceBackgroundTask() }
            }
        }
        // Room for the request and the push-token registration to go out. Only
        // the latest departure's timer ends it.
        DispatchQueue.main.asyncAfter(deadline: .now() + 5) { [weak self] in
            guard let self, self.presenceTaskGeneration == generation else { return }
            self.endPresenceBackgroundTask()
        }
    }

    /// The user switched away (home, app switcher, lock, another app, Control
    /// Center): start the card now for whatever is still running.
    private func leaveForeground(reason: String) {
        guard !leftForeground else { return }
        leftForeground = true
        guard Self.isActivityKitAvailable, Self.isUserEnabled else { return }
        let app = UIApplication.shared
        beginPresenceBackgroundTask()
        let bka = BackgroundKeepAliveManager.shared
        let local = LiveActivityPresencePolicy.decide(
            appActive: false, taskRunning: bka.isActive || Self.isAudioActive(), followed: true,
            enabled: Self.isUserEnabled, existingActivity: currentActivity != nil)
        logger.info("[LiveActivity][presence] leaving foreground (\(reason)) \(DisplayContext.current) local=\(String(describing: local)) appState=\(app.applicationState.rawValue)")
        if local == .start {
            remotePush = false
            _startActivity(sessions: bka.buildLiveSessionSnapshots())
        }
        // Followed, running Mac sessions (the bridge yields to a local card).
        HarnessLiveActivityBridge.shared.refresh()
    }

    private func endPresenceBackgroundTask() {
        guard presenceBackgroundTask != .invalid else { return }
        UIApplication.shared.endBackgroundTask(presenceBackgroundTask)
        presenceBackgroundTask = .invalid
    }

    /// End every agent card now — ours, the relay's push-to-start ones and
    /// final-state ones still on the Lock Screen — with `.immediate`.
    private func endAll(reason: String) {
        let system = Activity<AgentActivityAttributes>.activities
        guard currentActivity != nil || !system.isEmpty || !finalStateActivities.isEmpty else { return }
        logger.info("[LiveActivity][presence] ending all (\(reason)): current=\(self.currentActivity != nil) system=\(system.count) final=\(self.finalStateActivities.count)")
        for case let activity as Activity<AgentActivityAttributes> in finalStateActivities {
            Task { await activity.end(nil, dismissalPolicy: .immediate) }
        }
        finalStateActivities = []
        _endActivity()
    }

    // MARK: - Audio state (T-ios-live-activity-audio-toggle)

    /// Current audio state read from the app's global player. Nil-safe snapshot so
    /// every ContentState we build can carry the audio fields, and so start /
    /// keep-alive / cleanup decisions can treat "audio loaded" as a reason to keep
    /// the Live Activity alive even with zero Agent sessions.
    struct AudioState {
        var isPlaying: Bool
        var isLoaded: Bool
        var title: String
    }

    static func currentAudioState() -> AudioState {
        // [T-ios-live-activity-audio-toggle] Data source is the read-aloud (TTS)
        // engine, NOT the chat audio-attachment player. `VoiceOutputState.shared`
        // mirrors both TTS engines (System AVSpeechSynthesizer + cloud
        // VoiceOutputPlayer): isReadingAloud == a reply is being read (loaded /
        // capsule visible), speechPaused == currently paused. GlobalAudioPlayer's
        // isPlaying/isLoaded never change during read-aloud, which is why the
        // toggle previously never appeared (root-cause fix for b0f3f884).
        let v = VoiceOutputState.shared
        return AudioState(isPlaying: !v.speechPaused, isLoaded: v.isReadingAloud, title: "")
    }

    /// True when a reply is being read aloud (playing or paused) — the condition,
    /// alongside active sessions, that should keep a Live Activity on screen.
    static func isAudioActive() -> Bool {
        VoiceOutputState.shared.isReadingAloud
    }

    /// [T-ios-live-activity-audio-toggle] Drive a Live Activity update purely from
    /// an audio-state change. Starts an audio-only activity if none exists (and
    /// there are no Agent sessions), or updates the existing one in place so the
    /// play/pause icon flips promptly. Ends the activity if audio just went away
    /// and no Agent sessions remain.
    /// [T-live-activity-audio-toggle-latency] The `source` that marks a push as
    /// user-initiated (a tap on the Live Activity's audio button) and therefore
    /// exempt from the push throttle. Kept as one shared constant so the producer
    /// (VoiceOutputState.handleLiveActivityToggle) and this consumer cannot drift
    /// apart into a silently-ineffective bypass. Every OTHER source — notably the
    /// TTS engine's own `voiceOut(...)` state changes — stays throttled.
    static let userAudioToggleSource = "liveActivityToggle"

    func audioStateChanged(source: String) {
        guard Self.isActivityKitAvailable else { return }
        // [la-foreground] Read-aloud in the app needs no card (the capsule is on screen).
        if isAppInForeground {
            endAll(reason: "audio")
            return
        }
        _audioStateChanged(source: source)
    }

    @available(iOS 16.2, *)
    private func _audioStateChanged(source: String) {
        // Only the user's own tap skips the throttle; engine-driven audio state
        // changes keep the original damping.
        let bypassRateLimit = (source == Self.userAudioToggleSource)
        let audio = Self.currentAudioState()
        let sessions = SessionActivityTracker.shared.activeSessions
        logger.info("[LiveActivity][audio] src=\(source) isPlaying=\(audio.isPlaying) isLoaded=\(audio.isLoaded) sessions=\(sessions.count) hasActivity=\(self.currentActivity != nil)")

        // Audio gone AND no sessions → let the standard end path run (unless a
        // soft-finished/awaiting-dismissal activity is deliberately lingering).
        if !audio.isLoaded && sessions.isEmpty {
            if currentActivity != nil && !awaitingDismissal {
                logger.info("[LiveActivity][audio] audio stopped + no sessions — ending activity")
                _endActivity()
            }
            return
        }

        // Audio present (or sessions present). If nothing is on screen yet, start
        // an activity; otherwise update the existing one in place. This is the
        // audio-only start path that the session-count guards would otherwise block.
        if currentActivity == nil {
            _startActivity(sessions: BackgroundKeepAliveManager.shared.buildLiveSessionSnapshots())
        } else {
            // [T-live-activity-audio-toggle-latency] This is the audio path — it
            // is reached by the user tapping pause/resume on the Live Activity
            // (AudioTogglePlaybackIntent → Darwin notification →
            // VoiceOutputState.handleLiveActivityToggle → BackgroundKeepAliveManager
            // .audioPlaybackStateChanged → here). Bypass the push throttle so the
            // speaker glyph flips immediately instead of lagging up to 5s.
            _updateActivity(
                sessions: BackgroundKeepAliveManager.shared.buildLiveSessionSnapshots(),
                bypassRateLimit: bypassRateLimit
            )
        }
    }

    static func currentSoulName() -> String {
        let name = SoulStore.cachedMetadata.name.trimmingCharacters(in: .whitespacesAndNewlines)
        return name.isEmpty ? "LeoBot" : name
    }

    /// SF Symbol for the most-recently-invoked tool across all active sessions,
    /// for the Dynamic Island minimal icon's "latest tool" frame. Empty when no
    /// active session has a tool yet.
    static func latestToolIcon() -> String {
        guard let toolName = SessionActivityTracker.shared.latestToolName() else { return "" }
        return sfSymbol(forTool: toolName)
    }

    // MARK: - Tool icon mapping

    static func sfSymbol(forTool toolName: String) -> String {
        AgentToolPresentation.symbol(for: toolName)
    }

    static func displayName(forTool toolName: String) -> String {
        AgentToolPresentation.displayName(for: toolName)
    }

    // MARK: - @available implementations

    @available(iOS 16.2, *)
    private func _cleanupStaleActivities(source: String = "?") {
        // [la-foreground] Foreground return: no card while the user is in the
        // app, stale or not — end them all (relay push-to-start ones included).
        // This replaces the foreground "renew" (end + re-request to reset the
        // update budget) and the renew-race recovery: every trip to the
        // background now starts a fresh activity, which resets the budget anyway.
        if source.contains("scenePhase.active") {
            if isAppInForeground { endAll(reason: source) }
            return
        }
        let enabled = ActivityAuthorizationInfo().areActivitiesEnabled
        let currentId = (currentActivity as? Activity<AgentActivityAttributes>)?.id ?? "nil"
        let stale = Activity<AgentActivityAttributes>.activities
        let staleIds = stale.map { $0.id }.joined(separator: ",")
        logger.info("[LiveActivity][cleanup src=\(source)] enabled=\(enabled) currentActivity.id=\(currentId) systemActivities.count=\(stale.count) systemIds=[\(staleIds)]")

        if currentActivity != nil {
            logger.info("[LiveActivity][cleanup src=\(source)] skip: currentActivity is not nil — assuming this process owns it")
            return
        }
        // [WP-41] 中继 push-to-start 拉起的卡不是「上一个进程留下的」:App 被杀时它正显示
        // Mac 那边的审批/进度,由中继负责 update/end(或到 stale-date 自然变灰)。
        let localStale = stale.filter { $0.attributes.origin != AgentActivityAttributes.relayOrigin }
        guard !localStale.isEmpty else {
            logger.verbose("[LiveActivity][cleanup src=\(source)] nothing to clean: systemActivities is empty (relay-started cards are kept)")
            return
        }
        logger.info("[LiveActivity][cleanup src=\(source)] ending \(localStale.count) stale activity(ies) from previous session")
        let finalState = AgentActivityAttributes.ContentState(
            activeSessionCount: 0,
            sessions: [],
            carouselIndex: 0,
            soulName: ""
        )
        let finalContent = ActivityContent(state: finalState, staleDate: nil)
        for activity in localStale {
            let id = activity.id
            Task {
                await activity.end(finalContent, dismissalPolicy: .immediate)
                await MainActor.run {
                    logger.info("[LiveActivity][cleanup src=\(source)] ended stale id=\(id)")
                }
            }
        }
    }

    @available(iOS 16.2, *)
    private func _startActivity(sessions: [LiveSessionSnapshot]) {
        guard ActivityAuthorizationInfo().areActivitiesEnabled else {
            logger.info("[LiveActivity][start] skipped: Activities not enabled in Settings")
            return
        }
        // A fresh task supersedes any lingering completed activity.
        awaitingDismissal = false
        isFinishing = false

        let currentId = (currentActivity as? Activity<AgentActivityAttributes>)?.id ?? "nil"
        let stale = Activity<AgentActivityAttributes>.activities
        let staleIds = stale.map { $0.id }.joined(separator: ",")
        logger.info("[LiveActivity][start] pre: currentActivity.id=\(currentId) systemActivities.count=\(stale.count) systemIds=[\(staleIds)] sessions=\(sessions.count)")

        if !stale.isEmpty {
            logger.info("[LiveActivity][start] cleaning up \(stale.count) stale activity(ies) before start: [\(staleIds)]")
            let finalState = AgentActivityAttributes.ContentState(
                activeSessionCount: 0,
                sessions: [],
                carouselIndex: 0,
                soulName: ""
            )
            let finalContent = ActivityContent(state: finalState, staleDate: nil)
            for old in stale {
                let id = old.id
                Task {
                    await old.end(finalContent, dismissalPolicy: .immediate)
                    await MainActor.run {
                        logger.info("[LiveActivity][start] cleanup ended id=\(id)")
                    }
                }
            }
        }

        carouselIndex = 0
        lastPushedState = nil
        lastPushDate = .distantPast
        pendingPushWorkItem?.cancel()
        pendingPushWorkItem = nil
        pendingState = nil
        let now = Date()
        minimalShowsTool = false

        // [T-ios-live-activity-task-count] Only trust sessions the tracker still
        // considers active — the caller's `sessions` list can lag when tasks
        // finished between snapshot and start. Completed carryover snapshots
        // stay for their UI card but must NOT be counted as running.
        let liveIds = SessionActivityTracker.shared.activeSessions
        let filteredInput = sessions.filter { liveIds.contains($0.sessionId) }
        let activeSids = Set(filteredInput.map { $0.sessionId })
        var merged = filteredInput
        for (sid, snap) in completedSessionSnapshots where !activeSids.contains(sid) {
            merged.append(snap)
        }
        let liveCount = merged.reduce(0) { $0 + ($1.isCompleted ? 0 : 1) }

        for sid in completedSessionSnapshots.keys where !liveIds.contains(sid) {
            completedSessionSnapshots.removeValue(forKey: sid)
        }

        // [T-ios-live-activity-audio-toggle] Stamp audio fields on the initial
        // state so an activity started purely by audio (or with audio alongside a
        // task) renders the play/pause control from the very first frame.
        let state = withAudioState(AgentActivityAttributes.ContentState(
            activeSessionCount: liveCount,
            sessions: merged,
            carouselIndex: 0,
            soulName: Self.currentSoulName(),
            latestToolIcon: Self.latestToolIcon(),
            minimalShowsTool: minimalShowsTool
        ))
        let attributes = AgentActivityAttributes(startDate: now)
        let content = ActivityContent(state: state, staleDate: Self.staleDate(for: state))

        do {
            let activity = try Activity.request(
                attributes: attributes,
                content: content,
                pushType: requestPushType
            )
            currentActivity = activity
            observePushToken(of: activity)
            startTime = now
            // Record so the first _updateActivity dedup compares correctly and a
            // later audio-only end has a snapshot to reason about.
            lastPushedState = state
            lastPushDate = now
            logger.info("[LiveActivity][start] Started activity id=\(activity.id) sessions=\(sessions.count) audioLoaded=\(state.isAudioLoaded)")
        } catch {
            if Self.isNotForegroundFailure(error) {
                logger.info("[LiveActivity][start] not started: app not foreground (\(error.localizedDescription))")
            } else {
                logger.error("[LiveActivity][start] Failed to start: \(error.localizedDescription)")
            }
        }
    }

    /// [T-ios-live-activity-multisession-dismiss] Per-session completed state,
    /// keyed by session ID. Survives across updates so that a session marked
    /// completed stays rendered as completed even as other sessions continue
    /// to trigger updates.
    private var completedSessionSnapshots: [String: LiveSessionSnapshot] = [:]

    /// [T-ios-delete-session-live-activity] Session IDs the user has deleted.
    /// A deleted streaming session's teardown (VM cancel → endBackgroundProcessing)
    /// races with the delete cleanup and can call markSessionCompleted /
    /// finishActivity for the just-deleted session — this set makes those late
    /// calls no-ops so deleted content never reappears in the Live Activity.
    /// IDs are UUIDs, so the set stays tiny across an app run.
    private var deletedSessionIds: Set<String> = []

    @available(iOS 16.2, *)
    private func _handleSessionDeleted(_ sessionId: String) {
        deletedSessionIds.insert(sessionId)
        _removeSession(sessionId, tag: "sessionDeleted")
    }

    /// [T-la-false-failure] Take a session off the card without a verdict. The
    /// phone stopped following a Mac task that is still running (console left
    /// the screen): resting it as done / paused / failed would all be wrong,
    /// so it simply disappears; other sessions keep their card.
    func dropSession(_ sessionId: String) {
        guard Self.isActivityKitAvailable else { return }
        _removeSession(sessionId, tag: "dropSession")
    }

    @available(iOS 16.2, *)
    private func _removeSession(_ sessionId: String, tag: String) {
        completedSessionSnapshots.removeValue(forKey: sessionId)

        let system = Activity<AgentActivityAttributes>.activities
        guard currentActivity != nil || !system.isEmpty else {
            logger.info("[LiveActivity][\(tag)] sid=\(sessionId.prefix(8)) — no activity on screen, nothing to clean")
            return
        }

        // What the activity would still represent after removing this session:
        // still-running tracker sessions plus whatever the last pushed state
        // shows (covers the soft-finished "completed" resting state, whose
        // sessions only live in lastPushedState).
        let shown = (lastPushedState as? AgentActivityAttributes.ContentState)?.sessions ?? []
        let remainingShown = shown.filter { $0.sessionId != sessionId }
        let remainingActive = SessionActivityTracker.shared.activeSessions.subtracting([sessionId])

        if !remainingActive.isEmpty {
            // Other sessions still running — the normal update path rebuilds
            // snapshots from the tracker (which no longer contains the deleted
            // id) and dedups if the pushed state wouldn't change. Also covers
            // a just-started activity whose initial content isn't recorded in
            // lastPushedState yet.
            logger.info("[LiveActivity][\(tag)] sid=\(sessionId.prefix(8)) — \(remainingActive.count) session(s) still active, updating in place")
            BackgroundKeepAliveManager.shared.updateLiveActivityIfNeeded(source: "sessionDeleted")
            return
        }

        if remainingShown.isEmpty && completedSessionSnapshots.isEmpty {
            logger.info("[LiveActivity][\(tag)] sid=\(sessionId.prefix(8)) — no sessions remain, ending activity immediately")
            _endActivity()
            return
        }

        guard shown.count != remainingShown.count else {
            // Deleted session isn't displayed; other sessions' activity stays as-is.
            logger.info("[LiveActivity][\(tag)] sid=\(sessionId.prefix(8)) — not displayed in activity, no-op")
            return
        }

        // Soft-finished activity showing only completed sessions — push the
        // filtered state directly so the deleted one disappears while the rest
        // keep lingering until foreground dismissal.
        guard let activity = currentActivity as? Activity<AgentActivityAttributes>,
              let prev = lastPushedState as? AgentActivityAttributes.ContentState else { return }
        logger.info("[LiveActivity][\(tag)] sid=\(sessionId.prefix(8)) — trimming soft-finished activity to \(remainingShown.count) session(s)")
        let state = AgentActivityAttributes.ContentState(
            activeSessionCount: remainingShown.count,
            sessions: remainingShown,
            carouselIndex: 0,
            soulName: prev.soulName,
            latestToolIcon: prev.latestToolIcon,
            minimalShowsTool: false,
            allCompleted: prev.allCompleted
        )
        carouselIndex = 0
        pushState(state, activity: activity)
    }

    @available(iOS 16.2, *)
    private func _markSessionCompleted(sessionId: String, lastMessage: String) {
        guard !deletedSessionIds.contains(sessionId) else {
            logger.info("[LiveActivity][markCompleted] sid=\(sessionId.prefix(8)) — session was deleted, skipping")
            return
        }
        let prev = (lastPushedState as? AgentActivityAttributes.ContentState)?
            .sessions.first { $0.sessionId == sessionId }
        var snap = prev ?? LiveSessionSnapshot(
            sessionId: sessionId, title: AppLocalized("Agent Task"),
            toolIcon: "checkmark.circle.fill", toolStatus: "", loopIteration: 0
        )
        Self.applyOutcome(to: &snap, lastMessage: Self.collapseLastMessage(lastMessage))
        completedSessionSnapshots[sessionId] = snap
        logger.info("[LiveActivity][markCompleted] sid=\(sessionId.prefix(8)) — other sessions still active, updating in-place")
        BackgroundKeepAliveManager.shared.updateLiveActivityIfNeeded(source: "sessionCompleted")
    }

    @available(iOS 16.2, *)
    /// - Parameter bypassRateLimit: skip the 3s/5s push throttle. Pass true ONLY
    ///   for discrete user-initiated events (the Live Activity audio toggle) that
    ///   demand immediate visual feedback. Agent-driven refreshes must leave this
    ///   false so the throttle keeps damping their high-frequency churn.
    ///   [T-live-activity-audio-toggle-latency]
    private func _updateActivity(sessions: [LiveSessionSnapshot], bypassRateLimit: Bool = false) {
        // [T-ios-live-activity-audio-toggle] Audio-only case: with no activity on
        // screen, restart if EITHER there are sessions OR audio is active (loaded).
        // The old guard was `!sessions.isEmpty` only, which blocked a pure-audio
        // Live Activity from ever (re)starting.
        if currentActivity == nil, !sessions.isEmpty || Self.isAudioActive() {
            logger.info("[LiveActivity][update] currentActivity is nil but sessions=\(sessions.count) audioActive=\(Self.isAudioActive()) — restarting")
            _startActivity(sessions: sessions)
            return
        }
        guard let activity = currentActivity as? Activity<AgentActivityAttributes> else {
            let systemCount = Activity<AgentActivityAttributes>.activities.count
            logger.info("[LiveActivity][update] skipped: currentActivity is nil but systemActivities.count=\(systemCount)")
            return
        }

        // [T-ios-live-activity-task-count] Trust the tracker for who's actually
        // running right now. The caller's `sessions` list is assembled upstream
        // and can carry entries whose tasks finished before this update landed;
        // if we forward them verbatim the Dynamic Island keeps showing a stale
        // running count (repro: 8 shown while only 2 isRunning).
        let liveIds = SessionActivityTracker.shared.activeSessions
        let filteredInput = sessions.filter { liveIds.contains($0.sessionId) }
        let activeSids = Set(filteredInput.map { $0.sessionId })
        var mergedSessions: [LiveSessionSnapshot] = filteredInput.map { s in
            guard let snap = completedSessionSnapshots[s.sessionId] else { return s }
            return snap
        }
        for (sid, snap) in completedSessionSnapshots where !activeSids.contains(sid) {
            mergedSessions.append(snap)
        }
        let liveCount = mergedSessions.reduce(0) { $0 + ($1.isCompleted ? 0 : 1) }

        // Prune completed snapshots whose sessions are no longer tracked.
        // They get one last push above, then are removed so sessions.count
        // converges to the tracker's active count instead of growing forever.
        for sid in completedSessionSnapshots.keys where !liveIds.contains(sid) {
            completedSessionSnapshots.removeValue(forKey: sid)
        }

        if mergedSessions.count > 1 {
            carouselIndex = (carouselIndex + 1) % mergedSessions.count
        } else {
            carouselIndex = 0
        }
        let toolIcon = Self.latestToolIcon()
        minimalShowsTool = toolIcon.isEmpty ? false : !minimalShowsTool

        // [T-ios-live-activity-audio-toggle] Stamp audio fields NOW so the dedup
        // comparison below sees them — otherwise a pure audio play/pause change
        // (identical sessions) would be treated as "unchanged" and skipped, and
        // the LA icon would never flip. `pushState` stamps again harmlessly
        // (idempotent — same values).
        let state = withAudioState(AgentActivityAttributes.ContentState(
            activeSessionCount: liveCount,
            sessions: mergedSessions,
            carouselIndex: carouselIndex,
            soulName: Self.currentSoulName(),
            latestToolIcon: toolIcon,
            minimalShowsTool: minimalShowsTool
        ))

        // [T-la-stale] Unchanged state is skipped — except for the heartbeat
        // that pushes the stale date forward while work is in flight.
        if let prev = lastPushedState as? AgentActivityAttributes.ContentState, prev == state,
           Date().timeIntervalSince(lastPushDate) < Self.heartbeatInterval {
            logger.info("[LiveActivity][update] #\(self.updateCount) DEDUP-SKIP (state unchanged)")
            return
        }

        // [T-live-activity-audio-toggle-latency] A push triggered by the user
        // TAPPING the audio button skips the throttle: the whole point of the
        // control is immediate feedback, and waiting out the interval left the
        // speaker glyph showing the wrong state for up to 5s in the background.
        // This is safe to exempt because it is a discrete, user-initiated event
        // (one tap = one push), not the high-frequency Agent tool-status churn
        // the throttle exists to damp — those callers still pass false and are
        // unaffected. The DEDUP-SKIP above still runs first, so an unchanged
        // state never reaches activity.update() even on this path.
        let isBackground = UIApplication.shared.applicationState != .active
        let minInterval: TimeInterval = isBackground ? Self.backgroundPushInterval : 3.0
        let elapsed = Date().timeIntervalSince(lastPushDate)
        // [T-la-approval] "Needs your OK" must not wait out the throttle: it is
        // the one change the user has to see now (and the push carries the alert).
        let previouslyWaiting = Set(
            ((lastPushedState as? AgentActivityAttributes.ContentState)?.sessions ?? [])
                .filter(\.needsApproval).map(\.sessionId))
        let newlyWaiting = state.sessions.contains { $0.needsApproval && !previouslyWaiting.contains($0.sessionId) }

        if elapsed < minInterval, !bypassRateLimit, !newlyWaiting {
            pendingState = state
            if pendingPushWorkItem == nil {
                let delay = minInterval - elapsed
                logger.info("[LiveActivity][update] #\(self.updateCount) RATE-LIMIT defer \(String(format: "%.1f", delay))s (bg=\(isBackground))")
                let work = DispatchWorkItem { [weak self] in
                    guard let self else { return }
                    self.pendingPushWorkItem = nil
                    guard let pending = self.pendingState as? AgentActivityAttributes.ContentState else { return }
                    self.pendingState = nil
                    self.pushState(pending, activity: activity)
                }
                pendingPushWorkItem = work
                DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: work)
            }
            return
        }

        if bypassRateLimit, elapsed < minInterval {
            logger.info("[LiveActivity][update] #\(self.updateCount) RATE-LIMIT BYPASS (user audio toggle, elapsed=\(String(format: "%.1f", elapsed))s < \(String(format: "%.1f", minInterval))s)")
        }
        // Cancelling any queued work item + clearing pendingState here is what
        // keeps the bypass from double-pushing: a deferred push that was already
        // scheduled would otherwise fire moments after this one and flip the
        // glyph twice. pushState() refreshes lastPushDate, so the throttle window
        // restarts from this push for every subsequent (non-bypass) caller.
        pendingPushWorkItem?.cancel()
        pendingPushWorkItem = nil
        pendingState = nil
        pushState(state, activity: activity)
    }

    /// [T-ios-live-activity-audio-toggle] Overlay the current audio state onto a
    /// ContentState right before it's pushed/requested, so every live/running
    /// state (start, update, renew, delete-trim) carries fresh audio fields
    /// without editing each construction site. The end/cleanup "empty" states
    /// intentionally do NOT go through this (they represent teardown).
    @available(iOS 16.2, *)
    private func withAudioState(_ state: AgentActivityAttributes.ContentState) -> AgentActivityAttributes.ContentState {
        let audio = Self.currentAudioState()
        var s = state
        s.isAudioPlaying = audio.isPlaying
        s.isAudioLoaded = audio.isLoaded
        s.audioTitle = audio.title
        // [V-la] Cap strings/rows last: an oversize state is dropped by ActivityKit silently.
        return withPrivacyRedaction(s).cappedForPayload()
    }

    /// [T-ios-live-activity-privacy-mode] Data-layer redaction: strip every
    /// conversation-derived field (session title / tool status / tool icon /
    /// last message) right before the state is pushed, so the widget degrades
    /// to "task position + status + timer" without restructuring any view.
    /// The Soul name is NOT redacted (user-chosen persona label). Chained from
    /// `withAudioState`, which is the single decorator every LIVE state passes
    /// through (both `pushState` and the initial `Activity.request`), so no
    /// construction site needs editing and no live route can bypass it.
    ///
    /// What deliberately survives redaction: `activeSessionCount`, `isCompleted`
    /// / `allCompleted` (drive the "N sessions" vs "N completed" text and the
    /// green checkmark), the audio-control fields, and `attributes.startDate`
    /// (the elapsed timer lives there, not in ContentState).
    @available(iOS 16.2, *)
    private func withPrivacyRedaction(_ state: AgentActivityAttributes.ContentState) -> AgentActivityAttributes.ContentState {
        guard BackgroundKeepAliveManager.shared.liveActivityPrivacyMode else {
            // A Face ID–locked conversation is redacted on the Lock Screen
            // even with Privacy Mode off.
            var s = state
            s.sessions = s.sessions.map { snap in
                SessionLockStore.shared.isHiddenFromSystemSurfaces(snap.sessionId) ? Self.redactedRow(snap) : snap
            }
            if s.sessions.contains(where: { SessionLockStore.shared.isHiddenFromSystemSurfaces($0.sessionId) }) {
                s.latestToolIcon = Self.privacyLatestIcon(s)
                s.minimalShowsTool = false
            }
            return s
        }
        var s = state
        s.privacyMode = true
        // [T-ios-live-activity-privacy-duration] soulName deliberately survives
        // redaction now: it is the user's chosen Soul persona (an identity
        // label), not conversation content — forcing "LeoPhoneAgent" made Privacy Mode
        // gratuitously anonymous. The remaining redactions still strip
        // everything conversation-derived.
        // Neutral icon for the Dynamic Island trailing/expanded glyphs, and never
        // let the minimal icon flip to a tool glyph (it would leak which tool ran).
        s.latestToolIcon = Self.privacyLatestIcon(s)
        s.minimalShowsTool = false
        s.sessions = s.sessions.map(Self.redactedRow)
        return s
    }

    /// A content-free row: its position, its state and how it ended — never
    /// what it was about.
    @available(iOS 16.2, *)
    private static func redactedRow(_ snap: LiveSessionSnapshot) -> LiveSessionSnapshot {
        var redacted = snap
        // "Agent Task" + the view's existing "1/2" index chip reads as
        // "第 1/2 个智能体任务" — task position without task content.
        redacted.title = privacyTaskTitle
        if snap.isCompleted {
            // The real ending beside its icon, in the slot where the reply
            // summary appears outside Privacy Mode: a failed or stopped run
            // must not read "Completed".
            redacted.toolStatus = ""
            switch snap.outcome {
            case .done:
                redacted.toolIcon = "checkmark.circle.fill"
                redacted.lastMessage = privacyCompletedStatus
            case .attention:
                redacted.toolIcon = "exclamationmark.circle.fill"
                redacted.lastMessage = AppLocalized("Needs attention")
            case .paused:
                // A run parked until the app returns says so (no content in it).
                redacted.toolIcon = pausedIcon
                redacted.lastMessage = privacyPausedStatus
            case .stopped:
                redacted.toolIcon = "stop.circle.fill"
                redacted.lastMessage = AppLocalized("Stopped")
            }
        } else if snap.needsApproval {
            // A run waiting for your OK says so even in Privacy Mode (no command text).
            redacted.toolStatus = privacyApprovalStatus
            redacted.toolIcon = LiveSessionSnapshot.approvalIcon
            redacted.lastMessage = ""
        } else if snap.needsAnswer {
            // [T-ask-user] Content-free: the question itself never reaches the lock screen here.
            redacted.toolStatus = AppLocalized("等你回答")
            redacted.toolIcon = LiveSessionSnapshot.questionIcon
            redacted.lastMessage = ""
        } else if snap.toolIcon == pausedIcon {
            redacted.toolStatus = privacyPausedStatus
            redacted.toolIcon = pausedIcon
            redacted.lastMessage = ""
        } else {
            redacted.toolStatus = privacyWorkingStatus
            redacted.toolIcon = privacyNeutralIcon
            redacted.lastMessage = ""
        }
        return redacted
    }

    /// The shared glyph once everything has ended follows the most urgent
    /// ending, like the unredacted card.
    @available(iOS 16.2, *)
    private static func privacyLatestIcon(_ state: AgentActivityAttributes.ContentState) -> String {
        guard state.allCompleted else { return privacyNeutralIcon }
        return state.sessions.contains { $0.outcome == .attention } ? "exclamationmark.circle.fill" : "checkmark.circle.fill"
    }

    /// Neutral placeholders used by Privacy Mode. Localized so the redacted
    /// strings still match the user's language.
    private static var privacyTaskTitle: String { AppLocalized("Agent Task") }
    private static var privacyWorkingStatus: String { AppLocalized("Working…") }
    private static var privacyCompletedStatus: String { AppLocalized("Completed") }
    private static var privacyApprovalStatus: String { AppLocalized("等你批准") }
    /// Content-free already: the text and glyph of a run parked until the app returns.
    private static var privacyPausedStatus: String { AppLocalized("已暂停，回到 App 继续") }
    private static let pausedIcon = "pause.circle.fill"

    /// [T-la-stale] A running card whose app stopped updating it (killed,
    /// frozen, relay gone) turns "stale" after this long; while work is in
    /// flight the heartbeat re-pushes well before that.
    /// [T-la-false-failure] 20 min, not 5: ActivityKit rations background
    /// updates, and a long tool-heavy run (dozens of tool calls, one push each)
    /// exhausts the budget, after which the system holds our updates for
    /// minutes. With a 5-minute window the card flipped to "may be interrupted"
    /// while the task was running fine; a dead process is still caught, later.
    static let staleInterval: TimeInterval = 20 * 60
    static let heartbeatInterval: TimeInterval = 2 * 60
    /// Minimum spacing of background pushes. Tool changes arrive every few
    /// seconds on a busy run; pushing each one spends the update budget the
    /// stale window depends on. Newly needing approval bypasses this.
    static let backgroundPushInterval: TimeInterval = 15

    @available(iOS 16.2, *)
    static func staleDate(for state: AgentActivityAttributes.ContentState) -> Date? {
        state.allCompleted || state.sessions.isEmpty ? nil : Date().addingTimeInterval(staleInterval)
    }
    private static let privacyNeutralIcon = "circle.dashed"

    @available(iOS 16.2, *)
    private func pushState(_ rawState: AgentActivityAttributes.ContentState, activity: Activity<AgentActivityAttributes>) {
        let state = withAudioState(rawState)
        let previous = lastPushedState as? AgentActivityAttributes.ContentState
        lastPushedState = state
        lastPushDate = Date()
        updateCount += 1
        let count = updateCount
        let content = ActivityContent(state: state, staleDate: Self.staleDate(for: state))
        // [T-la-approval] Entering "needs your OK" is worth a buzz (it also
        // lights up the Dynamic Island and taps the watch); nothing else is.
        let newlyWaiting = state.sessions.filter { snap in
            snap.needsApproval && !(previous?.sessions.contains { $0.sessionId == snap.sessionId && $0.needsApproval } ?? false)
        }
        // [T-presence-quiet] 正在用 App 时不带提醒更新:App 里的审批卡已经在眼前,灵动岛再展开一次
        // 只会挡住正在看的内容(用户 2026-09-26 反馈)。离开 App 后还没批的,由审批通知接着提醒。
        let alert = newlyWaiting.isEmpty || UIApplication.shared.leoIsInUse ? nil : AlertConfiguration(
            title: LocalizedStringResource("需要你批准"),
            body: LocalizedStringResource(stringLiteral: state.privacyMode ? AppLocalized("有一步在等你批准") : newlyWaiting[0].title),
            sound: .default)
        logger.info("[LiveActivity][push] #\(count) active=\(state.activeSessionCount) sessions=\(state.sessions.count) alert=\(alert != nil)")
        updateCoalescer.submit(PendingActivityUpdate(activity: activity, content: content, alert: alert, count: count))
        registerPushTokenIfSessionsChanged(state)
    }

    private struct PendingActivityUpdate {
        let activity: Activity<AgentActivityAttributes>
        let content: ActivityContent<AgentActivityAttributes.ContentState>
        let alert: AlertConfiguration?
        let count: Int
    }

    /// [T-la-serial] ActivityKit calls must land in the order they were made — a
    /// late "running" after "completed" resurrected finished cards. [WP-41] Was a
    /// Task chain that replayed every frame; now single-flight with a replaceable
    /// next value: one update in flight, newer states overwrite the queued one
    /// (each is a full state), the newest always lands last. A dropped frame's
    /// "needs your OK" alert is carried into its replacement.
    private lazy var updateCoalescer = SingleFlightCoalescer<PendingActivityUpdate>(
        merge: { old, new in
            PendingActivityUpdate(activity: new.activity, content: new.content,
                                  alert: new.alert ?? old.alert, count: new.count)
        },
        perform: { item in
            await item.activity.update(item.content, alertConfiguration: item.alert)
            logger.info("[LiveActivity][push] #\(item.count) activity.update() returned")
        })

    // MARK: - [WP-41] Remote push token

    private func observePushToken(of activity: Activity<AgentActivityAttributes>) {
        pushTokenTask?.cancel()
        currentPushToken = nil
        registeredTokenSessions = []
        registeringTokenSessions = nil
        guard remotePush else { return }
        pushTokenTask = Task { [weak self] in
            for await data in activity.pushTokenUpdates {
                let token = LiveActivityTokenRegistration.hex(data)
                guard let self else { return }
                // 同一张卡的 token 轮换:旧的向中继注销(DELETE /relay/api/device/activity-token),
                // 中继不再往死 token 推。旧中继没有这个接口,注销失败就是以前的行为。
                if let old = self.currentPushToken, old != token {
                    Task { await PushRegistrar.shared.unregisterActivityUpdateToken(old) }
                }
                self.currentPushToken = token
                self.registeredTokenSessions = []
                self.registeringTokenSessions = nil
                if let state = self.lastPushedState as? AgentActivityAttributes.ContentState {
                    self.registerPushTokenIfSessionsChanged(state)
                }
            }
        }
    }

    /// 卡上的会话变了(新 Mac 任务上卡)就用同一个 token 重新登记,中继才找得到它。
    private func registerPushTokenIfSessionsChanged(_ state: AgentActivityAttributes.ContentState) {
        guard remotePush, let token = currentPushToken else { return }
        let key = LiveActivityTokenRegistration.sessionKey(state.sessions)
        guard !key.isEmpty, key != registeredTokenSessions, key != registeringTokenSessions else { return }
        registeringTokenSessions = key
        let sessions = state.sessions, privacyMode = state.privacyMode
        Task { [weak self] in
            let ok = await PushRegistrar.shared.registerActivityUpdateToken(token, sessions: sessions,
                                                                            privacyMode: privacyMode)
            // 中继回 2xx 才记为已登记;失败(PushRegistrar 内已退避重试过)留空,下一次状态推送再登记。
            // 期间 token 换了 / 会话又变了:结果作废,由新的那次负责。
            guard let self, self.currentPushToken == token, self.registeringTokenSessions == key else { return }
            self.registeringTokenSessions = nil
            if ok { self.registeredTokenSessions = key }
        }
    }

    @available(iOS 16.2, *)
    private func _finishActivity(lastMessages provided: [String: String] = [:]) async {
        guard !isFinishing else {
            logger.info("[LiveActivity][finish] already finishing — skip duplicate call")
            return
        }
        isFinishing = true
        defer { isFinishing = false }

        guard let activity = currentActivity as? Activity<AgentActivityAttributes> else {
            logger.info("[LiveActivity][finish] no current activity — falling back to end")
            _endActivity()
            return
        }
        guard let running = lastPushedState as? AgentActivityAttributes.ContentState,
              !running.sessions.isEmpty else {
            logger.info("[LiveActivity][finish] no running snapshot — ending instead")
            _endActivity()
            return
        }

        pendingPushWorkItem?.cancel()
        pendingPushWorkItem = nil
        pendingState = nil

        // [T-ios-delete-session-live-activity] Never soft-finish into a state
        // that displays a deleted session. If every session was deleted, hard-end.
        let runningSessions = running.sessions.filter { !deletedSessionIds.contains($0.sessionId) }
        guard !runningSessions.isEmpty else {
            logger.info("[LiveActivity][finish] all sessions deleted — ending instead of soft-finish")
            _endActivity()
            return
        }
        awaitingDismissal = true

        let soul = Self.currentSoulName()
        var resolvedMessages: [String: String] = [:]
        for s in runningSessions {
            let raw: String
            if let msg = provided[s.sessionId], !msg.isEmpty {
                raw = msg
            } else {
                raw = await ChatStore.shared.getSession(s.sessionId)?.lastMessage ?? ""
            }
            resolvedMessages[s.sessionId] = Self.collapseLastMessage(raw)
        }
        let completedSessions = runningSessions.map { s -> LiveSessionSnapshot in
            var c = s
            // A session already rested by markSessionCompleted keeps its outcome.
            if !s.isCompleted {
                Self.applyOutcome(to: &c, lastMessage: resolvedMessages[s.sessionId] ?? "")
            }
            return c
        }
        let anyAttention = completedSessions.contains { $0.outcome == .attention }
        // [T-ios-live-activity-audio-toggle] Keep the audio control alive into the
        // completed resting state — the TTS narration of the just-finished reply
        // is often still playing, and the user should be able to pause it from the
        // lingering Live Activity.
        var finishedRaw = AgentActivityAttributes.ContentState(
            activeSessionCount: completedSessions.count,
            sessions: completedSessions,
            carouselIndex: 0,
            soulName: soul,
            latestToolIcon: anyAttention ? "exclamationmark.circle.fill" : "checkmark.circle.fill",
            minimalShowsTool: false,
            allCompleted: true
        )
        // [T-ios-live-activity-privacy-duration] Stamp the finish moment so the
        // widget can show the static total run time in the resting state.
        finishedRaw.finishedAt = Date()
        let finished = withAudioState(finishedRaw)
        guard self.awaitingDismissal,
              self.currentActivity as? Activity<AgentActivityAttributes> != nil else {
            logger.info("[LiveActivity][finish] dropped completed push — activity already dismissed")
            return
        }
        let content = ActivityContent(state: finished, staleDate: nil)
        // Behind any running-state update still in flight, never ahead of it.
        await updateCoalescer.waitUntilIdle()
        // The user may have come back meanwhile: the foreground hook ended it.
        guard self.awaitingDismissal,
              (self.currentActivity as? Activity<AgentActivityAttributes>)?.id == activity.id else {
            logger.info("[LiveActivity][finish] dropped completed state — activity ended while finishing")
            return
        }
        if Self.isAudioActive() {
            // The finished reply is still being read aloud: keep the card (and its
            // pause control) as the completed resting state until the user is back.
            await activity.update(content)
            self.lastPushedState = finished
            self.lastPushDate = Date()
            logger.info("[LiveActivity][finish] activity id=\(activity.id) flipped to completed (\(completedSessions.count) session(s)), read-aloud still on — awaiting foreground dismissal")
            return
        }
        // [la-foreground] The work is over: END the activity with its final state
        // (the system's default dismissal — off the Dynamic Island now, on the
        // Lock Screen for a while) instead of leaving a live card up until the
        // app is opened. Coming back to the app removes it at once (`endAll`).
        clearActivityState(keepStartTime: true)
        finalStateActivities.append(activity)
        await activity.end(content, dismissalPolicy: .default)
        logger.info("[LiveActivity][finish] activity id=\(activity.id) ended with final state (\(completedSessions.count) session(s)), default dismissal")
    }

    /// Rest a snapshot according to how its run actually ended.
    ///
    /// The outcome comes from `SessionActivityTracker.lastOutcomes`, the one
    /// place every run ending is recorded — not from whichever caller happens to
    /// finish the activity first (the keep-alive teardown and the view model race
    /// here, and the teardown knows nothing about the result).
    static func applyOutcome(to snap: inout LiveSessionSnapshot, lastMessage: String) {
        let phase = SessionActivityTracker.shared.lastOutcomes[snap.sessionId]
        snap.isCompleted = true
        snap.outcome = LiveSessionSnapshot.RestingOutcome(ending: phase)
        snap.lastMessage = lastMessage
        switch snap.outcome {
        case .stopped:
            snap.toolIcon = "stop.circle.fill"
            snap.toolStatus = AppLocalized("Stopped")
        case .paused:
            // [T-la-false-failure] Not a verdict: the run carries on once the app
            // is back. Pause glyph, not the orange exclamation.
            snap.toolIcon = "pause.circle.fill"
            snap.toolStatus = AppLocalized("已暂停，回到 App 继续")
        case .attention:
            snap.toolIcon = "exclamationmark.circle.fill"
            snap.toolStatus = AppLocalized("Needs attention")
        case .done:
            snap.toolIcon = "checkmark.circle.fill"
            snap.toolStatus = AppLocalized("Completed")
        }
    }

    /// Collapse a stored last-message body to a single trimmed line, capped.
    private static func collapseLastMessage(_ raw: String) -> String {
        let collapsed = raw
            .replacingOccurrences(of: "\n", with: " ")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return String(collapsed.prefix(120))
    }

    @available(iOS 16.2, *)
    private func _endActivity() {
        isFinishing = false
        let current = currentActivity as? Activity<AgentActivityAttributes>
        clearActivityState(keepStartTime: false)
        // [la-foreground] Relay-started cards end below too: tell the relay their
        // update tokens are dead, so its next event push-to-starts a card instead
        // of updating one that is gone.
        PushRegistrar.shared.forgetRelayActivityTokens()
        let currentId = current?.id ?? "nil"
        let finalState = AgentActivityAttributes.ContentState(
            activeSessionCount: 0,
            sessions: [],
            carouselIndex: 0,
            soulName: ""
        )
        let content = ActivityContent(state: finalState, staleDate: nil)

        let all = Activity<AgentActivityAttributes>.activities
        let allIds = all.map { $0.id }.joined(separator: ",")
        logger.info("[LiveActivity][end] currentActivity.id=\(currentId) systemActivities.count=\(all.count) systemIds=[\(allIds)]")
        for activity in all {
            let id = activity.id
            Task {
                await activity.end(content, dismissalPolicy: .immediate)
                await MainActor.run {
                    logger.info("[LiveActivity][end] ended id=\(id)")
                }
            }
        }

        if let current, !all.contains(where: { $0.id == current.id }) {
            let id = current.id
            logger.warning("[LiveActivity][end] currentActivity id=\(id) missing from systemActivities — ending directly")
            Task {
                await current.end(content, dismissalPolicy: .immediate)
                await MainActor.run {
                    logger.info("[LiveActivity][end] orphan currentActivity ended id=\(id)")
                }
            }
        }
    }

    /// Forget the card this process owns (it was ended, or is being ended).
    /// [la-foreground] Its update token is unregistered from the relay: a card
    /// ended on foreground return must not keep receiving relay updates, or the
    /// relay never push-to-starts a new one for that session.
    @available(iOS 16.2, *)
    private func clearActivityState(keepStartTime: Bool) {
        awaitingDismissal = false
        lastPushedState = nil
        pendingPushWorkItem?.cancel()
        pendingPushWorkItem = nil
        pendingState = nil
        completedSessionSnapshots = [:]
        pushTokenTask?.cancel()
        pushTokenTask = nil
        if let token = currentPushToken {
            Task { await PushRegistrar.shared.unregisterActivityUpdateToken(token) }
        }
        currentPushToken = nil
        registeredTokenSessions = []
        registeringTokenSessions = nil
        currentActivity = nil
        // The finish path keeps it: the completion notification reports the run time.
        if !keepStartTime { startTime = nil }
        carouselIndex = 0
    }
}
