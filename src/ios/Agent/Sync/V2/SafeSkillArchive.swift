import Foundation
#if canImport(zlib)
import zlib
#endif

/// Bounded ZIP32 reader shared by file import and sync. Parse and validate the
/// entire archive before any caller mutates the installed skill. ZIP64,
/// encryption, symlinks and ambiguous names are deliberately unsupported.
enum SafeSkillArchive {
    struct Entry {
        let name: String
        let isDirectory: Bool
        let data: Data
    }
    enum Invalid: Error { case archive }
    static let maxArchiveBytes = 256 * 1_024 * 1_024
    static let maxEntryBytes = 64 * 1_024 * 1_024
    static let maxExpandedBytes = 128 * 1_024 * 1_024
    static let maxEntries = 4_096

    static func read(_ input: Data) throws -> [Entry] {
        try read(input, inflate: decompress)
    }

    static func decompress(_ data: Data, expectedSize: Int) -> Data? {
        #if canImport(zlib)
        guard expectedSize >= 0, expectedSize <= maxEntryBytes,
              !data.isEmpty, data.count <= maxArchiveBytes else { return nil }
        // One extra byte distinguishes exact output from truncated/bomb output.
        var output = Data(count: expectedSize + 1)
        let valid = output.withUnsafeMutableBytes { destination in
            data.withUnsafeBytes { source -> Bool in
                guard let src = source.baseAddress,
                      let dst = destination.baseAddress else { return false }
                // ZIP method 8 contains one raw DEFLATE stream. Compression's
                // decoder can consume trailing bytes, so use zlib's exact input
                // counters to reject garbage or a second stream inside the entry.
                var stream = z_stream()
                guard inflateInit2_(&stream, -MAX_WBITS, ZLIB_VERSION,
                                    Int32(MemoryLayout<z_stream>.size)) == Z_OK else { return false }
                defer { inflateEnd(&stream) }
                // zlib does not mutate input; its C API uses a mutable pointer.
                stream.next_in = UnsafeMutablePointer(mutating: src.assumingMemoryBound(to: Bytef.self))
                stream.avail_in = uInt(data.count)
                stream.next_out = dst.assumingMemoryBound(to: Bytef.self)
                stream.avail_out = uInt(expectedSize + 1)
                // Both buffers are complete and bounded. Z_FINISH must reach the
                // stream end in this call; incomplete input/output fails closed.
                let status = zlib.inflate(&stream, Z_FINISH)
                return status == Z_STREAM_END && stream.avail_in == 0
                    && stream.total_in == uLong(data.count)
                    && stream.total_out == uLong(expectedSize) && stream.avail_out == 1
            }
        }
        guard valid else { return nil }
        output.count = expectedSize
        return output
        #else
        return nil
        #endif
    }

