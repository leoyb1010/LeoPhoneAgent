import Foundation

private let logger = AppLogger(category: "Backup")

/// The app-side adapter: reads for export and writes for restore go through
/// the existing stores (ChatStore, SkillStore, ProviderConfigStore,
/// EnvVarStore, MCPStore, Keychain helpers), so every restored item is plain
/// local data that the stores mark dirty and iCloud sync re-uploads under
/// this device's identity. There is no second sync state machine here.
///
/// Secrets are never logged: only counts are.
struct LiveBackupStores: BackupExportSource, BackupRestoreTarget {

    static let manualOAuthAccount = "manual-oauth-token"

    // MARK: - Roots

    func chatsRoot() -> URL { AIChatViewModel.minisPersistentBase }
    func sharedFilesRoot() -> URL { AIChatViewModel.minisSharedPersistentDir }
    func skillsRoot() -> URL { AIChatViewModel.minisSkillsPersistentDir }
    func memoryRoot() -> URL { AIChatViewModel.minisMemoryPersistentDir }
    func mcpServersFile() -> URL { MCPStore.syncFileURL }
    func isSkillExcludedDirectory(_ name: String) -> Bool { SkillStore.isExcludedDir(name) }

    // MARK: - Export

    func deviceName() async -> String {
        await MainActor.run { DeviceIdentity.deviceName }
    }

    func appInfo() -> BackupManifest.AppInfo {
        let info = Bundle.main.infoDictionary
        return .init(platform: "ios",
                     version: info?["CFBundleShortVersionString"] as? String ?? "?",
                     build: info?["CFBundleVersion"] as? String ?? "?")
    }

    func chatSessionIds() async -> [String] { await ChatStore.shared.backupSessionIds() }
    func chatSession(_ id: String) async -> BackupSessionRecord? { await ChatStore.shared.backupSessionRecord(id) }
    func chatMessages(_ sessionId: String) async -> [BackupMessageRecord] {
        await ChatStore.shared.backupMessages(sessionId: sessionId)
    }
    func chatCompactMarkers(_ sessionId: String) async -> [BackupCompactMarkerRecord] {
        await ChatStore.shared.backupCompactMarkers(sessionId: sessionId)
    }

    func skills() async -> [BackupSkillRecord] {
        await MainActor.run {
            SkillStore.shared.skills.map {
                BackupSkillRecord(id: $0.id, name: $0.name, description: $0.description, version: $0.version,
                                  isEnabled: $0.isEnabled, installedAt: $0.installedAt, updatedAt: $0.updatedAt,
                                  body: $0.body, sourceURL: $0.sourceURL)
            }
        }
    }

    func providerConfigJSON() async -> Data? {
        await MainActor.run { try? BackupDates.encoder().encode(ProviderConfigStore.shared.config) }
    }

    func thinkingRules() async -> [BackupLeoThinkingRuleRecord] {
        ThinkingRuleStore.load().map {
            BackupLeoThinkingRuleRecord(prefix: $0.prefix, maxLevel: $0.maxLevel.rawValue,
                                        defaultLevel: $0.defaultLevel.rawValue)
        }
    }

    func envVarEntries() async -> [BackupEnvVarRecord] {
        await MainActor.run {
            EnvVarStore.shared.entries.map {
                BackupEnvVarRecord(id: $0.id, key: $0.key, createdAt: $0.createdAt, note: $0.note)
            }
        }
    }

    /// API keys and user-pasted tokens only. Structured OAuth logins stay
    /// device-only (LeoBot policy) and are re-done after a restore.
    func collectSecrets(providerInstanceIds: [String]?, envVarKeys: [String]?) async -> BackupSecrets {
        await MainActor.run {
            var out = BackupSecrets()
            let instances = ProviderConfigStore.shared.config.instances
            for id in providerInstanceIds ?? [] {
                guard let inst = instances.first(where: { $0.id == id }) else { continue }
                var s = BackupSecrets.ProviderSecret(instanceId: id, label: inst.label,
                                                     providerType: inst.providerType.rawValue)
                if let key = ProviderKeychainHelper.loadAPIKey(instanceId: id), !key.isEmpty {
                    s.apiKey = BackupSecrets.encode(key)
                }
                if let manual = ProviderKeychainHelper.loadOAuthString(instanceId: id, account: Self.manualOAuthAccount),
                   !manual.isEmpty {
                    s.manualOAuthToken = BackupSecrets.encode(manual)
                }
                if !s.isEmpty { out.providers.append(s) }
            }
            for key in envVarKeys ?? [] {
                guard let value = EnvVarStore.loadValueSync(forKey: key), !value.isEmpty else { continue }
                out.envVars.append(.init(name: key, value: BackupSecrets.encode(value)))
            }
            logger.info("[Backup] credentials collected providers=\(out.providers.count) envVars=\(out.envVars.count)")
            return out
        }
    }

