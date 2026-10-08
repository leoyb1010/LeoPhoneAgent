import Foundation

/// [T-opencode-dedicated-channel] A thread-safe cell holding the conversation id that
/// requests should carry (OpenCode Go's `x-opencode-session`, the prompt cache key).
///
/// Exists because the two sides live on different isolation domains: the chat view
/// model's `sessionId` is MainActor state, while request assembly runs wherever the
/// provider builds the request. The view model writes it from `sessionId.didSet` (the
/// single choke point every draft→session promotion flows through) and the request
/// builders read it under the lock, so a promotion that lands after the provider was
/// built is picked up by the very next request — no provider rebuild, no snapshot.
final class ConversationSessionBox: @unchecked Sendable {
    private let lock = NSLock()
    private var _value: String?

    init(_ initial: String? = nil) { _value = initial }

    var value: String? {
        get { lock.lock(); defer { lock.unlock() }; return _value }
        set { lock.lock(); _value = newValue; lock.unlock() }
    }
}

/// OpenCode Go's session header rules, kept pure so the logic tests cover them.
enum OpenCodeSessionHeader {
    /// Prefix of the placeholder key a draft conversation uses before its row exists.
    static let draftSessionPrefix = "__new__"

    /// A usable conversation id, or nil. Rejects empty strings and the `__new__…` draft
    /// placeholder: keying the upstream cache on an id that is about to be replaced
    /// reads one conversation as two — the exact thing the header exists to prevent.
    static func normalizedSessionId(_ raw: String?) -> String? {
        guard let s = raw?.trimmingCharacters(in: .whitespacesAndNewlines),
              !s.isEmpty, !s.hasPrefix(draftSessionPrefix) else { return nil }
        return s
    }

    /// The id to send on THIS request: the live conversation id when there is one,
    /// otherwise a per-provider fallback (Go answers 400 `MissingSessionID` to a request
    /// without the header, so calls outside a conversation — connection test, title
    /// generation — still need a stable id for the provider's lifetime).
    static func resolve(live: String?, fallback: String) -> String {
        normalizedSessionId(live) ?? fallback
    }
}
