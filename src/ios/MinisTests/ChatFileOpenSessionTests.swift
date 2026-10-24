import XCTest

/// [leo] 「输出的 html / 附件打不开」。真机日志(2026-10-24):父会话 5ECFA2CD 派了后台子代理 01933759,
/// 子代理 loadSession() 把全局 activeSessionId 抢成自己;子代理的文件按设计写在父会话 workspace,
/// 用户在父会话里点 leophoneagent://workspace/brain_sol_audit.md,却去 01933759/workspace 找 → 「文件不存在」。
/// 这些类型编不进逻辑 target,接线用源码守卫钉住。
final class ChatFileOpenSessionTests: XCTestCase {
    private func source(_ relative: String) throws -> String {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
        return try String(contentsOf: root.appendingPathComponent(relative), encoding: .utf8)
    }

    /// 加载会话(子代理/后台回合/同步重载)不能抢走屏幕上聊天的 activeSessionId。
    func testLoadSessionDoesNotStealTheOnScreenSession() throws {
        let text = try source("Agent/Chat/AIChatViewModel+Persistence.swift")
        let body = try XCTUnwrap(text.range(of: "func loadSession() async {"))
        let end = try XCTUnwrap(text.range(of: "isLoadingSession = true", range: body.upperBound..<text.endIndex))
        let load = String(text[body.upperBound..<end.lowerBound])
        XCTAssertTrue(load.contains("if Self.activeSessionId == nil { Self.activeSessionId = sessionId }"))
        XCTAssertFalse(load.contains("\n        Self.activeSessionId = sessionId\n"), "loadSession 无条件认领会抢走上屏的聊天")
    }

    /// 点链接按「这个聊天自己的文件会话」解析,子代理的聊天落到父会话。
    func testTapResolvesAgainstTheTappedChatsOwnSession() throws {
        let view = try source("Views/Chat/AIChatView.swift")
        XCTAssertTrue(view.contains("resolveMinisFileURL(url: url, sessionId: vm.subAgentFSSessionId)"))
        let media = try source("Views/Chat/MinisMediaViews.swift")
        XCTAssertTrue(media.contains("func resolveMinisFileURL(url: URL, sessionId: String? = nil) -> URL?"))
        XCTAssertTrue(media.contains("if let sid = sessionId ?? AIChatViewModel.activeSessionId {"))
    }

    /// 工具读文件/收录产物按本会话路由,不按「最后跑过 shell 的会话」。
    func testDirectReadRoutesBySessionNotLastMountedSession() throws {
        let files = try source("Agent/Chat/AIChatViewModel+FileTools.swift")
        XCTAssertTrue(files.contains("hostURL(for: linuxPath, sessionId: self.subAgentFSSessionId)"))
    }

    /// allowUniversalAccessFromFileURLs 是 WKWebViewConfiguration 的键,挂在 WKPreferences 上无效。
    func testUniversalFileAccessKeyIsSetOnTheConfiguration() throws {
        let sheet = try source("Views/Chat/WebPreviewSheet.swift")
        XCTAssertTrue(sheet.contains("SafeKVCSetTrue.apply(config, key: \"allowUniversalAccessFromFileURLs\")"))
        XCTAssertFalse(sheet.contains("SafeKVCSetTrue.apply(prefs, key: \"allowUniversalAccessFromFileURLs\")"))
    }
}
