//
//  WatchStreaming.swift
//  LeoWatch
//
//  [T-watch-stream] Pure helpers for streamed answers on the wrist: parsing a
//  model's SSE stream (text + tool calls), cutting a growing answer into
//  sentences that can be spoken the moment they are complete, and naming /
//  describing tools. No WatchKit — the same file compiles in a Mac test
//  harness, which is how the parsing is exercised end to end.
//

import Foundation

// MARK: - Model stream

/// One tool call the model asked for. `arguments` is the raw JSON text.
struct WatchToolCall: Equatable {
    var id: String
    var name: String
    var arguments: String
}

/// Incremental parser for one streamed model response: OpenAI Chat Completions
/// (`data: {choices:[{delta:…}]}` … `[DONE]`) or Anthropic Messages
/// (`content_block_*` / `message_*` events). Feed it every line.
struct WatchModelStreamParser {
    let format: String   // "openai" | "anthropic"
    private(set) var text = ""
    private(set) var toolCalls: [WatchToolCall] = []
    private(set) var finishReason: String?
    private(set) var done = false
    /// An error the provider put inside the stream (after a 200).
    private(set) var streamError: String?
    /// OpenAI `tool_calls[].index` → position in `toolCalls`.
    private var openAIIndex: [Int: Int] = [:]
    /// Anthropic content-block index → position in `toolCalls`.
    private var anthropicIndex: [Int: Int] = [:]

    init(format: String) { self.format = format }

    mutating func consume(line raw: String) {
        let line = raw.trimmingCharacters(in: .whitespaces)
        guard line.hasPrefix("data:") else { return }
        let payload = line.dropFirst(5).trimmingCharacters(in: .whitespaces)
        if payload == "[DONE]" {
            done = true
            return
        }
        guard let data = payload.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }
        if format == "anthropic" { consumeAnthropic(json) } else { consumeOpenAI(json) }
    }

    /// The model stopped to have tools run.
    var wantsTools: Bool { toolCalls.contains { !$0.name.isEmpty } }

    private mutating func consumeOpenAI(_ json: [String: Any]) {
        if let error = json["error"] as? [String: Any] {
            streamError = (error["message"] as? String) ?? "stream error"
            done = true
            return
        }
        guard let choice = (json["choices"] as? [[String: Any]])?.first else { return }
        if let delta = choice["delta"] as? [String: Any] {
            if let content = delta["content"] as? String { text += content }
            for call in (delta["tool_calls"] as? [[String: Any]]) ?? [] {
                let index = (call["index"] as? Int) ?? 0
                let position: Int
                if let known = openAIIndex[index] {
                    position = known
                } else {
                    toolCalls.append(WatchToolCall(id: "", name: "", arguments: ""))
                    position = toolCalls.count - 1
                    openAIIndex[index] = position
                }
                if let id = call["id"] as? String, !id.isEmpty { toolCalls[position].id = id }
                if let function = call["function"] as? [String: Any] {
                    // The name comes once; a provider repeating it must not double it.
                    if let name = function["name"] as? String, !name.isEmpty, toolCalls[position].name.isEmpty {
                        toolCalls[position].name = name
                    }
                    if let arguments = function["arguments"] as? String { toolCalls[position].arguments += arguments }
                }
            }
        }
        if let reason = choice["finish_reason"] as? String, !reason.isEmpty { finishReason = reason }
    }

    private mutating func consumeAnthropic(_ json: [String: Any]) {
        switch json["type"] as? String {
        case "content_block_start":
            let index = (json["index"] as? Int) ?? 0
            guard let block = json["content_block"] as? [String: Any] else { return }
            if block["type"] as? String == "tool_use" {
                toolCalls.append(WatchToolCall(id: (block["id"] as? String) ?? "",
                                               name: (block["name"] as? String) ?? "", arguments: ""))
                anthropicIndex[index] = toolCalls.count - 1
            } else if block["type"] as? String == "text", let start = block["text"] as? String {
                text += start
            }
        case "content_block_delta":
            let index = (json["index"] as? Int) ?? 0
            guard let delta = json["delta"] as? [String: Any] else { return }
            switch delta["type"] as? String {
            case "text_delta":
                text += (delta["text"] as? String) ?? ""
            case "input_json_delta":
                if let position = anthropicIndex[index] {
                    toolCalls[position].arguments += (delta["partial_json"] as? String) ?? ""
                }
            default:
                break
            }
        case "message_delta":
            if let delta = json["delta"] as? [String: Any], let reason = delta["stop_reason"] as? String {
                finishReason = reason
            }
        case "message_stop":
            done = true
        case "error":
            streamError = ((json["error"] as? [String: Any])?["message"] as? String) ?? "stream error"
            done = true
        default:
            break
        }
    }
}

