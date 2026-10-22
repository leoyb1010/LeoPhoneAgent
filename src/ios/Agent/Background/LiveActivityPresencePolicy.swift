//
//  LiveActivityPresencePolicy.swift
//  MinisApp
//
//  [la-foreground] When the agent Live Activity (Dynamic Island / Lock Screen,
//  the banner at the top of an iPad) may be on screen. Pure logic, shared by the
//  app and the logic-test target (Foundation only).
//
//  The card is for "a task is running and you are NOT looking at LeoBot". While
//  any LeoBot scene is foreground-active the user is in the conversation: the
//  card would only cover content (on iPad it sits over the top of the window),
//  and an approval is already on screen as the in-app card. So:
//  - foreground-active               → no card (end an existing one immediately);
//  - leaving the foreground, running → start it right then (ActivityKit only
//                                      allows a start while still foreground);
//  - background, running             → keep updating it;
//  - background, finished            → end it showing the final state;
//  - setting off / session unfollowed → no card.
//

import Foundation

enum LiveActivityPresencePolicy {
    enum Action: Equatable {
        /// Nothing on screen and nothing should be.
        case none
        /// Should be on screen and isn't: request one (only succeeds while the app
        /// is still foreground — i.e. in the resign-active transition — or from a
        /// background Live Activity intent).
        case start
        /// On screen and should stay: keep updating it.
        case keep
        /// Remove now (`dismissalPolicy: .immediate`): the user is in the app, the
        /// setting is off, or the session is not followed.
        case endImmediately
        /// The work finished while the app is away: end it with the final state
        /// and the system's default dismissal.
        case endWithFinalState
    }

    /// - Parameters:
    ///   - appActive: any LeoBot scene is foreground-active.
    ///   - taskRunning: a task (local run, followed Mac session, read-aloud) is in
    ///     flight — waiting for an approval or an answer counts as running.
    ///   - followed: the session is followed (local runs always are).
    ///   - enabled: Settings → Live Activity.
    ///   - existingActivity: a card for it is already on screen.
    static func decide(appActive: Bool, taskRunning: Bool, followed: Bool,
                       enabled: Bool, existingActivity: Bool) -> Action {
        if !enabled || !followed || appActive {
            return existingActivity ? .endImmediately : .none
        }
        if taskRunning {
            return existingActivity ? .keep : .start
        }
        return existingActivity ? .endWithFinalState : .none
    }

    enum Departure: Equatable {
        /// Another LeoBot window is still foreground-active: the app stays foreground.
        case stayForeground
        /// No LeoBot window is left in the foreground: the app is leaving now.
        case leaveNow
        /// Another LeoBot window is on screen but not active yet (iPad focus moving
        /// between two windows, or both windows going away together): look again
        /// on the next main-queue turn before deciding.
        case recheckNextTurn
    }

    /// A LeoBot scene is resigning active. `otherActive` / `otherVisible`: some
    /// OTHER LeoBot scene is foreground-active / foreground-inactive.
    static func departure(otherActive: Bool, otherVisible: Bool) -> Departure {
        if otherActive { return .stayForeground }
        return otherVisible ? .recheckNextTurn : .leaveNow
    }
}
