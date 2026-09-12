import XCTest
@testable import WindowCore

@MainActor
final class FixtureSystem: WindowSystem {
    var nowMilliseconds: Double = 2_000
    var granted = WindowPermissions(accessibility: true, screenCapture: true, postEvents: true)
    var before = fixtureWindow()
    var after = fixtureWindow()
    var performed = 0
    var observeCount = 0
    var revokeAfterObserve = false
    var advanceAfterObserve: Double?
    func permissions() -> WindowPermissions { granted }
    func listWindows() throws -> [WindowObservation] { [before] }
    func observe(_ ref: WindowIdentity, capture: Bool, elements: Bool) async throws -> WindowObservation {
        observeCount += 1
        if revokeAfterObserve { granted.accessibility = false }
        if let advanceAfterObserve { nowMilliseconds = advanceAfterObserve }
        return performed == 0 ? before : after
    }
    func perform(_ action: WindowAction, on window: WindowObservation, deadline: Double) async throws { performed += 1 }
    func settle() async {}
}

func fixtureWindow() -> WindowObservation {
    WindowObservation(app: "Fixture", pid: 42, windowId: "7", title: "Fixture window", bundleId: "test.fixture", processStartedAt: 100,
        frontmost: true, bounds: "0,0,800,600", onScreen: true, occluded: false, scale: 2,
        permissions: WindowPermissions(accessibility: true, screenCapture: true, postEvents: true), elements: [], stateHash: "before")
}
func request(_ action: WindowAction, kind: String = "ax") -> WindowRequest {
    let expected = fixtureWindow()
    return WindowRequest(operation: "act", ref: expected.identity, expected: expected, expiresAt: 4_000, kind: kind, action: action)
}

@MainActor
final class WindowEngineTests: XCTestCase {
    func testMissingActionCannotReportSuccess() async {
        let system = FixtureSystem()
        let engine = WindowEngine(system: system)
        var input = request(WindowAction(name: "focus"))
        input.action = nil
        let result = await engine.handle(input)
        XCTAssertFalse(result.ok)
        XCTAssertEqual(result.reason, "unsupported-action")
        XCTAssertEqual(system.performed, 0)
    }

    func testRevokedPermissionNeverReachesExecution() async {
        let system = FixtureSystem()
        system.granted.accessibility = false
        let result = await WindowEngine(system: system).handle(request(WindowAction(name: "minimize")))
        XCTAssertEqual(result.reason, "permission-denied")
        XCTAssertEqual(system.performed, 0)
    }

    func testRecreatedWindowOrReusedProcessIsRejected() async {
        for change in ["window", "process", "bounds"] {
            let system = FixtureSystem()
            if change == "window" { system.before.windowId = "8" }
            if change == "process" { system.before.processStartedAt = 101 }
            if change == "bounds" { system.before.bounds = "10,0,800,600" }
            let result = await WindowEngine(system: system).handle(request(WindowAction(name: "minimize")))
            XCTAssertFalse(result.ok)
            XCTAssertEqual(result.reason, "window-changed")
            XCTAssertEqual(system.performed, 0)
        }
    }

    func testObscuredTargetCannotReceiveAnElementAction() async {
        let system = FixtureSystem()
        system.before.occluded = true
        let result = await WindowEngine(system: system).handle(request(WindowAction(name: "press", elementId: "button")))
        XCTAssertEqual(result.reason, "window-occluded")
        XCTAssertEqual(system.performed, 0)
    }

    func testMinimizeRequiresActualReadback() async {
        let system = FixtureSystem()
        let failed = await WindowEngine(system: system).handle(request(WindowAction(name: "minimize")))
        XCTAssertFalse(failed.ok)
        XCTAssertEqual(failed.reason, "verification-failed")
        XCTAssertEqual(failed.receipt?.attempted, true)
        system.performed = 0
        system.after.minimized = true
        system.after.frontmost = false
        let success = await WindowEngine(system: system).handle(request(WindowAction(name: "minimize")))
        XCTAssertTrue(success.ok)
        XCTAssertEqual(success.receipt?.verification, "minimized-readback")
        XCTAssertEqual(success.observation?.minimized, true)
    }

    func testExpiredSnapshotAndUnboundedCoordinatesAreRejected() async {
        let system = FixtureSystem()
        var stale = request(WindowAction(name: "focus"))
        stale.expiresAt = 1_000
        let staleResult = await WindowEngine(system: system).handle(stale)
        XCTAssertEqual(staleResult.reason, "snapshot-expired")
        let outside = request(WindowAction(name: "click", x: 800, y: 600, coordinateSpace: "normalized-window"), kind: "coord")
        let outsideResult = await WindowEngine(system: system).handle(outside)
        XCTAssertEqual(outsideResult.reason, "unsupported-action")
        XCTAssertEqual(system.performed, 0)
    }

