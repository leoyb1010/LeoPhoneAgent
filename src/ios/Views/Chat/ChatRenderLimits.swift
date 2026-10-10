import CoreGraphics
import Foundation

// [T-r3-render-limits] Pure policy for the chat renderer: no UIKit, so the
// logic-test target compiles it directly. The UIKit side
// (SelectableMarkdownView, AssistantBlockView, CollectionViewMessageListV3)
// only asks these types questions.

// MARK: - Text container height sentinel (S3)

/// `NSTextContainerSetSizeGuard` clamps every width/height above
/// `unboundedHeight` down to it (`.greatestFiniteMagnitude` included). Code
/// that restores an "unbounded" container height must therefore compare
/// against THIS value: the old `height < .greatestFiniteMagnitude` test was
/// always true after the clamp, so every layout pass issued a `setSize:` and
/// re-typeset the whole message (the TextContainerGuard storms in the field).
enum LeoTextContainer {
    /// Must equal `kLeoTextContainerUnbounded` in NSTextContainerSetSizeGuard.m.
    static let unboundedHeight: CGFloat = 10_000_000

    /// True only when something actually clamped the height below the
    /// sentinel — the one case where restoring it is worth a `setSize:`.
    static func needsUnboundedRestore(_ height: CGFloat) -> Bool {
        height.isFinite && height < unboundedHeight
    }
}

// MARK: - Markdown render cap (B21)

/// A reply longer than `maxMarkdownScalars` renders its head as markdown and
/// the rest as a plain monospaced block (itself capped), so a 1 MB paste or a
/// runaway model can never make the parser / TextKit walk the whole thing on
/// the main thread. The raw text is untouched — copy still gets all of it.
enum MarkdownRenderCap {
    static let maxMarkdownScalars = 200_000
    static let maxOverflowScalars = 50_000

    struct Split: Equatable {
        /// Rendered as markdown.
        let head: String
        /// Rendered as plain monospaced text, after a short notice.
        let overflow: String
        /// More text exists past `overflow` that is not displayed at all.
        let overflowTruncated: Bool
    }

    /// nil when the text fits (the common case: an O(1) UTF-8 length check —
    /// a string is never longer in scalars than in UTF-8 bytes).
    static func split(_ markdown: String,
                      cap: Int = maxMarkdownScalars,
                      overflowCap: Int = maxOverflowScalars) -> Split? {
        guard cap > 0, markdown.utf8.count > cap else { return nil }
        let scalars = markdown.unicodeScalars
        guard let capIdx = scalars.index(scalars.startIndex, offsetBy: cap, limitedBy: scalars.endIndex),
              capIdx < scalars.endIndex else { return nil }
        // Cut after the last newline in the final 4 K of the head, so a line
        // (and usually a fenced block) is not split mid-way; a single giant
        // line is cut at the scalar boundary.
        var cut = capIdx
        let floor = scalars.index(capIdx, offsetBy: -4_096, limitedBy: scalars.startIndex) ?? scalars.startIndex
        if let nl = scalars[floor..<capIdx].lastIndex(of: "\n") {
            cut = scalars.index(after: nl)
        }
        let head = String(scalars[..<cut])
        let rest = scalars[cut...]
        let shownEnd = rest.index(rest.startIndex, offsetBy: max(0, overflowCap), limitedBy: rest.endIndex) ?? rest.endIndex
        return Split(head: head,
                     overflow: String(rest[..<shownEnd]),
                     overflowTruncated: shownEnd < rest.endIndex)
    }

    /// The part that goes through the markdown parser.
    static func head(_ markdown: String) -> String {
        split(markdown)?.head ?? markdown
    }
}

// MARK: - Markdown image policy (B22)

enum MarkdownImagePolicy {
    /// Inline images rendered per message; the rest become plain links.
    static let maxImagesPerMessage = 64
    /// Largest decoded `data:` image accepted.
    static let maxDataURIBytes = 1_048_576
    /// Image loads (disk or network) running at once, process-wide.
    static let maxConcurrentLoads = 4
    /// Network fetch timeout (seconds).
    static let fetchTimeout: TimeInterval = 10
    /// Largest remote image body accepted.
    static let maxRemoteBytes = 20 * 1_048_576

    enum Verdict: Equatable {
        case allow
        case dataURITooLarge
        case fileOutsideSessionMedia
    }

