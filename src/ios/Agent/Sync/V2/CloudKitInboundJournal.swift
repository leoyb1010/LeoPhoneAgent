import Foundation

/// A transport-owned inbox. CloudKit cursors may advance only after `append`
/// returns: both the portable payload and every temporary CKAsset are then
/// owned by this directory. Business ACK, not network completion, removes it.
/// Immutable pages retain failed entries; per-entry ACKs allow unrelated and
/// parent records to progress while preserving mutation order for each record ID.
final class CloudKitInboundJournal {
    struct Page: Codable, Equatable {
        let id: String
        let records: [PortableRecord]
        let deletes: [SyncRecordID]

        var batch: SyncInboundBatch {
            SyncInboundBatch(records: records, deletes: deletes, sourceDeviceId: nil,
                             inboundDeliveryID: id)
        }
    }

    /// One bounded work pass. A failure is attempted once until some other
    /// entry succeeds; no-progress and the hard attempt cap stop retry spins.
    /// The transport resets this only on an external fetch/start wake.
    struct DeliveryPass {
        private var attempted: Set<String> = []
        private var attempts = 0
        private var madeProgress = false
        private var exhausted = false
        let limit: Int
        init(limit: Int = 256) { self.limit = limit }
        mutating func begin() {
            // A capped pass resumes beyond already attempted entries. Clearing
            // them at every timer tick would starve a parent behind >limit
            // failed children forever. Only a complete no-progress sweep resets.
            if exhausted { attempted = []; madeProgress = false }
            attempts = 0
            exhausted = false
        }
        mutating func acknowledged() { madeProgress = true }
        mutating func claim(from journal: CloudKitInboundJournal) throws -> Page? {
            guard attempts < limit else { return nil }
            var page = try journal.claimFirst(excluding: attempted)
            if page == nil, madeProgress, !journal.hasActiveClaim {
                attempted = []; madeProgress = false
                page = try journal.claimFirst(excluding: attempted)
            }
            if let page { attempted.insert(page.id); attempts += 1; exhausted = false }
            else if !journal.hasActiveClaim { exhausted = true }
            return page
        }
    }

    // Reconfiguration can leave an old business merger alive while a new
    // transport opens the same account. Serialize index changes across those
    // instances, reload before mutation, and never give both the same page.
    private static let accessLock = NSRecursiveLock()
    nonisolated(unsafe) private static var claimed: [String: String] = [:]

    private struct Manifest: Codable {
        let version: Int
        let pageIDs: [String]
        // Optional for compatibility with inboxes written before per-entry ACK.
        let completed: [String: [Int]]?
    }

    enum JournalError: Error { case invalidManifest, missingAsset, unexpectedAcknowledgement }

    let directory: URL
    private let manifestURL: URL
    private let assetsURL: URL
    private var pageIDs: [String] = []
    private var cachedFirst: Page?
    private var completed: [String: Set<Int>] = [:]
    var pendingCount: Int { pageIDs.count }
    /// Fault injection at the real persistence boundary, also used by tests.
    private let write: (Data, URL) throws -> Void