    func testObserveReturnsTheActualLiveWindowInsteadOfRefreshingTheRequest() async {
        let system = FixtureSystem()
        system.before.title = "Changed title"
        let result = await WindowEngine(system: system).handle(WindowRequest(operation: "observe", ref: fixtureWindow().identity))
        XCTAssertTrue(result.ok)
        XCTAssertEqual(result.observation?.title, "Changed title")
        XCTAssertEqual(system.observeCount, 1)
    }
    func testPermissionRevokedAndDeadlineExpiringDuringObservationBothStopInput() async {
        let revoked = FixtureSystem(); revoked.revokeAfterObserve = true
        let revokedResult = await WindowEngine(system: revoked).handle(request(WindowAction(name: "minimize")))
        XCTAssertEqual(revokedResult.reason, "permission-denied"); XCTAssertEqual(revoked.performed, 0)
        let expired = FixtureSystem(); expired.advanceAfterObserve = 5_000
        let expiredResult = await WindowEngine(system: expired).handle(request(WindowAction(name: "minimize")))
        XCTAssertEqual(expiredResult.reason, "snapshot-expired"); XCTAssertEqual(expired.performed, 0)
    }

    func testPressRequiresAStableEnabledElementAndVisibleReadbackChange() async {
        let system = FixtureSystem()
        let button = WindowElement(id: "button", path: [0], role: "AXButton", title: "Fixture action", bounds: "10,10,60,20", enabled: true, settableValue: false, actions: ["AXPress"], redacted: false)
        system.before.elements = [button]; system.after = system.before
        var input = request(WindowAction(name: "press", elementId: "button")); input.expected = system.before
        let unchanged = await WindowEngine(system: system).handle(input)
        XCTAssertFalse(unchanged.ok); XCTAssertEqual(unchanged.receipt?.attempted, true)
        system.performed = 0; system.after.stateHash = "changed"
        let changed = await WindowEngine(system: system).handle(input)
        XCTAssertTrue(changed.ok); XCTAssertEqual(changed.receipt?.verification, "observed-ui-change")
        system.performed = 0; system.before.elements?[0].id = "replaced"
        let replaced = await WindowEngine(system: system).handle(input)
        XCTAssertEqual(replaced.reason, "element-changed"); XCTAssertEqual(system.performed, 0)
    }

    func testSetValueIsLimitedToWritableNonSecureTextWithExactValueReadback() async {
        let system = FixtureSystem()
        let field = WindowElement(id: "field", path: [0], role: "AXTextField", identifier: "fixture-text", value: "Old", bounds: "10,10,120,20", enabled: true, settableValue: true, actions: [], redacted: false)
        system.before.elements = [field]; system.after = system.before
        var input = request(WindowAction(name: "setValue", elementId: "field", value: "New")); input.expected = system.before
        system.after.elements?[0].value = "New"
        let changed = await WindowEngine(system: system).handle(input)
        XCTAssertTrue(changed.ok); XCTAssertEqual(changed.receipt?.verification, "value-readback")
        system.performed = 0; system.before.elements?[0].redacted = true; input.expected = system.before
        let secure = await WindowEngine(system: system).handle(input)
        XCTAssertEqual(secure.reason, "element-unavailable"); XCTAssertEqual(system.performed, 0)
    }

    func testCoordinateInputRequiresFreshImageAndVerifiesActualPixelChange() async {
        let system = FixtureSystem()
        let image = WindowImage(data: "", width: 800, height: 600, scaleX: 1, scaleY: 1, hash: "fixture-image-before")
        system.before.image = image; system.after = system.before
        var input = request(WindowAction(name: "click", x: 0.5, y: 0.5, coordinateSpace: "normalized-window"), kind: "coord")
        input.expected = system.before
        system.before.image?.hash = "scene-changed"
        let staleScene = await WindowEngine(system: system).handle(input)
        XCTAssertEqual(staleScene.reason, "scene-changed"); XCTAssertEqual(system.performed, 0)
        system.before.image = image; system.after.image?.hash = "fixture-image-after"
        let clicked = await WindowEngine(system: system).handle(input)
        XCTAssertTrue(clicked.ok); XCTAssertEqual(clicked.receipt?.verification, "observed-image-change")
    }

    func testMenuPathIsAllowlistedAndDoesNotEquateAXAcceptanceWithCompletion() async {
        let system = FixtureSystem()
        var input = request(WindowAction(name: "select", path: ["File", "Fixture Action"]), kind: "menu")
        let unverified = await WindowEngine(system: system).handle(input)
        XCTAssertFalse(unverified.ok); XCTAssertEqual(unverified.reason, "verification-failed")
        system.performed = 0; system.after.stateHash = "menu-action-result"
        let selected = await WindowEngine(system: system).handle(input)
        XCTAssertTrue(selected.ok)
        input.action?.path = ["File"]
        system.performed = 0
        let invalid = await WindowEngine(system: system).handle(input)
        XCTAssertEqual(invalid.reason, "unsupported-action"); XCTAssertEqual(system.performed, 0)
    }

    func testCoordinateOutcomeIsUnknownIfForegroundChangesAfterInput() async {
        let system = FixtureSystem()
        let image = WindowImage(data: "", width: 800, height: 600, scaleX: 1, scaleY: 1, hash: "before-image")
        system.before.image = image; system.after = system.before
        var input = request(WindowAction(name: "click", x: 0.5, y: 0.5, coordinateSpace: "normalized-window"), kind: "coord")
        input.expected = system.before
        system.after.frontmost = false; system.after.stateHash = "focus-changed"; system.after.image?.hash = "changed-image"
        let result = await WindowEngine(system: system).handle(input)
        XCTAssertFalse(result.ok)
        XCTAssertEqual(result.reason, "window-changed")
        XCTAssertEqual(result.receipt?.attempted, true)
        XCTAssertEqual(result.receipt?.verified, false)
    }

}
