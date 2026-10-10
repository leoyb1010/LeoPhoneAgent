import Foundation
import XCTest

/// Share extension / "Open in" / App Group record bounds.
final class ShareBoundsTests: XCTestCase {

    func testShareCapsItemCountAndInlineText() {
        let items = (0..<50).map { PendingShare.Item(kind: .inlineText, value: "item \($0)") }
            + [PendingShare.Item(kind: .inlineText, value: String(repeating: "x", count: 100_000))]
        let bounded = PendingShare.bounded(items)
        XCTAssertEqual(bounded.count, PendingShare.maxItems)
        XCTAssertEqual(bounded.last?.value.count, PendingShare.maxInlineTextChars)
        XCTAssertEqual(bounded.first?.value, "item 31", "the newest items are kept")
        let attachment = PendingShare.Item(kind: .attachment, value: "shared-abc_file.pdf")
        XCTAssertEqual(PendingShare.bounded([attachment]), [attachment], "file names are never truncated")

        let record = PendingShare(items: items, timestamp: Date(), instruction: "do it")
        XCTAssertEqual(record.bounded.items.count, PendingShare.maxItems)
        XCTAssertEqual(record.bounded.instruction, "do it")
    }

    func testShareFileSizeIsCheckedBeforeCopy() {
        XCTAssertTrue(PendingShare.admitsAttachment(byteCount: 10))
        XCTAssertTrue(PendingShare.admitsAttachment(byteCount: nil), "unknown size: copy is streamed")
        XCTAssertTrue(PendingShare.admitsAttachment(byteCount: PendingShare.maxAttachmentBytes))
        XCTAssertFalse(PendingShare.admitsAttachment(byteCount: PendingShare.maxAttachmentBytes + 1))
        XCTAssertFalse(PendingShare.admitsAttachment(byteCount: -1))
    }
}
