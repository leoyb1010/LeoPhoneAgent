import Foundation
import Security
import os.log

private let logger = AppLogger(category: "EnvVarStore")

// MARK: - EnvVarEntry

struct EnvVarEntry: Identifiable, Codable {
    let id: String
    var key: String
    var createdAt: Date
    /// Optional human-readable description of what this variable is for. Empty
    /// string when omitted. Stored in the JSON metadata file; not secret.
    var note: String

    init(id: String = UUID().uuidString, key: String, createdAt: Date = Date(), note: String = "") {
        self.id = id
        self.key = key
        self.createdAt = createdAt
        self.note = note
    }

    // Custom decoder so older entries without a `note` field still load.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.id = try c.decode(String.self, forKey: .id)
        self.key = try c.decode(String.self, forKey: .key)
        self.createdAt = try c.decode(Date.self, forKey: .createdAt)
        self.note = (try? c.decode(String.self, forKey: .note)) ?? ""
    }
}

// MARK: - EnvVarStore

@MainActor
final class EnvVarStore: ObservableObject {
    static let shared = EnvVarStore()

    @Published private(set) var entries: [EnvVarEntry] = []

    private let fileURL: URL
    nonisolated private static let keychainService = "com.leoyuan.leophoneagent.envvar"

    init() {
        let libraryURL = FileManager.default.urls(for: .libraryDirectory, in: .userDomainMask).first!
        let baseURL = libraryURL.appendingPathComponent("MinisChat", isDirectory: true)
        try? FileManager.default.createDirectory(at: baseURL, withIntermediateDirectories: true)
        self.fileURL = baseURL.appendingPathComponent("env-vars.json")
        self.entries = Self.loadEntries(from: fileURL)
        scheduleLegacyRecordCleanupIfNeeded()
    }

    // MARK: - Legacy whole-file record cleanup

    private static let legacyCleanupKey = "cloudSync.envVar.legacyV2RecordDeleted"

    /// One-time job that removes the old EnvVarV2 whole-file record
    /// from this device's cloud zone after the first per-variable
    /// EnvVarItem push round. Without this, the legacy record stays
    /// on iCloud forever, taking storage and confusing other devices'
    /// inbound merger.
    ///
    /// Sequencing:
    ///   1. Re-mark every local entry dirty as EnvVarItem (idempotent —
    ///      no-op if cloud already has them).
    ///   2. Queue an op=delete dirty row for EnvVarV2 (recordId
    ///      "env-vars"). SyncCore.sendNow drains the EnvVarItem
    ///      upserts in the same batch as the EnvVarV2 delete; CloudKit
    ///      orders the upserts before the delete by record id, so the
    ///      new schema is in cloud before the old record disappears.
    ///   3. Persist `legacyCleanupKey = true` so subsequent launches
    ///      skip this work.
    private func scheduleLegacyRecordCleanupIfNeeded() {
        guard !UserDefaults.standard.bool(forKey: Self.legacyCleanupKey) else { return }
        // Defer past actor init to avoid touching ChatStore before its
        // SyncCore wiring has completed (ChatStore actor is also being
        // brought up around the same time on app launch).
        Task { [weak self] in
            try? await Task.sleep(nanoseconds: 5_000_000_000) // 5s
            guard let self else { return }
            await MainActor.run {
                self.markAllEntriesDirty()
                Task { await ChatStore.shared.markDirty(
                    recordType: "EnvVar",
                    recordId: "env-vars",
                    operation: "delete"
                ) }
                UserDefaults.standard.set(true, forKey: Self.legacyCleanupKey)
                logger.info("[EnvVarStore] legacy EnvVarV2 cleanup scheduled (\(self.entries.count) entries re-emitted as EnvVarItem)")
            }
        }
    }

    // MARK: - Persistence (key list)

