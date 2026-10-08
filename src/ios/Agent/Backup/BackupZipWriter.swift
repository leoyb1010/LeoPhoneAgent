import Foundation
import zlib

/// Sequential STORED-only ZIP writer (ported from upstream).
///
/// Every member is STORED: both ends are phones, and on this workload deflate
/// costs CPU twice for little gain (upstream measured 3.1x faster packing and
/// no inflate on restore). STORED also keeps both ends a plain bounded copy.
///
/// No data descriptors: every entry is measured before its header is written,
/// so the header carries real sizes. ZIP64 records are emitted whenever a
/// value overflows, so packages past 4 GB / 65 535 members stay readable.
final class BackupZipWriter {

    enum WriteError: LocalizedError {
        case cannotCreate

        var errorDescription: String? {
            String(localized: "无法创建备份包文件")
        }
    }

    private struct Record {
        let name: String
        let crc: UInt32
        let size: UInt64
        let localHeaderOffset: UInt64
    }

    let url: URL
    private let handle: FileHandle
    private var records: [Record] = []
    private var offset: UInt64 = 0
    private(set) var writtenNames: Set<String> = []

    init(url: URL) throws {
        self.url = url
        let fm = FileManager.default
        try? fm.removeItem(at: url)
        guard fm.createFile(atPath: url.path, contents: nil) else { throw WriteError.cannotCreate }
        handle = try FileHandle(forWritingTo: url)
    }

    /// Append a file on disk. Returns false if the name was already written.
    @discardableResult
    func addFile(at source: URL, name: String) throws -> Bool {
        guard !writtenNames.contains(name) else { return false }
        let size = (try? FileManager.default.attributesOfItem(atPath: source.path)[.size] as? UInt64) ?? 0
        let crc = try Self.crc32OfFile(at: source)
        try writeEntry(name: name, crc: crc, size: size) { h in
            try Self.copyContents(of: source, into: h, expected: size)
        }
        writtenNames.insert(name)
        return true
    }

    /// Append in-memory bytes (manifest, indexes — always small).
    @discardableResult
    func addData(_ data: Data, name: String) throws -> Bool {
        guard !writtenNames.contains(name) else { return false }
        try writeEntry(name: name, crc: Self.crc32(data), size: UInt64(data.count)) { h in
            try h.write(contentsOf: data)
        }
        writtenNames.insert(name)
        return true
    }

    /// Central directory + (ZIP64) end records.
    func close() throws {
        let cdStart = offset
        var cd = Data()
        for r in records { cd.append(centralHeader(for: r)) }
        try handle.write(contentsOf: cd)
        offset += UInt64(cd.count)

        let needsZip64 = cdStart >= 0xFFFF_FFFF
            || UInt64(cd.count) >= 0xFFFF_FFFF
            || records.count >= 0xFFFF
            || records.contains { $0.localHeaderOffset >= 0xFFFF_FFFF }

        if needsZip64 {
            var z = Data()
            Self.append32(&z, 0x0606_4B50)
            Self.append64(&z, 44)
            Self.append16(&z, 45); Self.append16(&z, 45)
            Self.append32(&z, 0); Self.append32(&z, 0)
            Self.append64(&z, UInt64(records.count))
            Self.append64(&z, UInt64(records.count))
            Self.append64(&z, UInt64(cd.count))
            Self.append64(&z, cdStart)
            Self.append32(&z, 0x0706_4B50)
            Self.append32(&z, 0)
            Self.append64(&z, offset)
            Self.append32(&z, 1)
            try handle.write(contentsOf: z)
            offset += UInt64(z.count)
        }

        var e = Data()
        Self.append32(&e, 0x0605_4B50)
        Self.append16(&e, 0); Self.append16(&e, 0)
        let count16 = UInt16(min(records.count, 0xFFFF))
        Self.append16(&e, count16); Self.append16(&e, count16)
        Self.append32(&e, UInt32(min(UInt64(cd.count), 0xFFFF_FFFF)))
        Self.append32(&e, UInt32(min(cdStart, 0xFFFF_FFFF)))
        Self.append16(&e, 0)
        try handle.write(contentsOf: e)
        offset += UInt64(e.count)
        try handle.close()
    }

    /// Abandon a partially written package (cancel / failure path).
    func abort() {
        try? handle.close()
        try? FileManager.default.removeItem(at: url)
    }

    // MARK: - Entry writing

    /// Writes EXACTLY `expected` bytes — truncating a file that grew, padding
    /// one that shrank — so a racing writer can only corrupt its own member
    /// (which then fails its integrity hash) instead of desyncing every later
    /// offset in the archive.
    private static func copyContents(of source: URL, into h: FileHandle, expected: UInt64) throws {
        let input = try FileHandle(forReadingFrom: source)
        defer { try? input.close() }
        var remaining = expected
        while remaining > 0 {
            let done: Bool = try autoreleasepool {
                let want = Int(min(remaining, 4 * 1024 * 1024))
                guard let chunk = try input.read(upToCount: want), !chunk.isEmpty else { return true }
                try h.write(contentsOf: chunk)
                remaining -= UInt64(chunk.count)
                return false
            }
            if done { break }
        }
        while remaining > 0 {
            let n = Int(min(remaining, 4 * 1024 * 1024))
            try autoreleasepool { try h.write(contentsOf: Data(count: n)) }
            remaining -= UInt64(n)
        }
    }

