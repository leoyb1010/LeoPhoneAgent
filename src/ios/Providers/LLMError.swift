import Foundation

enum LLMError: LocalizedError {
    case invalidAPIKey(detail: String = "")
    case networkError(underlying: Error)
    case providerError(message: String)
    /// Transient server-side errors (HTTP 500/502/503/504/529) that should be
    /// retried on the same model rather than triggering a group fallback.
    /// [T-fallback-503-budget] `statusCode` is the HTTP status the mapping site saw on
    /// the real response — nil for statusless transients (dropped link, TTFB stall,
    /// empty response). Structural, never parsed out of a body that may mention "503".
    case transientError(message: String, statusCode: Int? = nil)
    case decodingError(underlying: Error)
    case rateLimited
    case cancelled
    case unknown(underlying: Error?)

    var errorDescription: String? {
        switch self {
        // Shown in the chat; AgentActivityFailureClassifier reads these words too.
        case .invalidAPIKey(let detail):
            return detail.isEmpty ? AppLocalized("Invalid API key") : AppLocalized("Invalid API key: \(detail)")
        case .networkError(let error):
            return AppLocalized("Network error: \(error.localizedDescription)")
        case .providerError(let message):
            return AppLocalized("Provider error: \(message)")
        case .transientError(let message, _):
            return AppLocalized("Service temporarily unavailable: \(message)")
        case .decodingError(let error):
            return AppLocalized("Decoding error: \(error.localizedDescription)")
        case .rateLimited:
            return AppLocalized("Rate limited — please try again later")
        case .cancelled:
            return AppLocalized("Request was cancelled")
        case .unknown(let error):
            return error.map { AppLocalized("Unknown error: \($0.localizedDescription)") } ?? AppLocalized("Unknown error")
        }
    }

    /// [T-fallback-503-budget] The HTTP status behind a transient, when the server
    /// produced one. nil for every other case.
    var httpStatusCode: Int? {
        if case .transientError(_, let code) = self { return code }
        return nil
    }

    /// A 5xx the SERVER answered with: this deployment has no capacity right now, and
    /// another group member probably does — so retry briefly, then fall back.
    var isServerCapacityTransient: Bool {
        guard let code = httpStatusCode else { return false }
        return (500...599).contains(code)
    }

    var isNetworkError: Bool {
        if case .networkError = self { return true }
        return false
    }

    /// Errors that should be retried with countdown on the same provider.
    /// Includes both network errors and transient server-side errors (5xx).
    var isRetryable: Bool {
        switch self {
        case .networkError, .transientError:
            return true
        case .invalidAPIKey, .providerError, .decodingError, .rateLimited, .cancelled, .unknown:
            return false
        }
    }

    /// Errors that indicate the provider itself cannot serve this request
    /// (rate limit, invalid key, permanent provider-side rejection). These trigger
    /// an immediate fallback to the next model in a group, without retry countdown.
    ///
    /// Note: transientError and networkError are also fallbackable — after
    /// auto-retry is exhausted on the current model, group fallback kicks in.
    var fallbackReason: String {
        switch self {
        case .rateLimited: return AppLocalized("请求太频繁")
        case .invalidAPIKey: return AppLocalized("API Key 无效")
        case .providerError(let msg): return AppLocalized("服务商报错：\(String(msg.prefix(60)))")
        default: return AppLocalized("出错")
        }
    }

    var isFallbackable: Bool {
        switch self {
        case .rateLimited, .invalidAPIKey, .providerError:
            return true
        case .transientError, .networkError, .decodingError, .cancelled, .unknown:
            return false
        }
    }
}
