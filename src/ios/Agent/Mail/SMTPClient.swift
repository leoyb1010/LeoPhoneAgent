//
//  SMTPClient.swift
//  MinisApp
//
//  [T-mail-send] 发信用的最小 SMTP 客户端。
//
//  用 URLSessionStreamTask 而不是 NWConnection:iCloud、Outlook 只开 587 端口的 STARTTLS
//  (先明文握手,再升级 TLS),NWConnection 做不了中途升级。465 端口一开始就走 TLS。
//  两种方式下,账户密码都只在 TLS 建好之后才发;服务器不提供 STARTTLS 就直接失败,绝不明文登录。
//

import Foundation

enum SMTPSecurity: String, Codable, Equatable {
    /// 465:连上就是 TLS。
    case implicitTLS
    /// 587:明文 EHLO 后 STARTTLS 升级。
    case startTLS
}

struct SMTPServer: Equatable {
    var host: String
    var port: Int
    var security: SMTPSecurity
}

enum SMTPError: LocalizedError, Equatable {
    case connectFailed(String)
    case timeout(String)
    case tlsUnavailable
    case authFailed(String)
    case rejected(stage: String, code: Int, text: String)
    case protocolError(String)

    var errorDescription: String? {
        switch self {
        case .connectFailed(let why): return "连不上发信服务器:\(why)"
        case .timeout(let stage): return "发信服务器没有响应(\(stage))"
        case .tlsUnavailable: return "发信服务器不支持加密连接,为保护密码没有登录"
        case .authFailed(let text):
            return "发信登录被拒绝:\(text)。请确认已在邮箱设置里开启 SMTP,并使用授权码 / 应用专用密码。"
        case .rejected(let stage, let code, let text): return "发信被拒(\(stage),\(code)):\(text)"
        case .protocolError(let text): return "发信协议错误:\(text)"
        }
    }
}

/// 一条(可能多行的)SMTP 回复。纯逻辑。
struct SMTPReply: Equatable {
    var code: Int
    var lines: [String]

    var text: String { lines.joined(separator: " ") }
    var isPositive: Bool { (200..<400).contains(code) }

    /// 从缓冲里取出一条完整回复:"250-a" 是续行,"250 b" 是最后一行。不完整返回 nil。
    static func take(from buffer: inout [String]) -> SMTPReply? {
        var lines: [String] = []
        for (i, line) in buffer.enumerated() {
            guard line.count >= 3, let code = Int(line.prefix(3)) else {
                // 不合规的行:当成一条错误回复交出去,别卡住。
                buffer.removeFirst(i + 1)
                return SMTPReply(code: 0, lines: [line])
            }
            let sep = line.count > 3 ? line[line.index(line.startIndex, offsetBy: 3)] : " "
            lines.append(String(line.dropFirst(4)))
            if sep != "-" {
                buffer.removeFirst(i + 1)
                return SMTPReply(code: code, lines: lines)
            }
        }
        return nil
    }

    /// EHLO 回复里的扩展(大写):["PIPELINING", "AUTH PLAIN LOGIN", "STARTTLS", …]。
    var extensions: [String] { lines.dropFirst().map { $0.uppercased() } }

    func supportsAuth(_ mechanism: String) -> Bool {
        extensions.contains { line in
            (line.hasPrefix("AUTH ") || line.hasPrefix("AUTH=")) && line.dropFirst(5).split(separator: " ").contains { $0 == mechanism }
        }
    }
}

enum SMTPWire {
    /// DATA 段:以 "." 开头的行前面再加一个 "."(RFC 5321 §4.5.2),并以 CRLF.CRLF 结束。
    static func dataSection(_ message: Data) -> Data {
        var text = String(decoding: message, as: UTF8.self).replacingOccurrences(of: "\r\n", with: "\n")
        if text.hasSuffix("\n") { text.removeLast() }
        let stuffed = text.split(separator: "\n", omittingEmptySubsequences: false)
            .map { $0.hasPrefix(".") ? "." + $0 : String($0) }
            .joined(separator: "\r\n")
        return Data((stuffed + "\r\n.\r\n").utf8)
    }

    static func authPlain(username: String, password: String) -> String {
        Data(("\u{0}" + username + "\u{0}" + password).utf8).base64EncodedString()
    }

    /// 地址只能是纯地址:防止模型把 "a@b>\r\nRCPT TO:<c@d" 拼进命令。
    static func envelopeAddress(_ email: String) throws -> String {
        guard MailComposer.isValidAddress(email) else { throw SMTPError.protocolError("地址无效") }
        return "<\(email)>"
    }
}

