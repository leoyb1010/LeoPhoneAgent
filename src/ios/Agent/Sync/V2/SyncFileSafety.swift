import Foundation

/// Remote identities are paths only after validation. Never normalize an unsafe
/// peer path into a different local identity, or follow an existing symlink.
enum SyncFileSafety {
    static func component(_ value: String) throws -> String {
        guard !value.isEmpty, value != ".", value != "..",
              !value.contains("/"), !value.contains("\\"), !value.contains("\0") else {
            throw CocoaError(.fileReadInvalidFileName)
        }
        return value
    }

    static func relativePath(_ value: String) throws -> [String] {
        let parts = value.components(separatedBy: "/")
        return try parts.map { try component($0) }
    }

    static func destination(root: URL, relativePath: String) throws -> URL {
        let parts = try self.relativePath(relativePath)
        let base = root.standardizedFileURL.resolvingSymlinksInPath()
        var target = base
        for part in parts {
            target.appendPathComponent(part)
            // attributesOfItem observes dangling links too (fileExists does not).
            if let attrs = try? FileManager.default.attributesOfItem(atPath: target.path),
               attrs[.type] as? FileAttributeType == .typeSymbolicLink {
                throw CocoaError(.fileReadInvalidFileName)
            }
        }
        let resolved = target.standardizedFileURL.resolvingSymlinksInPath()
        guard resolved.path.hasPrefix(base.path + "/") else {
            throw CocoaError(.fileReadInvalidFileName)
        }
        return target
    }

    static func dailyKey(_ value: String) throws -> String {
        guard value.range(of: #"^\d{4}-\d{2}-\d{2}$"#, options: .regularExpression) != nil else {
            throw CocoaError(.fileReadInvalidFileName)
        }
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        formatter.dateFormat = "yyyy-MM-dd"
        formatter.isLenient = false
        guard let date = formatter.date(from: value), formatter.string(from: date) == value else {
            throw CocoaError(.fileReadInvalidFileName)
        }
        return value
    }

    /// True means absent/deleted, false means the comparable local clock wins.
    /// Pending local edits are retryable, including clockless CloudKit deletes.
    static func removeFile(root: URL, relativePath: String, remoteUpdatedAt: Date?, hasPendingEdit: Bool) throws -> Bool {
        let url = try destination(root: root, relativePath: relativePath)
        if hasPendingEdit { throw CocoaError(.fileWriteUnknown) }
        let manager = FileManager.default
        guard manager.fileExists(atPath: url.path) else { return true }
        let attributes = try manager.attributesOfItem(atPath: url.path)
        guard attributes[.type] as? FileAttributeType == .typeRegular else { throw CocoaError(.fileReadInvalidFileName) }
        if let remoteUpdatedAt, let local = attributes[.modificationDate] as? Date, local > remoteUpdatedAt { return false }
        try manager.removeItem(at: url)
        return true
    }

    /// An atomic write leaves the old destination intact if reading or staging
    /// fails. Apply the sender's mtime so retry/LWW doesn't treat our copy as an edit.
    static func replaceFile(from source: URL, to destination: URL, modifiedAt: Date) throws {
        let data = try Data(contentsOf: source, options: .mappedIfSafe)
        try FileManager.default.createDirectory(at: destination.deletingLastPathComponent(), withIntermediateDirectories: true)
        try data.write(to: destination, options: .atomic)
        try FileManager.default.setAttributes([.modificationDate: modifiedAt], ofItemAtPath: destination.path)
    }
}

/// Content is part of identity. Keeping the full tuple avoids hash collisions
/// and survives serialization/restarts without changing the existing wire format.
enum SyncMemoryEntries {
    struct Entry: Codable, Hashable {
        let timestamp: String
        let content: String
    }

    static func union(_ local: [Entry], _ remote: [Entry]) -> [Entry] {
        Set(local).union(remote).sorted {
            $0.timestamp == $1.timestamp ? $0.content < $1.content : $0.timestamp > $1.timestamp
        }
    }
    static func parse(from text: String) -> [Entry] {
        let lines = text.components(separatedBy: "\n")
        var entries: [Entry] = []
        var currentTimestamp: String? = nil
        var currentLines: [String] = []

        for line in lines {
            if line.hasPrefix("<!-- "), line.hasSuffix(" -->") {
                // Flush previous block
                if let ts = currentTimestamp {
                    let body = currentLines.joined(separator: "\n")
                        .trimmingCharacters(in: .whitespacesAndNewlines)
                    if !body.isEmpty {
                        entries.append(Entry(timestamp: ts, content: body))
                    }
                }
                // Start new block — extract timestamp between "<!-- " and " -->"
                let inner = String(line.dropFirst(5).dropLast(4))
                currentTimestamp = inner
                currentLines = []
            } else {
                currentLines.append(line)
            }
        }
        // Flush last block
        if let ts = currentTimestamp {
            let body = currentLines.joined(separator: "\n")
                .trimmingCharacters(in: .whitespacesAndNewlines)
            if !body.isEmpty {
                entries.append(Entry(timestamp: ts, content: body))
            }
        }
        return entries
    }


    static func serialize(_ entries: [Entry]) -> String {
        let sorted = SyncMemoryEntries.union([], entries)
        return sorted.map { "<!-- \($0.timestamp) -->\n\($0.content)\n" }
                     .joined(separator: "\n")
    }


}
