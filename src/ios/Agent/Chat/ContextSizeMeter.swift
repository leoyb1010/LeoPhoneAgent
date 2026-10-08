import Foundation
import ImageIO

// MARK: - Outbound context measurement [T-ctx-measure-outbound]

/// Sizes the request that is ABOUT to be sent, so every capacity decision
/// (compact, offload, `max_tokens`) judges the context the model will actually
/// receive — not the size of some earlier request.
///
/// Ported from upstream (OpenMinis 1.12–1.14) with two LeoBot changes:
///   * `reasoningContent` is counted. OpenAI-compatible providers echo it on
///     every assistant turn (`OpenAIAgentProvider.convertSingleMessageChatCompletions`),
///     so leaving it out under-read thinking sessions by the whole reasoning trail.
///   * Image tokens are read from the image header with ImageIO instead of
///     decoding a UIImage, so this file has no UIKit dependency and compiles
///     into the logic-test target.
///
///     size(now) = calibration × (estimate(outbound history) + estimate(system prompt + tools))
///
/// where `calibration = lastReported / estimate(that same request)`. Both sides
/// of the ratio describe ONE request, so it stays valid across compaction,
/// offload, revert, trimming and relaunch.
enum ContextSizeMeter {

    /// Token estimate for a string, by character class.
    ///
    /// Fitted against cl100k_base on Chinese, Japanese, English prose, Swift,
    /// JSON, git logs and `ls -la` output: 0.66–1.18x the real count, versus
    /// 0.30–1.21x for the previous flat `chars / 3.5` — which read CJK text at
    /// under a third of its real size. The residual is per-session and is
    /// absorbed by the calibration ratio after the first response.
    ///
    /// Scans UTF-8 bytes (a non-ASCII scalar is counted once, at its lead byte).
    static func estimateTokens(_ text: String) -> Int {
        var letters = 0, digits = 0, asciiOther = 0, nonASCII = 0
        var copy = text
        copy.withUTF8 { bytes in
            for b in bytes {
                if b >= 0x80 {
                    if b & 0xC0 != 0x80 { nonASCII += 1 }   // lead byte = one scalar
                } else if (b >= 65 && b <= 90) || (b >= 97 && b <= 122) {
                    letters += 1
                } else if b >= 48 && b <= 57 {
                    digits += 1
                } else {
                    asciiOther += 1
                }
            }
        }
        let tokens = Double(letters) / 4.5 + Double(digits) / 2.0
            + Double(asciiOther) * 0.35 + Double(nonASCII)
        return Int(tokens.rounded(.up))
    }

    /// Per-message framing (role markers, separators).
    static let perMessageOverhead = 4
    static let perToolPartOverhead = 4

    static func estimateTokens(_ part: AgentContentPart) -> Int {
        switch part {
        case .text(let text):
            return estimateTokens(text)
        case .toolUse(_, let name, let input):
            var total = estimateTokens(name) + perToolPartOverhead
            if let data = try? JSONSerialization.data(withJSONObject: input),
               let json = String(data: data, encoding: .utf8) {
                total += estimateTokens(json)
            }
            return total
        case .toolResult(_, let name, let content, _, let imageData, _, _, _):
            var total = estimateTokens(name) + estimateTokens(content) + perToolPartOverhead
            if let imageData { total += imageTokens(imageData) }
            return total
        case .imageData(let data, _, _):
            return imageTokens(data)
        }
    }

    static func estimateTokens(_ messages: [AgentMessage]) -> Int {
        messages.reduce(0) { $0 + estimateTokens(message: $1) }
    }

    /// Persisted messages are cached: without it every measurement re-scans the
    /// whole history, several times per iteration. The key carries the
    /// message's content SHAPE as well as its id, because offload and the
    /// incremental trimmer produce different content for the same id: a changed
    /// length is a new key, so a shrunk message is re-measured instead of keeping
    /// its old size. In-flight messages (no dbMessageId yet) are always measured.
    static func estimateTokens(message msg: AgentMessage) -> Int {
        guard let id = msg.dbMessageId else { return uncachedEstimate(msg) }
        var shape = "\(id)|\(msg.parts.count)|rc\(msg.reasoningContent.map { "\($0.utf8.count)" } ?? "-")"
        for part in msg.parts {
            switch part {
            case .text(let t): shape += "|t\(t.utf8.count)"
            case .toolUse(_, _, let input):
                var argBytes = 0
                for value in input.values { if let s = value as? String { argBytes += s.utf8.count } }
                shape += "|u\(input.count)/\(argBytes)"
            case .toolResult(_, _, let content, _, let img, _, _, _): shape += "|r\(content.utf8.count)/\(img?.count ?? 0)"
            case .imageData(let d, _, _): shape += "|i\(d.count)"
            }
        }
        let key = shape as NSString
        if let hit = messageEstimateCache.object(forKey: key) { return hit.intValue }
        let tokens = uncachedEstimate(msg)
        messageEstimateCache.setObject(NSNumber(value: tokens), forKey: key)
        return tokens
    }

