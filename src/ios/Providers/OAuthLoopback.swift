import Foundation
import UIKit
import os.log

private let logger = AppLogger(category: "OAuthLoopback")

/// Masks a credential for on-screen display: only the first and last 4
/// characters stay visible, never more than a quarter of the token.
enum OAuthTokenMask {
    static func mask(_ token: String) -> String {
        let len = token.count
        guard len > 12 else { return String(repeating: "•", count: min(len, 8)) }
        let edge = min(4, len / 4)
        return "\(token.prefix(edge))••••••••\(token.suffix(edge))"
    }
}

/// Copies a secret to the local pasteboard only: never offered to Universal
/// Clipboard / other devices, and cleared automatically after `expiry`.
enum SecretPasteboard {
    static func copy(_ secret: String, expiry: TimeInterval = 60) {
        UIPasteboard.general.setItems(
            [[UIPasteboard.typeAutomatic: secret]],
            options: [
                .localOnly: true,
                .expirationDate: Date().addingTimeInterval(expiry),
            ]
        )
    }
}

struct OAuthCallbackResult {
    let code: String
    let state: String?
}

/// Minimal loopback HTTP server that receives the OAuth redirect.
/// Bound to 127.0.0.1 only; each connection gets a short read timeout so a
/// silent client cannot stall the accept loop.
final class OAuthCallbackServer: @unchecked Sendable {

    private let port: UInt16
    private let callbackPath: String
    /// Lowercased hosts allowed to trigger a CORS preflight (OPTIONS) reply.
    /// Empty set → OPTIONS requests get a `null` origin.
    private let optionsCORSAllowedHosts: Set<String>
    private var listenSocket: Int32 = -1
    private var continuation: CheckedContinuation<OAuthCallbackResult, Error>?
    private let queue = DispatchQueue(label: "oauth.callback.server")
    private var stopped = false

    init(
        port: UInt16,
        callbackPath: String = "/callback",
        optionsCORSAllowedHosts: Set<String> = []
    ) {
        self.port = port
        self.callbackPath = callbackPath
        self.optionsCORSAllowedHosts = Set(optionsCORSAllowedHosts.map { $0.lowercased() })
    }

    func start() throws {
        let fd = socket(AF_INET, SOCK_STREAM, 0)
        guard fd >= 0 else {
            throw LLMError.providerError(message: String(localized: "Could not start the sign-in callback listener."))
        }

        var reuse: Int32 = 1
        setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &reuse, socklen_t(MemoryLayout<Int32>.size))

        var addr = sockaddr_in()
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = port.bigEndian
        addr.sin_addr.s_addr = inet_addr("127.0.0.1")

        let bindResult = withUnsafePointer(to: &addr) { ptr in
            ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sockPtr in
                bind(fd, sockPtr, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        guard bindResult == 0 else {
            let err = errno
            close(fd)
            logger.error("[Server] bind port \(self.port) failed errno=\(err)")
            throw LLMError.providerError(message: String(localized: "Port \(Int(port)) is in use. Close other sign-in windows and try again."))
        }

        guard listen(fd, 4) == 0 else {
            close(fd)
            throw LLMError.providerError(message: String(localized: "Could not start the sign-in callback listener."))
        }

        self.listenSocket = fd
        logger.info("[Server] Listening on 127.0.0.1:\(self.port)")

        queue.async { [weak self] in
            self?.acceptLoop()
        }
    }

    func waitForCallback(timeout: TimeInterval) async throws -> OAuthCallbackResult {
        try await withCheckedThrowingContinuation { cont in
            self.continuation = cont

            queue.asyncAfter(deadline: .now() + timeout) { [weak self] in
                guard let self, !self.stopped else { return }
                self.stopped = true
                logger.error("[Server] Callback timeout after \(timeout)s")
                self.continuation = nil
                cont.resume(throwing: LLMError.providerError(message: String(localized: "Sign-in timed out. Please try again.")))
            }
        }
    }

    func stop() {
        // Close the listen socket OUTSIDE queue.sync: acceptLoop blocks in
        // accept() on `queue`, so closing first makes accept() return and
        // frees the queue for the critical section below.
        let fdToClose = listenSocket
        listenSocket = -1
        if fdToClose >= 0 {
            close(fdToClose)
            logger.info("[Server] Stopped (listen socket closed)")
        }

        // Serialized against handleCallback so a Safari dismiss racing a
        // successful redirect does not report the flow as cancelled.
        queue.sync {
            let wasStopped = stopped
            stopped = true
            if !wasStopped, let cont = continuation {
                continuation = nil
                cont.resume(throwing: LLMError.providerError(message: "OAuth callback cancelled"))
            }
        }
    }

    // MARK: - Private

    private func acceptLoop() {
        while !stopped && listenSocket >= 0 {
            var clientAddr = sockaddr_in()
            var addrLen = socklen_t(MemoryLayout<sockaddr_in>.size)

            let clientFd = withUnsafeMutablePointer(to: &clientAddr) { ptr in
                ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sockPtr in
                    accept(listenSocket, sockPtr, &addrLen)
                }
            }

            guard clientFd >= 0 else { break }
            handleConnection(clientFd)
        }
    }

    private func handleConnection(_ fd: Int32) {
        defer { close(fd) }

        var timeout = timeval(tv_sec: 5, tv_usec: 0)
        setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
        setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
        var noSigPipe: Int32 = 1
        setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &noSigPipe, socklen_t(MemoryLayout<Int32>.size))

