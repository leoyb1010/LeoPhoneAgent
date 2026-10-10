import XCTest

/// [T-r3-tool-arg-clamp] Plan §2.1 P0 #1–#4: extreme numbers in tool arguments
/// are clamped at the boundary — never `Int(1e300)`, never `total - Int.min`.
/// Arguments are decoded with JSONSerialization exactly as the tool dispatch
/// does, so the NSNumber shapes (double / int64 / unsigned / bool) are real.
final class ToolArgClampTests: XCTestCase {

    private func args(_ json: String, file: StaticString = #filePath, line: UInt = #line) -> [String: Any] {
        guard let obj = try? JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any] else {
            XCTFail("bad fixture JSON: \(json)", file: file, line: line)
            return [:]
        }
        return obj
    }

    // MARK: - shell_execute

    func testShellTimeoutHugeOrNegativeIsClamped() {
        let fallback: TimeInterval = 300
        XCTAssertEqual(ToolArgNumbers.shellTimeout(args(#"{"timeout":1e300}"#)["timeout"], default: fallback), 3600)
        XCTAssertEqual(ToolArgNumbers.shellTimeout(args(#"{"timeout":-1}"#)["timeout"], default: fallback), 1)
        XCTAssertEqual(ToolArgNumbers.shellTimeout(args(#"{"timeout":0}"#)["timeout"], default: fallback), 1)
        XCTAssertEqual(ToolArgNumbers.shellTimeout(args(#"{"timeout":-1e300}"#)["timeout"], default: fallback), 1)
        XCTAssertEqual(ToolArgNumbers.shellTimeout(args(#"{"timeout":9223372036854775807}"#)["timeout"], default: fallback), 3600)
        XCTAssertEqual(ToolArgNumbers.shellTimeout(args(#"{"timeout":120}"#)["timeout"], default: fallback), 120)
        XCTAssertEqual(ToolArgNumbers.shellTimeout(args(#"{"timeout":"abc"}"#)["timeout"], default: fallback), fallback)
        XCTAssertEqual(ToolArgNumbers.shellTimeout(args(#"{"timeout":true}"#)["timeout"], default: fallback), fallback)
        XCTAssertEqual(ToolArgNumbers.shellTimeout(nil, default: fallback), fallback)
        XCTAssertEqual(ToolArgNumbers.shellTimeout(Double.nan, default: fallback), fallback)
        XCTAssertEqual(ToolArgNumbers.shellTimeout(Double.infinity, default: fallback), fallback)
        // The value must survive the Int(...) the executor logs with.
        let t = ToolArgNumbers.shellTimeout(args(#"{"timeout":1e300}"#)["timeout"], default: fallback)
        XCTAssertEqual(Int(t), 3600)
    }

    func testShellDelayIsBoundedAndFinite() {
        XCTAssertEqual(ToolArgNumbers.shellDelay(args(#"{"delay":1e300}"#)["delay"]), 600)
        XCTAssertEqual(ToolArgNumbers.shellDelay(args(#"{"delay":1e18}"#)["delay"]), 600)
        XCTAssertEqual(ToolArgNumbers.shellDelay(args(#"{"delay":1e9}"#)["delay"]), 600, "1e9 s used to wait for decades")
        XCTAssertEqual(ToolArgNumbers.shellDelay(args(#"{"delay":-5}"#)["delay"]), 0)
        XCTAssertEqual(ToolArgNumbers.shellDelay(args(#"{"delay":2.5}"#)["delay"]), 2.5)
        XCTAssertEqual(ToolArgNumbers.shellDelay(nil), 0)
        // The countdown converts the delay to whole seconds — must not trap.
        let d = ToolArgNumbers.shellDelay(args(#"{"delay":1e300}"#)["delay"])
        XCTAssertEqual(ToolArgNumbers.int(d, clampedTo: 0...600), 600)
    }

    func testRemoteShellTimeoutIsClamped() {
        XCTAssertEqual(ToolArgNumbers.clampedInt(args(#"{"timeout":1e300}"#)["timeout"], to: ToolArgNumbers.remoteShellTimeoutRange), 600)
        XCTAssertEqual(ToolArgNumbers.clampedInt(args(#"{"timeout":9223372036854775807}"#)["timeout"], to: ToolArgNumbers.remoteShellTimeoutRange), 600)
        XCTAssertEqual(ToolArgNumbers.clampedInt(args(#"{"timeout":-3}"#)["timeout"], to: ToolArgNumbers.remoteShellTimeoutRange), 5)
        XCTAssertNil(ToolArgNumbers.clampedInt(args(#"{"timeout":"x"}"#)["timeout"], to: ToolArgNumbers.remoteShellTimeoutRange))
    }

    // MARK: - file_read

    func testFileReadPagingExtremeLinesDoesNotOverflow() {
        let lines = ["a", "b", "c", "d"]
        // lines: Int.max with offset 2 — `start + Int.max` used to overflow.
        let head = FileReadPaging.page(allLines: lines, offset: 2, requestedLines: Int.max, maxLength: 1000, direction: "head")
        XCTAssertEqual(head.content, "b\nc\nd")
        XCTAssertEqual(head.showStart, 2)
        XCTAssertNil(head.nextOffset)
        // lines: Int.min in tail mode — `total - Int.min` used to overflow.
        let tail = FileReadPaging.page(allLines: lines, offset: 1, requestedLines: Int.min, maxLength: 1000, direction: "tail")
        XCTAssertEqual(tail.content, "")
        let tailMax = FileReadPaging.page(allLines: lines, offset: 1, requestedLines: Int.max, maxLength: 1000, direction: "tail")
        XCTAssertEqual(tailMax.content, "a\nb\nc\nd")
        // Offset at the extremes.
        let past = FileReadPaging.page(allLines: lines, offset: Int.max, requestedLines: 2, maxLength: 1000, direction: "head")
        XCTAssertEqual(past.content, "")
        let before = FileReadPaging.page(allLines: lines, offset: Int.min, requestedLines: Int.max, maxLength: Int.min, direction: "head")
        XCTAssertEqual(before.content, "a", "max_length clamps to at least one character per page")
        // Normal paging is unchanged.
        let normal = FileReadPaging.page(allLines: lines, offset: 2, requestedLines: 2, maxLength: 1000, direction: "head")
        XCTAssertEqual(normal.content, "b\nc")
        XCTAssertEqual(normal.nextOffset, 4)
    }

    func testFileReadArgumentsFromJSONAreClamped() {
        let a = args(#"{"lines":9223372036854775807,"offset":1e300,"max_length":-9223372036854775808}"#)
        XCTAssertEqual(ToolArgNumbers.clampedInt(a["lines"], to: ToolArgNumbers.fileReadLinesRange), ToolArgNumbers.fileReadLinesRange.upperBound)
        XCTAssertEqual(ToolArgNumbers.clampedInt(a["offset"], to: ToolArgNumbers.fileReadOffsetRange), ToolArgNumbers.fileReadOffsetRange.upperBound)
        XCTAssertEqual(ToolArgNumbers.clampedInt(a["max_length"], to: ToolArgNumbers.fileReadMaxLengthRange), 1)
        XCTAssertEqual(FileReadPaging.intValue(a, "lines"), Int.max)
        XCTAssertEqual(FileReadPaging.intValue(args(#"{"lines":1e300}"#), "lines"), Int.max, "no trap on a huge double")
    }

    // MARK: - Generic conversions

    func testClampedIntHandlesEveryNumberShape() {
        XCTAssertEqual(ToolArgNumbers.clampedInt(args(#"{"v":18446744073709551615}"#)["v"], to: 0...10), 10, "unsigned 64-bit max")
        XCTAssertEqual(ToolArgNumbers.clampedInt(args(#"{"v":-9223372036854775808}"#)["v"], to: -5...5), -5)
        XCTAssertEqual(ToolArgNumbers.clampedInt(args(#"{"v":1e30}"#)["v"], to: 0...10), 10)
        XCTAssertEqual(ToolArgNumbers.clampedInt(args(#"{"v":3.9}"#)["v"], to: 0...10), 3)
        XCTAssertEqual(ToolArgNumbers.clampedInt(args(#"{"v":"7"}"#)["v"], to: 0...10), 7)
        XCTAssertNil(ToolArgNumbers.clampedInt(args(#"{"v":false}"#)["v"], to: 0...10))
        XCTAssertNil(ToolArgNumbers.clampedInt(args(#"{"v":null}"#)["v"], to: 0...10))
        XCTAssertEqual(ToolArgNumbers.clampedInt(Int.max, to: 0...10), 10)
    }

    func testSaturatingIntNeverTraps() {
        XCTAssertEqual(ToolArgNumbers.saturatingInt(.infinity), Int.max - 1024)
        XCTAssertEqual(ToolArgNumbers.saturatingInt(-.infinity), Int.min)
        XCTAssertEqual(ToolArgNumbers.saturatingInt(.nan), Int.min)
        XCTAssertEqual(ToolArgNumbers.saturatingInt(1e300), Int.max - 1024)
        XCTAssertEqual(ToolArgNumbers.saturatingInt(42.7), 42)
    }

    func testViewportIsClamped() {
        let a = args(#"{"viewport_width":100000,"viewport_height":1e300}"#)
        XCTAssertEqual(ToolArgNumbers.clampedInt(a["viewport_width"], to: ToolArgNumbers.viewportWidthRange), 4096)
        XCTAssertEqual(ToolArgNumbers.clampedInt(a["viewport_height"], to: ToolArgNumbers.viewportHeightRange), 8192)
        XCTAssertEqual(ToolArgNumbers.clampedInt(args(#"{"w":-1}"#)["w"], to: ToolArgNumbers.viewportWidthRange), 1)
    }

    // MARK: - Paths, commands, labels

    func testControlCharactersInPathsAreRejected() {
        XCTAssertNil(ToolInputGuard.pathRejection("/var/minis/workspace/a b.txt"))
        XCTAssertNil(ToolInputGuard.pathRejection("/var/minis/workspace/报告.md"))
        XCTAssertNotNil(ToolInputGuard.pathRejection("/var/minis/workspace/a\u{0}b"))
        XCTAssertNotNil(ToolInputGuard.pathRejection("/var/minis/workspace/a\nb"))
        XCTAssertNotNil(ToolInputGuard.pathRejection("/var/minis/\u{1B}[2Jx"))
        XCTAssertNotNil(ToolInputGuard.pathRejection("/var/minis/\u{7F}"))
    }

    func testPathsAreNFCNormalised() {
        let nfd = "/var/minis/workspace/Cafe\u{301}.txt"
        let nfc = "/var/minis/workspace/Caf\u{E9}.txt"
        XCTAssertNotEqual(Array(nfd.utf8), Array(nfc.utf8))
        XCTAssertEqual(Array(ToolInputGuard.normalizedPath(nfd).utf8), Array(nfc.utf8))
        XCTAssertEqual(ToolInputGuard.normalizedPath(nfc), nfc)
    }

    func testNulInShellCommandIsRejected() {
        XCTAssertNil(ToolInputGuard.commandRejection("ls -la /var/minis"))
        XCTAssertNotNil(ToolInputGuard.commandRejection("rm -rf /tmp/safe\u{0} /"))
    }

    func testSingleLineLabelCapsLength() {
        let label = ToolInputGuard.singleLineLabel("a\nb\r\n\tc" + String(repeating: "x", count: 300), maxCharacters: 120)
        XCTAssertEqual(label.count, 120)
        XCTAssertTrue(label.hasPrefix("a b c"))
        XCTAssertFalse(label.contains("\n"))
        XCTAssertEqual(ToolInputGuard.singleLineLabel("  short  ", maxCharacters: 120), "short")
    }

    // MARK: - browser_use navigation

    func testBrowserNavigationPolicy() {
        func rejection(_ s: String, allowed: Set<String> = []) -> String? {
            BrowserNavigationPolicy.rejection(for: URL(string: s)!, userAllowedHosts: allowed)
        }
        XCTAssertNil(rejection("https://example.com/"))
        XCTAssertNil(rejection("http://localhost:8765/"), "servers started inside the iSH sandbox stay reachable")
        XCTAssertNil(rejection("http://127.0.0.1:8000/index.html"))
        XCTAssertNil(rejection("http://[::1]:8000/"))
        XCTAssertNotNil(rejection("http://169.254.169.254/latest/meta-data/"))
        XCTAssertNotNil(rejection("http://192.168.1.1/admin"))
        XCTAssertNotNil(rejection("http://10.0.0.8/"))
        XCTAssertNotNil(rejection("http://[fe80::1]/"))
        XCTAssertNotNil(rejection("http://printer.local/"))
        XCTAssertNotNil(rejection("http://0x0a000001/"), "odd IPv4 spellings are normalised")
        XCTAssertNil(rejection("http://100.101.102.103/", allowed: ["100.101.102.103"]),
                     "a host the user configured as a remote machine is allowed")
        XCTAssertNil(rejection("leophoneagent://webapp/index.html"), "the app's own scheme is gated elsewhere")
    }
}
