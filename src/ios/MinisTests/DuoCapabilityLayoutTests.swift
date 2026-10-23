import XCTest

/// [duo-cap] iPhone Duo: capability (not idiom) decisions, per-edge safe-area math,
/// the scene-based image cap, biometry wording and the camera choices.
final class DuoCapabilityLayoutTests: XCTestCase {
    private var iosRoot: URL { URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent() }

    // MARK: Mac screen input

    func testPadKeepsPointerAndHardwareKeysWhateverIsConnected() {
        for pointer in [false, true] {
            for keyboard in [false, true] {
                for regular in [false, true] {
                    let d = MacScreenInputPolicy.decide(isPadIdiom: true, hasPointer: pointer,
                                                        hasHardwareKeyboard: keyboard, isRegularWidth: regular)
                    XCTAssertEqual(d, .init(pointer: .pointer, keys: .hardware))
                    XCTAssertTrue(d.attachesHardwareKeyboard)
                }
            }
        }
    }

    func testPlainIPhoneKeepsTrackpadAndControlBar() {
        let d = MacScreenInputPolicy.decide(isPadIdiom: false, hasPointer: false,
                                            hasHardwareKeyboard: false, isRegularWidth: false)
        XCTAssertEqual(d, .init(pointer: .trackpad, keys: .controlBar))
        XCTAssertFalse(d.attachesHardwareKeyboard)
        // Duo inner display without accessories: regular width alone changes nothing.
        XCTAssertEqual(MacScreenInputPolicy.decide(isPadIdiom: false, hasPointer: false,
                                                   hasHardwareKeyboard: false, isRegularWidth: true),
                       .init(pointer: .trackpad, keys: .controlBar))
    }

    func testIPhoneWithKeyboardSendsKeysInAnyWidth() {
        for regular in [false, true] {
            let d = MacScreenInputPolicy.decide(isPadIdiom: false, hasPointer: false,
                                                hasHardwareKeyboard: true, isRegularWidth: regular)
            XCTAssertEqual(d.keys, .hardware)
            XCTAssertTrue(d.attachesHardwareKeyboard)
            XCTAssertEqual(d.pointer, .trackpad)
        }
    }

    func testPointerModeNeedsPointerAndRegularWidth() {
        XCTAssertEqual(MacScreenInputPolicy.decide(isPadIdiom: false, hasPointer: true,
                                                   hasHardwareKeyboard: true, isRegularWidth: true).pointer, .pointer)
        XCTAssertEqual(MacScreenInputPolicy.decide(isPadIdiom: false, hasPointer: true,
                                                   hasHardwareKeyboard: true, isRegularWidth: false).pointer, .trackpad)
    }

    func testShareSheetPopoverFollowsSizeClass() {
        XCTAssertTrue(LeoSharePresentation.usesPopover(isRegularWidth: true))
        XCTAssertFalse(LeoSharePresentation.usesPopover(isRegularWidth: false))
    }

    // MARK: Safe areas

    func testInlineOverlayInsetsAreUnchanged() {
        let i = MacScreenOverlayInsets.inline
        XCTAssertEqual(i.badgeTop, 52); XCTAssertEqual(i.badgeTrailing, 12)
        XCTAssertEqual(i.controlsLeading, 0); XCTAssertEqual(i.controlsTrailing, 0); XCTAssertEqual(i.controlsBottom, 8)
    }

    func testFullscreenOverlayMatchesOldValuesWithoutInsets() {
        XCTAssertEqual(MacScreenOverlayInsets.fullscreen(top: 0, leading: 0, bottom: 0, trailing: 0), .inline)
    }

    func testFullscreenOverlayUsesEachEdgeOnItsOwn() {
        // iPhone Duo outer display in landscape: island on the right, nothing on the left.
        let i = MacScreenOverlayInsets.fullscreen(top: 0, leading: 0, bottom: 21, trailing: 62)
        XCTAssertEqual(i.badgeTop, 52)
        XCTAssertEqual(i.badgeTrailing, 74)
        XCTAssertEqual(i.controlsLeading, 0)
        XCTAssertEqual(i.controlsTrailing, 62)
        XCTAssertEqual(i.controlsBottom, 29)
        // Mirror image: island on the left.
        let m = MacScreenOverlayInsets.fullscreen(top: 0, leading: 62, bottom: 21, trailing: 0)
        XCTAssertEqual(m.controlsLeading, 62)
        XCTAssertEqual(m.badgeTrailing, 12)
        // Portrait iPhone: the badges clear the caption pill under the island.
        XCTAssertEqual(MacScreenOverlayInsets.fullscreen(top: 59, leading: 0, bottom: 34, trailing: 0).badgeTop, 111)
    }

    func testFloatingClampUsesLeftAndRightInsetsIndependently() {
        // 678-pt-wide window, 62-pt island on the left, a 44-pt control resting at x = 600.
        let r = FloatingControlBounds.horizontalOffsetRange(windowWidth: 678, safeLeft: 62, safeRight: 0,
                                                            margin: 16, restLeft: 600, width: 44)
        XCTAssertEqual(r.lowerBound, 62 + 16 - 600)   // frame's left edge stops at 78
        XCTAssertEqual(r.upperBound, 678 - 16 - 44 - 600)   // right edge stops at 662
        let mirrored = FloatingControlBounds.horizontalOffsetRange(windowWidth: 678, safeLeft: 0, safeRight: 62,
                                                                   margin: 16, restLeft: 556, width: 44)
        XCTAssertEqual(mirrored.lowerBound, 16 - 556)
        XCTAssertEqual(mirrored.upperBound, 678 - 62 - 16 - 44 - 556)
        XCTAssertNotEqual(r.lowerBound + 600, mirrored.lowerBound + 556, "not symmetric")
    }

