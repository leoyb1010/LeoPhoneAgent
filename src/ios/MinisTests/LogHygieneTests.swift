import XCTest

/// 日志隐私与降噪(审计:真机 4 天日志 + perf.jsonl)。
/// 纯逻辑(`LogContentDigest`、`RepeatedLogSummarizer`、`StderrBurstFilter`、`IgnoredFilePathNoise`)直接测;
/// 逻辑测试 target 编不进的文件(StreamingHangLogger、LoggingManager、SessionFileChangeTracker、
/// AgentLiveActivityManager、ChatStoreSyncHydrators、LeoPerf)用读源码的方式钉住接线。
final class LogHygieneTests: XCTestCase {
    private func source(_ relative: String) throws -> String {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
        return try String(contentsOf: root.appendingPathComponent(relative), encoding: .utf8)
    }

    /// 去掉 `#if DEBUG … #else` 之前的行,只留 Release 编译时看得见的源码。
    /// 只认 `#if DEBUG` / `#else` / `#endif` 三种指令(StreamingHangLogger 里没有别的条件编译)。
    private func releaseVisibleSource(_ text: String) -> String {
        var stack: [Bool] = []   // 每层:当前是否处在「只有 DEBUG 才编译」的分支
        var kept: [Substring] = []
        for line in text.split(separator: "\n", omittingEmptySubsequences: false) {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed == "#if DEBUG" { stack.append(true); continue }
            if trimmed == "#else", !stack.isEmpty { stack[stack.count - 1] = false; continue }
            if trimmed == "#endif", !stack.isEmpty { stack.removeLast(); continue }
            if !stack.contains(true) { kept.append(line) }
        }
        return kept.joined(separator: "\n")
    }

    // MARK: - LogContentDigest

    func testDigestKnownVector() {
        let d = LogContentDigest("abc")
        XCTAssertEqual(d.sha8, "ba7816bf", "SHA-256(\"abc\") = ba7816bf 8f01cfea …")
        XCTAssertEqual(d.length, 3)
        XCTAssertEqual(d.lines, 1)
        XCTAssertEqual(d.fields, "len=3 lines=1 sha256=ba7816bf")
        XCTAssertEqual(LogContentDigest("").sha8, "e3b0c442", "SHA-256 of the empty string")
    }

    func testDigestLineCounting() {
        XCTAssertEqual(LogContentDigest("").lines, 0)
        XCTAssertEqual(LogContentDigest("a").lines, 1)
        XCTAssertEqual(LogContentDigest("a\n").lines, 1, "a trailing newline does not start another line")
        XCTAssertEqual(LogContentDigest("a\nb").lines, 2)
        XCTAssertEqual(LogContentDigest("\n").lines, 1)
        XCTAssertEqual(LogContentDigest("a\r\nb\r\n").lines, 2)
        XCTAssertEqual(LogContentDigest("a\n\n\nb").lines, 4)
    }

    func testDigestCountsCharactersNotBytes() {
        XCTAssertEqual(LogContentDigest("你好👨‍👩‍👧").length, 3, "two CJK characters + one family emoji grapheme")
    }

    func testDigestFieldsNeverContainTheOriginalText() {
        let secret = "sk-THIS-IS-A-SECRET assistant reply body\nsecond line"
        let fields = LogContentDigest(secret).fields
        for fragment in ["SECRET", "assistant", "reply", "second", "sk-"] {
            XCTAssertFalse(fields.contains(fragment), "digest must not leak '\(fragment)'")
        }
        XCTAssertEqual(LogContentDigest(secret).sha8.count, 8)
        XCTAssertNotNil(UInt32(LogContentDigest(secret).sha8, radix: 16), "lowercase hex only")
    }

    func testDigestIsStableAndSensitiveToChanges() {
        XCTAssertEqual(LogContentDigest("same text").sha8, LogContentDigest("same text").sha8)
        XCTAssertNotEqual(LogContentDigest("same text").sha8, LogContentDigest("same texT").sha8)
    }

    // MARK: - StreamingHangLogger: Release 绝不写原文

    func testStreamingHangLoggerNeverFormatsRawTextIntoReleaseLogs() throws {
        let text = try source("Debug/StreamingHangLogger.swift")
        let release = releaseVisibleSource(text)
        // 这些字样是把原文拼进日志行的格式串;Release 可见的源码里一个都不许出现。
        for needle in ["slice=", "tail=", "head=", "escapeForLog", "sample.tail", "sample.head", "│"] {
            XCTAssertFalse(release.contains(needle), "Release-visible source must not contain '\(needle)'")
        }
        XCTAssertTrue(release.contains("LogContentDigest(sample.markdown)"), "assigned text is dumped as a digest")
        XCTAssertTrue(release.contains("sample.digest.fields"), "streaming flushes are dumped as a digest")
        // 完整分片转储仍在 DEBUG 里(本机调试要用)。
        XCTAssertTrue(text.contains("slice=\\(sliceIdx)"))
        XCTAssertTrue(text.contains("#if DEBUG"))
    }

