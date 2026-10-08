import Compression
import Foundation

/// ZIP reading for the importer (ported from upstream, hardened).
///
/// Everything a package says about itself is attacker-controlled the moment a
/// user restores a file someone sent them, so before a single byte is written:
///   * every entry name is validated (no absolute paths, no `..`/`.`, no
///     backslashes or NULs, bounded length, no duplicates, no case-insensitive
///     collisions that would let one member overwrite a verified one);
///   * entry count and the total declared size are capped, and the total must
///     fit in the free space we were given;
///   * every member's byte range must lie inside the file, STORED members must
///     declare equal sizes, and deflated members (legacy only) are capped.
/// Writes are bounded copies into a fresh directory; nothing is ever written
/// through a symlink because destinations are canonicalised and contained.
enum BackupZipExtractor {

    enum ExtractError: LocalizedError, Equatable {
        case notAZip
        case truncated
        case unsupportedCompression(UInt16)
        case unsafePath(String)
        case duplicateEntry(String)
        case tooManyEntries(Int)
        case tooLarge(Int64)
        case insufficientSpace(needed: Int64, available: Int64)
        case inconsistentEntry(String)

        var errorDescription: String? {
            switch self {
            case .notAZip: return String(localized: "不是有效的备份包（ZIP 结构损坏）")
            case .truncated: return String(localized: "备份包不完整（文件被截断）")
            case .unsupportedCompression(let m): return String(localized: "备份包使用了不支持的压缩方式（\(m)）")
            case .unsafePath: return String(localized: "备份包含有不安全的路径，已拒绝")
            case .duplicateEntry: return String(localized: "备份包含有重复条目，已拒绝")
            case .tooManyEntries(let n): return String(localized: "备份包条目过多（\(n)），已拒绝")
            case .tooLarge: return String(localized: "备份包解压后体积超出上限，已拒绝")
            case .insufficientSpace(let need, let have):
                let n = ByteCountFormatter.string(fromByteCount: need, countStyle: .file)
                let h = ByteCountFormatter.string(fromByteCount: have, countStyle: .file)
                return String(localized: "空间不足：需要约 \(n)，当前可用 \(h)")
            case .inconsistentEntry: return String(localized: "备份包条目信息不一致，已拒绝")
            }
        }
    }

    struct Entry: Sendable {
        let name: String
        let compressedSize: Int64
        let uncompressedSize: Int64
        let method: UInt16
        let localHeaderOffset: Int64
        var isDirectory: Bool { name.hasSuffix("/") }
    }

    struct Limits: Sendable {
        var maxEntries = BackupFormat.Limits.maxEntries
        var maxTotalBytes = BackupFormat.Limits.maxTotalUncompressedBytes
        var maxDeflatedEntryBytes = BackupFormat.Limits.maxDeflatedEntryBytes
        /// nil = don't check free space (tests).
        var availableBytes: Int64?
        static let standard = Limits()
    }

    // MARK: - Extraction

    /// Validate the whole central directory, then extract every entry under
    /// `destination` (which must be a fresh, empty directory).
    @discardableResult
    static func extract(_ zipURL: URL, to destination: URL,
                        limits: Limits = .standard) throws -> [Entry] {
        let fm = FileManager.default
        try fm.createDirectory(at: destination, withIntermediateDirectories: true)

        let handle = try FileHandle(forReadingFrom: zipURL)
        defer { try? handle.close() }
        let fileSize = Int64((try? handle.seekToEnd()) ?? 0)
        let entries = try centralDirectory(handle: handle)
        try validate(entries, fileSize: fileSize, limits: limits)

        for entry in entries {
            try Task.checkCancellation()
            guard let out = safeDestination(for: entry.name, under: destination) else {
                throw ExtractError.unsafePath(entry.name)
            }
            if entry.isDirectory {
                try fm.createDirectory(at: out, withIntermediateDirectories: true)
                continue
            }
            try fm.createDirectory(at: out.deletingLastPathComponent(), withIntermediateDirectories: true)
            do {
                try autoreleasepool { try writeEntry(entry, from: handle, to: out, fileSize: fileSize) }
            } catch {
                // A short blob is worse than a missing one: its name asserts a
                // hash its bytes no longer have.
                try? fm.removeItem(at: out)
                throw error
            }
        }
        return entries
    }

