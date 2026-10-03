// Test target only. No production keychain, network, CloudKit, speech, or chat IO.
import SwiftUI
import AVFoundation

struct AppLogger {
    init(category: String) {}
    func info(_ message: String) {}
    func warning(_ message: String) {}
    func error(_ message: String) {}
}

enum SharedContainerStore { static var sharedDefaults: UserDefaults? { .standard } }
enum ModelsDevAPI { static func enrichModel(_ model: LLMModel) -> LLMModel { model } }
enum CodexReasoningCeiling { static func level(for id: String) -> ThinkingLevel? { nil } }
enum XAIModelsAPI { static var allModels: [LLMModel] { [] } }
enum KimiModelsAPI { static var allModels: [LLMModel] { [] } }
enum OpenCodeGo { static var fallbackModels: [LLMModel] { [] } }
struct CodexTokenStorage: Codable {}
struct KimiTokenStorage: Codable {}
enum XAICredentialSource {
    case none
    static func resolve(instanceId: String) -> XAICredentialSource { .none }
}
// Synthetic sentinel is returned only inside this isolated test process.
// It is not a usable secret and never enters a network request.
enum ProviderKeychainHelper {
    static func loadAPIKey(instanceId: String, caller: String = "") -> String? {
        instanceId == "missing-auth" ? nil : "SYNTHETIC-NOT-A-CREDENTIAL"
    }
    static func loadOAuthString(instanceId: String, account: String, caller: String = "") -> String? { nil }
    static func loadOAuthToken<T: Decodable>(instanceId: String, as type: T.Type, caller: String = "") -> T? { nil }
}
@MainActor final class ChatStore {
    static let shared = ChatStore()
    func updateSessionModelId(_ sessionId: String, modelId: String) async {}
}
extension Notification.Name { static let sessionModelBindingChanged = Notification.Name("audit.sessionModelBindingChanged") }
enum LeoHaptics { static func selection() {} }
enum MinisToast { static func show(_ message: String) {} }
enum ForceSyncHelper {
    static func markProvidersDirty() async -> Bool { false }
    static func bidirectionalSync(recordTypes: [String]) async {}
}
@MainActor final class SystemVoiceRoster: ObservableObject { static let shared = SystemVoiceRoster() }
@MainActor enum SystemVoiceCatalog {
    static func ttsModels() -> [LLMModel] { [] }
    static func startObservingVoiceChanges() {}
    static func displayName(for voice: AVSpeechSynthesisVoice) -> String { voice.name }
}
enum SystemVoiceProvider {
    static let builtinProviderId = "__builtin_system_speech__"
    static let providerInstance = ProviderInstance(id: builtinProviderId, label: "System", providerType: .openAI, credentialType: .apiKey)
}
enum SystemSpeechPreferences { static let autoNetworkAllowed = false }
enum VoiceProviderResolver {
    static let systemEntryId = SystemVoiceProvider.builtinProviderId
    static func isSystemEntry(_ id: String?) -> Bool { id?.hasPrefix(systemEntryId) == true }
    static func selectedSystemVoiceId(_ id: String) -> String? { nil }
}
@MainActor final class VoiceSelectionStore {
    static let shared = VoiceSelectionStore()
    var inputEntryId: String?
    var outputEntryId: String?
}
@MainActor final class VoiceOutputPlayer {
    static let shared = VoiceOutputPlayer()
    func resetActiveModel() {}
}
struct ModelQuickTestSheet: View {
    let entry: ModelEntry
    var body: some View { Text("Network execution is disabled in this native audit") }
}