    // NSCache is thread-safe; the annotation only silences the Sendable check.
    nonisolated(unsafe) private static let messageEstimateCache: NSCache<NSString, NSNumber> = {
        let c = NSCache<NSString, NSNumber>()
        c.countLimit = 20_000
        return c
    }()

    private static func uncachedEstimate(_ msg: AgentMessage) -> Int {
        perMessageOverhead
            + msg.parts.reduce(0) { $0 + estimateTokens($1) }
            + (msg.role == .assistant ? estimateTokens(msg.reasoningContent ?? "") : 0)
    }

    /// System prompt plus tool schemas — the part of every request that the
    /// history-only estimate used to leave out entirely.
    static func estimateFixedTokens(systemPrompt: String, tools: [AgentToolDefinition]) -> Int {
        var total = estimateTokens(systemPrompt)
        for tool in tools {
            total += estimateTokens(tool.name) + estimateTokens(tool.description) + 10
            for (name, param) in tool.parameters {
                total += estimateTokens(name) + estimateTokens(param.description) + 4
                if let values = param.enumValues {
                    total += values.reduce(0) { $0 + estimateTokens($1) + 1 }
                }
            }
        }
        return total
    }

    // MARK: Calibration

    /// Bounds on reported / estimated. Outside this band the report is more
    /// likely to describe something other than the request we estimated (a
    /// relay that bills differently, a provider that omits cached tokens) than
    /// a real tokenizer difference, so it is clamped rather than trusted.
    static let calibrationRange: ClosedRange<Double> = 0.8...3.0

    /// Ratio of what the provider counted to what we estimated for the SAME
    /// request, or nil when either side is missing.
    static func calibrationRatio(reported: Int, estimated: Int) -> Double? {
        guard reported > 0, estimated > 0 else { return nil }
        let raw = Double(reported) / Double(estimated)
        return min(max(raw, calibrationRange.lowerBound), calibrationRange.upperBound)
    }

    static func calibrated(_ estimated: Int, ratio: Double) -> Int {
        Int((Double(estimated) * ratio).rounded(.up))
    }

    /// Applied when the current model has no calibration of its own and we are
    /// borrowing another model's ratio. Leaning high for that one request costs,
    /// at worst, an early compaction; its first response replaces the borrowed ratio.
    static let uncalibratedModelMargin = 1.2

    /// Where `ratio(for:known:lastLearned:)` got its answer, for logs.
    static func ratioSource(for modelId: String?, known: [String: Double], lastLearned: Double?) -> String {
        if let modelId, known[modelId] != nil { return "own" }
        return lastLearned == nil ? "default" : "borrowed"
    }

    /// Share of the gap closed per sample when a new sample says the ratio
    /// should come DOWN.
    static let calibrationFallRate = 0.3

    /// Fold one sample into a model's ratio — an asymmetric weighted average.
    /// A ratio that is too LOW under-reads the context and can send a request
    /// over the window; one that is too high only compacts a little early. So
    /// "higher" applies at once and "lower" moves only part of the way.
    static func smoothed(previous: Double?, sample: Double) -> Double {
        guard let previous else { return sample }
        if sample >= previous { return sample }
        return previous + calibrationFallRate * (sample - previous)
    }

    /// The ratio to judge `modelId` by: its own if it has one; otherwise the
    /// most recently learned ratio (any model) with the margin above; otherwise
    /// 1.0 for a session that has never reported usage.
    static func ratio(for modelId: String?, known: [String: Double], lastLearned: Double?) -> Double {
        if let modelId, let own = known[modelId] { return own }
        guard let lastLearned else { return 1.0 }
        return min(max(lastLearned, 1.0) * uncalibratedModelMargin, calibrationRange.upperBound)
    }

    // MARK: Provider rejections

    /// Phrases providers use to refuse an over-length request.
    static let overflowMarkers = [
        "maximum context length", "context length exceeded", "context_length_exceeded",
        "reduce the length of the messages", "too many tokens", "prompt is too long",
        "request too large", "exceeds the maximum", "input is too long",
        "exceeds the context window", "input exceeds the context",
        "exceed context limit",
        "上下文长度", "超出最大长度", "内容过长",
    ]

    /// Markers that a byte-size rejection also matches.
    static let byteAmbiguousMarkers: Set<String> = ["exceeds the maximum", "request too large"]

