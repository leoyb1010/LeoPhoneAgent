//
//  SessionSpotlightIndexer.swift
//  MinisApp
//
//  [T-spotlight-sessions] Puts chat sessions into system search.
//
//  The app already models sessions as an `AppEntity` for Shortcuts and Siri,
//  but nothing was ever indexed, so "that conversation last week where I looked
//  up flights" could only be found by scrolling the sidebar. Sessions are the
//  app's primary content; Spotlight is where iOS users look for content.
//
//  Only the title and a short snippet are indexed — never message bodies. The
//  index lives on-device and is dropped when the session is deleted or when the
//  user turns the feature off.
//

import CoreSpotlight
import Foundation
import UniformTypeIdentifiers

private let logger = AppLogger(category: "Spotlight")

@MainActor
enum SessionSpotlightIndexer {
    static let enabledDefaultsKey = "leo.spotlightSessionsEnabled"
    /// Same domain for every session so a single call can clear them all.
    private static let domain = "com.leoyuan.leophoneagent.sessions"

    static var isEnabled: Bool {
        (UserDefaults.standard.object(forKey: enabledDefaultsKey) as? Bool) ?? true
    }

    static func setEnabled(_ enabled: Bool) {
        UserDefaults.standard.set(enabled, forKey: enabledDefaultsKey)
        if enabled {
            Task { await reindexAll() }
        } else {
            deleteAll()
        }
    }

    /// Index (or refresh) one session. Cheap enough to call whenever a title
    /// changes; CoreSpotlight coalesces.
    static func index(session: ChatSession) {
        guard isEnabled else { return }
        let attributes = CSSearchableItemAttributeSet(contentType: .content)
        attributes.title = session.title?.isEmpty == false
            ? session.title
            : String(localized: "New Chat")
        attributes.contentDescription = String(localized: "LeoPhoneAgent conversation")
        attributes.contentModificationDate = session.updatedAt
        attributes.keywords = ["LeoPhoneAgent", "Agent", "chat"]

        let item = CSSearchableItem(
            uniqueIdentifier: session.id,
            domainIdentifier: domain,
            attributeSet: attributes
        )
        CSSearchableIndex.default().indexSearchableItems([item]) { error in
            if let error {
                logger.error("[Spotlight] index failed: \(error.localizedDescription)")
            }
        }
    }

    static func remove(sessionId: String) {
        CSSearchableIndex.default().deleteSearchableItems(withIdentifiers: [sessionId]) { error in
            if let error {
                logger.error("[Spotlight] delete failed: \(error.localizedDescription)")
            }
        }
    }

    static func deleteAll() {
        CSSearchableIndex.default().deleteSearchableItems(withDomainIdentifiers: [domain]) { _ in }
    }

    /// Full rebuild. Runs on foreground so renames, deletions on another device
    /// and sessions created while indexing was off all converge.
    static func reindexAll(limit: Int = 300) async {
        guard isEnabled else { return }
        let sessions = await ChatStore.shared.listSessions()
        let items = sessions.prefix(limit).map { session -> CSSearchableItem in
            let attributes = CSSearchableItemAttributeSet(contentType: .content)
            attributes.title = session.title?.isEmpty == false
                ? session.title
                : String(localized: "New Chat")
            attributes.contentDescription = String(localized: "LeoPhoneAgent conversation")
            attributes.contentModificationDate = session.updatedAt
            attributes.keywords = ["LeoPhoneAgent", "Agent", "chat"]
            return CSSearchableItem(
                uniqueIdentifier: session.id,
                domainIdentifier: domain,
                attributeSet: attributes
            )
        }
        // Replace the whole domain so sessions deleted elsewhere disappear.
        CSSearchableIndex.default().deleteSearchableItems(withDomainIdentifiers: [domain]) { _ in
            CSSearchableIndex.default().indexSearchableItems(items) { error in
                if let error {
                    logger.error("[Spotlight] reindex failed: \(error.localizedDescription)")
                } else {
                    logger.info("[Spotlight] indexed \(items.count) session(s)")
                }
            }
        }
    }
}