    init(directory: URL, write: @escaping (Data, URL) throws -> Void = CloudKitInboundJournal.writeDurably) throws {
        self.directory = directory
        self.manifestURL = directory.appendingPathComponent("pending.json")
        self.assetsURL = directory.appendingPathComponent("assets", isDirectory: true)
        self.write = write
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
                                                attributes: [.posixPermissions: 0o700])
        try refresh()
    }

    private var leaseKey: String { directory.resolvingSymlinksInPath().path }

    private func refreshUnlocked() throws {
        // A corrupt/unreadable inbox is never treated as empty: a saved
        // CloudKit token may already depend on these durable pages.
        let data: Data
        do {
            data = try Data(contentsOf: manifestURL)
        } catch {
            let failure = error as NSError
            guard failure.domain == NSCocoaErrorDomain,
                  failure.code == CocoaError.fileReadNoSuchFile.rawValue else { throw error }
            pageIDs = []
            completed = [:]
            cachedFirst = nil
            return
        }
        let manifest = try JSONDecoder().decode(Manifest.self, from: data)
        guard manifest.version == 1, Set(manifest.pageIDs).count == manifest.pageIDs.count,
              manifest.pageIDs.allSatisfy({ UUID(uuidString: $0) != nil }) else {
            throw JournalError.invalidManifest
        }
        let done = manifest.completed ?? [:]
        guard Set(done.keys).isSubset(of: Set(manifest.pageIDs)),
              done.values.allSatisfy({ Set($0).count == $0.count && $0.allSatisfy { $0 >= 0 } }) else {
            throw JournalError.invalidManifest
        }
        pageIDs = manifest.pageIDs
        completed = done.mapValues { Set($0) }
        cachedFirst = try firstPending(in: pageIDs, completed: completed)
    }

    func refresh() throws {
        Self.accessLock.lock(); defer { Self.accessLock.unlock() }
        try refreshUnlocked()
    }

    func peek() throws -> Page? {
        Self.accessLock.lock(); defer { Self.accessLock.unlock() }
        try refreshUnlocked()
        return cachedFirst
    }

    /// Each pass excludes already attempted deliveries, not entire pages.
    /// An earlier pending mutation reserves its record ID even when excluded,
    /// so a failed upsert can never be overtaken by its delete or later update.
    func claimFirst(excluding attempted: Set<String> = []) throws -> Page? {
        Self.accessLock.lock(); defer { Self.accessLock.unlock() }
        try refreshUnlocked()
        guard Self.claimed[leaseKey] == nil else { return nil }
        var reserved: Set<SyncRecordID> = []
        for id in pageIDs {
            let page = try loadPage(id)
            try validateCompletion(for: page, completed: completed)
            for index in 0..<entryCount(page) where !(completed[id] ?? []).contains(index) {
                let delivery = entry(page, at: index)
                let key = delivery.records.first?.id ?? delivery.deletes[0]
                guard reserved.insert(key).inserted else { continue }
                guard !attempted.contains(delivery.id) else { continue }
                Self.claimed[leaseKey] = delivery.id
                return delivery
            }
        }
        return nil
    }

    func hasPendingMutation(for key: SyncRecordID) throws -> Bool {
        Self.accessLock.lock(); defer { Self.accessLock.unlock() }
        try refreshUnlocked()
        for id in pageIDs {
            let page = try loadPage(id)
            try validateCompletion(for: page, completed: completed)
            for index in 0..<entryCount(page) where !(completed[id] ?? []).contains(index) {
                let delivery = entry(page, at: index)
                if delivery.records.first?.id == key || delivery.deletes.first == key { return true }
            }
        }
        return false
    }

    var hasActiveClaim: Bool {
        Self.accessLock.lock(); defer { Self.accessLock.unlock() }
        return Self.claimed[leaseKey] != nil
    }

    /// Wire field names match SyncedTypes and the real domain foreign keys.
    /// Record-ID fetches bypass recent-query time windows without weakening ACK.
    static func dependency(for record: PortableRecord) -> SyncRecordID? {
        let type: String, field: String
        switch record.id.type {
        case "MessageV2", "CompactMarkerV2": type = "SessionV2"; field = "sessionId"
        case "ProviderModelEntryV3": type = "ProviderInstanceV3"; field = "providerInstanceId"
        default: return nil
        }
        guard case .string(let id) = record.fields[field], !id.isEmpty else { return nil }
        return SyncRecordID(type: type, id: id)
    }

    func release(_ id: String) {
        Self.accessLock.lock(); defer { Self.accessLock.unlock() }
        if Self.claimed[leaseKey] == id { Self.claimed[leaseKey] = nil }
    }

    var first: Page? { cachedFirst }

    @discardableResult
    func append(records: [PortableRecord], deletes: [SyncRecordID]) throws -> Page? {
        Self.accessLock.lock(); defer { Self.accessLock.unlock() }
        try refreshUnlocked()
        guard !records.isEmpty || !deletes.isEmpty else { return nil }
        let id = UUID().uuidString
        let assetDirectory = assetsURL.appendingPathComponent(id, isDirectory: true)
        do {
            var frozen: [PortableRecord] = []
            for record in records {
                var assets: [String: PortableAsset] = [:]
                for (key, asset) in record.assets {
                    try FileManager.default.createDirectory(at: assetDirectory, withIntermediateDirectories: true,
                                                            attributes: [.posixPermissions: 0o700])
                    let target = assetDirectory.appendingPathComponent(UUID().uuidString)
                    try FileManager.default.copyItem(at: asset.fileURL, to: target)
                    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: target.path)
                    try Self.validateAsset(target, expectedSize: asset.size)
                    let handle = try FileHandle(forWritingTo: target)
                    defer { try? handle.close() }
                    try handle.synchronize()
                    assets[key] = PortableAsset(key: asset.key, fileURL: target, size: asset.size, mimeType: asset.mimeType)
                }
                frozen.append(PortableRecord(id: record.id, fields: record.fields, assets: assets,
                    schemaVersion: record.schemaVersion, minimumCompatibleVersion: record.minimumCompatibleVersion,
                    unknownFields: record.unknownFields, updatedAt: record.updatedAt))
            }
            let page = Page(id: id, records: frozen, deletes: deletes)
            // Immutable pages keep the index small and memory bounded to the
            // current head. A large initial sync must not rewrite all payloads
            // or retain every not-yet-applied record on the main actor.
            try write(JSONEncoder().encode(page), pageURL(id))
            let next = pageIDs + [id]
            try persist(next, completed: completed)
            pageIDs = next
            if cachedFirst == nil { cachedFirst = entry(page, at: 0) }
            return page
        } catch {
            // A failed manifest write can be ambiguous (rename succeeded but
            // fsync failed). Keep the asset copies: the disk manifest may own
            // them. Orphans are harmless; deleting potentially owned data isn't.
            throw error
        }
    }

    /// Exact entry ACK is persisted before cleanup. A completed entry cannot
    /// be reapplied after restart; assets stay until every entry in its page is
    /// complete. Stale ACKs cannot consume an identical later delivery.
    @discardableResult
    func acknowledge(_ batch: SyncInboundBatch) throws -> Bool {
        Self.accessLock.lock(); defer { Self.accessLock.unlock() }
        try refreshUnlocked()
        guard let id = batch.inboundDeliveryID else { throw JournalError.unexpectedAcknowledgement }
        let parts = id.split(separator: ":", omittingEmptySubsequences: false)
        guard let rawPageID = parts.first, UUID(uuidString: String(rawPageID)) != nil,
              parts.count == 1 || parts.count == 2 else { throw JournalError.unexpectedAcknowledgement }
        let pageID = String(rawPageID)
        guard pageIDs.contains(pageID) else { return false }
        let page = try loadPage(pageID)
        let index = parts.count == 1 ? 0 : Int(parts[1]) ?? -1
        guard index >= 0, index < entryCount(page), entry(page, at: index).id == id else {
            throw JournalError.unexpectedAcknowledgement
        }
        if (completed[pageID] ?? []).contains(index) { return false }
        let delivery = entry(page, at: index)
        guard delivery.records == batch.records, delivery.deletes == batch.deletes,
              Self.claimed[leaseKey] == id || (Self.claimed[leaseKey] == nil && cachedFirst?.id == id) else {
            throw JournalError.unexpectedAcknowledgement
        }
        var done = completed
        done[pageID, default: []].insert(index)
        var next = pageIDs
        let finishedPage = done[pageID]!.count == entryCount(page)
        if finishedPage { next.removeAll { $0 == pageID }; done[pageID] = nil }
        let nextHead = try firstPending(in: next, completed: done)
        try persist(next, completed: done)
        pageIDs = next
        completed = done
        cachedFirst = nextHead
        release(id)
        if finishedPage {
            // A failed cleanup leaves unreachable copies, never another
            // delivery's assets. The manifest commit already owns the ACK.
            try? FileManager.default.removeItem(at: assetsURL.appendingPathComponent(pageID, isDirectory: true))
            try? FileManager.default.removeItem(at: pageURL(pageID))
        }
        return true
    }

    private func entryCount(_ page: Page) -> Int { page.records.count + page.deletes.count }

    private func entry(_ page: Page, at index: Int) -> Page {
        let id = entryCount(page) == 1 ? page.id : page.id + ":" + String(index)
        return index < page.records.count
            ? Page(id: id, records: [page.records[index]], deletes: [])
            : Page(id: id, records: [], deletes: [page.deletes[index - page.records.count]])
    }

    private func validateCompletion(for page: Page, completed: [String: Set<Int>]) throws {
        let done = completed[page.id] ?? []
        guard entryCount(page) > 0, done.count < entryCount(page),
              done.allSatisfy({ $0 >= 0 && $0 < entryCount(page) }) else { throw JournalError.invalidManifest }
    }

    private func firstPending(in ids: [String], completed: [String: Set<Int>]) throws -> Page? {
        guard let id = ids.first else { return nil }
        let page = try loadPage(id)
        try validateCompletion(for: page, completed: completed)
        let index = (0..<entryCount(page)).first { !(completed[id] ?? []).contains($0) }!
        return entry(page, at: index)
    }

    private func persist(_ pageIDs: [String], completed: [String: Set<Int>]) throws {
        try write(JSONEncoder().encode(Manifest(version: 1, pageIDs: pageIDs,
            completed: completed.mapValues { $0.sorted() })), manifestURL)
    }

    private func pageURL(_ id: String) -> URL { directory.appendingPathComponent(id + ".json") }

    private func loadPage(_ id: String) throws -> Page {
        let page = try JSONDecoder().decode(Page.self, from: Data(contentsOf: pageURL(id)))
        guard page.id == id else { throw JournalError.invalidManifest }
        return try rebased(page)
    }

    /// Rebase only journal-generated UUID filenames. iOS container roots can
    /// move across restore; persisted absolute CKAsset URLs must not escape
    /// the current journal or continue referring to the previous container.
    private func rebased(_ page: Page) throws -> Page {
        let root = assetsURL.appendingPathComponent(page.id, isDirectory: true)
        let records = try page.records.map { record in
            var assets: [String: PortableAsset] = [:]
            for (key, asset) in record.assets {
                let name = asset.fileURL.lastPathComponent
                guard UUID(uuidString: name) != nil else { throw JournalError.invalidManifest }
                let url = root.appendingPathComponent(name)
                guard url.resolvingSymlinksInPath().deletingLastPathComponent().path == root.resolvingSymlinksInPath().path else {
                    throw JournalError.invalidManifest
                }
                try Self.validateAsset(url, expectedSize: asset.size)
                assets[key] = PortableAsset(key: asset.key, fileURL: url, size: asset.size, mimeType: asset.mimeType)
            }
            return PortableRecord(id: record.id, fields: record.fields, assets: assets,
                schemaVersion: record.schemaVersion, minimumCompatibleVersion: record.minimumCompatibleVersion,
                unknownFields: record.unknownFields, updatedAt: record.updatedAt)
        }
        return Page(id: page.id, records: records, deletes: page.deletes)
    }

    private static func validateAsset(_ url: URL, expectedSize: Int) throws {
        let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
        guard expectedSize >= 0, attributes[.type] as? FileAttributeType == .typeRegular,
              (attributes[.size] as? NSNumber)?.intValue == expectedSize else {
            throw JournalError.missingAsset
        }
    }

    static func writeDurably(_ data: Data, to url: URL) throws {
        try data.write(to: url, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
        let handle = try FileHandle(forWritingTo: url)
        defer { try? handle.close() }
        try handle.synchronize()
    }
}
