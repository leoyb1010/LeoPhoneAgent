//
//  GoogleOAuthClientStore.swift
//  MinisApp
//
//  [T-google-oauth-byo-client] Both Google sign-in paths (Gemini Cloud Code
//  Assist and Antigravity) ship with a PLACEHOLDER client secret — upstream
//  stripped the real one when the project was open-sourced, leaving
//  `GOCSPX-xxxxxxxxxxxxxxxxxxxxxxxxxxx` in the source. Google's installed-app
//  flow rejects that at the token-exchange step, which is why Gemini's OAuth
//  option was hidden from the credential picker entirely.
//
//  Rather than hiding a nearly-complete implementation, let the user supply
//  their own OAuth client from Google Cloud Console. Credentials live in the
//  Keychain (never UserDefaults) and are shared by both Google providers,
//  since one Cloud project can serve both.
//

import Foundation
import Security

enum GoogleOAuthClientStore {
    private static let service = "com.leoyuan.leophoneagent.googleOAuthClient"
    private static let clientIDAccount = "client-id"
    private static let clientSecretAccount = "client-secret"

    /// How the user's OAuth client was created in Google Cloud Console.
    /// This is inferred, not asked: Google issues a secret for "Desktop app"
    /// clients and none for "iOS" clients, so the presence of a secret tells
    /// us which flow to run.
    enum ClientKind {
        /// Desktop app: client_secret + loopback HTTP redirect.
        case desktop
        /// iOS app: no secret, PKCE + reversed-client-id custom scheme.
        /// This is the correct type for a real iOS app and sidesteps the
        /// "secret embedded in a shipped binary" problem entirely.
        case iOS
    }

    static var kind: ClientKind {
        let secret = clientSecret ?? ""
        return (secret.isEmpty || secret.hasPrefix("GOCSPX-xxx")) ? .iOS : .desktop
    }

    /// Redirect URI for an iOS-type client: Google mandates the reversed
    /// client ID as a custom scheme. `ASWebAuthenticationSession` claims the
    /// scheme at runtime, so no Info.plist entry is needed.
    static var iOSRedirectURI: String? {
        guard let id = clientID, id.hasSuffix(".apps.googleusercontent.com") else { return nil }
        let bare = id.replacingOccurrences(of: ".apps.googleusercontent.com", with: "")
        return "com.googleusercontent.apps.\(bare):/oauth2redirect"
    }

    static var iOSCallbackScheme: String? {
        guard let id = clientID, id.hasSuffix(".apps.googleusercontent.com") else { return nil }
        let bare = id.replacingOccurrences(of: ".apps.googleusercontent.com", with: "")
        return "com.googleusercontent.apps.\(bare)"
    }

    /// True when sign-in can actually succeed. A desktop client needs a real
    /// secret; an iOS client needs only a well-formed client ID.
    static var isConfigured: Bool {
        guard let id = clientID, !id.isEmpty else { return false }
        switch kind {
        case .desktop:
            return true
        case .iOS:
            return id.hasSuffix(".apps.googleusercontent.com")
        }
    }

    static var clientID: String? {
        get { read(account: clientIDAccount) }
        set { write(newValue, account: clientIDAccount) }
    }

    static var clientSecret: String? {
        get { read(account: clientSecretAccount) }
        set { write(newValue, account: clientSecretAccount) }
    }

    static func clear() {
        write(nil, account: clientIDAccount)
        write(nil, account: clientSecretAccount)
    }

    // MARK: - Keychain

    private static func read(account: String) -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data,
              let value = String(data: data, encoding: .utf8) else { return nil }
        return value
    }

    private static func write(_ value: String?, account: String) {
        let base: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        SecItemDelete(base as CFDictionary)
        guard let value, !value.isEmpty, let data = value.data(using: .utf8) else { return }
        var insert = base
        insert[kSecValueData as String] = data
        insert[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        SecItemAdd(insert as CFDictionary, nil)
    }
}
