import AppIntents
import Foundation

/// Opens a specific chat session in the LeoPhoneAgent app.
struct OpenSessionIntent: AppIntent {
    static var title: LocalizedStringResource = "Open Session"
    static var description = IntentDescription("Opens a LOBE chat session in the app.")
    static var openAppWhenRun = true
    static var authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication

    @Parameter(title: "Session")
    var session: SessionEntity

    @MainActor
    func perform() async throws -> some IntentResult {
        let sessionId = session.id
        // Cold launch: ContentView isn't subscribed yet, so buffer first.
        SessionLockStore.shared.runWhenUnlocked {
            NotificationNavigationStore.shared.setPending(sessionId)
            NotificationCenter.default.post(
                name: .openSessionFromIntent,
                object: nil,
                userInfo: ["sessionId": sessionId]
            )
        }
        return .result()
    }
}

extension Notification.Name {
    static let openSessionFromIntent = Notification.Name("openSessionFromIntent")
}
