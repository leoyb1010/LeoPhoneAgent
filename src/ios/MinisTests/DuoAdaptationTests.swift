import CoreGraphics
import XCTest

/// [duo] iPhone Duo (foldable) adaptations of the chat page: the keyboard
/// short-height rule, fold (division) avoidance math, fold / unfold state
/// continuity, two-window event routing, plus source guards for the wiring.
final class DuoAdaptationTests: XCTestCase {
    private var iosRoot: URL {
        URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
    }
    private func source(_ path: String) throws -> String {
        try String(contentsOf: iosRoot.appendingPathComponent(path), encoding: .utf8)
    }

    // MARK: P0-9 keyboard: short height from the height actually left

    func testInnerDisplayWithKeyboardIsShortAlthoughSizeClassIsRegular() {
        // 669 pt inner display, landscape (951 wide): ~24 status + ~50 bar + ~300 keyboard.
        XCTAssertTrue(ChatShortHeightRule.heightIsShort(visibleHeight: 295, wasShort: false,
                                                        verticalSizeClassRegular: true, windowWidth: 951))
        XCTAssertTrue(ChatShortHeightRule.isShort(verticalSizeClassCompact: false, heightIsShort: true))
        // Inner portrait (669 wide) with a tall keyboard.
        XCTAssertTrue(ChatShortHeightRule.heightIsShort(visibleHeight: 300, wasShort: false,
                                                        verticalSizeClassRegular: true, windowWidth: 669))
        // Keyboard down on the inner display: full composer.
        XCTAssertFalse(ChatShortHeightRule.heightIsShort(visibleHeight: 595, wasShort: false,
                                                         verticalSizeClassRegular: true, windowWidth: 951))
    }

    func testOrdinaryPhonesKeepTheFullComposer() {
        // 6.1" portrait with keyboard (~422) and without (~760).
        XCTAssertFalse(ChatShortHeightRule.heightIsShort(visibleHeight: 422, wasShort: false))
        XCTAssertFalse(ChatShortHeightRule.heightIsShort(visibleHeight: 760, wasShort: false))
        XCTAssertFalse(ChatShortHeightRule.isShort(verticalSizeClassCompact: false, heightIsShort: false))
        // Landscape phone: the size class alone still decides.
        XCTAssertTrue(ChatShortHeightRule.isShort(verticalSizeClassCompact: true, heightIsShort: false))
    }

    func testSmallPhonesWithTallThirdPartyKeyboardsAreNotCompacted() {
        // iPhone SE / mini portrait with a tall third-party keyboard: ~300 visible,
        // regular height, but the window is far below 600 wide.
        for width: CGFloat in [375, 393, 440] {
            XCTAssertFalse(ChatShortHeightRule.heightIsShort(visibleHeight: 300, wasShort: false,
                                                             verticalSizeClassRegular: true, windowWidth: width), "\(width)")
        }
        // Duo outer display portrait (466): the height half does not apply either.
        XCTAssertFalse(ChatShortHeightRule.heightIsShort(visibleHeight: 254, wasShort: false,
                                                         verticalSizeClassRegular: true, windowWidth: 466))
        // Compact height is the size-class half's job, not this one.
        XCTAssertFalse(ChatShortHeightRule.heightIsShort(visibleHeight: 200, wasShort: true,
                                                         verticalSizeClassRegular: false, windowWidth: 951))
        // Window not known yet: not short.
        XCTAssertFalse(ChatShortHeightRule.heightIsShort(visibleHeight: 200, wasShort: true,
                                                         verticalSizeClassRegular: true, windowWidth: 0))
        // 320–360 used to enter; now it does not, even on a wide window.
        XCTAssertFalse(ChatShortHeightRule.heightIsShort(visibleHeight: 340, wasShort: false,
                                                         verticalSizeClassRegular: true, windowWidth: 951))
        XCTAssertEqual(ChatShortHeightRule.enterBelow, 320)
        XCTAssertEqual(ChatShortHeightRule.exitAbove, 400)
        XCTAssertEqual(ChatShortHeightRule.minWindowWidth, 600)
    }

