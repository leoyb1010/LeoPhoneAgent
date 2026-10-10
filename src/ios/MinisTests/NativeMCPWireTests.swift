import XCTest

/// [B17] Native MCP client: credentials never follow a redirect to another
/// host, and only the reply to the request just sent is accepted.
final class NativeMCPWireTests: XCTestCase {

    func testRedirect_crossHostIsRefused() {
        let from = URL(string: "https://mcp.example.com/mcp")
        XCTAssertFalse(MCPWireSafety.allowsRedirect(from: from, to: URL(string: "https://evil.example.net/steal")))
        XCTAssertFalse(MCPWireSafety.allowsRedirect(from: from, to: URL(string: "http://mcp.example.com/mcp")),
                       "no https → http downgrade")
        XCTAssertFalse(MCPWireSafety.allowsRedirect(from: from, to: URL(string: "https://mcp.example.com:8443/mcp")))
        XCTAssertFalse(MCPWireSafety.allowsRedirect(from: from, to: nil))
    }

    func testRedirect_sameOriginIsAllowed() {
        let from = URL(string: "https://MCP.example.com/mcp")
        XCTAssertTrue(MCPWireSafety.allowsRedirect(from: from, to: URL(string: "https://mcp.example.com/v2/mcp")))
        XCTAssertTrue(MCPWireSafety.allowsRedirect(from: from, to: URL(string: "https://mcp.example.com:443/mcp/")))
    }

    func testResponseId_mustMatchRequest() throws {
        func obj(_ json: String) throws -> [String: Any] {
            try XCTUnwrap(JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any])
        }
        XCTAssertTrue(MCPWireSafety.isReply(try obj(#"{"jsonrpc":"2.0","id":7,"result":{}}"#), to: 7))
        XCTAssertTrue(MCPWireSafety.isReply(try obj(#"{"jsonrpc":"2.0","id":"7","result":{}}"#), to: 7),
                      "a string-echoed id still matches")
        XCTAssertFalse(MCPWireSafety.isReply(try obj(#"{"jsonrpc":"2.0","id":6,"result":{}}"#), to: 7))
        XCTAssertFalse(MCPWireSafety.isReply(try obj(#"{"jsonrpc":"2.0","id":true,"result":{}}"#), to: 1))
        XCTAssertFalse(MCPWireSafety.isReply(try obj(#"{"jsonrpc":"2.0","method":"notifications/progress"}"#), to: 7))
        XCTAssertTrue(MCPWireSafety.isReply(try obj(#"{"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"parse"}}"#), to: 7),
                      "an error the server could not attribute is still reported")
        XCTAssertEqual(MCPWireSafety.errorMessage("plain"), "plain")
        XCTAssertEqual(MCPWireSafety.errorMessage(["message": "bad"]), "bad")
    }

    func testSSE_picksTheReplyForThisRequest() throws {
        let body = """
        event: message
        data: {"jsonrpc":"2.0","method":"notifications/progress","params":{}}

        data: {"jsonrpc":"2.0","id":3,"result":{"other":true}}

        data: {"jsonrpc":"2.0","id":4,"result":{"mine":true}}

        """
        let reply = try XCTUnwrap(MCPWireSafety.replyFromSSE(Data(body.utf8), requestId: 4))
        XCTAssertEqual((reply["result"] as? [String: Any])?["mine"] as? Bool, true)
        XCTAssertNil(MCPWireSafety.replyFromSSE(Data(body.utf8), requestId: 9))
    }

    func testClient_usesGuardedSessionAndChecksIds() throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
        let text = try String(contentsOf: root.appendingPathComponent("Agent/Session/NativeMCPClient.swift"), encoding: .utf8)
        XCTAssertFalse(text.contains("URLSession.shared"), "every request goes through the redirect-guarded session")
        XCTAssertTrue(text.contains("delegate: MCPRedirectGuard()"))
        XCTAssertTrue(text.contains("MCPWireSafety.isReply(parsed, to: requestId)"))
        let oauth = try String(contentsOf: root.appendingPathComponent("Agent/Session/MCPOAuthController.swift"), encoding: .utf8)
        XCTAssertFalse(oauth.contains("URL(string: oauth.tokenEndpoint)!"), "no force-unwrap of a user-entered endpoint")
        XCTAssertFalse(oauth.contains("resolvingAgainstBaseURL: false)!"))
    }
}
