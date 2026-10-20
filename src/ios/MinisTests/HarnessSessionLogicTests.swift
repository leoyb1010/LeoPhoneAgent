import XCTest

/// Mac 会话页的纯逻辑:diff 解析、改动面板数据、权限模式、正文合并、无会话时的排队。
final class HarnessSessionLogicTests: XCTestCase {
    func testUnifiedDiffNumbersLinesAndSkipsFileHeaders() {
        let diff = """
        diff --git a/a.txt b/a.txt
        index 1..2 100644
        --- a/a.txt
        +++ b/a.txt
        @@ -1,3 +1,4 @@
         keep
        -let x = 1
        +let x = 2
        +--- not a header
         tail
        \\ No newline at end of file
        @@ -10 +11,0 @@
        -gone
        """
        let lines = UnifiedDiff.parse(diff)
        XCTAssertEqual(lines.filter { $0.kind == .meta }.count, 4)
        let body = lines.filter { [.context, .added, .removed].contains($0.kind) }
        XCTAssertEqual(body.map(\.kind), [.context, .removed, .added, .added, .context, .removed])
        XCTAssertEqual(body[0].oldNumber, 1); XCTAssertEqual(body[0].newNumber, 1)
        XCTAssertEqual(body[1].oldNumber, 2); XCTAssertNil(body[1].newNumber)
        XCTAssertEqual(body[3].text, "--- not a header", "hunk 里以 --- 开头的新增行不是文件头")
        XCTAssertEqual(body[3].newNumber, 3)
        XCTAssertEqual(body[4].oldNumber, 3); XCTAssertEqual(body[4].newNumber, 4)
        XCTAssertEqual(body[5].oldNumber, 10)
        XCTAssertEqual(lines.filter { $0.kind == .noNewline }.count, 1)
        // 字内高亮:只标 1 → 2。
        XCTAssertEqual(body[1].highlight, 8..<9)
        XCTAssertEqual(body[2].highlight, 8..<9)
    }

    func testHunkHeaderAndIntraLineEdgeCases() {
        XCTAssertEqual(UnifiedDiff.hunkHeader("@@ -0,0 +1,3 @@ func"), [0, 0, 1, 3].tuple)
        XCTAssertEqual(UnifiedDiff.hunkHeader("@@ -5 +7 @@"), [5, 1, 7, 1].tuple)
        XCTAssertNil(UnifiedDiff.hunkHeader("@@ nope"))
        XCTAssertNil(UnifiedDiff.changedRanges(old: "abc", new: "xyz"), "整行都换了不标")
        XCTAssertNil(UnifiedDiff.changedRanges(old: "same", new: "same"))
        XCTAssertEqual(UnifiedDiff.changedRanges(old: "改了一个字的中文句子", new: "改了两个字的中文句子")?.0, 2..<3)
    }

    func testChangesParseSortsCheckpointsNewestFirst() {
        let changes = HarnessChanges.parse([
            "is_repo": true, "cwd": "/p", "branch": "main",
            "files": [["path": "a.swift", "status": "M", "additions": 3, "deletions": 1],
                      ["path": "b.swift", "status": "R", "additions": 0, "deletions": 0, "old_path": "old.swift"],
                      ["status": "A"]],
            "checkpoints": [["id": "c1", "turn": 1, "created_at": "2026-10-20T08:00:00Z", "label": "第一轮"],
                            ["id": "c2", "turn": 2, "created_at": "2026-10-20T08:05:00.123Z", "label": ""]],
        ])
        XCTAssertTrue(changes.isRepo)
        XCTAssertEqual(changes.files.map(\.path), ["a.swift", "b.swift"])
        XCTAssertEqual(changes.files[1].oldPath, "old.swift")
        XCTAssertEqual(changes.additions, 3)
        XCTAssertEqual(changes.checkpoints.map(\.id), ["c2", "c1"])
        XCTAssertNotNil(changes.checkpoints[0].createdAt)
        XCTAssertFalse(HarnessChanges.parse(["is_repo": false]).isRepo)
    }

    func testModeParsingAndFallback() {
        XCTAssertEqual(HarnessMode.parse("plan"), .plan)
        XCTAssertNil(HarnessMode.parse("weird"))
        XCTAssertNil(HarnessMode.parse(nil))
        XCTAssertEqual(HarnessMode.fallback(fullAutoOn: true), .yolo)
        XCTAssertEqual(HarnessMode.fallback(fullAutoOn: false), .guarded)
    }

    func testDeltaBufferMergesAndSignalsOneFlushPerBatch() {
        var buffer = TextDeltaBuffer()
        XCTAssertNil(buffer.take())
        XCTAssertTrue(buffer.append("Hel"))
        XCTAssertFalse(buffer.append("lo"))
        XCTAssertFalse(buffer.append(""))
        XCTAssertEqual(buffer.take(), "Hello")
        XCTAssertNil(buffer.take())
        XCTAssertTrue(buffer.append("!"), "冲刷后下一段又要排一次")
    }

    func testPendingTurnsNeverRunsTwoAtOnce() {
        var turns = PendingTurns()
        XCTAssertTrue(turns.submit("第一条"))
        XCTAssertFalse(turns.submit("第二条"))
        XCTAssertFalse(turns.submit("第三条"))
        XCTAssertEqual(turns.turnEnded(), "第二条")
        turns.begin()
        XCTAssertFalse(turns.submit("第四条"))
        XCTAssertEqual(turns.turnEnded(), "第三条")
        turns.begin()
        XCTAssertEqual(turns.cancel(), ["第四条"], "停止时排队的退回输入框")
        XCTAssertFalse(turns.busy)
        XCTAssertNil(turns.turnEnded())
        // 建会话成功:排队的全部交出去当后续消息。
        turns.begin()
        _ = turns.submit("a"); _ = turns.submit("b")
        XCTAssertEqual(turns.drain(), ["a", "b"])
        XCTAssertTrue(turns.submit("c"))
    }
}

private extension Array where Element == Int {
    var tuple: HunkTuple { HunkTuple(self[0], self[1], self[2], self[3]) }
}

private struct HunkTuple: Equatable {
    let a: Int, b: Int, c: Int, d: Int
    init(_ a: Int, _ b: Int, _ c: Int, _ d: Int) { self.a = a; self.b = b; self.c = c; self.d = d }
}

private func XCTAssertEqual(_ value: (Int, Int, Int, Int)?, _ expected: HunkTuple, file: StaticString = #filePath, line: UInt = #line) {
    guard let value else { return XCTFail("nil", file: file, line: line) }
    XCTAssertEqual(HunkTuple(value.0, value.1, value.2, value.3), expected, file: file, line: line)
}
