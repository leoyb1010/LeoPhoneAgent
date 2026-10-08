import Foundation
import UIKit
import SafariServices
import CryptoKit
import os.log

private let logger = AppLogger(category: "CodexOAuth")

@MainActor
final class CodexOAuthManager: NSObject, ObservableObject {

    static let shared = CodexOAuthManager()

    // MARK: - OAuth Config

    private let authURL = "https://auth.openai.com/oauth/authorize"
    private let tokenURL = "https://auth.openai.com/oauth/token"
    private let clientID = "app_EMoamEEZ73f0CkXaXp7hrann"
    private let callbackPort: UInt16 = 1455
    private var redirectURI: String { "http://localhost:\(callbackPort)/auth/callback" }
    private let scopes = "openid profile email offline_access"

    private let refreshBuffer: TimeInterval = 5 * 60

    // MARK: - Published State

    @Published private(set) var isAuthenticating = false

    // MARK: - Private

    private var callbackServer: OAuthCallbackServer?
    private weak var safariVC: SFSafariViewController?

    /// [T-oauth-refresh-race] Instance-level single-flight for token refresh.
    private let refreshSingleFlight = OAuthRefreshSingleFlight<CodexTokenStorage>()

    private override init() {
        super.init()
    }

    // MARK: - Public API (per-instance)

    func isAuthenticated(instanceId: String) -> Bool {
        ProviderKeychainHelper.loadOAuthToken(instanceId: instanceId, as: CodexTokenStorage.self)?.accessToken != nil
    }

    func maskedToken(instanceId: String) -> String? {
        guard let token = ProviderKeychainHelper.loadOAuthToken(instanceId: instanceId, as: CodexTokenStorage.self)?.accessToken else { return nil }
        return OAuthTokenMask.mask(token)
    }

    func accountId(instanceId: String) -> String? {
        ProviderKeychainHelper.loadOAuthToken(instanceId: instanceId, as: CodexTokenStorage.self)?.accountId
    }

    func planType(instanceId: String) -> String? {
        ProviderKeychainHelper.loadOAuthToken(instanceId: instanceId, as: CodexTokenStorage.self)?.planType
    }

    func login(instanceId: String) async throws {
        // A second concurrent login would fight over the same loopback port
        // and tear down the first attempt's server.
        guard !isAuthenticating else {
            logger.warning("Codex login already in progress — ignoring re-entrant call")
            return
        }
        logger.info("=== Codex OAuth login started (instance: \(instanceId)) ===")
        isAuthenticating = true
        var ownServer: OAuthCallbackServer?
        defer {
            isAuthenticating = false
            ownServer?.stop()
            if callbackServer === ownServer { callbackServer = nil }
            safariVC?.dismiss(animated: true)
            safariVC = nil
        }

        let (verifier, challenge) = generatePKCE()
        let state = generateState()
        logger.info("PKCE generated — verifier length: \(verifier.count)")

        // 1. Start local HTTP server
        let server = OAuthCallbackServer(port: callbackPort, callbackPath: "/auth/callback")
        ownServer = server
        self.callbackServer = server
        try server.start()
        logger.info("Callback server started on port \(self.callbackPort)")

        // 2. Build authorization URL
        var components = URLComponents(string: authURL)!
        components.queryItems = [
            URLQueryItem(name: "response_type", value: "code"),
            URLQueryItem(name: "client_id", value: clientID),
            URLQueryItem(name: "redirect_uri", value: redirectURI),
            URLQueryItem(name: "scope", value: scopes),
            URLQueryItem(name: "code_challenge", value: challenge),
            URLQueryItem(name: "code_challenge_method", value: "S256"),
            URLQueryItem(name: "state", value: state),
            URLQueryItem(name: "id_token_add_organizations", value: "true"),
            URLQueryItem(name: "codex_cli_simplified_flow", value: "true"),
            URLQueryItem(name: "originator", value: "codex_cli_rs"),
        ]
        let authorizationURL = components.url!
        logger.info("Opening OAuth authorization page for \(authorizationURL.host ?? "provider")")

        // 3. Open in-app Safari (throws when it can't be shown, so the flow
        //    ends now instead of waiting for a callback that can't come)
        safariVC = try OAuthSafariPresenter.present(authorizationURL, delegate: self)

        // 4. Wait for callback (5 min timeout)
        logger.info("Waiting for callback...")
        let result = try await server.waitForCallback(timeout: 300)
        logger.info("Callback received — code length: \(result.code.count), state match: \(result.state == state)")

        // 5. Validate state
        guard result.state == state else {
            logger.error("State mismatch!")
            throw LLMError.providerError(message: String(localized: "Sign-in could not be verified. Please try again."))
        }

        // 6. Exchange code for token
        logger.info("Exchanging code for token...")
        let token = try await exchangeCode(result.code, verifier: verifier)
        logger.info("Token exchange successful")

        ProviderKeychainHelper.saveOAuthToken(token, instanceId: instanceId)
        logger.info("=== Codex OAuth login complete (instance: \(instanceId)) ===")
    }

