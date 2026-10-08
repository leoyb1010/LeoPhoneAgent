import Foundation

// MARK: - Token Storage Model

/// Persisted Kimi Code OAuth credentials. Kept UIKit-free (this file compiles
/// into the unit-test target) so the refresh-race logic below is testable in
/// isolation. Carries the RFC 8628 device identity alongside the tokens.
struct KimiTokenStorage: Codable {
    let accessToken: String
    let refreshToken: String?
    let expireDate: Date?
    /// Persisted device ID from the device-authorization step (RFC 8628).
    let deviceId: String
    let lastRefresh: Date?

    var isExpired: Bool {
        guard let expire = expireDate else { return false }
        return expire < Date()
    }
}

// MARK: - Refresh-failure resolution (single-flight backstop)

/// [T-oauth-refresh-race] Pure decision logic for "a refresh attempt failed —
/// now what?", split out from `KimiOAuthManager` so it has NO UIKit / network
/// dependency and can be unit-tested against the exact concurrent ordering that
/// bit Anthropic (A=200 rotates + writes the new token, stale B=400 must NOT
/// delete it). All I/O is injected so the test drives credential state
/// deterministically without touching the real Keychain.
///
/// Same contract as `OAuthRefreshCoordinator`: the compare-before-delete guard
/// is the load-bearing correctness requirement.
enum KimiOAuthRefreshCoordinator {

    private static let providerName = "Kimi"

    /// Classify a refresh error as "refresh token itself invalid" (revoked /
    /// reused / expired → mark for re-login) vs transient (network → keep).
    /// Pure + in the test target so both the coordinator and its tests share
    /// one classification.
    /// Only an explicit OAuth error code counts; a bare HTTP status or a body
    /// that merely mentions "refresh_token" stays transient.
    static let fatalErrorCodes: Set<String> = [
        "invalid_grant", "invalid_token", "invalid_request",
        "unauthorized_client", "refresh_token_reused", "expired_token",
    ]

    static func isRefreshTokenInvalid(_ error: LLMError) -> Bool {
        OAuthRefreshErrorClassifier.isTokenInvalid(error, fatalErrorCodes: fatalErrorCodes)
    }

    /// Decide what storage to use (or whether to mark the instance for re-login) after a
    /// refresh attempt threw `error`.
    ///
    /// Critical guard — *compare-before-delete*: on a token-invalid error we
    /// mark the instance for re-login ONLY when the currently-persisted refresh token
    /// is still the one we failed with. If a concurrent refresh already rotated
    /// it, this request is stale and returning `current` preserves the
    /// freshly-written token instead of wiping it.
    static func resolveAfterRefreshFailure(
        staleRefreshToken: String,
        existingStorage: KimiTokenStorage,
        error: Error,
        isFatal: (LLMError) -> Bool,
        loadCurrent: () -> KimiTokenStorage?,
        markNeedsReauth: () -> Void,
        log: ((String) -> Void)? = nil
    ) throws -> KimiTokenStorage {
        // Re-load the latest persisted state — a concurrent winner may have
        // rotated the token while we were awaiting.
        let current = loadCurrent()

        if let llmError = error as? LLMError, isFatal(llmError) {
            if let current, current.refreshToken != staleRefreshToken {
                log?("Stale invalid_grant ignored — token already rotated; keeping new credentials")
                return current
            }
            let summary = OAuthRefreshErrorClassifier.userFacingSummary(llmError)
            // [T-oauth-keep-credentials] Never delete on a rejected refresh: the
            // classifier can misread a transient reply and a wiped credential
            // cannot be recovered. Mark the instance (UI shows 需要重新登录,
            // routing skips it); a new credential lapses the mark, and only an
            // explicit sign-out removes the blob.
            log?("Refresh token invalid, marking instance for re-login (credentials kept): \(summary)")
            markNeedsReauth()
            throw LLMError.invalidAPIKey(detail: String(localized: "\(providerName) sign-in has expired. Please sign in again.") + " (\(summary))")
        }

        // Non-fatal (network / transient). Prefer whatever is now stored (a
        // concurrent winner may have refreshed); else keep the caller's copy.
        let fallback = current ?? existingStorage
        let summary = OAuthRefreshErrorClassifier.userFacingSummary(error)
        log?("Refresh failed, keeping existing token: \(summary)")
        if fallback.isExpired {
            log?("Existing token is also expired — re-auth required")
            throw LLMError.invalidAPIKey(detail: String(localized: "Could not renew the \(providerName) sign-in right now. Check your connection and try again.") + " (\(summary))")
        }
        return fallback
    }
}