    private static func loadEntries(from url: URL) -> [EnvVarEntry] {
        guard let data = try? Data(contentsOf: url),
              let entries = try? JSONDecoder().decode([EnvVarEntry].self, from: data) else {
            return []
        }
        return entries
    }

    /// Reload entries from disk (e.g. after iCloud sync merges new data).
    func reloadFromDisk() {
        entries = Self.loadEntries(from: fileURL)
    }

    @discardableResult
    private func saveEntries() -> Bool {
        do {
            let data = try JSONEncoder().encode(entries)
            try data.write(to: fileURL, options: .atomic)
        } catch {
            logger.error("Failed to save env var entries: \(error)")
            return false
        }
        // v2 sync uses per-variable EnvVarItem records. Per-key markDirty
        // is issued by the call sites that actually mutate a specific
        // entry (add / update / delete / updateNote). Bulk re-emit when
        // we don't know which key changed (e.g. file rewritten via
        // SyncDirtyScanner) is handled by markAllEntriesDirty.
        //
        // Legacy EnvVar (whole-file) markDirty is no longer issued —
        // SyncedEnvVars builder returns nil, so any leftover dirty rows
        // get drained as no-ops.
        return true
    }

    /// Mark a single variable's per-key sync record as dirty. Caller
    /// passes the entry's UUID (EnvVarEntry.id), which is also the
    /// EnvVarItem record's recordName.
    fileprivate func markEntryDirty(entryId: String, operation: String = "upsert") {
        Task { await ChatStore.shared.markDirty(
            recordType: "EnvVarItem",
            recordId: entryId,
            operation: operation
        ) }
    }

    /// Re-emit per-key markDirty for every current entry. Used by
    /// markAllLocalForReupload and any post-restore path that doesn't
    /// know which keys changed.
    func markAllEntriesDirty() {
        for entry in entries {
            markEntryDirty(entryId: entry.id, operation: "upsert")
        }
    }

    // MARK: - Keychain (values)

    /// Persist a value under `key` in the synchronizable Keychain.
    ///
    /// Previously this did delete-then-add unconditionally. That had a
    /// data-loss window: if the two SecItemDelete calls didn't fully remove
    /// the prior synchronizable item (iCloud Keychain replication lag), the
    /// following SecItemAdd returned errSecDuplicateItem — the old value was
    /// already deleted and the new value never landed, so the variable read
    /// back EMPTY. That is the intermittent "saved a value but it comes back
    /// blank" the user hit (e.g. WEBDAV_USER).
    ///
    /// Now: update-in-place first; only add when the item genuinely doesn't
    /// exist; and on a duplicate race, fall back to update. The prior value is
    /// never deleted before the new one is committed, so a failed write leaves
    /// the old value intact instead of blanking it. Returns whether the value
    /// is now persisted.
    @discardableResult
    nonisolated private static func saveValue(_ value: String, forKey key: String) -> Bool {
        let syncMatch: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecAttrAccount as String: key,
            kSecAttrSynchronizable as String: true,
        ]
        let attrs: [String: Any] = [
            kSecValueData as String: Data(value.utf8),
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlock,
        ]

        // Remove any legacy NON-synchronizable item for this key so reads
        // (which prefer the sync item) don't shadow it — but do this only
        // after we know the sync write will be attempted, and never let its
        // result blank the value.
        func dropLegacyNonSyncItem() {
            var legacy = syncMatch
            legacy[kSecAttrSynchronizable as String] = false
            SecItemDelete(legacy as CFDictionary)
        }

        var status = SecItemUpdate(syncMatch as CFDictionary, attrs as CFDictionary)
        if status == errSecItemNotFound {
            var addQuery = syncMatch
            addQuery.merge(attrs) { _, new in new }
            status = SecItemAdd(addQuery as CFDictionary, nil)
            // Lost a race: the item appeared between our update and add
            // (replication or a concurrent write). Update it instead of
            // failing — this is the exact case that used to blank the value.
            if status == errSecDuplicateItem {
                status = SecItemUpdate(syncMatch as CFDictionary, attrs as CFDictionary)
            }
        }

