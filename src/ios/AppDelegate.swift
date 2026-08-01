//
//  AppDelegate.swift
//  MinisApp
//
//  Minimal UIApplicationDelegate stub mounted via
//  `@UIApplicationDelegateAdaptor` so we can receive
//  `UIApplicationShortcutItem` events. SwiftUI's `App` lifecycle does
//  not surface Home-Screen Quick Actions on its own — only the
//  legacy UIKit delegate path delivers them reliably across cold
//  launch (via launchOptions) AND warm tap (via
//  `application(_:performActionFor:completionHandler:)`).
//
//  Everything else (URL handling, scene phase, etc.) continues to
//  flow through the SwiftUI App lifecycle — this class only forwards
//  shortcut events to `QuickActionRouter`.
//

import CoreLocation
import CoreSpotlight
import UIKit

private let logger = AppLogger(category: "AppDelegate")

final class AppDelegate: NSObject, UIApplicationDelegate {

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        if #available(iOS 17.0, *) {
            CLBackgroundActivitySession().invalidate()
        }

        // [T-notification-tap-vs-launch-session] The UNUserNotificationCenter
        // delegate must be in place BEFORE didFinishLaunching returns, or iOS
        // never delivers a cold-launch notification tap to didReceive — the
        // app then falls through to the Launch Session preference and opens
        // the wrong (new) session. The .onAppear registration in MinisApp
        // remains as an idempotent backstop.
        ShortcutNotificationDelegate.shared.register()

        // Refresh the dynamic shortcut list every cold launch. The
        // items themselves are stable, but their localized titles
        // depend on the current `String(localized:)` resolution which
        // can change when the user switches in-app language.
        Task { @MainActor in
            QuickActionRouter.registerShortcutItems()
        }

        // [T-bg-keepalive-default-on] Both `enhancedBackgroundExecution` and
        // `backgroundSpeakEnabled` read through UserDefaults.bool(forKey:),
        // which is false when the key is absent — so a fresh install had NO
        // keep-alive and every backgrounded run died when the finite
        // background task expired. That is wrong for an agent whose whole
        // point is running long tasks, and it silently broke widget-launched
        // runs (those start with the app in the background). Opt in once;
        // the marker means a user who later turns it off stays off.
        // Written SYNCHRONOUSLY: a widget-launched AppIntent can reach
        // armEagerlyForShortcut on the same main-actor hop, and an async
        // Task here would have it read the old `false` and skip keep-alive
        // on exactly the first run this is meant to protect.
        //
        // [T-keepalive-optin-upgrade-path] The marker key is itself new, so on
        // an EXISTING install it is also absent — the first run of this build
        // would force keep-alive (background audio + a location session) back
        // on for someone who had deliberately turned it off. Only opt in when
        // neither switch has ever been written, which is what actually
        // distinguishes "fresh install" from "user made a choice".
        let keepAliveOptInKey = "bg.keepAliveDefaultOptIn.v1"
        let hasExistingChoice = UserDefaults.standard.object(forKey: "enhancedBackgroundExecution") != nil
            || UserDefaults.standard.object(forKey: "backgroundSpeakEnabled") != nil
        if !UserDefaults.standard.bool(forKey: keepAliveOptInKey) {
            UserDefaults.standard.set(true, forKey: keepAliveOptInKey)
            if hasExistingChoice {
                logger.info("[KeepAlive] first-run opt-in skipped — user already has a setting")
            } else {
                UserDefaults.standard.set(true, forKey: "enhancedBackgroundExecution")
                UserDefaults.standard.set(true, forKey: "backgroundSpeakEnabled")
                logger.info("[KeepAlive] enabled by first-run opt-in")
            }
        }

        // [T-watch-companion] Inert unless a watch app is installed.
        WatchBridge.shared.activate()
        // [T-automation-engine] Region wakes relaunch the app in the
        // BACKGROUND — the monitor delegate must exist before iOS delivers
        // the event, not when the settings page happens to appear.
        AutomationEngine.shared.reloadMonitoring()

        // [T-widget-run-in-place] Teach the shared widget intent how to reach
        // the agent loop. The intent type is compiled into the widget target
        // too, where this handler is never installed — harmless, because the
        // system performs LiveActivityIntent in the app's process.
        WidgetIntentBridge.shared.runQuickTaskHandler = { taskId in
            await QuickTaskWidgetRunner.run(taskId: taskId)
        }
        // [T-widget-stop] Console "stop" button. Cancels the real underlying
        // work for every running session — a cached ViewModel always exists
        // for a processing session (ViewModelCache never evicts those).
        WidgetIntentBridge.shared.stopAllTasksHandler = {
            await MainActor.run {
                var stopped = 0
                for sessionId in SessionActivityTracker.shared.activeSessions {
                    if let vm = ViewModelCache.shared.get(for: sessionId) {
                        vm.cancel(queuePolicy: .discardQueuedPrompts)
                        stopped += 1
                    } else {
                        // [T-widget-stop-eager-placeholder] An intent registers
                        // a synthetic "intent-eager:<uuid>" id with the tracker
                        // BEFORE its session (and view model) exist, so the app
                        // is kept alive while the session is being created.
                        // Those ids have no view model and were skipped in
                        // silence: Stop looked like it worked while the task
                        // went on to start anyway. Mark them cancelled so the
                        // intent aborts as soon as it has something to cancel.
                        SessionActivityTracker.shared.requestEagerCancel(sessionId)
                    }
                }
                logger.info("[Widget] stop-all cancelled \(stopped) session(s)")
            }
        }
        // [T-control-center] Control Center buttons land here after the
        // system has already foregrounded the app (openAppWhenRun = true).
        WidgetIntentBridge.shared.controlDestinationHandler = { destination in
            await MainActor.run {
                switch destination {
                case .newChat:
                    QuickActionRouter.shared.startNewChat()
                case .voice:
                    QuickActionRouter.shared.startVoiceChat()
                case .camera:
                    QuickActionWorkflow.shared.start(.openCamera)
                    QuickActionRouter.shared.startNewChat()
                }
            }
        }
        logger.info("didFinishLaunching (scene-based; shortcut routing happens in SceneDelegate)")
        // In a scene-based SwiftUI app, `launchOptions[.shortcutItem]`
        // is NOT populated for cold-launch shortcuts — the item is
        // delivered to `scene(_:willConnectTo:options:)` via
        // `UISceneConnectionOptions.shortcutItem` instead. Warm-tap
        // shortcuts are likewise delivered to
        // `windowScene(_:performActionFor:completionHandler:)` rather
        // than the UIApplication delegate. See SceneDelegate below.
        return true
    }

    /// Tell UIKit to instantiate our `SceneDelegate` for every window
    /// scene. SwiftUI still owns the actual UIWindow + root hosting
    /// controller; this SceneDelegate only handles shortcut routing
    /// (and could add other scene-scoped hooks later).
    func application(
        _ application: UIApplication,
        configurationForConnecting connectingSceneSession: UISceneSession,
        options: UIScene.ConnectionOptions
    ) -> UISceneConfiguration {
        let config = UISceneConfiguration(name: nil, sessionRole: connectingSceneSession.role)
        config.delegateClass = SceneDelegate.self
        return config
    }

    /// [T-willterminate-dead-code] This was defined on `SceneDelegate`, but
    /// `applicationWillTerminate` is a `UIApplicationDelegate` method — UIKit
    /// only ever sends it to the APP delegate, so the crash-reporter flush and
    /// the `[T-ios-bgactivitysession-leak]` location-indicator teardown never
    /// actually ran on termination.
    func applicationWillTerminate(_ application: UIApplication) {
        CrashReporter.shared.onWillTerminate()
        // [T-ios-bgactivitysession-leak] Retract the background location session
        // + Live Activity on a clean exit so the system location indicator
        // doesn't stay pinned to the Dynamic Island after the app is gone.
        MainActor.assumeIsolated {
            BackgroundKeepAliveManager.shared.prepareForTermination()
        }
    }

}

