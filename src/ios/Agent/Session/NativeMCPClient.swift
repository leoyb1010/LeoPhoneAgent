//
//  NativeMCPClient.swift
//  MinisApp
//
//  [T-native-mcp] In-process MCP client for HTTP-family servers.
//
//  Until now every MCP call went through the in-guest Python CLI
//  (`/usr/local/lib/leophoneagent-mcp-cli`). That path is fine for stdio
//  servers — those genuinely need a local process — but for a REMOTE server
//  it drags in a pile of failure modes that have nothing to do with MCP:
//  the iSH kernel has to be booted, Alpine has to have python3, pip has to
//  have fetched httpx, and the rootfs layout has to be exactly right (a
//  rename of that directory broke every MCP call once already).
//
//  MCP over HTTP is just JSON-RPC 2.0 with an SSE-or-JSON response, so the
//  native path needs no third-party package: URLSession is enough. Servers
//  reachable this way work with the kernel cold and Python absent.
//
//  Scope is deliberate: `initialize` → `tools/list` → `tools/call`. Anything
//  stateful (prompts, resources, sampling, stdio) stays with the CLI.
//

import Foundation

private let logger = AppLogger(category: "NativeMCP")

actor NativeMCPClient {
    static let shared = NativeMCPClient()

    struct ToolDescriptor {
        let name: String
        let description: String
    }

    enum ClientError: LocalizedError {
        case notHTTPTransport
        case badURL(String)
        case http(Int, String)
        case rpc(String)
        case malformed(String)
        /// 401/403 on a server that has OAuth configured — carries the same
        /// tappable Authorize link the in-guest transport emits.
        case authRequired(server: String, detail: String)
        /// The URL or a header still contains an unresolved `$$NAME`.
        case missingEnvVar(names: [String])

        var errorDescription: String? {
            switch self {
            case .notHTTPTransport:
                return "This MCP server is not an HTTP server."
            case .badURL(let u):
                return "Invalid MCP server URL: \(u)"
            case .http(let code, let body):
                return "MCP server returned HTTP \(code): \(body.prefix(200))"
            case .rpc(let message):
                return "MCP error: \(message)"
            case .malformed(let detail):
                return "Unexpected MCP response: \(detail)"
            case .authRequired(let server, let detail):
                return "AUTH_REQUIRED: '\(server)' rejected the request (\(detail.prefix(120))). "
                    + MCPOAuthController.authorizeDeepLink(server: server)
            case .missingEnvVar(let names):
                let list = names.joined(separator: ", ")
                return "MCP server config references undefined App environment variable(s): \(list). "
                    + "Add them in Settings → Environment Variables, or replace $$NAME with a literal value."
            }
        }
    }

    /// Sessions the server handed us via `Mcp-Session-Id`, keyed by server id.
    /// Stateless servers simply never populate this.
    private var sessionIDs: [String: String] = [:]
    /// Servers whose three-leg handshake has completed. Tracked separately
    /// from `sessionIDs` because a stateless server never issues a session id
    /// yet still must not be re-initialized on every call.
    private var initialized: Set<String> = []
    private var requestCounter = 0

    private let protocolVersion = "2025-06-18"

    // MARK: - Public

    /// True when this config can be served natively. stdio servers still need
    /// the in-guest CLI.
    nonisolated static func canHandle(_ config: MCPServerConfig) -> Bool {
        config.isHTTP && !(config.url ?? "").isEmpty
    }

    func listTools(server config: MCPServerConfig) async throws -> [ToolDescriptor] {
        guard Self.canHandle(config) else { throw ClientError.notHTTPTransport }
        try await initializeIfNeeded(config)
        let result = try await send(config, method: "tools/list", params: [:])
        guard let tools = result["tools"] as? [[String: Any]] else {
            throw ClientError.malformed("tools/list had no `tools` array")
        }
        return tools.compactMap { t in
            guard let name = t["name"] as? String else { return nil }
            return ToolDescriptor(name: name, description: (t["description"] as? String) ?? "")
        }
    }

    func callTool(
        server config: MCPServerConfig,
        tool: String,
        arguments: [String: Any]
    ) async throws -> String {
        guard Self.canHandle(config) else { throw ClientError.notHTTPTransport }
        try await initializeIfNeeded(config)
        let result = try await send(config, method: "tools/call", params: [
            "name": tool,
            "arguments": arguments,
        ])
        // Per spec the payload is a content array; flatten the text parts,
        // and fall back to the raw JSON so nothing is silently dropped.
        if let content = result["content"] as? [[String: Any]] {
            let text = content.compactMap { item -> String? in
                if let t = item["text"] as? String { return t }
                if let type = item["type"] as? String { return "[\(type) content]" }
                return nil
            }.joined(separator: "\n")
            if !text.isEmpty { return text }
        }
        if let data = try? JSONSerialization.data(withJSONObject: result, options: [.prettyPrinted]),
           let s = String(data: data, encoding: .utf8) {
            return s
        }
        return String(describing: result)
    }

    /// Drop cached session state (used by the force-refresh path).
    func reset(server id: String) {
        sessionIDs.removeValue(forKey: id)
        initialized.remove(id)
    }

    // MARK: - Internals

    /// URL + headers with `$$NAME` / `$NAME` / `${NAME}` placeholders replaced
    /// by App environment variables.
    ///
    /// The app tells the agent to configure servers this way (see
    /// `MCPStore.systemPromptSnippet`) and the MCP form has a button that
    /// inserts `$$NAME`, so this is the *primary* way credentials get into a
    /// server entry. The in-guest transport has always expanded them
    /// (`transport/http.py: expand_env`); the native path sending `$$KEY`
    /// literally is why hosted servers answered 401.
    private static func resolve(_ config: MCPServerConfig) throws -> (url: String, headers: [String: String]) {
        var missing: [String] = []
        let url = expand(config.url ?? "", missing: &missing)
        var headers: [String: String] = [:]
        for (key, value) in config.headers ?? [:] {
            headers[key] = expand(value, missing: &missing)
        }
        if !missing.isEmpty {
            throw ClientError.missingEnvVar(names: Array(Set(missing)).sorted())
        }
        return (url, headers)
    }

    /// Mirrors the CLI's regex `\$\$?\{?([A-Za-z_][A-Za-z0-9_]*)\}?`.
    private static let envPlaceholder = try? NSRegularExpression(
        pattern: "\\$\\$?\\{?([A-Za-z_][A-Za-z0-9_]*)\\}?"
    )

    private static func expand(_ value: String, missing: inout [String]) -> String {
        guard value.contains("$"), let regex = envPlaceholder else { return value }
        let ns = value as NSString
        var out = ""
        var cursor = 0
        for match in regex.matches(in: value, range: NSRange(location: 0, length: ns.length)) {
            out += ns.substring(with: NSRange(location: cursor, length: match.range.location - cursor))
            let name = ns.substring(with: match.range(at: 1))
            if let resolved = EnvVarStore.loadValueSync(forKey: name) {
                out += resolved
            } else {
                missing.append(name)
            }
            cursor = match.range.location + match.range.length
        }
        out += ns.substring(from: cursor)
        return out
    }

    /// In-flight initializations, so two concurrent calls on this actor don't
    /// both run the handshake across the suspension points and leak a session
    /// on stateful servers. [T-native-mcp-reentrancy]
    private var initInFlight: [String: Task<Void, Error>] = [:]

    private func initializeIfNeeded(_ config: MCPServerConfig) async throws {
        guard !initialized.contains(config.id) else { return }
        if let running = initInFlight[config.id] {
            return try await running.value
        }
        let task = Task { try await self.performInitialize(config) }
        initInFlight[config.id] = task
        defer { initInFlight[config.id] = nil }
        try await task.value
    }

    private func performInitialize(_ config: MCPServerConfig) async throws {
        // Let a real failure out: swallowing it here only surfaced later as a
        // confusing second error on tools/list.
        _ = try await send(config, method: "initialize", params: [
            "protocolVersion": protocolVersion,
            "capabilities": ["tools": [String: Any]()],
            "clientInfo": ["name": "LeoPhoneAgent", "version": Self.appVersion],
        ], isInitialize: true)
        // Third leg of the handshake. Servers built on the official SDKs
        // reject every subsequent request with "Server not initialized"
        // without it; the in-guest transport has always sent it.
        // [T-native-mcp-init-honest] Only mark the server initialized when the
        // notification was ACCEPTED — swallowing a 4xx here left `initialized`
        // set while a strict server kept answering "not initialized" forever.
        let accepted = await sendNotification(config, method: "notifications/initialized")
        if accepted {
            initialized.insert(config.id)
        } else {
            logger.warning("notifications/initialized not accepted by \(config.id) — will re-handshake on next call")
        }
    }

    /// JSON-RPC notification: no `id`, no response body to parse. A compliant
    /// server answers 202 (or 200) with an empty body. Returns whether the
    /// server accepted it; network errors count as accepted so a flaky link
    /// doesn't force an endless re-handshake loop.
    @discardableResult
    private func sendNotification(_ config: MCPServerConfig, method: String) async -> Bool {
        guard let resolved = try? Self.resolve(config), let url = URL(string: resolved.url) else {
            return false
        }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = 30
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json, text/event-stream", forHTTPHeaderField: "Accept")
        request.setValue(protocolVersion, forHTTPHeaderField: "MCP-Protocol-Version")
        if let session = sessionIDs[config.id] {
            request.setValue(session, forHTTPHeaderField: "Mcp-Session-Id")
        }
        for (key, value) in resolved.headers { request.setValue(value, forHTTPHeaderField: key) }
        if let oauth = config.oauth,
           let token = await MCPOAuthController.validAccessToken(server: config.id, oauth: oauth) {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        guard let body = try? JSONSerialization.data(withJSONObject: [
            "jsonrpc": "2.0", "method": method, "params": [String: Any](),
        ]) else { return false }
        request.httpBody = body
        guard let (_, response) = try? await URLSession.shared.data(for: request) else {
            return true   // network hiccup — don't force a re-handshake loop
        }
        guard let http = response as? HTTPURLResponse else { return true }
        return (200..<300).contains(http.statusCode)
    }

    private static var appVersion: String {
        (Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String) ?? "1.0"
    }

    private func nextID() -> Int {
        requestCounter += 1
        return requestCounter
    }

    private func send(
        _ config: MCPServerConfig,
        method: String,
        params: [String: Any],
        isInitialize: Bool = false,
        isRetryAfterAuthRefresh: Bool = false
    ) async throws -> [String: Any] {
        let resolved = try Self.resolve(config)
        guard let url = URL(string: resolved.url) else {
            // [T-secret-in-error] The RESOLVED url carries expanded credentials
            // and this error text ends up in chat and the exportable log —
            // report the configured (unexpanded) form instead.
            throw ClientError.badURL(config.url ?? "")
        }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = 60
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        // Accept both shapes — a spec-compliant server may answer a POST with
        // either a JSON body or an SSE stream.
        request.setValue("application/json, text/event-stream", forHTTPHeaderField: "Accept")
        request.setValue(protocolVersion, forHTTPHeaderField: "MCP-Protocol-Version")
        if let session = sessionIDs[config.id] {
            request.setValue(session, forHTTPHeaderField: "Mcp-Session-Id")
        }
        for (key, value) in resolved.headers {
            request.setValue(value, forHTTPHeaderField: key)
        }
        // [T-native-mcp-oauth] Same credential the in-guest transport attaches.
        if let oauth = config.oauth,
           let token = await MCPOAuthController.validAccessToken(server: config.id, oauth: oauth) {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }

        let body: [String: Any] = [
            "jsonrpc": "2.0",
            "id": nextID(),
            "method": method,
            "params": params,
        ]
        request.httpBody = try JSONSerialization.data(withJSONObject: body)

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw ClientError.malformed("no HTTP response")
        }
        if let session = http.value(forHTTPHeaderField: "Mcp-Session-Id"), !session.isEmpty {
            sessionIDs[config.id] = session
        }
        // [T-native-mcp-selfheal] A restarted server no longer knows our
        // Mcp-Session-Id and answers 404 — clear the cached handshake and run
        // it again once instead of failing for the rest of the app's life.
        if http.statusCode == 404, !isRetryAfterAuthRefresh, sessionIDs[config.id] != nil {
            logger.info("session rejected by \(config.id) — re-handshaking")
            sessionIDs.removeValue(forKey: config.id)
            initialized.remove(config.id)
            try await initializeIfNeeded(config)
            return try await send(config, method: method, params: params,
                                  isInitialize: isInitialize, isRetryAfterAuthRefresh: true)
        }
        if http.statusCode == 401 || http.statusCode == 403 {
            let bodyText = String(data: data, encoding: .utf8) ?? ""
            if let oauth = config.oauth {
                // One forced refresh, then give up and tell the user how to
                // re-authorize — mirroring transport/http.py.
                if !isRetryAfterAuthRefresh,
                   await MCPOAuthController.refreshTokens(server: config.id, oauth: oauth) != nil {
                    return try await send(config, method: method, params: params,
                                          isInitialize: isInitialize,
                                          isRetryAfterAuthRefresh: true)
                }
                throw ClientError.authRequired(server: config.id, detail: bodyText)
            }
            throw ClientError.http(http.statusCode, bodyText)
        }
        guard (200..<300).contains(http.statusCode) else {
            throw ClientError.http(http.statusCode, String(data: data, encoding: .utf8) ?? "")
        }

        let contentType = (http.value(forHTTPHeaderField: "Content-Type") ?? "").lowercased()
        let envelope: [String: Any]
        if contentType.contains("text/event-stream") {
            guard let parsed = Self.firstJSONFromSSE(data) else {
                throw ClientError.malformed("SSE stream carried no JSON-RPC message")
            }
            envelope = parsed
        } else {
            guard let parsed = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                throw ClientError.malformed(String(data: data, encoding: .utf8)?.prefix(200).description ?? "non-JSON body")
            }
            envelope = parsed
        }

        if let error = envelope["error"] as? [String: Any] {
            let message = (error["message"] as? String) ?? String(describing: error)
            throw ClientError.rpc(message)
        }
        guard let result = envelope["result"] as? [String: Any] else {
            if isInitialize { return [:] }   // some servers answer initialize with a bare ack
            throw ClientError.malformed("no `result` in JSON-RPC envelope")
        }
        logger.info("\(method) ok server=\(config.id)")
        return result
    }

    /// Pulls the first `data:` payload that parses as a JSON-RPC envelope.
    /// A POST response stream carries the reply for that request, so the
    /// first well-formed message is the one we want.
    private static func firstJSONFromSSE(_ data: Data) -> [String: Any]? {
        guard let text = String(data: data, encoding: .utf8) else { return nil }
        for line in text.split(whereSeparator: \.isNewline) {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            guard trimmed.hasPrefix("data:") else { continue }
            let payload = trimmed.dropFirst(5).trimmingCharacters(in: .whitespaces)
            guard payload != "[DONE]", let d = payload.data(using: .utf8),
                  let obj = try? JSONSerialization.jsonObject(with: d) as? [String: Any] else { continue }
            if obj["result"] != nil || obj["error"] != nil { return obj }
        }
        return nil
    }
}
