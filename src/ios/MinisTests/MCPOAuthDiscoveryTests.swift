import XCTest

/// [F1] 远程 MCP OAuth 自动发现 + 动态注册的纯逻辑(`MCPOAuthDiscovery.swift`)。
final class MCPOAuthDiscoveryTests: XCTestCase {
    func testProtectedResourceWellKnownUsesPathInsertionThenRoot() {
        let urls = MCPOAuthDiscovery.protectedResourceMetadataURLs(serverURL: URL(string: "https://mcp.example.com/v1/mcp")!)
        XCTAssertEqual(urls.map(\.absoluteString), [
            "https://mcp.example.com/.well-known/oauth-protected-resource/v1/mcp",
            "https://mcp.example.com/.well-known/oauth-protected-resource",
        ])
        XCTAssertEqual(MCPOAuthDiscovery.protectedResourceMetadataURLs(serverURL: URL(string: "https://mcp.example.com/")!)
            .map(\.absoluteString), ["https://mcp.example.com/.well-known/oauth-protected-resource"])
    }

    func testAuthorizationServerMetadataCandidates() {
        let root = MCPOAuthDiscovery.authorizationServerMetadataURLs(issuer: URL(string: "https://auth.example.com")!)
        XCTAssertEqual(root.map(\.absoluteString), [
            "https://auth.example.com/.well-known/oauth-authorization-server",
            "https://auth.example.com/.well-known/openid-configuration",
        ])
        let tenant = MCPOAuthDiscovery.authorizationServerMetadataURLs(issuer: URL(string: "https://auth.example.com/tenant1")!)
        XCTAssertEqual(tenant.first?.absoluteString, "https://auth.example.com/.well-known/oauth-authorization-server/tenant1")
        XCTAssertTrue(tenant.map(\.absoluteString).contains("https://auth.example.com/tenant1/.well-known/openid-configuration"))
    }

    func testServerURLMustBeHttps() {
        XCTAssertNil(MCPOAuthDiscovery.httpsURL("http://mcp.example.com/mcp"))
        XCTAssertNil(MCPOAuthDiscovery.httpsURL(""))
        XCTAssertEqual(MCPOAuthDiscovery.httpsURL(" https://mcp.example.com/mcp?x=1#f ")?.absoluteString, "https://mcp.example.com/mcp")
    }

    func testProtectedResourceParsingKeepsOnlyHttpsServers() {
        let data = Data(#"{"resource":"https://mcp.example.com","authorization_servers":["http://insecure","https://auth.example.com"],"scopes_supported":["read","write"]}"#.utf8)
        let prm = MCPOAuthDiscovery.parseProtectedResource(data)
        XCTAssertEqual(prm?.authorizationServers.map(\.absoluteString), ["https://auth.example.com"])
        XCTAssertEqual(prm?.scopes, ["read", "write"])
        XCTAssertNil(MCPOAuthDiscovery.parseProtectedResource(Data(#"{"authorization_servers":["http://x"]}"#.utf8)))
    }

    func testServerMetadataValidation() throws {
        let issuer = URL(string: "https://auth.example.com")!
        let ok = Data(#"{"issuer":"https://auth.example.com/","authorization_endpoint":"https://auth.example.com/authorize","token_endpoint":"https://auth.example.com/token","registration_endpoint":"https://auth.example.com/register","code_challenge_methods_supported":["S256"]}"#.utf8)
        let meta = try MCPOAuthDiscovery.parseServerMetadata(ok, expectedIssuer: issuer)
        XCTAssertEqual(meta.registrationEndpoint, "https://auth.example.com/register")

        let wrongIssuer = Data(#"{"issuer":"https://evil.example","authorization_endpoint":"https://a/x","token_endpoint":"https://a/t"}"#.utf8)
        XCTAssertThrowsError(try MCPOAuthDiscovery.parseServerMetadata(wrongIssuer, expectedIssuer: issuer)) {
            XCTAssertEqual($0 as? MCPOAuthDiscovery.DiscoveryError, .issuerMismatch)
        }
        let insecure = Data(#"{"issuer":"https://auth.example.com","authorization_endpoint":"http://auth.example.com/a","token_endpoint":"https://auth.example.com/t"}"#.utf8)
        XCTAssertThrowsError(try MCPOAuthDiscovery.parseServerMetadata(insecure, expectedIssuer: issuer)) {
            XCTAssertEqual($0 as? MCPOAuthDiscovery.DiscoveryError, .insecureEndpoint)
        }
        let noPKCE = Data(#"{"issuer":"https://auth.example.com","authorization_endpoint":"https://auth.example.com/a","token_endpoint":"https://auth.example.com/t","code_challenge_methods_supported":["plain"]}"#.utf8)
        XCTAssertThrowsError(try MCPOAuthDiscovery.parseServerMetadata(noPKCE, expectedIssuer: issuer)) {
            XCTAssertEqual($0 as? MCPOAuthDiscovery.DiscoveryError, .pkceUnsupported)
        }
    }

    func testRegistrationBodyIsPublicPKCEClient() {
        let body = MCPOAuthDiscovery.registrationBody(redirectURI: "http://localhost:54546/callback", scope: "read")
        XCTAssertEqual(body["redirect_uris"] as? [String], ["http://localhost:54546/callback"])
        XCTAssertEqual(body["token_endpoint_auth_method"] as? String, "none")
        XCTAssertEqual(body["grant_types"] as? [String], ["authorization_code", "refresh_token"])
        XCTAssertEqual(body["scope"] as? String, "read")
        XCTAssertNil(MCPOAuthDiscovery.registrationBody(redirectURI: "x", scope: " ")["scope"])
    }

    func testRegistrationResponseParsing() throws {
        let client = try MCPOAuthDiscovery.parseRegistration(Data(#"{"client_id":"abc123","client_secret":""}"#.utf8))
        XCTAssertEqual(client, .init(clientId: "abc123", clientSecret: nil))
        XCTAssertThrowsError(try MCPOAuthDiscovery.parseRegistration(Data(#"{"error":"invalid_redirect_uri"}"#.utf8)))
        XCTAssertThrowsError(try MCPOAuthDiscovery.parseRegistration(Data(#"{"client_id":"   "}"#.utf8)))
    }

    func testNeedsDiscoveryOnlyWhenSomethingIsMissing() {
        XCTAssertFalse(MCPOAuthDiscovery.needsDiscovery(clientId: "id", authorizationEndpoint: "https://a", tokenEndpoint: "https://t"))
        XCTAssertTrue(MCPOAuthDiscovery.needsDiscovery(clientId: " ", authorizationEndpoint: "https://a", tokenEndpoint: "https://t"))
        XCTAssertTrue(MCPOAuthDiscovery.needsDiscovery(clientId: "id", authorizationEndpoint: "", tokenEndpoint: "https://t"))
    }

    func testLegacyDefaultsStayOnServerOrigin() {
        let meta = MCPOAuthDiscovery.legacyDefaultMetadata(serverURL: URL(string: "https://mcp.example.com:8443/v1/mcp")!)
        XCTAssertEqual(meta?.authorizationEndpoint, "https://mcp.example.com:8443/authorize")
        XCTAssertEqual(meta?.registrationEndpoint, "https://mcp.example.com:8443/register")
    }
}
