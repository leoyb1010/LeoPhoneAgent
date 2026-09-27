import AppIntents
import Foundation

/// Lists chat sessions as entities so Shortcuts can pass a selected session
/// directly into follow-up LeoPhoneAgent actions.
struct ListSessionsIntent: AppIntent {
    static var title: LocalizedStringResource = "List Sessions"
    static var description = IntentDescription("Lists all LeoPhoneAgent chat sessions with their titles and IDs.")
    static var openAppWhenRun = false
    static var authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication

    func perform() async throws -> some IntentResult & ReturnsValue<[SessionEntity]> {
        let sessions = await ChatStore.shared.listSessions()
        return .result(value: sessions
            .filter { !SessionLockStore.isHiddenFromSystemSurfaces($0.id) }
            .map(SessionEntity.init(from:)))
    }
}
