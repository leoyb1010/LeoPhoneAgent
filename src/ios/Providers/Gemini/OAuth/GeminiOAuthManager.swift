import AuthenticationServices
import Foundation
import UIKit
import SafariServices
import CryptoKit
import os.log

private let logger = AppLogger(category: "GeminiOAuth")

@MainActor
final class GeminiOAuthManager: NSObject, ObservableObject {

    static let shared = GeminiOAuthManager()

    // MARK: - OAuth Config (public client credentials, same as Gemini CLI)

    private let authURL = "https://accounts.google.com/o/oauth2/v2/auth"
    private let tokenURL = "https://oauth2.googleapis.com/token"
    private let userInfoURL = "https://www.googleapis.com/oauth2/v1/userinfo"
    // [T-google-oauth-byo-client] The bundled values are upstream's stripped
    // placeholders; a user-supplied client from Google Cloud Console takes
    // precedence and is what actually makes this flow work.
    private var clientID: String {
        GoogleOAuthClientStore.clientID.flatMap { $0.isEmpty ? nil : $0 }
            ?? "681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com"
    }
    private var clientSecret: String {
        GoogleOAuthClientStore.clientSecret.flatMap { $0.isEmpty ? nil : $0 }
            ?? "GOCSPX-xxxxxxxxxxxxxxxxxxxxxxxxxxx"
    }
    private let callbackPort: UInt16 = 8085
    private var redirectURI: String { "http://localhost:\(callbackPort)/oauth2callback" }
    // [T-google-oauth-byo-client] `generative-language.retriever` comes from
    // Google's own Gemini API OAuth guide. Without it the fallback path
    // (generativelanguage.googleapis.com, used whenever Cloud Code Assist
    // project discovery fails) is unauthorized and 403s — GeminiModelsAPI
    // already documents that symptom. Cloud Code Assist ignores the extra
    // scope, so adding it costs nothing and rescues the fallback.
    private let scopes = "https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/generative-language.retriever https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile"

    /// Loopback redirect (desktop clients) vs reversed-client-id custom
    /// scheme (iOS clients).
    private var effectiveRedirectURI: String {
        if GoogleOAuthClientStore.kind == .iOS,
           let iosRedirect = GoogleOAuthClientStore.iOSRedirectURI {
            return iosRedirect
        }
        return redirectURI
    }

    private let cliUserAgent = "GeminiCLI/0.30.0 (darwin; arm64)"
    private let setupClientMetadata: [String: String] = [
        "ideType": "GEMINI_CLI",
        "platform": "DARWIN_ARM64",
        "pluginType": "GEMINI",
    ]

    // MARK: - Published State

    @Published private(set) var isAuthenticating = false

    // MARK: - Private

    private var callbackServer: OAuthCallbackServer?
    private weak var safariVC: SFSafariViewController?

    /// [T-oauth-refresh-race] Instance-level single-flight for token refresh.
    private let refreshSingleFlight = OAuthRefreshSingleFlight<GeminiTokenStorage>()

    private override init() {
        super.init()
    }

    // MARK: - Public API (per-instance)

    func isAuthenticated(instanceId: String) -> Bool {
        ProviderKeychainHelper.loadOAuthToken(instanceId: instanceId, as: GeminiTokenStorage.self)?.accessToken != nil
    }

    func maskedToken(instanceId: String) -> String? {
        guard let token = ProviderKeychainHelper.loadOAuthToken(instanceId: instanceId, as: GeminiTokenStorage.self)?.accessToken else { return nil }
        return ClaudeOAuthManager.maskToken(token)
    }

    func userEmail(instanceId: String) -> String? {
        ProviderKeychainHelper.loadOAuthString(instanceId: instanceId, account: "oauth-email")
    }

    func gcpProjectID(instanceId: String) -> String? {
        ProviderKeychainHelper.loadOAuthString(instanceId: instanceId, account: "oauth-gcp-project")
    }

