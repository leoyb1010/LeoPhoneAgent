import XCTest

/// [C1][C3][C10][C11] 1.56.0 快捷指令深挖的纯逻辑部分。
final class ShortcutDeepeningTests: XCTestCase {
    private var dir: URL!

    override func setUpWithError() throws {
        dir = FileManager.default.temporaryDirectory.appendingPathComponent("c156-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: dir)
    }

    private func makeStore() -> ShortcutCallbackStore {
        ShortcutCallbackStore(resultsDirectory: dir, observeAppActive: false)
    }

    // MARK: C1 回调 URL 解析

    func testCallbackURLRoundTripsRunIdAndStatus() throws {
        let raw = ShortcutCallbackStore.callbackURL(runId: "abc123def456", status: .error)
        XCTAssertEqual(raw, "leophoneagent://shortcut-result?run=abc123def456&status=error")
        let parsed = try XCTUnwrap(ShortcutCallbackStore.parse(XCTUnwrap(URL(string: raw))))
        XCTAssertEqual(parsed.runId, "abc123def456")
        XCTAssertEqual(parsed.status, .error)
        XCTAssertNil(parsed.result)
    }

    func testParsesResultAppendedByShortcutsApp() throws {
        // 快捷指令 App 把输出追加成 result 参数(中文、空格都已百分号编码)。
        let url = try XCTUnwrap(URL(string:
            "leophoneagent://shortcut-result?run=r1&status=success&result=%E4%BB%8A%E5%A4%A9%208421%20%E6%AD%A5"))
        let parsed = try XCTUnwrap(ShortcutCallbackStore.parse(url))
        XCTAssertEqual(parsed.status, .success)
        XCTAssertEqual(parsed.result, "今天 8421 步")
    }

    func testParsesErrorMessageAndDefaultsMissingStatusToSuccess() throws {
        let error = try XCTUnwrap(ShortcutCallbackStore.parse(
            XCTUnwrap(URL(string: "leophoneagent://shortcut-result?run=r2&status=error&errorMessage=boom"))))
        XCTAssertEqual(error.errorMessage, "boom")
        let bare = try XCTUnwrap(ShortcutCallbackStore.parse(XCTUnwrap(URL(string: "leophoneagent://shortcut-result?run=r3"))))
        XCTAssertEqual(bare.status, .success)
        let cancel = try XCTUnwrap(ShortcutCallbackStore.parse(
            XCTUnwrap(URL(string: "leophoneagent://shortcut-result?run=r4&status=cancel"))))
        XCTAssertEqual(cancel.status, .cancel)
    }

    func testCallbackAcceptsLobeAliasButKeepsGeneratingLegacyScheme() throws {
        XCTAssertTrue(ShortcutCallbackStore.callbackURL(runId: "r9", status: .success).hasPrefix("leophoneagent://"))
        let parsed = try XCTUnwrap(ShortcutCallbackStore.parse(
            XCTUnwrap(URL(string: "lobe://shortcut-result?run=r9&status=cancel&result=ok"))))
        XCTAssertEqual(parsed.runId, "r9")
        XCTAssertEqual(parsed.status, .cancel)
        XCTAssertEqual(parsed.result, "ok")
        XCTAssertNil(ShortcutCallbackStore.parse(try XCTUnwrap(URL(string: "lobe://settings?run=r9"))))
    }

    func testRejectsForeignHostsAndUnsafeRunIds() throws {
        XCTAssertNil(ShortcutCallbackStore.parse(try XCTUnwrap(URL(string: "leophoneagent://settings?run=r1"))))
        XCTAssertNil(ShortcutCallbackStore.parse(try XCTUnwrap(URL(string: "other://shortcut-result?run=r1"))))
        XCTAssertNil(ShortcutCallbackStore.parse(try XCTUnwrap(URL(string: "leophoneagent://shortcut-result?status=success"))))
        XCTAssertNil(ShortcutCallbackStore.parse(try XCTUnwrap(URL(string: "leophoneagent://shortcut-result?run=..%2Fx"))))
        XCTAssertFalse(makeStore().handle(url: try XCTUnwrap(URL(string: "leophoneagent://settings"))))
    }

    // MARK: C1 等待、回调、超时、文件退路

    func testCallbackWithResultWakesWaiter() throws {
        let store = makeStore()
        let runId = store.begin(name: "今天步数")
        DispatchQueue.global().asyncAfter(deadline: .now() + 0.2) {
            _ = store.handle(url: URL(string: "leophoneagent://shortcut-result?run=\(runId)&status=success&result=42")!)
        }
        let outcome = store.wait(runId: runId, timeout: 10)
        XCTAssertEqual(outcome.status, .success)
        XCTAssertEqual(outcome.output, "42")
        XCTAssertEqual(outcome.source, "callback")
    }

    func testTimesOutWhenNoCallbackArrives() {
        let store = makeStore()
        let runId = store.begin(name: "永不回调")
        let started = Date()
        let outcome = store.wait(runId: runId, timeout: 0.3)
        XCTAssertEqual(outcome.status, .timeout)
        XCTAssertNil(outcome.output)
        XCTAssertLessThan(Date().timeIntervalSince(started), 5)
        // 超时后迟到的回调不会崩,也不会复活这次运行。
        store.deliver(.init(runId: runId, status: .success, result: "late", errorMessage: nil))
    }

    func testCallbackWithoutResultFallsBackToRunIdFile() throws {
        let store = makeStore()
        let runId = store.begin(name: "今天步数")
        try "8421\n".write(to: dir.appendingPathComponent("\(runId).txt"), atomically: true, encoding: .utf8)
        store.deliver(.init(runId: runId, status: .success, result: nil, errorMessage: nil))
        let outcome = store.wait(runId: runId, timeout: 5)
        XCTAssertEqual(outcome.output, "8421")
        XCTAssertEqual(outcome.source, "file")
        XCTAssertFalse(FileManager.default.fileExists(atPath: dir.appendingPathComponent("\(runId).txt").path),
                       "读过的结果文件要删掉,不被下次运行复用")
    }

    func testNameFileOnlyCountsWhenWrittenAfterRunStarted() throws {
        let store = makeStore()
        let file = dir.appendingPathComponent("今天步数.txt")
        try "旧结果".write(to: file, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.modificationDate: Date().addingTimeInterval(-600)], ofItemAtPath: file.path)
        let runId = store.begin(name: "今天步数")
        store.deliver(.init(runId: runId, status: .success, result: nil, errorMessage: nil))
        let stale = store.wait(runId: runId, timeout: 5)
        XCTAssertEqual(stale.status, .success)
        XCTAssertNil(stale.output, "运行开始前写的同名文件是上次的结果")

        let second = store.begin(name: "今天步数")
        try "9000".write(to: file, atomically: true, encoding: .utf8)
        store.checkResultFiles()   // App 回到前台
        let fresh = store.wait(runId: second, timeout: 5)
        XCTAssertEqual(fresh.output, "9000")
        XCTAssertEqual(fresh.source, "file")
    }