    func testHysteresisAbsorbsTheNavBarMinimizeStep() {
        // Short at 350; the bar minimizing adds ~24 pt → 374: stays short.
        XCTAssertTrue(ChatShortHeightRule.heightIsShort(visibleHeight: 374, wasShort: true))
        // Not short at 370; the bar coming back takes ~24 pt → 380 → still not short at 362.
        XCTAssertFalse(ChatShortHeightRule.heightIsShort(visibleHeight: 362, wasShort: false))
        // Keyboard down: clearly above the exit threshold.
        XCTAssertFalse(ChatShortHeightRule.heightIsShort(visibleHeight: 520, wasShort: true))
        XCTAssertGreaterThan(ChatShortHeightRule.exitAbove - ChatShortHeightRule.enterBelow, 24)
    }

    func testUnmeasuredHeightKeepsThePreviousAnswer() {
        XCTAssertTrue(ChatShortHeightRule.heightIsShort(visibleHeight: 0, wasShort: true))
        XCTAssertFalse(ChatShortHeightRule.heightIsShort(visibleHeight: -12, wasShort: false))
    }

    // MARK: P1-2 fold (division) avoidance

    func testVerticalFoldMovesAFullWidthComposerOntoOneHalf() {
        // Inner display landscape, book posture: fold at x ≈ 475.
        let size = CGSize(width: 951, height: 120)
        let fold = CGRect(x: 471, y: -400, width: 8, height: 1000)
        let insets = FoldAvoidance.insets(size: size, divisions: [fold])
        // Equal rooms → trailing half (leading padding up to the fold's far edge).
        XCTAssertEqual(insets, FoldInsets(top: 0, leading: 479, bottom: 0, trailing: 0))
        XCTAssertGreaterThanOrEqual(size.width - insets.leading, FoldAvoidance.minimumSide)
    }

    func testVerticalFoldPicksTheRoomierSide() {
        let size = CGSize(width: 600, height: 44)
        let nearTrailing = CGRect(x: 420, y: 0, width: 10, height: 44)
        XCTAssertEqual(FoldAvoidance.insets(size: size, divisions: [nearTrailing]),
                       FoldInsets(top: 0, leading: 0, bottom: 0, trailing: 180))
        let nearLeading = CGRect(x: 150, y: 0, width: 10, height: 44)
        XCTAssertEqual(FoldAvoidance.insets(size: size, divisions: [nearLeading]),
                       FoldInsets(top: 0, leading: 160, bottom: 0, trailing: 0))
    }

    func testNoMoveWhenTheFoldMissesOrTheSideIsTooNarrow() {
        let size = CGSize(width: 400, height: 60)
        XCTAssertEqual(FoldAvoidance.insets(size: size, divisions: []), .zero)
        XCTAssertEqual(FoldAvoidance.insets(size: size, divisions: [CGRect(x: 0, y: 200, width: 400, height: 8)]), .zero,
                       "a fold above the control leaves it alone")
        // Fold through a 300 pt control: both sides < 160 → stays put.
        XCTAssertEqual(FoldAvoidance.insets(size: CGSize(width: 300, height: 44),
                                            divisions: [CGRect(x: 145, y: 0, width: 10, height: 44)]), .zero)
    }

    func testHorizontalFoldLiftsABottomAnchoredControlAboveIt() {
        // Laptop posture (inner portrait): fold crosses the composer 30 pt above its bottom.
        let insets = FoldAvoidance.insets(size: CGSize(width: 669, height: 120),
                                          divisions: [CGRect(x: 0, y: 90, width: 669, height: 8)])
        XCTAssertEqual(insets, FoldInsets(top: 0, leading: 0, bottom: 30, trailing: 0))
    }