    func testStreamingHangLoggerKeepsRawTextOutOfReleaseMemoryPaths() throws {
        let release = releaseVisibleSource(try source("Debug/StreamingHangLogger.swift"))
        // Release 下 recordStreamingFlush 不在主线程取尾巴:`tail` 恒为空串,哈希在后台队列算。
        XCTAssertTrue(release.contains("let tail = \"\""))
        XCTAssertTrue(release.contains("digest: LogContentDigest(text)"))
        XCTAssertTrue(release.contains("LeoPerf.noteStreamingFlush()"))
    }

    // MARK: - RepeatedLogSummarizer

    func testFirstOccurrencePerKeyIsLoggedOnceAndTheRestAreCounted() {
        var s = RepeatedLogSummarizer(summaryEvery: 500, maxFirstLines: 20)
        XCTAssertTrue(s.note("a").isFirst)
        XCTAssertFalse(s.note("a").isFirst)
        XCTAssertTrue(s.note("b").isFirst)
        XCTAssertFalse(s.note("a").isFirst)
        XCTAssertEqual(s.pendingCount, 2)
    }

    func testSummaryComesEveryNSuppressedAndDrainFlushesTheRest() {
        var s = RepeatedLogSummarizer(summaryEvery: 3, maxFirstLines: 20)
        XCTAssertTrue(s.note("a").isFirst)
        XCTAssertNil(s.note("a").summary)
        XCTAssertNil(s.note("a").summary)
        let third = s.note("a").summary
        XCTAssertEqual(third?.suppressed, 3)
        XCTAssertEqual(third?.distinct, 1)
        XCTAssertEqual(third?.top, [RepeatedLogSummarizer.Summary.Entry(key: "a", count: 3)])
        XCTAssertEqual(s.pendingCount, 0, "a summary resets the pending counters")
        _ = s.note("a")
        let rest = s.drain()
        XCTAssertEqual(rest?.suppressed, 1)
        XCTAssertNil(s.drain(), "nothing pending → nothing to say")
    }

    func testTopEntriesAreOrderedByCountThenKeyAndLimitedToThree() {
        var s = RepeatedLogSummarizer(summaryEvery: 1_000, maxFirstLines: 20)
        for key in ["a", "b", "c", "d"] { XCTAssertTrue(s.note(key).isFirst) }
        for _ in 0..<2 { _ = s.note("c") }
        for _ in 0..<2 { _ = s.note("b") }
        _ = s.note("d")
        _ = s.note("a")
        let summary = s.drain()
        XCTAssertEqual(summary?.top.map(\.key), ["b", "c", "a"], "ties break by key; only three are shown")
        XCTAssertEqual(summary?.distinct, 4)
        XCTAssertEqual(summary?.text, "+6 repeats across 4 id(s): b×2, c×2, a×1, …")
    }

    func testDistinctFirstLinesAreCapped() {
        var s = RepeatedLogSummarizer(summaryEvery: 500, maxFirstLines: 2)
        XCTAssertTrue(s.note("a").isFirst)
        XCTAssertTrue(s.note("b").isFirst)
        XCTAssertFalse(s.note("c").isFirst, "a whole deleted provider must not print a first line per model every launch")
        XCTAssertEqual(s.pendingCount, 1)
    }

    func testTheAuditedFloodBecomesAHandfulOfLines() {
        // 真机:同一个已删除条目 4 天里 5,774 次 SKIP。
        var s = RepeatedLogSummarizer(summaryEvery: 500, maxFirstLines: 20)
        var logged = 0
        for _ in 0..<5_774 {
            let note = s.note("mergeProviderModelEntryV3:abcdef0123456789")
            if note.isFirst { logged += 1 }
            if note.summary != nil { logged += 1 }
        }
        if s.drain() != nil { logged += 1 }
        XCTAssertEqual(logged, 1 + 11 + 1, "one first line, 11 full summaries, one closing summary")
    }

    // MARK: - StderrBurstFilter

    private let nsLogPrefix = "2026-10-14 12:00:00.123456+0800 LeoPhoneAgent[1234:5a6b] "

