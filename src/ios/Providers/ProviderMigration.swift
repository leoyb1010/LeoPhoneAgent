import Foundation
import Security
import os.log

private let logger = AppLogger(category: "ProviderMigration")

/// Migrates existing provider configuration (AuthMode, API keys, OAuth state)
/// into the new ProviderInstance / ModelEntry / ModelGroup system.
@MainActor
enum ProviderMigration {

    private static let migrationKey = "com.leoyuan.leophoneagent.provider-migration-v1-done"
    private static let oauthMigrationKey = "com.leoyuan.leophoneagent.provider-migration-oauth-v2-done"

    /// Run migration if it hasn't been performed yet.
    static func migrateIfNeeded(store: ProviderConfigStore) {
        if !UserDefaults.standard.bool(forKey: migrationKey) {
            logger.info("Starting provider migration from legacy config")
            migrate(store: store)
            UserDefaults.standard.set(true, forKey: migrationKey)
            logger.info("Provider migration complete")
        }

        if !UserDefaults.standard.bool(forKey: oauthMigrationKey) {
            migrateOAuthTokens(store: store)
            UserDefaults.standard.set(true, forKey: oauthMigrationKey)
        }

        if !UserDefaults.standard.bool(forKey: deviceOnlyOAuthMigrationKey) {
            for instance in store.instances where instance.credentialType == .oauth {
                ProviderKeychainHelper.migrateOAuthTokenToDeviceOnly(instanceId: instance.id)
            }
            UserDefaults.standard.set(true, forKey: deviceOnlyOAuthMigrationKey)
        }

        // Every launch: instances can arrive later through iCloud sync.
        retireDiscontinuedSignIns(store: store)
    }

    private static let deviceOnlyOAuthMigrationKey = "com.leoyuan.leophoneagent.provider-migration-oauth-device-only-v3-done"

    // MARK: - Retired sign-in methods (Claude subscription, Gemini Google login, Antigravity)

    /// Disables instances whose sign-in method is gone and deletes their stored
    /// tokens. The instance itself stays so the user sees the notice and can
    /// switch it to an API key. Idempotent.
    private static func retireDiscontinuedSignIns(store: ProviderConfigStore) {
        for singleton in ["com.leoyuan.leophoneagent.claude-oauth", "com.leoyuan.leophoneagent.gemini-oauth"] {
            let query: [String: Any] = [
                kSecClass as String: kSecClassGenericPassword,
                kSecAttrService as String: singleton,
            ]
            SecItemDelete(query as CFDictionary)
        }
        for key in ["com.leoyuan.leophoneagent.gemini-email", "com.leoyuan.leophoneagent.gemini-gcp-project"] {
            UserDefaults.standard.removeObject(forKey: key)
        }

        for instance in store.instances where instance.retiredSignInNotice != nil {
            if ProviderKeychainHelper.migrateOAuthTokenToDeviceOnly(instanceId: instance.id) != nil {
                ProviderKeychainHelper.deleteOAuthToken(instanceId: instance.id)
            }
            for account in ["oauth-email", "oauth-gcp-project", "oauth-base-url"]
            where ProviderKeychainHelper.loadOAuthString(instanceId: instance.id, account: account) != nil {
                ProviderKeychainHelper.deleteOAuthString(instanceId: instance.id, account: account)
            }
            if instance.isEnabled {
                var disabled = instance
                disabled.isEnabled = false
                store.updateInstance(disabled)
                logger.info("Retired sign-in: disabled instance \(instance.id.prefix(8))")
            }
        }
    }

    // MARK: - V2: Migrate singleton OAuth tokens → per-instance storage

    private static func migrateOAuthTokens(store: ProviderConfigStore) {
        logger.info("Starting OAuth token migration to per-instance storage")

        for instance in store.instances where instance.credentialType == .oauth {
            switch instance.providerType {
            case .anthropic, .gemini:
                // Subscription / Google sign-in is retired; see retireDiscontinuedSignIns.
                break

            case .openAI:
                if ProviderKeychainHelper.loadOAuthToken(instanceId: instance.id, as: CodexTokenStorage.self) != nil {
                    continue
                }
                if let token = CodexOAuthManager.loadLegacyToken() {
                    ProviderKeychainHelper.saveOAuthToken(token, instanceId: instance.id)
                    CodexOAuthManager.deleteLegacyToken()
                    logger.info("Migrated Codex OAuth token to instance \(instance.id)")
                }

            case .openCodeGo:
                break
            case .openRouter:
                // No legacy tokens to migrate for OpenRouter (new provider)
                break
            case .openAIResponses:
                break
            case .xAI:
                // xAI is a new provider; no legacy singleton tokens to migrate.
                break
            case .kimiCode:
                // Kimi is a new provider; no legacy singleton tokens to migrate.
                break
            case .unsupported:
                break
            }
        }

        logger.info("OAuth token migration complete")
    }

    // MARK: - V1: Legacy migration