    func testFoldPaddingIsAFixedPointNotAFeedbackLoop() {
        // Overlay space: control 669×120 anchored at y 380…500, fold at y 470…478.
        let natural = CGSize(width: 669, height: 120)
        let foldInOverlay = CGRect(x: 0, y: 470, width: 669, height: 8)
        func wrapperSpace(_ applied: FoldInsets) -> (CGSize, [CGRect]) {
            // The padded wrapper keeps its bottom edge at y 500 and grows upward.
            let h = natural.height + applied.top + applied.bottom
            let wrapperTop = 500 - h
            return (CGSize(width: natural.width, height: h), [foldInOverlay.offsetBy(dx: 0, dy: -wrapperTop)])
        }
        var applied = FoldInsets.zero
        for _ in 0..<4 {
            let (measured, divisions) = wrapperSpace(applied)
            applied = FoldAvoidance.nextInsets(measured: measured, divisions: divisions, applied: applied)
        }
        XCTAssertEqual(applied, FoldInsets(top: 0, leading: 0, bottom: 30, trailing: 0),
                       "the padding converges and stays: control bottom sits on the fold's top edge")

        // Book posture: horizontal padding doesn't change a flexible wrapper's width.
        let bookFold = [CGRect(x: 471, y: -10, width: 8, height: 200)]
        var side = FoldInsets.zero
        for _ in 0..<3 {
            side = FoldAvoidance.nextInsets(measured: CGSize(width: 951, height: 120), divisions: bookFold, applied: side)
        }
        XCTAssertEqual(side.leading, 479)
    }

    // MARK: P0-7 fold / unfold continuity

    func testScrollAnchorRestoresTheItemAndClamps() {
        // Item top sat 40 pt below the visible top; inset 100 pt.
        XCTAssertEqual(ChatScrollAnchorMath.restoredOffset(itemMinY: 2000, offsetFromTop: 40,
                                                           adjustedTop: 100, maxOffset: 5000), 1860)
        // Near the top: never above the inset.
        XCTAssertEqual(ChatScrollAnchorMath.restoredOffset(itemMinY: 20, offsetFromTop: 40,
                                                           adjustedTop: 100, maxOffset: 5000), -100)
        // Near the bottom of a list that got shorter (wider window): clamp to max.
        XCTAssertEqual(ChatScrollAnchorMath.restoredOffset(itemMinY: 4800, offsetFromTop: -300,
                                                           adjustedTop: 100, maxOffset: 4200), 4200)
        // Content shorter than the viewport.
        XCTAssertEqual(ChatScrollAnchorMath.restoredOffset(itemMinY: 300, offsetFromTop: 0,
                                                           adjustedTop: 100, maxOffset: -300), -100)
    }

    private final class Box { let id = UUID() }

    func testContinuityStoreHandsTheSameObjectToTheReplacementView() {
        var clock = Date(timeIntervalSince1970: 1000)
        let store = FoldContinuityStore<Box>(window: 3, now: { clock })
        let first = store.value(for: "draft-1") { Box() }
        XCTAssertFalse(first.reused)
        store.claim("draft-1")                  // old view appears
        // Fold: the replacement is built while the old view still claims it…
        let second = store.value(for: "draft-1") { Box() }
        XCTAssertTrue(second.reused)
        XCTAssertTrue(first.value === second.value)
        store.release("draft-1")                // …old view goes away
        clock += 1
        store.claim("draft-1")                  // replacement appears
        clock += 60
        XCTAssertTrue(store.existing("draft-1") === first.value, "a claimed value never expires")
        store.release("draft-1")
        clock += 2.9
        XCTAssertNotNil(store.existing("draft-1"))
        clock += 0.2
        XCTAssertNil(store.existing("draft-1"), "released for longer than the window: gone")
        XCTAssertEqual(store.count, 0)
    }

    func testContinuityStoreDropsValuesNoViewEverClaimed() {
        var clock = Date(timeIntervalSince1970: 0)
        let store = FoldContinuityStore<Box>(window: 3, now: { clock })
        _ = store.value(for: "s") { Box() }
        clock += 3.5
        XCTAssertFalse(store.value(for: "s") { Box() }.reused)
        // Separate keys never share.
        XCTAssertFalse(store.value(for: "other") { Box() }.reused)
    }

