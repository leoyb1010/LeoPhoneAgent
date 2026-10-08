import Foundation

/// Cheap read-side access to a `.minisbak` without extracting it: list the
/// central directory and pull the (plaintext) manifest so the restore screen
/// can show what a package holds before anything is unpacked or decrypted.
enum BackupPackageReader {

    enum ReaderError: LocalizedError {
        case missingManifest
        case invalidManifest
        case incompatibleFormat(String)

        var errorDescription: String? {
            switch self {
            case .missingManifest: return String(localized: "这不是 LeoBot 备份包（缺少 manifest.json）")
            case .invalidManifest: return String(localized: "备份包的清单文件已损坏")
            case .incompatibleFormat(let f):
                return String(localized: "备份格式 \(f) 不受支持，请更新 LeoBot 后再试")
            }
        }
    }

    struct Peek: Sendable {
        var manifest: BackupManifest
        /// manifest.json exactly as stored (what the sidecar MAC covers).
        var rawManifest: Data
        /// `manifest.mac` sidecar, when present.
        var manifestMacSidecar: String?
        var entryCount: Int
        var totalUncompressedBytes: Int64
        var fileSize: Int64
    }

    static func listEntries(at url: URL) throws -> [BackupZipExtractor.Entry] {
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        return try BackupZipExtractor.centralDirectory(handle: handle)
    }

    /// Read and structurally validate the package, then decode its manifest.
    /// Rejects hostile layouts (traversal names, bombs) before the caller can
    /// even offer to restore.
    static func peek(at url: URL) throws -> Peek {
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        let fileSize = Int64((try? handle.seekToEnd()) ?? 0)
        let entries = try BackupZipExtractor.centralDirectory(handle: handle)
        try BackupZipExtractor.validate(entries, fileSize: fileSize, limits: .standard)
        // Our own packages are flat; legacy packages wrapped everything in a
        // single `minisbak-<id>/` folder.
        guard let entry = entries.first(where: { $0.name == "manifest.json" })
                ?? entries.first(where: { $0.name.hasSuffix("/manifest.json")
                                          && $0.name.split(separator: "/").count == 2 }) else {
            throw ReaderError.missingManifest
        }
        let data = try BackupZipExtractor.readEntry(entry, handle: handle, fileSize: fileSize,
                                                    maxBytes: BackupFormat.Limits.maxManifestBytes)
        let manifest = try decodeManifest(data)
        let prefix = String(entry.name.dropLast("manifest.json".count))
        let sidecar = entries.first(where: { $0.name == prefix + "manifest.mac" })
            .flatMap { try? BackupZipExtractor.readEntry($0, handle: handle, fileSize: fileSize, maxBytes: 4096) }
            .flatMap { String(data: $0, encoding: .utf8) }?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return Peek(manifest: manifest, rawManifest: data, manifestMacSidecar: sidecar,
                    entryCount: entries.count,
                    totalUncompressedBytes: entries.reduce(0) { $0 + $1.uncompressedSize },
                    fileSize: fileSize)
    }

    static func decodeManifest(_ data: Data) throws -> BackupManifest {
        guard let manifest = try? BackupDates.decoder().decode(BackupManifest.self, from: data) else {
            throw ReaderError.invalidManifest
        }
        guard isFormatSupported(manifest.format) else {
            throw ReaderError.incompatibleFormat(manifest.format)
        }
        return manifest
    }

    /// Same prefix and same MAJOR version; minor bumps import, a different
    /// product or a future major is refused outright.
    static func isFormatSupported(_ format: String) -> Bool {
        func parse(_ s: String) -> (prefix: String, major: Int)? {
            let parts = s.split(separator: "/", maxSplits: 1, omittingEmptySubsequences: false)
            guard parts.count == 2, !parts[0].isEmpty else { return nil }
            let majorText = parts[1].split(separator: ".", omittingEmptySubsequences: false)
                .first.map(String.init) ?? ""
            guard !majorText.isEmpty, majorText.allSatisfy(\.isASCII), let major = Int(majorText) else { return nil }
            return (String(parts[0]), major)
        }
        guard let found = parse(format), let supported = parse(BackupFormat.current) else { return false }
        return found.prefix == supported.prefix && found.major == supported.major
    }
}