    func testKernelBootBurstIsCappedAndSummarisedOnTheNextLine() {
        var f = StderrBurstFilter(ratePerSecond: 10, burst: 50, maxFamilies: 64)
        let t0 = Date(timeIntervalSince1970: 1_000)
        var written = 0, dropped = 0
        for i in 0..<250 {
            switch f.verdict(for: Substring("\(nsLogPrefix)ISHKernel: boot step \(i)"), at: t0) {
            case .write: written += 1
            case .drop: dropped += 1
            }
        }
        XCTAssertEqual(written, 50)
        XCTAssertEqual(dropped, 200)
        XCTAssertEqual(f.pendingDrops, 200)
        XCTAssertEqual(f.verdict(for: Substring("\(nsLogPrefix)ISHKernel: later"), at: t0.addingTimeInterval(5)),
                       .write(family: "ISHKernel:", summaryBefore: 200),
                       "the next line of the family is preceded by one summary")
        XCTAssertEqual(f.pendingDrops, 0)
    }

    func testAlertLinesAreNeverLimited() {
        var f = StderrBurstFilter(ratePerSecond: 10, burst: 5, maxFamilies: 64)
        let t0 = Date(timeIntervalSince1970: 1_000)
        for i in 0..<100 {
            XCTAssertEqual(f.verdict(for: Substring("\(nsLogPrefix)ISHKernel: mount FAILED (\(i))"), at: t0),
                           .write(family: "ISHKernel:", summaryBefore: 0))
        }
        for line in ["ISHKernel: Warning - no output callback set", "x TIMED OUT", "boom: fatal signal", "⚠️ low memory"] {
            XCTAssertTrue(StderrBurstFilter.isAlert(line), line)
        }
        XCTAssertFalse(StderrBurstFilter.isAlert("ISHKernel: Root filesystem mounted at /x"))
        XCTAssertFalse(f.pendingDrops > 0)
    }

    func testFamiliesHaveIndependentBudgets() {
        var f = StderrBurstFilter(ratePerSecond: 10, burst: 3, maxFamilies: 64)
        let t0 = Date(timeIntervalSince1970: 1_000)
        for i in 0..<10 { _ = f.verdict(for: Substring("\(nsLogPrefix)ISHKernel: a\(i)"), at: t0) }
        XCTAssertEqual(f.verdict(for: Substring("\(nsLogPrefix)[DNS] configured"), at: t0),
                       .write(family: "[DNS]", summaryBefore: 0), "a noisy family must not starve another")
        XCTAssertEqual(f.verdict(for: Substring("\(nsLogPrefix)ISHKernel: still noisy"), at: t0), .drop)
    }

    func testFamilyExtractionStripsTheNSLogHeader() {
        XCTAssertEqual(StderrBurstFilter.family(of: "\(nsLogPrefix)ISHShellExecutor[stdin]: pipe created"), "ISHShellExecutor[stdin]:")
        XCTAssertEqual(StderrBurstFilter.family(of: "[DNS] configured"), "[DNS]")
        XCTAssertEqual(StderrBurstFilter.family(of: ""), "(blank)")
        XCTAssertEqual(StderrBurstFilter.family(of: "   "), "(blank)")
        XCTAssertEqual(StderrBurstFilter.family(of: "\(nsLogPrefix)"), "(blank)")
        XCTAssertEqual(StderrBurstFilter.family(of: String(repeating: "x", count: 100)).utf8.count, 40)
        // 头不完整(不是 NSLog 行)时退回整行的第一个词。
        XCTAssertEqual(StderrBurstFilter.family(of: "2026-10-14 not a header"), "2026-10-14")
    }

    func testFamilyCountIsBoundedSoRandomFirstWordsCannotGrowTheBuckets() {
        var f = StderrBurstFilter(ratePerSecond: 1, burst: 1, maxFamilies: 2)
        let t0 = Date(timeIntervalSince1970: 1_000)
        XCTAssertEqual(f.verdict(for: "a x", at: t0), .write(family: "a", summaryBefore: 0))
        XCTAssertEqual(f.verdict(for: "b x", at: t0), .write(family: "b", summaryBefore: 0))
        XCTAssertEqual(f.verdict(for: "c x", at: t0), .write(family: "other", summaryBefore: 0))
        XCTAssertEqual(f.verdict(for: "d x", at: t0), .drop, "c and d share the overflow bucket")
        let drained = f.drainSummaries()
        XCTAssertEqual(drained.map(\.family), ["other"])
        XCTAssertEqual(drained.map(\.count), [1])
        XCTAssertEqual(f.pendingDrops, 0)
    }

    // MARK: - IgnoredFilePathNoise