    func testSnapshotStoreParksTakesAndRemembersTheFold() {
        var clock = Date(timeIntervalSince1970: 0)
        let store = FoldSnapshotStore<Set<String>>(window: 3, now: { clock })
        XCTAssertFalse(store.wasRecentlyParked("s1"))
        store.park(["inspector"], for: "s1")
        XCTAssertEqual(store.peek("s1"), ["inspector"])
        XCTAssertTrue(store.wasRecentlyParked("s1"))
        XCTAssertEqual(store.take("s1"), ["inspector"])
        XCTAssertNil(store.take("s1"), "taken once")
        XCTAssertTrue(store.wasRecentlyParked("s1"), "the replacement can still tell it is a fold")
        clock += 3.1
        XCTAssertFalse(store.wasRecentlyParked("s1"))
        store.park(["x"], for: "s2")
        clock += 3.1
        XCTAssertNil(store.take("s2"), "a stale position is not restored on a later visit")
        store.park(["y"], for: "s3")
        store.discard("s3")
        XCTAssertFalse(store.wasRecentlyParked("s3"))
    }

    // MARK: Fold continuity gating

    func testContinuityOnlyFollowsAFoldOrDisplayChange() {
        let now = Date(timeIntervalSince1970: 1_000)
        // Ordinary navigation (no hinge, no geometry change): nothing is parked.
        XCTAssertFalse(FoldSignalPolicy.isRecentFold(lastHingeMovement: nil, lastGeometryChange: nil, now: now))
        // Hinge moved within ~1.5 s.
        XCTAssertTrue(FoldSignalPolicy.isRecentFold(lastHingeMovement: now - 1.2, lastGeometryChange: nil, now: now))
        XCTAssertTrue(FoldSignalPolicy.isRecentFold(lastHingeMovement: now - 1.5, lastGeometryChange: nil, now: now))
        XCTAssertFalse(FoldSignalPolicy.isRecentFold(lastHingeMovement: now - 1.6, lastGeometryChange: nil, now: now))
        // Scene geometry changed within ~1 s.
        XCTAssertTrue(FoldSignalPolicy.isRecentFold(lastHingeMovement: nil, lastGeometryChange: now - 0.4, now: now))
        XCTAssertFalse(FoldSignalPolicy.isRecentFold(lastHingeMovement: nil, lastGeometryChange: now - 1.2, now: now))
        // Pop home and re-enter 2 s after an earlier fold: both signals stale.
        XCTAssertFalse(FoldSignalPolicy.isRecentFold(lastHingeMovement: now - 2, lastGeometryChange: now - 2, now: now))
        // A timestamp from the future (clock change) does not count.
        XCTAssertFalse(FoldSignalPolicy.isRecentFold(lastHingeMovement: now + 5, lastGeometryChange: nil, now: now))
    }

    func testAnchorRestoreGivesUpAfterFiveZeroHeightTurns() {
        XCTAssertEqual(FoldAnchorRestore.step(boundsHeight: 600, failedAttempts: 0), .restore)
        for attempt in 1...5 {
            XCTAssertEqual(FoldAnchorRestore.step(boundsHeight: 0, failedAttempts: attempt), .retry, "\(attempt)")
        }
        XCTAssertEqual(FoldAnchorRestore.step(boundsHeight: 0, failedAttempts: 6), .giveUp)
        // Laid out on the last turn: still restores.
        XCTAssertEqual(FoldAnchorRestore.step(boundsHeight: 600, failedAttempts: 5), .restore)
    }

    // MARK: P1-4 two windows

    func testExactlyOneChatHandlesAnAppWideEvent() {
        XCTAssertNil(GlobalEventRouting.winner(isKey: []))
        XCTAssertEqual(GlobalEventRouting.winner(isKey: [false]), 0)
        XCTAssertEqual(GlobalEventRouting.winner(isKey: [true, false]), 0, "the chat in the key window")
        XCTAssertEqual(GlobalEventRouting.winner(isKey: [false, true]), 1)
        XCTAssertEqual(GlobalEventRouting.winner(isKey: [true, true]), 1,
                       "fold transition: outgoing and incoming share the key window — the incoming one")
        XCTAssertEqual(GlobalEventRouting.winner(isKey: [false, false, false]), 2, "no chat in front: the newest")
    }

    // MARK: Wiring guards

