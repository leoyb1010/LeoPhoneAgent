import CoreGraphics
import Foundation
import XCTest

/// [T-r3-S7/S8/P2] Hot-path wiring for the chat renderer. The markdown view,
/// message list and view model are not in the logic-test target, so their
/// wiring is pinned by source scans; pure helpers are tested directly.
final class RenderHotPathTests: XCTestCase {
    private func source(_ relative: String) throws -> String {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
        return try String(contentsOf: root.appendingPathComponent(relative), encoding: .utf8)
    }

    func testHeightKey_precomputedHashMatchesContentKey() {
        let body = "## 标题\n\n正文 **粗体** 与 [链接](https://example.com)"
        XCTAssertEqual(HeightCacheKey(contentLength: body.utf8.count, contentHash: body.hashValue, width: 358, fontSize: 16.5),
                       HeightCacheKey(content: body, width: 358, fontSize: 16.5))
    }

    func testFormatters_sharedPerFormat() {
        XCTAssertTrue(LeoFormatters.date(format: "HH:mm") === LeoFormatters.date(format: "HH:mm"))
        XCTAssertFalse(LeoFormatters.date(format: "HH:mm") === LeoFormatters.date(format: "M/d"))
        XCTAssertTrue(LeoFormatters.date(dateStyle: .medium, timeStyle: .none)
                      === LeoFormatters.date(dateStyle: .medium, timeStyle: .none))
        XCTAssertNotNil(LeoFormatters.iso8601Fractional.date(from: "2026-10-10T08:00:00.123Z"))
    }

    func testTextContainerRestoresCompareAgainstClampedSentinel() throws {
        let md = try source("Views/Chat/SelectableMarkdownView.swift")
        XCTAssertFalse(md.contains("< CGFloat.greatestFiniteMagnitude"), "always true after the guard's clamp")
        XCTAssertEqual(md.components(separatedBy: "LeoTextContainer.needsUnboundedRestore(").count - 1, 5)
    }

    func testUpdateUIViewDecidesUnchangedFirst() throws {
        let md = try source("Views/Chat/SelectableMarkdownView.swift")
        let unchanged = try XCTUnwrap(md.range(of: "let markdownUnchanged = markdown == context.coordinator.lastMarkdown"))
        let widthProbe = try XCTUnwrap(md.range(of: "let _curW = textView.textContainer.size.width"))
        XCTAssertLessThan(unchanged.lowerBound, widthProbe.lowerBound)
        XCTAssertTrue(md.contains("guard !markdownUnchanged || fontChanged || tailNeedsFinalRender else {"))
        XCTAssertTrue(md.contains("if AppLogger.isVerboseEnabled, renderSource.contains(\"![\")"))
        XCTAssertFalse(md.contains("let prepared = prepareMarkdownForRender(_splitForUpdate.prefix)"), "cachedContent skips prep")
    }

    func testStreamingFlushPublishesOnce() throws {
        let vm = try source("Agent/Chat/AIChatViewModel.swift")
        XCTAssertTrue(vm.contains("block.applyBatched {\n            block.isStreamingText = !shouldCacheAttributedString"))
        let all = try source("Agent/Chat/ChatModels.swift")
        let start = try XCTUnwrap(all.range(of: "final class AssistantBlock: Identifiable, ObservableObject {"))
        let models = String(all[start.lowerBound...].prefix(20_000))
        XCTAssertFalse(models.contains("@Published var content: String"))
        XCTAssertFalse(models.contains("@Published var cachedMarkdown"))
        XCTAssertFalse(models.contains("@Published var cachedAttributedString"))
        XCTAssertTrue(models.contains("func applyBatched(_ body: () -> Void)"))
    }

    func testAttachmentSizeChangeScopedToOwner() throws {
        let list = try source("Agent/MessageList/CollectionViewMessageListV3.swift")
        XCTAssertTrue(list.contains("notification.userInfo?[Notification.Name.minisAttachmentOwnerKey] as? UUID"))
        XCTAssertFalse(list.contains("snap.reconfigureItems(snapshot.itemIdentifiers)"), "no whole-snapshot reconfigure per image")
        XCTAssertTrue(list.contains("contentHash: block.contentHash"))
        XCTAssertTrue(list.contains("DispatchQueue.main.asyncAfter(deadline: .now() + 0.05)"))
    }

    func testHotPathImageLogsAreVerbose() throws {
        let md = try source("Views/Chat/SelectableMarkdownView.swift")
        for tag in ["[IMG][BOUNDS]", "[IMG][MAKEVIEW]", "[UAV] enter", "[UPD] entry", "[MinisImage][MakeView]", "[MinisImage][InlineParse]", "[MinisImage][StreamParse]", "[MinisImage][RenderAttach]"] {
            let lines = md.components(separatedBy: "\n").filter { $0.contains(tag) && $0.contains("(\"") }
            XCTAssertFalse(lines.isEmpty, tag)
            XCTAssertTrue(lines.allSatisfy { $0.contains(".verbose(") }, "\(tag) must be verbose")
        }
    }

    func testDeadKaTeXRendererRemoved() throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent("Agent/Markdown/KaTeXRenderer.swift").path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent("Resources/KaTeX/katex-render.html").path))
        let pbx = try source("LeoPhoneAgent.xcodeproj/project.pbxproj")
        XCTAssertFalse(pbx.contains("KaTeX"))
    }

    func testHelperCardsParseOnceAndWatchOnlyTheirJob() throws {
        let card = try source("Views/Chat/HelperBlockView.swift")
        XCTAssertFalse(card.contains("@ObservedObject private var registry"))
        XCTAssertTrue(card.contains("static func parsed(_ block: AssistantBlock)"))
        let blockView = try source("Views/Chat/AssistantBlockView.swift")
        XCTAssertFalse(blockView.contains("UIImage(contentsOfFile:"), "tool images decode downsampled off-main")
    }
}