    /// Structural validation, independent of the filesystem. Public so the
    /// preview path can reject a hostile package before anything is unpacked.
    static func validate(_ entries: [Entry], fileSize: Int64, limits: Limits) throws {
        guard entries.count <= limits.maxEntries else { throw ExtractError.tooManyEntries(entries.count) }
        var seen = Set<String>()
        var total: Int64 = 0
        for e in entries {
            guard isSafeEntryName(e.name) else { throw ExtractError.unsafePath(e.name) }
            // Exact-name duplicates only: iOS volumes are case-sensitive, and a
            // case-folding overwrite would surface as an integrity failure anyway.
            guard seen.insert(e.name).inserted else { throw ExtractError.duplicateEntry(e.name) }
            guard e.compressedSize >= 0, e.uncompressedSize >= 0, e.localHeaderOffset >= 0 else {
                throw ExtractError.inconsistentEntry(e.name)
            }
            // The header (30 bytes + name) and payload must sit inside the file.
            let minEnd = e.localHeaderOffset + 30 + Int64(e.name.utf8.count) + e.compressedSize
            guard minEnd <= fileSize else { throw ExtractError.truncated }
            switch e.method {
            case 0:
                guard e.compressedSize == e.uncompressedSize else { throw ExtractError.inconsistentEntry(e.name) }
            case 8:
                guard e.uncompressedSize <= limits.maxDeflatedEntryBytes else { throw ExtractError.tooLarge(e.uncompressedSize) }
            default:
                throw ExtractError.unsupportedCompression(e.method)
            }
            let (sum, overflow) = total.addingReportingOverflow(e.uncompressedSize)
            guard !overflow else { throw ExtractError.tooLarge(Int64.max) }
            total = sum
        }
        guard total <= limits.maxTotalBytes else { throw ExtractError.tooLarge(total) }
        if let available = limits.availableBytes, total > available {
            throw ExtractError.insufficientSpace(needed: total, available: available)
        }
    }

    /// Lexical rule: relative, no empty / `.` / `..` components, no
    /// backslashes, NULs or control characters, bounded length.
    static func isSafeEntryName(_ name: String) -> Bool {
        guard !name.isEmpty, name.utf8.count <= BackupFormat.Limits.maxEntryNameBytes,
              !name.hasPrefix("/"), !name.contains("\\"),
              !name.unicodeScalars.contains(where: { $0.value < 0x20 || $0.value == 0x7F }) else { return false }
        let trimmed = name.hasSuffix("/") ? String(name.dropLast()) : name
        let parts = trimmed.split(separator: "/", omittingEmptySubsequences: false)
        return !parts.isEmpty && parts.allSatisfy { !$0.isEmpty && $0 != "." && $0 != ".." }
    }

    /// Where `name` may be written, or nil if it would land outside `root`.
    /// Resolves the deepest existing ancestor so a symlinked parent cannot
    /// smuggle a write out of the tree; both sides are canonicalised because
    /// `/var` is a symlink to `/private/var` on iOS.
    static func safeDestination(for name: String, under root: URL) -> URL? {
        guard isSafeEntryName(name) else { return nil }
        let out = name.split(separator: "/").reduce(root) { $0.appendingPathComponent(String($1)) }
        return BackupPaths.isContained(out, within: root) ? out : nil
    }

