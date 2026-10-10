import Foundation
import XCTest

/// [T-r3-B22] Markdown image limits: bounded concurrency, data: URI size cap,
/// file: URLs confined to the session's media directory.
final class ImageAttachmentTests: XCTestCase {
    private final class ConcurrencyProbe: @unchecked Sendable {
        private let lock = NSLock()
        private var current = 0
        private(set) var peak = 0
        private(set) var completed = 0
        func enter() {
            lock.lock(); current += 1; peak = max(peak, current); lock.unlock()
        }
        func leave() {
            lock.lock(); current -= 1; completed += 1; lock.unlock()
        }
    }

    func testImage_5kImagesLoadsAtMostNConcurrently() async {
        let limiter = AsyncLimiter(limit: MarkdownImagePolicy.maxConcurrentLoads)
        let probe = ConcurrencyProbe()
        await withTaskGroup(of: Void.self) { group in
            for _ in 0..<5_000 {
                group.addTask {
                    await limiter.run {
                        probe.enter()
                        await Task.yield()
                        try? await Task.sleep(nanoseconds: 20_000)
                        probe.leave()
                    }
                }
            }
        }
        XCTAssertEqual(probe.completed, 5_000, "every queued load eventually runs")
        XCTAssertLessThanOrEqual(probe.peak, MarkdownImagePolicy.maxConcurrentLoads)
        XCTAssertEqual(MarkdownImagePolicy.maxConcurrentLoads, 4)
        XCTAssertEqual(MarkdownImagePolicy.maxImagesPerMessage, 64)
        XCTAssertEqual(MarkdownImagePolicy.fetchTimeout, 10)
    }

    func testImage_dataURIAbove1MBIsSkipped() {
        let big = "data:image/png;base64," + String(repeating: "A", count: 1_500_000)
        XCTAssertEqual(MarkdownImagePolicy.verdict(for: big, sessionMediaRoot: nil), .dataURITooLarge)
        let small = "data:image/png;base64," + String(repeating: "A", count: 4_000)
        XCTAssertEqual(MarkdownImagePolicy.verdict(for: small, sessionMediaRoot: nil), .allow)
        let rawBig = "DATA:text/plain," + String(repeating: "x", count: 1_100_000)
        XCTAssertEqual(MarkdownImagePolicy.verdict(for: rawBig, sessionMediaRoot: nil), .dataURITooLarge)
        XCTAssertEqual(MarkdownImagePolicy.estimatedDataURIBytes("data:image/png;base64,AAAA"), 3)
        XCTAssertEqual(MarkdownImagePolicy.estimatedDataURIBytes("data:text/plain,hello"), 5)
        XCTAssertEqual(MarkdownImagePolicy.verdict(for: "https://example.com/a.png", sessionMediaRoot: nil), .allow)
    }

    func testImage_fileURLOutsideSessionMediaIsRefused() throws {
        let base = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("r3-media-\(UUID().uuidString)", isDirectory: true)
        let root = base.appendingPathComponent("sid", isDirectory: true)
        try FileManager.default.createDirectory(at: root.appendingPathComponent("images"), withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: base) }
        let inside = root.appendingPathComponent("images/a.png").absoluteString
        XCTAssertEqual(MarkdownImagePolicy.verdict(for: inside, sessionMediaRoot: root), .allow)
        XCTAssertEqual(MarkdownImagePolicy.verdict(for: "file:///etc/passwd", sessionMediaRoot: root), .fileOutsideSessionMedia)
        let traversal = root.absoluteString + "images/../../other/a.png"
        XCTAssertEqual(MarkdownImagePolicy.verdict(for: traversal, sessionMediaRoot: root), .fileOutsideSessionMedia)
        let sibling = base.appendingPathComponent("sidx/a.png").absoluteString
        XCTAssertEqual(MarkdownImagePolicy.verdict(for: sibling, sessionMediaRoot: root), .fileOutsideSessionMedia)
        XCTAssertEqual(MarkdownImagePolicy.verdict(for: inside, sessionMediaRoot: nil), .fileOutsideSessionMedia)
    }
}
