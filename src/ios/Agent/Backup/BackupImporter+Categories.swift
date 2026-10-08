import Foundation

private let logger = AppLogger(category: "Backup")

extension BackupImporter {

    // MARK: - Dispatch

    func applyCategory(_ category: BackupCategory, _ p: Prepared, sessions: [BackupSessionRecord],
                       journal: BackupRestoreJournal, undo: inout UndoLog,
                       say: Progress) async throws -> CategoryReport {
        switch category {
        case .chats: return try await applyChats(p, sessions: sessions, journal: journal)
        case .sharedFiles:
            var r = CategoryReport(category: .sharedFiles)
            let files = try restoreFileTree(p, category: .sharedFiles, rootKind: .shared,
                                            root: target.sharedFilesRoot(), journal: journal,
                                            map: { Self.sharedComponents($0) })
            files.apply(to: &r)
            if files.written > 0 { await target.didRestoreSharedFiles() }
            return r
        case .skills: return try await applySkills(p, undo: &undo)
        case .memory: return try await applyMemory(p, journal: journal)
        case .providers: return try await applyProviders(p, undo: &undo)
        case .environmentVariables: return try await applyEnvironmentVariables(p, undo: &undo)
        case .mcpServers: return try await applyMCPServers(p, undo: &undo)
        case .voiceCorrections: return CategoryReport(category: .voiceCorrections)
        }
    }

    // MARK: - Chats

    /// Files first (journaled, undoable), then the DB merge in ONE store
    /// transaction. If the DB step throws it has already rolled itself back
    /// and the caller undoes the files, so the category is all-or-nothing.
    private func applyChats(_ p: Prepared, sessions: [BackupSessionRecord],
                            journal: BackupRestoreJournal) async throws -> CategoryReport {
        var r = CategoryReport(category: .chats)
        let stamps = await target.localSessionStamps(sessions.map(\.session.id))
        // Session-level LWW decides whether its messages, markers and files
        // are merged at all: a locally newer conversation is left untouched.
        let applied = Set(sessions.filter {
            BackupMerge.decide(local: stamps[$0.session.id], incoming: $0.session.updatedAt) != .keepLocal
        }.map(\.session.id))

        let files = try restoreFileTree(p, category: .chats, rootKind: .chats, root: target.chatsRoot(),
                                        journal: journal, map: { path in
            guard let comps = Self.chatComponents(path), applied.contains(comps[0]) else { return nil }
            return comps
        })
        files.apply(to: &r)

        let db = try await target.applyChats(sessions: sessions.filter { applied.contains($0.session.id) },
                                             dataDir: p.dataDir)
        r.imported = db.sessionsInserted + db.messagesInserted + db.markersInserted
        r.updated = db.sessionsUpdated + db.messagesUpdated
        r.keptLocal = (sessions.count - applied.count) + db.sessionsKeptLocal + db.messagesKeptLocal + db.markersKept
        r.unreadable += db.unreadable
        let touched = Set(db.changedSessionIds).union(files.touchedFirstComponents)
        if !touched.isEmpty { await target.didRestoreChats(sessionIds: touched) }
        return r
    }

    static func chatComponents(_ path: String) -> [String]? {
        guard path.hasPrefix("chats/"), let comps = BackupPaths.safeComponents(String(path.dropFirst(6))),
              comps.count >= 2 else { return nil }
        return comps
    }

    static func sharedComponents(_ path: String) -> [String]? {
        guard path.hasPrefix("shared/") else { return nil }
        return BackupPaths.safeComponents(String(path.dropFirst(7)))
    }

    // MARK: - File trees

    struct FileTreeResult {
        var written = 0
        var replaced = 0
        var keptLocal = 0
        var identical = 0
        var bytes: Int64 = 0
        var missingBlobs = 0
        var rejected = 0
        var touchedFirstComponents = Set<String>()

        func apply(to r: inout CategoryReport) {
            r.filesWritten += written + replaced
            r.imported += written
            r.updated += replaced
            r.keptLocal += keptLocal
            r.identical += identical
            r.bytesWritten += bytes
            r.missingBlobs += missingBlobs
            r.rejectedPaths += rejected
        }
    }

