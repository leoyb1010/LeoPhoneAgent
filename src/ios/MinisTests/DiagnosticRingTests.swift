import XCTest

/// [B1] 常开诊断日志:写入、按日轮转、超限截断、7 天清理。
final class DiagnosticRingTests: XCTestCase {
    private var dir: URL!

    override func setUpWithError() throws {
        dir = FileManager.default.temporaryDirectory.appendingPathComponent("diag-\(UUID().uuidString)")
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: dir)
    }

    private func lines(_ ring: DiagnosticRing, _ date: Date) throws -> [DiagnosticRing.Event] {
        let text = try String(contentsOf: ring.fileURL(for: date), encoding: .utf8)
        return try text.split(separator: "\n").map { try JSONDecoder().decode(DiagnosticRing.Event.self, from: Data($0.utf8)) }
    }

    func testWritesStructuredLineWithoutBodyAndTruncatesFields() throws {
        let now = Date()
        let ring = DiagnosticRing(directory: dir, now: { now })
        ring.record(.llmError, sessionId: "0123456789abcdef", model: "gpt", entryId: "e1", attempt: 2,
                    error: URLError(.networkConnectionLost), message: String(repeating: "长", count: 500), durationMs: 12)
        ring.flush()
        let events = try lines(ring, now)
        XCTAssertEqual(events.count, 1)
        let event = try XCTUnwrap(events.first)
        XCTAssertEqual(event.kind, "llm.error")
        XCTAssertEqual(event.sessionId, "01234567")
        XCTAssertEqual(event.errorDomain, NSURLErrorDomain)
        XCTAssertEqual(event.errorCode, NSURLErrorNetworkConnectionLost)
        XCTAssertEqual(event.message?.count, 200)
        XCTAssertEqual(event.attempt, 2)
        XCTAssertTrue(ring.fileURL(for: now).lastPathComponent.hasPrefix("diag-"))
    }

    func testRotatesByDay() throws {
        let day1 = Date(timeIntervalSince1970: 1_790_000_000)
        let day2 = day1.addingTimeInterval(86_400)
        final class Clock: @unchecked Sendable { var now: Date; init(_ d: Date) { now = d } }
        let clock = Clock(day1)
        let ring = DiagnosticRing(directory: dir, now: { clock.now })
        ring.record(.llmRequest); ring.flush()
        clock.now = day2
        ring.record(.llmRetry); ring.flush()
        XCTAssertNotEqual(ring.fileURL(for: day1), ring.fileURL(for: day2))
        XCTAssertEqual(try lines(ring, day1).map(\.kind), ["llm.request"])
        XCTAssertEqual(try lines(ring, day2).map(\.kind), ["llm.retry"])
    }

    func testDailyCapWritesOneMarkerThenDrops() throws {
        let now = Date()
        let ring = DiagnosticRing(directory: dir, maxBytesPerDay: 600, now: { now })
        for _ in 0..<30 { ring.record(.llmRequest, model: "model-name") }
        ring.flush()
        let events = try lines(ring, now)
        XCTAssertEqual(events.filter { $0.kind == "diag.truncated" }.count, 1)
        XCTAssertEqual(events.last?.kind, "diag.truncated")
        XCTAssertLessThan(events.count, 30)
    }

    func testPurgesFilesOlderThanSevenDays() throws {
        let now = Date()
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let old = now.addingTimeInterval(-8 * 86_400)
        let recent = now.addingTimeInterval(-3 * 86_400)
        let ring = DiagnosticRing(directory: dir, now: { now })
        for date in [old, recent] { try Data("{}\n".utf8).write(to: ring.fileURL(for: date)) }
        let unrelated = dir.appendingPathComponent("other.log")
        try Data().write(to: unrelated)
        ring.record(.llmRequest); ring.flush()
        XCTAssertFalse(FileManager.default.fileExists(atPath: ring.fileURL(for: old).path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: ring.fileURL(for: recent).path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: unrelated.path))
    }
}