        var buffer = [UInt8](repeating: 0, count: 8192)
        let bytesRead = read(fd, &buffer, buffer.count)
        guard bytesRead > 0 else { return }

        let requestString = String(bytes: buffer[0..<bytesRead], encoding: .utf8) ?? ""
        let lines = requestString.split(separator: "\r\n", omittingEmptySubsequences: false)
        guard let firstLine = lines.first else { return }

        let parts = firstLine.split(separator: " ")
        guard parts.count >= 2 else { return }
        let method = String(parts[0]).uppercased()
        let path = String(parts[1])
        logger.info("[Server] Request: \(method) \(path.split(separator: "?").first.map(String.init) ?? "")")

        if method == "OPTIONS" {
            handleOptionsPreflight(fd: fd, headerLines: lines.dropFirst())
            return
        }

        if path == callbackPath || path.hasPrefix(callbackPath + "?") {
            handleCallback(fd: fd, path: path)
        } else {
            writeResponse(fd, "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
        }
    }

    /// Some providers (e.g. xAI auth.x.ai) probe the redirect_uri with a CORS
    /// preflight; only explicitly trusted origins are echoed back.
    private func handleOptionsPreflight(fd: Int32, headerLines: ArraySlice<Substring>) {
        var origin: String?
        for line in headerLines {
            if line.isEmpty { break }
            let kv = line.split(separator: ":", maxSplits: 1, omittingEmptySubsequences: false)
            guard kv.count == 2 else { continue }
            if kv[0].trimmingCharacters(in: .whitespaces).lowercased() == "origin" {
                origin = kv[1].trimmingCharacters(in: .whitespaces)
                break
            }
        }
        let allowOrigin: String
        if !optionsCORSAllowedHosts.isEmpty,
           let originStr = origin,
           let originHost = URL(string: originStr)?.host?.lowercased(),
           optionsCORSAllowedHosts.contains(originHost) {
            allowOrigin = originStr
        } else {
            allowOrigin = "null"
        }
        writeResponse(fd, "HTTP/1.1 204 No Content\r\n" +
            "Access-Control-Allow-Origin: \(allowOrigin)\r\n" +
            "Access-Control-Allow-Methods: GET, OPTIONS\r\n" +
            "Access-Control-Allow-Headers: *\r\n" +
            "Access-Control-Max-Age: 600\r\n" +
            "Content-Length: 0\r\n" +
            "Connection: close\r\n\r\n")
    }

    private func handleCallback(fd: Int32, path: String) {
        guard let components = URLComponents(string: "http://127.0.0.1\(path)") else {
            sendErrorPage(fd: fd, message: "Invalid callback URL")
            return
        }

        let queryItems = components.queryItems ?? []
        let code = queryItems.first(where: { $0.name == "code" })?.value
        let state = queryItems.first(where: { $0.name == "state" })?.value

        logger.info("[Server] Callback — code present: \(code != nil), state present: \(state != nil)")

        guard let code, !code.isEmpty else {
            let errorMsg = queryItems.first(where: { $0.name == "error" })?.value ?? "no code"
            logger.error("[Server] Callback error: \(errorMsg)")
            sendErrorPage(fd: fd, message: errorMsg)
            continuation?.resume(throwing: LLMError.providerError(message: String(localized: "Sign-in was not completed (\(errorMsg)).")))
            continuation = nil
            return
        }

        sendSuccessPage(fd: fd)

        stopped = true
        continuation?.resume(returning: OAuthCallbackResult(code: code, state: state))
        continuation = nil
    }

    private func sendSuccessPage(fd: Int32) {
        let html = """
        <!DOCTYPE html>
        <html>
        <head><meta charset="utf-8"><title>Authorization Successful</title>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
            body { font-family: -apple-system, sans-serif; display: flex;
                   justify-content: center; align-items: center; height: 100vh;
                   margin: 0; background: #f5f5f7; }
            .card { text-align: center; padding: 40px; background: white;
                    border-radius: 16px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
            h1 { color: #1a1a1a; font-size: 24px; }
            p { color: #666; margin-top: 8px; }
        </style>
        </head>
        <body>
        <div class="card">
            <h1>Authorization Successful</h1>
            <p>You can close this tab and return to the app.</p>
        </div>
        </body>
        </html>
        """
        writeResponse(fd, "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: \(html.utf8.count)\r\nConnection: close\r\n\r\n\(html)")
    }

    private func sendErrorPage(fd: Int32, message: String) {
        let html = "<!DOCTYPE html><html><head><meta charset=\"utf-8\"></head><body><h1>Authorization Failed</h1><p>\(Self.htmlEscaped(message))</p></body></html>"
        writeResponse(fd, "HTTP/1.1 400 Bad Request\r\nContent-Type: text/html; charset=utf-8\r\nX-Content-Type-Options: nosniff\r\nContent-Length: \(html.utf8.count)\r\nConnection: close\r\n\r\n\(html)")
    }

    private func writeResponse(_ fd: Int32, _ response: String) {
        _ = response.withCString { write(fd, $0, strlen($0)) }
    }

    static func htmlEscaped(_ s: String) -> String {
        var out = ""
        out.reserveCapacity(s.count)
        for ch in s {
            switch ch {
            case "&": out += "&amp;"
            case "<": out += "&lt;"
            case ">": out += "&gt;"
            case "\"": out += "&quot;"
            case "'": out += "&#39;"
            default: out.append(ch)
            }
        }
        return out
    }
}