    /// Write a category's files out of `blobs/` with per-file merge:
    /// absent → write; same bytes → skip; different → newer mtime wins, an
    /// unknown age keeps local. Every create / replace is journaled first.
    /// Paths come from the package (attacker-controlled): each one must map
    /// to safe components AND resolve inside its category root.
    func restoreFileTree(_ p: Prepared, category: BackupCategory, rootKind: BackupRestoreJournal.Root,
                         root: URL, journal: BackupRestoreJournal,
                         map: (String) -> [String]?) throws -> FileTreeResult {
        var result = FileTreeResult()
        try fm.createDirectory(at: root, withIntermediateDirectories: true)
        var n = 0
        for entry in p.fileIndex where entry.category == category.rawValue && entry.skipped == nil {
            n += 1
            if n % 64 == 0 { try Task.checkCancellation() }
            guard let comps = map(entry.path) else {
                if category != .chats || Self.chatComponents(entry.path) == nil { result.rejected += 1 }
                continue
            }
            let dest = comps.reduce(root) { $0.appendingPathComponent($1) }
            guard BackupPaths.isContained(dest, within: root) else {
                result.rejected += 1
                continue
            }
            let rel = comps.joined(separator: "/")
            if entry.isDirectory == true {
                try ensureDirectory(comps, root: root, category: category, rootKind: rootKind, journal: journal)
                continue
            }
            guard let sha = entry.sha256, sha.count == 64, sha.allSatisfy(\.isHexDigit) else { result.rejected += 1; continue }
            let blob = p.root.appendingPathComponent("blobs").appendingPathComponent(String(sha.prefix(2)))
                .appendingPathComponent(sha)
            guard fm.fileExists(atPath: blob.path) else {
                result.missingBlobs += 1
                continue
            }
            var isDir: ObjCBool = false
            let exists = fm.fileExists(atPath: dest.path, isDirectory: &isDir)
            if exists && isDir.boolValue { result.keptLocal += 1; continue }
            var localMtime: Date?
            var localSha: String?
            if exists {
                localMtime = (try? dest.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate
                localSha = try? BackupBlobStore.sha256OfFile(at: dest)
            }
            let decision = BackupMerge.decideFile(localExists: exists, localSha: localSha,
                                                  localMtime: localMtime,
                                                  packageSha: sha, packageMtime: entry.mtime)
            switch decision {
            case .identical: result.identical += 1; continue
            case .keepLocal: result.keptLocal += 1; continue
            case .write, .replace: break
            }
            try ensureDirectory(Array(comps.dropLast()), root: root, category: category,
                                rootKind: rootKind, journal: journal)
            let staged = dest.deletingLastPathComponent().appendingPathComponent(".restore-\(UUID().uuidString).tmp")
            try fm.copyItem(at: blob, to: staged)
            do {
                if decision == .replace {
                    try journal.willReplace(category, root: rootKind, path: rel, live: dest)
                    _ = try fm.replaceItemAt(dest, withItemAt: staged)
                    result.replaced += 1
                } else {
                    try journal.willCreate(category, root: rootKind, path: rel)
                    try fm.moveItem(at: staged, to: dest)
                    result.written += 1
                }
            } catch {
                try? fm.removeItem(at: staged)
                throw error
            }
            if let mtime = entry.mtime {
                try? fm.setAttributes([.modificationDate: Date(timeIntervalSince1970: mtime)], ofItemAtPath: dest.path)
            }
            result.bytes += entry.size
            result.touchedFirstComponents.insert(comps[0])
        }
        if result.rejected > 0 { logger.error("[Restore] rejected \(result.rejected) unsafe path(s) in \(category.rawValue)") }
        if result.missingBlobs > 0 { logger.error("[Restore] \(result.missingBlobs) file(s) referenced but missing in \(category.rawValue)") }
        return result
    }

    private func ensureDirectory(_ comps: [String], root: URL, category: BackupCategory,
                                 rootKind: BackupRestoreJournal.Root, journal: BackupRestoreJournal) throws {
        var url = root
        var rel: [String] = []
        for c in comps {
            url.appendPathComponent(c, isDirectory: true)
            rel.append(c)
            var isDir: ObjCBool = false
            if fm.fileExists(atPath: url.path, isDirectory: &isDir) {
                guard isDir.boolValue else { throw BackupZipExtractor.ExtractError.unsafePath(rel.joined(separator: "/")) }
                continue
            }
            guard BackupPaths.isContained(url, within: root) else {
                throw BackupZipExtractor.ExtractError.unsafePath(rel.joined(separator: "/"))
            }
            try journal.willCreateDirectory(category, root: rootKind, path: rel.joined(separator: "/"))
            try fm.createDirectory(at: url, withIntermediateDirectories: false)
        }
    }

    func analyzeFiles(_ p: Prepared, category: BackupCategory, root: URL,
                      map: (String) -> [String]?, into plan: inout CategoryPlan) {
        for entry in p.fileIndex where entry.category == category.rawValue
            && entry.skipped == nil && entry.isDirectory != true {
            plan.total += 1
            guard let comps = map(entry.path) else { continue }
            let dest = comps.reduce(root) { $0.appendingPathComponent($1) }
            if fm.fileExists(atPath: dest.path) {
                plan.localKept += 1      // decided per file (bytes, then mtime) at restore
            } else {
                plan.newItems += 1
            }
        }
        if plan.localKept > 0 {
            plan.notes.append(String(localized: "\(plan.localKept) 个文件本地已存在，内容不同时保留较新的一份"))
        }
    }

    // MARK: - Memory

    struct MemoryItem {
        var name: String
        var packageURL: URL
        var localURL: URL
        var packageMtime: Double?
    }

    func memoryItems(_ p: Prepared) -> [MemoryItem] {
        let dir = p.dataDir.appendingPathComponent("memory", isDirectory: true)
        var mtimes: [String: Double] = [:]
        BackupJSONLReader.forEach(in: p.dataDir, base: "memory.meta", as: BackupMemoryMetaRecord.self) {
            mtimes[$0.name] = $0.mtime
        }
        let root = target.memoryRoot()
        return ((try? fm.contentsOfDirectory(atPath: dir.path)) ?? []).sorted().compactMap { name in
            guard name.lowercased().hasSuffix(".md"), BackupPaths.isSafeComponent(name), !name.hasPrefix(".") else { return nil }
            return MemoryItem(name: name, packageURL: dir.appendingPathComponent(name),
                              localURL: root.appendingPathComponent(name), packageMtime: mtimes[name])
        }
    }

    func memoryDecision(_ item: MemoryItem) -> BackupMerge.FileDecision {
        guard let pkgSha = try? BackupBlobStore.sha256OfFile(at: item.packageURL) else { return .keepLocal }
        let exists = fm.fileExists(atPath: item.localURL.path)
        if exists, let text = try? String(contentsOf: item.localURL, encoding: .utf8),
           text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return .replace   // an empty local file holds nothing to protect
        }
        var mtime: Date?
        var localSha: String?
        if exists {
            mtime = (try? item.localURL.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate
            localSha = try? BackupBlobStore.sha256OfFile(at: item.localURL)
        }
        return BackupMerge.decideFile(localExists: exists, localSha: localSha,
                                      localMtime: mtime, packageSha: pkgSha, packageMtime: item.packageMtime)
    }

    private func applyMemory(_ p: Prepared, journal: BackupRestoreJournal) async throws -> CategoryReport {
        var r = CategoryReport(category: .memory)
        let root = target.memoryRoot()
        try fm.createDirectory(at: root, withIntermediateDirectories: true)
        var changed: [String] = []
        for item in memoryItems(p) {
            try Task.checkCancellation()
            guard BackupPaths.isContained(item.localURL, within: root) else { r.rejectedPaths += 1; continue }
            let decision = memoryDecision(item)
            switch decision {
            case .identical: r.identical += 1; continue
            case .keepLocal: r.keptLocal += 1; continue
            case .write, .replace: break
            }
            let staged = root.appendingPathComponent(".restore-\(UUID().uuidString).tmp")
            try fm.copyItem(at: item.packageURL, to: staged)
            do {
                if fm.fileExists(atPath: item.localURL.path) {
                    try journal.willReplace(.memory, root: .memory, path: item.name, live: item.localURL)
                    _ = try fm.replaceItemAt(item.localURL, withItemAt: staged)
                    r.updated += 1
                } else {
                    try journal.willCreate(.memory, root: .memory, path: item.name)
                    try fm.moveItem(at: staged, to: item.localURL)
                    r.imported += 1
                }
            } catch {
                try? fm.removeItem(at: staged)
                throw error
            }
            changed.append(item.name)
        }
        if !changed.isEmpty { await target.didRestoreMemory(fileNames: changed) }
        return r
    }

    // MARK: - Skills

    private func applySkills(_ p: Prepared, undo: inout UndoLog) async throws -> CategoryReport {
        var r = CategoryReport(category: .skills)
        let records = BackupJSONLReader.readAll(in: p.dataDir, base: "skills", as: BackupSkillRecord.self)
        let stamps = await target.localSkillStamps()
        var byId: [String: [BackupFileIndexEntry]] = [:]
        for e in p.fileIndex where e.category == BackupCategory.skills.rawValue && e.skipped == nil && e.isDirectory != true {
            guard e.path.hasPrefix("skills/"), let comps = BackupPaths.safeComponents(String(e.path.dropFirst(7))),
                  comps.count >= 2 else { r.rejectedPaths += 1; continue }
            byId[comps[0], default: []].append(e)
        }
        var handled = Set<String>()
        var restored: [String] = []
        for rec in records {
            try Task.checkCancellation()
            guard BackupPaths.isSafeComponent(rec.id), handled.insert(rec.id).inserted else { continue }
            let decision = BackupMerge.decide(local: stamps[rec.id], incoming: rec.updatedAt)
            if decision == .keepLocal { r.keptLocal += 1; continue }

            guard let payload = skillPayload(rec, entries: byId[rec.id] ?? [], root: p.root, report: &r) else {
                r.unreadable += 1
                continue
            }
            var snapshot: BackupSkillSnapshot?
            if decision == .update { snapshot = await target.snapshotSkill(id: rec.id) }
            try await target.applySkill(payload)
            let t = target
            if let snapshot {
                undo.add { await t.restoreSkillSnapshot(snapshot) }
                r.updated += 1
            } else {
                let id = rec.id
                undo.add { await t.removeRestoredSkill(id: id) }
                r.imported += 1
            }
            r.filesWritten += payload.files.count + 1
            restored.append(rec.id)
        }
        if !restored.isEmpty { await target.didRestoreSkills(ids: restored) }
        return r
    }

    private func skillPayload(_ rec: BackupSkillRecord, entries: [BackupFileIndexEntry], root: URL,
                              report r: inout CategoryReport) -> BackupSkillPayload? {
        var content: String?
        var files: [BackupSkillFile] = []
        var total: Int64 = 0
        let prefix = "skills/\(rec.id)/"
        for e in entries {
            guard let sha = e.sha256, sha.count == 64, sha.allSatisfy(\.isHexDigit) else { continue }
            let blob = root.appendingPathComponent("blobs/\(sha.prefix(2))/\(sha)")
            total += e.size
            guard total <= BackupFormat.Limits.maxSkillBytes else { return nil }
            guard let data = try? Data(contentsOf: blob) else { r.missingBlobs += 1; continue }
            let rel = String(e.path.dropFirst(prefix.count))
            if rel == "SKILL.md" {
                content = String(data: data, encoding: .utf8)
            } else {
                files.append(BackupSkillFile(relativePath: rel, data: data))
            }
        }
        // A package from a writer that didn't carry SKILL.md as a file: the
        // record's body is the best we have.
        let text = content ?? (rec.body.isEmpty ? nil : rec.body)
        guard let text else { return nil }
        return BackupSkillPayload(record: rec, content: text, files: files)
    }

    // MARK: - Providers

    private func applyProviders(_ p: Prepared, undo: inout UndoLog) async throws -> CategoryReport {
        var r = CategoryReport(category: .providers)
        let t = target
        if let backup = jsonObject(p.dataDir.appendingPathComponent("provider_config.json")) {
            guard let localData = await target.providerConfigJSON(),
                  let local = try? JSONSerialization.jsonObject(with: localData) as? [String: Any] else {
                throw ImportError.providerStoreUnavailable
            }
            let merged = BackupMerge.mergeProviderConfig(local: local, backup: backup,
                                                         backupSnapshotAt: p.manifest.snapshotAt ?? p.manifest.createdAt)
            r.imported = merged.stats.instancesAdded
            r.keptLocal = merged.stats.instancesKept
            if merged.stats.changed {
                let data = try JSONSerialization.data(withJSONObject: merged.merged)
                try await target.applyProviderConfigJSON(data)
                undo.add { try? await t.applyProviderConfigJSON(localData) }
            }
            if merged.stats.groupsAdded > 0 {
                r.needsAttention.append(String(localized: "新增 \(merged.stats.groupsAdded) 个模型分组"))
            }

            if p.hasSecrets, let data = BackupJSONFile.read(p.root.appendingPathComponent("secrets.json")),
               let secrets = try? JSONDecoder().decode(BackupSecrets.self, from: data) {
                let ids = Set(((merged.merged["instances"] as? [[String: Any]]) ?? []).compactMap { $0["id"] as? String })
                let result = await target.applyProviderSecrets(secrets.providers, instanceIds: ids)
                r.credentialsRestored = result.written.count
                r.credentialsKept = result.keptLocal
                if !result.written.isEmpty {
                    let written = result.written
                    undo.add { await t.removeProviderSecrets(written) }
                }
            } else if r.imported > 0 {
                r.needsAttention.append(String(localized: "\(r.imported) 个服务商需要重新填写 API 密钥"))
            }
        }

        let rules = BackupJSONLReader.readAll(in: p.dataDir, base: "leo_thinking_rules", as: BackupLeoThinkingRuleRecord.self)
        if !rules.isEmpty {
            let localRules = await target.thinkingRules()
            let merged = BackupMerge.mergeThinkingRules(local: localRules, backup: rules)
            if merged.added > 0 {
                await target.saveThinkingRules(merged.merged)
                undo.add { await t.saveThinkingRules(localRules) }
                r.imported += merged.added
            }
        }
        return r
    }

    // MARK: - Environment variables

    private func applyEnvironmentVariables(_ p: Prepared, undo: inout UndoLog) async throws -> CategoryReport {
        var r = CategoryReport(category: .environmentVariables)
        let records = readEnvVars(p)
        let toAdd = BackupMerge.envVarsToAdd(localKeys: await target.envVarKeys(), backup: records)
        r.keptLocal = records.count - toAdd.count
        var values: [String: String] = [:]
        if p.hasSecrets, let data = BackupJSONFile.read(p.root.appendingPathComponent("secrets.json")),
           let secrets = try? JSONDecoder().decode(BackupSecrets.self, from: data) {
            for s in secrets.envVars { values[s.name.uppercased()] = BackupSecrets.decode(s.value) }
        }
        var missingValues = 0
        let t = target
        for rec in toAdd {
            try Task.checkCancellation()
            let value = values[rec.key]
            if value == nil { missingValues += 1 }
            let id = try await target.addEnvVar(key: rec.key, value: value ?? "", note: rec.note)
            undo.add { await t.removeEnvVar(id: id) }
            r.imported += 1
            if value != nil { r.credentialsRestored += 1 }
        }
        if missingValues > 0 {
            r.needsAttention.append(String(localized: "\(missingValues) 个环境变量没有值，需要重新填写"))
        }
        return r
    }

    // MARK: - MCP servers

    private func applyMCPServers(_ p: Prepared, undo: inout UndoLog) async throws -> CategoryReport {
        var r = CategoryReport(category: .mcpServers)
        guard let backup = jsonObject(p.dataDir.appendingPathComponent("mcp_servers.json")) else { return r }
        let localData = await target.mcpServersJSON()
        let local = localData.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] } ?? [:]
        var merged = BackupMerge.mergeMCPServers(local: local, backup: backup)
        r.imported = merged.plan.added.count
        r.updated = merged.plan.replaced.count
        r.keptLocal = merged.plan.kept.count
        // An unencrypted package carries no proof of origin: anyone can hand
        // one over with a server whose headers/env reference `$$API_KEY`, and
        // the model would call it on the next turn, leaking the real value.
        // Imported servers from such a package land DISABLED; the user turns
        // each one on after looking at it.
        let quarantined = !p.wasEncrypted ? BackupMerge.disableMCPServers(&merged.toApply) : 0
        if !merged.toApply.isEmpty {
            let data = try JSONSerialization.data(withJSONObject: ["mcpServers": merged.toApply])
            try await target.applyMCPServers(data)
            let t = target
            let added = merged.plan.added
            undo.add { await t.revertMCPServers(previous: localData, added: added) }
        }
        if !merged.plan.needsSecrets.isEmpty {
            r.needsAttention.append(String(localized: "\(merged.plan.needsSecrets.count) 个 MCP 服务器需要重新填写密钥"))
        }
        if quarantined > 0 {
            r.needsAttention.append(String(localized: "未加密备份无法验证来源：导入的 \(quarantined) 个 MCP 服务器已保持停用，请在 设置 › MCP 里逐个检查后再启用"))
        }
        return r
    }
}
