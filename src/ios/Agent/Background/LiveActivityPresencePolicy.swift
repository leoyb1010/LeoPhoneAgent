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

    // MARK: - [duo-fold] Display moves on a foldable (iPhone Duo)
    //
    // Folding or unfolding moves the LeoBot scene between the outer and inner
    // display. If the system resigns the scene during that move and activates it
    // again, starting the card in `willDeactivate` would flash it into the
    // Dynamic Island and end it a moment later. App left in the foreground on the
    // other display = still foreground: no card.
    //
    // Trade-off: ActivityKit only accepts a start while the app is foreground, so
    // the start cannot simply be delayed — locking the phone takes the app to the
    // background within a few hundred ms and a late request fails ("Target is not
    // foreground"). Hence the settle wait applies ONLY when the hinge moved just
    // before the deactivation (a fold is the likely cause). Lock / home / app
    // switch without hinge movement keep the synchronous start, exactly as before.
    // If a fold really does send the app to the background, the pending start is
    // tried at once on `didEnterBackground`; ActivityKit may refuse it there, in
    // which case a local task gets no card until the next departure (a Mac task
    // still gets the relay's push-to-start card). Every wait runs inside the
    // background-task assertion taken in `willDeactivate` (0.6 s ≪ its 5 s), so
    // the process is not suspended mid-wait.

    /// How long a fold-caused departure waits for the scene to come back.
    static let displayMoveSettleDelay: TimeInterval = 0.6
    /// Hinge movement this recent marks a deactivation as a likely display move.
    static let hingeMovementWindow: TimeInterval = 1.0

    enum DepartureStart: Equatable {
        /// Ordinary departure (lock, home, app switcher): start the card now,
        /// synchronously, while ActivityKit still sees the app as foreground.
        case startNow
        /// The hinge just moved: wait this long; a reactivation cancels the start.
        case settle(after: TimeInterval)
    }

    /// - Parameters:
    ///   - lastHingeMovement: when the hinge angle/status last changed (nil: never,
    ///     or no hinge — every non-foldable device).
    ///   - now: the deactivation time.
    static func departureStart(lastHingeMovement: Date?, now: Date) -> DepartureStart {
        guard let moved = lastHingeMovement else { return .startNow }
        let age = now.timeIntervalSince(moved)
        guard age >= 0, age <= hingeMovementWindow else { return .startNow }
        return .settle(after: displayMoveSettleDelay)
    }

    enum SettledDeparture: Equatable {
        /// A LeoBot scene became active again (the fold finished on the other
        /// display): the app never left — no card.
        case cancel
        /// Still away: start the card now.
        case start
    }

    /// A pending (settling) departure resolves on its timer, or early when the app
    /// enters the background, whichever comes first. `reactivated`: some LeoBot
    /// scene became foreground-active since the departure.
    static func settle(reactivated: Bool) -> SettledDeparture {
        reactivated ? .cancel : .start
    }
}
