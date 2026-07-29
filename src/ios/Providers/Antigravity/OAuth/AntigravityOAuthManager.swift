import Foundation
import UIKit
import AuthenticationServices
import SafariServices
import CryptoKit
import os.log

private let logger = AppLogger(category: "AntigravityOAuth")

@MainActor
final class AntigravityOAuthManager: NSObject, ObservableObject {

    static let shared = AntigravityOAuthManager()

    // MARK: - OAuth Config (Antigravity-specific credentials)

    private let authURL = "https://accounts.google.com/o/oauth2/v2/auth"
    private let tokenURL = "https://oauth2.googleapis.com/token"
    private let userInfoURL = "https://www.googleapis.com/oauth2/v1/userinfo"
    // [T-google-oauth-byo-client] User-supplied client (Google Cloud Console)
    // wins over upstream's stripped placeholders — see GoogleOAuthClientStore.
    private var clientID: String {
        GoogleOAuthClientStore.clientID.flatMap { $0.isEmpty ? nil : $0 }
            ?? "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com"
    }
    private var clientSecret: String {
        GoogleOAuthClientStore.clientSecret.flatMap { $0.isEmpty ? nil : $0 }
            ?? "GOCSPX-xxxxxxxxxxxxxxxxxxxxxxxxxxx"
    }
    private let callbackPort: UInt16 = 8086
    /// [T-google-oauth-ios-client] An iOS-type Google client has no secret and
    /// rejects a loopback redirect — it uses the reversed-client-id scheme.
    /// Gemini's manager was taught this; this one was not, so with the
    /// recommended iOS client it sent a placeholder secret to a redirect URI
    /// the client does not own and failed twice over.
    private var isIOSClient: Bool { GoogleOAuthClientStore.kind == .iOS }
    private var redirectURI: String {
        isIOSClient
            ? (GoogleOAuthClientStore.iOSRedirectURI ?? "http://localhost:\(callbackPort)/oauth2callback")
            : "http://localhost:\(callbackPort)/oauth2callback"
    }
    private let scopes = "https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile https://www.googleapis.com/auth/cclog https://www.googleapis.com/auth/experimentsandconfigs"

    private let cliUserAgent = "antigravity/1.107.0 darwin/arm64"
    private let setupClientMetadata: [String: String] = [
        "ideType": "IDE_UNSPECIFIED",
        "platform": "PLATFORM_UNSPECIFIED",
        "pluginType": "GEMINI",
    ]

    // MARK: - Cloud Code Base URLs (daily sandbox preferred, prod fallback)

    nonisolated static let cloudCodeBaseURLs = [
        "https://daily-cloudcode-pa.sandbox.googleapis.com",
        "https://cloudcode-pa.googleapis.com",
    ]

    // MARK: - Published State

    @Published private(set) var isAuthenticating = false

    // MARK: - Private

    private var callbackServer: OAuthCallbackServer?
    private weak var safariVC: SFSafariViewController?

    /// [T-oauth-refresh-race] Instance-level single-flight for token refresh.
    private let refreshSingleFlight = OAuthRefreshSingleFlight<AntigravityTokenStorage>()

    private override init() {
        super.init()
    }

    // MARK: - Public API (per-instance)

    func isAuthenticated(instanceId: String) -> Bool {
        ProviderKeychainHelper.loadOAuthToken(instanceId: instanceId, as: AntigravityTokenStorage.self)?.accessToken != nil
    }

    func maskedToken(instanceId: String) -> String? {
        guard let token = ProviderKeychainHelper.loadOAuthToken(instanceId: instanceId, as: AntigravityTokenStorage.self)?.accessToken else { return nil }
        return ClaudeOAuthManager.maskToken(token)
    }

    func userEmail(instanceId: String) -> String? {
        ProviderKeychainHelper.loadOAuthString(instanceId: instanceId, account: "oauth-email")
    }

    func projectID(instanceId: String) -> String? {
        ProviderKeychainHelper.loadOAuthString(instanceId: instanceId, account: "oauth-gcp-project")
    }

    /// The base URL where the project was successfully discovered.
    func resolvedBaseURL(instanceId: String) -> String? {
        ProviderKeychainHelper.loadOAuthString(instanceId: instanceId, account: "oauth-base-url")
    }