    func testErrorAndCancelCallbacksCarryStatus() {
        let store = makeStore()
        let failing = store.begin(name: "a")
        store.deliver(.init(runId: failing, status: .error, result: nil, errorMessage: "找不到快捷指令"))
        let failed = store.wait(runId: failing, timeout: 5)
        XCTAssertEqual(failed.status, .error)
        XCTAssertEqual(failed.errorMessage, "找不到快捷指令")

        let cancelling = store.begin(name: "b")
        store.deliver(.init(runId: cancelling, status: .cancel, result: nil, errorMessage: nil))
        XCTAssertEqual(store.wait(runId: cancelling, timeout: 5).status, .cancel)
    }

    // MARK: C3 记忆写入

    func testMemoryDailyLogPrependsNewestEntryWithTimestamp() throws {
        let first = Date(timeIntervalSince1970: 1_790_000_000)
        let name = try MemoryDailyLog.prepend("我下周三去上海", in: dir, at: first)
        XCTAssertEqual(name, MemoryDailyLog.fileName(for: first))
        try MemoryDailyLog.prepend("记得带充电器", in: dir, at: first.addingTimeInterval(60))
        let text = try String(contentsOf: dir.appendingPathComponent(name), encoding: .utf8)
        let newer = try XCTUnwrap(text.range(of: "记得带充电器"))
        let older = try XCTUnwrap(text.range(of: "我下周三去上海"))
        XCTAssertLessThan(newer.lowerBound, older.lowerBound, "新条目在最前")
        XCTAssertTrue(text.hasPrefix("<!-- "))
        XCTAssertEqual(text.components(separatedBy: "<!-- ").count - 1, 2)
    }

