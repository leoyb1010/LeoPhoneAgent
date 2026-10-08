import Foundation

/// The credential section of a package (`secrets.json`).
///
/// LeoBot policy (stricter than upstream, which writes it base64-in-the-clear
/// by default): this file is ONLY written into a passphrase-encrypted package,
/// sealed with the dedicated `secrets` subkey. Without a passphrase the
/// credentials are simply not exported, and on restore a `secrets.json` that
/// did not arrive encrypted is ignored.
///
/// Field names and base64-of-UTF-8 encoding match upstream/Android so an
/// encrypted package interoperates. Structured OAuth logins (`oauthToken`)
/// are never exported: LeoBot keeps them device-only by design, so a restored
/// device signs in again. `mcpOAuth` is decoded for tolerance, never written.
struct BackupSecrets: Codable, Sendable {
    var v: Int = 1
    var providers: [ProviderSecret] = []
    var envVars: [EnvVarSecret] = []
    var mcpOAuth: [MCPOAuthSecret] = []

    init(providers: [ProviderSecret] = [], envVars: [EnvVarSecret] = []) {
        self.providers = providers
        self.envVars = envVars
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        v = try c.decodeIfPresent(Int.self, forKey: .v) ?? 1
        providers = (try? c.decodeIfPresent([ProviderSecret].self, forKey: .providers)) ?? []
        envVars = (try? c.decodeIfPresent([EnvVarSecret].self, forKey: .envVars)) ?? []
        mcpOAuth = (try? c.decodeIfPresent([MCPOAuthSecret].self, forKey: .mcpOAuth)) ?? []
    }

    struct ProviderSecret: Codable, Sendable {
        let instanceId: String
        let label: String?
        let providerType: String?
        var apiKey: String?
        var manualOAuthToken: String?
        var oauthToken: String?
        var oauthEmail: String?
        var oauthGcpProject: String?

        init(instanceId: String, label: String?, providerType: String?,
             apiKey: String? = nil, manualOAuthToken: String? = nil) {
            self.instanceId = instanceId
            self.label = label
            self.providerType = providerType
            self.apiKey = apiKey
            self.manualOAuthToken = manualOAuthToken
        }

        var isEmpty: Bool { apiKey == nil && manualOAuthToken == nil }
    }

    struct EnvVarSecret: Codable, Sendable {
        let name: String
        /// base64 of the value's UTF-8 bytes.
        let value: String
    }

    struct MCPOAuthSecret: Codable, Sendable {
        let serverId: String
        let token: String
        var clientSecret: String?
    }

    static func encode(_ s: String) -> String { Data(s.utf8).base64EncodedString() }
    static func decode(_ b64: String) -> String? {
        Data(base64Encoded: b64).flatMap { String(data: $0, encoding: .utf8) }
    }
}
