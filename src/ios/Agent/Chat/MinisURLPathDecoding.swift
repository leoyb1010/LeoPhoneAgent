import Foundation

/// Shared percent-decoding helpers for resolving `leophoneagent://` URLs to on-disk
/// subpaths.
///
/// A correctly-formed `minis_url` percent-encodes the filename exactly once
/// (see `linuxPathToMinisURL`), so `URL(string:).path` decodes it back to the
/// real UTF-8 name. But links sometimes arrive double-encoded — the agent (or
/// an intermediate Markdown autolink/sanitize step) re-encodes the literal `%`
/// of an already-encoded URL into `%25`, turning `%E6` into `%2520`/`%25E6`.
/// `url.path` then decodes only one layer, leaving a literal `%E6…` that
/// matches no file on disk, so the tap fell through to the workspace folder
/// view instead of opening the target file. [T-fix-double-encoding 2026-06-01]
///
/// The fix is tolerant resolution: try the single-decoded subpath first
/// (the correct case, unchanged behaviour), then — only when that doesn't
/// exist on disk — try one extra `removingPercentEncoding` pass to recover a
/// double-encoded name. The disk-existence check is the disambiguator, so a
/// filename that legitimately contains a `%` is still resolved by the first
/// candidate and never reaches the extra decode.
enum MinisURLPathDecoding {
    /// Candidate subpaths for a `leophoneagent://` URL, in priority order.
    /// `url.path` already strips the scheme/host and percent-decodes once.
    static func subPathCandidates(for url: URL) -> [String] {
        let p = url.path
        let base = p.hasPrefix("/") ? String(p.dropFirst()) : p
        var candidates = [base]
        // Recover double-encoded names: a second decode collapses %25XX → %XX
        // → the real UTF-8 character. Only add it when it actually differs so
        // single-encoded (already-correct) URLs keep exactly one candidate.
        if let twice = base.removingPercentEncoding, twice != base {
            candidates.append(twice)
        }
        // ".." 段会爬出作用域目录(别的会话、App 私有文件),这样的候选一律不要。
        return candidates.filter { !hasParentTraversal($0) }
    }

    /// 路径里有没有 ".." 段(`a/..b` 这种文件名不算)。
    static func hasParentTraversal(_ path: String) -> Bool {
        path.split(separator: "/", omittingEmptySubsequences: true).contains("..")
    }
}
