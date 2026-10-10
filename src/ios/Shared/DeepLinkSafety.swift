import Foundation

/// Validation for values that arrive in a `leophoneagent://` link. A link can
/// come from anywhere (a web page, a message, a model reply), so it may
/// navigate and prefill, but it never names a path outside its scope, never
/// executes, and never supplies a secret.
enum DeepLinkSafety {
    enum WebAppScope: Equatable { case sessionAttachment, sessionWorkspace, shared, mount }

    struct WebAppLaunch: Equatable {
        let scope: WebAppScope
        /// Session id (session scopes) or mount UUID (mount scope).
        let context: String?
        let htmlPath: String
    }

    /// A session id as this app writes them (UUIDs) or a conservative safe
    /// name; never a path.
    static func isSafeSessionId(_ raw: String) -> Bool {
        if UUID(uuidString: raw) != nil { return true }
        return raw.range(of: #"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$"#, options: .regularExpression) != nil
            && !raw.contains("..")
    }

    /// Relative path inside a scope: no `..`/`.` segments, no absolute or
    /// backslash forms, no control characters.
    static func isSafeRelativePath(_ raw: String) -> Bool {
        guard !raw.isEmpty, raw.utf8.count <= 1024, !raw.hasPrefix("/"), !raw.contains("\\") else { return false }
        if raw.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) { return false }
        return !raw.split(separator: "/", omittingEmptySubsequences: false).contains { $0 == ".." || $0 == "." }
    }

    /// `open?session=…&path=…` from the home-screen web app tile.
    static func parseWebAppLaunch(session: String?, rawPath: String) -> WebAppLaunch? {
        func sessionScoped(_ prefix: String, _ scope: WebAppScope) -> WebAppLaunch? {
            guard let sid = session, isSafeSessionId(sid) else { return nil }
            let rest = String(rawPath.dropFirst(prefix.count))
            guard isSafeRelativePath(rest) else { return nil }
            return WebAppLaunch(scope: scope, context: sid, htmlPath: rest)
        }
        if rawPath.hasPrefix("attachments/") { return sessionScoped("attachments/", .sessionAttachment) }
        if rawPath.hasPrefix("workspace/") { return sessionScoped("workspace/", .sessionWorkspace) }
        if rawPath.hasPrefix("shared:") {
            let rest = String(rawPath.dropFirst("shared:".count))
            guard isSafeRelativePath(rest) else { return nil }
            return WebAppLaunch(scope: .shared, context: nil, htmlPath: rest)
        }
        if rawPath.hasPrefix("mount:") {
            let rest = rawPath.dropFirst("mount:".count)
            guard let slash = rest.firstIndex(of: "/") else { return nil }
            let mountId = String(rest[..<slash])
            let path = String(rest[rest.index(after: slash)...])
            guard UUID(uuidString: mountId) != nil, isSafeRelativePath(path) else { return nil }
            return WebAppLaunch(scope: .mount, context: mountId, htmlPath: path)
        }
        return nil
    }

    /// `settings/environments?create_key=…` opens the add form with the NAME
    /// (and note) filled in. A value in the link is ignored: a link must never
    /// plant a credential for the user to save with one tap.
    static func envVarPrefill(_ items: [URLQueryItem]) -> (key: String, note: String)? {
        guard let key = items.first(where: { $0.name == "create_key" })?.value?
            .trimmingCharacters(in: .whitespacesAndNewlines), !key.isEmpty else { return nil }
        let note = items.first(where: { $0.name == "create_note" })?.value ?? ""
        return (String(key.prefix(256)), String(stripControls(note).prefix(500)))
    }

    /// `open_terminal?init_command=…` only prefills: a `%0A` in the link must
    /// not press Return for the user.
    static func terminalPrefill(_ raw: String?) -> String? {
        raw.map { String(stripControls($0).prefix(4096)) }
    }

    private static func stripControls(_ s: String) -> String {
        String(String.UnicodeScalarView(s.unicodeScalars.filter { !CharacterSet.controlCharacters.contains($0) }))
    }
}
