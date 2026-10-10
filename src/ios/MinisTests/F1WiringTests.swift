import XCTest

/// [F1] 端侧标题/追问、余额、超时、模型搜索、MCP 自动注册在 App 代码里的接线(读源码断言;
/// 这些路径依赖真机的本机模型、钥匙串与网络,逻辑测试只能钉住它们走的是哪条路)。
final class F1WiringTests: XCTestCase {
    private func source(_ relative: String) throws -> String {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
        return try String(contentsOf: root.appendingPathComponent(relative), encoding: .utf8)
    }

    func testTitleGenerationTriesOnDeviceFirstOnBothPaths() throws {
        let text = try source("Agent/Chat/AIChatViewModel+TitleGeneration.swift")
        XCTAssertEqual(text.components(separatedBy: "titleOnDeviceFirst(").count - 1, 3)  // 定义 + 自动 + 重新生成
        XCTAssertTrue(text.contains("LocalBrain.shared.generateSessionTitle("))
        XCTAssertTrue(text.contains("return try await callSubModelForTitle(conversationSummary: conversationSummary"))
    }

    func testFollowUpsNeverReachTheCloud() throws {
        let text = try source("Agent/Chat/AIChatViewModel+FollowUps.swift")
        XCTAssertTrue(text.contains("LocalBrain.shared.suggestFollowUps("))
        for cloud in ["makeAgentProvider", "streamAgentMessage", "URLSession", "callSubModel"] {
            XCTAssertFalse(text.contains(cloud), cloud)
        }
        XCTAssertTrue(text.contains("FollowUpSuggestionPolicy.shouldGenerate("))
        let brain = try source("Agent/LocalIntelligence/LocalBrain.swift")
        XCTAssertFalse(brain.contains("URLSession"))
    }

    func testStallWatchdogUsesPerProviderTimeout() throws {
        let stream = try source("Agent/Chat/AIChatViewModel+SSEStream.swift")
        XCTAssertFalse(stream.contains("let stallTimeoutSeconds: TimeInterval = 120"))
        XCTAssertTrue(stream.contains("self.streamStallLimit"))
        let fallback = try source("Agent/Chat/AIChatViewModel+Fallback.swift")
        XCTAssertTrue(fallback.contains("streamStallLimit = ProviderResponseTimeout.stallSeconds("))
    }

    func testModelPickerRanksSearchAndSortsNewestFirst() throws {
        let picker = try source("Views/Providers/UnifiedModelPicker.swift")
        XCTAssertTrue(picker.contains("ModelSearchScorer.rank("))
        XCTAssertTrue(picker.contains("ModelRecency.sortNewestFirst("))
        XCTAssertTrue(picker.contains("balances.refreshIfStale("))
    }

    func testBalanceFetchIsOffMainAndDoesNotFollowRedirects() throws {
        let store = try source("Providers/ProviderBalanceStore.swift")
        XCTAssertTrue(store.contains("Task.detached(priority: .utility)"))
        XCTAssertTrue(store.contains("nonisolated private static func fetch("))
        XCTAssertTrue(store.contains("StrictNoRedirectDelegate()"))
        XCTAssertFalse(store.contains("URLSession.shared"))
    }

    func testMCPDiscoveryOnlyRunsWhenConfigIsIncomplete() throws {
        let controller = try source("Agent/Session/MCPOAuthController.swift")
        XCTAssertTrue(controller.contains("guard MCPOAuthDiscovery.needsDiscovery("))
        XCTAssertTrue(controller.contains("delegate: StrictNoRedirectDelegate()"))
        let form = try source("Views/MCP/MCPFormSheet.swift")
        XCTAssertTrue(form.contains("resolveConfigIfNeeded("))
    }
}
