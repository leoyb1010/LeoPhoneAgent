import CryptoKit
import Foundation

private let logger = AppLogger(category: "Backup")

/// Builds a `.minisbak` package.
///
/// Everything streams into one STORED zip in `workRoot` (tmp): blobs go
/// straight from a per-file clone into the package (sealed first when a
/// passphrase is set), the small members (JSONL, indexes, secrets) are staged
/// and appended at the end, the manifest last. The package is written under a
/// `.partial` name and only renamed once complete and re-readable, so an
/// interrupted run never leaves a plausible-looking but truncated package.
///
/// Credentials policy: Keychain secrets are exported ONLY into a
/// passphrase-encrypted package. Without a passphrase, `secrets.json` is not
/// written, env-var values are not exported, and MCP server headers / env /
/// URL credentials are redacted.
actor BackupExporter {

    struct Options: Sendable {
        var categories: Set<BackupCategory> = Set(BackupCategory.backupable)
        /// nil = no per-file size cap (default: a backup must not silently drop files).
        var maxFileBytes: Int64?
        /// nil / empty = unencrypted package without credentials.
        var passphrase: String?
        /// Data cut-off: the package is the state as of this instant.
        var snapshotAt: Date = Date()

        init(categories: Set<BackupCategory> = Set(BackupCategory.backupable),
             maxFileBytes: Int64? = nil, passphrase: String? = nil, snapshotAt: Date = Date()) {
            self.categories = categories.intersection(BackupCategory.backupable)
            self.maxFileBytes = maxFileBytes
            self.passphrase = passphrase
            self.snapshotAt = snapshotAt
        }

        var isEncrypted: Bool { !(passphrase ?? "").isEmpty }
    }

    struct Summary: Sendable {
        var packageURL: URL
        var backupId: String
        var totalBytes: Int64
        var categories: [String: BackupManifest.CategoryStat]
        var encrypted: Bool
        var credentialsIncluded: Bool
        var skippedFiles: Int
        var skippedBytes: Int64
        var skippedPaths: [BackupHistory.SkippedEntry]
        var notDownloadedFiles: Int
        var mcpServersRedacted: Int
        var duration: TimeInterval
    }

    typealias Progress = @Sendable (_ text: String, _ transient: Bool) -> Void

    private let source: BackupExportSource
    private let workRoot: URL
    private let fm = FileManager.default

    init(source: BackupExportSource, workRoot: URL) {
        self.source = source
        self.workRoot = workRoot
    }

    /// Serialised process-wide with restores (`BackupActivityLock`).
    func export(options: Options, progress: Progress? = nil) async throws -> Summary {
        try await BackupActivityLock.shared.withLock(.export) {
            try await self.exportBody(options: options, progress: progress ?? { _, _ in })
        }
    }

    // MARK: - Body

    private struct RunState {
        var notDownloaded = 0
        var mcpRedacted = 0
        var credentialsIncluded = false
    }

    private func exportBody(options: Options, progress say: @escaping Progress) async throws -> Summary {
        let started = Date()
        let backupId = UUID().uuidString
        let selected = BackupCategory.backupable.filter(options.categories.contains)
        guard !selected.isEmpty else { throw BackupError.stagingFailed(String(localized: "未选择任何类别")) }

        try fm.createDirectory(at: workRoot, withIntermediateDirectories: true)
        BackupExportJournal.begin(.init(backupId: backupId, startedAt: started,
                                        categories: selected.map(\.rawValue),
                                        encrypted: options.isEncrypted), in: workRoot)
        let staging = workRoot.appendingPathComponent("minisbak-\(backupId)", isDirectory: true)
        let dataDir = staging.appendingPathComponent("data", isDirectory: true)
        let blobWork = workRoot.appendingPathComponent("minisbak-\(backupId)-blobs", isDirectory: true)
        try fm.createDirectory(at: dataDir, withIntermediateDirectories: true)

        let deviceName = await source.deviceName()
        let finalName = Self.packageFileName(backupId: backupId, at: options.snapshotAt,
                                             deviceName: deviceName, encrypted: options.isEncrypted)
        let finalURL = workRoot.appendingPathComponent(finalName)
        let partialURL = workRoot.appendingPathComponent(finalName + ".partial")

        let writer = try BackupZipWriter(url: partialURL)
        var completed = false
        defer {
            try? fm.removeItem(at: staging)
            try? fm.removeItem(at: blobWork)
            if !completed {
                writer.abort()
                try? fm.removeItem(at: partialURL)
            }
            BackupExportJournal.finish(in: workRoot)
        }

        say(String(localized: "开始备份：\(selected.count) 个类别"), false)

        var keys: BackupCrypto.Keys?
        var encryption: BackupManifest.Encryption?
        if let passphrase = options.passphrase, !passphrase.isEmpty {
            say(String(localized: "正在生成加密密钥…"), false)
            let kdf = BackupCrypto.currentKDF(salt: BackupCrypto.makeSalt())
            let derived = try BackupCrypto.deriveKeys(passphrase: passphrase, kdf: kdf)
            keys = derived
            encryption = .init(scheme: BackupCrypto.scheme, kdf: kdf, verifier: derived.verifier)
        }

        let blobStore = BackupBlobStore(workDir: blobWork, maxFileBytes: options.maxFileBytes,
                                        sink: writer, encryptionKey: keys?.dataKey)
        let fileIndex = BackupFileIndexWriter(url: staging.appendingPathComponent("files.index.jsonl"))
        var trees = BackupFileTreeExporter(blobStore: blobStore, fileIndex: fileIndex, snapshotAt: options.snapshotAt)
        var stats: [String: BackupManifest.CategoryStat] = [:]
        var state = RunState()
        let encrypted = keys != nil

        for category in selected {
            try Task.checkCancellation()
            let stat: BackupManifest.CategoryStat?
            switch category {
            case .chats:
                stat = try await exportChats(dataDir: dataDir, trees: trees, snapshotAt: options.snapshotAt,
                                             state: &state, say: say)
            case .sharedFiles:
                say(String(localized: "正在导出共享文件…"), false)
                let r = try trees.export(root: source.sharedFilesRoot(), logicalPrefix: "shared",
                                         category: .sharedFiles)
                state.notDownloaded += r.filesNotDownloaded
                stat = .init(entries: r.filesIncluded, bytes: r.bytesIncluded, encrypted: encrypted)
            case .skills:
                say(String(localized: "正在导出技能…"), false)
                let src = source
                trees.isExcludedDirectory = { src.isSkillExcludedDirectory($0) }
                stat = try await exportSkills(dataDir: dataDir, trees: trees, state: &state)
                trees.isExcludedDirectory = { _ in false }
            case .memory:
                say(String(localized: "正在导出记忆…"), false)
                stat = try exportMemory(dataDir: dataDir)
            case .providers:
                say(String(localized: "正在导出服务商…"), false)
                stat = try await exportProviders(dataDir: dataDir)
            case .mcpServers:
                say(String(localized: "正在导出 MCP 服务器…"), false)
                stat = try exportMCPServers(dataDir: dataDir, encrypted: encrypted, state: &state)
            case .environmentVariables:
                say(String(localized: "正在导出环境变量…"), false)
                stat = try await exportEnvironmentVariables(dataDir: dataDir)
            case .voiceCorrections:
                stat = nil
            }
            if var stat {
                stat.encrypted = encrypted
                stats[category.rawValue] = stat
            }
        }

        // Credentials: only into an encrypted package.
        if encrypted, selected.contains(.providers) || selected.contains(.environmentVariables) {
            try Task.checkCancellation()
            let instanceIds: [String]? = selected.contains(.providers)
                ? Self.instanceIds(inProviderConfigAt: dataDir.appendingPathComponent("provider_config.json"))
                : nil
            var envKeys: [String]?
            if selected.contains(.environmentVariables) { envKeys = await source.envVarEntries().map(\.key) }
            let secrets = await source.collectSecrets(providerInstanceIds: instanceIds, envVarKeys: envKeys)
            if !secrets.providers.isEmpty || !secrets.envVars.isEmpty {
                try BackupJSONFile.write(secrets, to: staging.appendingPathComponent("secrets.json"))
                state.credentialsIncluded = true
            }
        }
        if stats[BackupCategory.providers.rawValue] != nil {
            stats[BackupCategory.providers.rawValue]?.includesCredentials = state.credentialsIncluded
        }

        // Indexes.
        fileIndex.close()
        let blobIndexURL = staging.appendingPathComponent("blobs.index.jsonl")
        var blobLines = Data()
        let lineEncoder = BackupDates.encoder()
        for e in blobStore.blobIndex {
            blobLines.append(try lineEncoder.encode(e))
            blobLines.append(0x0A)
        }
        try blobLines.write(to: blobIndexURL, options: .atomic)

        // Seal (if encrypted) and hash every staged member.
        try Task.checkCancellation()
        say(encrypted ? String(localized: "正在加密并封装…") : String(localized: "正在封装…"), false)
        var integrity = blobStore.integrity
        var members: [(url: URL, name: String)] = []
        for (url, rel) in stagedMembers(in: staging) {
            if let keys {
                let shipped = rel + ".enc"
                let sealedURL = url.appendingPathExtension("enc")
                try BackupCrypto.encryptFile(at: url, to: sealedURL,
                                             key: rel == "secrets.json" ? keys.secretsKey : keys.dataKey,
                                             path: shipped)
                try fm.removeItem(at: url)
                integrity[shipped] = try BackupBlobStore.sha256OfFile(at: sealedURL)
                members.append((sealedURL, shipped))
            } else {
                integrity[rel] = try BackupBlobStore.sha256OfFile(at: url)
                members.append((url, rel))
            }
        }

        let app = source.appInfo()
        var manifest = BackupManifest(
            createdAt: Date(), app: app, deviceName: deviceName, backupId: backupId,
            categories: stats,
            limits: .init(maxFileBytes: blobStore.maxFileBytesForManifest,
                          skippedFiles: blobStore.skippedFiles, skippedBytes: blobStore.skippedBytes),
            encryption: encryption, integrity: integrity, manifestMac: nil,
            snapshotAt: options.snapshotAt)
        if let keys { manifest.manifestMac = try BackupCrypto.manifestMAC(manifest, key: keys.macKey) }
        let manifestData = try BackupDates.encoder(pretty: true).encode(manifest)

        for m in members.sorted(by: { $0.name < $1.name }) {
            try Task.checkCancellation()
            try writer.addFile(at: m.url, name: m.name)
        }
        try writer.addData(manifestData, name: "manifest.json")
        if let keys {
            try writer.addData(Data(BackupCrypto.manifestMAC(rawBytes: manifestData, key: keys.macKey).utf8),
                               name: "manifest.mac")
        }
        try writer.close()

        // Self-check before the package is allowed to exist under its real name.
        _ = try BackupPackageReader.peek(at: partialURL)
        try? fm.removeItem(at: finalURL)
        try fm.moveItem(at: partialURL, to: finalURL)
        completed = true

        let total = (try? fm.attributesOfItem(atPath: finalURL.path)[.size] as? Int64) ?? 0
        let elapsed = Date().timeIntervalSince(started)
        let sizeText = ByteCountFormatter.string(fromByteCount: total, countStyle: .file)
        say(String(localized: "备份完成：\(sizeText)，用时 \(BackupProgressReporter.durationText(elapsed))"), false)
        logger.info("[Backup] export done categories=\(selected.count) bytes=\(total) skipped=\(blobStore.skippedFiles) encrypted=\(encrypted)")

        return Summary(packageURL: finalURL, backupId: backupId, totalBytes: total, categories: stats,
                       encrypted: encrypted, credentialsIncluded: state.credentialsIncluded,
                       skippedFiles: blobStore.skippedFiles, skippedBytes: blobStore.skippedBytes,
                       skippedPaths: blobStore.skippedPaths.map { .init(path: $0.path, size: $0.size) },
                       notDownloadedFiles: state.notDownloaded, mcpServersRedacted: state.mcpRedacted,
                       duration: elapsed)
    }

    private func stagedMembers(in staging: URL) -> [(URL, String)] {
        guard let e = fm.enumerator(at: staging, includingPropertiesForKeys: [.isRegularFileKey]) else { return [] }
        var out: [(URL, String)] = []
        for case let url as URL in e {
            guard (try? url.resourceValues(forKeys: [.isRegularFileKey]))?.isRegularFile == true,
                  let rel = BackupPaths.relativePath(of: url, under: staging) else { continue }
            out.append((url, rel))
        }
        return out.sorted { $0.1 < $1.1 }
    }

    // MARK: - Chats

    private func exportChats(dataDir: URL, trees: BackupFileTreeExporter, snapshotAt: Date,
                             state: inout RunState, say: @escaping Progress) async throws -> BackupManifest.CategoryStat {
        let ids = await source.chatSessionIds()
        var reporter = BackupProgressReporter(noun: String(localized: "个对话"), total: ids.count,
                                              emit: { say($0, $1) })
        reporter.begin(String(localized: "正在导出对话…"))
        let sessions = BackupJSONLWriter(directory: dataDir, baseName: "sessions")
        let messages = BackupJSONLWriter(directory: dataDir, baseName: "messages")
        let markers = BackupJSONLWriter(directory: dataDir, baseName: "compact_markers")
        defer { try? sessions.close(); try? messages.close(); try? markers.close() }

        let root = source.chatsRoot()
        var sessionCount = 0, messageCount = 0, fileCount = 0
        var fileBytes: Int64 = 0
        for sid in ids {
            try Task.checkCancellation()
            BackupMemoryGovernor.shared.throttleIfNeeded()
            reporter.step()
            guard BackupPaths.isSafeComponent(sid), var rec = await source.chatSession(sid),
                  rec.session.createdAt <= snapshotAt else { continue }
            // A session touched during the export stays in, clamped to the
            // cut-off, rather than vanishing from the backup.
            rec.session.updatedAt = min(rec.session.updatedAt, snapshotAt)
            try sessions.write(BackupRecordEnvelope(t: "SessionV2", d: rec))
            sessionCount += 1

            let msgs = await source.chatMessages(sid)
            try autoreleasepool {
                for var m in msgs where m.createdAt <= snapshotAt {
                    if let u = m.updatedAt { m.updatedAt = min(u, snapshotAt) }
                    try messages.write(BackupRecordEnvelope(t: "MessageV2", d: m))
                    messageCount += 1
                }
            }
            for marker in await source.chatCompactMarkers(sid) where marker.createdAt <= snapshotAt {
                try markers.write(BackupRecordEnvelope(t: "CompactMarkerV2", d: marker))
            }
            let r = try trees.export(root: root.appendingPathComponent(sid, isDirectory: true),
                                     logicalPrefix: "chats/\(sid)", category: .chats, sessionId: sid)
            fileCount += r.filesIncluded
            fileBytes += r.bytesIncluded
            state.notDownloaded += r.filesNotDownloaded
        }
        try sessions.close(); try messages.close(); try markers.close()
        reporter.finish(String(localized: "对话已导出"),
                        detail: String(localized: "\(sessionCount) 个对话、\(messageCount) 条消息、\(fileCount) 个文件"))
        return .init(entries: messageCount + fileCount,
                     bytes: sessions.totalBytes + messages.totalBytes + markers.totalBytes + fileBytes,
                     encrypted: false, messages: messageCount, files: fileCount)
    }

    // MARK: - Skills

    private func exportSkills(dataDir: URL, trees: BackupFileTreeExporter,
                              state: inout RunState) async throws -> BackupManifest.CategoryStat {
        let rows = await source.skills().filter { BackupPaths.isSafeComponent($0.id) }
        let writer = BackupJSONLWriter(directory: dataDir, baseName: "skills")
        defer { try? writer.close() }
        for row in rows { try writer.write(BackupRecordEnvelope(t: "SkillV2", d: row)) }
        try writer.close()
        var bytes: Int64 = 0
        var files = 0
        let root = source.skillsRoot()
        for row in rows {
            try Task.checkCancellation()
            let r = try trees.export(root: root.appendingPathComponent(row.id, isDirectory: true),
                                     logicalPrefix: "skills/\(row.id)", category: .skills)
            bytes += r.bytesIncluded
            files += r.filesIncluded
            state.notDownloaded += r.filesNotDownloaded
        }
        return .init(entries: rows.count, bytes: writer.totalBytes + bytes, encrypted: false, files: files)
    }

    // MARK: - Memory

    /// GLOBAL.md / SOUL.md / daily files, verbatim, plus their mtimes so a
    /// restore can keep a locally newer file.
    private func exportMemory(dataDir: URL) throws -> BackupManifest.CategoryStat {
        let src = source.memoryRoot()
        let dst = dataDir.appendingPathComponent("memory", isDirectory: true)
        try fm.createDirectory(at: dst, withIntermediateDirectories: true)
        let meta = BackupJSONLWriter(directory: dataDir, baseName: "memory.meta")
        defer { try? meta.close() }
        var count = 0
        var bytes: Int64 = 0
        for name in ((try? fm.contentsOfDirectory(atPath: src.path)) ?? []).sorted()
        where name.lowercased().hasSuffix(".md") && BackupPaths.isSafeComponent(name) && !name.hasPrefix(".") {
            let from = src.appendingPathComponent(name)
            let values = try? from.resourceValues(forKeys: [.isRegularFileKey, .contentModificationDateKey, .fileSizeKey])
            guard values?.isRegularFile == true else { continue }
            try fm.copyItem(at: from, to: dst.appendingPathComponent(name))
            try meta.write(BackupRecordEnvelope(t: "MemoryMetaV1", d: BackupMemoryMetaRecord(
                name: name, mtime: values?.contentModificationDate?.timeIntervalSince1970 ?? 0)))
            count += 1
            bytes += Int64(values?.fileSize ?? 0)
        }
        try meta.close()
        return .init(entries: count, bytes: bytes, encrypted: false)
    }

    // MARK: - Providers

    private func exportProviders(dataDir: URL) async throws -> BackupManifest.CategoryStat? {
        guard let data = await source.providerConfigJSON() else { return nil }
        let url = dataDir.appendingPathComponent("provider_config.json")
        try data.write(to: url, options: .atomic)
        var bytes = Int64(data.count)
        let rules = await source.thinkingRules()
        if !rules.isEmpty {
            let w = BackupJSONLWriter(directory: dataDir, baseName: "leo_thinking_rules")
            for r in rules { try w.write(BackupRecordEnvelope(t: "LeoThinkingRuleV1", d: r)) }
            try w.close()
            bytes += w.totalBytes
        }
        let instances = Self.instanceIds(inProviderConfigAt: url)?.count ?? 0
        return .init(entries: instances, bytes: bytes, encrypted: false,
                     thinkingRules: rules.isEmpty ? nil : rules.count, includesCredentials: false)
    }

    static func instanceIds(inProviderConfigAt url: URL) -> [String]? {
        guard let data = try? Data(contentsOf: url),
              let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let instances = root["instances"] as? [[String: Any]] else { return nil }
        return instances.compactMap { $0["id"] as? String }
    }

    // MARK: - MCP

    private func exportMCPServers(dataDir: URL, encrypted: Bool,
                                  state: inout RunState) throws -> BackupManifest.CategoryStat? {
        let src = source.mcpServersFile()
        guard let data = try? Data(contentsOf: src),
              let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        var out = root
        if !encrypted {
            let r = BackupMerge.redactMCPServers(root)
            out = r.redacted
            state.mcpRedacted = r.count
        }
        let dst = dataDir.appendingPathComponent("mcp_servers.json")
        let written = try JSONSerialization.data(withJSONObject: out, options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes])
        try written.write(to: dst, options: .atomic)
        return .init(entries: Self.mcpServerCount(at: dst) ?? 0, bytes: Int64(written.count), encrypted: false)
    }

    /// Number of servers declared in a `servers.json`, nil if unreadable.
    static func mcpServerCount(at url: URL) -> Int? {
        guard let data = try? Data(contentsOf: url),
              let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let servers = root["mcpServers"] as? [String: Any] else { return nil }
        return servers.count
    }

    // MARK: - Environment variables

    /// Metadata only (id, key, createdAt, note). Values travel in the
    /// encrypted `secrets.json` or not at all.
    private func exportEnvironmentVariables(dataDir: URL) async throws -> BackupManifest.CategoryStat? {
        let entries = await source.envVarEntries()
        guard !entries.isEmpty else { return nil }
        let url = dataDir.appendingPathComponent("env_vars.json")
        try BackupJSONFile.write(entries, to: url)
        let bytes = (try? fm.attributesOfItem(atPath: url.path)[.size] as? Int64) ?? 0
        return .init(entries: entries.count, bytes: bytes, encrypted: false)
    }

    // MARK: - Naming

    /// `<device>-<yyyyMMdd>-<sortable-id>[-encrypted].minisbak` (upstream
    /// shape): device first so a shared folder groups by device, an id whose
    /// lexical order is chronological, and the encryption visible in the name.
    static func packageFileName(backupId: String, at date: Date, deviceName: String,
                                encrypted: Bool = false) -> String {
        let f = DateFormatter()
        f.dateFormat = "yyyyMMdd"
        f.locale = Locale(identifier: "en_US_POSIX")
        let suffix = encrypted ? "-encrypted" : ""
        return "\(filenameDeviceToken(deviceName))-\(f.string(from: date))-\(sortableID(backupId: backupId, at: date))\(suffix).\(BackupFormat.fileExtension)"
    }

    static func sortableID(backupId: String, at date: Date) -> String {
        let alphabet = Array("0123456789abcdefghjkmnpqrstvwxyz")
        func encode(_ value: UInt64, width: Int) -> String {
            var v = value
            var out = [Character]()
            for _ in 0..<width { out.append(alphabet[Int(v & 31)]); v >>= 5 }
            return String(out.reversed())
        }
        let ms = UInt64(max(0, date.timeIntervalSince1970 * 1000))
        var h: UInt64 = 0xcbf2_9ce4_8422_2325
        for b in backupId.utf8 { h = (h ^ UInt64(b)) &* 0x1000_0000_01b3 }
        return encode(ms & 0xFF_FFFF_FFFF, width: 8) + encode(h, width: 3)
    }

    /// Filename-safe ASCII token; non-ASCII names fall back to `fallback`.
    static func filenameDeviceToken(_ raw: String, fallback: String = "LeoBot") -> String {
        var out = ""
        var lastWasSeparator = false
        for ch in raw {
            if ch.isASCII && (ch.isLetter || ch.isNumber) {
                out.append(ch); lastWasSeparator = false
            } else if ch == "'" || ch == "\u{2019}" {
                continue
            } else if !out.isEmpty && !lastWasSeparator {
                out.append("-"); lastWasSeparator = true
            }
        }
        while out.hasSuffix("-") { out.removeLast() }
        if out.count > 24 {
            out = String(out.prefix(24))
            while out.hasSuffix("-") { out.removeLast() }
        }
        return out.isEmpty ? fallback : out
    }
}
