import XCTest

/// [la-foreground] The Live Activity only shows while a task runs AND the app is
/// away. In the conversation it covered content (iPad: the top banner).
final class LiveActivityPresencePolicyTests: XCTestCase {
    private typealias P = LiveActivityPresencePolicy

    private func decide(active: Bool, running: Bool, followed: Bool = true, enabled: Bool = true,
                        existing: Bool) -> P.Action {
        P.decide(appActive: active, taskRunning: running, followed: followed, enabled: enabled,
                 existingActivity: existing)
    }

    func testForegroundNeverShowsACard() {
        XCTAssertEqual(decide(active: true, running: true, existing: false), .none,
                       "running task in the open conversation: no card")
        XCTAssertEqual(decide(active: true, running: true, existing: true), .endImmediately,
                       "coming back to the app (or a relay push-to-start while in it) ends the card at once")
        XCTAssertEqual(decide(active: true, running: false, existing: true), .endImmediately)
        XCTAssertEqual(decide(active: true, running: false, existing: false), .none)
    }

    func testLeavingWhileRunningStartsAndBackgroundKeeps() {
        XCTAssertEqual(decide(active: false, running: true, existing: false), .start)
        XCTAssertEqual(decide(active: false, running: true, existing: true), .keep)
    }

    func testFinishingInBackgroundEndsWithFinalState() {
        XCTAssertEqual(decide(active: false, running: false, existing: true), .endWithFinalState)
        XCTAssertEqual(decide(active: false, running: false, existing: false), .none)
    }

    func testUnfollowedOrDisabledNeverShows() {
        for active in [true, false] {
            for running in [true, false] {
                XCTAssertEqual(decide(active: active, running: running, followed: false, existing: false), .none)
                XCTAssertEqual(decide(active: active, running: running, followed: false, existing: true), .endImmediately)
                XCTAssertEqual(decide(active: active, running: running, enabled: false, existing: false), .none)
                XCTAssertEqual(decide(active: active, running: running, enabled: false, existing: true), .endImmediately)
            }
        }
    }

    func testOnlyStartsOutsideTheForeground() {
        // Exhaustive: `.start` happens exactly when the app is away, the work is
        // running, the session is followed, the setting is on and nothing is shown.
        for active in [true, false] { for running in [true, false] { for followed in [true, false] {
            for enabled in [true, false] { for existing in [true, false] {
                let action = decide(active: active, running: running, followed: followed, enabled: enabled,
                                    existing: existing)
                XCTAssertEqual(action == .start, !active && running && followed && enabled && !existing)
                XCTAssertEqual(action == .keep, !active && running && followed && enabled && existing)
                if active { XCTAssertTrue(action == .none || action == .endImmediately) }
            } }
        } } }
    }

    // MARK: - Wiring (reads the source: the runtime needs ActivityKit + scenes)

    private func source(_ relative: String) throws -> String {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
        return try String(contentsOf: root.appendingPathComponent(relative), encoding: .utf8)
    }

    func testLifecycleHooksAreWired() throws {
        let manager = try source("Agent/Background/AgentLiveActivityManager.swift")
        XCTAssertTrue(manager.contains("UIScene.didActivateNotification"), "foreground return ends the card")
        XCTAssertTrue(manager.contains("UIScene.willDeactivateNotification"), "leaving starts the card")
        XCTAssertTrue(manager.contains("guard !isAppInForeground else {"), "startActivity holds while in the app")
        XCTAssertFalse(manager.contains("postDismissRecovery"), "foreground return must not restart a card")
        let bka = try source("Agent/Background/BackgroundKeepAliveManager.swift")
        XCTAssertTrue(bka.contains("AgentLiveActivityManager.shared.installPresenceObservers()"))
        let bridge = try source("Agent/Gateway/HarnessLiveActivityBridge.swift")
        XCTAssertTrue(bridge.contains("appActive: manager.isAppInForeground"), "console open in the app starts no card")
        let push = try source("Agent/Gateway/PushRegistrar.swift")
        XCTAssertTrue(push.contains("appActive: AgentLiveActivityManager.shared.isAppInForeground"),
                      "relay push-to-start while in the app is ended")
    }

    func testIPadOtherWindowKeepsTheAppForeground() {
        XCTAssertEqual(P.departure(otherActive: true, otherVisible: false), .stayForeground)
        XCTAssertEqual(P.departure(otherActive: true, otherVisible: true), .stayForeground)
        XCTAssertEqual(P.departure(otherActive: false, otherVisible: true), .recheckNextTurn)
        XCTAssertEqual(P.departure(otherActive: false, otherVisible: false), .leaveNow)
    }
}