    func login(instanceId: String) async throws {
        logger.info("=== Antigravity OAuth login started (instance: \(instanceId)) ===")
        callbackServer?.stop()
        callbackServer = nil
        isAuthenticating = true
        defer {
            isAuthenticating = false
            callbackServer?.stop()
            callbackServer = nil
            safariVC?.dismiss(animated: true)
            safariVC = nil
        }

        let state = generateState()
        let pkce = generatePKCE()

        // [T-antigravity-ios-client] An iOS-type client's reversed-scheme
        // redirect can never reach a loopback HTTP server — the earlier build
        // changed the redirect but kept the loopback receiver, so sign-in with
        // the recommended client silently waited out the whole 300s timeout.
        // ASWebAuthenticationSession claims the scheme itself (no Info.plist
        // entry, no server), same as GeminiOAuthManager.
        if !isIOSClient {
            // 1. Start local HTTP server (desktop-type client only)
            let server = OAuthCallbackServer(port: callbackPort, callbackPath: "/oauth2callback")
            self.callbackServer = server
            try server.start()
            logger.info("Callback server started on port \(self.callbackPort)")
        }

        // 2. Build authorization URL with PKCE (S256)
        var components = URLComponents(string: authURL)!
        components.queryItems = [
            URLQueryItem(name: "response_type", value: "code"),
            URLQueryItem(name: "client_id", value: clientID),
            URLQueryItem(name: "redirect_uri", value: redirectURI),
            URLQueryItem(name: "scope", value: scopes),
            URLQueryItem(name: "state", value: state),
            URLQueryItem(name: "access_type", value: "offline"),
            URLQueryItem(name: "prompt", value: "consent"),
            URLQueryItem(name: "code_challenge", value: pkce.challenge),
            URLQueryItem(name: "code_challenge_method", value: "S256"),
        ]
        let authorizationURL = components.url!
        logger.info("Opening OAuth authorization page for \(authorizationURL.host ?? "provider")")

        // 3-5. Present and collect the authorization code.
        let authCode: String
        if isIOSClient {
            guard let scheme = GoogleOAuthClientStore.iOSCallbackScheme else {
                throw LLMError.providerError(message: String(localized:
                    "Google 客户端 ID 格式不正确，应以 .apps.googleusercontent.com 结尾。"))
            }
            authCode = try await runWebAuthSession(
                url: authorizationURL, callbackScheme: scheme, expectedState: state)
        } else {
            presentSafariViewController(url: authorizationURL)
            guard let server = callbackServer else {
                throw LLMError.providerError(message: "OAuth callback server unavailable")
            }
            let result = try await server.waitForCallback(timeout: 300)
            logger.info("Callback received — code length: \(result.code.count)")
            guard result.state == state else {
                logger.error("State mismatch!")
                throw LLMError.providerError(message: "OAuth state mismatch")
            }
            authCode = result.code
        }

        // 6. Exchange code for token (with PKCE verifier)
        let token = try await exchangeCode(authCode, codeVerifier: pkce.verifier)
        ProviderKeychainHelper.saveOAuthToken(token, instanceId: instanceId)

        // 7. Fetch user email
        if let email = try? await fetchUserEmail(token: token.accessToken) {
            ProviderKeychainHelper.saveOAuthString(email, instanceId: instanceId, account: "oauth-email")
        }

        // 8. Discover project via Cloud Code Assist
        if let (project, baseURL) = try? await discoverCloudCodeProject(token: token.accessToken) {
            ProviderKeychainHelper.saveOAuthString(project, instanceId: instanceId, account: "oauth-gcp-project")
            ProviderKeychainHelper.saveOAuthString(baseURL, instanceId: instanceId, account: "oauth-base-url")
            logger.info("Discovered project: \(project) via \(baseURL)")
        } else {
            logger.warning("No project found — Antigravity inference unavailable")
        }

        logger.info("=== Antigravity OAuth login complete (instance: \(instanceId)) ===")
    }

