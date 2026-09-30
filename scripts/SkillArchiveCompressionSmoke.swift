import Foundation
import Compression // Intentionally unconditional: this fixture must use Apple's SDK.

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
        let expansion = bytes("edc1010d000000c2a06cef5fca1e0e28000000e0dd00")
        precondition(SafeSkillArchive.decompress(expansion, expectedSize: 1) == nil)
        precondition(SafeSkillArchive.decompress(expansion, expectedSize: 4096) == Data(repeating: 65, count: 4096))
        for path in CommandLine.arguments.dropFirst() {
            let entries = try SafeSkillArchive.read(Data(contentsOf: URL(fileURLWithPath: path)))
            precondition(entries.count == 2)
            precondition(entries.first { $0.name == "SKILL.md" }?.data == expected)
            precondition(entries.first { $0.name == "empty.txt" }?.data == Data())
        }
        print("Apple Compression: valid, empty, every truncation, size mismatch, trailing bytes, overexpansion and ZIP fixtures PASS")
    }
}
