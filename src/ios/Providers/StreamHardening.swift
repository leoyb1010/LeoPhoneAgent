import Foundation

// [T-r3-stream-hardening] Pure pieces of the provider stream parsers. Each one
// is used by the real parser (Anthropic / OpenAI Chat / OpenAI Responses /
// Gemini) and is small enough to drive from raw SSE lines in a logic test.
// The rule they share: nothing a server sends — an error event, a 5 MB tool
// argument, a 100k-delta reply, a nonsense token count, a BOM — may hang,
// crash or silently truncate the turn.

// MARK: - SSE framing

enum SSEFraming {
    private static let bom = "\u{FEFF}"

    /// Payload of an SSE `data:` line, nil for anything else (comments,
    /// `event:` lines, blanks). The space after the colon is optional (some
    /// servers send `data:{…}`), a UTF-8 BOM on the first line is ignored, and
    /// a trailing CR from `\r\n` framing is stripped.
    static func payload(fromLine rawLine: String) -> String? {
        var line = Substring(rawLine)
        if line.hasPrefix(bom) { line = line.dropFirst() }
        if line.hasSuffix("\r") { line = line.dropLast() }
        guard line.hasPrefix("data:") else { return nil }
        var after = line.dropFirst(5)
        if after.first == " " { after = after.dropFirst() }
        return String(after)
    }

    /// Value of an SSE `event:` line, nil otherwise.
    static func eventName(fromLine rawLine: String) -> String? {
        var line = Substring(rawLine)
        if line.hasPrefix(bom) { line = line.dropFirst() }
        if line.hasSuffix("\r") { line = line.dropLast() }
        guard line.hasPrefix("event:") else { return nil }
        return line.dropFirst(6).trimmingCharacters(in: .whitespaces)
    }

    /// JSON object carried by a `data:` line, nil for `[DONE]` / non-JSON.
    static func jsonObject(fromLine line: String) -> [String: Any]? {
        guard let payload = payload(fromLine: line), payload != "[DONE]",
              let data = payload.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        return obj
    }
}

// MARK: - In-stream errors

/// Maps an error that arrives INSIDE an HTTP-200 stream to the same LLMError
/// the HTTP status would have produced, so retry / group fallback behave the
/// same way whether the server failed before or after the first byte.
enum StreamErrorClassifier {
    /// Anthropic `event: error` → `{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}`.
    static func anthropic(type: String, message: String) -> LLMError {
        let msg = "[\(type)] \(message)"
        switch type {
        case "overloaded_error":
            return .transientError(message: msg, statusCode: 529)
        case "api_error", "internal_server_error", "server_error", "timeout_error":
            return .transientError(message: msg, statusCode: 500)
        case "rate_limit_error":
            return .rateLimited
        case "authentication_error", "permission_error":
            return .invalidAPIKey(detail: message)
        default:
            return .providerError(message: msg)
        }
    }

    /// Generic error object (OpenAI Chat `{"error":{…}}`, Responses
    /// `{"type":"error",…}` / `response.error`, Gemini `{"error":{"code":503,"status":"UNAVAILABLE"}}`).
    static func generic(_ error: [String: Any]) -> LLMError {
        let message = (error["message"] as? String) ?? "streaming error"
        let typeOrCode = ((error["code"] as? String) ?? (error["type"] as? String) ?? (error["status"] as? String) ?? "")
            .lowercased()
        let numeric = ToolArgNumbers.clampedInt(error["code"], to: 0...999)
            ?? ToolArgNumbers.clampedInt(error["status"], to: 0...999)
        let label = typeOrCode.isEmpty ? (numeric.map(String.init) ?? "error") : typeOrCode
        let msg = "[\(label)] \(message)"
        if let numeric, numeric == 429 { return .rateLimited }
        if let numeric, (500...599).contains(numeric) { return .transientError(message: msg, statusCode: numeric) }
        if typeOrCode.contains("overload") || typeOrCode == "unavailable" {
            return .transientError(message: msg, statusCode: 529)
        }
        if typeOrCode.contains("server_error") || typeOrCode == "internal" || typeOrCode.contains("api_error")
            || typeOrCode.contains("timeout") || typeOrCode == "deadline_exceeded" {
            return .transientError(message: msg, statusCode: 500)
        }
        if typeOrCode.contains("rate_limit") || typeOrCode == "resource_exhausted" { return .rateLimited }
        if let numeric, numeric == 401 || numeric == 403 { return .invalidAPIKey(detail: message) }
        return .providerError(message: msg)
    }

