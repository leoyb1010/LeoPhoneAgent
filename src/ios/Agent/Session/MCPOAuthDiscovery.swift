//
//  MCPOAuthDiscovery.swift
//  MinisApp
//
//  远程 MCP 服务器的 OAuth 自动发现 + 动态客户端注册的纯逻辑部分:
//    • RFC 9728 受保护资源元数据(从 MCP 服务器自己的主机找到它声明的授权服务器)
//    • RFC 8414 授权服务器元数据(授权/令牌/注册端点)
//    • RFC 7591 动态客户端注册(请求体与响应解析)
//  只访问 MCP 服务器及其元数据里声明的 https 端点。网络请求在 MCPOAuthController。
//

import Foundation

enum MCPOAuthDiscovery {
    /// 授权服务器元数据里我们需要的部分。
    struct ServerMetadata: Equatable {
        var issuer: String
        var authorizationEndpoint: String
        var tokenEndpoint: String
        var registrationEndpoint: String?
        var scopesSupported: [String]
    }

    /// 动态注册拿到的客户端。
    struct RegisteredClient: Equatable {
        var clientId: String
        var clientSecret: String?
    }

    enum DiscoveryError: Error, Equatable {
        case invalidServerURL
        case noMetadata
        case insecureEndpoint
        case issuerMismatch
        case pkceUnsupported
        case registrationUnsupported
        case registrationRejected
    }

    static let maxMetadataBytes = 256 * 1024
    static let clientName = "LeoBot"

    // MARK: - URL 构造

    /// MCP 服务器 URL 的规范形式:https、去掉 query/fragment。非 https 返回 nil。
    static func httpsURL(_ raw: String?) -> URL? {
        guard let raw = raw?.trimmingCharacters(in: .whitespacesAndNewlines), !raw.isEmpty,
              var comps = URLComponents(string: raw), comps.scheme?.lowercased() == "https",
              let host = comps.host, !host.isEmpty else { return nil }
        comps.query = nil
        comps.fragment = nil
        return comps.url
    }

    /// RFC 9728 §3.1:把 `/.well-known/oauth-protected-resource` 插在主机和路径之间;
    /// 路径非空时再补一个根路径的地址。
    static func protectedResourceMetadataURLs(serverURL: URL) -> [URL] {
        wellKnownURLs(for: serverURL, suffix: "oauth-protected-resource")
    }

    /// RFC 8414 §3.1(路径插入)优先,然后是 OpenID Connect Discovery 的两种写法。
    static func authorizationServerMetadataURLs(issuer: URL) -> [URL] {
        var urls = wellKnownURLs(for: issuer, suffix: "oauth-authorization-server", includeRoot: false)
        urls += wellKnownURLs(for: issuer, suffix: "openid-configuration", includeRoot: false)
        let path = trimmedPath(issuer)
        if !path.isEmpty, var comps = URLComponents(url: issuer, resolvingAgainstBaseURL: false) {
            comps.path = path + "/.well-known/openid-configuration"
            comps.query = nil
            comps.fragment = nil
            if let u = comps.url { urls.append(u) }
        }
        if !path.isEmpty {
            // 没有路径段的根地址作为最后的尝试(很多服务器只在根上发布)。
            urls += wellKnownURLs(for: origin(issuer) ?? issuer, suffix: "oauth-authorization-server", includeRoot: false)
        }
        return dedupe(urls)
    }

