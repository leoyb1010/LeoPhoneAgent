import Foundation

/// Append-only JSONL writer with shard rollover (`messages.jsonl`,
/// `messages-0002.jsonl`, …). Every record is one self-contained line, so a
/// reader can skip a bad record without losing the file, and nothing
/// accumulates in memory.
final class BackupJSONLWriter {
    private let directory: URL
    private let baseName: String
    private let maxShardBytes: Int

    private var handle: FileHandle?
    private var currentBytes = 0
    private var shardIndex = 1

    private(set) var writtenRecords = 0
    private(set) var totalBytes: Int64 = 0
    private(set) var shardPaths: [String] = []

    private let encoder = BackupDates.encoder()

    init(directory: URL, baseName: String, maxShardBytes: Int = BackupFormat.maxShardBytes) {
        self.directory = directory
        self.baseName = baseName
        self.maxShardBytes = maxShardBytes
    }

    func write<T: Codable>(_ envelope: BackupRecordEnvelope<T>) throws {
        var line = try encoder.encode(envelope)
        line.append(0x0A)
        if handle == nil || currentBytes + line.count > maxShardBytes {
            try rollover()
        }
        guard let handle else { throw BackupError.writeFailed(baseName) }
        try handle.write(contentsOf: line)
        currentBytes += line.count
        totalBytes += Int64(line.count)
        writtenRecords += 1
    }

    private func rollover() throws {
        try close()
        let name = shardIndex == 1 ? "\(baseName).jsonl" : String(format: "%@-%04d.jsonl", baseName, shardIndex)
        let url = directory.appendingPathComponent(name)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        FileManager.default.createFile(atPath: url.path, contents: nil)
        handle = try FileHandle(forWritingTo: url)
        currentBytes = 0
        shardIndex += 1
        shardPaths.append(name)
    }

    func close() throws {
        try handle?.close()
        handle = nil
    }

    var isEmpty: Bool { writtenRecords == 0 }
}

/// Reader for `data/<base>.jsonl` + `<base>-NNNN.jsonl` shards.
enum BackupJSONLReader {

    /// Shard files for `base`, in order.
    static func shards(in dir: URL, base: String) -> [URL] {
        let names = ((try? FileManager.default.contentsOfDirectory(atPath: dir.path)) ?? [])
            .filter { $0 == "\(base).jsonl" || ($0.hasPrefix("\(base)-") && $0.hasSuffix(".jsonl")
                                                 && $0.dropFirst(base.count + 1).dropLast(6).allSatisfy(\.isNumber)) }
            .sorted()
        return names.map { dir.appendingPathComponent($0) }
    }

    struct Stats: Sendable {
        var decoded = 0
        var unreadable = 0
    }

    /// Stream every record of type `T`, unwrapping the envelope. A line this
    /// build cannot parse is counted and skipped; an oversized shard (beyond
    /// the format's own cap) is refused as unreadable rather than buffered.
    @discardableResult
    static func forEach<T: Codable>(in dir: URL, base: String, as type: T.Type,
                                    _ body: (T) throws -> Void) rethrows -> Stats {
        var stats = Stats()
        let decoder = BackupDates.decoder()
        for url in shards(in: dir, base: base) {
            let size = (try? FileManager.default.attributesOfItem(atPath: url.path)[.size] as? Int64) ?? 0
            guard size <= BackupFormat.Limits.maxDataFileBytes,
                  let data = try? Data(contentsOf: url, options: .mappedIfSafe) else {
                stats.unreadable += 1
                continue
            }
            for line in data.split(separator: 0x0A) where !line.isEmpty {
                let record: T? = autoreleasepool {
                    (try? decoder.decode(BackupRecordEnvelope<T>.self, from: Data(line)))?.d
                }
                if let record {
                    stats.decoded += 1
                    try body(record)
                } else {
                    stats.unreadable += 1
                }
            }
        }
        return stats
    }

    static func readAll<T: Codable>(in dir: URL, base: String, as type: T.Type) -> [T] {
        var out: [T] = []
        forEach(in: dir, base: base, as: type) { out.append($0) }
        return out
    }
}

/// One-shot JSON files (`provider_config.json`, `env_vars.json`, manifest).
enum BackupJSONFile {
    static func write<T: Encodable>(_ value: T, to url: URL) throws {
        let data = try BackupDates.encoder(pretty: true).encode(value)
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(),
                                                withIntermediateDirectories: true)
        try data.write(to: url, options: .atomic)
    }

    /// Bounded read of a package data file.
    static func read(_ url: URL) -> Data? {
        let size = (try? FileManager.default.attributesOfItem(atPath: url.path)[.size] as? Int64) ?? 0
        guard size <= BackupFormat.Limits.maxDataFileBytes else { return nil }
        return try? Data(contentsOf: url)
    }
}
