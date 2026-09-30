import Foundation
import zlib // Unconditional: this fixture must execute the production decoder.

@main enum SkillArchiveCompressionSmoke {
    static func bytes(_ hex: String) -> Data {
        Data(stride(from: 0, to: hex.count, by: 2).map { index in
            let start = hex.index(hex.startIndex, offsetBy: index)
            return UInt8(hex[start..<hex.index(start, offsetBy: 2)], radix: 16)!
        })
    }
    static func main() throws {
        // Independent Python zlib.compressobj(wbits: -15) fixtures, not output
        // encoded by the implementation under test. ZIP uses raw DEFLATE.
        let input = bytes("cb48cdc9c957482bcacf55702c28c8495570cecf2d284a2d2ececccfe30200")
        let expected = Data("hello from Apple Compression\n".utf8)
        precondition(SafeSkillArchive.decompress(input, expectedSize: expected.count) == expected)
        precondition(SafeSkillArchive.decompress(bytes("0300"), expectedSize: 0) == Data())
        precondition(SafeSkillArchive.decompress(Data(), expectedSize: 0) == nil)
        for length in 0..<input.count {
            precondition(SafeSkillArchive.decompress(Data(input.prefix(length)), expectedSize: expected.count) == nil,
                         "truncated DEFLATE must fail at byte \(length)")
        }
        precondition(SafeSkillArchive.decompress(input, expectedSize: expected.count - 1) == nil)
        precondition(SafeSkillArchive.decompress(input, expectedSize: expected.count + 1) == nil)
        precondition(SafeSkillArchive.decompress(input + Data([0]), expectedSize: expected.count) == nil)
        for suffix in [Data([0xff]), Data(repeating: 0, count: 32), input, bytes("0300")] {
            precondition(SafeSkillArchive.decompress(input + suffix, expectedSize: expected.count) == nil,
                         "trailing bytes and concatenated streams must fail")
        }
        precondition(SafeSkillArchive.decompress(bytes("030000"), expectedSize: 0) == nil)
        precondition(SafeSkillArchive.decompress(input, expectedSize: -1) == nil)
        precondition(SafeSkillArchive.decompress(input, expectedSize: SafeSkillArchive.maxEntryBytes + 1) == nil)
        let expansion = bytes("edc1010d000000c2a06cef5fca1e0e28000000e0dd00")
        precondition(SafeSkillArchive.decompress(expansion, expectedSize: 1) == nil)
        precondition(SafeSkillArchive.decompress(expansion, expectedSize: 4096) == Data(repeating: 65, count: 4096))
        for path in CommandLine.arguments.dropFirst() {
            if path.hasSuffix(".invalid.zip") {
                let archive = try Data(contentsOf: URL(fileURLWithPath: path))
                // Control: every ZIP header, size, path and CRC is valid. Only
                // the actual decoder's exact input consumption can reject it.
                let control = try SafeSkillArchive.read(archive, inflate: { _, _ in expected })
                precondition(control.count == 1 && control[0].data == expected)
                do {
                    _ = try SafeSkillArchive.read(archive)
                    preconditionFailure("ZIP with trailing bytes inside its DEFLATE entry must fail: \(path)")
                } catch SafeSkillArchive.Invalid.archive { }
                continue
            }
            let entries = try SafeSkillArchive.read(Data(contentsOf: URL(fileURLWithPath: path)))
            precondition(entries.count == 2)
            precondition(entries.first { $0.name == "SKILL.md" }?.data == expected)
            precondition(entries.first { $0.name == "empty.txt" }?.data == Data())
        }
        print("System zlib raw DEFLATE: valid, empty, every truncation, size mismatch, trailing bytes, concatenated streams, overexpansion and ZIP fixtures PASS")
    }
}
