//
//  WatchAgentLoop.swift
//  LeoWatch
//
//  [T-watch-stream][T-watch-skills] One direct answer from the wrist: stream
//  the model's reply as it is written, and when the model asks for one of the
//  phone-shared tools (web search, maps…), run it here and feed the result
//  back — a few rounds at most, then the answer. Foundation only, so a Mac
//  harness can drive it against local mock servers.
//

import Foundation

enum WatchStandaloneError: LocalizedError {
    case notConfigured(String)
    case http(Int, String)
    case emptyReply
    case network(String)
    /// The provider reported an error inside a stream it had already started.
    case stream(String)

    var errorDescription: String? {
        switch self {
        case .notConfigured(let reason):
            return reason
        case .http(let status, let detail):
            switch status {
            case 401, 403: return "API Key 无效或没有权限。请在 iPhone 上检查这个模型的服务商。"
            case 404: return "模型或接口地址不存在（\(detail)）。"
            case 429: return "请求太频繁，或额度已用完。稍后再试。"
            case 500...599: return "模型服务暂时不可用（\(status)）。"
            default: return "请求失败（\(status)）\(detail.isEmpty ? "" : "：\(detail)")"
            }
        case .emptyReply:
            return "模型没有返回文字。"
        case .network(let detail):
            // The watch may be riding a nearby iPhone's connection, and there
            // is no API to force its own cellular or Wi-Fi (TN3135).
            return "网络不可用（\(detail)）。手表离开 iPhone 时要靠自己的蜂窝或 Wi-Fi；答案会在联网后送到通知里。"
        case .stream(let detail):
            return "模型回答到一半出错了：\(detail.prefix(80))"
        }
    }
}

struct WatchModelEndpoint: Equatable {
    let format: String          // "openai" | "anthropic"
    let endpoint: String
    let model: String
    let apiKey: String
    let userAgent: String
    /// Send `max_tokens` (OpenRouter, Mistral, pre-1.45 configs) instead of `max_completion_tokens`.
    let legacyMaxTokens: Bool
}

enum WatchAgentEvent: Equatable {
    /// The answer so far in model round `round` (a round restarts after a tool call).
    case text(String, round: Int)
    /// What is happening right now ("正在搜索「…」").
    case step(String)
}

struct WatchAgentLoop {
    let endpoint: WatchModelEndpoint
    let tools: [WatchMCPTool]
    let servers: [WatchMCPServer]
    let mcp: WatchMCPClient
    let session: URLSession
    let systemPrompt: String
    var maxToolRounds = 3
    var maxTokens = 2000
    static let toolResultLimit = 6000

