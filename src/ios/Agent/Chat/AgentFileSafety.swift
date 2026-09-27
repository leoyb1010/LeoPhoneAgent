import Foundation

// MARK: - Symlink-safe delete

/// Deleting a symlink must remove only the link. `/var/minis/mounts/<name>`
/// entries are links to user folders (iCloud Drive, Obsidian vaults…), so
/// anything that follows the link turns "delete this row" into "delete the
/// user's library".
enum SymlinkSafeDelete {
    /// `lstat`-based check: true only when `url` itself is a symbolic link.
    static func isSymlink(_ url: URL) -> Bool {
        var buf = stat()
        guard lstat(url.path, &buf) == 0 else { return false }
        return (buf.st_mode & S_IFMT) == S_IFLNK
    }

    /// Removes the link at `url` and never touches its target. Throws when
    /// `url` is not a symlink so callers can't fall back to a recursive delete.
    static func unlinkSymlink(at url: URL) throws {
        guard isSymlink(url) else {
            throw CocoaError(.fileNoSuchFile, userInfo: [NSFilePathErrorKey: url.path])
        }
        guard unlink(url.path) == 0 else {
            throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
        }
    }

    /// Destination path stored in the link, without resolving it further.
    static func linkDestination(of url: URL) -> String? {
        try? FileManager.default.destinationOfSymbolicLink(atPath: url.path)
    }

    /// Total bytes and file count under `url`, not following symlinks (a link
    /// counts as the link, so a mount link reports ~0 bytes, not the vault).
    static func recursiveSize(of url: URL) -> (bytes: Int64, files: Int) {
        if isSymlink(url) { return (0, 1) }
        var isDir: ObjCBool = false
        guard FileManager.default.fileExists(atPath: url.path, isDirectory: &isDir) else { return (0, 0) }
        guard isDir.boolValue else {
            let size = (try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
            return (Int64(size), 1)
        }
        var bytes: Int64 = 0
        var files = 0
        let keys: [URLResourceKey] = [.isSymbolicLinkKey, .isRegularFileKey, .fileSizeKey]
        guard let e = FileManager.default.enumerator(at: url, includingPropertiesForKeys: keys) else { return (0, 0) }
        for case let child as URL in e {
            guard let v = try? child.resourceValues(forKeys: Set(keys)) else { continue }
            if v.isSymbolicLink == true {
                files += 1
            } else if v.isRegularFile == true {
                files += 1
                bytes += Int64(v.fileSize ?? 0)
            }
        }
        return (bytes, files)
    }
}

// MARK: - Offload placeholder guard

/// Context offload replaces large tool payloads in history with a stub
/// (`[CONTEXT OFFLOADED] … saved to: <path>`), and oversized tool output is
/// clipped with an `[OUTPUT TRUNCATED]` marker. Models copy these stubs back
/// into `file_write` / `file_edit`, which silently replaces real file content
/// with a pointer. This guard puts back the model's own earlier `file_write`
/// content and refuses every other stub.
enum OffloadPlaceholderGuard {
    static let contextMarker = "[CONTEXT OFFLOADED]"

    /// Where a `file_write` call's `content` is offloaded (Offloading.swift:
    /// `tools/<tool name>_<id>.txt`): text the model itself wrote. Any other
    /// Content stub stands for a tool *result* — a `file_read` page with its
    /// `[path | … ]` header and `minis_url:` / `next_offset:` trailers, shell
    /// or browser output — and writing that back corrupts the file. [B3]
    static let ownWriteOffloadPrefix = "/var/minis/offloads/tools/file_write_"

    static func isOwnWriteContent(_ path: String) -> Bool {
        guard path.hasPrefix(ownWriteOffloadPrefix), !path.contains("..") else { return false }
        return !path.dropFirst(ownWriteOffloadPrefix.count).contains("/")
    }

    enum Outcome: Equatable {
        /// No placeholder present; write as-is.
        case clean
        /// Every context stub was replaced by the offloaded content.
        case resolved(String)
        /// Placeholder present but can't be restored; do not write.
        case rejected(String)
    }