    private static func wellKnownURLs(for url: URL, suffix: String, includeRoot: Bool = true) -> [URL] {
        guard var comps = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return [] }
        comps.query = nil
        comps.fragment = nil
        let path = trimmedPath(url)
        var result: [URL] = []
        comps.path = "/.well-known/\(suffix)" + path
        if let u = comps.url { result.append(u) }
        if includeRoot, !path.isEmpty {
            comps.path = "/.well-known/\(suffix)"
            if let u = comps.url { result.append(u) }
        }
        return result
    }

    private static func trimmedPath(_ url: URL) -> String {
        var path = URLComponents(url: url, resolvingAgainstBaseURL: false)?.path ?? ""
        while path.hasSuffix("/") { path.removeLast() }
        return path
    }

    /// scheme://host[:port],没有路径。
    static func origin(_ url: URL) -> URL? {
        guard var comps = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return nil }
        comps.path = ""
        comps.query = nil
        comps.fragment = nil
        comps.user = nil
        comps.password = nil
        return comps.url
    }

    private static func dedupe(_ urls: [URL]) -> [URL] {
        var seen = Set<String>()
        return urls.filter { seen.insert($0.absoluteString).inserted }
    }

    // MARK: - 解析

    /// RFC 9728 受保护资源元数据 → 声明的授权服务器(只要 https)与建议的 scopes。
    static func parseProtectedResource(_ data: Data) -> (authorizationServers: [URL], scopes: [String])? {
        guard data.count <= maxMetadataBytes,
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        let servers = (obj["authorization_servers"] as? [String] ?? []).compactMap { httpsURL($0) }
        guard !servers.isEmpty else { return nil }
        let scopes = (obj["scopes_supported"] as? [String] ?? []).filter { !$0.isEmpty }
        return (servers, scopes)
    }

    /// RFC 8414 授权服务器元数据。`issuer` 必须与我们请求的签发者一致(§3.3),所有端点必须 https,
    /// 声明了 `code_challenge_methods_supported` 时必须包含 S256(PKCE 是 MCP 授权的硬要求)。
    static func parseServerMetadata(_ data: Data, expectedIssuer: URL) throws -> ServerMetadata {
        guard data.count <= maxMetadataBytes,
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let authorization = obj["authorization_endpoint"] as? String,
              let token = obj["token_endpoint"] as? String else { throw DiscoveryError.noMetadata }
        let issuer = (obj["issuer"] as? String) ?? ""
        guard normalizeIssuer(issuer) == normalizeIssuer(expectedIssuer.absoluteString) else {
            throw DiscoveryError.issuerMismatch
        }
        guard httpsURL(authorization) != nil, httpsURL(token) != nil else { throw DiscoveryError.insecureEndpoint }
        var registration: String?
        if let reg = obj["registration_endpoint"] as? String {
            guard httpsURL(reg) != nil else { throw DiscoveryError.insecureEndpoint }
            registration = reg
        }
        if let methods = obj["code_challenge_methods_supported"] as? [String], !methods.contains("S256") {
            throw DiscoveryError.pkceUnsupported
        }
        return ServerMetadata(issuer: issuer, authorizationEndpoint: authorization, tokenEndpoint: token,
                              registrationEndpoint: registration,
                              scopesSupported: (obj["scopes_supported"] as? [String] ?? []).filter { !$0.isEmpty })
    }

    static func normalizeIssuer(_ raw: String) -> String {
        var s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        while s.hasSuffix("/") { s.removeLast() }
        return s.lowercased()
    }

    /// 旧版 MCP 规范(2025-03-26):服务器既不发布受保护资源元数据也不发布授权服务器元数据时,
    /// 授权端点默认在服务器自己的主机上。
    static func legacyDefaultMetadata(serverURL: URL) -> ServerMetadata? {
        guard let base = origin(serverURL)?.absoluteString else { return nil }
        return ServerMetadata(issuer: base, authorizationEndpoint: base + "/authorize", tokenEndpoint: base + "/token",
                              registrationEndpoint: base + "/register", scopesSupported: [])
    }

    // MARK: - RFC 7591 动态注册

    /// 公共客户端(原生应用)注册:不要 client_secret,走 PKCE。
    static func registrationBody(redirectURI: String, scope: String?) -> [String: Any] {
        var body: [String: Any] = [
            "client_name": clientName,
            "redirect_uris": [redirectURI],
            "grant_types": ["authorization_code", "refresh_token"],
            "response_types": ["code"],
            "token_endpoint_auth_method": "none",
        ]
        if let scope, !scope.trimmingCharacters(in: .whitespaces).isEmpty { body["scope"] = scope }
        return body
    }

    static func parseRegistration(_ data: Data) throws -> RegisteredClient {
        guard data.count <= maxMetadataBytes,
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let id = (obj["client_id"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines),
              !id.isEmpty, id.count <= 512 else { throw DiscoveryError.registrationRejected }
        let secret = (obj["client_secret"] as? String).flatMap { $0.isEmpty ? nil : $0 }
        return RegisteredClient(clientId: id, clientSecret: secret)
    }

    /// 这个配置是否需要先自动发现:没填 Client ID,或端点缺一个。
    static func needsDiscovery(clientId: String, authorizationEndpoint: String, tokenEndpoint: String) -> Bool {
        clientId.trimmingCharacters(in: .whitespaces).isEmpty
            || authorizationEndpoint.trimmingCharacters(in: .whitespaces).isEmpty
            || tokenEndpoint.trimmingCharacters(in: .whitespaces).isEmpty
    }
}
