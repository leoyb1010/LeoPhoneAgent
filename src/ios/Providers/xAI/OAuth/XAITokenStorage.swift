import Foundation

struct XAITokenStorage: Codable {
    let accessToken: String
    let refreshToken: String?
    let idToken: String?
    let expireDate: Date?
    let lastRefresh: Date?
    /// Cached from OIDC discovery so refresh doesn't have to re-fetch each time.
    let tokenEndpoint: String?
    let email: String?
    let displayName: String?
    let accountId: String?
    /// OIDC `sub`, kept separate because Grok's CLI proxy uses it as x-userid.
    let userId: String?

    var isExpired: Bool {
        guard let expire = expireDate else { return false }
        return expire < Date()
    }
}

extension XAITokenStorage: RefreshableOAuthToken {}