    func testFloatingClampNeverInvertsInATinyWindow() {
        let r = FloatingControlBounds.horizontalOffsetRange(windowWidth: 60, safeLeft: 30, safeRight: 30,
                                                            margin: 16, restLeft: 0, width: 44)
        XCTAssertLessThanOrEqual(r.lowerBound, r.upperBound)
    }

    func testRestingCornerAndTopLimitUseRealInsets() {
        XCTAssertEqual(FloatingControlBounds.restingMaxX(windowMaxX: 678, safeRight: 62, trailingPadding: 16), 600)
        XCTAssertEqual(FloatingControlBounds.restingMaxX(windowMaxX: 678, safeRight: 0, trailingPadding: 16), 662)
        XCTAssertEqual(FloatingControlBounds.topLimit(safeTop: 0), 52)
        XCTAssertEqual(FloatingControlBounds.topLimit(safeTop: 59), 111)
    }

    // MARK: Image cap

    func testLayoutHeightFollowsTallestSceneAndFallsBack() {
        XCTAssertEqual(LayoutHeightPolicy.height(sceneHeights: [678], fallback: 844), 678)
        XCTAssertEqual(LayoutHeightPolicy.height(sceneHeights: [669, 400], fallback: 844), 669)
        XCTAssertEqual(LayoutHeightPolicy.height(sceneHeights: [], fallback: 844), 844)
        XCTAssertEqual(LayoutHeightPolicy.height(sceneHeights: [0], fallback: 844), 844)
    }

    func testRecapOnlyOnRealChange() {
        XCTAssertFalse(LayoutHeightPolicy.shouldRecap(old: nil, new: 669))
        XCTAssertFalse(LayoutHeightPolicy.shouldRecap(old: 669, new: 669.4))
        XCTAssertTrue(LayoutHeightPolicy.shouldRecap(old: 678, new: 951))
    }

    // MARK: Biometry wording

    func testLockedTextNamesTheRealSensor() {
        let reply = BiometryLockText.lockedOpenToReply("Touch ID")
        let view = BiometryLockText.lockedOpenToView("Touch ID")
        for text in [reply, view] {
            XCTAssertTrue(text.contains("Touch ID"), text)
            XCTAssertFalse(text.contains("Face ID"), text)
        }
        XCTAssertTrue(BiometryLockText.lockedOpenToView("Face ID").contains("Face ID"))
    }

    func testLockedTextIsInTheCatalogInThreeLanguages() throws {
        let data = try Data(contentsOf: iosRoot.appendingPathComponent("Localizable.xcstrings"))
        let root = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let strings = try XCTUnwrap(root["strings"] as? [String: Any])
        for key in ["这个会话已用 %@ 锁定，请在 App 里打开后回复。", "这个会话已用 %@ 锁定，请在 App 里打开查看。"] {
            let entry = try XCTUnwrap(strings[key] as? [String: Any], key)
            let locs = try XCTUnwrap(entry["localizations"] as? [String: Any], key)
            for lang in ["en", "zh-Hans", "zh-Hant"] {
                let unit = try XCTUnwrap((locs[lang] as? [String: Any])?["stringUnit"] as? [String: Any], "\(key) \(lang)")
                let value = try XCTUnwrap(unit["value"] as? String)
                XCTAssertTrue(value.contains("%@"), "\(key) \(lang)")
                XCTAssertFalse(value.contains("Face ID"), "\(key) \(lang)")
            }
        }
    }

    func testIntentsNoLongerHardCodeFaceID() throws {
        for file in ["Agent/Intents/SessionEntity.swift", "Agent/Intents/SendPromptIntent.swift"] {
            let source = try String(contentsOf: iosRoot.appendingPathComponent(file), encoding: .utf8)
            XCTAssertFalse(source.contains("已用 Face ID 锁定"), file)
        }
    }

    // MARK: Camera

    func testCameraArguments() {
        XCTAssertEqual(CameraFacingRequest(argument: "back"), .back)
        XCTAssertEqual(CameraFacingRequest(argument: "rear"), .back)
        XCTAssertEqual(CameraFacingRequest(argument: "front"), .userFacing)
        XCTAssertEqual(CameraFacingRequest(argument: "user_facing"), .userFacing)
        XCTAssertEqual(CameraFacingRequest(argument: "Outer"), .outer)
        XCTAssertEqual(CameraFacingRequest(argument: "inner"), .inner)
        XCTAssertNil(CameraFacingRequest(argument: "side"))
        XCTAssertNil(CameraFacingRequest(argument: ""))
        XCTAssertFalse(CameraFacingRequest.userFacing.needsSpecificFrontCamera)
        XCTAssertFalse(CameraFacingRequest.back.needsSpecificFrontCamera)
        XCTAssertTrue(CameraFacingRequest.outer.needsSpecificFrontCamera)
        XCTAssertTrue(CameraFacingRequest.inner.needsSpecificFrontCamera)
    }

    func testCameraToolDescriptionsListTheNewChoices() throws {
        let help = try String(contentsOf: iosRoot.appendingPathComponent("NativeOffloads/CameraOffload.m"), encoding: .utf8)
        let prompt = try String(contentsOf: iosRoot.appendingPathComponent("Agent/Chat/AIChatViewModel.swift"), encoding: .utf8)
        for option in ["user_facing", "outer", "inner"] {
            XCTAssertTrue(help.contains(option), option)
            XCTAssertTrue(prompt.contains(option), option)
            XCTAssertTrue(CameraFacingRequest.accepted.contains(option), option)
        }
        XCTAssertFalse(help.contains("--camera front|back "), "old two-choice help")
    }
}
