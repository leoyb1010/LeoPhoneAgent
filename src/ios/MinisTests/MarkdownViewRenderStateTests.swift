import XCTest

/// Step-9 guards for SelectableMarkdownView (not compiled into the logic-test
/// target): [T-ios-memo-key-ignores-render-state], [T-ios-reuse-cachewipe],
/// [T-ios-image-single-writer], [T-codeblock-hide-idle-scrollbars].
final class MarkdownViewRenderStateTests: XCTestCase {
    private func source(_ relative: String) throws -> String {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
        return try String(contentsOf: root.appendingPathComponent(relative), encoding: .utf8)
    }

    private func imageAttachmentBody() throws -> Substring {
        let md = try source("Views/Chat/SelectableMarkdownView.swift")
        let start = try XCTUnwrap(md.range(of: "final class ImageAttachment: NSTextAttachment {"))
        let end = try XCTUnwrap(md.range(of: "\nfinal class ", range: start.upperBound..<md.endIndex))
        return md[start.lowerBound..<end.lowerBound]
    }

    func testMemoKeyIsQualifiedByAsyncRenderStateOnBothSides() throws {
        let infra = try source("Agent/MessageList/MessageListInfrastructure.swift")
        XCTAssertTrue(infra.contains("recordMeasuredHeight(forKey: Self.renderQualifiedKey(key, for: self)"))
        let list = try source("Agent/MessageList/CollectionViewMessageListV3.swift")
        XCTAssertTrue(list.contains("let memoKey = SelfSizingCell.renderQualifiedKey(key, for: cell)"))
        XCTAssertTrue(list.contains("layout.measuredHeight(forKey: memoKey, width: cvW)"), "read and write must use the same key")
        let md = try source("Views/Chat/SelectableMarkdownView.swift")
        XCTAssertTrue(md.contains("func asyncAttachmentRenderSignal() -> Int"))
        XCTAssertTrue(md.contains("total += img.loadedImage?.size.height ?? 0"), "bounds is never written; use the bitmap")
    }

    func testRecycledViewDoesNotWipeAttachmentCaches() throws {
        let md = try source("Views/Chat/SelectableMarkdownView.swift")
        XCTAssertTrue(md.contains("let contentId = blockId ?? messageId"))
        XCTAssertTrue(md.contains("&& !isDifferentContent"))
        XCTAssertTrue(md.contains("private func performRefreshAttachmentViews()"))
        XCTAssertTrue(md.contains("guard !isCoalescingRefresh else { return }"))
    }

    func testImageAttachmentHasASingleWriterAndGenerationGate() throws {
        let body = try imageAttachmentBody()
        let writes = body.components(separatedBy: "loadedImage = ").count - 1
        XCTAssertEqual(writes, 2, "only adoptLoaded writes a bitmap; invalidateLoadedImage clears it")
        XCTAssertTrue(body.contains("guard gen == self.loadGeneration else"))
        XCTAssertTrue(body.contains("loadGeneration &+= 1\n        isLoading = false"), "invalidation kills in-flight loads")
        XCTAssertFalse(body.contains("Task.detached(priority: .utility)"), "no bounds-time re-downsample")
        XCTAssertFalse(body.contains("downsampledAtPixelSize"))
        // Cache adoption precedes the in-flight guard.
        let cacheIdx = try XCTUnwrap(body.range(of: "if let cached = NativeMediaImageCache.shared.image(for: fpKey)")).lowerBound
        let guardIdx = try XCTUnwrap(body.range(of: "guard loadedImage == nil, !isLoading else")).lowerBound
        XCTAssertLessThan(cacheIdx, guardIdx)
        XCTAssertTrue(body.contains("maxPixelSize: displayTargetPixels(for: data, screenScale: screenScale)"))
    }

    func testCodeBlockScrollbarsFollowScrollability() throws {
        let md = try source("Views/Chat/SelectableMarkdownView.swift")
        XCTAssertTrue(md.contains("private static func syncScrollability(_ scrollView: UIScrollView"))
        XCTAssertEqual(md.components(separatedBy: "Self.syncScrollability(").count - 1, 2, "makeView + updateExistingView")
        XCTAssertTrue(md.contains("scrollView.isScrollEnabled = canScrollV || canScrollH"))
        XCTAssertTrue(md.contains("if let codeScroll = findCodeScrollView(in: subview)"))
    }
}