/// A whole (non-streamed) response — for endpoints that ignore `stream: true`.
enum WatchModelResponse {
    static func parse(_ data: Data, format: String) -> (text: String, toolCalls: [WatchToolCall]) {
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return ("", []) }
        if format == "anthropic" {
            var text: [String] = []
            var calls: [WatchToolCall] = []
            for block in (json["content"] as? [[String: Any]]) ?? [] {
                switch block["type"] as? String {
                case "text":
                    if let value = block["text"] as? String { text.append(value) }
                case "tool_use":
                    let input = block["input"].flatMap { try? JSONSerialization.data(withJSONObject: $0) }
                    calls.append(WatchToolCall(id: (block["id"] as? String) ?? "", name: (block["name"] as? String) ?? "",
                                               arguments: input.flatMap { String(data: $0, encoding: .utf8) } ?? "{}"))
                default:
                    break
                }
            }
            return (text.joined(separator: "\n"), calls)
        }
        let message = ((json["choices"] as? [[String: Any]])?.first?["message"]) as? [String: Any]
        let calls = ((message?["tool_calls"] as? [[String: Any]]) ?? []).map { call -> WatchToolCall in
            let function = call["function"] as? [String: Any]
            return WatchToolCall(id: (call["id"] as? String) ?? "", name: (function?["name"] as? String) ?? "",
                                 arguments: (function?["arguments"] as? String) ?? "{}")
        }
        return ((message?["content"] as? String) ?? "", calls)
    }
}

// MARK: - MCP

enum WatchMCPEnvelope {
    /// The first `data:` payload that is a JSON-RPC response. A POST's SSE
    /// stream carries the reply for that request, so the first well-formed
    /// message is the one we want.
    static func firstJSON(fromSSE data: Data) -> [String: Any]? {
        guard let text = String(data: data, encoding: .utf8) else { return nil }
        for line in text.split(whereSeparator: \.isNewline) {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            guard trimmed.hasPrefix("data:") else { continue }
            let payload = trimmed.dropFirst(5).trimmingCharacters(in: .whitespaces)
            guard payload != "[DONE]", let body = payload.data(using: .utf8),
                  let object = try? JSONSerialization.jsonObject(with: body) as? [String: Any] else { continue }
            if object["result"] != nil || object["error"] != nil { return object }
        }
        return nil
    }
}

// MARK: - Tools

enum WatchToolNaming {
    /// A model-visible tool name: `[A-Za-z0-9_-]`, at most 64, unique across
    /// servers (two servers both exposing `search` become `search` and
    /// `server2_search`).
    static func modelName(server: String, tool: String, taken: Set<String>) -> String {
        func clean(_ raw: String) -> String {
            let allowed = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-")
            let mapped = String(String.UnicodeScalarView(raw.unicodeScalars.map { allowed.contains($0) ? $0 : "_" }))
            return String(mapped.prefix(64))
        }
        let plain = clean(tool)
        if !plain.isEmpty, !taken.contains(plain) { return plain }
        var candidate = clean("\(server)_\(tool)")
        var suffix = 2
        while taken.contains(candidate) || candidate.isEmpty {
            candidate = String(clean("\(server)_\(tool)").prefix(60)) + "_\(suffix)"
            suffix += 1
        }
        return candidate
    }
}

enum WatchToolStep {
    /// What the wrist shows while a tool runs ("正在搜索「北京天气」").
    static func label(tool: String, arguments: String) -> String {
        let object = arguments.data(using: .utf8).flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
        let lowered = tool.lowercased()
        for key in ["query", "q", "search_query", "keyword", "keywords", "search", "question"] {
            if let value = object?[key] as? String, !value.trimmingCharacters(in: .whitespaces).isEmpty {
                return "正在搜索「\(value.prefix(24))」"
            }
        }
        if lowered.contains("search") { return "正在搜索" }
        if lowered.contains("weather") { return "正在查天气" }
        if lowered.contains("route") || lowered.contains("direction") { return "正在查路线" }
        if lowered.contains("fetch") || lowered.contains("read") || lowered.contains("url") { return "正在读网页" }
        return "正在调用 \(tool)"
    }
}

// MARK: - Speech text

/// What actually gets spoken: models answer in Markdown and links even when
/// asked not to, and a speech engine reads "asterisk asterisk". Strip the
/// markup, drop URLs and emoji — the full answer stays on screen.
enum WatchSpeechText {
    static func spoken(_ text: String, maxSentences: Int = 4, maxCharacters: Int = 220) -> String {
        var stream = WatchSentenceStream(maxSentences: maxSentences, maxCharacters: maxCharacters)
        return stream.take(text, final: true).joined()
    }

