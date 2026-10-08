import Foundation
import XCTest

/// A whole fake "device" for backup tests: real directories for the file
/// categories, in-memory tables for the record categories. It implements both
/// sides of the store boundary, so the REAL exporter / importer / zip / crypto
/// / journal code runs end to end against it.
final class FakeBackupWorld: BackupExportSource, BackupRestoreTarget, @unchecked Sendable {
    let root: URL
    private let lock = NSLock()

    var sessions: [String: BackupSessionRecord] = [:]
    var messages: [String: BackupMessageRecord] = [:]
    var markers: [String: BackupCompactMarkerRecord] = [:]
    var skillRecords: [String: BackupSkillRecord] = [:]
    /// A fresh device's provider store is empty, never absent.
    var providerJSON: Data? = Data(#"{"instances":[],"modelEntries":[],"modelGroups":[],"sessionBindings":{}}"#.utf8)
    var rules: [BackupLeoThinkingRuleRecord] = []
    var envEntries: [BackupEnvVarRecord] = []
    var envValues: [String: String] = [:]
    var apiKeys: [String: String] = [:]
    var running: Set<String> = []
    var failChatsDB = false
    var collectSecretsCalls = 0
    var markedSessions: [String] = []

    init(name: String) throws {
        root = FileManager.default.temporaryDirectory
            .appendingPathComponent("backup-world-\(name)-\(UUID().uuidString)", isDirectory: true)
        for d in ["chats", "shared", "skills", "memory", "mcp", "work", "journal"] {
            try FileManager.default.createDirectory(at: root.appendingPathComponent(d), withIntermediateDirectories: true)
        }
    }

    func destroy() { try? FileManager.default.removeItem(at: root) }

    func sync<T>(_ body: () throws -> T) rethrows -> T {
        lock.lock(); defer { lock.unlock() }
        return try body()
    }

    var workRoot: URL { root.appendingPathComponent("work", isDirectory: true) }
    var journalBase: URL { root.appendingPathComponent("journal", isDirectory: true) }

    // MARK: Helpers for fixtures

    func write(_ text: String, to rel: String, under base: URL, mtime: Date? = nil) throws {
        let url = rel.split(separator: "/").reduce(base) { $0.appendingPathComponent(String($1)) }
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data(text.utf8).write(to: url)
        if let mtime { try FileManager.default.setAttributes([.modificationDate: mtime], ofItemAtPath: url.path) }
    }

    func read(_ rel: String, under base: URL) -> String? {
        let url = rel.split(separator: "/").reduce(base) { $0.appendingPathComponent(String($1)) }
        return (try? Data(contentsOf: url)).flatMap { String(data: $0, encoding: .utf8) }
    }

    static func textParts(_ s: String) -> BackupJSONValue {
        .array([.object(["type": .string("text"), "value": .string(s)])])
    }

    // MARK: - BackupExportSource

    func deviceName() async -> String { "Test iPhone · AB12" }
    func appInfo() -> BackupManifest.AppInfo { .init(platform: "ios", version: "1.59.0", build: "157") }
    func chatSessionIds() async -> [String] { sync { sessions.keys.sorted() } }
    func chatSession(_ id: String) async -> BackupSessionRecord? { sync { sessions[id] } }
    func chatMessages(_ sessionId: String) async -> [BackupMessageRecord] {
        sync { messages.values.filter { $0.sessionId == sessionId }.sorted { $0.sortOrder < $1.sortOrder } }
    }
    func chatCompactMarkers(_ sessionId: String) async -> [BackupCompactMarkerRecord] {
        sync { markers.values.filter { $0.sessionId == sessionId } }
    }
    func chatsRoot() -> URL { root.appendingPathComponent("chats", isDirectory: true) }
    func sharedFilesRoot() -> URL { root.appendingPathComponent("shared", isDirectory: true) }
    func skills() async -> [BackupSkillRecord] { sync { skillRecords.values.sorted { $0.id < $1.id } } }
    func skillsRoot() -> URL { root.appendingPathComponent("skills", isDirectory: true) }
    func isSkillExcludedDirectory(_ name: String) -> Bool { name == "node_modules" }
    func memoryRoot() -> URL { root.appendingPathComponent("memory", isDirectory: true) }
    func providerConfigJSON() async -> Data? { sync { providerJSON } }
    func thinkingRules() async -> [BackupLeoThinkingRuleRecord] { sync { rules } }
    func mcpServersFile() -> URL { root.appendingPathComponent("mcp/servers.json") }
    func envVarEntries() async -> [BackupEnvVarRecord] { sync { envEntries } }

    func collectSecrets(providerInstanceIds: [String]?, envVarKeys: [String]?) async -> BackupSecrets {
        sync {
            collectSecretsCalls += 1
            var s = BackupSecrets()
            for id in providerInstanceIds ?? [] {
                if let k = apiKeys[id] {
                    s.providers.append(.init(instanceId: id, label: nil, providerType: "openAI",
                                             apiKey: BackupSecrets.encode(k)))
                }
            }
            for key in envVarKeys ?? [] {
                if let v = envValues[key], !v.isEmpty { s.envVars.append(.init(name: key, value: BackupSecrets.encode(v))) }
            }
            return s
        }
    }

    // MARK: - BackupRestoreTarget

    func runningSessionIds(_ ids: [String]) async -> [String] { sync { ids.filter { running.contains($0) } } }
    func localSessionStamps(_ ids: [String]) async -> [String: Date] {
        sync {
            var out: [String: Date] = [:]
            for id in ids { if let s = sessions[id] { out[id] = s.session.updatedAt } }
            return out
        }
    }

    /// Same LWW rules as ChatStore+Restore, all-or-nothing.
    func applyChats(sessions incoming: [BackupSessionRecord], dataDir: URL) async throws -> BackupChatApplyResult {
        try sync {
            let snapshot = (sessions, messages, markers)
            var r = BackupChatApplyResult()
            var applied = Set<String>()
            for rec in incoming {
                switch BackupMerge.decide(local: sessions[rec.session.id]?.session.updatedAt, incoming: rec.session.updatedAt) {
                case .keepLocal: r.sessionsKeptLocal += 1; continue
                case .insert: r.sessionsInserted += 1
                case .update: r.sessionsUpdated += 1
                }
                sessions[rec.session.id] = rec
                applied.insert(rec.session.id)
                r.changedSessionIds.append(rec.session.id)
            }
            let s1 = BackupJSONLReader.forEach(in: dataDir, base: "messages", as: BackupMessageRecord.self) { m in
                guard applied.contains(m.sessionId) else { return }
                switch BackupMerge.decide(local: messages[m.id]?.effectiveUpdatedAt, incoming: m.effectiveUpdatedAt) {
                case .keepLocal: r.messagesKeptLocal += 1
                case .insert: messages[m.id] = m; r.messagesInserted += 1
                case .update: messages[m.id] = m; r.messagesUpdated += 1
                }
            }
            let s2 = BackupJSONLReader.forEach(in: dataDir, base: "compact_markers", as: BackupCompactMarkerRecord.self) { mk in
                guard applied.contains(mk.sessionId) else { return }
                if markers[mk.id] == nil { markers[mk.id] = mk; r.markersInserted += 1 } else { r.markersKept += 1 }
            }
            r.unreadable = s1.unreadable + s2.unreadable
            if failChatsDB {
                (sessions, messages, markers) = snapshot
                throw NSError(domain: "FakeDB", code: 1)
            }
            return r
        }
    }

    func didRestoreChats(sessionIds: Set<String>) async { sync { markedSessions += sessionIds.sorted() } }
    func didRestoreMemory(fileNames: [String]) async {}
    func didRestoreSharedFiles() async {}

    func localSkillStamps() async -> [String: Date] { sync { skillRecords.mapValues(\.updatedAt) } }

    func snapshotSkill(id: String) async -> BackupSkillSnapshot? {
        sync {
            guard let rec = skillRecords[id],
                  let content = read("\(id)/SKILL.md", under: skillsRoot()) else { return nil }
            return BackupSkillSnapshot(record: rec, content: content, zipData: nil)
        }
    }

    func applySkill(_ payload: BackupSkillPayload) async throws {
        try sync {
            let dir = skillsRoot().appendingPathComponent(payload.record.id, isDirectory: true)
            try? FileManager.default.removeItem(at: dir)
            try write(payload.content, to: "SKILL.md", under: dir)
            for f in payload.files {
                let url = f.relativePath.split(separator: "/").reduce(dir) { $0.appendingPathComponent(String($1)) }
                try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
                try f.data.write(to: url)
            }
            skillRecords[payload.record.id] = payload.record
        }
    }

    func restoreSkillSnapshot(_ snapshot: BackupSkillSnapshot) async {
        sync {
            let dir = skillsRoot().appendingPathComponent(snapshot.record.id, isDirectory: true)
            try? FileManager.default.removeItem(at: dir)
            try? write(snapshot.content, to: "SKILL.md", under: dir)
            skillRecords[snapshot.record.id] = snapshot.record
        }
    }

    func removeRestoredSkill(id: String) async {
        sync {
            try? FileManager.default.removeItem(at: skillsRoot().appendingPathComponent(id))
            skillRecords[id] = nil
        }
    }

    func didRestoreSkills(ids: [String]) async {}

    func applyProviderConfigJSON(_ data: Data) async throws { sync { providerJSON = data } }
    func saveThinkingRules(_ rules: [BackupLeoThinkingRuleRecord]) async { sync { self.rules = rules } }

    func applyProviderSecrets(_ secrets: [BackupSecrets.ProviderSecret],
                              instanceIds: Set<String>) async -> (written: [BackupSecretRef], keptLocal: Int) {
        sync {
            var written: [BackupSecretRef] = []
            var kept = 0
            for s in secrets where instanceIds.contains(s.instanceId) {
                guard let v = s.apiKey.flatMap(BackupSecrets.decode) else { continue }
                if apiKeys[s.instanceId] == nil {
                    apiKeys[s.instanceId] = v
                    written.append(.init(instanceId: s.instanceId, kind: .apiKey))
                } else { kept += 1 }
            }
            return (written, kept)
        }
    }

    func removeProviderSecrets(_ refs: [BackupSecretRef]) async {
        sync { for r in refs { apiKeys[r.instanceId] = nil } }
    }

    func envVarKeys() async -> Set<String> { sync { Set(envEntries.map(\.key)) } }

    func addEnvVar(key: String, value: String, note: String) async throws -> String {
        sync {
            let id = UUID().uuidString
            envEntries.append(.init(id: id, key: key, createdAt: Date(), note: note))
            envValues[key] = value
            return id
        }
    }

    func removeEnvVar(id: String) async {
        sync {
            if let e = envEntries.first(where: { $0.id == id }) { envValues[e.key] = nil }
            envEntries.removeAll { $0.id == id }
        }
    }

    func mcpServersJSON() async -> Data? { try? Data(contentsOf: mcpServersFile()) }

    func applyMCPServers(_ json: Data) async throws {
        let incoming = (try JSONSerialization.jsonObject(with: json) as? [String: Any])?["mcpServers"] as? [String: Any] ?? [:]
        var current = ((try? Data(contentsOf: mcpServersFile()))
            .flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }?["mcpServers"] as? [String: Any]) ?? [:]
        for (k, v) in incoming { current[k] = v }
        try JSONSerialization.data(withJSONObject: ["mcpServers": current]).write(to: mcpServersFile())
    }