actor SMTPClient {
    private let server: SMTPServer
    private var task: URLSessionStreamTask?
    private var pendingLines: [String] = []
    private var partial = Data()
    static let stepTimeout: TimeInterval = 30

    init(server: SMTPServer) {
        self.server = server
    }

    /// 连接、登录、投递一封信、退出。任何一步失败都抛错,连接随之关闭。
    func send(username: String, password: String, from: String, recipients: [String], message: Data) async throws {
        let session = URLSession(configuration: .ephemeral)
        let task = session.streamTask(withHostName: server.host, port: server.port)
        self.task = task
        defer { task.closeWrite(); task.closeRead(); task.cancel(); session.invalidateAndCancel() }
        task.resume()
        if server.security == .implicitTLS { task.startSecureConnection() }

        try await expect(220, stage: "连接")
        var ehlo = try await command("EHLO leobot.local", expect: 250, stage: "EHLO")
        if server.security == .startTLS {
            guard ehlo.extensions.contains(where: { $0 == "STARTTLS" }) else { throw SMTPError.tlsUnavailable }
            _ = try await command("STARTTLS", expect: 220, stage: "STARTTLS")
            task.startSecureConnection()
            pendingLines.removeAll(); partial.removeAll()
            ehlo = try await command("EHLO leobot.local", expect: 250, stage: "EHLO")
        }

        if ehlo.supportsAuth("PLAIN") || !ehlo.supportsAuth("LOGIN") {
            let reply = try await raw("AUTH PLAIN \(SMTPWire.authPlain(username: username, password: password))")
            guard reply.code == 235 else { throw SMTPError.authFailed(reply.text) }
        } else {
            let first = try await raw("AUTH LOGIN")
            guard first.code == 334 else { throw SMTPError.authFailed(first.text) }
            let second = try await raw(Data(username.utf8).base64EncodedString())
            guard second.code == 334 else { throw SMTPError.authFailed(second.text) }
            let done = try await raw(Data(password.utf8).base64EncodedString())
            guard done.code == 235 else { throw SMTPError.authFailed(done.text) }
        }

        _ = try await command("MAIL FROM:\(try SMTPWire.envelopeAddress(from))", expect: 250, stage: "MAIL FROM")
        for rcpt in recipients {
            let reply = try await raw("RCPT TO:\(try SMTPWire.envelopeAddress(rcpt))")
            guard reply.code == 250 || reply.code == 251 else {
                throw SMTPError.rejected(stage: "收件人 \(rcpt)", code: reply.code, text: reply.text)
            }
        }
        _ = try await command("DATA", expect: 354, stage: "DATA")
        try await write(SMTPWire.dataSection(message))
        try await expect(250, stage: "投递")
        _ = try? await raw("QUIT")
    }

    // MARK: - Plumbing

    private func command(_ line: String, expect code: Int, stage: String) async throws -> SMTPReply {
        let reply = try await raw(line)
        guard reply.code == code else { throw SMTPError.rejected(stage: stage, code: reply.code, text: reply.text) }
        return reply
    }

    private func raw(_ line: String) async throws -> SMTPReply {
        try await write(Data((line + "\r\n").utf8))
        return try await readReply(stage: line.split(separator: " ").first.map(String.init) ?? "")
    }

    private func expect(_ code: Int, stage: String) async throws {
        let reply = try await readReply(stage: stage)
        guard reply.code == code else { throw SMTPError.rejected(stage: stage, code: reply.code, text: reply.text) }
    }

    private func write(_ data: Data) async throws {
        guard let task else { throw SMTPError.connectFailed("连接已关闭") }
        do {
            try await task.write(data, timeout: Self.stepTimeout)
        } catch {
            throw SMTPError.connectFailed(error.localizedDescription)
        }
    }

    private func readReply(stage: String) async throws -> SMTPReply {
        guard let task else { throw SMTPError.connectFailed("连接已关闭") }
        let deadline = Date().addingTimeInterval(Self.stepTimeout)
        while true {
            if let reply = SMTPReply.take(from: &pendingLines) { return reply }
            guard Date() < deadline else { throw SMTPError.timeout(stage) }
            let (data, atEOF): (Data?, Bool)
            do {
                (data, atEOF) = try await task.readData(ofMinLength: 1, maxLength: 64 * 1024,
                                                        timeout: max(1, deadline.timeIntervalSinceNow))
            } catch {
                throw SMTPError.connectFailed(error.localizedDescription)
            }
            if let data { partial.append(data) }
            while let r = partial.range(of: Data("\r\n".utf8)) {
                pendingLines.append(String(decoding: partial[partial.startIndex..<r.lowerBound], as: UTF8.self))
                partial.removeSubrange(partial.startIndex..<r.upperBound)
            }
            if atEOF {
                if let reply = SMTPReply.take(from: &pendingLines) { return reply }
                throw SMTPError.connectFailed("服务器断开了连接(\(stage))")
            }
        }
    }
}