    private static let contextStubRegex = try! NSRegularExpression(
        pattern: #"\[CONTEXT OFFLOADED\] (Content|Image) \(~\d+ tokens, \d+ bytes\) saved to: ([^\n]*)(?:\nUse file_read tool to retrieve if needed\.)?"#
    )
    /// The two clipping notices exactly as generated (ConcurrentTools /
    /// ISHCommand). Text that merely mentions the marker — docs, tests, the
    /// source that builds it — is ordinary content. [B12]
    private static let truncatedExcerptRegex = try! NSRegularExpression(
        pattern: #"\[OUTPUT TRUNCATED\] (?:Full output \(\d+ chars\) saved to: \S+|Showing first & last \d+ of \d+ chars \(\d+ lines total\)\.)"#
    )
    private static let savedToRegex = try! NSRegularExpression(pattern: #"saved to: (\S+)"#)

    /// Linux paths of `Content` stubs in `text`, in order of appearance.
    static func referencedContentPaths(in text: String) -> [String] {
        guard text.contains(contextMarker) else { return [] }
        let ns = text as NSString
        return contextStubRegex.matches(in: text, range: NSRange(location: 0, length: ns.length)).compactMap { m in
            guard ns.substring(with: m.range(at: 1)) == "Content" else { return nil }
            let path = ns.substring(with: m.range(at: 2)).trimmingCharacters(in: .whitespaces)
            return path.isEmpty ? nil : path
        }
    }

    /// - Parameters:
    ///   - text: the value the model wants to write.
    ///   - field: parameter name, used in the error message.
    ///   - contents: offloaded content keyed by the Linux path from
    ///     `referencedContentPaths(in:)`; a missing key means unreadable.
    static func check(_ text: String, field: String, contents: [String: String]) -> Outcome {
        let ns = text as NSString
        let whole = NSRange(location: 0, length: ns.length)
        if text.contains("[OUTPUT TRUNCATED]"),
           let excerpt = truncatedExcerptRegex.firstMatch(in: text, range: whole) {
            let notice = ns.substring(with: excerpt.range) as NSString
            let path = savedToRegex.firstMatch(in: notice as String, range: NSRange(location: 0, length: notice.length))
                .map { notice.substring(with: $0.range(at: 1)) }
            let hint = path.map { " The complete output is in \($0) — read it with file_read (use offset/next_offset to page) or copy it with shell_execute `cp \($0) <destination>`." } ?? " Re-read the source with file_read and write the real content."
            return .rejected("Error: '\(field)' contains a truncated tool-output excerpt ([OUTPUT TRUNCATED]…), not real file content. Nothing was written.\(hint)")
        }
        guard text.contains(contextMarker) else { return .clean }

        // A bare "[CONTEXT OFFLOADED]" without the stub around it is ordinary text. [B12]
        let matches = contextStubRegex.matches(in: text, range: whole)
        guard !matches.isEmpty else { return .clean }
        var result = text
        for m in matches.reversed() {
            let kind = ns.substring(with: m.range(at: 1))
            let path = ns.substring(with: m.range(at: 2)).trimmingCharacters(in: .whitespaces)
            guard kind == "Content" else {
                return .rejected("Error: '\(field)' contains an offloaded-image placeholder (saved to: \(path)). Images can't be written as text. Nothing was written.")
            }
            guard path.isEmpty || isOwnWriteContent(path) else {
                return .rejected("Error: '\(field)' contains an offload placeholder for an earlier tool result (saved to: \(path)), not file content. That saved output still carries the tool's headers and trailers, so writing it would corrupt the file. Nothing was written. Read the real source file again with file_read and write its actual text.")
            }
            guard let restored = contents[path] else {
                let location = path.isEmpty ? "" : " (saved to: \(path))"
                return .rejected("Error: '\(field)' contains an offload placeholder\(location) whose content could not be read back. Nothing was written. Read the source again with file_read and pass the actual text.")
            }
            guard let r = Range(m.range, in: result) else { continue }
            result.replaceSubrange(r, with: restored)
        }
        // A stub whose restored content is itself a stub would loop forever.
        if result.contains(contextMarker), !referencedContentPaths(in: result).isEmpty {
            return .rejected("Error: '\(field)' still contains an offload placeholder after restoring it. Nothing was written. Read the file with file_read and pass the actual text.")
        }
        return .resolved(result)
    }

    /// For a `file_read` result that returned an entire file under the
    /// offloads dir, returns that path. Offloading such a result again would
    /// only copy the same bytes to a new file and hand the model another
    /// pointer. Partial pages return nil: restoring a stub from the whole file
    /// would write more than the page the model saw.
    static func offloadSourcePath(ofFileReadResult content: String, offloadsDir: String) -> String? {
        let prefix = "[\(offloadsDir)/"
        guard content.hasPrefix(prefix),
              let header = content.split(separator: "\n", maxSplits: 1).first,
              let end = header.range(of: " | ") else { return nil }
        guard !header.contains("(truncated"),
              let range = header.range(of: #"showing 1-(\d+) of (\d+)\]"#, options: .regularExpression) else { return nil }
        let nums = header[range].split(whereSeparator: { !$0.isNumber }).map(String.init)
        guard nums.count == 3, nums[1] == nums[2] else { return nil }
        return String(header[header.index(after: header.startIndex)..<end.lowerBound])
    }
}
