import Foundation

// [T-r3-input-hardening] Every number, path, command and pasted string that a
// model (or a web page, or the clipboard) hands to a tool goes through these
// pure helpers first. Nothing here throws or traps: an extreme value is clamped
// into range, a non-finite one falls back to the caller's default, and text
// that could impersonate an app-authored envelope is neutralised.

// MARK: - Numbers

enum ToolArgNumbers {
    /// A finite Double from a JSON-ish value (Int, Double, NSNumber, numeric
    /// String). Booleans are not numbers here; NaN / ±inf return nil.
    static func finiteDouble(_ raw: Any?) -> Double? {
        let value: Double?
        switch raw {
        case let n as NSNumber:
            if CFGetTypeID(n) == CFBooleanGetTypeID() { return nil }
            value = n.doubleValue
        case let i as Int:
            value = Double(i)
        case let d as Double:
            value = d
        case let s as String:
            value = Double(s.trimmingCharacters(in: .whitespacesAndNewlines))
        default:
            value = nil
        }
        guard let value, value.isFinite else { return nil }
        return value
    }

    /// `raw` as a finite Double clamped into `range`; nil when absent or not a
    /// finite number (the caller then uses its default).
    static func clampedDouble(_ raw: Any?, to range: ClosedRange<Double>) -> Double? {
        finiteDouble(raw).map { min(max($0, range.lowerBound), range.upperBound) }
    }

    /// `raw` as an Int clamped into `range`. Exact integers (including
    /// Int.min / Int.max from JSON) clamp without passing through Double, so
    /// no precision is lost and `Int(someDouble)` can never trap.
    static func clampedInt(_ raw: Any?, to range: ClosedRange<Int>) -> Int? {
        if let n = raw as? NSNumber {
            if CFGetTypeID(n) == CFBooleanGetTypeID() { return nil }
            switch UInt8(bitPattern: n.objCType.pointee) {
            case UInt8(ascii: "f"), UInt8(ascii: "d"):
                break // floating point (and NSDecimalNumber): clamp via Double below
            case UInt8(ascii: "Q"), UInt8(ascii: "L"), UInt8(ascii: "I"), UInt8(ascii: "S"), UInt8(ascii: "C"):
                return min(max(Int(clamping: n.uint64Value), range.lowerBound), range.upperBound)
            default:
                return min(max(Int(clamping: n.int64Value), range.lowerBound), range.upperBound)
            }
        } else if let i = raw as? Int {
            return min(max(i, range.lowerBound), range.upperBound)
        }
        guard let d = finiteDouble(raw) else { return nil }
        return int(d, clampedTo: range)
    }

    /// An integer the caller can range-check itself: exact JSON integers
    /// (even Int.max) pass through clamped to Int; a floating value is used
    /// only when finite and below 1e15 in magnitude (`1e300` means "garbage",
    /// not "as long as possible"). Booleans and everything else → nil.
    static func plausibleInt(_ raw: Any?) -> Int? {
        if let n = raw as? NSNumber {
            if CFGetTypeID(n) == CFBooleanGetTypeID() { return nil }
            let type = UInt8(bitPattern: n.objCType.pointee)
            if type != UInt8(ascii: "f"), type != UInt8(ascii: "d") {
                return clampedInt(n, to: Int.min...Int.max)
            }
        }
        guard let d = finiteDouble(raw), abs(d) < 1e15 else { return nil }
        return Int(d)
    }

    /// Never-trapping Double → Int: clamps first, truncates toward zero.
    /// Non-finite input maps to the nearest bound (NaN → lower bound).
    static func int(_ value: Double, clampedTo range: ClosedRange<Int>) -> Int {
        guard !value.isNaN else { return range.lowerBound }
        if value <= Double(range.lowerBound) { return range.lowerBound }
        if value >= Double(range.upperBound) { return range.upperBound }
        return Int(value)
    }

    /// Never-trapping Double → Int over the full Int range.
    static func saturatingInt(_ value: Double) -> Int {
        // Double(Int.max) rounds up to 2^63, which itself is not representable.
        int(value, clampedTo: Int.min...(Int.max - 1024))
    }

    // MARK: Tool-specific bounds (single source of truth for the tests)

    static let shellTimeoutRange: ClosedRange<Double> = 1...3600
    static let shellDelayRange: ClosedRange<Double> = 0...600
    static let remoteShellTimeoutRange: ClosedRange<Int> = 5...600
    static let remoteAgentTimeoutRange: ClosedRange<Int> = 5...3600
    static let fileReadOffsetRange: ClosedRange<Int> = 1...100_000_000
    static let fileReadLinesRange: ClosedRange<Int> = 0...100_000_000
    static let fileReadMaxLengthRange: ClosedRange<Int> = 1...10_000_000
    static let viewportWidthRange: ClosedRange<Int> = 1...4096
    static let viewportHeightRange: ClosedRange<Int> = 1...8192

