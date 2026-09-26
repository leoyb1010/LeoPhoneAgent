//
//  WatchMCPClient.swift
//  LeoWatch
//
//  [T-watch-skills] Lets the wrist use the phone's remote tools — web search,
//  maps, weather — when it answers on its own. The phone shares its enabled
//  HTTP MCP servers with credentials already filled in (OAuth and stdio
//  servers stay phone-only); this is the same streamable-HTTP handling as the
//  phone's NativeMCPClient: initialize → tools/list → tools/call, session ids,
//  JSON or SSE replies, one re-handshake when a server forgets the session.
//

import Foundation

/// A remote MCP server the phone shared. `url` / `headers` are resolved and may
/// carry a key, so the list lives in the watch Keychain, never in defaults.
struct WatchMCPServer: Codable, Equatable {
    let id: String
    let url: String
    let headers: [String: String]
}

/// One tool as the model sees it. Descriptions and schemas are not secret.
struct WatchMCPTool: Codable, Equatable {
    let server: String
    let name: String
    let description: String
    /// JSON Schema of the arguments, as JSON text.
    let inputSchema: String
}

enum WatchMCPError: LocalizedError {
    case badURL
    case http(Int)
    case rpc(String)
    case malformed(String)

    var errorDescription: String? {
        switch self {
        case .badURL: return "工具地址无效"
        case .http(let status): return "工具服务返回 \(status)"
        case .rpc(let message): return "工具出错：\(message.prefix(120))"
        case .malformed(let detail): return "工具返回无法解析（\(detail.prefix(60))）"
        }
    }
}

actor WatchMCPClient {
    static let shared = WatchMCPClient()

    private let session: URLSession
    private var sessionIDs: [String: String] = [:]
    private var initialized: Set<String> = []
    private var requestCounter = 0
    private let protocolVersion = "2025-06-18"

    init(session: URLSession? = nil) {
        if let session {
            self.session = session
        } else {
            let configuration = URLSessionConfiguration.default
            configuration.timeoutIntervalForRequest = 20
            configuration.waitsForConnectivity = false
            self.session = URLSession(configuration: configuration)
        }
    }

    func listTools(_ server: WatchMCPServer) async throws -> [WatchMCPTool] {
        try await initializeIfNeeded(server)
        let result = try await send(server, method: "tools/list", params: [:])
        guard let tools = result["tools"] as? [[String: Any]] else { throw WatchMCPError.malformed("no tools") }
        return tools.compactMap { tool in
            guard let name = tool["name"] as? String else { return nil }
            let schema = (tool["inputSchema"] as? [String: Any]) ?? ["type": "object", "properties": [String: Any]()]
            let schemaText = (try? JSONSerialization.data(withJSONObject: schema)).flatMap { String(data: $0, encoding: .utf8) }
            return WatchMCPTool(server: server.id, name: name,
                                description: String(((tool["description"] as? String) ?? "").prefix(1000)),
                                inputSchema: schemaText ?? "{\"type\":\"object\"}")
        }
    }

    /// The tool's text output (content parts joined), or the raw result JSON.
    func callTool(_ server: WatchMCPServer, name: String, arguments: [String: Any]) async throws -> String {
        try await initializeIfNeeded(server)
        let result = try await send(server, method: "tools/call", params: ["name": name, "arguments": arguments])
        if let content = result["content"] as? [[String: Any]] {
            let text = content.compactMap { item -> String? in
                if let value = item["text"] as? String { return value }
                if let type = item["type"] as? String { return "[\(type)]" }
                return nil
            }.joined(separator: "\n")
            if (result["isError"] as? Bool) == true { throw WatchMCPError.rpc(text.isEmpty ? "tool error" : text) }
            if !text.isEmpty { return text }
        }
        let raw = (try? JSONSerialization.data(withJSONObject: result)).flatMap { String(data: $0, encoding: .utf8) }
        return raw ?? ""
    }

    /// Forget a server's session (its config changed, or it was removed).
    func reset(_ id: String) {
        sessionIDs.removeValue(forKey: id)
        initialized.remove(id)
    }

    // MARK: - Internals

    private func initializeIfNeeded(_ server: WatchMCPServer) async throws {
        guard !initialized.contains(server.id) else { return }
        _ = try await send(server, method: "initialize", params: [
            "protocolVersion": protocolVersion,
            "capabilities": [String: Any](),
            "clientInfo": ["name": "LeoPhoneAgent Watch", "version": "1.0"],
        ], isInitialize: true)
        // Official-SDK servers reject everything until this third leg arrives.
        if await notify(server, method: "notifications/initialized") {
            initialized.insert(server.id)
        }
    }

    private func request(_ server: WatchMCPServer, body: [String: Any]) throws -> URLRequest {
        guard let url = URL(string: server.url), url.scheme == "https" || url.scheme == "http" else {
            throw WatchMCPError.badURL
        }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json, text/event-stream", forHTTPHeaderField: "Accept")
        request.setValue(protocolVersion, forHTTPHeaderField: "MCP-Protocol-Version")
        if let id = sessionIDs[server.id] { request.setValue(id, forHTTPHeaderField: "Mcp-Session-Id") }
        for (key, value) in server.headers { request.setValue(value, forHTTPHeaderField: key) }
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        return request
    }

    /// JSON-RPC notification. Network errors count as accepted so a flaky link
    /// doesn't force a handshake on every call.
    private func notify(_ server: WatchMCPServer, method: String) async -> Bool {
        guard let request = try? request(server, body: ["jsonrpc": "2.0", "method": method, "params": [String: Any]()]),
              let (_, response) = try? await session.data(for: request),
              let http = response as? HTTPURLResponse else { return true }
        return (200..<300).contains(http.statusCode)
    }

    private func send(_ server: WatchMCPServer, method: String, params: [String: Any],
                      isInitialize: Bool = false, isRetry: Bool = false) async throws -> [String: Any] {
        requestCounter += 1
        let request = try request(server, body: ["jsonrpc": "2.0", "id": requestCounter, "method": method, "params": params])
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw WatchMCPError.malformed("no HTTP response") }
        if let id = http.value(forHTTPHeaderField: "Mcp-Session-Id"), !id.isEmpty { sessionIDs[server.id] = id }
        // A restarted server no longer knows our session: handshake again, once.
        if http.statusCode == 404, !isRetry, sessionIDs[server.id] != nil {
            reset(server.id)
            try await initializeIfNeeded(server)
            return try await send(server, method: method, params: params, isInitialize: isInitialize, isRetry: true)
        }
        guard (200..<300).contains(http.statusCode) else { throw WatchMCPError.http(http.statusCode) }

        let contentType = (http.value(forHTTPHeaderField: "Content-Type") ?? "").lowercased()
        let envelope: [String: Any]
        if contentType.contains("text/event-stream") {
            guard let parsed = WatchMCPEnvelope.firstJSON(fromSSE: data) else {
                throw WatchMCPError.malformed("SSE without a JSON-RPC message")
            }
            envelope = parsed
        } else {
            guard let parsed = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                throw WatchMCPError.malformed(String(data: data.prefix(80), encoding: .utf8) ?? "non-JSON")
            }
            envelope = parsed
        }
        if let error = envelope["error"] as? [String: Any] {
            throw WatchMCPError.rpc((error["message"] as? String) ?? "error")
        }
        guard let result = envelope["result"] as? [String: Any] else {
            if isInitialize { return [:] }
            throw WatchMCPError.malformed("no result")
        }
        return result
    }
}