    private static func migrate(store: ProviderConfigStore) {
        var config = ProviderConfig.empty
        var firstGroupEntryIds: [String] = []

        // MARK: - Anthropic

        // API Key
        if let key = readLegacyKeychain(service: "com.leoyuan.leophoneagent.anthropic-api-key") {
            let instance = ProviderInstance(
                label: "Anthropic API Key",
                providerType: .anthropic,
                credentialType: .apiKey
            )
            config.instances.append(instance)
            let entries = LLMModel.allAnthropic.map {
                ModelEntry(providerInstanceId: instance.id, model: $0)
            }
            config.modelEntries.append(contentsOf: entries)
            // Save key to new keychain location
            ProviderKeychainHelper.saveAPIKey(key, instanceId: instance.id)

            if isLegacyActiveProvider("API Key") {
                firstGroupEntryIds = entries.map(\.id)
            }
        }

        // MARK: - Gemini

        // API Key
        if let key = readLegacyKeychain(service: "com.leoyuan.leophoneagent.gemini-api-key") {
            let instance = ProviderInstance(
                label: "Gemini API Key",
                providerType: .gemini,
                credentialType: .apiKey
            )
            config.instances.append(instance)
            let entries = LLMModel.allGemini.map {
                ModelEntry(providerInstanceId: instance.id, model: $0)
            }
            config.modelEntries.append(contentsOf: entries)
            ProviderKeychainHelper.saveAPIKey(key, instanceId: instance.id)

            if isLegacyActiveProvider("Gemini API Key") {
                firstGroupEntryIds = entries.map(\.id)
            }
        }

        // MARK: - OpenAI

        // API Key
        if let key = readLegacyKeychain(service: "com.leoyuan.leophoneagent.openai-api-key") {
            let instance = ProviderInstance(
                label: "OpenAI API Key",
                providerType: .openAI,
                credentialType: .apiKey
            )
            config.instances.append(instance)
            let entries = LLMModel.allOpenAI.map {
                ModelEntry(providerInstanceId: instance.id, model: $0)
            }
            config.modelEntries.append(contentsOf: entries)
            ProviderKeychainHelper.saveAPIKey(key, instanceId: instance.id)

            if isLegacyActiveProvider("OpenAI API Key") {
                firstGroupEntryIds = entries.map(\.id)
            }
        }

        // Codex OAuth
        if CodexOAuthManager.loadLegacyToken() != nil {
            let instance = ProviderInstance(
                label: "Codex OAuth",
                providerType: .openAI,
                credentialType: .oauth
            )
            config.instances.append(instance)
            let entries = LLMModel.allOpenAI.map {
                ModelEntry(providerInstanceId: instance.id, model: $0)
            }
            config.modelEntries.append(contentsOf: entries)

            if isLegacyActiveProvider("Codex OAuth") {
                firstGroupEntryIds = entries.map(\.id)
            }
        }

        // MARK: - Default Group

        // If we found an active provider, narrow the group to the last selected model if possible
        if !firstGroupEntryIds.isEmpty {
            // Try to match legacy AgentModelSettings primary model IDs
            let legacySettings = Self.loadLegacyAgentModelSettings()
            let primaryIds = legacySettings.primaryModelIds

            // Filter to just entries matching the legacy primary model IDs
            let matchedEntries = firstGroupEntryIds.filter { entryId in
                primaryIds.contains(where: { entryId.hasSuffix(":\($0)") })
            }

            let groupMembers = matchedEntries.isEmpty ? firstGroupEntryIds : matchedEntries

            let defaultGroup = ModelGroup(
                name: "Default",
                memberEntryIds: groupMembers,
                strategy: groupMembers.count > 1 ? .fallback : .fallback
            )
            config.modelGroups.append(defaultGroup)
            config.defaultPrimaryGroupId = defaultGroup.id

            // Sub-model group from legacy settings
            let subIds = legacySettings.subModelIds.isEmpty ? legacySettings.primaryModelIds : legacySettings.subModelIds
            if subIds != primaryIds {
                let subEntries = firstGroupEntryIds.filter { entryId in
                    subIds.contains(where: { entryId.hasSuffix(":\($0)") })
                }
                if !subEntries.isEmpty {
                    let subGroup = ModelGroup(
                        name: "Sub Tasks",
                        memberEntryIds: subEntries,
                        strategy: .fallback
                    )
                    config.modelGroups.append(subGroup)
                    config.defaultSubGroupId = subGroup.id
                }
            }
        }

        store.applyConfig(config)

        logger.info("Migration created \(config.instances.count) instances, \(config.modelEntries.count) entries, \(config.modelGroups.count) groups")
    }

    // MARK: - Legacy Helpers

    private static func readLegacyKeychain(service: String) -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: "api-key",
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var result: AnyObject?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    /// Legacy AgentModelSettings shape (for migration only).
    private struct LegacyAgentModelSettings: Codable {
        var primaryModelIds: [String]
        var subModelIds: [String]
    }

    private static func loadLegacyAgentModelSettings() -> LegacyAgentModelSettings {
        let key = "com.leoyuan.leophoneagent.agent-model-settings"
        guard let data = UserDefaults.standard.data(forKey: key),
              let settings = try? JSONDecoder().decode(LegacyAgentModelSettings.self, from: data)
        else {
            return LegacyAgentModelSettings(primaryModelIds: [LLMModel.claudeSonnet46.id], subModelIds: [])
        }
        return settings
    }

    /// Check if a given raw auth mode string matches the legacy active provider keychain entry.
    private static func isLegacyActiveProvider(_ rawValue: String) -> Bool {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: "com.leoyuan.leophoneagent.active-provider",
            kSecAttrAccount as String: "auth-mode",
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var result: AnyObject?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data,
              let raw = String(data: data, encoding: .utf8) else { return false }
        return raw == rawValue
    }
}
