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

    func testGuard_logsOnlyOnPowersOfTwo() {
        let logged = (0...1_000).filter { NSTextContainerSetSizeGuard.shouldLogShortCircuitTotal(UInt64($0)) }
        XCTAssertEqual(logged, [1, 2, 4, 8, 16, 32, 64, 128, 256, 512])
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
