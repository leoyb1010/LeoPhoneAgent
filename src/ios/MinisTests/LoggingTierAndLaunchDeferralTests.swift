import XCTest

/// [T-ios-log-verbose-tier] / [T-ios27-scene-create-watchdog] /
/// [T-ios-listsessions-perf] launch deferral. AppLogger, LoggingManager,
/// ChatStore and MinisApp are not compiled into the logic-test target (the
/// test bundle uses a stub AppLogger), so these guards read the sources.
final class LoggingTierAndLaunchDeferralTests: XCTestCase {
    private func source(_ relative: String) throws -> String {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
        return try String(contentsOf: root.appendingPathComponent(relative), encoding: .utf8)
    }

    func testAppLoggerHasThreeTiersWithInfoDefault() throws {
        let text = try source("Shared/AppLogger.swift")
        XCTAssertTrue(text.contains("case verbose = 0"))
        XCTAssertTrue(text.contains("case info    = 1"))
        // A missing key must not read as 0 (= verbose, the firehose).
        XCTAssertTrue(text.contains("UserDefaults.standard.object(forKey: levelKey) as? Int"))
        XCTAssertTrue(text.contains("func verbose(_ message: @autoclosure () -> String)"))
        XCTAssertTrue(text.contains("#if DEBUG"), "debug() stays compiled out of Release")
        XCTAssertTrue(text.contains("subsystem: String = \"com.leoyuan.leophoneagent\""))
        XCTAssertFalse(text.contains("openminis"))
    }

    func testDeferredLoggingIsThreadLocalAndBounded() throws {
        let text = try source("Shared/AppLogger.swift")
        XCTAssertTrue(text.contains("static func withDeferredLogging<T>"))
        XCTAssertTrue(text.contains("Thread.current.threadDictionary"))
        XCTAssertTrue(text.contains("box.buffer.count < 512"))
    }

    func testChatStoreInitDefersLoggingInsideOnceToken() throws {
        let text = try source("Agent/Chat/ChatStore.swift")
        guard let initRange = text.range(of: "    init() {"),
              let end = text.range(of: "/// Initialize with a custom base URL", range: initRange.upperBound..<text.endIndex)
        else { return XCTFail("ChatStore.init not found") }
        let body = text[initRange.upperBound..<end.lowerBound]
        XCTAssertTrue(body.contains("AppLogger.withDeferredLogging {"))
    }

    func testLoggingManagerMirrorsLevelIntoKernelThroughShim() throws {
        let text = try source("Shared/LoggingManager.swift")
        XCTAssertTrue(text.contains("@Published var level: AppLogger.Level"))
        XCTAssertTrue(text.contains("leo_set_kernel_verbose_trace(level <= .verbose)"))
        let shim = try source("Diagnostics/LeoVerboseTraceShim.c")
        XCTAssertTrue(shim.contains("__attribute__((weak)) void ish_set_verbose_trace(bool enabled)"),
                      "weak default keeps old iSH kernels linking")
        XCTAssertFalse(shim.contains("#include \"ish"), "shim must not include the kernel prototype")
    }

    func testForegroundSkillReloadIsOffTheFirstFramePath() throws {
        // [S4/S6] The skills reload now lives in runAfterForegroundFrame (after
        // the returning frame is on screen) and is throttled + fingerprinted.
        let text = try source("MinisApp.swift")
        guard let call = text.range(of: "SkillStore.shared.reloadIfChangedOnDisk()") else { return XCTFail("reload call not found") }
        guard let after = text.range(of: "private static func runAfterForegroundFrame()") else { return XCTFail("after-frame routine missing") }
        XCTAssertLessThan(after.lowerBound, call.lowerBound)
        XCTAssertFalse(text.contains("SkillStore.shared.reload()"))
    }
}