/// Receives Home Screen Quick Action events in a scene-based SwiftUI
/// app. Mounted via `AppDelegate.configurationForConnecting`.
///
/// Two delivery paths:
///   - Cold launch: `scene(_:willConnectTo:options:)` carries the
///     tapped item in `connectionOptions.shortcutItem`.
///   - Warm tap:    `windowScene(_:performActionFor:completionHandler:)`
///     is invoked while the scene is already attached.
///
/// Both paths forward to `QuickActionRouter.shared.handle`, which
/// bumps `newChatTrigger` (subscribed by ContentView via @ObservedObject)
/// and also posts `.newChatRequested` as a redundancy.
final class SceneDelegate: NSObject, UIWindowSceneDelegate {

    /// Required by UIWindowSceneDelegate. SwiftUI manages the actual
    /// window contents — we just record a reference for potential
    /// later use and consume the cold-launch shortcut item.
    var window: UIWindow?

    func scene(
        _ scene: UIScene,
        willConnectTo session: UISceneSession,
        options connectionOptions: UIScene.ConnectionOptions
    ) {
        if let item = connectionOptions.shortcutItem {
            logger.info("scene willConnectTo: cold-launch shortcut type=\(item.type)")
            // Bump synchronously on the main actor. ContentView's
            // `.onAppear` belt-and-braces will route any unconsumed
            // trigger as soon as it mounts.
            Task { @MainActor in
                _ = QuickActionRouter.shared.handle(item)
            }
        } else {
            logger.info("scene willConnectTo (no shortcut)")
        }
        // [T-ios-ipad-airdrop-provider-json-no-import] Cold-launch URL
        // delivery. When the app is NOT already running and the user AirDrops
        // (or "Open in LeoPhoneAgent") a file, the file:// URL arrives here in
        // `connectionOptions.urlContexts` — NOT via SwiftUI `.onOpenURL`.
        // Providing this custom UIWindowSceneDelegate suppresses SwiftUI's
        // automatic URL-context bridging, so without forwarding these the
        // Provider-JSON import prompt never appears (the iPad-AirDrop symptom;
        // iPhone happened to still bridge in some launch paths). Route through
        // the SAME pipeline `.onOpenURL` uses.
        if !connectionOptions.urlContexts.isEmpty {
            Self.handleURLContexts(connectionOptions.urlContexts, phase: "willConnectTo")
        }
        // [T-spotlight-sessions] Cold-launch tap on a Spotlight result.
        for activity in connectionOptions.userActivities {
            Self.handleUserActivity(activity, phase: "willConnectTo")
        }
    }