    func logout(instanceId: String) {
        logger.info("Antigravity logout — clearing token (instance: \(instanceId))")
        ProviderKeychainHelper.deleteOAuthToken(instanceId: instanceId)
        ProviderKeychainHelper.deleteOAuthString(instanceId: instanceId, account: "oauth-email")
        ProviderKeychainHelper.deleteOAuthString(instanceId: instanceId, account: "oauth-gcp-project")
    }

    func validAccessToken(instanceId: String) async throws -> String {
        guard var storage = ProviderKeychainHelper.loadOAuthToken(instanceId: instanceId, as: AntigravityTokenStorage.self) else {
            throw LLMError.invalidAPIKey(detail: "Antigravity: no OAuth token found for instance \(instanceId)")
        }

        let needsRefresh = storage.refreshToken != nil
            && (storage.expireDate.map({ $0.timeIntervalSinceNow <= 0 }) ?? false)

        if needsRefresh {
            storage = try await refreshTokenGuarded(instanceId: instanceId, existingStorage: storage)
        }

        guard let token = Optional(storage.accessToken), !token.isEmpty else {
            throw LLMError.invalidAPIKey(detail: "Antigravity: access token is empty for instance \(instanceId)")
        }
        return token
    }

    /// [T-oauth-refresh-race-classify] Structured classification via the shared
    /// classifier — replaces the old body-substring match.
    private func isRefreshTokenInvalid(_ error: LLMError) -> Bool {
        OAuthRefreshErrorClassifier.isTokenInvalid(
            error,
            fatalErrorCodes: ["invalid_grant", "invalid_token", "invalid_request", "unauthorized_client"]
        )
    }

    /// [T-oauth-refresh-race] Refresh under instance-level single-flight, with a
    /// compare-before-delete backstop on failure so a stale concurrent refresh
    /// never wipes a token another caller just rotated. Mirrors ClaudeOAuthManager.
    private func refreshTokenGuarded(instanceId: String, existingStorage: AntigravityTokenStorage) async throws -> AntigravityTokenStorage {
        let staleRefreshToken = existingStorage.refreshToken!
        do {
            return try await refreshSingleFlight.run(instanceId: instanceId) { [weak self] in
                guard let self else { throw LLMError.providerError(message: "OAuth manager deallocated") }
                logger.info("Refreshing Antigravity token on-demand (instance: \(instanceId))...")
                let refreshed = try await self.performRefresh(refreshToken: staleRefreshToken)
                ProviderKeychainHelper.saveOAuthToken(refreshed, instanceId: instanceId)
                return refreshed
            }
        } catch {
            return try OAuthRefreshCoordinator.resolveAfterRefreshFailure(
                providerName: "Antigravity",
                staleRefreshToken: staleRefreshToken,
                existingStorage: existingStorage,
                error: error,
                isFatal: { [weak self] in self?.isRefreshTokenInvalid($0) ?? false },
                loadCurrent: { ProviderKeychainHelper.loadOAuthToken(instanceId: instanceId, as: AntigravityTokenStorage.self) },
                deleteCredentials: { ProviderKeychainHelper.deleteOAuthToken(instanceId: instanceId) },
                log: { logger.info($0) }
            )
        }
    }

    func discoverProjectIfNeeded(instanceId: String) async {
        guard projectID(instanceId: instanceId) == nil else { return }
        guard let storage = ProviderKeychainHelper.loadOAuthToken(instanceId: instanceId, as: AntigravityTokenStorage.self) else { return }
        logger.info("Auto-discovering project (instance: \(instanceId))...")
        if let (project, baseURL) = try? await discoverCloudCodeProject(token: storage.accessToken) {
            ProviderKeychainHelper.saveOAuthString(project, instanceId: instanceId, account: "oauth-gcp-project")
            ProviderKeychainHelper.saveOAuthString(baseURL, instanceId: instanceId, account: "oauth-base-url")
            logger.info("Auto-discovered project: \(project) via \(baseURL)")
        } else {
            logger.warning("Auto-discovery failed")
        }
    }

    // MARK: - State & PKCE Generation