    static func read(_ input: Data, inflate: (Data, Int) -> Data?) throws -> [Entry] {
        let data = Data(input) // normalize a possible Data slice's startIndex
        func require(_ valid: Bool) throws { if !valid { throw Invalid.archive } }
        func range(_ offset: Int, _ length: Int, end: Int? = nil) throws -> Range<Int> {
            let limit = end ?? data.count
            try require(offset >= 0 && length >= 0 && offset <= limit && length <= limit - offset)
            return offset..<(offset + length)
        }
        func u16(_ p: Int) -> Int { Int(data[p]) | Int(data[p + 1]) << 8 }
        func u32(_ p: Int) -> UInt32 {
            UInt32(data[p]) | UInt32(data[p + 1]) << 8 | UInt32(data[p + 2]) << 16 | UInt32(data[p + 3]) << 24
        }
        try require(data.count >= 22 && data.count <= maxArchiveBytes)
        var endOffset: Int?
        for p in stride(from: data.count - 22, through: max(0, data.count - 65_557), by: -1) {
            if u32(p) == 0x06054b50 && p + 22 + u16(p + 20) == data.count { endOffset = p; break }
        }
        guard let end = endOffset else { throw Invalid.archive }
        let count = u16(end + 10)
        try require(u16(end + 4) == 0 && u16(end + 6) == 0 && u16(end + 8) == count)
        try require(count > 0 && count <= maxEntries && count != 0xffff)
        let cdSize = Int(u32(end + 12)), cdStart = Int(u32(end + 16))
        _ = try range(cdStart, cdSize, end: end)
        try require(cdStart + cdSize == end)
        var cursor = cdStart, expanded = 0
        var names = Set<String>(), fileNames = Set<String>()
        var regions: [Range<Int>] = []
        var entries: [Entry] = []
        for _ in 0..<count {
            _ = try range(cursor, 46, end: end)
            try require(u32(cursor) == 0x02014b50)
            let flags = u16(cursor + 8), method = u16(cursor + 10)
            let crc = u32(cursor + 16)
            let compressed = Int(u32(cursor + 20)), size = Int(u32(cursor + 24))
            let nameLength = u16(cursor + 28), extraLength = u16(cursor + 30), commentLength = u16(cursor + 32)
            let localOffset = Int(u32(cursor + 42))
            // UTF-8, data descriptors and normal DEFLATE option bits only.
            try require(flags & ~0x080e == 0 && (method == 0 || method == 8))
            try require(method == 8 || flags & 0x0006 == 0)
            try require(u16(cursor + 34) == 0 && compressed != 0xffffffff && size <= maxEntryBytes)
            try require(size <= maxExpandedBytes - expanded)
            try require(size <= 1_024 * 1_024 || size / max(1, compressed) <= 1_000)
            let wholeName = try range(cursor + 46, nameLength + extraLength + commentLength, end: end)
            let nameRange = try range(cursor + 46, nameLength, end: wholeName.upperBound)
            guard let name = String(data: data[nameRange], encoding: .utf8) else { throw Invalid.archive }
            let isDirectory = name.hasSuffix("/")
            let path = isDirectory ? String(name.dropLast()) : name
            _ = try SyncFileSafety.relativePath(path)
            // ZIP paths are case-sensitive, but the destination filesystem may not
            // be. Reject duplicate/case aliases and file/directory collisions.
            let canonical = path.precomposedStringWithCanonicalMapping.lowercased()
            try require(names.insert(canonical).inserted)
            let unixMode = (u32(cursor + 38) >> 16) & 0xf000
            try require(unixMode == 0 || unixMode == (isDirectory ? 0x4000 : 0x8000))
            if !isDirectory { fileNames.insert(canonical) }
            expanded += size
            cursor = wholeName.upperBound

            _ = try range(localOffset, 30, end: cdStart)
            try require(u32(localOffset) == 0x04034b50 && u16(localOffset + 6) == flags && u16(localOffset + 8) == method)
            let localNameLength = u16(localOffset + 26), localExtraLength = u16(localOffset + 28)
            let header = try range(localOffset, 30 + localNameLength + localExtraLength, end: cdStart)
            let localName = try range(localOffset + 30, localNameLength, end: header.upperBound)
            try require(data[localName] == data[nameRange])
            if flags & 8 == 0 {
                try require(u32(localOffset + 14) == crc && Int(u32(localOffset + 18)) == compressed && Int(u32(localOffset + 22)) == size)
            }
            let body = try range(header.upperBound, compressed, end: cdStart)
            var regionEnd = body.upperBound
            if flags & 8 != 0 {
                _ = try range(regionEnd, 12, end: cdStart)
                if u32(regionEnd) == 0x08074b50 { regionEnd += 4 }
                _ = try range(regionEnd, 12, end: cdStart)
                try require(u32(regionEnd) == crc && Int(u32(regionEnd + 4)) == compressed && Int(u32(regionEnd + 8)) == size)
                regionEnd += 12
            }
            let region = localOffset..<regionEnd
            try require(!regions.contains { $0.overlaps(region) })
            regions.append(region)
            let content: Data
            if method == 0 {
                try require(compressed == size)
                content = Data(data[body])
            } else {
                guard let decoded = inflate(Data(data[body]), size), decoded.count == size else { throw Invalid.archive }
                content = decoded
            }
            try require(!isDirectory || content.isEmpty)
            try require(crc32(content) == crc)
            entries.append(Entry(name: name, isDirectory: isDirectory, data: content))
        }
        try require(cursor == end)
        for name in names {
            var parts = name.components(separatedBy: "/")
            while parts.count > 1 {
                parts.removeLast()
                try require(!fileNames.contains(parts.joined(separator: "/")))
            }
        }
        return entries
    }

    private static let crcTable: [UInt32] = (0..<256).map { value in
        var crc = UInt32(value)
        for _ in 0..<8 { crc = (crc >> 1) ^ ((crc & 1 == 1) ? 0xedb88320 : 0) }
        return crc
    }

    static func crc32(_ data: Data) -> UInt32 {
        var crc: UInt32 = 0xffffffff
        for byte in data { crc = (crc >> 8) ^ crcTable[Int((crc ^ UInt32(byte)) & 255)] }
        return crc ^ 0xffffffff
    }
}