    func testChatPageWiring() throws {
        let chat = try source("Views/Chat/AIChatView.swift")
        let pill = try source("Views/Components/LeoChromePill.swift")
        let list = try source("Agent/MessageList/CollectionViewMessageListV3.swift")
        let blocks = try source("Views/Chat/AssistantBlockView.swift")

        // P0-3: horizontal bars on the chat page, behind the 27.1 availability check.
        XCTAssertTrue(chat.contains("            .modifier(LeoHorizontalSystemBars())"))
        XCTAssertTrue(pill.contains("if #available(iOS 27.1, *) {\n            content.toolbarVerticalBehavior(.disabled)"))
        // P0-9: the composer compaction reads the measured height too.
        XCTAssertTrue(chat.contains("ChatShortHeightRule.isShort(verticalSizeClassCompact: vSizeClass == .compact"))
        XCTAssertTrue(chat.contains("visibleHeight: measured.height, wasShort: heightIsShort,\n                verticalSizeClassRegular: vSizeClass == .regular,"))
        // P1-2: composer stack, ↑↓ discs, new-message pill, download button.
        XCTAssertEqual(chat.components(separatedBy: ".modifier(FoldAvoidingControl())").count - 1, 4)
        XCTAssertTrue(pill.contains("proxy.reservedRegions(kind: .division)"))
        // P1-3: composer shell, input popups, activity strip.
        XCTAssertTrue(chat.contains(".modifier(ChatComposerShell(namespace: chatComposerGlassNS))"))
        XCTAssertTrue(chat.contains("ConcentricRectangle(corners: .concentric(minimum: .fixed(LeoTheme.Radius.composer))"))
        XCTAssertTrue(try source("Views/Chat/ToolLiveSheet.swift").contains(".modifier(LeoEdgeSurface("))
        // P0-7: list parks / restores, the re-entry bottom pin yields to it.
        XCTAssertTrue(list.contains("static func dismantleUIViewController(_ vc: MessageListViewController, coordinator: Coordinator) {\n        if FoldSignal.isRecent {\n            coordinator.parkFoldAnchor()\n        } else {\n            coordinator.discardFoldAnchor()"))
        // Open panels are parked only on a fold / display change.
        XCTAssertTrue(chat.contains("if panels.isEmpty || !FoldSignal.isRecent {\n            ChatFoldContinuity.openPanels.discard(key)"))
        // The restore's give-up path follows the bottom again.
        XCTAssertTrue(list.contains("case .giveUp:"))
        XCTAssertTrue(list.contains("pendingFoldAnchor = nil\n                scrollMode = .autoScrolling\n                scrollToBottomNow()"))
        // Signal sources.
        XCTAssertTrue(try source("Agent/Background/AgentLiveActivityManager.swift").contains("FoldSignal.noteHingeMovement()"))
        XCTAssertTrue(try source("Diagnostics/SceneDisplayLogger.swift").contains("if lastLogged[id] != nil { FoldSignal.noteGeometryChange() }"))
        XCTAssertTrue(chat.contains("!ChatFoldContinuity.scrollAnchors.wasRecentlyParked(sessionId)"))
        XCTAssertTrue(chat.contains("CachedViewModel(sessionId: sessionId, draftId: draftId)"))
        // P1-4: app-wide notifications handled by one chat only.
        XCTAssertTrue(chat.contains("guard ChatWindowGate.shouldHandleGlobalEvent(hostWindow) else { return }"))
        XCTAssertTrue(blocks.contains("!ChatWindowGate.shouldHandleGlobalEvent(hostWindow)"))
        XCTAssertTrue(blocks.contains("guard vm.messages.contains(where: { $0.blocks.contains { $0.id == blockId } })"))
    }

    func testDropTargetsAreNotIdiomGated() throws {
        let chat = try source("Views/Chat/AIChatView.swift")
        let bar = try source("Views/Chat/ChatInputBar.swift")
        let home = try source("Views/Home/HomeComposer.swift")
        XCTAssertTrue(chat.contains(".onDrop(of: [.image, .movie, .fileURL, .data], isTargeted: $isDropTargeted)"))
        XCTAssertTrue(home.contains(".dropDestination(for: String.self)"))
        for text in [chat, bar, home] {
            XCTAssertFalse(text.contains("userInterfaceIdiom == .pad"), "drag and drop works on the iPhone idiom too")
        }
    }
}