    private func generateState() -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        _ = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        return Data(bytes).base64URLEncodedAntigravity()
    }

    private func generatePKCE() -> (verifier: String, challenge: String) {
        var bytes = [UInt8](repeating: 0, count: 32)
        _ = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        let verifier = bytes.map { String(format: "%02x", $0) }.joined()
        let challengeData = Data(SHA256.hash(data: Data(verifier.utf8)))
        let challenge = challengeData.base64URLEncodedAntigravity()
        return (verifier, challenge)
    }

    // MARK: - Token Exchange

    private func exchangeCode(_ code: String, codeVerifier: String) async throws -> AntigravityTokenStorage {
        var body: [String: String] = [
            "grant_type": "authorization_code",
            "client_id": clientID,
            "code": code,
            "redirect_uri": redirectURI,
            "code_verifier": codeVerifier,
        ]
        // An iOS client is a public client: PKCE is the proof, and sending a
        // secret (let alone the placeholder) makes Google reject the exchange.
        if !isIOSClient { body["client_secret"] = clientSecret }
        return try await postTokenRequest(body: body, context: "Token exchange")
    }

    private func performRefresh(refreshToken: String) async throws -> AntigravityTokenStorage {
        var body: [String: String] = [
            "grant_type": "refresh_token",
            "client_id": clientID,
            "refresh_token": refreshToken,
        ]
        if !isIOSClient { body["client_secret"] = clientSecret }

        var storage = try await postTokenRequest(body: body, context: "Token refresh")
        if storage.refreshToken == nil {
            storage = AntigravityTokenStorage(
                accessToken: storage.accessToken,
                refreshToken: refreshToken,
                expireDate: storage.expireDate,
                lastRefresh: storage.lastRefresh
            )
        }
        return storage
    }

    private func postTokenRequest(body: [String: String], context: String) async throws -> AntigravityTokenStorage {
        var request = URLRequest(url: URL(string: tokenURL)!)
        request.httpMethod = "POST"
        request.setValue("application/x-www-form-urlencoded;charset=UTF-8", forHTTPHeaderField: "Content-Type")
        request.setValue("google-api-nodejs-client/9.15.1", forHTTPHeaderField: "User-Agent")

        let formData = body.map { "\($0.key)=\($0.value.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? $0.value)" }
            .joined(separator: "&")
        request.httpBody = formData.data(using: .utf8)

        logger.info("\(context) POST \(self.tokenURL)")

        let (data, response) = try await URLSession.shared.data(for: request)
        let http = response as? HTTPURLResponse
        let statusCode = http?.statusCode ?? -1
        let responseBody = String(data: data, encoding: .utf8) ?? "<binary>"

        logger.info("\(context) Response status: \(statusCode)")

        guard (200..<300).contains(statusCode) else {
            #if DEBUG
            logger.error("\(context) FAILED — status \(statusCode)")
            #else
            logger.error("\(context) FAILED — status \(statusCode)")
            #endif
            // [T-oauth-refresh-race-classify] Embed real HTTP status structurally.
            throw LLMError.providerError(message: "\(context) failed: " + OAuthRefreshErrorClassifier.makeErrorMessage(status: statusCode, body: responseBody))
        }

        return try parseTokenResponse(data)
    }

    private func parseTokenResponse(_ data: Data) throws -> AntigravityTokenStorage {
        let json = try JSONSerialization.jsonObject(with: data) as? [String: Any] ?? [:]

        guard let accessToken = json["access_token"] as? String else {
            throw LLMError.decodingError(underlying: NSError(domain: "AntigravityOAuth", code: -1,
                userInfo: [NSLocalizedDescriptionKey: "Missing access_token"]))
        }

        let refreshToken = json["refresh_token"] as? String
        let expiresIn = json["expires_in"] as? TimeInterval
        let expireDate = expiresIn.map { Date().addingTimeInterval($0 - 300) }

        return AntigravityTokenStorage(
            accessToken: accessToken,
            refreshToken: refreshToken,
            expireDate: expireDate,
            lastRefresh: Date()
        )
    }

    // MARK: - User Info

    private func fetchUserEmail(token: String) async throws -> String? {
        var request = URLRequest(url: URL(string: userInfoURL)!)
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")

        let (data, _) = try await URLSession.shared.data(for: request)
        let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        return json?["email"] as? String
    }

    // MARK: - Project Discovery

    /// Returns (projectID, baseURL) on success.
    private func discoverCloudCodeProject(token: String) async throws -> (String, String)? {
        // Try each Cloud Code base URL
        for baseURL in Self.cloudCodeBaseURLs {
            if let project = try? await loadCodeAssist(token: token, baseURL: baseURL) {
                return (project, baseURL)
            }
        }

        // Fallback: onboardUser on each base URL
        for baseURL in Self.cloudCodeBaseURLs {
            if let project = try? await onboardUser(token: token, baseURL: baseURL) {
                return (project, baseURL)
            }
        }

        return nil
    }

    private func applySetupHeaders(_ request: inout URLRequest, token: String) {
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue(cliUserAgent, forHTTPHeaderField: "User-Agent")
        request.setValue("antigravity", forHTTPHeaderField: "X-Client-Name")
        request.setValue("1.107.0", forHTTPHeaderField: "X-Client-Version")
        request.setValue("gl-node/18.18.2 fire/0.8.6 grpc/1.10.x", forHTTPHeaderField: "x-goog-api-client")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
    }

    private func loadCodeAssist(token: String, baseURL: String) async throws -> String? {
        let urlString = URLBuilding.join(baseURL, "v1internal:loadCodeAssist")
        var request = URLRequest(url: URL(string: urlString)!)
        request.httpMethod = "POST"
        applySetupHeaders(&request, token: token)

        let body: [String: Any] = ["metadata": setupClientMetadata]
        request.httpBody = try? JSONSerialization.data(withJSONObject: body)

        let (data, response) = try await URLSession.shared.data(for: request)
        let http = response as? HTTPURLResponse
        let statusCode = http?.statusCode ?? -1
        let responseBody = String(data: data, encoding: .utf8) ?? ""

        logger.info("loadCodeAssist response: \(statusCode)")

        guard (200..<300).contains(statusCode) else { return nil }

        let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        if let project = json?["cloudaicompanionProject"] as? String { return project }
        if let project = json?["project"] as? String {
            return project.split(separator: "/").last.map(String.init) ?? project
        }
        if let projectID = json?["projectId"] as? String { return projectID }
        return nil
    }

    private func onboardUser(token: String, baseURL: String) async throws -> String? {
        let urlString = URLBuilding.join(baseURL, "v1internal:onboardUser")
        var request = URLRequest(url: URL(string: urlString)!)
        request.httpMethod = "POST"
        applySetupHeaders(&request, token: token)

        let onboardBody: [String: Any] = [
            "tierId": "FREE",
            "metadata": setupClientMetadata,
        ]
        request.httpBody = try? JSONSerialization.data(withJSONObject: onboardBody)

        let (data, response) = try await URLSession.shared.data(for: request)
        let http = response as? HTTPURLResponse
        let statusCode = http?.statusCode ?? -1

        logger.info("onboardUser response: \(statusCode)")

        guard (200..<300).contains(statusCode) else { return nil }

        let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]

        if let operationName = json?["name"] as? String, operationName.contains("operations/") {
            return try await pollOperation(name: operationName, token: token, baseURL: baseURL)
        }

        if let companion = json?["response"] as? [String: Any],
           let project = companion["cloudaicompanionProject"] as? [String: Any],
           let id = project["id"] as? String { return id }
        if let project = json?["project"] as? String {
            return project.split(separator: "/").last.map(String.init) ?? project
        }
        if let projectID = json?["projectId"] as? String { return projectID }
        return nil
    }

    private func pollOperation(name: String, token: String, baseURL: String) async throws -> String? {
        let maxAttempts = 24
        let interval: UInt64 = 5_000_000_000

        for attempt in 1...maxAttempts {
            try await Task.sleep(nanoseconds: interval)

            let urlString = URLBuilding.join(baseURL, "v1internal", name)
            var request = URLRequest(url: URL(string: urlString)!)
            applySetupHeaders(&request, token: token)

            let (data, response) = try await URLSession.shared.data(for: request)
            let http = response as? HTTPURLResponse
            guard (200..<300).contains(http?.statusCode ?? -1) else { continue }

            let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            let done = json?["done"] as? Bool ?? false

            logger.info("pollOperation attempt \(attempt)/\(maxAttempts) done=\(done)")

            if done {
                if let result = json?["response"] as? [String: Any] {
                    if let companion = result["cloudaicompanionProject"] as? [String: Any],
                       let id = companion["id"] as? String { return id }
                    if let project = result["project"] as? String {
                        return project.split(separator: "/").last.map(String.init) ?? project
                    }
                    if let projectID = result["projectId"] as? String { return projectID }
                }
                return nil
            }
        }
        logger.warning("pollOperation timed out after \(maxAttempts) attempts")
        return nil
    }

    // MARK: - In-App Safari

    private var webAuthSession: ASWebAuthenticationSession?

    /// [T-antigravity-ios-client] Authorization for an iOS-type client, same
    /// implementation as GeminiOAuthManager.runWebAuthSession.
    private func runWebAuthSession(
        url: URL,
        callbackScheme: String,
        expectedState: String
    ) async throws -> String {
        try await withCheckedThrowingContinuation { continuation in
            var didResume = false
            let session = ASWebAuthenticationSession(
                url: url,
                callbackURLScheme: callbackScheme
            ) { callbackURL, error in
                guard !didResume else { return }
                didResume = true
                if let error {
                    let nsError = error as NSError
                    if nsError.domain == ASWebAuthenticationSessionErrorDomain,
                       nsError.code == ASWebAuthenticationSessionError.canceledLogin.rawValue {
                        continuation.resume(throwing: LLMError.providerError(
                            message: String(localized: "已取消 Google 登录。")))
                    } else {
                        continuation.resume(throwing: error)
                    }
                    return
                }
                guard let callbackURL,
                      let components = URLComponents(url: callbackURL, resolvingAgainstBaseURL: false) else {
                    continuation.resume(throwing: LLMError.providerError(message: "OAuth callback was empty"))
                    return
                }
                let items = components.queryItems ?? []
                if let failure = items.first(where: { $0.name == "error" })?.value {
                    continuation.resume(throwing: LLMError.providerError(
                        message: "Google 拒绝了授权请求：\(failure)"))
                    return
                }
                guard items.first(where: { $0.name == "state" })?.value == expectedState else {
                    continuation.resume(throwing: LLMError.providerError(message: "OAuth state mismatch"))
                    return
                }
                guard let code = items.first(where: { $0.name == "code" })?.value, !code.isEmpty else {
                    continuation.resume(throwing: LLMError.providerError(message: "OAuth callback had no code"))
                    return
                }
                continuation.resume(returning: code)
            }
            session.presentationContextProvider = self
            session.prefersEphemeralWebBrowserSession = false
            self.webAuthSession = session
            if !session.start() {
                guard !didResume else { return }
                didResume = true
                continuation.resume(throwing: LLMError.providerError(
                    message: "Unable to present the sign-in sheet."))
            }
        }
    }

    private func presentSafariViewController(url: URL) {
        guard let scene = UIApplication.shared.connectedScenes
            .compactMap({ $0 as? UIWindowScene }).activeFirst,
              let root = scene.windows.first(where: { $0.isKeyWindow })?.rootViewController else { return }
        var topVC = root
        while let presented = topVC.presentedViewController { topVC = presented }
        let vc = SFSafariViewController(url: url)
        topVC.present(vc, animated: true)
        self.safariVC = vc
    }
}

// MARK: - Token Storage Model

struct AntigravityTokenStorage: Codable {
    let accessToken: String
    let refreshToken: String?
    let expireDate: Date?
    let lastRefresh: Date?

    var isExpired: Bool {
        guard let expire = expireDate else { return false }
        return expire < Date()
    }
}

extension AntigravityTokenStorage: RefreshableOAuthToken {}

// MARK: - Helpers

private extension Data {
    func base64URLEncodedAntigravity() -> String {
        base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}

extension AntigravityOAuthManager: ASWebAuthenticationPresentationContextProviding {
    nonisolated func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        MainActor.assumeIsolated {
            UIApplication.shared.leoActiveKeyWindow ?? ASPresentationAnchor()
        }
    }
}