    func run(question: String, history: [(question: String, answer: String)],
             onEvent: @escaping (WatchAgentEvent) -> Void) async throws -> String {
        var taken = Set<String>()
        var routes: [String: WatchMCPTool] = [:]
        var toolDefinitions: [[String: Any]] = []
        for tool in tools {
            let name = WatchToolNaming.modelName(server: tool.server, tool: tool.name, taken: taken)
            taken.insert(name)
            routes[name] = tool
            let schema = Self.object(tool.inputSchema).isEmpty
                ? ["type": "object", "properties": [String: Any]()] : Self.object(tool.inputSchema)
            if endpoint.format == "anthropic" {
                toolDefinitions.append(["name": name, "description": tool.description, "input_schema": schema])
            } else {
                toolDefinitions.append(["type": "function",
                                        "function": ["name": name, "description": tool.description, "parameters": schema]])
            }
        }

        var messages: [[String: Any]] = []
        if endpoint.format != "anthropic" { messages.append(["role": "system", "content": systemPrompt]) }
        for pair in history {
            messages.append(["role": "user", "content": pair.question])
            messages.append(["role": "assistant", "content": pair.answer])
        }
        messages.append(["role": "user", "content": question])

        var answer = ""
        for round in 0...maxToolRounds {
            try Task.checkCancellation()
            let offerTools = !toolDefinitions.isEmpty && round < maxToolRounds
            let reply = try await streamRound(messages: messages, tools: offerTools ? toolDefinitions : [],
                                              round: round, onEvent: onEvent)
            let text = reply.text.trimmingCharacters(in: .whitespacesAndNewlines)
            if !text.isEmpty { answer = text }
            let calls = reply.toolCalls.filter { !$0.name.isEmpty }.enumerated().map { index, call -> WatchToolCall in
                var call = call
                if call.id.isEmpty { call.id = "call_\(round)_\(index)" }
                if call.arguments.trimmingCharacters(in: .whitespaces).isEmpty { call.arguments = "{}" }
                return call
            }
            guard offerTools, !calls.isEmpty else { break }

            // The assistant turn that asked for the tools, then their results.
            if endpoint.format == "anthropic" {
                var content: [[String: Any]] = text.isEmpty ? [] : [["type": "text", "text": text]]
                for call in calls {
                    content.append(["type": "tool_use", "id": call.id, "name": call.name, "input": Self.object(call.arguments)])
                }
                messages.append(["role": "assistant", "content": content])
            } else {
                messages.append([
                    "role": "assistant",
                    "content": text.isEmpty ? NSNull() : text,
                    "tool_calls": calls.map { call in
                        ["id": call.id, "type": "function", "function": ["name": call.name, "arguments": call.arguments]]
                    },
                ])
            }
            var anthropicResults: [[String: Any]] = []
            for call in calls {
                try Task.checkCancellation()
                let tool = routes[call.name]
                onEvent(.step(WatchToolStep.label(tool: tool?.name ?? call.name, arguments: call.arguments)))
                var output: String
                if let tool, let server = servers.first(where: { $0.id == tool.server }) {
                    do {
                        output = try await mcp.callTool(server, name: tool.name, arguments: Self.object(call.arguments))
                    } catch is CancellationError {
                        throw CancellationError()
                    } catch {
                        output = "工具调用失败：\(error.localizedDescription)"
                    }
                } else {
                    output = "没有这个工具：\(call.name)"
                }
                if output.count > Self.toolResultLimit { output = String(output.prefix(Self.toolResultLimit)) + "\n…（已截断）" }
                if endpoint.format == "anthropic" {
                    anthropicResults.append(["type": "tool_result", "tool_use_id": call.id, "content": output])
                } else {
                    messages.append(["role": "tool", "tool_call_id": call.id, "content": output])
                }
            }
            if endpoint.format == "anthropic" { messages.append(["role": "user", "content": anthropicResults]) }
            onEvent(.step("正在整理答案"))
        }
        guard !answer.isEmpty else { throw WatchStandaloneError.emptyReply }
        return Self.plain(answer)
    }

    // MARK: - One streamed request

    private func streamRound(messages: [[String: Any]], tools: [[String: Any]], round: Int,
                             onEvent: @escaping (WatchAgentEvent) -> Void) async throws -> (text: String, toolCalls: [WatchToolCall]) {
        let request = try makeRequest(messages: messages, tools: tools)
        let bytes: URLSession.AsyncBytes
        let response: URLResponse
        do {
            (bytes, response) = try await session.bytes(for: request)
        } catch {
            throw Self.mapTransport(error)
        }
        let http = response as? HTTPURLResponse
        let status = http?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            var body = Data()
            do {
                for try await byte in bytes {
                    body.append(byte)
                    if body.count > 4096 { break }
                }
            } catch {}
            throw WatchStandaloneError.http(status, Self.errorDetail(from: body))
        }

        // An endpoint that ignored `stream: true` answers with one JSON body.
        let contentType = (http?.value(forHTTPHeaderField: "Content-Type") ?? "").lowercased()
        guard contentType.contains("text/event-stream") else {
            var body = Data()
            do {
                for try await byte in bytes { body.append(byte) }
            } catch {
                throw Self.mapTransport(error)
            }
            let whole = WatchModelResponse.parse(body, format: endpoint.format)
            if !whole.text.isEmpty { onEvent(.text(Self.plain(whole.text), round: round)) }
            return whole
        }