    /// Anthropic error event, straight from a raw `data:` line (test seam and
    /// the shape the SDK decodes into `MessageStreamResponse.error`).
    static func anthropicErrorEvent(fromLine line: String) -> LLMError? {
        guard let obj = SSEFraming.jsonObject(fromLine: line), (obj["type"] as? String) == "error" else { return nil }
        let err = obj["error"] as? [String: Any]
        return anthropic(type: (err?["type"] as? String) ?? "error",
                         message: (err?["message"] as? String) ?? "stream error")
    }

    /// Responses API error events: `{"type":"error",…}` (fields at top level
    /// or under `error`) and `{"type":"response.error","error":{…}}`.
    static func responsesErrorEvent(_ event: [String: Any]) -> LLMError? {
        let type = event["type"] as? String
        guard type == "error" || type == "response.error" else { return nil }
        if let nested = event["error"] as? [String: Any] { return generic(nested) }
        var fields = event
        fields.removeValue(forKey: "type") // the event type ("error"), not the error kind
        return generic(fields)
    }

    /// Chat Completions / Gemini: an `error` object anywhere at top level.
    static func topLevelError(_ event: [String: Any]) -> LLMError? {
        guard let err = event["error"] as? [String: Any] else { return nil }
        return generic(err)
    }
}

// MARK: - Tool argument accumulation

/// Accumulates one tool call's streamed argument JSON in O(total) time:
/// chunks are kept in an array and joined only when a progress snapshot is
/// actually yielded (throttled), never per delta. Past `maxBytes` further
/// chunks are dropped and the call completes as an error the model can read.
struct StreamToolArgsAccumulator {
    static let maxBytes = 1_048_576
    /// Progress snapshots at most this often (the consumer throttles further).
    static let yieldInterval: TimeInterval = 0.08
    /// Key of the sentinel args dict delivered for an oversized call;
    /// tool preflight turns it into a tool error result.
    static let oversizeSentinelKey = "__leo_tool_args_error"

    private(set) var byteCount = 0
    private(set) var chunkCount = 0
    private(set) var overLimit = false
    private var chunks: [String] = []
    private var joinedCache = ""
    private var joinedAtChunk = 0
    private var lastYieldAt: Date = .distantPast
    let maxBytes: Int

    init(maxBytes: Int = StreamToolArgsAccumulator.maxBytes) {
        self.maxBytes = maxBytes
    }

    /// Append a delta. Returns true when a progress snapshot is due now.
    mutating func append(_ delta: String, now: Date = Date()) -> Bool {
        guard !overLimit else { return false }
        let n = delta.utf8.count
        if byteCount + n > maxBytes {
            overLimit = true
            byteCount += n
            chunks.removeAll()
            joinedCache = ""
            joinedAtChunk = 0
            return false
        }
        chunks.append(delta)
        chunkCount += 1
        byteCount += n
        if now.timeIntervalSince(lastYieldAt) >= Self.yieldInterval {
            lastYieldAt = now
            return true
        }
        return false
    }

    /// The JSON received so far (joined lazily, cached until the next chunk).
    mutating func joined() -> String {
        if joinedAtChunk != chunks.count {
            joinedCache = chunks.joined()
            joinedAtChunk = chunks.count
        }
        return joinedCache
    }

    /// Final arguments: the parsed object, or the oversize sentinel.
    mutating func finalArgs(toolName: String) -> [String: Any] {
        if overLimit {
            return [Self.oversizeSentinelKey:
                "The arguments for '\(toolName)' exceeded \(maxBytes / 1_048_576) MB and were discarded. "
                + "Split the work into smaller calls (e.g. write the file in parts) instead of sending one huge argument."]
        }
        let json = joined()
        guard let data = json.data(using: .utf8),
              let dict = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return [:] }
        return dict
    }
}

/// OpenAI Chat Completions tool calls arrive keyed by `index`. A provider that
/// starts a SECOND call (new id) on an index that is still open must not
/// overwrite the first one — both are kept, in arrival order.
struct OpenAIToolCallTable {
    struct Entry {
        let id: String
        let name: String
        var args: StreamToolArgsAccumulator
    }

    private(set) var entries: [Entry] = []
    private var openByIndex: [Int: Int] = [:]

    var isEmpty: Bool { entries.isEmpty }