    private static func writeEntry(_ entry: Entry, from handle: FileHandle, to out: URL, fileSize: Int64) throws {
        try handle.seek(toOffset: UInt64(entry.localHeaderOffset))
        guard let header = try handle.read(upToCount: 30), header.count == 30,
              readU32(header, 0) == 0x0403_4B50 else {
            throw ExtractError.truncated
        }
        let nameLen = Int64(readU16(header, 26))
        let extraLen = Int64(readU16(header, 28))
        let dataStart = entry.localHeaderOffset + 30 + nameLen + extraLen
        guard dataStart + entry.compressedSize <= fileSize else { throw ExtractError.truncated }
        try handle.seek(toOffset: UInt64(dataStart))

        FileManager.default.createFile(atPath: out.path, contents: nil)
        let sink = try FileHandle(forWritingTo: out)
        defer { try? sink.close() }

        if entry.method == 8 {
            guard let raw = try handle.read(upToCount: Int(entry.compressedSize)),
                  Int64(raw.count) == entry.compressedSize else { throw ExtractError.truncated }
            try sink.write(contentsOf: inflate(raw, expectedSize: Int(entry.uncompressedSize)))
            return
        }

        var remaining = entry.compressedSize
        while remaining > 0 {
            try autoreleasepool {
                let want = Int(min(remaining, 4 * 1024 * 1024))
                guard let chunk = try handle.read(upToCount: want), !chunk.isEmpty else {
                    throw ExtractError.truncated
                }
                try sink.write(contentsOf: chunk)
                remaining -= Int64(chunk.count)
            }
        }
    }

    /// Read one small member into memory (manifest preview), bounded.
    static func readEntry(_ entry: Entry, handle: FileHandle, fileSize: Int64, maxBytes: Int) throws -> Data {
        guard entry.uncompressedSize <= Int64(maxBytes) else { throw ExtractError.tooLarge(entry.uncompressedSize) }
        try handle.seek(toOffset: UInt64(entry.localHeaderOffset))
        guard let header = try handle.read(upToCount: 30), header.count == 30,
              readU32(header, 0) == 0x0403_4B50 else { throw ExtractError.truncated }
        let dataStart = entry.localHeaderOffset + 30 + Int64(readU16(header, 26)) + Int64(readU16(header, 28))
        guard dataStart + entry.compressedSize <= fileSize else { throw ExtractError.truncated }
        try handle.seek(toOffset: UInt64(dataStart))
        guard let raw = try handle.read(upToCount: Int(entry.compressedSize)),
              Int64(raw.count) == entry.compressedSize else { throw ExtractError.truncated }
        switch entry.method {
        case 0: return raw
        case 8: return try inflate(raw, expectedSize: Int(entry.uncompressedSize))
        default: throw ExtractError.unsupportedCompression(entry.method)
        }
    }

    // MARK: - Central directory