    func revertMCPServers(previous: Data?, added: [String]) async {
        if let previous { try? previous.write(to: mcpServersFile()) } else { try? FileManager.default.removeItem(at: mcpServersFile()) }
    }
}

enum BackupTestZip {
    /// Hand-built ZIP with arbitrary declared sizes / names, for hostile-input
    /// tests the real writer would never produce.
    static func raw(_ entries: [(name: String, method: UInt16, data: Data, declaredSize: UInt32?)]) -> Data {
        var out = Data()
        var central = Data()
        func u16(_ v: UInt16, _ d: inout Data) { withUnsafeBytes(of: v.littleEndian) { d.append(contentsOf: $0) } }
        func u32(_ v: UInt32, _ d: inout Data) { withUnsafeBytes(of: v.littleEndian) { d.append(contentsOf: $0) } }
        for e in entries {
            let offset = UInt32(out.count)
            let name = Data(e.name.utf8)
            let comp = UInt32(e.data.count)
            let uncomp = e.declaredSize ?? comp
            u32(0x0403_4B50, &out); u16(20, &out); u16(0, &out); u16(e.method, &out)
            u16(0, &out); u16(0, &out); u32(0, &out); u32(comp, &out); u32(uncomp, &out)
            u16(UInt16(name.count), &out); u16(0, &out); out.append(name); out.append(e.data)
            u32(0x0201_4B50, &central); u16(20, &central); u16(20, &central); u16(0, &central); u16(e.method, &central)
            u16(0, &central); u16(0, &central); u32(0, &central); u32(comp, &central); u32(uncomp, &central)
            u16(UInt16(name.count), &central); u16(0, &central); u16(0, &central); u16(0, &central); u16(0, &central)
            u32(0, &central); u32(offset, &central); central.append(name)
        }
        let cdOffset = UInt32(out.count)
        out.append(central)
        u32(0x0605_4B50, &out); u16(0, &out); u16(0, &out)
        u16(UInt16(entries.count), &out); u16(UInt16(entries.count), &out)
        u32(UInt32(central.count), &out); u32(cdOffset, &out); u16(0, &out)
        return out
    }
}