    private func writeEntry(name: String, crc: UInt32, size: UInt64,
                            _ body: (FileHandle) throws -> Void) throws {
        let localOffset = offset
        let nameBytes = Array(name.utf8)
        let big = size >= 0xFFFF_FFFF || localOffset >= 0xFFFF_FFFF

        var h = Data()
        Self.append32(&h, 0x0403_4B50)
        Self.append16(&h, big ? 45 : 20)
        Self.append16(&h, 0x0800)              // UTF-8 names; never bit 3
        Self.append16(&h, 0)                   // STORED
        Self.append16(&h, 0); Self.append16(&h, 0)
        Self.append32(&h, crc)
        Self.append32(&h, big ? 0xFFFF_FFFF : UInt32(size))
        Self.append32(&h, big ? 0xFFFF_FFFF : UInt32(size))
        Self.append16(&h, UInt16(nameBytes.count))
        Self.append16(&h, big ? 20 : 0)
        h.append(contentsOf: nameBytes)
        if big {
            Self.append16(&h, 0x0001); Self.append16(&h, 16)
            Self.append64(&h, size)
            Self.append64(&h, size)
        }
        try handle.write(contentsOf: h)
        offset += UInt64(h.count)

        try body(handle)
        offset += size

        records.append(Record(name: name, crc: crc, size: size, localHeaderOffset: localOffset))
    }

    private func centralHeader(for r: Record) -> Data {
        let nameBytes = Array(r.name.utf8)
        var extra = Data()
        if r.size >= 0xFFFF_FFFF { Self.append64(&extra, r.size); Self.append64(&extra, r.size) }
        if r.localHeaderOffset >= 0xFFFF_FFFF { Self.append64(&extra, r.localHeaderOffset) }

        var h = Data()
        Self.append32(&h, 0x0201_4B50)
        Self.append16(&h, 45)
        Self.append16(&h, extra.isEmpty ? 20 : 45)
        Self.append16(&h, 0x0800)
        Self.append16(&h, 0)
        Self.append16(&h, 0); Self.append16(&h, 0)
        Self.append32(&h, r.crc)
        Self.append32(&h, r.size >= 0xFFFF_FFFF ? 0xFFFF_FFFF : UInt32(r.size))
        Self.append32(&h, r.size >= 0xFFFF_FFFF ? 0xFFFF_FFFF : UInt32(r.size))
        Self.append16(&h, UInt16(nameBytes.count))
        Self.append16(&h, extra.isEmpty ? 0 : UInt16(extra.count + 4))
        Self.append16(&h, 0)
        Self.append16(&h, 0)
        Self.append16(&h, 0); Self.append32(&h, 0)
        Self.append32(&h, r.localHeaderOffset >= 0xFFFF_FFFF ? 0xFFFF_FFFF : UInt32(r.localHeaderOffset))
        h.append(contentsOf: nameBytes)
        if !extra.isEmpty {
            Self.append16(&h, 0x0001)
            Self.append16(&h, UInt16(extra.count))
            h.append(extra)
        }
        return h
    }

    // MARK: - Primitives

    private static func append16(_ d: inout Data, _ v: UInt16) {
        withUnsafeBytes(of: v.littleEndian) { d.append(contentsOf: $0) }
    }
    private static func append32(_ d: inout Data, _ v: UInt32) {
        withUnsafeBytes(of: v.littleEndian) { d.append(contentsOf: $0) }
    }
    private static func append64(_ d: inout Data, _ v: UInt64) {
        withUnsafeBytes(of: v.littleEndian) { d.append(contentsOf: $0) }
    }

    // MARK: - CRC32 (zlib: vectorised / hardware CRC, ~40x the table loop)

    private static func zCRC32(_ seed: uLong, _ data: Data) -> uLong {
        guard !data.isEmpty else { return seed }
        return data.withUnsafeBytes { buf -> uLong in
            guard let base = buf.bindMemory(to: Bytef.self).baseAddress else { return seed }
            return zlib.crc32(seed, base, uInt(buf.count))
        }
    }

    static func crc32(_ data: Data) -> UInt32 { UInt32(zCRC32(0, data)) }

    static func crc32OfFile(at url: URL) throws -> UInt32 {
        let h = try FileHandle(forReadingFrom: url)
        defer { try? h.close() }
        var c: uLong = 0
        while true {
            let done: Bool = try autoreleasepool {
                guard let chunk = try h.read(upToCount: 4 * 1024 * 1024), !chunk.isEmpty else { return true }
                c = zCRC32(c, chunk)
                return false
            }
            if done { break }
        }
        return UInt32(c)
    }
}
