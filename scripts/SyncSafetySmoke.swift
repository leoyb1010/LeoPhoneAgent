import Foundation

@main enum SyncSafetySmoke {
    static func rejected(_ block: () throws -> Void) {
        do { try block(); preconditionFailure("unsafe input was accepted") } catch {}
    }
    static func zip(_ files: [(String, Data)]) -> Data {
        var data = Data(), central = Data()
        func u16(_ value: Int) -> Data { Data([UInt8(value & 255), UInt8((value >> 8) & 255)]) }
        func u32(_ value: Int) -> Data { Data((0..<4).map { UInt8((value >> ($0 * 8)) & 255) }) }
        for (path, body) in files {
            let name = Data(path.utf8), offset = data.count, crc = Int(SafeSkillArchive.crc32(body))
            data += u32(0x04034b50) + u16(20) + u16(0x800) + u16(0) + u16(0) + u16(0)
            data += u32(crc) + u32(body.count) + u32(body.count) + u16(name.count) + u16(0) + name + body
            central += u32(0x02014b50) + u16(20) + u16(20) + u16(0x800) + u16(0) + u16(0) + u16(0)
            central += u32(crc) + u32(body.count) + u32(body.count) + u16(name.count) + u16(0) + u16(0)
            central += u16(0) + u16(0) + u32(0) + u32(offset) + name
        }
        let start = data.count
        data += central
        data += u32(0x06054b50) + u16(0) + u16(0) + u16(files.count) + u16(files.count)
        data += u32(central.count) + u32(start) + u16(0)
        return data
    }
    static func main() throws {
        let fm = FileManager.default, root = fm.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try fm.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? fm.removeItem(at: root) }
        let outside = root.appendingPathComponent("outside"), safe = root.appendingPathComponent("safe")
        try fm.createDirectory(at: outside, withIntermediateDirectories: true)
        try fm.createDirectory(at: safe, withIntermediateDirectories: true)
        try fm.createSymbolicLink(at: safe.appendingPathComponent("linked"), withDestinationURL: outside)
        for path in ["../outside/secret", "/absolute", "session/../../outside", "session//x", "session/./x", "session\\x", "session/\0x", "linked/secret", "linked"] {
            rejected { _ = try SyncFileSafety.destination(root: safe, relativePath: path) }
        }
        let legacy = try SyncFileSafety.destination(root: safe, relativePath: "legacy.skill-名/files/read me.md")
        precondition(legacy.path.hasPrefix(safe.path + "/"))
        for date in ["../outside", "2026-02-30", "2026-9-01", "2026-09-30/x"] { rejected { _ = try SyncFileSafety.dailyKey(date) } }
        let date = try SyncFileSafety.dailyKey("2026-09-30"); precondition(date == "2026-09-30")
        let old = safe.appendingPathComponent("old.txt")
        try Data("old bytes".utf8).write(to: old)
        rejected { try SyncFileSafety.replaceFile(from: root.appendingPathComponent("missing"), to: old, modifiedAt: Date()) }
        let oldBytes = try Data(contentsOf: old); precondition(oldBytes == Data("old bytes".utf8))
        let source = root.appendingPathComponent("source")
        try Data("new bytes".utf8).write(to: source)
        try SyncFileSafety.replaceFile(from: source, to: old, modifiedAt: Date(timeIntervalSince1970: 100))
        let newBytes = try Data(contentsOf: old); precondition(newBytes == Data("new bytes".utf8))
        let clock = Date(timeIntervalSince1970: 100)
        rejected { _ = try SyncFileSafety.removeFile(root: safe, relativePath: "old.txt", remoteUpdatedAt: nil, hasPendingEdit: true) }
        precondition(fm.fileExists(atPath: old.path), "clockless delete must retain unpublished local edit")
        let kept = try SyncFileSafety.removeFile(root: safe, relativePath: "old.txt", remoteUpdatedAt: clock.addingTimeInterval(-1), hasPendingEdit: false)
        precondition(!kept && fm.fileExists(atPath: old.path), "older tombstone must preserve recreated/newer file")
        let deleted = try SyncFileSafety.removeFile(root: safe, relativePath: "old.txt", remoteUpdatedAt: clock.addingTimeInterval(1), hasPendingEdit: false)
        precondition(deleted && !fm.fileExists(atPath: old.path) && fm.fileExists(atPath: source.path))
        let absent = try SyncFileSafety.removeFile(root: safe, relativePath: "old.txt", remoteUpdatedAt: nil, hasPendingEdit: false)
        precondition(absent, "replayed delete must be idempotent")
        let a = SyncMemoryEntries.Entry(timestamp: "same second", content: "A")
        let b = SyncMemoryEntries.Entry(timestamp: "same second", content: "B")
        let c = SyncMemoryEntries.Entry(timestamp: "same second", content: "C")
        let d = SyncMemoryEntries.Entry(timestamp: "new second", content: "D")
        let ab = SyncMemoryEntries.union([a], [b])
        let persisted = SyncMemoryEntries.parse(from: SyncMemoryEntries.serialize(ab))
        let abc = SyncMemoryEntries.union(persisted, [c])
        precondition(abc.count == 3 && Set(abc) == Set([a,b,c]))
        precondition(SyncMemoryEntries.union(abc, [b]) == abc)
        precondition(SyncMemoryEntries.union([a,b], [c,d]) == SyncMemoryEntries.union([c,d], [b,a]))
        precondition(SyncMemoryEntries.union(ab, [c,d]) == SyncMemoryEntries.union([a], SyncMemoryEntries.union([b], [c,d])))
        let valid = zip([("SKILL.md", Data("# Skill".utf8)), ("scripts/工具.sh", Data("echo ok".utf8)), ("empty", Data())])
        let noInflate: (Data, Int) -> Data? = { _, _ in preconditionFailure("stored ZIP invoked inflate") }
        let decoded = try SafeSkillArchive.read(valid, inflate: noInflate); precondition(decoded.count == 3)
        for path in ["../escape", "/absolute", "x/../../escape", "x\\escape", "./x", "x//y"] {
            rejected { _ = try SafeSkillArchive.read(zip([(path, Data("x".utf8))]), inflate: noInflate) }
        }
        for files in [[("same", Data()), ("same", Data())], [("Same", Data()), ("same", Data())], [("parent", Data()), ("parent/child", Data())]] {
            rejected { _ = try SafeSkillArchive.read(zip(files), inflate: noInflate) }
        }
        // Every truncation must fail as a whole, never return partial entries.
        for length in 0..<valid.count { rejected { _ = try SafeSkillArchive.read(valid.prefix(length), inflate: noInflate) } }
        var corruptCRC = valid; corruptCRC[30 + "SKILL.md".utf8.count] ^= 1
        rejected { _ = try SafeSkillArchive.read(corruptCRC, inflate: noInflate) }
        var oversized = zip([("SKILL.md", Data("x".utf8))])
        let central = 30 + "SKILL.md".utf8.count + 1
        for offset in [central + 24, central + 42] {
            var copy = oversized
            for i in 0..<4 { copy[offset+i] = 255 }
            rejected { _ = try SafeSkillArchive.read(copy, inflate: noInflate) }
        }
        oversized[central + 28] = 255; oversized[central + 29] = 255
        rejected { _ = try SafeSkillArchive.read(oversized, inflate: noInflate) }
        // Deterministic malformed-data fuzz: exercise slices/header lengths safely.
        var state: UInt64 = 7
        for _ in 0..<2_000 {
            var bytes = valid
            state = state &* 6364136223846793005 &+ 1
            let index = Int(state % UInt64(bytes.count))
            bytes[index] ^= UInt8((state >> 32) & 255)
            _ = try? SafeSkillArchive.read(bytes, inflate: { _, _ in nil })
        }
        print("SyncSafetySmoke: root containment, symlinks, atomic failure, dates, memory union, ZIP validation/budgets/fuzz passed")
    }
}