    func login(instanceId: String) async throws {
        logger.info("=== Gemini OAuth login started (instance: \(instanceId)) ===")
        // Defensive cleanup: stop any leftover server from a previous failed attempt
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
        let isIOSClient = GoogleOAuthClientStore.kind == .iOS

        // 1. Start local HTTP server — desktop clients only. An iOS client
        //    redirects to its reversed-client-id scheme, which
        //    ASWebAuthenticationSession intercepts directly.
        if !isIOSClient {
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
            URLQueryItem(name: "redirect_uri", value: effectiveRedirectURI),
            URLQueryItem(name: "scope", value: scopes),
            URLQueryItem(name: "state", value: state),
            URLQueryItem(name: "access_type", value: "offline"),
            URLQueryItem(name: "prompt", value: "consent"),
            URLQueryItem(name: "code_challenge", value: pkce.challenge),
            URLQueryItem(name: "code_challenge_method", value: "S256"),
        ]
        let authorizationURL = components.url!
        logger.info("Opening OAuth authorization page for \(authorizationURL.host ?? "provider") clientKind=\(isIOSClient ? "iOS" : "desktop")")

        // 3-5. Present and collect the code.
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

        // 8. Discover GCP project for Cloud Code Assist
        if let projectID = try? await discoverCloudCodeProject(token: token.accessToken) {
            ProviderKeychainHelper.saveOAuthString(projectID, instanceId: instanceId, account: "oauth-gcp-project")
            logger.info("Discovered GCP project: \(projectID)")
        } else {
            logger.warning("No GCP project found — Cloud Code Assist unavailable")
        }

        logger.info("=== Gemini OAuth login complete (instance: \(instanceId)) ===")
    }

    func logout(instanceId: String) {
        logger.info("Gemini logout — clearing token (instance: \(instanceId))")
        ProviderKeychainHelper.deleteOAuthToken(instanceId: instanceId)
        ProviderKeychainHelper.deleteOAuthString(instanceId: instanceId, account: "oauth-email")
        ProviderKeychainHelper.deleteOAuthString(instanceId: instanceId, account: "oauth-gcp-project")
    }

    func validAccessToken(instanceId: String) async throws -> String {
        guard var storage = ProviderKeychainHelper.loadOAuthToken(instanceId: instanceId, as: GeminiTokenStorage.self) else {
            throw LLMError.invalidAPIKey(detail: "Gemini: no OAuth token found for instance \(instanceId)")
        }

        let needsRefresh = storage.refreshToken != nil
            && (storage.expireDate.map({ $0.timeIntervalSinceNow <= 0 }) ?? false)

        if needsRefresh {
            storage = try await refreshTokenGuarded(instanceId: instanceId, existingStorage: storage)
        }

        guard let token = Optional(storage.accessToken), !token.isEmpty else {
            throw LLMError.invalidAPIKey(detail: "Gemini: access token is empty for instance \(instanceId)")
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
    private func refreshTokenGuarded(instanceId: String, existingStorage: GeminiTokenStorage) async throws -> GeminiTokenStorage {
        let staleRefreshToken = existingStorage.refreshToken!
        do {
            return try await refreshSingleFlight.run(instanceId: instanceId) { [weak self] in
                guard let self else { throw LLMError.providerError(message: "OAuth manager deallocated") }
                logger.info("Refreshing Gemini token on-demand (instance: \(instanceId))...")
                let refreshed = try await self.performRefresh(refreshToken: staleRefreshToken)
                ProviderKeychainHelper.saveOAuthToken(refreshed, instanceId: instanceId)
                return refreshed
            }
        } catch {
            return try OAuthRefreshCoordinator.resolveAfterRefreshFailure(
                providerName: "Gemini",
                staleRefreshToken: staleRefreshToken,
                existingStorage: existingStorage,
                error: error,
                isFatal: { [weak self] in self?.isRefreshTokenInvalid($0) ?? false },
                loadCurrent: { ProviderKeychainHelper.loadOAuthToken(instanceId: instanceId, as: GeminiTokenStorage.self) },
                deleteCredentials: { ProviderKeychainHelper.deleteOAuthToken(instanceId: instanceId) },
                log: { logger.info($0) }
            )
        }
    }

    /// Discover GCP project if authenticated but missing project ID.
    func discoverProjectIfNeeded(instanceId: String) async {
        guard gcpProjectID(instanceId: instanceId) == nil else { return }
        guard let storage = ProviderKeychainHelper.loadOAuthToken(instanceId: instanceId, as: GeminiTokenStorage.self) else { return }
        logger.info("Auto-discovering GCP project (instance: \(instanceId))...")
        if let projectID = try? await discoverCloudCodeProject(token: storage.accessToken) {
            ProviderKeychainHelper.saveOAuthString(projectID, instanceId: instanceId, account: "oauth-gcp-project")
            logger.info("Auto-discovered GCP project: \(projectID)")
        } else {
            logger.warning("Auto-discovery failed — Cloud Code Assist unavailable")
        }
    }

    // MARK: - Legacy singleton Keychain (for migration)

    static let legacyKeychainService = "com.leoyuan.leophoneagent.gemini-oauth"
    static let legacyKeychainAccount = "token"
    static let legacyEmailKey = "com.leoyuan.leophoneagent.gemini-email"
    static let legacyProjectIDKey = "com.leoyuan.leophoneagent.gemini-gcp-project"

    static func loadLegacyToken() -> GeminiTokenStorage? {
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
        return try? JSONDecoder().decode(GeminiTokenStorage.self, from: data)
    }

    static func deleteLegacyToken() {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: legacyKeychainService,
            kSecAttrAccount as String: legacyKeychainAccount,
        ]
        SecItemDelete(query as CFDictionary)
    }

    // MARK: - State & PKCE Generation

    private func generateState() -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        _ = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        return Data(bytes).base64URLEncodedGemini()
    }

