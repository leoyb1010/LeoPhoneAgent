import AppIntents
import CoreSpotlight
import Foundation

/// Wraps a ChatSession as an AppEntity so Shortcuts can reference sessions by name.
/// [F2-indexed-entity] Also an IndexedEntity: the Spotlight items the indexer
/// writes are associated with this entity, so Spotlight and Shortcuts resolve a
/// found conversation to the same entity the session actions take.
struct SessionEntity: AppEntity, IndexedEntity {
    static var typeDisplayRepresentation = TypeDisplayRepresentation(name: "New Session")
    static var defaultQuery = SessionEntityQuery()

    var id: String
    var displayName: String
    var modelId: String

    var displayRepresentation: DisplayRepresentation {
        DisplayRepresentation(title: "\(displayName)")
    }

    /// Title only — never message bodies (same rule as SessionSpotlightIndexer).
    var attributeSet: CSSearchableItemAttributeSet {
        let attributes = CSSearchableItemAttributeSet(contentType: .content)
        attributes.title = displayName
        attributes.keywords = ["LeoBot", "Agent", "chat"]
        return attributes
    }

    init(id: String, displayName: String, modelId: String) {
        self.id = id
        self.displayName = displayName
        self.modelId = modelId
    }

    init(from session: ChatSession) {
        self.id = session.id
        self.displayName = session.title ?? "Untitled"
        self.modelId = session.modelId
    }
}

struct SessionEntityQuery: EntityQuery {
    func entities(for identifiers: [String]) async throws -> [SessionEntity] {
        var results: [SessionEntity] = []
        // Face ID–locked sessions are invisible to Shortcuts/Siri: they can
        // neither be listed nor resolved from a saved shortcut.
        for id in identifiers where !SessionLockStore.isHiddenFromSystemSurfaces(id) {
            if let session = await ChatStore.shared.getSession(id) {
                results.append(SessionEntity(from: session))
            }
        }
        return results
    }

    func suggestedEntities() async throws -> [SessionEntity] {
        let sessions = await ChatStore.shared.listSessions()
        return sessions.lazy
            .filter { !SessionLockStore.isHiddenFromSystemSurfaces($0.id) }
            .prefix(100)
            .map { SessionEntity(from: $0) }
    }
}

enum SessionLockedIntentError: Error, CustomLocalizedStringResourceConvertible {
    case locked

    var localizedStringResource: LocalizedStringResource {
        "这个会话已用 Face ID 锁定，请在 App 里打开查看。"
    }
}