    /// `sessionMediaRoot` is the active session's media directory
    /// (`…/MinisChat/minis/<sessionId>`); `file:` images must live under it.
    static func verdict(for source: String, sessionMediaRoot: URL?) -> Verdict {
        if source.utf8.count > 5, source.prefix(5).lowercased() == "data:" {
            return estimatedDataURIBytes(source) > maxDataURIBytes ? .dataURITooLarge : .allow
        }
        if source.prefix(5).lowercased() == "file:" {
            guard let root = sessionMediaRoot,
                  let url = URL(string: source), url.isFileURL else { return .fileOutsideSessionMedia }
            return isInside(url, root: root) ? .allow : .fileOutsideSessionMedia
        }
        return .allow
    }

    /// Decoded size of a `data:` URI without decoding it (O(header) + O(1)).
    static func estimatedDataURIBytes(_ source: String) -> Int {
        let utf8 = source.utf8
        let headerScan = utf8.prefix(512)
        guard let comma = headerScan.firstIndex(of: UInt8(ascii: ",")) else { return utf8.count }
        let headerLen = utf8.distance(from: utf8.startIndex, to: comma)
        let payload = utf8.count - headerLen - 1
        let header = String(decoding: utf8[utf8.startIndex..<comma], as: UTF8.self).lowercased()
        return header.hasSuffix(";base64") ? payload / 4 * 3 : payload
    }

    static func isInside(_ url: URL, root: URL) -> Bool {
        let path = url.standardizedFileURL.resolvingSymlinksInPath().path
        var rootPath = root.standardizedFileURL.resolvingSymlinksInPath().path
        if !rootPath.hasSuffix("/") { rootPath += "/" }
        return path.hasPrefix(rootPath)
    }
}

// MARK: - Async limiter

/// FIFO counting semaphore for async work (image loads). `run` suspends until
/// a slot is free, so N callers never run more than `limit` bodies at once.
actor AsyncLimiter {
    let limit: Int
    private var running = 0
    private var waiters: [CheckedContinuation<Void, Never>] = []
    private var head = 0

    init(limit: Int) { self.limit = max(1, limit) }

    func run<T: Sendable>(_ body: @Sendable () async -> T) async -> T {
        await acquire()
        let value = await body()
        release()
        return value
    }

    private func acquire() async {
        if running < limit {
            running += 1
            return
        }
        await withCheckedContinuation { waiters.append($0) }
        // The releaser handed its slot straight to us; `running` is unchanged.
    }

    private func release() {
        if head < waiters.count {
            let next = waiters[head]
            head += 1
            if head > 256, head * 2 > waiters.count {
                waiters.removeFirst(head)
                head = 0
            }
            next.resume()
        } else {
            running -= 1
        }
    }
}

// MARK: - Shared formatters (P2: formatters built per row)

/// Formatters are expensive to build (ICU setup) and were created per row /
/// per body evaluation. Formatting with a shared instance is thread-safe.
enum LeoFormatters {
    nonisolated(unsafe) private static var byFormat: [String: DateFormatter] = [:]
    private static let lock = NSLock()

    /// A `DateFormatter` with a fixed `dateFormat`, built once per format.
    static func date(format: String) -> DateFormatter {
        lock.lock(); defer { lock.unlock() }
        if let f = byFormat[format] { return f }
        let f = DateFormatter()
        f.locale = .autoupdatingCurrent
        f.dateFormat = format
        byFormat[format] = f
        return f
    }

    /// A `DateFormatter` with the given styles, built once per style pair.
    static func date(dateStyle: DateFormatter.Style, timeStyle: DateFormatter.Style) -> DateFormatter {
        let key = "style:\(dateStyle.rawValue):\(timeStyle.rawValue)"
        lock.lock(); defer { lock.unlock() }
        if let f = byFormat[key] { return f }
        let f = DateFormatter()
        f.locale = .autoupdatingCurrent
        f.dateStyle = dateStyle
        f.timeStyle = timeStyle
        byFormat[key] = f
        return f
    }

    nonisolated(unsafe) static let relative: RelativeDateTimeFormatter = {
        let f = RelativeDateTimeFormatter()
        f.locale = .autoupdatingCurrent
        return f
    }()

    nonisolated(unsafe) static let iso8601: ISO8601DateFormatter = ISO8601DateFormatter()

    nonisolated(unsafe) static let iso8601Fractional: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
}