    /// A start chunk (non-empty id + name). Returns true when this is a new call.
    mutating func start(index: Int, id: String, name: String) -> Bool {
        if let pos = openByIndex[index], entries[pos].id == id { return false }
        entries.append(Entry(id: id, name: name, args: StreamToolArgsAccumulator()))
        openByIndex[index] = entries.count - 1
        return true
    }

    /// An arguments delta for `index`. Returns (name, snapshot) when a
    /// throttled progress snapshot is due.
    mutating func appendArguments(index: Int, delta: String, now: Date = Date()) -> (name: String, snapshot: String)? {
        guard let pos = openByIndex[index] else { return nil }
        guard entries[pos].args.append(delta, now: now) else { return nil }
        return (entries[pos].name, entries[pos].args.joined())
    }

    /// Complete every call in arrival order and reset.
    mutating func drain() -> [(id: String, name: String, args: [String: Any], raw: String)] {
        var out: [(id: String, name: String, args: [String: Any], raw: String)] = []
        for i in entries.indices {
            let name = entries[i].name
            let args = entries[i].args.finalArgs(toolName: name)
            let raw = entries[i].args.overLimit ? "" : entries[i].args.joined()
            out.append((entries[i].id, name, args, raw))
        }
        entries.removeAll()
        openByIndex.removeAll()
        return out
    }
}

// MARK: - Tool names on replay

/// Every provider restricts function names (`^[a-zA-Z0-9_-]{1,64}$`). A name
/// the model invented ("foo bar", 200 chars, emoji) is stored in history as
/// is; replaying it unchanged made EVERY later request — and every fallback
/// model — fail with 400. Names are sanitised when a request is built.
enum ToolNameSanitizer {
    static let maxLength = 64

    static func sanitize(_ name: String) -> String {
        var out = String()
        out.reserveCapacity(min(name.utf8.count, maxLength))
        for scalar in name.unicodeScalars {
            if out.unicodeScalars.count >= maxLength { break }
            let v = scalar.value
            let ok = (v >= 0x30 && v <= 0x39) || (v >= 0x41 && v <= 0x5A) || (v >= 0x61 && v <= 0x7A)
                || v == 0x5F || v == 0x2D
            out.unicodeScalars.append(ok ? scalar : "_")
        }
        return out.isEmpty ? "tool" : out
    }
}

// MARK: - Streamed text budget

/// Tracks the length of the streamed reply without re-counting it per delta
/// (String.count is O(n); per delta that made a 100k-delta reply O(n²)), and
/// ends the turn once the reply passes `maxBytes`.
struct StreamTextBudget {
    static let maxBytes = 2 * 1024 * 1024

    let maxBytes: Int
    private(set) var utf8Count = 0
    private(set) var exceeded = false

    init(maxBytes: Int = StreamTextBudget.maxBytes) {
        self.maxBytes = maxBytes
    }

    /// Count a delta. Returns true exactly once: on the delta that crosses the budget.
    mutating func add(_ delta: String) -> Bool {
        guard !exceeded else { return false }
        utf8Count += delta.utf8.count
        if utf8Count > maxBytes {
            exceeded = true
            return true
        }
        return false
    }

    mutating func reset() {
        utf8Count = 0
        exceeded = false
    }
}

// MARK: - Usage numbers

/// Token counts come straight from the server. A bogus `9223372036854775807`
/// used to overflow when added to cache counts (trap). Clamp to a range no
/// real request reaches.
enum UsageTokenClamp {
    static let maxTokens = 1 << 40

    static func clamp(_ value: Int) -> Int { min(max(value, 0), maxTokens) }
    static func clamp(_ value: Int?) -> Int? { value.map { clamp($0) } }

    /// Integer from a JSON value (Int, Int64.max, 1e30 …) clamped into range.
    static func value(_ raw: Any?) -> Int? {
        ToolArgNumbers.clampedInt(raw, to: 0...maxTokens)
    }
}

// MARK: - Stop reason

/// The first `.done` of a stream wins. Gemini yields `MAX_TOKENS` from the
/// candidate and then a trailing `.done(endTurn)` when the body ends; the
/// second used to overwrite the first and the truncation went unreported.
struct StreamStopReasonGate<Reason> {
    private(set) var reason: Reason?

    /// Record `candidate`; returns false (and ignores it) when a reason is already set.
    mutating func record(_ candidate: Reason) -> Bool {
        guard reason == nil else { return false }
        reason = candidate
        return true
    }
}