        var parser = WatchModelStreamParser(format: endpoint.format)
        var emitted = ""
        var lastEmit = Date.distantPast
        do {
            for try await line in bytes.lines {
                parser.consume(line: line)
                // ~8 updates a second, plus every finished sentence: smooth on
                // the wrist without re-rendering on every token.
                let endsSentence = parser.text.last.map { "。！？!?\n".contains($0) } ?? false
                if parser.text != emitted, endsSentence || Date().timeIntervalSince(lastEmit) >= 0.12 {
                    emitted = parser.text
                    lastEmit = Date()
                    onEvent(.text(Self.plain(emitted), round: round))
                }
                if parser.done { break }
            }
        } catch {
            throw Self.mapTransport(error)
        }
        if let error = parser.streamError { throw WatchStandaloneError.stream(error) }
        if parser.text != emitted { onEvent(.text(Self.plain(parser.text), round: round)) }
        return (parser.text, parser.toolCalls)
    }

    private func makeRequest(messages: [[String: Any]], tools: [[String: Any]]) throws -> URLRequest {
        guard let url = URL(string: endpoint.endpoint) else { throw WatchStandaloneError.notConfigured("接口地址无效。") }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = 60
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        if !endpoint.userAgent.isEmpty { request.setValue(endpoint.userAgent, forHTTPHeaderField: "User-Agent") }
        var body: [String: Any]
        if endpoint.format == "anthropic" {
            request.setValue(endpoint.apiKey, forHTTPHeaderField: "x-api-key")
            request.setValue("2023-06-01", forHTTPHeaderField: "anthropic-version")
            body = ["model": endpoint.model, "max_tokens": maxTokens, "system": systemPrompt,
                    "messages": messages, "stream": true]
            if !tools.isEmpty { body["tools"] = tools }
        } else {
            request.setValue("Bearer \(endpoint.apiKey)", forHTTPHeaderField: "Authorization")
            // GPT-5 / o-series reject `max_tokens`; OpenRouter and Mistral reject the newer name.
            let tokenParam = endpoint.legacyMaxTokens ? "max_tokens" : "max_completion_tokens"
            body = ["model": endpoint.model, tokenParam: maxTokens, "stream": true, "messages": messages]
            if !tools.isEmpty {
                body["tools"] = tools
                body["tool_choice"] = "auto"
            }
        }
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        return request
    }

    // MARK: - Helpers

    private static func mapTransport(_ error: Error) -> Error {
        if error is CancellationError { return CancellationError() }
        if let urlError = error as? URLError, urlError.code == .cancelled { return CancellationError() }
        if error is WatchStandaloneError { return error }
        return WatchStandaloneError.network(error.localizedDescription)
    }

    static func object(_ json: String) -> [String: Any] {
        guard let data = json.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return [:] }
        return object
    }

    static func errorDetail(from data: Data) -> String {
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return "" }
        if let error = json["error"] as? [String: Any], let message = error["message"] as? String {
            return String(message.prefix(80))
        }
        return String(((json["message"] as? String) ?? "").prefix(80))
    }

    /// Models answer in Markdown even when asked not to; a 45 mm screen shows
    /// the raw markers. Flatten the common ones.
    static func plain(_ text: String) -> String {
        var out = text
        for marker in ["**", "__", "`"] { out = out.replacingOccurrences(of: marker, with: "") }
        out = out.replacingOccurrences(of: "(?m)^\\s*#{1,6}\\s*", with: "", options: .regularExpression)
        out = out.replacingOccurrences(of: "(?m)^(\\s*)[-*+]\\s+", with: "$1· ", options: .regularExpression)
        return out.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
