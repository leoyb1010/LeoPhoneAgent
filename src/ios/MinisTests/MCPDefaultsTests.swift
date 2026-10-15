import XCTest

/// [T-default-mcp] 1.71 默认装机清单:目录清理 + 三个免 Key 远程 MCP 首装开启。
/// MCPStore / 目录视图编不进逻辑测试 target,用读源码的方式钉住。
final class MCPDefaultsTests: XCTestCase {
    private func source(_ relative: String) throws -> String {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
        return try String(contentsOf: root.appendingPathComponent(relative), encoding: .utf8)
    }

    /// 智谱(独立性红线)、飞书(用户不接)、支付宝(含支付,不进一键目录)都不能再出现。
    func testCatalogDropsRedLineAndPaymentEntries() throws {
        let catalog = try source("Views/MCP/MCPIntegrationsView.swift")
        for banned in ["bigmodel.cn", "zhipu", "alipay", "支付宝", "feishu", "飞书"] {
            XCTAssertFalse(catalog.contains(banned), banned)
        }
    }

    func testCatalogOffersThePlannedEntries() throws {
        let catalog = try source("Views/MCP/MCPIntegrationsView.swift")
        for id in ["exa", "tavily", "jina-reader", "context7", "deepwiki", "github", "notion",
                   "amap-maps", "12306", "kuaidi100", "qweather"] {
            XCTAssertTrue(catalog.contains("id: \"\(id)\""), id)
        }
        // 密钥只用 $$NAME 占位,不写死。
        XCTAssertTrue(catalog.contains("\"Authorization\": \"Bearer $$GITHUB_TOKEN\""))
        XCTAssertTrue(catalog.contains("tavilyApiKey=$$TAVILY_API_KEY"))
        // Jina 的 streamable-HTTP 端点是 /v1(/mcp 返回 404)。
        XCTAssertTrue(catalog.contains("url: \"https://mcp.jina.ai/v1\""))
    }

    func testDefaultServersAreTheThreeKeylessEndpoints() throws {
        let store = try source("Agent/Session/MCPStore.swift")
        let body = try XCTUnwrap(store.range(of: "enum DefaultMCPServers"))
        let text = String(store[body.lowerBound...].prefix(2500))
        XCTAssertTrue(text.contains("make(id: \"exa\", url: \"https://mcp.exa.ai/mcp\""))
        XCTAssertTrue(text.contains("make(id: \"context7\", url: \"https://mcp.context7.com/mcp\""))
        XCTAssertTrue(text.contains("make(id: \"deepwiki\", url: \"https://mcp.deepwiki.com/mcp\""))
        XCTAssertFalse(text.contains("headers"), "默认服务不带任何密钥")
    }

    /// 每台设备只种一次,且不覆盖同名的已有配置:用户删掉的不会被加回来。
    func testSeedingRunsOnceAndSkipsExistingNames() throws {
        let store = try source("Agent/Session/MCPStore.swift")
        let initRange = try XCTUnwrap(store.range(of: "private init() {"))
        let initText = String(store[initRange.lowerBound...].prefix(400))
        let load = try XCTUnwrap(initText.range(of: "load()"))
        let seed = try XCTUnwrap(initText.range(of: "seedDefaultServersIfNeeded()"))
        XCTAssertLessThan(load.lowerBound, seed.lowerBound, "先读已有配置再种")
        let fn = try XCTUnwrap(store.range(of: "private func seedDefaultServersIfNeeded()"))
        let fnText = String(store[fn.lowerBound...].prefix(700))
        XCTAssertTrue(fnText.contains("guard !UserDefaults.standard.bool(forKey: key) else { return }"))
        XCTAssertTrue(fnText.contains("DefaultMCPServers.missing(from: servers.map(\\.id))"))
        XCTAssertTrue(fnText.contains("UserDefaults.standard.set(true, forKey: key)"))
        XCTAssertTrue(store.contains("return all.filter { !existing.contains($0.id.lowercased()) }"))
    }
}