    func testNeverSyncedPathsAreNoise() {
        for path in ["/dev/null", "/dev/tty", "/dev/pts/0", "/proc/self/stat", "/sys/class/x", "/run/lock", "/tmp/out.txt", "/var/tmp/x"] {
            XCTAssertTrue(IgnoredFilePathNoise.isNoise(path), path)
        }
        for path in ["/var/minis/workspace/a.txt", "/var/minis/skills/x", "/root/notes.txt", "/devices/x", "/tmpfile", "relative/dev/null"] {
            XCTAssertFalse(IgnoredFilePathNoise.isNoise(path), path)
        }
    }

    // MARK: - 接线(读源码)

    func testSessionFileTrackerDemotesAllNoiseBatchesToVerbose() throws {
        let text = try source("Agent/Sync/V2/SessionFileChangeTracker.swift")
        XCTAssertTrue(text.contains("IgnoredFilePathNoise.isNoise(rawPath)"))
        XCTAssertTrue(text.contains("if noiseIgnored == ignored {"))
        XCTAssertTrue(text.contains("logger.verbose(\"[SessionFileTracker] batch recv: events=\\(events.count) all ignored"))
    }

    func testLiveActivityNotForegroundFailureIsNotAnErrorLine() throws {
        let text = try source("Agent/Background/AgentLiveActivityManager.swift")
        XCTAssertTrue(text.contains("static func isNotForegroundFailure(_ error: Error) -> Bool"))
        XCTAssertGreaterThanOrEqual(text.components(separatedBy: "Self.isNotForegroundFailure(error)").count - 1, 3,
                                    "start, renew restart and pendingStart recovery all classify the failure")
        // 三处 error 行都在 else 分支里,「Target is not foreground」走 info。
        for marker in ["[LiveActivity][start] Failed to start", "[LiveActivity][renew] Failed to restart",
                       "[LiveActivity][renew] pendingStart recovery still failed"] {
            guard let range = text.range(of: marker) else { return XCTFail("missing \(marker)") }
            let before = text[text.startIndex..<range.lowerBound]
            let lastLines = before.split(separator: "\n").suffix(2).joined(separator: "\n")
            XCTAssertTrue(lastLines.contains("} else {"), "\(marker) must only run when the failure is not the foreground race")
        }
    }

    func testRecentlyDeletedSkipLogsGoThroughTheSummarizer() throws {
        let text = try source("Agent/Sync/V2/ChatStoreSyncHydrators.swift")
        XCTAssertGreaterThanOrEqual(text.components(separatedBy: "noteRecentlyDeletedSkip(kind:").count - 1, 7,
                                    "six merge sites + the declaration")
        for line in text.split(separator: "\n") where line.contains("SKIP (recently deleted locally)") {
            XCTAssertTrue(line.contains("firstLine:") || line.contains("repeats suppressed"),
                          "every SKIP line must be the first-occurrence line or the summary: \(line)")
        }
        XCTAssertTrue(text.contains("RepeatedLogSummarizer(summaryEvery: 500"))
    }

    func testLoggingManagerRoutesCapturedLinesThroughTheBurstFilter() throws {
        let text = try source("Shared/LoggingManager.swift")
        XCTAssertTrue(text.contains("private var stderrBurstFilter = StderrBurstFilter()"))
        XCTAssertTrue(text.contains("stderrBurstFilter.verdict(for: line, at: capturedAt)"))
        // tee 到 console 的那份在过滤之前,不受影响。
        guard let tee = text.range(of: "Darwin.write(teeFd, base, safeData.count)"),
              let filter = text.range(of: "stderrBurstFilter.verdict(for:") else { return XCTFail("wiring missing") }
        XCTAssertLessThan(tee.lowerBound, filter.lowerBound)
    }

    func testLeoPerfMarksBackgroundLaunchesAndStreamingHangs() throws {
        let text = try source("Diagnostics/LeoPerf.swift")
        XCTAssertTrue(text.contains("var extra: [String: Any] = [\"prewarm\": prewarm, \"end\": step, \"bg\": bg]"))
        XCTAssertTrue(text.contains("isBackgroundLaunch(marked: marked, stateWasBackground: stateWasBackground"))
        XCTAssertTrue(text.contains("marked || (stateWasBackground && firstFrameMs > bgLaunchGraceMs)"))
        XCTAssertTrue(text.contains("LeoPerf.record(\"hang\", ms: ms, extra: [\"stream\": LeoPerf.isStreaming(hangBeganAt: sent)])"))
        XCTAssertTrue(text.contains("static func noteStreamingFlush()"))
    }
}
