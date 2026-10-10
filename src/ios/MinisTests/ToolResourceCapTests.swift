import XCTest
import ImageIO
import UniformTypeIdentifiers

/// [B5] read_image never decodes an unreasonable image at full size.
final class ReadImageGuardTests: XCTestCase {

    /// A PNG with a valid IHDR claiming `width`×`height` and an IDAT of
    /// filler bytes. ImageIO reports the dimensions from the header (it wants
    /// a plausible file size first, hence the 1.5 MB filler) without decoding
    /// anything — exactly what a hostile oversized image looks like.
    private func pngHeader(width: UInt32, height: UInt32) -> Data {
        var data = Data([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])
        var ihdr = Data("IHDR".utf8)
        for v in [width, height] { withUnsafeBytes(of: v.bigEndian) { ihdr.append(contentsOf: $0) } }
        ihdr.append(contentsOf: [8, 6, 0, 0, 0]) // 8-bit RGBA
        withUnsafeBytes(of: UInt32(13).bigEndian) { data.append(contentsOf: $0) }
        data.append(ihdr)
        withUnsafeBytes(of: crc32(ihdr).bigEndian) { data.append(contentsOf: $0) }
        var idat = Data("IDAT".utf8)
        idat.append(contentsOf: [0x78, 0x9C])
        idat.append(Data(count: 1_500_000))
        withUnsafeBytes(of: UInt32(idat.count - 4).bigEndian) { data.append(contentsOf: $0) }
        data.append(idat)
        withUnsafeBytes(of: crc32(idat).bigEndian) { data.append(contentsOf: $0) }
        // IEND
        let iend = Data("IEND".utf8)
        withUnsafeBytes(of: UInt32(0).bigEndian) { data.append(contentsOf: $0) }
        data.append(iend)
        withUnsafeBytes(of: crc32(iend).bigEndian) { data.append(contentsOf: $0) }
        return data
    }

    private static let crcTable: [UInt32] = (0..<256).map { n -> UInt32 in
        var c = UInt32(n)
        for _ in 0..<8 { c = (c & 1) != 0 ? (c >> 1) ^ 0xEDB8_8320 : c >> 1 }
        return c
    }

    private func crc32(_ data: Data) -> UInt32 {
        let table = Self.crcTable
        var crc: UInt32 = 0xFFFF_FFFF
        data.withUnsafeBytes { raw in
            for byte in raw { crc = table[Int((crc ^ UInt32(byte)) & 0xFF)] ^ (crc >> 8) }
        }
        return crc ^ 0xFFFF_FFFF
    }

    func testReadImageRefusesOversizedDimensions() throws {
        let probe = try XCTUnwrap(ImageInputGuard.probe(data: pngHeader(width: 40_000, height: 40_000)))
        XCTAssertEqual(probe.pixelWidth, 40_000)
        XCTAssertEqual(probe.pixelHeight, 40_000)
        guard case .refuse(let reason) = ImageInputGuard.decide(probe) else {
            return XCTFail("a 1.6 GP image must be refused, not decoded")
        }
        XCTAssertTrue(reason.contains("40000×40000"))

        // Through the file path the tool uses.
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("hostile-\(UUID().uuidString).png")
        try pngHeader(width: 30_000, height: 30_000).write(to: url)
        defer { try? FileManager.default.removeItem(at: url) }
        guard case .failure(.refused) = ImageInputGuard.prepare(url: url) else {
            return XCTFail("prepare must refuse before decoding")
        }
    }

    func testDecisionRules() {
        let mb = 1_048_576
        func probe(_ bytes: Int, _ w: Int, _ h: Int, _ type: String) -> ImageInputGuard.Probe {
            .init(fileBytes: bytes, pixelWidth: w, pixelHeight: h, typeIdentifier: type)
        }
        if case .refuse = ImageInputGuard.decide(probe(500 * mb, 100, 100, UTType.jpeg.identifier)) {} else {
            XCTFail("a 500 MB file is refused by size alone")
        }
        // > 50 MP JPEG decodes via subsampled thumbnail; > 50 MP PNG is refused.
        XCTAssertEqual(ImageInputGuard.decide(probe(20 * mb, 9000, 9000, UTType.jpeg.identifier)), .downsample(maxPixelSize: 2000))
        if case .refuse = ImageInputGuard.decide(probe(20 * mb, 9000, 9000, UTType.png.identifier)) {} else {
            XCTFail("an 81 MP PNG must not be decoded at full size")
        }
        if case .refuse = ImageInputGuard.decide(probe(20 * mb, 30_000, 30_000, UTType.jpeg.identifier)) {} else {
            XCTFail("past the hard cap even JPEG is refused")
        }
        XCTAssertEqual(ImageInputGuard.decide(probe(1 * mb, 4000, 3000, UTType.png.identifier)), .downsample(maxPixelSize: 2000))
        XCTAssertEqual(ImageInputGuard.decide(probe(10_000, 800, 600, UTType.png.identifier)), .downsample(maxPixelSize: 800),
                       "small images are not upscaled")
    }