    /// 快捷指令(可能在锁屏时)写入的条目标明来源;时间戳注释格式不变,按时间读取照旧。
    func testMemoryDailyLogTagsShortcutSource() throws {
        let date = Date(timeIntervalSince1970: 1_790_000_000)
        let name = try MemoryDailyLog.prepend("我对花生过敏", in: dir, at: date, source: "快捷指令·锁屏")
        let text = try String(contentsOf: dir.appendingPathComponent(name), encoding: .utf8)
        XCTAssertTrue(text.hasPrefix("<!-- "))
        XCTAssertTrue(text.contains("-->\n[来源:快捷指令·锁屏] 我对花生过敏\n"))
    }

    /// 当天文件读不出来(编码损坏 / 锁屏数据保护)时必须报错,不能用新条目覆盖掉旧内容。
    func testMemoryDailyLogRefusesToOverwriteUnreadableFile() throws {
        let date = Date(timeIntervalSince1970: 1_790_000_000)
        let url = dir.appendingPathComponent(MemoryDailyLog.fileName(for: date))
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let corrupt = Data([0xFF, 0xFE, 0x00, 0xC3])
        try corrupt.write(to: url)
        XCTAssertThrowsError(try MemoryDailyLog.prepend("新的一条", in: dir, at: date))
        XCTAssertEqual(try Data(contentsOf: url), corrupt, "旧内容原样保留")
    }

    func testMemoryDailyLogConcurrentWritesKeepEveryEntry() throws {
        let date = Date(timeIntervalSince1970: 1_790_000_000)
        let directory: URL = dir
        DispatchQueue.concurrentPerform(iterations: 20) { i in
            _ = try? MemoryDailyLog.prepend("entry-\(i)", in: directory, at: date)
        }
        let text = try String(contentsOf: dir.appendingPathComponent(MemoryDailyLog.fileName(for: date)), encoding: .utf8)
        for i in 0..<20 { XCTAssertTrue(text.contains("entry-\(i)\n"), "entry-\(i) 丢了") }
    }

    // MARK: C11 Siri 朗读与隐私

    func testSiriReplyHiddenOnlyWhenLockedWithPrivacyAndNotVoiceOnly() {
        let body = "今天走了 8421 步"
        // 锁屏 + 隐私开启:不念正文
        XCTAssertEqual(SiriReplyPrivacy.dialogText(body, deviceLocked: true, privacyMode: true, voiceOnly: false),
                       SiriReplyPrivacy.hiddenReply)
        // 已解锁:照常朗读
        XCTAssertEqual(SiriReplyPrivacy.dialogText(body, deviceLocked: false, privacyMode: true, voiceOnly: false), body)
        // 锁屏但只有声音(车载 / 耳机):照常朗读
        XCTAssertEqual(SiriReplyPrivacy.dialogText(body, deviceLocked: true, privacyMode: true, voiceOnly: true), body)
        // 隐私模式关闭:照常朗读
        XCTAssertEqual(SiriReplyPrivacy.dialogText(body, deviceLocked: true, privacyMode: false, voiceOnly: false), body)
    }

    // MARK: C10 配方

    func testRecipesHaveThreeStepsAndPendingLinksStayNil() {
        XCTAssertEqual(ShortcutRecipes.all.count, 5)
        XCTAssertEqual(Set(ShortcutRecipes.all.map(\.id)).count, 5)
        for recipe in ShortcutRecipes.all {
            XCTAssertEqual(recipe.steps.count, 3, recipe.id)
            XCTAssertFalse(recipe.purpose.isEmpty)
            if recipe.iCloudLink.isEmpty { XCTAssertNil(recipe.shareURL) }
        }
        let linked = ShortcutRecipe(id: "x", title: "x", symbolName: "x", purpose: "x", trigger: "x", action: "x",
                                    iCloudLink: "https://www.icloud.com/shortcuts/abc", steps: [])
        XCTAssertNotNil(linked.shareURL)
        let unsafe = ShortcutRecipe(id: "y", title: "y", symbolName: "y", purpose: "y", trigger: "y", action: "y",
                                    iCloudLink: "javascript:alert(1)", steps: [])
        XCTAssertNil(unsafe.shareURL)
    }
}
