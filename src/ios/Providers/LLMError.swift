import Foundation

enum LLMError: LocalizedError {
    case invalidAPIKey(detail: String = "")
    case networkError(underlying: Error)
    case providerError(message: String)
    /// Transient server-side errors (HTTP 500/502/503/504/529) that should be
    /// retried on the same model rather than triggering a group fallback.
    case transientError(message: String)
    case decodingError(underlying: Error)
    case rateLimited
    case cancelled
    case unknown(underlying: Error?)

    var errorDescription: String? {
        switch self {
        // Shown in the chat; AgentActivityFailureClassifier reads these words too.
        case .invalidAPIKey(let detail):
            return detail.isEmpty ? String(localized: "Invalid API key") : String(localized: "Invalid API key: \(detail)")
        case .networkError(let error):
            return String(localized: "Network error: \(error.localizedDescription)")
        case .providerError(let message):
            return String(localized: "Provider error: \(message)")
        case .transientError(let message):
            return String(localized: "Service temporarily unavailable: \(message)")
        case .decodingError(let error):
            return String(localized: "Decoding error: \(error.localizedDescription)")
        case .rateLimited:
            return String(localized: "Rate limited — please try again later")
        case .cancelled:
            return String(localized: "Request was cancelled")
        case .unknown(let error):
            return error.map { String(localized: "Unknown error: \($0.localizedDescription)") } ?? String(localized: "Unknown error")
        }
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
        case .rateLimited: return String(localized: "请求太频繁")
        case .invalidAPIKey: return String(localized: "API Key 无效")
        case .providerError(let msg): return String(localized: "服务商报错：\(String(msg.prefix(60)))")
        default: return String(localized: "出错")
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