    private func generatePKCE() -> (verifier: String, challenge: String) {
        var bytes = [UInt8](repeating: 0, count: 32)
        _ = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        let verifier = bytes.map { String(format: "%02x", $0) }.joined()
        let challengeData = Data(SHA256.hash(data: Data(verifier.utf8)))
        let challenge = challengeData.base64URLEncodedGemini()
        return (verifier, challenge)
    }

    // MARK: - iOS-client auth session [T-google-oauth-byo-client]

    private var webAuthSession: ASWebAuthenticationSession?

    /// Runs the authorization step for an iOS-type OAuth client. The custom
    /// scheme is claimed by ASWebAuthenticationSession itself, so nothing has
    /// to be declared in Info.plist and no loopback server is needed.
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
                didResume = true
                continuation.resume(throwing: LLMError.providerError(
                    message: String(localized: "无法打开 Google 登录页面。")))
            }
        }
    }

    // MARK: - Token Exchange

    private func exchangeCode(_ code: String, codeVerifier: String) async throws -> GeminiTokenStorage {
        var body: [String: String] = [
            "grant_type": "authorization_code",
            "client_id": clientID,
            "code": code,
            "redirect_uri": effectiveRedirectURI,
            "code_verifier": codeVerifier,
        ]
        // iOS-type clients have no secret — sending one is an error, and PKCE
        // is what proves the exchange instead.
        if GoogleOAuthClientStore.kind == .desktop {
            body["client_secret"] = clientSecret
        }

        return try await postTokenRequest(body: body, context: "Token exchange")
    }

    private func performRefresh(refreshToken: String) async throws -> GeminiTokenStorage {
        var body: [String: String] = [
            "grant_type": "refresh_token",
            "client_id": clientID,
            "refresh_token": refreshToken,
        ]
        if GoogleOAuthClientStore.kind == .desktop {
            body["client_secret"] = clientSecret
        }

        var storage = try await postTokenRequest(body: body, context: "Token refresh")
        // Google doesn't always return a new refresh token on refresh
        if storage.refreshToken == nil {
            storage = GeminiTokenStorage(
                accessToken: storage.accessToken,
                refreshToken: refreshToken,
                expireDate: storage.expireDate,
                lastRefresh: storage.lastRefresh
            )
        }
        return storage
    }

    private func postTokenRequest(body: [String: String], context: String) async throws -> GeminiTokenStorage {
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
            logger.error("\(context) FAILED — status \(statusCode)")
            // [T-google-oauth-byo-client] `invalid_client` is the one failure
            // a user can actually fix, and Google's raw JSON says nothing
            // about how. Name the cause instead.
            if responseBody.contains("invalid_client") {
                throw LLMError.providerError(message: String(localized:
                    "Google rejected the OAuth client (invalid_client). Add your own Google Cloud OAuth client under Add Provider → Google sign-in setup. An \"iOS\" application type (bundle ID com.leoyuan.leophoneagent, no secret) is recommended; a \"Desktop app\" client with its secret also works."))
            }
            // [T-oauth-refresh-race-classify] Embed the real HTTP status for
            // structured classification (not body substring matching).
            throw LLMError.providerError(message: "\(context) failed: " + OAuthRefreshErrorClassifier.makeErrorMessage(status: statusCode, body: responseBody))
        }

        return try parseTokenResponse(data)
    }

    private func parseTokenResponse(_ data: Data) throws -> GeminiTokenStorage {
        let json = try JSONSerialization.jsonObject(with: data) as? [String: Any] ?? [:]

        guard let accessToken = json["access_token"] as? String else {
            throw LLMError.decodingError(underlying: NSError(domain: "GeminiOAuth", code: -1,
                userInfo: [NSLocalizedDescriptionKey: "Missing access_token"]))
        }

        let refreshToken = json["refresh_token"] as? String
        let expiresIn = json["expires_in"] as? TimeInterval
        let expireDate = expiresIn.map { Date().addingTimeInterval($0 - 300) }

        return GeminiTokenStorage(
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

    // MARK: - GCP Project Discovery

    private let cloudCodeBaseURL = "https://cloudcode-pa.googleapis.com/v1internal"

    /// Discover Cloud Code project via loadCodeAssist → onboardUser → Cloud Resource Manager fallback.
    private func discoverCloudCodeProject(token: String) async throws -> String? {
        // Step 1: loadCodeAssist
        if let projectID = try? await loadCodeAssist(token: token) {
            return projectID
        }

        // Step 2: onboardUser (creates project if needed, polls for completion)
        if let projectID = try? await onboardUser(token: token) {
            return projectID
        }

        // Step 3: Fallback to Cloud Resource Manager
        return try? await fetchGCPProjectFallback(token: token)
    }

    /// Apply setup headers used during project discovery (loadCodeAssist, onboardUser).
    private func applySetupHeaders(_ request: inout URLRequest, token: String) {
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue(cliUserAgent, forHTTPHeaderField: "User-Agent")
    }

    /// POST loadCodeAssist to discover existing Cloud Code project.
    private func loadCodeAssist(token: String) async throws -> String? {
        let urlString = URLBuilding.join(cloudCodeBaseURL + ":loadCodeAssist")
        var request = URLRequest(url: URL(string: urlString)!)
        request.httpMethod = "POST"
        applySetupHeaders(&request, token: token)

        let body: [String: Any] = [
            "metadata": setupClientMetadata
        ]
        request.httpBody = try? JSONSerialization.data(withJSONObject: body)

        let (data, response) = try await URLSession.shared.data(for: request)
        let http = response as? HTTPURLResponse
        let statusCode = http?.statusCode ?? -1
        logger.info("loadCodeAssist response: \(statusCode)")

        guard (200..<300).contains(statusCode) else {
            logger.warning("loadCodeAssist failed \(statusCode)")
            return nil
        }

        let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        // Antigravity returns cloudaicompanionProject
        if let project = json?["cloudaicompanionProject"] as? String {
            return project
        }
        if let project = json?["project"] as? String {
            return project.split(separator: "/").last.map(String.init) ?? project
        }
        if let projectID = json?["projectId"] as? String {
            return projectID
        }
        return nil
    }

    /// POST onboardUser and poll operation until complete.
    private func onboardUser(token: String) async throws -> String? {
        let urlString = URLBuilding.join(cloudCodeBaseURL + ":onboardUser")
        var request = URLRequest(url: URL(string: urlString)!)
        request.httpMethod = "POST"
        applySetupHeaders(&request, token: token)

        // Match Gemini CLI: FREE tier onboarding with metadata
        let onboardBody: [String: Any] = [
            "tierId": "FREE",
            "metadata": setupClientMetadata,
        ]
        request.httpBody = try? JSONSerialization.data(withJSONObject: onboardBody)

        let (data, response) = try await URLSession.shared.data(for: request)
        let http = response as? HTTPURLResponse
        let statusCode = http?.statusCode ?? -1

        logger.info("onboardUser response: \(statusCode)")

        guard (200..<300).contains(statusCode) else {
            logger.warning("onboardUser failed \(statusCode), responseBytes=\(data.count)")
            return nil
        }

        let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]

        // If it returned an operation, poll it
        if let operationName = json?["name"] as? String, operationName.contains("operations/") {
            return try await pollOperation(name: operationName, token: token)
        }

        // Direct response — Gemini CLI checks response.cloudaicompanionProject.id
        if let companion = json?["response"] as? [String: Any],
           let project = companion["cloudaicompanionProject"] as? [String: Any],
           let id = project["id"] as? String {
            return id
        }
        if let project = json?["project"] as? String {
            return project.split(separator: "/").last.map(String.init) ?? project
        }
        if let projectID = json?["projectId"] as? String {
            return projectID
        }
        return nil
    }

    /// Poll a long-running operation (max 24 attempts, 5s interval).
    private func pollOperation(name: String, token: String) async throws -> String? {
        let maxAttempts = 24
        let interval: UInt64 = 5_000_000_000 // 5 seconds in nanoseconds

        for attempt in 1...maxAttempts {
            try await Task.sleep(nanoseconds: interval)

            let urlString = URLBuilding.join("https://cloudcode-pa.googleapis.com/v1internal", name)
            var request = URLRequest(url: URL(string: urlString)!)
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            request.setValue(cliUserAgent, forHTTPHeaderField: "User-Agent")

            let (data, response) = try await URLSession.shared.data(for: request)
            let http = response as? HTTPURLResponse
            guard (200..<300).contains(http?.statusCode ?? -1) else { continue }

            let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            let done = json?["done"] as? Bool ?? false

            logger.info("pollOperation attempt \(attempt)/\(maxAttempts) done=\(done)")

            if done {
                if let result = json?["response"] as? [String: Any] {
                    // Gemini CLI: response.cloudaicompanionProject.id
                    if let companion = result["cloudaicompanionProject"] as? [String: Any],
                       let id = companion["id"] as? String {
                        return id
                    }
                    if let project = result["project"] as? String {
                        return project.split(separator: "/").last.map(String.init) ?? project
                    }
                    if let projectID = result["projectId"] as? String {
                        return projectID
                    }
                }
                return nil
            }
        }
        logger.warning("pollOperation timed out after \(maxAttempts) attempts")
        return nil
    }

    /// Fallback: Cloud Resource Manager API to find first active project.
    private func fetchGCPProjectFallback(token: String) async throws -> String? {
        let urlString = "https://cloudresourcemanager.googleapis.com/v1/projects?filter=lifecycleState:ACTIVE"
        var request = URLRequest(url: URL(string: urlString)!)
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")

        let (data, response) = try await URLSession.shared.data(for: request)
        let http = response as? HTTPURLResponse
        let statusCode = http?.statusCode ?? -1

        guard (200..<300).contains(statusCode) else {
            logger.error("GCP projects API error \(statusCode), responseBytes=\(data.count)")
            return nil
        }

        let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        let projects = json?["projects"] as? [[String: Any]] ?? []
        return projects.first?["projectId"] as? String
    }

    // MARK: - In-App Safari

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

struct GeminiTokenStorage: Codable {
    let accessToken: String
    let refreshToken: String?
    let expireDate: Date?
    let lastRefresh: Date?

    var isExpired: Bool {
        guard let expire = expireDate else { return false }
        return expire < Date()
    }
}

extension GeminiTokenStorage: RefreshableOAuthToken {}

// MARK: - Helpers

private extension Data {
    func base64URLEncodedGemini() -> String {
        base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}

// MARK: - ASWebAuthenticationSession presentation [T-google-oauth-byo-client]

extension GeminiOAuthManager: ASWebAuthenticationPresentationContextProviding {
    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap(\.windows)
            .first { $0.isKeyWindow } ?? ASPresentationAnchor()
    }
}
