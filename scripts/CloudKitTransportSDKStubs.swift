import Foundation

// Compile-only app boundaries for CloudKitTransportSDKTypecheck.sh.
// No CloudKit/transport/record/registry API is stubbed. These declarations
// mirror only the app singleton members consumed by the actual transport.
// This fixture is never linked into the app and must never be run as a sync test.
struct AppLogger {
    init(category: String) {}
    func debug(_ message: @autoclosure () -> String) {}
    func info(_ message: String) {}
    func warning(_ message: String) {}
    func error(_ message: String) {}
}

final class ProviderConfigDB {}

@MainActor
final class ProviderConfigStore {
    static let shared = ProviderConfigStore()
    private(set) var db: ProviderConfigDB?
}

actor ChatStore {
    static let shared = ChatStore()
    func markRecordsPushed(_ recordNames: [String]) {}
}