    func logout(instanceId: String) {
        logger.info("Logout — clearing token (instance: \(instanceId))")
        ProviderKeychainHelper.deleteOAuthToken(instanceId: instanceId)
    }

    func validAccessToken(instanceId: String) async throws -> String {
        guard var storage = ProviderKeychainHelper.loadOAuthToken(instanceId: instanceId, as: CodexTokenStorage.self) else {
            throw LLMError.invalidAPIKey(detail: String(localized: "Not signed in to ChatGPT. Sign in again in Settings → Providers."))
        }

        let needsRefresh = storage.refreshToken != nil
            && (storage.expireDate.map({ $0.timeIntervalSinceNow <= refreshBuffer }) ?? false)

        if needsRefresh {
            storage = try await refreshTokenGuarded(instanceId: instanceId, existingStorage: storage)
        }

        guard let token = Optional(storage.accessToken), !token.isEmpty else {
            throw LLMError.invalidAPIKey(detail: String(localized: "Not signed in to ChatGPT. Sign in again in Settings → Providers."))
        }
        return token
    }

    /// Returns true when the refresh error indicates the refresh token itself
    /// is invalid (revoked, expired, already used) vs a transient network issue.
    /// [T-oauth-refresh-race-classify] Structured classification via the shared
    /// classifier. Codex (ChatGPT OAuth) rotates + rejects reused refresh tokens.
    /// The old bare `refresh_token` substring is dropped: it was the widest
    /// false-positive source (matched benign mentions like refresh_token_expiry);
    /// the precise codes (`invalid_grant`, `refresh_token_reused/expired/invalidated`,
    /// read from OpenAI's nested error body too) cover real revocation without it.
    private func isRefreshTokenInvalid(_ error: LLMError) -> Bool {
        OAuthRefreshErrorClassifier.isTokenInvalid(
            error,
            fatalErrorCodes: OAuthRefreshErrorClassifier.codexFatalErrorCodes
        )
    }

    /// [T-oauth-refresh-race] Refresh under instance-level single-flight, with a
    /// compare-before-delete backstop on failure so a stale concurrent refresh
    /// never wipes a token another caller just rotated.
    private func refreshTokenGuarded(instanceId: String, existingStorage: CodexTokenStorage) async throws -> CodexTokenStorage {
        let staleRefreshToken = existingStorage.refreshToken!
        do {
            return try await refreshSingleFlight.run(instanceId: instanceId) { [weak self] in
                guard let self else { throw LLMError.providerError(message: "OAuth manager deallocated") }
                logger.info("Refreshing Codex token on-demand (instance: \(instanceId))...")
                let refreshed = try await self.performRefresh(refreshToken: staleRefreshToken)
                ProviderKeychainHelper.saveOAuthToken(refreshed, instanceId: instanceId)
                return refreshed
            }
        } catch {
            return try OAuthRefreshCoordinator.resolveAfterRefreshFailure(
                providerName: "Codex",
                staleRefreshToken: staleRefreshToken,
                existingStorage: existingStorage,
                error: error,
                isFatal: { [weak self] in self?.isRefreshTokenInvalid($0) ?? false },
                loadCurrent: { ProviderKeychainHelper.loadOAuthToken(instanceId: instanceId, as: CodexTokenStorage.self) },
                markNeedsReauth: { ProviderKeychainHelper.markOAuthNeedsReauth(instanceId: instanceId) },
                log: { logger.info($0) }
            )
        }
    }

    // MARK: - Legacy singleton Keychain (for migration)

    static let legacyKeychainService = "com.leoyuan.leophoneagent.openai-oauth"
    static let legacyKeychainAccount = "token"

