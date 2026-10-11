import UIKit
import XCTest

/// [T-r3-S3] The setSize: guard clamps .greatestFiniteMagnitude to a finite
/// sentinel; height restores must compare against that sentinel, or every
/// layout pass re-issues setSize: and re-typesets the whole message.
@MainActor
final class TextContainerGuardTests: XCTestCase {
    override func setUp() {
        super.setUp()
        NSTextContainerSetSizeGuard.install()
    }

    func testGuard_clampSentinelMatchesSwiftConstant() {
        XCTAssertEqual(NSTextContainerSetSizeGuard.unboundedDimension(), LeoTextContainer.unboundedHeight)
        let tc = NSTextContainer(size: CGSize(width: 100, height: 100))
        tc.size = CGSize(width: 100, height: CGFloat.greatestFiniteMagnitude)
        XCTAssertEqual(tc.size.height, LeoTextContainer.unboundedHeight)
        XCTAssertTrue(tc.size.height < CGFloat.greatestFiniteMagnitude,
                      "the pre-fix test (`< .greatestFiniteMagnitude`) is always true after the clamp")
        XCTAssertFalse(LeoTextContainer.needsUnboundedRestore(tc.size.height))
        XCTAssertTrue(LeoTextContainer.needsUnboundedRestore(812))
        XCTAssertFalse(LeoTextContainer.needsUnboundedRestore(.nan))
    }

    func testGuard_identicalSetSizeInSameTickForwardedOnce() {
        let tc = NSTextContainer(size: .zero)
        let before = NSTextContainerSetSizeGuard.forwardedCount()
        for _ in 0..<5 { tc.size = CGSize(width: 321, height: 654) }
        XCTAssertEqual(NSTextContainerSetSizeGuard.forwardedCount() - before, 1)
        XCTAssertEqual(tc.size, CGSize(width: 321, height: 654))
    }

    /// [r7] Device 1.64: `size=334.0x10000000.0 repeatThisTick=6` — UIKit's own
    /// sizeThatFits set/restore re-assigned the size the container already had.
    func testGuard_identicalToCurrentSizeIsNeverForwarded() {
        let tc = NSTextContainer(size: CGSize(width: 334, height: CGFloat.greatestFiniteMagnitude))
        tc.size = CGSize(width: 334, height: CGFloat.greatestFiniteMagnitude) // clamps → changes
        let forwarded = NSTextContainerSetSizeGuard.forwardedCount()
        let skipped = NSTextContainerSetSizeGuard.identicalSkipCount()
        for _ in 0..<6 { tc.size = CGSize(width: 334, height: CGFloat.greatestFiniteMagnitude) }
        tc.size = CGSize(width: 334, height: LeoTextContainer.unboundedHeight)
        XCTAssertEqual(NSTextContainerSetSizeGuard.forwardedCount() - forwarded, 0)
        XCTAssertEqual(NSTextContainerSetSizeGuard.identicalSkipCount() - skipped, 7)
        tc.size = CGSize(width: 236, height: LeoTextContainer.unboundedHeight)
        XCTAssertEqual(NSTextContainerSetSizeGuard.forwardedCount() - forwarded, 1, "a real change still goes through")
        XCTAssertEqual(tc.size.width, 236)
    }

    func testMeasure_sizeThatFitsAtContainerWidthIssuesNoSetSize() {
        let tv = UITextView(frame: CGRect(x: 0, y: 0, width: 334, height: 50))
        tv.isScrollEnabled = false
        tv.textContainer.lineFragmentPadding = 0
        tv.textContainerInset = .zero
        tv.text = String(repeating: "流畅滚动 smooth scrolling. ", count: 40)
        tv.textContainer.size = CGSize(width: 334, height: CGFloat.greatestFiniteMagnitude)
        let forwarded = NSTextContainerSetSizeGuard.forwardedCount()
        let shortCircuits = NSTextContainerSetSizeGuard.shortCircuitCount()
        var heights = Set<CGFloat>()
        for _ in 0..<6 {
            heights.insert(tv.sizeThatFits(CGSize(width: 334, height: CGFloat.greatestFiniteMagnitude)).height)
        }
        XCTAssertEqual(NSTextContainerSetSizeGuard.forwardedCount() - forwarded, 0)
        XCTAssertEqual(NSTextContainerSetSizeGuard.shortCircuitCount() - shortCircuits, 0)
        XCTAssertEqual(heights.count, 1, "measurement is stable")
        XCTAssertGreaterThan(heights.first ?? 0, 100, "multi-line text still measures its full height")
        XCTAssertEqual(tv.textContainer.size, CGSize(width: 334, height: LeoTextContainer.unboundedHeight))
    }