    /// Whether an error text is a context-length rejection. The status must be
    /// 400/413 when one is present in the text (`[400] …`): other statuses with
    /// similar words (a 429 "too many tokens per minute") are rate limits.
    static func isContextOverflow(_ text: String) -> Bool {
        let lower = text.lowercased()
        let codes = (try? NSRegularExpression(pattern: #"\[(\d{3})\]"#))?
            .matches(in: lower, range: NSRange(lower.startIndex..., in: lower))
            .compactMap { Range($0.range(at: 1), in: lower).flatMap { Int(lower[$0]) } } ?? []
        if !codes.isEmpty && !codes.contains(where: { $0 == 400 || $0 == 413 }) { return false }
        let hits = overflowMarkers.filter { lower.contains($0) }
        // A 413 "exceeds the maximum allowed number of bytes" is a payload-size
        // limit (images), not a token count: only a token-specific marker counts.
        if lower.contains("bytes") {
            return hits.contains { !byteAmbiguousMarkers.contains($0) }
        }
        return !hits.isEmpty
    }

    /// The token count the provider says the rejected request had, when its
    /// message states one (the larger of the two numbers named).
    static func requestedTokens(inOverflowMessage text: String) -> Int? {
        let cleaned = text.replacingOccurrences(of: #"(?<=\d),(?=\d{3})"#, with: "", options: .regularExpression)
        let regex = try? NSRegularExpression(pattern: #"\d{4,}"#)
        let range = NSRange(cleaned.startIndex..., in: cleaned)
        let values = regex?.matches(in: cleaned, range: range).compactMap {
            Range($0.range, in: cleaned).flatMap { Int(cleaned[$0]) }
        } ?? []
        return values.filter { $0 >= 1000 }.max()
    }

    /// Ratio after a rejection: never lower than the current ratio — a
    /// rejection only ever says we under-read.
    static func ratioAfterOverflow(current: Double, estimated: Int, requested: Int?, window: Int) -> Double {
        guard estimated > 0 else { return current }
        let plausible = requested.flatMap { r -> Int? in
            guard window > 0 else { return r }
            return (Double(r) >= Double(window) * 0.9 && Double(r) <= Double(window) * 4) ? r : nil
        }
        let target = plausible.map(Double.init) ?? Double(max(window, 1)) * 1.02
        let implied = target / Double(estimated)
        return min(max(current, implied), calibrationRange.upperBound)
    }

    // MARK: Session calibration: replay and reload

    /// One persisted (report, estimate) pair — an assistant turn's usage.
    struct CalibrationSample: Equatable {
        let reported: Int, estimated: Int, fixedTokens: Int, modelId: String?
    }

    /// A session's calibration: per-model ratios, the newest learned one, and the fixed share.
    struct CalibrationState: Equatable {
        var ratios: [String: Double] = [:]
        var lastLearned: Double? = nil
        var fixedTokens = 0
        var samples = 0

        /// Reloading the SAME session keeps what was learned in memory (a ratio
        /// raised by a rejection exists nowhere else); the transcript fills in
        /// models memory has not seen.
        func carryingOver(_ learned: CalibrationState) -> CalibrationState {
            var merged = self
            merged.ratios.merge(learned.ratios) { _, inMemory in inMemory }
            if let last = learned.lastLearned { merged.lastLearned = last }
            if learned.fixedTokens > 0 { merged.fixedTokens = learned.fixedTokens }
            return merged
        }
    }

    /// Rebuild calibration from persisted samples in conversation order,
    /// through the same `smoothed` rule the live path uses.
    static func replayCalibration(_ samples: [CalibrationSample]) -> CalibrationState {
        var state = CalibrationState()
        for s in samples {
            guard let sample = calibrationRatio(reported: s.reported, estimated: s.estimated) else { continue }
            state.samples += 1
            if let model = s.modelId {
                let updated = smoothed(previous: state.ratios[model], sample: sample)
                state.ratios[model] = updated
                state.lastLearned = updated
            } else {
                state.lastLearned = sample
            }
            state.fixedTokens = s.fixedTokens
        }
        return state
    }

    /// [T-ctx-warmup-fit] How many leading warm-up messages to drop so that
    /// warm-up + `restTokens` is under `budget`. Drops whole turns: after each
    /// cut it keeps dropping until the slice starts on a user-TEXT message
    /// (`startsTurn`), so a tool call is never separated from its result.
    static func warmUpDrop(sizes: [Int], startsTurn: [Bool], restTokens: Int, budget: Int) -> Int {
        precondition(sizes.count == startsTurn.count)
        var total = sizes.reduce(0, +)
        var drop = 0
        while drop < sizes.count, total + restTokens >= budget {
            total -= sizes[drop]; drop += 1
            while drop < sizes.count, !startsTurn[drop] { total -= sizes[drop]; drop += 1 }
        }
        return drop
    }

    // MARK: Images

    nonisolated(unsafe) private static let imageTokenCache = NSCache<NSString, NSNumber>()

    /// Same formula as `BPETokenizer.countImageTokens` (32px tiles, 2048 edge
    /// cap, 85 floor, 1000 when unreadable), read from the image header.
    static func imageTokens(_ data: Data) -> Int {
        let key = "\(data.count)-\(data.prefix(64).hashValue)-\(data.suffix(64).hashValue)" as NSString
        if let cached = imageTokenCache.object(forKey: key) { return cached.intValue }
        var tokens = 1_000
        if let source = CGImageSourceCreateWithData(data as CFData, nil),
           let props = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
           let w = (props[kCGImagePropertyPixelWidth] as? NSNumber)?.doubleValue,
           let h = (props[kCGImagePropertyPixelHeight] as? NSNumber)?.doubleValue,
           w > 0, h > 0 {
            let scale = max(w, h) > 2048 ? 2048 / max(w, h) : 1.0
            tokens = max(85, Int(ceil(w * scale / 32.0) * ceil(h * scale / 32.0)))
        }
        imageTokenCache.setObject(NSNumber(value: tokens), forKey: key)
        return tokens
    }
}