    /// shell_execute `timeout` (seconds): absent / non-finite → default.
    static func shellTimeout(_ raw: Any?, default fallback: TimeInterval) -> TimeInterval {
        clampedDouble(raw, to: shellTimeoutRange) ?? fallback
    }

    /// shell_execute `delay` (seconds): absent / non-finite → 0.
    static func shellDelay(_ raw: Any?) -> TimeInterval {
        clampedDouble(raw, to: shellDelayRange) ?? 0
    }
}

// MARK: - Paths & commands

enum ToolInputGuard {
    /// Why a model-supplied path is refused, or nil when it is acceptable.
    /// C0 control characters (including NUL, newline, ESC) and DEL never
    /// belong in a file path; they truncate C strings, split log lines and
    /// fool the approval card.
    static func pathRejection(_ path: String) -> String? {
        for scalar in path.unicodeScalars where scalar.value < 0x20 || scalar.value == 0x7F {
            return "Error: the path contains a control character (U+\(String(format: "%04X", scalar.value))). Use a plain path."
        }
        return nil
    }

    /// Canonical (NFC) form of a model-supplied path. APFS treats NFC and NFD
    /// spellings as the same file, but meta.db rows and mount-prefix compares
    /// are plain string matches — normalise once at the tool boundary so one
    /// file never gets two metadata rows.
    static func normalizedPath(_ path: String) -> String {
        path.precomposedStringWithCanonicalMapping
    }

    /// Why a shell command is refused, or nil. A NUL byte silently truncates
    /// the command at the C boundary, so what runs is not what was approved.
    static func commandRejection(_ command: String) -> String? {
        if command.utf8.contains(0) {
            return "Error: the command contains a NUL (\\0) character, which cannot be passed to the shell. Remove it and call shell_execute again."
        }
        return nil
    }

    /// One-line, length-capped label (sub-agent titles and similar).
    static func singleLineLabel(_ raw: String, maxCharacters: Int) -> String {
        let flattened = raw.unicodeScalars.map { scalar -> String in
            (scalar.value < 0x20 || scalar.value == 0x7F || scalar.value == 0x2028 || scalar.value == 0x2029)
                ? " " : String(scalar)
        }.joined()
        let collapsed = flattened.split(separator: " ", omittingEmptySubsequences: true).joined(separator: " ")
        guard collapsed.count > maxCharacters else { return collapsed }
        return String(collapsed.prefix(maxCharacters - 1)) + "…"
    }
}

// MARK: - Resource limits

enum ToolResourceLimits {
    /// file_read / file_edit refuse to load more than this into memory.
    static let maxTextFileBytes = 32 * 1024 * 1024
    /// file_write refuses content larger than this.
    static let maxWriteContentBytes = 16 * 1024 * 1024
    /// read_image refuses files larger than this.
    static let maxImageFileBytes = 50 * 1024 * 1024
    /// Above this many pixels read_image never decodes at full size.
    static let maxImagePixels = 50_000_000
    /// Above this many pixels read_image refuses outright.
    static let hardMaxImagePixels = 400_000_000
    /// Longest edge handed to the model.
    static let imageInferenceLongEdge = 2000

    static func fileTooLargeMessage(path: String, bytes: Int, limit: Int, hint: String) -> String {
        let mb = Double(bytes) / 1_048_576
        let limitMB = limit / 1_048_576
        return "Error: \(path) is \(String(format: "%.1f", mb)) MB, larger than the \(limitMB) MB limit for this tool. \(hint)"
    }

    /// Size of a regular file without reading it; nil when it cannot be stat'ed.
    static func fileSize(at url: URL) -> Int? {
        guard let attrs = try? FileManager.default.attributesOfItem(atPath: url.path),
              let n = attrs[.size] as? NSNumber else { return nil }
        return Int(clamping: n.int64Value)
    }

    /// Up to `count` leading bytes of a file, read with a FileHandle so a huge
    /// file is never loaded just to sniff it.
    static func leadingBytes(of url: URL, count: Int) -> Data? {
        guard let handle = try? FileHandle(forReadingFrom: url) else { return nil }
        defer { try? handle.close() }
        return try? handle.read(upToCount: count) ?? Data()
    }
}

// MARK: - Reserved envelope tags