        if status == errSecSuccess {
            dropLegacyNonSyncItem()
            return true
        }
        logger.error("Keychain save failed for \(key): OSStatus \(status) — prior value left intact")
        return false
    }

    nonisolated private static func loadValue(forKey key: String) -> String? {
        // Try synchronizable first
        let syncQuery: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecAttrAccount as String: key,
            kSecAttrSynchronizable as String: true,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var result: AnyObject?
        if SecItemCopyMatching(syncQuery as CFDictionary, &result) == errSecSuccess,
           let data = result as? Data { return String(data: data, encoding: .utf8) }
        // Fallback to legacy non-sync
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecAttrAccount as String: key,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    /// A rollback snapshot must distinguish a genuinely absent secret from a
    /// locked/unreadable Keychain item. Only "not found" permits legacy fallback.
    nonisolated private static func readValueForMutation(forKey key: String) -> Result<String?, MutationError> {
        for synchronizable in [true, false] {
            let query: [String: Any] = [
                kSecClass as String: kSecClassGenericPassword,
                kSecAttrService as String: keychainService,
                kSecAttrAccount as String: key,
                kSecAttrSynchronizable as String: synchronizable,
                kSecReturnData as String: true,
                kSecMatchLimit as String: kSecMatchLimitOne,
            ]
            var result: AnyObject?
            let status = SecItemCopyMatching(query as CFDictionary, &result)
            if status == errSecItemNotFound { continue }
            guard status == errSecSuccess, let data = result as? Data,
                  let value = String(data: data, encoding: .utf8) else {
                return .failure(.keychainReadFailed)
            }
            return .success(value)
        }
        return .success(nil)
    }

    @discardableResult
    nonisolated private static func deleteValue(forKey key: String) -> Bool {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecAttrAccount as String: key,
        ]
        let local = SecItemDelete(query as CFDictionary)
        var syncQuery = query
        syncQuery[kSecAttrSynchronizable as String] = true
        let synced = SecItemDelete(syncQuery as CFDictionary)
        return [errSecSuccess, errSecItemNotFound].contains(local) && [errSecSuccess, errSecItemNotFound].contains(synced)
    }

    /// Non-isolated read for use from CloudSyncEngine (background thread).
    nonisolated static func loadValueSync(forKey key: String) -> String? {
        loadValue(forKey: key)
    }

    /// Non-isolated write for use from CloudSyncEngine (background thread).
    nonisolated static func saveValueSync(_ value: String, forKey key: String) {
        saveValue(value, forKey: key)
    }

    // MARK: - Validation

    /// Valid env var name: starts with a letter, contains only letters, digits, and underscores.
    static let keyRegex = /^[A-Za-z][A-Za-z0-9_]*$/

    static func isValidKey(_ key: String) -> Bool {
        key.wholeMatch(of: keyRegex) != nil
    }

    // MARK: - Value Sanitization

    /// Strip invisible/control characters that iOS paste can introduce (e.g. \u{9b} CSI).
    /// Keeps only printable ASCII and common whitespace (space, tab).
    private static func sanitizeValue(_ value: String) -> String {
        String(value.unicodeScalars.filter { scalar in
            // Allow printable ASCII (0x20-0x7E) and tab (0x09)
            (scalar.value >= 0x20 && scalar.value <= 0x7E) || scalar.value == 0x09
        })
    }

    // MARK: - Public API

    enum MutationError: LocalizedError {
        case invalidKey, duplicateKey, missingEntry, keychainWriteFailed, metadataWriteFailed
        case keychainReadFailed, valueChangedMetadataWriteFailed

        var errorDescription: String? {
            switch self {
            case .invalidKey: return String(localized: "Enter a valid variable name.")
            case .duplicateKey: return String(localized: "A variable with this name already exists. Choose another name.")
            case .missingEntry: return String(localized: "This variable no longer exists. Your changes have not been saved.")
            case .keychainWriteFailed: return String(localized: "Couldn't save the value to Keychain. Your changes are still here; try again.")
            case .metadataWriteFailed: return String(localized: "Couldn't save the variable. Check available storage and try again.")
            case .keychainReadFailed: return String(localized: "Couldn't read the previous value from Keychain. Nothing was changed. Try again.")
            case .valueChangedMetadataWriteFailed: return String(localized: "The value changed, but its note could not be saved. The previous value could not be restored. Try saving again.")
            }
        }
    }

    @discardableResult
    func add(key: String, value: String, note: String = "") -> Result<Void, MutationError> {
        let trimmedKey = key.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
        guard !trimmedKey.isEmpty, Self.isValidKey(trimmedKey) else { return .failure(.invalidKey) }
        guard !entries.contains(where: { $0.key == trimmedKey }) else { return .failure(.duplicateKey) }
        guard Self.saveValue(Self.sanitizeValue(value), forKey: trimmedKey) else {
            return .failure(.keychainWriteFailed)
        }
        let entry = EnvVarEntry(key: trimmedKey, note: note)
        entries.append(entry)
        guard saveEntries() else {
            entries.removeAll { $0.id == entry.id }
            return .failure(.metadataWriteFailed)
        }
        markEntryDirty(entryId: entry.id, operation: "upsert")
        return .success(())
    }

    /// Commit a rename before retiring the old secret. For a same-key edit,
    /// restore the secret if metadata fails; report an explicit partial outcome
    /// if that compensation also fails so the editor cannot claim full rollback.
    @discardableResult
    func update(id: String, key: String, value: String, note: String? = nil) -> Result<Void, MutationError> {
        guard let idx = entries.firstIndex(where: { $0.id == id }) else { return .failure(.missingEntry) }
        let original = entries[idx]
        let oldKey = original.key
        let trimmedKey = key.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
        guard !trimmedKey.isEmpty, Self.isValidKey(trimmedKey) else { return .failure(.invalidKey) }
        guard !entries.contains(where: { $0.key == trimmedKey && $0.id != id }) else {
            return .failure(.duplicateKey)
        }
        var previousValue: String?
        if oldKey == trimmedKey {
            switch Self.readValueForMutation(forKey: oldKey) {
            case .success(let saved): previousValue = saved
            case .failure(let error): return .failure(error)
            }
        }
        guard Self.saveValue(Self.sanitizeValue(value), forKey: trimmedKey) else {
            return .failure(.keychainWriteFailed)
        }
        entries[idx].key = trimmedKey
        if let note { entries[idx].note = note }
        guard saveEntries() else {
            entries[idx] = original
            if oldKey == trimmedKey {
                let restored = previousValue.map { Self.saveValue($0, forKey: oldKey) }
                    ?? Self.deleteValue(forKey: oldKey)
                guard restored else {
                    // The live secret changed even though the metadata stayed old.
                    // Report that partial outcome and let sync see the actual value.
                    markEntryDirty(entryId: id, operation: "upsert")
                    return .failure(.valueChangedMetadataWriteFailed)
                }
            }
            return .failure(.metadataWriteFailed)
        }
        if oldKey != trimmedKey, !entries.contains(where: { $0.key == oldKey }) {
            _ = Self.deleteValue(forKey: oldKey)
        }
        markEntryDirty(entryId: id, operation: "upsert")
        return .success(())
    }

    /// Update only the human-readable note without touching the
    /// Keychain-stored value. Used by minis-config so the agent can
    /// annotate variables without ever seeing or overwriting the
    /// secret.
    func updateNote(id: String, note: String) {
        guard let idx = entries.firstIndex(where: { $0.id == id }) else { return }
        entries[idx].note = note
        saveEntries()
        markEntryDirty(entryId: id, operation: "upsert")
    }

    func delete(id: String) {
        guard let idx = entries.firstIndex(where: { $0.id == id }) else { return }
        let key = entries[idx].key
        entries.remove(at: idx)
        Self.deleteValue(forKey: key)
        saveEntries()
        // Mark the entry's per-key record for cloud deletion. Peers will
        // hard-delete it via applyEnvVarItemDeletion. The recordId is the
        // entry UUID, not the key — same as upsert path.
        markEntryDirty(entryId: id, operation: "delete")
        logger.info("Deleted env var: \(key)")
    }

    func value(forKey key: String) -> String? {
        Self.loadValue(forKey: key)
    }

    func entry(id: String) -> EnvVarEntry? {
        entries.first(where: { $0.id == id })
    }

    // MARK: - Sync inbound (per-variable)

    /// Apply an inbound EnvVarItem. Lookup by id; if a local entry with
    /// the same id exists, LWW-by-updatedAt decides the winner. If no
    /// local entry exists by id but another one with the same key
    /// exists (created independently on two devices before they ever
    /// synced), keep both — they have distinct UUIDs and the user can
    /// reconcile manually.
    ///
    /// `value` is empty when the sender sent an empty/missing valueB64
    /// (e.g. legacy build that didn't fill it). In that case we leave
    /// the local Keychain value untouched rather than wiping it.
    func applyRemoteItem(
        id: String, key: String, value: String, note: String,
        createdAt: Date, updatedAt: Date
    ) throws {
        var next = entries
        let existing = next.first(where: { $0.id == id })
        let valueToStore = !value.isEmpty ? value : (existing.flatMap { Self.loadValue(forKey: $0.key) } ?? "")
        if !valueToStore.isEmpty, !Self.saveValue(valueToStore, forKey: key) { throw CocoaError(.fileWriteUnknown) }
        if let index = next.firstIndex(where: { $0.id == id }) {
            next[index].key = key
            next[index].note = note
            next[index].createdAt = min(next[index].createdAt, createdAt)
        } else { next.append(EnvVarEntry(id: id, key: key, createdAt: createdAt, note: note)) }
        try JSONEncoder().encode(next).write(to: fileURL, options: .atomic)
        entries = next
        // Shared keys can be used by more than one entry. Do not delete another
        // entry's secret after a rename, or before metadata commits.
        if let existing, existing.key != key, !next.contains(where: { $0.key == existing.key }) {
            guard Self.deleteValue(forKey: existing.key) else { throw CocoaError(.fileWriteUnknown) }
        }
        _ = updatedAt
    }

    /// Hard-delete a per-variable entry locally without re-queueing the
    /// delete back into the sync layer. Mirrors the SessionV2 inbound
    /// delete pattern. Caller is the sync hydrator; the cloud already
    /// holds the tombstone.
    func applyRemoteDeletion(id: String) throws {
        guard let existing = entries.first(where: { $0.id == id }) else { return }
        let next = entries.filter { $0.id != id }
        if !next.contains(where: { $0.key == existing.key }), !Self.deleteValue(forKey: existing.key) {
            throw CocoaError(.fileWriteUnknown)
        }
        try JSONEncoder().encode(next).write(to: fileURL, options: .atomic)
        entries = next
    }

    /// Returns all env vars as a dictionary for injection into shell execution.
    nonisolated func allAsDict() -> [String: String] {
        var dict: [String: String] = [:]
        // Read entries from the JSON file directly (avoid MainActor requirement)
        let libraryURL = FileManager.default.urls(for: .libraryDirectory, in: .userDomainMask).first!
        let fileURL = libraryURL.appendingPathComponent("MinisChat/env-vars.json")
        guard let data = try? Data(contentsOf: fileURL),
              let entries = try? JSONDecoder().decode([EnvVarEntry].self, from: data) else {
            return dict
        }
        for entry in entries {
            if let val = Self.loadValue(forKey: entry.key) {
                dict[entry.key] = val
            }
        }
        return dict
    }
}