    func testPrepareProducesModelSizedJPEG() throws {
        // 3000×1000 opaque image → long edge 2000.
        let ctx = try XCTUnwrap(CGContext(data: nil, width: 3000, height: 1000, bitsPerComponent: 8, bytesPerRow: 0,
                                          space: CGColorSpaceCreateDeviceRGB(),
                                          bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue))
        ctx.setFillColor(CGColor(red: 0.2, green: 0.4, blue: 0.6, alpha: 1))
        ctx.fill(CGRect(x: 0, y: 0, width: 3000, height: 1000))
        let image = try XCTUnwrap(ctx.makeImage())
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("ok-\(UUID().uuidString).png")
        let dest = try XCTUnwrap(CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil))
        CGImageDestinationAddImage(dest, image, nil)
        XCTAssertTrue(CGImageDestinationFinalize(dest))
        defer { try? FileManager.default.removeItem(at: url) }

        guard case .success(let prepared) = ImageInputGuard.prepare(url: url) else { return XCTFail("a normal image loads") }
        XCTAssertEqual(prepared.probe.pixelWidth, 3000)
        XCTAssertEqual(max(prepared.width, prepared.height), 2000)
        XCTAssertEqual(Array(prepared.jpegData.prefix(2)), [0xFF, 0xD8], "JPEG output")
    }

    func testNotAnImageFails() throws {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("text-\(UUID().uuidString).png")
        try Data("not an image".utf8).write(to: url)
        defer { try? FileManager.default.removeItem(at: url) }
        guard case .failure(.notAnImage) = ImageInputGuard.prepare(url: url) else { return XCTFail() }
    }
}

/// [B7] Memory is injected into every future prompt: entries and fragments are byte-capped.
final class MemoryWriteCapTests: XCTestCase {

    func testMemoryWriteCapsEntrySize() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("mem-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: dir) }
        let huge = String(repeating: "记", count: 10 * 1_048_576 / 3) // ~10 MB of UTF-8
        let name = try MemoryDailyLog.prepend(huge, in: dir)
        let size = try XCTUnwrap(ToolResourceLimits.fileSize(at: dir.appendingPathComponent(name)))
        XCTAssertLessThan(size, MemoryDailyLog.maxEntryBytes + 200, "one entry ≈ 8 KB plus its timestamp line")
        let text = try String(contentsOf: dir.appendingPathComponent(name), encoding: .utf8)
        XCTAssertTrue(text.contains("…[truncated]"))
    }

    func testCappedRespectsCharacterBoundaries() {
        let s = String(repeating: "数", count: 1000) // 3000 bytes
        let capped = MemoryDailyLog.capped(s, maxBytes: 1024)
        XCTAssertLessThanOrEqual(capped.utf8.count, 1024)
        XCTAssertTrue(capped.hasSuffix("…[truncated]"))
        XCTAssertFalse(capped.contains("\u{FFFD}"))
        XCTAssertEqual(MemoryDailyLog.capped("short", maxBytes: 1024), "short")
        let emoji = String(repeating: "👨‍👩‍👧‍👦", count: 200)
        XCTAssertLessThanOrEqual(MemoryDailyLog.capped(emoji, maxBytes: 100).utf8.count, 100)
    }

    func testReadPrefixNeverLoadsTheWholeFile() throws {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("prefix-\(UUID().uuidString).md")
        defer { try? FileManager.default.removeItem(at: url) }
        try Data(String(repeating: "é", count: 50_000).utf8).write(to: url) // 100 KB
        let read = try XCTUnwrap(MemoryDailyLog.readPrefix(of: url, maxBytes: 1001)) // splits a 2-byte char
        XCTAssertTrue(read.truncated)
        XCTAssertEqual(read.text.utf8.count, 1000)
        XCTAssertEqual(MemoryDailyLog.readPrefix(of: url, maxBytes: 1_000_000)?.truncated, false)
    }
}