    static func loadLegacyToken() -> CodexTokenStorage? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: legacyKeychainService,
            kSecAttrAccount as String: legacyKeychainAccount,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var result: AnyObject?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data else { return nil }
        return try? JSONDecoder().decode(CodexTokenStorage.self, from: data)
    }

    static func deleteLegacyToken() {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: legacyKeychainService,
            kSecAttrAccount as String: legacyKeychainAccount,
        ]
        SecItemDelete(query as CFDictionary)
    }

    // MARK: - PKCE

    private func generatePKCE() -> (verifier: String, challenge: String) {
        var bytes = [UInt8](repeating: 0, count: 64)
        _ = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        let verifier = Data(bytes).base64URLEncodedCodex()

        let hash = SHA256.hash(data: Data(verifier.utf8))
        let challenge = Data(hash).base64URLEncodedCodex()

        return (verifier, challenge)
    }

    private func generateState() -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        _ = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        return Data(bytes).base64URLEncodedCodex()
    }

    // MARK: - Token Exchange

    private func exchangeCode(_ code: String, verifier: String) async throws -> CodexTokenStorage {
        let body: [String: String] = [
            "grant_type": "authorization_code",
            "client_id": clientID,
            "code": code,
            "redirect_uri": redirectURI,
            "code_verifier": verifier,
        ]

        do {
            return try await postTokenRequest(body: body, context: "Token exchange")
        } catch let error as LLMError {
            guard case .providerError = error else { throw error }
            throw LLMError.providerError(message: String(localized: "ChatGPT sign-in failed (\(OAuthRefreshErrorClassifier.userFacingSummary(error))). Please try again."))
        }
    }

    private func performRefresh(refreshToken: String) async throws -> CodexTokenStorage {
        let body: [String: String] = [
            "grant_type": "refresh_token",
            "client_id": clientID,
            "refresh_token": refreshToken,
            "scope": scopes,
        ]

        var storage = try await postTokenRequest(body: body, context: "Token refresh")
        // OpenAI may not return a new refresh token on every refresh;
        // preserve the existing one so subsequent refreshes keep working.
        if storage.refreshToken == nil {
            storage = CodexTokenStorage(
                accessToken: storage.accessToken,
                refreshToken: refreshToken,
                idToken: storage.idToken,
                expireDate: storage.expireDate,
                lastRefresh: storage.lastRefresh,
                accountId: storage.accountId,
                planType: storage.planType
            )
        }
        return storage
    }

    private func postTokenRequest(body: [String: String], context: String) async throws -> CodexTokenStorage {
        var request = URLRequest(url: URL(string: tokenURL)!)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        let jsonData = try JSONSerialization.data(withJSONObject: body)
        request.httpBody = jsonData

        logger.info("\(context) POST \(self.tokenURL)")

        let (data, response) = try await URLSession.shared.data(for: request)
        let http = response as? HTTPURLResponse
        let statusCode = http?.statusCode ?? -1
        logger.info("\(context) Response status: \(statusCode)")

        guard (200..<300).contains(statusCode) else {
            logger.error("\(context) FAILED — status \(statusCode)")
            let responseBody = String(data: data, encoding: .utf8) ?? ""
            // [T-oauth-refresh-race-classify] Embed real HTTP status structurally.
            throw LLMError.providerError(message: "\(context) failed: " + OAuthRefreshErrorClassifier.makeErrorMessage(status: statusCode, body: responseBody))
        }

        return try parseTokenResponse(data)
    }

    private func parseTokenResponse(_ data: Data) throws -> CodexTokenStorage {
        let json = try JSONSerialization.jsonObject(with: data) as? [String: Any] ?? [:]

        guard let accessToken = json["access_token"] as? String else {
            throw LLMError.decodingError(underlying: NSError(domain: "OAuth", code: -1,
                userInfo: [NSLocalizedDescriptionKey: "Missing access_token"]))
        }

        let refreshToken = json["refresh_token"] as? String
        let expiresIn = json["expires_in"] as? TimeInterval
        let expireDate = expiresIn.map { Date().addingTimeInterval($0) }
        let idToken = json["id_token"] as? String

        // Parse JWT id_token to extract account info
        var extractedAccountId: String?
        var extractedPlanType: String?
        if let idToken {
            let claims = Self.decodeJWTPayload(idToken)
            extractedAccountId = claims?["chatgpt_account_id"] as? String
            extractedPlanType = claims?["chatgpt_plan_type"] as? String
            logger.info("ID token claims — account present: \(extractedAccountId != nil), plan present: \(extractedPlanType != nil)")
        }

        return CodexTokenStorage(
            accessToken: accessToken,
            refreshToken: refreshToken,
            idToken: idToken,
            expireDate: expireDate,
            lastRefresh: Date(),
            accountId: extractedAccountId,
            planType: extractedPlanType
        )
    }

    // MARK: - JWT Decode

    /// Decode the payload (segment[1]) of a JWT without signature verification.
    static func decodeJWTPayload(_ jwt: String) -> [String: Any]? {
        let segments = jwt.split(separator: ".")
        guard segments.count >= 2 else { return nil }

        var base64 = String(segments[1])
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        // Pad to multiple of 4
        let remainder = base64.count % 4
        if remainder > 0 {
            base64 += String(repeating: "=", count: 4 - remainder)
        }

        guard let data = Data(base64Encoded: base64) else { return nil }
        return try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    }
}

extension CodexOAuthManager: SFSafariViewControllerDelegate {
    nonisolated func safariViewControllerDidFinish(_ controller: SFSafariViewController) {
        Task { @MainActor [weak self] in
            // Closing Safari cancels the wait instead of holding the port for the full timeout.
            guard let self, self.safariVC === controller else { return }
            self.callbackServer?.stop()
        }
    }
}

// MARK: - Token Storage Model

struct CodexTokenStorage: Codable {
    let accessToken: String
    let refreshToken: String?
    let idToken: String?
    let expireDate: Date?
    let lastRefresh: Date?
    let accountId: String?
    let planType: String?

    var isExpired: Bool {
        guard let expire = expireDate else { return false }
        return expire < Date()
    }
}

extension CodexTokenStorage: RefreshableOAuthToken {}

// MARK: - Helpers

private extension Data {
    func base64URLEncodedCodex() -> String {
        base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}
