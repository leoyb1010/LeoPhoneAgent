import XCTest

/// [S1] AppLogger lines go to the writer queue through `LogLinePipeline`; the
/// caller never waits on formatting, redaction or file I/O, and a single chatty
/// category cannot flood the log.
final class LoggingPipelineTests: XCTestCase {
    private final class Sink: @unchecked Sendable {
        private let lock = NSLock()
        private var _lines: [String] = []
        var delay: TimeInterval = 0
        func write(_ line: String) {
            if delay > 0 { Thread.sleep(forTimeInterval: delay) }
            lock.lock(); _lines.append(line); lock.unlock()
        }
        var lines: [String] { lock.lock(); defer { lock.unlock() }; return _lines }
    }

    func testBurstOf1000LinesNeverBlocksCaller() {
        let sink = Sink()
        sink.delay = 0.002   // a slow disk: 1000 lines would take >= 2 s to write
        let queue = DispatchQueue(label: "test.log.writer")
        let pipeline = LogLinePipeline(queue: queue, ratePerSecond: 1_000_000, burst: 1_000_000) { sink.write($0) }

        var worst: TimeInterval = 0
        let start = CFAbsoluteTimeGetCurrent()
        for i in 0..<1000 {
            let t0 = CFAbsoluteTimeGetCurrent()
            pipeline.submit(category: "Burst", level: "INFO", message: "line \(i)")
            worst = max(worst, CFAbsoluteTimeGetCurrent() - t0)
        }
        let total = CFAbsoluteTimeGetCurrent() - start
        XCTAssertLessThan(worst, 0.005, "a single log call must never wait for the writer")
        XCTAssertLessThan(total, 0.5, "1000 calls must return long before the 2 s the writer needs")
        queue.sync {}
        XCTAssertEqual(sink.lines.count, 1000)
        XCTAssertTrue(sink.lines[0].hasSuffix("[Burst] [INFO] line 0\n"))
    }

    func testTokenBucketSuppressesFloodAndEmitsOneSummary() {
        let sink = Sink()
        let queue = DispatchQueue(label: "test.log.bucket")
        var clock = Date(timeIntervalSince1970: 1_000)
        let pipeline = LogLinePipeline(queue: queue, ratePerSecond: 50, burst: 100,
                                       summaryDelay: 3600, now: { clock }) { sink.write($0) }
        var accepted = 0
        for i in 0..<1000 {
            if pipeline.submit(category: "FPWatcher", level: "WARN", message: "skip \(i)") { accepted += 1 }
        }
        XCTAssertEqual(accepted, 100, "burst of 100, then suppressed")
        // Another category keeps its own budget.
        XCTAssertTrue(pipeline.submit(category: "Lifecycle", level: "INFO", message: "→ Active"))
        // Errors are never rate-limited.
        XCTAssertTrue(pipeline.submit(category: "FPWatcher", level: "ERROR", message: "real problem"))

        queue.sync { pipeline.flushSummaries() }
        let summaries = sink.lines.filter { $0.contains("suppressed") }
        XCTAssertEqual(summaries.count, 1)
        XCTAssertTrue(summaries[0].contains("[FPWatcher] [WARN] suppressed 900 lines"))

        // After a second the bucket refills by 50; nothing left to summarize.
        clock = clock.addingTimeInterval(1)
        XCTAssertTrue(pipeline.submit(category: "FPWatcher", level: "INFO", message: "later"))
        queue.sync { pipeline.flushSummaries() }
        XCTAssertEqual(sink.lines.filter { $0.contains("suppressed") }.count, 1)
        XCTAssertEqual(sink.lines.count, 100 + 1 + 1 + 1 + 1)
    }

    func testSummaryPrecedesNextAdmittedLineWhenNotFlushedYet() {
        var limiter = LogRateLimiter(ratePerSecond: 1, burst: 1)
        let t = Date(timeIntervalSince1970: 0)
        XCTAssertEqual(limiter.admit(category: "c", at: t), .emit(suppressedBefore: 0))
        XCTAssertEqual(limiter.admit(category: "c", at: t), .suppress)
        XCTAssertEqual(limiter.admit(category: "c", at: t), .suppress)
        XCTAssertEqual(limiter.admit(category: "c", at: t.addingTimeInterval(1)), .emit(suppressedBefore: 2))
        XCTAssertTrue(limiter.drainSuppressed().isEmpty)
    }

    func testDisabledPipelineDropsWithoutQueueing() {
        let sink = Sink()
        let queue = DispatchQueue(label: "test.log.disabled")
        let pipeline = LogLinePipeline(queue: queue) { sink.write($0) }
        pipeline.isEnabled = false
        XCTAssertFalse(pipeline.submit(category: "x", level: "INFO", message: "y"))
        queue.sync {}
        XCTAssertTrue(sink.lines.isEmpty)
    }

    func testAppLoggerRoutesThroughPipelineAndNSLogIsDebugOnly() throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
        let logger = try String(contentsOf: root.appendingPathComponent("Shared/AppLogger.swift"), encoding: .utf8)
        guard let emit = logger.range(of: "private func emit(") else { return XCTFail("emit not found") }
        let body = String(logger[emit.lowerBound...].prefix(1200))
        XCTAssertTrue(body.contains("LoggingManager.linePipeline"))
        XCTAssertFalse(body.contains("Date().formatted"), "no per-line formatter construction")
        let nslog = try XCTUnwrap(body.range(of: "NSLog("))
        let debugGate = try XCTUnwrap(body.range(of: "#if DEBUG"))
        XCTAssertLessThan(debugGate.lowerBound, nslog.lowerBound, "NSLog only inside #if DEBUG")
        let manager = try String(contentsOf: root.appendingPathComponent("Shared/LoggingManager.swift"), encoding: .utf8)
        XCTAssertTrue(manager.contains("thread.qualityOfService = .userInitiated"))
        XCTAssertTrue(manager.contains("EnvVarRedactor.redactForLocalLog(line)"), "pipeline lines are redacted like stderr")
    }
}
