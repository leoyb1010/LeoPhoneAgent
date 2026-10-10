import XCTest

/// [V-rec] 转写合并、时间轴、说话人标注与改名。
final class TranscriptAssemblerTests: XCTestCase {

    private func chunk(_ index: Int, start: Double, seconds: Double) -> RecordingChunk {
        RecordingChunk(index: index, fileName: RecordingChunk.fileName(forIndex: index), startOffset: start,
                       sampleRate: 16_000, frameCount: Int64(seconds * 16_000), isOpen: false)
    }

    // MARK: - Plan

    func testPlanSplitsLongChunksIntoTenMinuteWindows() {
        let chunks = [chunk(0, start: 0, seconds: 600), chunk(1, start: 600, seconds: 1_500)]
        let units = TranscriptionPlan.units(for: chunks)
        XCTAssertEqual(units.map(\.id), [0, 1000, 1001, 1002])
        XCTAssertEqual(units.map(\.globalStart), [0, 600, 1_200, 1_800])
        XCTAssertEqual(units.map(\.localStart), [0, 0, 600, 1_200])
        XCTAssertEqual(units.last?.duration ?? 0, 300, accuracy: 0.001)
        XCTAssertEqual(units.reduce(0) { $0 + $1.duration }, 2_100, accuracy: 0.001)
        XCTAssertEqual(TranscriptionPlan.pending(units, completed: [0, 1001]).map(\.id), [1000, 1002])
    }

    func testPlanSkipsEmptyChunksAndSortsByIndex() {
        let chunks = [chunk(2, start: 20, seconds: 5), chunk(0, start: 0, seconds: 0), chunk(1, start: 0, seconds: 20)]
        XCTAssertEqual(TranscriptionPlan.units(for: chunks).map(\.chunkIndex), [1, 2])
    }

    // MARK: - Merge

    func testMergeShiftsToGlobalTimeAndSorts() {
        let units = TranscriptionPlan.units(for: [chunk(0, start: 0, seconds: 600), chunk(1, start: 600, seconds: 100)])
        var segs = TranscriptAssembler.merge(existing: [], unit: units[1], local: [
            .init(start: 5, end: 8, text: "第二块"),
        ])
        segs = TranscriptAssembler.merge(existing: segs, unit: units[0], local: [
            .init(start: 1, end: 2, text: "开场"),
            .init(start: 3, end: 4, text: "  "),          // blank dropped
            .init(start: 590, end: 700, text: "跨界"),     // clamped into the unit
        ])
        XCTAssertEqual(segs.map(\.text), ["开场", "跨界", "第二块"])
        XCTAssertEqual(segs[0].start, 1)
        XCTAssertEqual(segs[1].end, 600, "end clamped to the unit boundary")
        XCTAssertEqual(segs[2].start, 605)
        XCTAssertEqual(segs[2].unit, 1000)
    }

    func testMergeReplacesAUnitsOldSegments() {
        let unit = TranscriptionPlan.units(for: [chunk(0, start: 0, seconds: 60)])[0]
        let first = TranscriptAssembler.merge(existing: [], unit: unit, local: [.init(start: 0, end: 1, text: "旧")])
        let second = TranscriptAssembler.merge(existing: first, unit: unit, local: [.init(start: 0, end: 1, text: "新")])
        XCTAssertEqual(second.map(\.text), ["新"])
    }

    func testMergeSurvivesNonFiniteTimes() {
        let unit = TranscriptionPlan.units(for: [chunk(0, start: 10, seconds: 60)])[0]
        let segs = TranscriptAssembler.merge(existing: [], unit: unit, local: [.init(start: .nan, end: .infinity, text: "x")])
        XCTAssertEqual(segs.count, 1)
        XCTAssertTrue(segs[0].start.isFinite && segs[0].end.isFinite)
        XCTAssertGreaterThanOrEqual(segs[0].start, 10)
        XCTAssertLessThanOrEqual(segs[0].end, 70)
    }

    func testApproximateSegmentsDistributeByLength() {
        let local = TranscriptAssembler.approximateSegments(text: "第一句话。第二句稍微长一些的话！好", duration: 30)
        XCTAssertEqual(local.map(\.text), ["第一句话。", "第二句稍微长一些的话！", "好"])
        XCTAssertEqual(local.first?.start, 0)
        XCTAssertEqual(local.last?.end ?? 0, 30, accuracy: 0.0001)
        for (a, b) in zip(local, local.dropFirst()) { XCTAssertEqual(a.end, b.start, accuracy: 0.0001) }
    }

    // MARK: - Paragraphs & rendering