/// [B23] Tags the app itself writes into user-role messages. Text the user
/// typed or pasted must never contain them verbatim: the bubble hides
/// `<system-reminder>` / `<treasury_context>` blocks, attachment metadata is
/// cut out of the visible text, and a message that opens with
/// `<agent_callback` used to render as a sub-agent result card. The opening
/// `<` of such a tag is replaced with a full-width `＜`, which reads the same
/// to a person, is not markup to the model, and no display filter matches.
enum ReservedTagEscaper {
    static let reservedTagNames = ["system-reminder", "agent_callback", "user-attached-files", "treasury_context"]
    static let neutralisedBracket: Character = "\u{FF1C}" // ＜

    /// True when `text` contains a reserved opening or closing tag.
    static func containsReservedTag(_ text: String) -> Bool {
        guard text.utf8.contains(UInt8(ascii: "<")) else { return false }
        let lower = text.lowercased()
        return reservedTagNames.contains { lower.contains("<\($0)") || lower.contains("</\($0)") }
    }

    /// Neutralise every reserved tag in user-authored text. Idempotent.
    static func escapeUserAuthored(_ text: String) -> String {
        guard containsReservedTag(text) else { return text }
        let chars = Array(text)
        var out = String()
        out.reserveCapacity(text.utf8.count)
        var i = 0
        while i < chars.count {
            if chars[i] == "<", let skip = reservedTagLength(chars, at: i) {
                out.append(neutralisedBracket)
                out.append(contentsOf: String(chars[(i + 1)..<(i + skip)]))
                i += skip
                continue
            }
            out.append(chars[i])
            i += 1
        }
        return out
    }

    /// Escape `text` but keep an app-authored trailing reminder (Siri / Watch
    /// append a fixed `<system-reminder>` to the user's words) intact.
    static func escapeUserAuthored(_ text: String, preservingTrustedSuffixes suffixes: [String]) -> String {
        for raw in suffixes {
            let suffix = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !suffix.isEmpty, text.hasSuffix(suffix) else { continue }
            let head = String(text.dropLast(suffix.count))
            return escapeUserAuthored(head) + suffix
        }
        return escapeUserAuthored(text)
    }

    /// Length of `<name` / `</name` at `i` when it is a reserved tag followed by
    /// a tag boundary (whitespace, `>` or `/`), else nil.
    private static func reservedTagLength(_ chars: [Character], at i: Int) -> Int? {
        var j = i + 1
        if j < chars.count, chars[j] == "/" { j += 1 }
        for name in reservedTagNames {
            let nameChars = Array(name)
            guard j + nameChars.count <= chars.count else { continue }
            var match = true
            for k in 0..<nameChars.count where chars[j + k].lowercased() != String(nameChars[k]) {
                match = false
                break
            }
            guard match else { continue }
            let end = j + nameChars.count
            if end == chars.count || chars[end] == ">" || chars[end] == "/" || chars[end].isWhitespace {
                return end - i
            }
        }
        return nil
    }
}

// MARK: - Browser navigation

/// [T-r3-browser-ssrf] Where a model-driven browser_use navigation may go.
/// Reuses the link-preview SSRF host rules (private ranges, link-local and
/// cloud metadata, `.local`, odd IPv4 spellings, IPv4-mapped IPv6) with two
/// deliberate exceptions:
///   - loopback (`localhost`, 127/8, ::1): the system prompt tells the model to
///     start servers inside the iSH sandbox and open them, and those listen on
///     the device's own loopback;
///   - hosts the user configured themselves elsewhere (remote SSH hosts).
enum BrowserNavigationPolicy {
    static func rejection(for url: URL, userAllowedHosts: Set<String> = []) -> String? {
        let scheme = url.scheme?.lowercased() ?? ""
        guard scheme == "http" || scheme == "https" else { return nil } // scheme gate lives in navigate()
        guard var host = url.host?.lowercased(), !host.isEmpty else {
            return "Blocked: the URL has no host."
        }
        if host.hasPrefix("["), host.hasSuffix("]") { host = String(host.dropFirst().dropLast()) }
        if userAllowedHosts.contains(host) { return nil }
        guard LinkPreviewFetcher.isBlockedHost(url) else { return nil }
        if isLoopback(host) { return nil }
        return "Blocked: \(host) is a private, link-local or reserved network address. browser_use only opens public sites, servers running inside this app's Linux sandbox (localhost), and hosts the user configured."
    }

    static func isLoopback(_ host: String) -> Bool {
        if host == "localhost" || host.hasSuffix(".localhost") { return true }
        if host == "::1" { return true }
        if let v4 = LinkPreviewFetcher.normalizedIPv4(host) { return v4 >> 24 == 127 }
        return false
    }
}
