import Foundation

private let logger = AppLogger(category: "Backup")

/// Restores a `.minisbak` package with MERGE semantics.
///
/// Three steps, so the user sees what will happen before anything changes:
///   1. `open` — structural validation (traversal / bomb guards), passphrase
///      verifier + manifest MAC (BEFORE unpacking), bounded extraction,
///      SHA-256 integrity of every member, decryption. Members the manifest
///      does not vouch for are discarded.
///   2. `analyze` — per-category counts and conflicts vs. local data, no writes.
///   3. `apply` — per category, in a transaction with rollback: chats through
///      one SQLite transaction plus a journaled file tree, other categories
///      through store APIs with compensating undo. A failed category is rolled
///      back; categories already completed are kept. Refused while an agent
///      turn is running in a session the package would touch.
actor BackupImporter {

    struct Prepared: Sendable {
        let packageName: String
        let workDir: URL
        let root: URL
        let manifest: BackupManifest
        let wasEncrypted: Bool
        let hasSecrets: Bool
        let ignoredPlaintextSecrets: Bool
        let ignoredMembers: Int
        let integrityChecked: Int
        let fileIndex: [BackupFileIndexEntry]
        var dataDir: URL { root.appendingPathComponent("data", isDirectory: true) }
    }

    struct CategoryPlan: Sendable, Identifiable {
        var id: String { category.rawValue }
        var category: BackupCategory
        /// Items in the package for this category.
        var total = 0
        /// Not present locally — will be added.
        var newItems = 0
        /// Present locally, package copy newer — will be updated.
        var newerInBackup = 0
        /// Present locally and local is newer / differs with unknown age — kept.
        var localKept = 0
        var identical = 0
        var notes: [String] = []
    }

    struct Plan: Sendable {
        var categories: [CategoryPlan]
        var runningSessions: Int
        var warnings: [String]
    }

    struct CategoryReport: Sendable, Identifiable {
        var id: String { category.rawValue }
        var category: BackupCategory
        var imported = 0
        var updated = 0
        var keptLocal = 0
        var identical = 0
        var unreadable = 0
        var filesWritten = 0
        var bytesWritten: Int64 = 0
        var missingBlobs = 0
        var rejectedPaths = 0
        var sizeSkippedInPackage = 0
        var notDownloadedInPackage = 0
        var credentialsRestored = 0
        var credentialsKept = 0
        var needsAttention: [String] = []
        var failed: String?
        var rolledBack = false
        var skippedNotRun = false

        var summary: String {
            if skippedNotRun { return String(localized: "未执行") }
            if let failed { return String(localized: "失败并已撤销：\(failed)") }
            var parts: [String] = []
            if imported > 0 { parts.append(String(localized: "新增 \(imported)")) }
            if updated > 0 { parts.append(String(localized: "更新 \(updated)")) }
            if keptLocal > 0 { parts.append(String(localized: "保留本地 \(keptLocal)")) }
            if identical > 0 { parts.append(String(localized: "相同 \(identical)")) }
            if filesWritten > 0 { parts.append(String(localized: "文件 \(filesWritten)")) }
            if credentialsRestored > 0 { parts.append(String(localized: "密钥 \(credentialsRestored)")) }
            if missingBlobs > 0 { parts.append(String(localized: "缺失 \(missingBlobs)")) }
            if unreadable > 0 { parts.append(String(localized: "无法读取 \(unreadable)")) }
            return parts.isEmpty ? String(localized: "无变化") : parts.joined(separator: "，")
        }
    }

    struct Report: Sendable {
        var backupId: String
        var createdAt: Date
        var deviceName: String
        var categories: [CategoryReport] = []
        var wasEncrypted = false
        var warnings: [String] = []
        var cancelled = false
        var duration: TimeInterval = 0

        var hasFailures: Bool { categories.contains { $0.failed != nil } }
        var hasIssues: Bool {
            hasFailures || cancelled || categories.contains {
                $0.missingBlobs > 0 || $0.unreadable > 0 || !$0.needsAttention.isEmpty || $0.rejectedPaths > 0
            }
        }
    }

    enum ImportError: LocalizedError, Equatable {
        case passphraseRequired
        case integrityFailed(Int)
        case sessionsRunning(Int)
        case insufficientSpace(needed: Int64, available: Int64)
        case encryptedMembersWithoutManifest
        case manifestMismatch
        case nothingSelected
        case providerStoreUnavailable

        var errorDescription: String? {
            switch self {
            case .passphraseRequired: return String(localized: "这个备份已加密，请输入备份密码")
            case .integrityFailed(let n): return String(localized: "完整性校验失败（\(n) 个文件），备份包可能已损坏，未做任何修改")
            case .sessionsRunning(let n): return String(localized: "有 \(n) 个相关对话正在运行，请等它们结束后再恢复")
            case .insufficientSpace(let need, let have):
                let n = ByteCountFormatter.string(fromByteCount: need, countStyle: .file)
                let h = ByteCountFormatter.string(fromByteCount: have, countStyle: .file)
                return String(localized: "空间不足：需要约 \(n)，当前可用 \(h)")
            case .encryptedMembersWithoutManifest: return String(localized: "备份包含加密内容但清单未声明加密，可能被篡改，已拒绝")
            case .manifestMismatch: return String(localized: "备份清单前后不一致，已拒绝")
            case .nothingSelected: return String(localized: "未选择要恢复的类别")
            case .providerStoreUnavailable: return String(localized: "服务商配置尚未加载完成，请稍后再试")
            }
        }
    }

    typealias Progress = @Sendable (_ text: String, _ transient: Bool) -> Void

    let target: BackupRestoreTarget
    let workRoot: URL
    let journalBase: URL
    let fm = FileManager.default

    init(target: BackupRestoreTarget, workRoot: URL, journalBase: URL) {
        self.target = target
        self.workRoot = workRoot
        self.journalBase = journalBase
    }

    static func isFormatSupported(_ format: String) -> Bool {
        BackupPackageReader.isFormatSupported(format)
    }

    // MARK: - 1. Open

    /// Unpack + verify (+ decrypt) under the process-wide backup lock: a
    /// second package opened while one is extracting is refused instead of
    /// running two multi-GB extractions side by side.
    func open(packageURL: URL, passphrase: String?) async throws -> Prepared {
        try await BackupActivityLock.shared.withLock(.restore) {
            try await self.openUnlocked(packageURL: packageURL, passphrase: passphrase)
        }
    }

    private func openUnlocked(packageURL: URL, passphrase: String?) async throws -> Prepared {
        let peek = try BackupPackageReader.peek(at: packageURL)
        let manifest = peek.manifest

        // Passphrase + manifest authentication BEFORE unpacking anything, so
        // a wrong password costs a second, not a multi-GB extraction.
        var keys: BackupCrypto.Keys?
        if let encryption = manifest.encryption {
            guard encryption.scheme == BackupCrypto.scheme else {
                throw BackupCrypto.CryptoError.unsupportedScheme(encryption.scheme)
            }
            guard let passphrase, !passphrase.isEmpty else { throw ImportError.passphraseRequired }
            let derived = try BackupCrypto.deriveKeys(passphrase: passphrase, kdf: encryption.kdf)
            guard BackupCrypto.verifierMatches(encryption.verifier, keys: derived) else {
                throw BackupCrypto.CryptoError.wrongPassphrase
            }
            if let sidecar = peek.manifestMacSidecar, !sidecar.isEmpty {
                try BackupCrypto.verifyManifestMAC(rawBytes: peek.rawManifest, expected: sidecar, key: derived.macKey)
            } else {
                try BackupCrypto.verifyManifestMAC(manifest, key: derived.macKey)
            }
            keys = derived
        }

        try fm.createDirectory(at: workRoot, withIntermediateDirectories: true)
        let workDir = workRoot.appendingPathComponent("restore-work-\(UUID().uuidString)", isDirectory: true)
        do {
            let unpacked = workDir.appendingPathComponent("unpacked", isDirectory: true)
            var limits = BackupZipExtractor.Limits.standard
            if let free = BackupPaths.freeSpace(at: workRoot) { limits.availableBytes = max(0, free - 200_000_000) }
            try BackupZipExtractor.extract(packageURL, to: unpacked, limits: limits)
            let root = packageRoot(unpacked)

            guard let extractedManifest = try? Data(contentsOf: root.appendingPathComponent("manifest.json")),
                  extractedManifest == peek.rawManifest else { throw ImportError.manifestMismatch }

            // Integrity: every vouched-for member must exist and match.
            var failed = 0
            var checked = 0
            for (rel, expected) in manifest.integrity {
                try Task.checkCancellation()
                guard BackupZipExtractor.isSafeEntryName(rel),
                      let url = BackupZipExtractor.safeDestination(for: rel, under: root),
                      fm.fileExists(atPath: url.path),
                      let actual = try? BackupBlobStore.sha256OfFile(at: url) else { failed += 1; continue }
                checked += 1
                if actual != expected.lowercased() { failed += 1 }
            }
            guard failed == 0 else { throw ImportError.integrityFailed(failed) }

            // Anything the manifest does not vouch for is discarded, so an
            // injected plaintext shard can never ride along unverified.
            let ignored = discardUnlisted(in: root, keep: Set(manifest.integrity.keys))

            var ignoredPlaintextSecrets = false
            if let keys {
                try decryptMembers(in: root, keys: keys)
            } else {
                if hasEncryptedMembers(in: root) { throw ImportError.encryptedMembersWithoutManifest }
                let plain = root.appendingPathComponent("secrets.json")
                if fm.fileExists(atPath: plain.path) {
                    // Policy: credentials are only accepted from an encrypted package.
                    try? fm.removeItem(at: plain)
                    ignoredPlaintextSecrets = true
                }
            }
            let fileIndex = BackupFileIndexWriter.read(root.appendingPathComponent("files.index.jsonl"))
            return Prepared(packageName: packageURL.lastPathComponent, workDir: workDir, root: root,
                            manifest: manifest, wasEncrypted: keys != nil,
                            hasSecrets: keys != nil && fm.fileExists(atPath: root.appendingPathComponent("secrets.json").path),
                            ignoredPlaintextSecrets: ignoredPlaintextSecrets, ignoredMembers: ignored,
                            integrityChecked: checked, fileIndex: fileIndex)
        } catch {
            try? fm.removeItem(at: workDir)
            throw error
        }
    }

    nonisolated func discard(_ prepared: Prepared) {
        try? FileManager.default.removeItem(at: prepared.workDir)
    }

    private func packageRoot(_ unpacked: URL) -> URL {
        if fm.fileExists(atPath: unpacked.appendingPathComponent("manifest.json").path) { return unpacked }
        let children = (try? fm.contentsOfDirectory(at: unpacked, includingPropertiesForKeys: [.isDirectoryKey])) ?? []
        if children.count == 1,
           fm.fileExists(atPath: children[0].appendingPathComponent("manifest.json").path) {
            return children[0]
        }
        return unpacked
    }

    private func regularFiles(in root: URL) -> [(URL, String)] {
        guard let e = fm.enumerator(at: root, includingPropertiesForKeys: [.isRegularFileKey]) else { return [] }
        var out: [(URL, String)] = []
        for case let url as URL in e {
            guard (try? url.resourceValues(forKeys: [.isRegularFileKey]))?.isRegularFile == true,
                  let rel = BackupPaths.relativePath(of: url, under: root) else { continue }
            out.append((url, rel))
        }
        return out
    }

    private func discardUnlisted(in root: URL, keep: Set<String>) -> Int {
        var removed = 0
        for (url, rel) in regularFiles(in: root)
        where !keep.contains(rel) && rel != "manifest.json" && rel != "manifest.mac" {
            try? fm.removeItem(at: url)
            removed += 1
        }
        if removed > 0 { logger.warning("[Restore] discarded \(removed) member(s) not covered by the manifest") }
        return removed
    }

    private func hasEncryptedMembers(in root: URL) -> Bool {
        regularFiles(in: root).contains { $0.1.hasSuffix(".enc") }
    }

    /// Decrypt every `.enc` member in place. The AAD is the shipped name, so
    /// a member renamed to impersonate another fails to open.
    private func decryptMembers(in root: URL, keys: BackupCrypto.Keys) throws {
        for (url, rel) in regularFiles(in: root) where rel.hasSuffix(".enc") {
            try Task.checkCancellation()
            let plain = url.deletingPathExtension()
            let isSecrets = String(rel.dropLast(4)) == "secrets.json"
            try BackupCrypto.decryptFile(at: url, to: plain, key: isSecrets ? keys.secretsKey : keys.dataKey, path: rel)
            try fm.removeItem(at: url)
        }
    }

    // MARK: - 2. Analyze

    func analyze(_ p: Prepared) async -> Plan {
        var plans: [CategoryPlan] = []
        var warnings: [String] = []
        var running = 0
        let selectable = p.manifest.knownCategories.filter { $0 != .voiceCorrections }

        for category in selectable {
            var plan = CategoryPlan(category: category)
            switch category {
            case .chats:
                let sessions = readSessions(p)
                let stamps = await target.localSessionStamps(sessions.map(\.session.id))
                plan.total = sessions.count
                for s in sessions {
                    switch BackupMerge.decide(local: stamps[s.session.id], incoming: s.session.updatedAt) {
                    case .insert: plan.newItems += 1
                    case .update: plan.newerInBackup += 1
                    case .keepLocal: plan.localKept += 1
                    }
                }
                running = await target.runningSessionIds(sessions.map(\.session.id)).count
                if running > 0 { plan.notes.append(String(localized: "\(running) 个相关对话正在运行，需要先停止")) }
            case .sharedFiles:
                analyzeFiles(p, category: category, root: target.sharedFilesRoot(),
                             map: { Self.sharedComponents($0) }, into: &plan)
            case .skills:
                let records = BackupJSONLReader.readAll(in: p.dataDir, base: "skills", as: BackupSkillRecord.self)
                let stamps = await target.localSkillStamps()
                plan.total = records.count
                for r in records {
                    switch BackupMerge.decide(local: stamps[r.id], incoming: r.updatedAt) {
                    case .insert: plan.newItems += 1
                    case .update: plan.newerInBackup += 1
                    case .keepLocal: plan.localKept += 1
                    }
                }
            case .memory:
                for item in memoryItems(p) {
                    plan.total += 1
                    switch memoryDecision(item) {
                    case .write: plan.newItems += 1
                    case .replace: plan.newerInBackup += 1
                    case .identical: plan.identical += 1
                    case .keepLocal: plan.localKept += 1
                    }
                }
            case .providers:
                if let dicts = await providerDictionaries(p) {
                    let (local, backup) = dicts
                    let r = BackupMerge.mergeProviderConfig(local: local, backup: backup,
                                                            backupSnapshotAt: p.manifest.snapshotAt ?? p.manifest.createdAt)
                    plan.total = ((backup["instances"] as? [Any]) ?? []).count
                    plan.newItems = r.stats.instancesAdded
                    plan.localKept = r.stats.instancesKept
                    if r.stats.groupsAdded > 0 { plan.notes.append(String(localized: "新增 \(r.stats.groupsAdded) 个模型分组")) }
                    if r.stats.groupsRenamed > 0 { plan.notes.append(String(localized: "\(r.stats.groupsRenamed) 个同名分组将加“（备份）”后缀")) }
                }
                if !p.hasSecrets {
                    plan.notes.append(String(localized: "此备份不含 API 密钥，恢复后需要重新填写"))
                }
            case .environmentVariables:
                let records = readEnvVars(p)
                let add = BackupMerge.envVarsToAdd(localKeys: await target.envVarKeys(), backup: records)
                plan.total = records.count
                plan.newItems = add.count
                plan.localKept = records.count - add.count
                if !p.hasSecrets, !add.isEmpty {
                    plan.notes.append(String(localized: "变量值未包含在备份中，恢复后为空值"))
                }
            case .mcpServers:
                if let backup = jsonObject(p.dataDir.appendingPathComponent("mcp_servers.json")) {
                    let local = (await target.mcpServersJSON()).flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] } ?? [:]
                    let m = BackupMerge.mergeMCPServers(local: local, backup: backup)
                    plan.total = ((backup["mcpServers"] as? [String: Any]) ?? [:]).count
                    plan.newItems = m.plan.added.count
                    plan.newerInBackup = m.plan.replaced.count
                    plan.localKept = m.plan.kept.count
                    if !m.plan.needsSecrets.isEmpty {
                        plan.notes.append(String(localized: "\(m.plan.needsSecrets.count) 个服务器的密钥已在备份时移除，需重新填写"))
                    }
                }
            case .voiceCorrections:
                continue
            }
            plans.append(plan)
        }
        if p.ignoredPlaintextSecrets {
            warnings.append(String(localized: "备份包含未加密的密钥文件，出于安全考虑已忽略"))
        }
        if p.manifest.limits.skippedFiles > 0 {
            warnings.append(String(localized: "备份时有 \(p.manifest.limits.skippedFiles) 个文件因超出大小上限未被包含"))
        }
        if p.manifest.categories[BackupCategory.voiceCorrections.rawValue] != nil {
            warnings.append(String(localized: "语音纠错数据不在恢复范围内，已忽略"))
        }
        if fm.fileExists(atPath: p.dataDir.appendingPathComponent("sub_agents.jsonl").path)
            || fm.fileExists(atPath: p.dataDir.appendingPathComponent("thinking_rules.jsonl").path) {
            warnings.append(String(localized: "包内的子智能体 / 上游思考规则暂不支持恢复，已忽略"))
        }
        return Plan(categories: plans, runningSessions: running, warnings: warnings)
    }

    // MARK: - 3. Apply

    func apply(_ p: Prepared, categories requested: Set<BackupCategory>,
               progress: Progress? = nil) async throws -> Report {
        try await BackupActivityLock.shared.withLock(.restore) {
            try await self.applyBody(p, requested: requested, say: progress ?? { _, _ in })
        }
    }

    private func applyBody(_ p: Prepared, requested: Set<BackupCategory>, say: Progress) async throws -> Report {
        let started = Date()
        let selected = p.manifest.knownCategories.filter { requested.contains($0) && $0 != .voiceCorrections }
        guard !selected.isEmpty else { throw ImportError.nothingSelected }

        // Refuse up front while an agent is writing into any affected session.
        var sessions: [BackupSessionRecord] = []
        if selected.contains(.chats) {
            sessions = readSessions(p)
            let running = await target.runningSessionIds(sessions.map(\.session.id))
            guard running.isEmpty else { throw ImportError.sessionsRunning(running.count) }
        }

        // Disk space for the file categories being written.
        let fileBytes = p.fileIndex
            .filter { e in e.skipped == nil && selected.contains(where: { $0.rawValue == e.category }) }
            .reduce(Int64(0)) { $0 + $1.size }
        if fileBytes > 0, let free = BackupPaths.freeSpace(at: target.chatsRoot().deletingLastPathComponent()),
           Double(fileBytes) * 1.1 > Double(free) {
            throw ImportError.insufficientSpace(needed: Int64(Double(fileBytes) * 1.1), available: free)
        }

        let journal = try BackupRestoreJournal.begin(
            base: journalBase,
            header: .init(backupId: p.manifest.backupId, startedAt: started, categories: selected.map(\.rawValue)))
        defer { journal.finish() }
        let roots: [BackupRestoreJournal.Root: URL] = [
            .chats: target.chatsRoot(), .shared: target.sharedFilesRoot(), .memory: target.memoryRoot(),
        ]

        var report = Report(backupId: p.manifest.backupId, createdAt: p.manifest.createdAt,
                            deviceName: p.manifest.deviceName, wasEncrypted: p.wasEncrypted)
        say(String(localized: "开始恢复：\(selected.count) 个类别"), false)

        for (index, category) in selected.enumerated() {
            if Task.isCancelled {
                report.cancelled = true
                for rest in selected[index...] {
                    var r = CategoryReport(category: rest); r.skippedNotRun = true
                    report.categories.append(r)
                }
                break
            }
            say(String(localized: "正在恢复\(category.displayName)…"), false)
            var undo = UndoLog()
            do {
                try journal.beginCategory(category)
                var r = try await applyCategory(category, p, sessions: sessions, journal: journal, undo: &undo, say: say)
                r.sizeSkippedInPackage = p.fileIndex.filter { $0.category == category.rawValue && $0.skipped == "size" }.count
                r.notDownloadedInPackage = p.fileIndex.filter { $0.category == category.rawValue && $0.skipped == "not_downloaded" }.count
                try journal.endCategory(category)
                report.categories.append(r)
                say(String(localized: "\(category.displayName)：\(r.summary)"), false)
            } catch {
                let cancelled = error is CancellationError
                logger.error("[Restore] category \(category.rawValue) failed; rolling back")
                await undo.run()
                journal.rollback(category, roots: roots)
                try? journal.endCategory(category)
                var r = CategoryReport(category: category)
                r.failed = cancelled ? String(localized: "已取消") : error.localizedDescription
                r.rolledBack = true
                report.categories.append(r)
                say(String(localized: "\(category.displayName)恢复失败，已撤销该类别的改动"), false)
                if cancelled {
                    report.cancelled = true
                    for rest in selected.dropFirst(index + 1) {
                        var s = CategoryReport(category: rest); s.skippedNotRun = true
                        report.categories.append(s)
                    }
                    break
                }
            }
        }
        if p.ignoredPlaintextSecrets {
            report.warnings.append(String(localized: "备份包含未加密的密钥文件，出于安全考虑已忽略"))
        }
        report.duration = Date().timeIntervalSince(started)
        logger.info("[Restore] done categories=\(report.categories.count) failed=\(report.categories.filter { $0.failed != nil }.count)")
        return report
    }

    /// Compensating actions for the non-file part of a category.
    struct UndoLog {
        private var actions: [@Sendable () async -> Void] = []
        mutating func add(_ action: @escaping @Sendable () async -> Void) { actions.append(action) }
        func run() async { for a in actions.reversed() { await a() } }
    }

    // MARK: - Shared readers

    func readSessions(_ p: Prepared) -> [BackupSessionRecord] {
        var seen = Set<String>()
        return BackupJSONLReader.readAll(in: p.dataDir, base: "sessions", as: BackupSessionRecord.self)
            .filter { BackupPaths.isSafeComponent($0.session.id) && seen.insert($0.session.id).inserted }
    }

    func readEnvVars(_ p: Prepared) -> [BackupEnvVarRecord] {
        guard let data = BackupJSONFile.read(p.dataDir.appendingPathComponent("env_vars.json")) else { return [] }
        return (try? BackupDates.decoder().decode([BackupEnvVarRecord].self, from: data)) ?? []
    }

    func jsonObject(_ url: URL) -> [String: Any]? {
        guard let data = BackupJSONFile.read(url) else { return nil }
        return try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    }

    func providerDictionaries(_ p: Prepared) async -> ([String: Any], [String: Any])? {
        guard let backup = jsonObject(p.dataDir.appendingPathComponent("provider_config.json")),
              let localData = await target.providerConfigJSON(),
              let local = try? JSONSerialization.jsonObject(with: localData) as? [String: Any] else { return nil }
        return (local, backup)
    }
}