    func testParagraphsJoinSameSpeakerCloseSegments() {
        let segs = [
            TranscriptSegment(start: 0, end: 2, text: "大家好", speaker: 1, unit: 0),
            TranscriptSegment(start: 2.5, end: 4, text: "开始吧", speaker: 1, unit: 0),
            TranscriptSegment(start: 4.2, end: 6, text: "好的", speaker: 2, unit: 0),
            TranscriptSegment(start: 30, end: 31, text: "补充一点", speaker: 2, unit: 0),
        ]
        let p = TranscriptAssembler.paragraphs(segs)
        XCTAssertEqual(p.map(\.text), ["大家好开始吧", "好的", "补充一点"])
        XCTAssertEqual(p.map(\.firstSegment), [0, 2, 3])
    }

    func testLatinSegmentsGetASpace() {
        let segs = [TranscriptSegment(start: 0, end: 1, text: "hello", unit: 0),
                    TranscriptSegment(start: 1, end: 2, text: "world", unit: 0)]
        XCTAssertEqual(TranscriptAssembler.paragraphs(segs).first?.text, "hello world")
    }

    func testTimestampFormat() {
        XCTAssertEqual(TranscriptAssembler.timestamp(0), "00:00")
        XCTAssertEqual(TranscriptAssembler.timestamp(75.9), "01:15")
        XCTAssertEqual(TranscriptAssembler.timestamp(3_723), "1:02:03")
        XCTAssertEqual(TranscriptAssembler.timestamp(-4), "00:00")
        XCTAssertEqual(TranscriptAssembler.timestamp(.nan), "00:00")
    }

    func testRenderMarkdownMarksInferredSpeakersAndUsesNames() {
        let segs = [TranscriptSegment(start: 0, end: 1, text: "我们开始", speaker: 1, unit: 0),
                    TranscriptSegment(start: 61, end: 62, text: "收到", speaker: 2, approximate: true, unit: 0)]
        let md = TranscriptAssembler.renderMarkdown(title: "周会", date: Date(timeIntervalSince1970: 0), duration: 62,
                                                    segments: segs, names: ["1": "张三"], speakersInferred: true,
                                                    highlights: [RecordingHighlight(id: "h", time: 61, note: nil)])
        XCTAssertTrue(md.hasPrefix("# 周会"))
        XCTAssertTrue(md.contains("[00:00] **张三** 我们开始"))
        XCTAssertTrue(md.contains("[01:01] **说话人 2** 收到"))
        XCTAssertTrue(md.contains("推断"))
        XCTAssertTrue(md.contains("估算"))
        XCTAssertTrue(md.contains("[01:01]"))
    }

    // MARK: - Speakers

    func testSpeakerAssignmentsInheritAndClamp() {
        let segs = (0..<5).map { TranscriptSegment(start: Double($0), end: Double($0) + 1, text: "s\($0)", unit: 0) }
        let out = TranscriptAssembler.applySpeakerAssignments(segs, assignments: [1: 1, 3: 2, 5: 99])
        XCTAssertEqual(out.map(\.speaker), [1, 1, 2, 2, 12])
        XCTAssertEqual(TranscriptAssembler.speakers(in: out), [1, 2, 12])
    }

    func testParseSpeakerAssignmentsAcceptsCommonShapes() {
        let reply = """
        好的,标注如下:
        1:1
        2：说话人2
        3 -> 1
        [4] 2
        5 → speaker 3
        999:1
        x:2
        """
        let parsed = TranscriptAssembler.parseSpeakerAssignments(reply, validLines: 1...5)
        XCTAssertEqual(parsed, [1: 1, 2: 2, 3: 1, 4: 2, 5: 3], "out-of-range and junk lines ignored")
    }

    func testParseSpeakerAssignmentsAcceptsJSON() {
        let parsed = TranscriptAssembler.parseSpeakerAssignments(#"结果:{"1": 1, "2": "2", "7": 3}"#, validLines: 1...3)
        XCTAssertEqual(parsed, [1: 1, 2: 2])
    }

    func testRenameSpeaker() {
        var names = TranscriptAssembler.renameSpeaker([:], speaker: 1, to: "  张三\n经理 ")
        XCTAssertEqual(names["1"], "张三 经理")
        XCTAssertEqual(TranscriptAssembler.speakerLabel(1, names: names), "张三 经理")
        XCTAssertEqual(TranscriptAssembler.speakerLabel(2, names: names), "说话人 2")
        names = TranscriptAssembler.renameSpeaker(names, speaker: 1, to: String(repeating: "长", count: 50))
        XCTAssertEqual(names["1"]?.count, 20)
        names = TranscriptAssembler.renameSpeaker(names, speaker: 1, to: "   ")
        XCTAssertNil(names["1"], "empty name restores the default label")
    }

    func testNumberedLinesUseGlobalLineNumbers() {
        let segs = (0..<4).map { TranscriptSegment(start: Double($0 * 60), end: 0, text: "t\($0)", unit: 0) }
        XCTAssertEqual(TranscriptAssembler.numberedLines(segs, range: 2..<10), ["3 [02:00] t2", "4 [03:00] t3"])
    }
}