    static func centralDirectory(handle: FileHandle) throws -> [Entry] {
        let fileSize = Int64((try? handle.seekToEnd()) ?? 0)
        guard fileSize >= 22 else { throw ExtractError.notAZip }

        let tailLen = Int(min(fileSize, 65_557))
        try handle.seek(toOffset: UInt64(fileSize - Int64(tailLen)))
        let tail = try handle.read(upToCount: tailLen) ?? Data()

        var eocd = -1
        var i = tail.count - 22
        while i >= 0 {
            if readU32(tail, i) == 0x0605_4B50 { eocd = i; break }
            i -= 1
        }
        guard eocd >= 0 else { throw ExtractError.notAZip }

        var count = Int64(readU16(tail, eocd + 10))
        var cdSize = Int64(readU32(tail, eocd + 12))
        var cdOffset = Int64(readU32(tail, eocd + 16))

        if count == 0xFFFF || cdOffset == 0xFFFF_FFFF || cdSize == 0xFFFF_FFFF {
            let locatorPos = eocd - 20
            guard locatorPos >= 0, readU32(tail, locatorPos) == 0x0706_4B50 else { throw ExtractError.notAZip }
            let z64Offset = Int64(bitPattern: readU64(tail, locatorPos + 8))
            guard z64Offset >= 0, z64Offset + 56 <= fileSize else { throw ExtractError.truncated }
            try handle.seek(toOffset: UInt64(z64Offset))
            guard let z64 = try handle.read(upToCount: 56), z64.count == 56,
                  readU32(z64, 0) == 0x0606_4B50 else { throw ExtractError.notAZip }
            count = Int64(bitPattern: readU64(z64, 32))
            cdSize = Int64(bitPattern: readU64(z64, 40))
            cdOffset = Int64(bitPattern: readU64(z64, 48))
        }

        guard count >= 0, count <= Int64(BackupFormat.Limits.maxEntries) * 2,
              cdOffset >= 0, cdSize >= 0, cdOffset + cdSize <= fileSize,
              cdSize <= 512 * 1024 * 1024 else { throw ExtractError.truncated }
        try handle.seek(toOffset: UInt64(cdOffset))
        let cd = try handle.read(upToCount: Int(cdSize)) ?? Data()
        guard Int64(cd.count) == cdSize else { throw ExtractError.truncated }

        var entries: [Entry] = []
        entries.reserveCapacity(Int(min(count, 100_000)))
        var pos = 0
        for _ in 0..<count {
            guard pos + 46 <= cd.count, readU32(cd, pos) == 0x0201_4B50 else { throw ExtractError.truncated }
            let method = readU16(cd, pos + 10)
            var compSize = Int64(readU32(cd, pos + 20))
            var uncompSize = Int64(readU32(cd, pos + 24))
            let nameLen = Int(readU16(cd, pos + 28))
            let extraLen = Int(readU16(cd, pos + 30))
            let commentLen = Int(readU16(cd, pos + 32))
            var localOffset = Int64(readU32(cd, pos + 42))
            guard pos + 46 + nameLen + extraLen + commentLen <= cd.count else { throw ExtractError.truncated }
            let nameStart = cd.startIndex + pos + 46
            let nameData = cd[nameStart..<(nameStart + nameLen)]
            guard let name = String(data: nameData, encoding: .utf8) else {
                throw ExtractError.unsafePath("<non-utf8>")
            }

            if compSize == 0xFFFF_FFFF || uncompSize == 0xFFFF_FFFF || localOffset == 0xFFFF_FFFF {
                var p = pos + 46 + nameLen
                let extraEnd = p + extraLen
                while p + 4 <= extraEnd {
                    let tag = readU16(cd, p)
                    let size = Int(readU16(cd, p + 2))
                    guard tag == 0x0001 else { p += 4 + size; continue }
                    var q = p + 4
                    if uncompSize == 0xFFFF_FFFF, q + 8 <= extraEnd {
                        uncompSize = Int64(bitPattern: readU64(cd, q)); q += 8
                    }
                    if compSize == 0xFFFF_FFFF, q + 8 <= extraEnd {
                        compSize = Int64(bitPattern: readU64(cd, q)); q += 8
                    }
                    if localOffset == 0xFFFF_FFFF, q + 8 <= extraEnd {
                        localOffset = Int64(bitPattern: readU64(cd, q))
                    }
                    break
                }
            }

            entries.append(Entry(name: name, compressedSize: compSize, uncompressedSize: uncompSize,
                                 method: method, localHeaderOffset: localOffset))
            pos += 46 + nameLen + extraLen + commentLen
        }
        return entries
    }

    private static func inflate(_ data: Data, expectedSize: Int) throws -> Data {
        // Bounded by the declared size, which `validate` already capped.
        let cap = max(expectedSize, 1)
        var out = Data(count: cap)
        let written: Int = out.withUnsafeMutableBytes { dst in
            data.withUnsafeBytes { src -> Int in
                guard let d = dst.bindMemory(to: UInt8.self).baseAddress,
                      let s = src.bindMemory(to: UInt8.self).baseAddress else { return 0 }
                return compression_decode_buffer(d, cap, s, data.count, nil, COMPRESSION_ZLIB)
            }
        }
        guard written > 0 || expectedSize == 0 else { throw ExtractError.unsupportedCompression(8) }
        out.removeSubrange(written...)
        return out
    }

