import Foundation

/// What the exporter reads. `LiveBackupStores` wraps the app's stores; the
/// logic tests drive the whole pipeline with a temp-directory fake.
protocol BackupExportSource: Sendable {
    func deviceName() async -> String
    func appInfo() -> BackupManifest.AppInfo

    /// Live (not soft-deleted) chat sessions.
    func chatSessionIds() async -> [String]
    func chatSession(_ id: String) async -> BackupSessionRecord?
    func chatMessages(_ sessionId: String) async -> [BackupMessageRecord]
    func chatCompactMarkers(_ sessionId: String) async -> [BackupCompactMarkerRecord]
    /// `<chats root>/<sid>/` — attachments, offloads, workspace, browser.
    func chatsRoot() -> URL
    func sharedFilesRoot() -> URL
    func skills() async -> [BackupSkillRecord]
    func skillsRoot() -> URL
    /// Directory names a skill export skips (node_modules, caches …).
    func isSkillExcludedDirectory(_ name: String) -> Bool
    func memoryRoot() -> URL
    /// `ProviderConfig` encoded with ISO-8601 dates; nil if unavailable.
    func providerConfigJSON() async -> Data?
    func thinkingRules() async -> [BackupLeoThinkingRuleRecord]
    /// The MCP `servers.json` file (`{"mcpServers": {…}}`).
    func mcpServersFile() -> URL
    func envVarEntries() async -> [BackupEnvVarRecord]
    /// Keychain credentials. Only ever called for an ENCRYPTED export.
    func collectSecrets(providerInstanceIds: [String]?, envVarKeys: [String]?) async -> BackupSecrets
}

/// Outcome of the chats DB merge, done by the store in ONE transaction.
struct BackupChatApplyResult: Sendable, Equatable {
    var sessionsInserted = 0
    var sessionsUpdated = 0
    var sessionsKeptLocal = 0
    var messagesInserted = 0
    var messagesUpdated = 0
    var messagesKeptLocal = 0
    var markersInserted = 0
    var markersKept = 0
    var unreadable = 0
    /// Sessions whose rows changed — re-marked for sync under this device.
    var changedSessionIds: [String] = []
}

/// A restored skill, rebuilt from the package's file tree.
struct BackupSkillPayload: Sendable {
    var record: BackupSkillRecord
    /// Full SKILL.md text.
    var content: String
    /// Every other file, relative to the skill directory.
    var files: [BackupSkillFile]
}

struct BackupSkillFile: Sendable {
    var relativePath: String
    var data: Data
}

/// Enough to put a replaced skill back on rollback.
struct BackupSkillSnapshot: Sendable {
    var record: BackupSkillRecord
    var content: String
    var zipData: Data?
}

/// Reference to one credential written by a restore, for rollback.
struct BackupSecretRef: Sendable, Equatable {
    enum Kind: String, Sendable { case apiKey, manualOAuthToken }
    var instanceId: String
    var kind: Kind
}

/// What the importer writes through. Every mutation goes through the app's own
/// store APIs, so restored data is local data, marked dirty, and re-uploaded
/// by iCloud sync under THIS device's identity — no second sync state machine.
protocol BackupRestoreTarget: Sendable {
    func chatsRoot() -> URL
    func sharedFilesRoot() -> URL
    func memoryRoot() -> URL

    /// Sessions among `ids` with an agent turn in flight right now.
    func runningSessionIds(_ ids: [String]) async -> [String]
    /// Local `updated_at` (or a newer soft-delete time) per existing session.
    func localSessionStamps(_ ids: [String]) async -> [String: Date]
    /// Merge sessions + their messages / markers (read from `dataDir`'s JSONL
    /// shards) atomically. Must throw (and roll back) on any failure.
    func applyChats(sessions: [BackupSessionRecord], dataDir: URL) async throws -> BackupChatApplyResult
    func didRestoreChats(sessionIds: Set<String>) async
    func didRestoreMemory(fileNames: [String]) async
    func didRestoreSharedFiles() async

    func localSkillStamps() async -> [String: Date]
    func snapshotSkill(id: String) async -> BackupSkillSnapshot?
    func applySkill(_ payload: BackupSkillPayload) async throws
    func restoreSkillSnapshot(_ snapshot: BackupSkillSnapshot) async
    func removeRestoredSkill(id: String) async
    /// Called once the whole skills category succeeded: mark for sync.
    func didRestoreSkills(ids: [String]) async

    func providerConfigJSON() async -> Data?
    func applyProviderConfigJSON(_ data: Data) async throws
    func thinkingRules() async -> [BackupLeoThinkingRuleRecord]
    func saveThinkingRules(_ rules: [BackupLeoThinkingRuleRecord]) async
    /// Write credentials that are MISSING locally; never overwrite.
    func applyProviderSecrets(_ secrets: [BackupSecrets.ProviderSecret],
                              instanceIds: Set<String>) async -> (written: [BackupSecretRef], keptLocal: Int)
    func removeProviderSecrets(_ refs: [BackupSecretRef]) async

    func envVarKeys() async -> Set<String>
    /// Returns the new entry's id.
    func addEnvVar(key: String, value: String, note: String) async throws -> String
    func removeEnvVar(id: String) async

    func mcpServersJSON() async -> Data?
    /// `{"mcpServers": {name: entry}}` — upsert these entries.
    func applyMCPServers(_ json: Data) async throws
    /// Undo: remove `added`, put `previous` (whole servers.json) entries back.
    func revertMCPServers(previous: Data?, added: [String]) async
}