    /// One sentence made speakable; empty when nothing sayable is left.
    static func clean(_ raw: String) -> String {
        var out = raw
        out = out.replacingOccurrences(of: "\\[([^\\]]+)\\]\\([^)]+\\)", with: "$1", options: .regularExpression)
        out = out.replacingOccurrences(of: "https?://\\S+", with: "链接", options: .regularExpression)
        for marker in ["**", "__", "`", "~~"] { out = out.replacingOccurrences(of: marker, with: "") }
        out = out.replacingOccurrences(of: "(?m)^\\s*(#{1,6}|>|[-*+•·]|\\d+[.)])\\s+", with: "", options: .regularExpression)
        out = String(String.UnicodeScalarView(out.unicodeScalars.filter { scalar in
            let props = scalar.properties
            if props.isEmojiPresentation || (props.isEmoji && scalar.value > 0x2000) { return false }
            return props.generalCategory != .control && props.generalCategory != .format
        }))
        return out.replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespaces)
    }

    /// A line that is mostly symbols — code, a table, a formula — is shown, not read.
    static func looksLikeCode(_ sentence: String) -> Bool {
        let visible = sentence.unicodeScalars.filter { !$0.properties.isWhitespace }
        guard visible.count >= 12 else { return false }
        let symbols = visible.filter { "{}[]()<>=;:$&|\\/_#@*+^%".unicodeScalars.contains($0) }.count
        return symbols * 4 >= visible.count
    }

    static func isMostlyChinese(_ text: String) -> Bool {
        let han = text.unicodeScalars.filter { (0x4E00...0x9FFF).contains($0.value) }.count
        return han * 3 >= text.unicodeScalars.filter { !$0.properties.isWhitespace }.count
    }
}

/// [T-watch-speak-stream] Turns a growing answer into sentences to speak as
/// soon as each one is complete, so the first words come out while the rest
/// is still being written.
///
/// Tracks sentences by count, not by character offset: the phone re-flattens
/// Markdown on every partial, which can shift offsets inside a sentence but
/// not the sentence boundaries themselves.
struct WatchSentenceStream {
    let maxSentences: Int
    let maxCharacters: Int
    /// Raw sentences of the current text already looked at.
    private var consumed = 0
    private(set) var spokenSentences = 0
    private(set) var spokenCharacters = 0
    private(set) var exhausted = false
    private var saidCodeNotice = false
    /// Inside a ``` fence: every line is code until the closing fence.
    private var inFence = false

    init(maxSentences: Int, maxCharacters: Int) {
        self.maxSentences = maxSentences
        self.maxCharacters = maxCharacters
    }

    /// Summary: the first few sentences. Full: the whole answer, up to a
    /// couple of minutes of speech.
    init(full: Bool) {
        self.init(maxSentences: full ? Int.max : 4, maxCharacters: full ? 2000 : 220)
    }

    /// The model started a new round (after a tool call): its text restarts
    /// from empty, so sentence counting restarts; the limits carry over.
    mutating func startNewRound() {
        consumed = 0
        inFence = false
    }

    /// New sentences to speak in `text` since the last call. With `final`, the
    /// unterminated tail counts as a sentence too.
    mutating func take(_ text: String, final: Bool) -> [String] {
        guard !exhausted else { return [] }
        let all = Self.sentences(in: text, includeTail: final)
        guard all.count > consumed else { return [] }
        var out: [String] = []
        for raw in all[consumed...] {
            consumed += 1
            let isFence = raw.trimmingCharacters(in: .whitespaces).hasPrefix("```")
            if isFence { inFence.toggle() }
            // Judge "code" after Markdown is gone: **加粗** is not code.
            let sentence = WatchSpeechText.clean(raw)
            if isFence || inFence || WatchSpeechText.looksLikeCode(sentence) {
                if !saidCodeNotice {
                    saidCodeNotice = true
                    out.append("（代码见屏幕）")
                }
                continue
            }
            guard !sentence.isEmpty else { continue }
            if spokenSentences >= maxSentences || spokenCharacters + sentence.count > maxCharacters {
                if spokenSentences == 0 { out.append(String(sentence.prefix(maxCharacters)) + "…") }
                exhausted = true
                break
            }
            out.append(sentence)
            spokenSentences += 1
            spokenCharacters += sentence.count
        }
        return out
    }

    /// Sentence boundaries: 。！？；!?; and line breaks always; a period only
    /// when whitespace follows it (so "3.14" and "e.g" in progress stay whole).
    static func sentences(in text: String, includeTail: Bool) -> [String] {
        var sentences: [String] = []
        var current = ""
        let characters = Array(text)
        for (index, character) in characters.enumerated() {
            current.append(character)
            let isBoundary: Bool
            switch character {
            case "。", "！", "？", "；", "!", "?", ";", "\n":
                isBoundary = true
            case ".":
                isBoundary = index + 1 < characters.count && characters[index + 1].isWhitespace
            default:
                isBoundary = false
            }
            if isBoundary {
                if !current.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { sentences.append(current) }
                current = ""
            }
        }
        if includeTail, !current.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { sentences.append(current) }
        return sentences
    }
}