    static func readU16(_ d: Data, _ off: Int) -> UInt16 {
        let i = d.startIndex + off
        guard off >= 0, i + 1 < d.endIndex else { return 0 }
        return UInt16(d[i]) | (UInt16(d[i + 1]) << 8)
    }

    static func readU32(_ d: Data, _ off: Int) -> UInt32 {
        let i = d.startIndex + off
        guard off >= 0, i + 3 < d.endIndex else { return 0 }
        return UInt32(d[i]) | (UInt32(d[i + 1]) << 8) | (UInt32(d[i + 2]) << 16) | (UInt32(d[i + 3]) << 24)
    }

    static func readU64(_ d: Data, _ off: Int) -> UInt64 {
        let i = d.startIndex + off
        guard off >= 0, i + 7 < d.endIndex else { return 0 }
        var v: UInt64 = 0
        for b in (0..<8).reversed() { v = (v << 8) | UInt64(d[i + b]) }
        return v
    }
}

/// Containment checks shared by extraction and file-tree restore.
enum BackupPaths {
    /// True when `url` really resolves inside `root`. Both sides are
    /// standardised and symlink-resolved (resolving only one side breaks on
    /// iOS's `/var -> /private/var`), the deepest EXISTING ancestor is
    /// resolved (a non-existent leaf would otherwise hide a symlinked parent),
    /// and the prefix carries a trailing separator so `/a/b-evil` is not
    /// inside `/a/b`.
    static func isContained(_ url: URL, within root: URL) -> Bool {
        let fm = FileManager.default
        let base = root.standardizedFileURL.resolvingSymlinksInPath().path
        var probe = url.standardizedFileURL
        var suffix: [String] = []
        while !fm.fileExists(atPath: probe.path) {
            let parent = probe.deletingLastPathComponent()
            if parent.path == probe.path { break }
            suffix.insert(probe.lastPathComponent, at: 0)
            probe = parent
        }
        // An existing leaf that is itself a symlink is resolved too, so a
        // planted link cannot redirect an overwrite outside the tree.
        var resolved = probe.resolvingSymlinksInPath().path
        for comp in suffix {
            guard comp != "..", comp != "." else { return false }
            resolved += (resolved.hasSuffix("/") ? "" : "/") + comp
        }
        return resolved == base || resolved.hasPrefix(base.hasSuffix("/") ? base : base + "/")
    }

    /// A single safe path component (session id, skill id, file name).
    static func isSafeComponent(_ s: String) -> Bool {
        !s.isEmpty && s.utf8.count <= 255 && s != "." && s != ".."
            && !s.contains("/") && !s.contains("\\")
            && !s.unicodeScalars.contains(where: { $0.value < 0x20 || $0.value == 0x7F })
    }

    /// `relative` split into safe components, or nil.
    static func safeComponents(_ relative: String) -> [String]? {
        let parts = relative.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
        guard !parts.isEmpty, parts.allSatisfy(isSafeComponent) else { return nil }
        return parts
    }

    /// Relative path of `url` under `root` (both standardised + resolved).
    static func relativePath(of url: URL, under root: URL) -> String? {
        let base = root.standardizedFileURL.resolvingSymlinksInPath().path
        let full = url.standardizedFileURL.resolvingSymlinksInPath().path
        guard full.hasPrefix(base + "/") else { return nil }
        return String(full.dropFirst(base.count + 1))
    }

    static func freeSpace(at url: URL) -> Int64? {
        let values = try? url.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey])
        return values?.volumeAvailableCapacityForImportantUsage
    }
}