    // MARK: - Restore: chats

    func runningSessionIds(_ ids: [String]) async -> [String] {
        ids.filter { SessionActivityTracker.isActiveThreadSafe($0) }
    }

    func localSessionStamps(_ ids: [String]) async -> [String: Date] {
        await ChatStore.shared.backupSessionStamps(ids)
    }

    func applyChats(sessions: [BackupSessionRecord], dataDir: URL) async throws -> BackupChatApplyResult {
        try await ChatStore.shared.restoreChatsFromBackup(sessions: sessions, dataDir: dataDir)
    }

    func didRestoreChats(sessionIds: Set<String>) async {
        // Session + every message / marker / file → durable dirty queue, so
        // sync re-uploads the restored tree under this device.
        for sid in sessionIds.sorted() {
            await ChatStore.shared.forceMarkSessionDirty(sessionId: sid)
        }
        await MainActor.run {
            NotificationCenter.default.post(name: .cloudSyncDidFetchChanges, object: nil)
        }
    }

    // MARK: - Restore: memory / shared

    func didRestoreMemory(fileNames: [String]) async {
        let dayFormat = /^\d{4}-\d{2}-\d{2}\.md$/
        for name in fileNames {
            if name == "GLOBAL.md" {
                await ChatStore.shared.markDirty(recordType: "MemoryGlobalV2", recordId: "memory-global")
            } else if name == "SOUL.md" {
                await ChatStore.shared.markDirty(recordType: "SoulV2", recordId: "soul")
            } else if name.wholeMatch(of: dayFormat) != nil {
                await ChatStore.shared.markDirty(recordType: "MemoryDailyV2",
                                                 recordId: String(name.dropLast(3)))
            }
        }
        if fileNames.contains("SOUL.md") {
            await MainActor.run { SoulStore.refreshCache() }
        }
    }

    func didRestoreSharedFiles() async {}

    // MARK: - Restore: skills

    func localSkillStamps() async -> [String: Date] {
        await MainActor.run {
            Dictionary(SkillStore.shared.skills.map { ($0.id, $0.updatedAt) }, uniquingKeysWith: { a, _ in a })
        }
    }

    func snapshotSkill(id: String) async -> BackupSkillSnapshot? {
        await MainActor.run {
            let store = SkillStore.shared
            guard let s = store.skills.first(where: { $0.id == id }),
                  let content = store.readSkillContent(id) else { return nil }
            let record = BackupSkillRecord(id: s.id, name: s.name, description: s.description, version: s.version,
                                           isEnabled: s.isEnabled, installedAt: s.installedAt,
                                           updatedAt: s.updatedAt, body: s.body, sourceURL: s.sourceURL)
            return BackupSkillSnapshot(record: record, content: content, zipData: store.buildSkillZipData(id))
        }
    }

    func applySkill(_ payload: BackupSkillPayload) async throws {
        try await MainActor.run {
            var files = [(relativePath: "SKILL.md", data: Data(payload.content.utf8))]
            files += payload.files.map { (relativePath: $0.relativePath, data: $0.data) }
            let rec = payload.record
            // The same transactional path iCloud sync uses: both skill roots,
            // the skills DB and the guest's fakefs metadata in one step.
            try SkillStore.shared.importSkillFromSyncWithAsset(
                skillId: rec.id, content: payload.content,
                zipData: SkillStore.buildZipArchive(files: files),
                source: rec.sourceURL.map { .url($0) } ?? .file,
                isEnabled: rec.isEnabled, installedAt: rec.installedAt, updatedAt: rec.updatedAt)
        }
    }

    func restoreSkillSnapshot(_ snapshot: BackupSkillSnapshot) async {
        await MainActor.run {
            let store = SkillStore.shared
            let rec = snapshot.record
            // Remove the restored copy first: the sync import path refuses to
            // overwrite a newer local skill, which the restored one now is.
            try? store.applyRemoteDeletion(id: rec.id)
            try? store.importSkillFromSyncWithAsset(
                skillId: rec.id, content: snapshot.content, zipData: snapshot.zipData,
                source: rec.sourceURL.map { .url($0) } ?? .file,
                isEnabled: rec.isEnabled, installedAt: rec.installedAt, updatedAt: rec.updatedAt)
        }
    }

    func removeRestoredSkill(id: String) async {
        await MainActor.run { try? SkillStore.shared.applyRemoteDeletion(id: id) }
    }

    func didRestoreSkills(ids: [String]) async {
        await MainActor.run { for id in ids { SkillStore.shared.forceMarkDirty(id) } }
    }

    // MARK: - Restore: providers

    enum ProviderApplyError: LocalizedError {
        case decode, rejected
        var errorDescription: String? {
            switch self {
            case .decode: return String(localized: "备份中的服务商配置无法解析")
            case .rejected: return String(localized: "服务商配置保存失败，已保留原配置")
            }
        }
    }