    func testDecisionHelper_needsResize() {
        let unbounded = CGSize(width: 334, height: LeoTextContainer.unboundedHeight)
        XCTAssertFalse(LeoTextContainer.needsResize(current: unbounded,
                                                    to: CGSize(width: 334, height: CGFloat.greatestFiniteMagnitude)))
        XCTAssertFalse(LeoTextContainer.needsResize(current: unbounded,
                                                    to: CGSize(width: 334.2, height: LeoTextContainer.unboundedHeight)))
        XCTAssertTrue(LeoTextContainer.needsResize(current: unbounded,
                                                   to: CGSize(width: 236, height: CGFloat.greatestFiniteMagnitude)))
        XCTAssertTrue(LeoTextContainer.needsResize(current: CGSize(width: 334, height: 548),
                                                   to: CGSize(width: 334, height: CGFloat.greatestFiniteMagnitude)))
        XCTAssertEqual(LeoTextContainer.clamped(CGSize(width: CGFloat.greatestFiniteMagnitude, height: 12)),
                       CGSize(width: LeoTextContainer.unboundedHeight, height: 12))
    }

    func testSessionSummary_countsByWidthOnlyWhenSomethingWasCut() {
        _ = NSTextContainerSetSizeGuard.sessionSummaryResetting(true)
        let tc = NSTextContainer(size: CGSize(width: 100, height: 100))
        for _ in 0..<5 { tc.size = CGSize(width: 100, height: 100) }
        XCTAssertNil(NSTextContainerSetSizeGuard.sessionSummaryResetting(false),
                     "identical no-op skips alone never produce a log line")
        for _ in 0..<3 { NSTextContainerSetSizeGuard.recordShortCircuit(forTestingWidth: 334) }
        NSTextContainerSetSizeGuard.recordShortCircuit(forTestingWidth: 236.2)
        tc.size = CGSize(width: -16, height: 0) // rejected
        let line = NSTextContainerSetSizeGuard.sessionSummaryResetting(true)
        XCTAssertNotNil(line)
        XCTAssertTrue(line?.contains("shortCircuits=4") == true, line ?? "")
        XCTAssertTrue(line?.contains("rejected=1") == true, line ?? "")
        XCTAssertTrue(line?.contains("byWidth={334:3,236:1}") == true, line ?? "")
        XCTAssertNil(NSTextContainerSetSizeGuard.sessionSummaryResetting(true), "reset clears the session")
    }

    func testMeasure_noContainerResizeStormOnSizeThatFits() {
        let tv = UITextView(frame: CGRect(x: 0, y: 0, width: 300, height: 120))
        tv.isScrollEnabled = false
        tv.text = String(repeating: "流畅滚动 smooth scrolling. ", count: 300)
        tv.textContainer.size = CGSize(width: 300, height: CGFloat.greatestFiniteMagnitude)
        let before = NSTextContainerSetSizeGuard.forwardedCount()
        var restores = 0
        for _ in 0..<50 {
            // The measure + restore sequence SelectableMarkdownView runs per pass.
            _ = tv.sizeThatFits(CGSize(width: 300, height: CGFloat.greatestFiniteMagnitude))
            if LeoTextContainer.needsUnboundedRestore(tv.textContainer.size.height) {
                tv.textContainer.size.height = LeoTextContainer.unboundedHeight
                restores += 1
            }
            tv.setNeedsLayout()
            tv.layoutIfNeeded()
        }
        let forwarded = NSTextContainerSetSizeGuard.forwardedCount() - before
        XCTAssertEqual(restores, 0, "an unclamped container must not be restored")
        XCTAssertLessThan(forwarded, 5, "no setSize: per measure/layout pass (was one per pass)")
    }
}
