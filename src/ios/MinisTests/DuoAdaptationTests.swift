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

    // MARK: [duo-composer] composer sizing from the container geometry

    func testVisibleHeightSubtractsTheBarsOnceNotTheKeyboardTwice() {
        typealias C = ChatComposerLayout
        // Measured on the 18 Pro Max simulator: container 922 / inset 34 (no
        // keyboard), 608 / inset 348 (keyboard); window top inset 62.
        XCTAssertEqual(C.visibleHeight(containerHeight: 922, windowTopInset: 62), 810)
        XCTAssertEqual(C.visibleHeight(containerHeight: 608, windowTopInset: 62), 496)
        XCTAssertEqual(C.windowHeight(containerHeight: 608, bottomInset: 348), 956)
        XCTAssertEqual(C.windowHeight(containerHeight: 922, bottomInset: 34), 956)
        // Window not captured yet: "not measured", the short rule keeps its answer.
        XCTAssertEqual(C.visibleHeight(containerHeight: 608, windowTopInset: nil), 0)
        XCTAssertTrue(ChatShortHeightRule.heightIsShort(visibleHeight: 0, wasShort: true,
                                                        verticalSizeClassRegular: true, windowWidth: 951))
        // Pro Max with the keyboard is not short (the old double subtraction read 260).
        XCTAssertFalse(ChatShortHeightRule.heightIsShort(visibleHeight: 496, wasShort: false))
        // iPad 11" landscape with the keyboard (834 − ~400 kb − 24 − 50 ≈ 360): full composer.
        XCTAssertFalse(ChatShortHeightRule.heightIsShort(
            visibleHeight: C.visibleHeight(containerHeight: 834 - 400, windowTopInset: 24),
            wasShort: false, verticalSizeClassRegular: true, windowWidth: 1194))
        // Duo inner landscape with a ~330 pt keyboard: 669 − 330 − 24 − 50 = 265, short.
        XCTAssertTrue(ChatShortHeightRule.heightIsShort(
            visibleHeight: C.visibleHeight(containerHeight: 669 - 330, windowTopInset: 24),
            wasShort: false, verticalSizeClassRegular: true, windowWidth: 951))
        // Duo inner portrait with the keyboard keeps the full composer (951 − 300 − 24 − 50).
        XCTAssertFalse(ChatShortHeightRule.heightIsShort(
            visibleHeight: C.visibleHeight(containerHeight: 951 - 300, windowTopInset: 24),
            wasShort: false, verticalSizeClassRegular: true, windowWidth: 669))
    }

    func testComposerTextGrowsWithTheRoomLeft() {
        typealias C = ChatComposerLayout
        XCTAssertEqual(C.maxTextHeight(visibleHeight: 810, verticalSizeClassCompact: false), 160, "Pro Max, no keyboard: 8 lines")
        XCTAssertEqual(C.maxTextHeight(visibleHeight: 496, verticalSizeClassCompact: false), 120, "Pro Max + keyboard: 6 lines")
        XCTAssertEqual(C.maxTextHeight(visibleHeight: 300, verticalSizeClassCompact: false), 60, "Duo outer + keyboard: 3 lines")
        XCTAssertEqual(C.maxTextHeight(visibleHeight: 265, verticalSizeClassCompact: false), 60, "Duo inner landscape + keyboard")
        XCTAssertEqual(C.maxTextHeight(visibleHeight: 575, verticalSizeClassCompact: false), 140, "Duo inner landscape, no keyboard")
        XCTAssertEqual(C.maxTextHeight(visibleHeight: 900, verticalSizeClassCompact: true), 60, "landscape phone keeps 3 lines")
        XCTAssertEqual(C.maxTextHeight(visibleHeight: 0, verticalSizeClassCompact: false), 120, "unmeasured: old 6 lines")
        // Whole-line steps: a few points of geometry jitter don't change the cap.
        XCTAssertEqual(C.maxTextHeight(visibleHeight: 500, verticalSizeClassCompact: false),
                       C.maxTextHeight(visibleHeight: 515, verticalSizeClassCompact: false))
        for v in stride(from: CGFloat(1), through: 2000, by: 37) {
            let h = C.maxTextHeight(visibleHeight: v, verticalSizeClassCompact: false)
            XCTAssertTrue((C.minText...C.maxText).contains(h))
            XCTAssertEqual(h.truncatingRemainder(dividingBy: C.textStep), 0)
        }
    }

    func testComposerSitsJustAboveTheHomeIndicator() {
        typealias C = ChatComposerLayout
        // iPhone (34): card 20 pt from the screen edge instead of 8 + 34 = 42.
        XCTAssertEqual(C.bottomPadding(bottomInset: 34), -14)
        XCTAssertEqual(34 + C.bottomPadding(bottomInset: 34), 20)
        // iPad (20): 12 pt from the edge, clear of the indicator.
        XCTAssertEqual(20 + C.bottomPadding(bottomInset: 20), 12)
        // Keyboard / accessory bar, or no inset at all: 8 pt gap as before.
        XCTAssertEqual(C.bottomPadding(bottomInset: 348), 8)
        // 44…64 线性过渡(键盘收起最后几帧、硬件键盘快捷栏),64 起回到 8。
        XCTAssertEqual(C.bottomPadding(bottomInset: 64), 8)
        XCTAssertEqual(C.bottomPadding(bottomInset: 0), 8)
        // With an indicator the card keeps at least 60 % of the inset to the edge.
        for inset in stride(from: CGFloat(1), through: C.homeIndicatorMaxInset, by: 1) {
            XCTAssertGreaterThanOrEqual(inset + C.bottomPadding(bottomInset: inset), (inset * 0.6).rounded())
        }
    }

    func testDenseComposerOnlyOnShortWindows() {
        typealias C = ChatComposerLayout
        XCTAssertTrue(C.isDense(windowHeight: 678), "Duo outer")
        XCTAssertTrue(C.isDense(windowHeight: 669), "Duo inner landscape")
        XCTAssertTrue(C.isDense(windowHeight: 667), "SE")
        XCTAssertFalse(C.isDense(windowHeight: 951), "Duo inner portrait")
        XCTAssertFalse(C.isDense(windowHeight: 874), "18 Pro")
        XCTAssertFalse(C.isDense(windowHeight: 956), "18 Pro Max")
        XCTAssertFalse(C.isDense(windowHeight: 0), "unmeasured")
        let roomy = C.spacing(dense: false), dense = C.spacing(dense: true)
        XCTAssertEqual(roomy, .init(textTop: 16, textTopWithAttachments: 11, rowBottom: 10, outerTop: 8), "ordinary phones unchanged")
        XCTAssertLessThan(dense.textTop + dense.rowBottom + dense.outerTop, roomy.textTop + roomy.rowBottom + roomy.outerTop)
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
        XCTAssertTrue(chat.contains("visibleHeight: visible, wasShort: heightIsShort,\n            verticalSizeClassRegular: vSizeClass == .regular,"))
        // [duo-composer] …measured once (no second subtraction of the keyboard inset).
        XCTAssertTrue(chat.contains("ChatComposerLayout.visibleHeight(containerHeight: m.height,"))
        XCTAssertFalse(chat.contains("proxy.size.height - proxy.safeAreaInsets.top - proxy.safeAreaInsets.bottom"))
        XCTAssertTrue(chat.contains("maxTextHeight: composerMaxTextHeight"), "composer text cap follows the visible height")
        XCTAssertTrue(chat.contains(".padding(.bottom, composerBottomPadding)"), "card sits just above the home indicator")
        // P1-2: composer stack, ↑↓ discs, new-message pill, download button.
        XCTAssertEqual(chat.components(separatedBy: ".modifier(FoldAvoidingControl())").count - 1, 3)
        XCTAssertTrue(chat.contains(".modifier(FoldAvoidingControl(squeezeHorizontally: false, maxLift: FoldAvoidance.composerMaxLift))"),
                      "composer: full width across a book fold, lift ≤ 60 pt")
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

    // MARK: Fable 5.1 审计(输入框)

    func testComposerCapIgnoresSmallChangesWhileTyping() {
        // 预测栏开合 / 键盘动画让目标差 20 pt:保持当前上限,不让整框跳
        XCTAssertEqual(ChatComposerLayout.maxTextHeight(visibleHeight: 496, verticalSizeClassCompact: false, current: 140), 140)
        // 差得多(键盘弹出 160 → 3 行)才改
        XCTAssertEqual(ChatComposerLayout.maxTextHeight(visibleHeight: 265, verticalSizeClassCompact: false, current: 160), 60)
        XCTAssertEqual(ChatComposerLayout.maxTextHeight(visibleHeight: 496, verticalSizeClassCompact: false, current: nil), 120)
    }

    func testComposerCapScalesWithTheInputFontsLineHeight() {
        // 1.5 倍字号(行高 30):最少 3 行 = 90,不是 60
        XCTAssertEqual(ChatComposerLayout.maxTextHeight(visibleHeight: 265, verticalSizeClassCompact: false, lineHeight: 30), 90)
        XCTAssertEqual(ChatComposerLayout.maxTextHeight(visibleHeight: 2000, verticalSizeClassCompact: false, lineHeight: 30), 240)
        XCTAssertEqual(ChatComposerLayout.maxTextHeight(visibleHeight: 0, verticalSizeClassCompact: true, lineHeight: 30), 90)
    }

    func testBottomPaddingBlendsBetweenHomeIndicatorAndKeyboard() {
        let atIndicator = ChatComposerLayout.bottomPadding(bottomInset: 44)
        let mid = ChatComposerLayout.bottomPadding(bottomInset: 54)
        XCTAssertLessThan(atIndicator, mid)
        XCTAssertLessThan(mid, ChatComposerLayout.keyboardGap)
        XCTAssertEqual(ChatComposerLayout.bottomPadding(bottomInset: 64), ChatComposerLayout.keyboardGap)
        XCTAssertEqual(ChatComposerLayout.bottomPadding(bottomInset: 336), ChatComposerLayout.keyboardGap)
    }

    func testComposerStaysFullWidthAcrossABookFoldAndNeverLiftsMoreThan60() {
        let composer = CGSize(width: 900, height: 140)
        let bookFold = CGRect(x: 470, y: -400, width: 12, height: 900)
        XCTAssertEqual(FoldAvoidance.insets(size: composer, divisions: [bookFold], squeezeHorizontally: false), .zero)
        XCTAssertNotEqual(FoldAvoidance.insets(size: composer, divisions: [bookFold]), .zero, "pills still move off the fold")
        let laptopFoldNearTop = CGRect(x: 0, y: 20, width: 900, height: 12)   // would need a 120 pt lift
        XCTAssertEqual(FoldAvoidance.insets(size: composer, divisions: [laptopFoldNearTop], maxLift: FoldAvoidance.composerMaxLift), .zero)
        let laptopFoldNearBottom = CGRect(x: 0, y: 110, width: 900, height: 12)
        XCTAssertEqual(FoldAvoidance.insets(size: composer, divisions: [laptopFoldNearBottom], maxLift: FoldAvoidance.composerMaxLift).bottom, 30)
    }
}
