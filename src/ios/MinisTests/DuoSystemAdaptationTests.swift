import CoreGraphics
import XCTest

/// [duo-fold] Live Activity departures that may be an iPhone Duo fold / unfold.
final class DuoLiveActivityDebounceTests: XCTestCase {
    private typealias P = LiveActivityPresencePolicy
    private let now = Date(timeIntervalSinceReferenceDate: 1_000_000)

    func testNoHingeStartsSynchronouslyAsBefore() {
        // Every non-foldable device, and a Duo that hasn't moved its hinge:
        // lock / home / app switch keep the synchronous start in willDeactivate.
        XCTAssertEqual(P.departureStart(lastHingeMovement: nil, now: now), .startNow)
    }

    func testHingeMovementJustBeforeDeactivationSettles() {
        XCTAssertEqual(P.departureStart(lastHingeMovement: now.addingTimeInterval(-0.2), now: now),
                       .settle(after: P.displayMoveSettleDelay))
        XCTAssertEqual(P.departureStart(lastHingeMovement: now, now: now),
                       .settle(after: P.displayMoveSettleDelay))
        XCTAssertEqual(P.departureStart(lastHingeMovement: now.addingTimeInterval(-P.hingeMovementWindow), now: now),
                       .settle(after: P.displayMoveSettleDelay), "window edge is inclusive")
    }

    func testOldHingeMovementDoesNotDelayTheLockPath() {
        // Unfolded a while ago, then locked: must start now, or ActivityKit rejects
        // the late request once the app is in the background.
        XCTAssertEqual(P.departureStart(lastHingeMovement: now.addingTimeInterval(-1.5), now: now), .startNow)
        XCTAssertEqual(P.departureStart(lastHingeMovement: now.addingTimeInterval(-60), now: now), .startNow)
    }

    func testClockSkewNeverDelays() {
        XCTAssertEqual(P.departureStart(lastHingeMovement: now.addingTimeInterval(5), now: now), .startNow)
    }

    func testSettleDelayFitsInsideTheBackgroundAssertion() {
        // The wait runs under the 5 s "LiveActivityStart" background task.
        XCTAssertGreaterThan(P.displayMoveSettleDelay, 0)
        XCTAssertLessThan(P.displayMoveSettleDelay, 1.0)
    }

    func testReactivationCancelsOtherwiseStarts() {
        XCTAssertEqual(P.settle(reactivated: true), .cancel, "scene back on the other display: no card")
        XCTAssertEqual(P.settle(reactivated: false), .start, "still away after the wait (or backgrounded): start")
    }
}

/// [duo-diag] Which display a scene is on, from the screen bounds.
final class DuoDisplayContextTests: XCTestCase {
    private typealias D = DisplayContext

    func testOuterDisplayEitherOrientation() {
        XCTAssertEqual(D.display(screenSize: CGSize(width: 466, height: 678)), .outer)
        XCTAssertEqual(D.display(screenSize: CGSize(width: 678, height: 466)), .outer)
        XCTAssertEqual(D.display(screenSize: CGSize(width: 470, height: 672)), .outer, "within tolerance")
    }

    func testInnerDisplayEitherOrientation() {
        XCTAssertEqual(D.display(screenSize: CGSize(width: 951, height: 669)), .inner)
        XCTAssertEqual(D.display(screenSize: CGSize(width: 669, height: 951)), .inner)
    }

    func testOtherDevicesAreSingle() {
        XCTAssertEqual(D.display(screenSize: CGSize(width: 440, height: 956)), .single, "iPhone Pro Max class")
        XCTAssertEqual(D.display(screenSize: CGSize(width: 375, height: 667)), .single, "iPhone SE")
        XCTAssertEqual(D.display(screenSize: CGSize(width: 1032, height: 1376)), .single, "iPad Pro 13")
        XCTAssertEqual(D.display(screenSize: .zero), .single)
    }

    func testSummaryCarriesDisplayScreenAndWindow() {
        // Inner display, LeoBot in half of a split view.
        XCTAssertEqual(D.summary(screenSize: CGSize(width: 951, height: 669), windowSize: CGSize(width: 475.4, height: 669)),
                       "display=inner screen=951x669 window=475x669")
        XCTAssertEqual(D.summary(screenSize: CGSize(width: 466, height: 678), windowSize: CGSize(width: 466, height: 678)),
                       "display=outer screen=466x678 window=466x678")
    }

    func testCurrentIsReadableAfterSet() {
        let saved = D.current
        defer { D.setCurrent(saved) }
        D.setCurrent("display=outer screen=466x678 window=466x678")
        XCTAssertEqual(D.current, "display=outer screen=466x678 window=466x678")
    }
}

/// [duo-diag] Crash reports and device info name the Duo.
final class DuoModelNameTests: XCTestCase {
    func testDuoIdentifierMapsToName() {
        XCTAssertEqual(DeviceIdentity.knownModelName(for: "iPhone19,4"), "iPhone Duo")
        XCTAssertEqual(DeviceIdentity.describe(identifier: "iPhone19,4"), "iPhone19,4 (iPhone Duo)")
    }

    func testUnknownIdentifierStaysRaw() {
        XCTAssertNil(DeviceIdentity.knownModelName(for: "iPhone99,9"))
        XCTAssertEqual(DeviceIdentity.describe(identifier: "iPhone99,9"), "iPhone99,9")
        XCTAssertEqual(DeviceIdentity.describe(identifier: "iPhone18,2"), "iPhone18,2 (iPhone 17 Pro Max)")
    }

    func testSimulatorReportsTheSimulatedModel() {
        XCTAssertEqual(DeviceIdentity.machineIdentifier(uname: "arm64",
                                                        environment: ["SIMULATOR_MODEL_IDENTIFIER": "iPhone19,4"]),
                       "iPhone19,4")
        XCTAssertEqual(DeviceIdentity.machineIdentifier(uname: "iPhone19,4", environment: [:]), "iPhone19,4")
    }
}
