//
//  MCPWireSafety.swift
//  MinisApp
//
//  [B17] Pure rules for the native MCP client (NativeMCPClient), compiled into
//  MinisTests: which redirects may be followed with the server's credentials
//  attached, and which JSON-RPC message is the reply to a given request.
//

import Foundation

enum MCPWireSafety {
    /// A redirect is followed only to the same scheme, host and port. URLSession
    /// would otherwise resend the request — Authorization / API-key headers
    /// included — to whatever host the server names.
    static func allowsRedirect(from original: URL?, to target: URL?) -> Bool {
        guard let original, let target,
              let fromScheme = original.scheme?.lowercased(), let toScheme = target.scheme?.lowercased(),
              let fromHost = original.host?.lowercased(), let toHost = target.host?.lowercased() else {
            return false
        }
        return fromScheme == toScheme && fromHost == toHost
            && effectivePort(original) == effectivePort(target)
    }

    private static func effectivePort(_ url: URL) -> Int? {
        if let port = url.port { return port }
        switch url.scheme?.lowercased() {
        case "https": return 443
        case "http": return 80
        default: return nil
        }
    }

    /// JSON-RPC ids are echoed as sent, but servers differ on number vs string
    /// ("1" for 1); both forms match. A JSON boolean never does.
    static func idMatches(_ responseId: Any?, requestId: Int) -> Bool {
        if let s = responseId as? String { return s == String(requestId) }
        if let n = responseId as? NSNumber {
            if CFGetTypeID(n) == CFBooleanGetTypeID() { return false }
            return n.doubleValue == Double(requestId)
        }
        return false
    }

    /// Whether `envelope` answers request `requestId`. An error envelope with a
    /// null / missing id (the server could not read our id) still counts, so
    /// its message is reported rather than swallowed.
    static func isReply(_ envelope: [String: Any], to requestId: Int) -> Bool {
        guard envelope["result"] != nil || envelope["error"] != nil else { return false }
        if idMatches(envelope["id"], requestId: requestId) { return true }
        let id = envelope["id"]
        return envelope["error"] != nil && (id == nil || id is NSNull)
    }

    /// The reply to `requestId` in an SSE body: the first `data:` payload that
    /// is a JSON-RPC response with that id (progress notifications and
    /// server-initiated requests are skipped).
    static func replyFromSSE(_ data: Data, requestId: Int) -> [String: Any]? {
        guard let text = String(data: data, encoding: .utf8) else { return nil }
        for line in text.split(whereSeparator: \.isNewline) {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            guard trimmed.hasPrefix("data:") else { continue }
            let payload = trimmed.dropFirst(5).trimmingCharacters(in: .whitespaces)
            guard payload != "[DONE]", let d = payload.data(using: .utf8),
                  let obj = try? JSONSerialization.jsonObject(with: d) as? [String: Any] else { continue }
            if isReply(obj, to: requestId) { return obj }
        }
        return nil
    }

    /// Text of a JSON-RPC `error` member, whatever shape the server sent.
    static func errorMessage(_ error: Any) -> String {
        if let dict = error as? [String: Any], let message = dict["message"] as? String, !message.isEmpty {
            return message
        }
        return String(String(describing: error).prefix(500))
    }
}

/// Refuses cross-host redirects for the native MCP client's session.
final class MCPRedirectGuard: NSObject, URLSessionTaskDelegate, Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest) async -> URLRequest? {
        let original = task.originalRequest?.url ?? task.currentRequest?.url
        return MCPWireSafety.allowsRedirect(from: original, to: request.url) ? request : nil
    }
}