    /// Local write through `applyConfig`: persists JSON + DB mirror and marks
    /// exactly the changed provider rows dirty (row timestamps only move on
    /// change), so V3 sync re-uploads them. Not `mergeProviderConfig`: that
    /// is the inbound-sync merger (remote wins, skips while dirty, drops
    /// API-truth entries), the wrong semantics for "put my backup back".
    func applyProviderConfigJSON(_ data: Data) async throws {
        guard let config = try? BackupDates.decoder().decode(ProviderConfig.self, from: data) else {
            throw ProviderApplyError.decode
        }
        try await MainActor.run {
            let store = ProviderConfigStore.shared
            store.applyConfig(config)
            // save() rolls the in-memory config back when persistence refuses.
            guard store.config == config else { throw ProviderApplyError.rejected }
        }
    }

    func saveThinkingRules(_ rules: [BackupLeoThinkingRuleRecord]) async {
        let mapped = rules.compactMap { r -> ThinkingRule? in
            guard let maxLevel = ThinkingLevel(rawValue: r.maxLevel),
                  let defaultLevel = ThinkingLevel(rawValue: r.defaultLevel) else { return nil }
            return ThinkingRule(prefix: r.prefix, maxLevel: maxLevel, defaultLevel: defaultLevel)
        }
        ThinkingRuleStore.save(mapped)
    }

    func applyProviderSecrets(_ secrets: [BackupSecrets.ProviderSecret],
                              instanceIds: Set<String>) async -> (written: [BackupSecretRef], keptLocal: Int) {
        await MainActor.run {
            var written: [BackupSecretRef] = []
            var kept = 0
            for s in secrets where instanceIds.contains(s.instanceId) {
                if let value = s.apiKey.flatMap(BackupSecrets.decode), !value.isEmpty {
                    if ProviderKeychainHelper.loadAPIKey(instanceId: s.instanceId) == nil {
                        if ProviderKeychainHelper.saveAPIKey(value, instanceId: s.instanceId) {
                            written.append(.init(instanceId: s.instanceId, kind: .apiKey))
                        }
                    } else {
                        kept += 1
                    }
                }
                if let value = s.manualOAuthToken.flatMap(BackupSecrets.decode), !value.isEmpty {
                    if ProviderKeychainHelper.loadOAuthString(instanceId: s.instanceId, account: Self.manualOAuthAccount) == nil {
                        ProviderKeychainHelper.saveOAuthString(value, instanceId: s.instanceId, account: Self.manualOAuthAccount)
                        written.append(.init(instanceId: s.instanceId, kind: .manualOAuthToken))
                    } else {
                        kept += 1
                    }
                }
            }
            logger.info("[Restore] credentials written=\(written.count) keptLocal=\(kept)")
            return (written, kept)
        }
    }

    func removeProviderSecrets(_ refs: [BackupSecretRef]) async {
        await MainActor.run {
            for ref in refs {
                switch ref.kind {
                case .apiKey: ProviderKeychainHelper.deleteAPIKey(instanceId: ref.instanceId)
                case .manualOAuthToken:
                    ProviderKeychainHelper.deleteOAuthString(instanceId: ref.instanceId, account: Self.manualOAuthAccount)
                }
            }
        }
    }

    // MARK: - Restore: environment variables

    func envVarKeys() async -> Set<String> {
        await MainActor.run { Set(EnvVarStore.shared.entries.map(\.key)) }
    }

    func addEnvVar(key: String, value: String, note: String) async throws -> String {
        try await MainActor.run {
            let store = EnvVarStore.shared
            switch store.add(key: key, value: value, note: note) {
            case .success:
                guard let id = store.entries.first(where: { $0.key == key })?.id else {
                    throw EnvVarStore.MutationError.missingEntry
                }
                return id
            case .failure(let error):
                throw error
            }
        }
    }

    func removeEnvVar(id: String) async {
        await MainActor.run { EnvVarStore.shared.delete(id: id) }
    }

    // MARK: - Restore: MCP

    func mcpServersJSON() async -> Data? {
        try? Data(contentsOf: MCPStore.syncFileURL)
    }

    func applyMCPServers(_ json: Data) async throws {
        let text = String(decoding: json, as: UTF8.self)
        try await MainActor.run {
            let store = MCPStore.shared
            // parse + commit = the store's own import path: per-server
            // updatedAt stamped, file written atomically, items marked dirty.
            try store.commitImport(try store.parseImport(text))
        }
    }

    func revertMCPServers(previous: Data?, added: [String]) async {
        await MainActor.run {
            let store = MCPStore.shared
            for name in added { store.delete(id: name) }
            if let previous, let text = String(data: previous, encoding: .utf8),
               let parsed = try? store.parseImport(text) {
                try? store.commitImport(parsed)
            }
        }
    }
}
