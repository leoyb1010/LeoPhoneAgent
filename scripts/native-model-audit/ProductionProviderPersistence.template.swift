// Test target only: exact production method bodies are inserted by generate.py.
// This isolates file/SQLite persistence from app startup, network and keychain.
import Foundation
import Combine

private let logger = AppLogger(category: "ProductionProviderPersistenceTests")

@MainActor
final class ProductionProviderPersistence {
    let objectWillChange = ObservableObjectPublisher()
    var config: ProviderConfig
    let fileURL: URL
    var db: ProviderConfigDB?
    private var lastSavedSnapshot: ProviderConfig?
    private var jsonLoadFailed = false
    private var persistenceReady: Bool
    private(set) var configRevision: UInt = 0
    private(set) var legacyUuidToCompositeKey: [String: String] = [:]
    private let databaseWrites = ModelCatalogWriteQueue()
    private var modelArchiveURL: URL { fileURL.appendingPathExtension("model-archive") }

    init(fileURL: URL, initial: ProviderConfig? = nil, db: ProviderConfigDB? = nil,
         persistenceReady: Bool = true) {
        self.fileURL = fileURL
        self.db = db
        self.persistenceReady = persistenceReady
        let loaded = Self.load(from: fileURL)
        self.config = initial ?? loaded.config
        self.jsonLoadFailed = loaded.failed
        self.lastSavedSnapshot = self.config
        loadModelArchiveAliases()
    }

    func stage(_ snapshot: ProviderConfig) -> Bool {
        config = snapshot
        return save()
    }

    // Test only the production metadata transaction, with no credential input.
    func importMetadata(_ instance: ProviderInstance, entries: [ModelEntry]) -> Bool {
        commitImportedMetadata(instance, entries: entries)
    }

    func drainWrites() async { await databaseWrites.drain() }
    func holdWrites(_ operation: @escaping @MainActor () async -> Void) {
        databaseWrites.enqueue(operation)
    }
    func recoverPendingSnapshot() async -> Bool {
        guard let db else { return false }
        return await recoverPendingDatabaseSnapshot(db)
    }

    // The lookup adapter handles only stored fixture entries. System voice is
    // exercised separately by the native picker suite, not this persistence seam.
    func normalizeEntryRef(_ reference: String) -> String {
        config.modelEntries.first {
            $0.id == reference || $0.uuid == reference || $0.legacyColonCompositeKey == reference
        }?.id ?? legacyUuidToCompositeKey[reference] ?? reference
    }

    // No external compact-slot preference changes in the isolated save tests.
    private enum AgentModelSlots {
        static func forget(entryIds: Set<String>) {}
    }

    // Bootstrap authority is unrelated to the JSON-only reload regression.
    // Tests exercise reload with db == nil; keep the DB branch compilable.
    private enum ProviderV3Bootstrap {
        static let isEnabled = true
    }

    // INSERT_PRODUCTION_METHODS
}