    /// Warm tap on a Spotlight result.
    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        Self.handleUserActivity(userActivity, phase: "continue")
    }

    /// A Spotlight item's unique identifier IS the session id, so this reuses
    /// the existing open-session route rather than inventing a second one.
    private static func handleUserActivity(_ activity: NSUserActivity, phase: String) {
        guard activity.activityType == CSSearchableItemActionType,
              let sessionId = activity.userInfo?[CSSearchableItemActivityIdentifier] as? String,
              !sessionId.isEmpty else { return }
        logger.info("[Spotlight] open session \(sessionId.prefix(8)) phase=\(phase)")
        Task { @MainActor in
            // [T-spotlight-cold-launch] Buffer BEFORE posting: on a cold launch
            // ContentView's onReceive is not mounted yet and a bare post is
            // simply lost — the app opened to the default session instead of
            // the search result. Same pending store the notification-tap path
            // uses; the launch .task consumes it once the UI is up, and a warm
            // tap is handled by the post + markHandled inside the receiver.
            NotificationNavigationStore.shared.setPending(sessionId)
            NotificationCenter.default.post(
                name: .openSessionFromIntent, object: nil,
                userInfo: ["sessionId": sessionId]
            )
        }
    }

    func windowScene(
        _ windowScene: UIWindowScene,
        performActionFor shortcutItem: UIApplicationShortcutItem,
        completionHandler: @escaping (Bool) -> Void
    ) {
        logger.info("windowScene performActionFor type=\(shortcutItem.type)")
        Task { @MainActor in
            let handled = QuickActionRouter.shared.handle(shortcutItem)
            completionHandler(handled)
        }
    }

    // [T-ios-ipad-airdrop-provider-json-no-import] Warm URL delivery. When the
    // app is ALREADY running, AirDrop / "Open in LeoPhoneAgent" delivers the file URL
    // here. A custom scene delegate must implement this or the URL is dropped
    // (SwiftUI's `.onOpenURL` no longer auto-receives it). Same pipeline as the
    // cold-launch path above and as MinisApp's `.onOpenURL`.
    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        Self.handleURLContexts(URLContexts, phase: "openURLContexts")
    }

    /// Route each opened URL through the shared import pipeline, mirroring
    /// MinisApp's `.onOpenURL`: a local file goes to `ExternalFileImporter`
    /// (which detects Provider-export JSON and prompts import-vs-attach), and
    /// anything else falls through to `DeepLinkRouter`. Uses
    /// `ShareCoordinator.shared` — the exact instance MinisApp injects into the
    /// environment — so `raisePendingShare()` drives the same SwiftUI flow.
    private static func handleURLContexts(_ contexts: Set<UIOpenURLContext>, phase: String) {
        for context in contexts {
            let url = context.url
            logger.info("[Share] scene \(phase) URL scheme=\(url.scheme ?? "nil") host=\(url.host ?? "nil")")
            Task { @MainActor in
                let coordinator = ShareCoordinator.shared
                if ExternalFileImporter.canIngest(url) {
                    ExternalFileImporter.ingest(url, into: coordinator)
                } else {
                    DeepLinkRouter.handle(url: url, shareCoordinator: coordinator)
                }
            }
        }
    }

}
