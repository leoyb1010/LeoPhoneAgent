import XCTest

/// WP-42:Liquid Glass 控制层 + 动效体系的可测部分(节拍、状态条语义、Reduce Motion 退化),
/// 以及几处关键接线的源码守卫。
final class WP42MotionSystemTests: XCTestCase {
    private var iosRoot: URL {
        URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
    }
    private func source(_ path: String) throws -> String {
        try String(contentsOf: iosRoot.appendingPathComponent(path), encoding: .utf8)
    }

    func testBeatMatchesCrossPlatformToken() {
        XCTAssertEqual(LeoMotionPolicy.beat, 1.6, "same as Mac --leo-beat")
    }

    func testToolStatusStripSemantics() {
        XCTAssertEqual(LeoMotionPolicy.strip(forToolStatus: "running"), .running)
        XCTAssertEqual(LeoMotionPolicy.strip(forToolStatus: "streaming"), .running)
        XCTAssertEqual(LeoMotionPolicy.strip(forToolStatus: "success"), .success)
        XCTAssertEqual(LeoMotionPolicy.strip(forToolStatus: "failed"), .failure)
        XCTAssertEqual(LeoMotionPolicy.strip(forToolStatus: "cancelled"), .cancelled)
        XCTAssertEqual(LeoMotionPolicy.strip(forToolStatus: nil), .hidden)
        XCTAssertEqual(LeoMotionPolicy.strip(forToolStatus: "running", waitingForApproval: true), .waiting)
        XCTAssertTrue(LeoMotionPolicy.StripStatus.running.breathes)
        XCTAssertFalse(LeoMotionPolicy.StripStatus.success.breathes)
    }

    func testGroupStripPrefersFailureThenCancel() {
        XCTAssertEqual(LeoMotionPolicy.strip(forGroupFailed: 1, cancelled: 2), .failure)
        XCTAssertEqual(LeoMotionPolicy.strip(forGroupFailed: 0, cancelled: 1), .cancelled)
        XCTAssertEqual(LeoMotionPolicy.strip(forGroupFailed: 0, cancelled: 0), .success)
    }

    func testReduceMotionFallsBackToFadeOnly() {
        XCTAssertEqual(LeoMotionPolicy.fallback(reduceMotion: true), .fadeOnly)
        XCTAssertEqual(LeoMotionPolicy.fallback(reduceMotion: false), .full)
    }

    func testDoneFlashOnlyOnTheLiveTransition() {
        XCTAssertTrue(LeoMotionPolicy.shouldFlashDone(wasFinished: false, isFinished: true, hasAppeared: true))
        XCTAssertFalse(LeoMotionPolicy.shouldFlashDone(wasFinished: false, isFinished: true, hasAppeared: false),
                       "scrolling history must not flash")
        XCTAssertFalse(LeoMotionPolicy.shouldFlashDone(wasFinished: true, isFinished: true, hasAppeared: true))
    }

    func testEveryNewEffectHonoursReduceMotion() throws {
        let effects = try source("Shared/LeoMotionEffects.swift")
        let marker = try XCTUnwrap(effects.range(of: "// MARK: - [WP-42] Thinking shimmer"))
        let wp42 = String(effects[marker.lowerBound...])
        for name in ["LeoThinkingShimmerModifier", "LeoDoneModifier", "LeoSendFlightModifier",
                     "LeoBreathingDot", "LeoStatusStrip"] {
            let start = try XCTUnwrap(wp42.range(of: name))
            let body = String(wp42[start.lowerBound...].prefix(1800))
            XCTAssertTrue(body.contains("reduceMotion"), "\(name) must read accessibilityReduceMotion")
        }
        XCTAssertTrue(wp42.contains("? .scale(scale: 0.85).combined(with: .opacity)\n            : .opacity"))
    }

    func testControlLayerGlassAndComposerContainer() throws {
        let chat = try source("Views/Chat/AIChatView.swift")
        XCTAssertTrue(chat.contains("GlassEffectContainer(spacing: LeoComposerGlass.containerSpacing)"))
        XCTAssertTrue(chat.contains(".leoComposerChrome(glassID: \"chat.composer\", in: chatComposerGlassNS)"))
        XCTAssertTrue(chat.contains(".toolbarMinimizationBehavior(.onScrollDown, for: .navigationBar)"))
        XCTAssertFalse(chat.contains(".background(.regularMaterial, in: Capsule())"), "new-messages pill is glass")
        // 隐私遮罩是内容层,保留 Material。
        XCTAssertTrue(chat.contains(".fill(.regularMaterial)"))
        let home = try source("Views/ContentView.swift")
        XCTAssertTrue(home.contains("glassNamespace: homeComposerGlassNS"))
        XCTAssertTrue(home.contains(".swipeActions(edge: .leading, allowsFullSwipe: true)"))
        let block = try source("Views/Chat/AssistantBlockView.swift")
        XCTAssertTrue(block.contains(".leoThinkingShimmer(active: isStreaming)"))
        XCTAssertTrue(block.contains("LeoStatusStrip(status: stripStatus"))
    }
}
