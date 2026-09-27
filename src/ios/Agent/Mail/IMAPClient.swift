//
//  IMAPClient.swift
//  MinisApp
//
//  [T-mail] 最小 IMAP4rev1 客户端(RFC 3501),Network.framework 直连 TLS(993)。
//  只做读邮件需要的几条命令:LOGIN / AUTHENTICATE PLAIN、ID、LIST、STATUS、EXAMINE、
//  UID SEARCH、UID FETCH(BODY.PEEK,不改已读)、LOGOUT。
//  一次工具调用开一条连接、用完关掉;没有连接池,也不缓存邮件。
//

import Foundation
import Network

enum IMAPError: LocalizedError {
    case connectFailed(String)
    case timeout(String)
    case closed
    case loginRejected(String)
    case serverNo(command: String, message: String)
    case serverBad(command: String, message: String)
    case protocolError(String)

    var errorDescription: String? {
        switch self {
        case .connectFailed(let why): return "连不上邮件服务器:\(why)"
        case .timeout(let what): return "邮件服务器没有响应(\(what))"
        case .closed: return "连接已断开"
        case .loginRejected(let msg):
            return "登录被拒绝:\(msg)。请确认填的是邮箱设置里生成的「授权码 / 应用专用密码」,不是网页登录密码;并确认已开启 IMAP 服务。"
        case .serverNo(let command, let msg): return "\(command) 失败:\(msg)"
        case .serverBad(let command, let msg): return "服务器不接受 \(command):\(msg)"
        case .protocolError(let msg): return "协议错误:\(msg)"
        }
    }
}

struct IMAPMailbox: Equatable {
    var rawName: String
    var name: String
    var attributes: [String]
    var delimiter: String?
}

struct IMAPMessageSummary: Equatable {
    var uid: Int
    var flags: [String]
    var size: Int
    var internalDate: String?
    var subject: String
    var from: [MailAddress]
    var to: [MailAddress]
    var date: Date?
    var messageId: String

    var isUnread: Bool { !flags.contains(where: { $0.caseInsensitiveCompare("\\Seen") == .orderedSame }) }
}

enum IMAPSearchTerm {
    case keyword(String)                 // ALL / UNSEEN / …
    case since(Date)                     // SINCE dd-MMM-yyyy
    case field(String, String)           // FROM "x" / SUBJECT "x" / TEXT "x"
}

/// 只允许 resume 一次的续体(NWConnection 的状态回调会连发几次)。
private final class ResumeOnce: @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<Void, Error>?
    init(_ continuation: CheckedContinuation<Void, Error>) { self.continuation = continuation }
    func resume(_ error: Error?) {
        lock.lock()
        let cont = continuation
        continuation = nil
        lock.unlock()
        guard let cont else { return }
        if let error { cont.resume(throwing: error) } else { cont.resume() }
    }
}

actor IMAPClient {
    struct ClientID {
        var name = "LeoPhoneAgent"
        var version = (Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String) ?? "1.0"
        var vendor = "leoyuan"
    }

    private let host: String
    private let port: UInt16
    private var connection: NWConnection?
    private var buffer = Data()
    private var tagCounter = 0
    private let queue = DispatchQueue(label: "imap.\(UUID().uuidString.prefix(8))")
    private(set) var capabilities: Set<String> = []
    /// 已登录后 EXAMINE 过的邮箱,避免重复选。
    private var examined: String?

    static let commandTimeout: TimeInterval = 45
    static let connectTimeout: TimeInterval = 20

    init(host: String, port: UInt16) {
        self.host = host
        self.port = port
    }

    // MARK: - Connection

    func connect() async throws {
        let tls = NWProtocolTLS.Options()
        let tcp = NWProtocolTCP.Options()
        tcp.connectionTimeout = Int(Self.connectTimeout)
        let params = NWParameters(tls: tls, tcp: tcp)
        guard let nwPort = NWEndpoint.Port(rawValue: port) else { throw IMAPError.connectFailed("端口无效") }
        let conn = NWConnection(host: NWEndpoint.Host(host), port: nwPort, using: params)
        connection = conn
        let queue = self.queue
        try await withTimeout(Self.connectTimeout, label: "连接") {
            try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
                let once = ResumeOnce(cont)
                conn.stateUpdateHandler = { state in
                    switch state {
                    case .ready:
                        once.resume(nil)
                    case .failed(let error):
                        once.resume(IMAPError.connectFailed(error.localizedDescription))
                    case .waiting(let error):
                        // 没网 / DNS 失败会一直 waiting,不等它自己超时
                        conn.cancel()
                        once.resume(IMAPError.connectFailed(error.localizedDescription))
                    case .cancelled:
                        once.resume(IMAPError.closed)
                    default: break
                    }
                }
                conn.start(queue: queue)
            }
        }
        conn.stateUpdateHandler = nil
        let greeting = try await readResponse(timeout: Self.connectTimeout)
        guard greeting.kind == .untagged, let name = greeting.untaggedName, name == "OK" || name == "PREAUTH" else {
            throw IMAPError.protocolError("服务器问候异常:\(greeting.line.prefix(120))")
        }
        parseCapabilities(from: greeting)
    }

    func close() {
        if let conn = connection {
            let bye = Data("Z999 LOGOUT\r\n".utf8)
            conn.send(content: bye, completion: .contentProcessed { _ in conn.cancel() })
        }
        connection = nil
    }

    // MARK: - Auth

    /// LOGIN;被拒时再试 AUTHENTICATE PLAIN(有的服务器只开其中一种)。
    func login(username: String, password: String, clientID: ClientID? = ClientID()) async throws {
        if let clientID, capabilities.isEmpty || capabilities.contains("ID") {
            // 网易(163 / 126)要求客户端先自报家门,否则 SELECT 回 "Unsafe Login"。失败不影响后续。
            let fields = ["name", clientID.name, "version", clientID.version, "vendor", clientID.vendor]
                .map { "\"\($0)\"" }.joined(separator: " ")
            _ = try? await command("ID (\(fields))")
        }
        let (status, text, _) = try await command("LOGIN \(quoted(username)) \(quoted(password))")
        if status == "OK" { return }
        if capabilities.isEmpty || capabilities.contains("AUTH=PLAIN") {
            let plain = Data(("\u{0}" + username + "\u{0}" + password).utf8).base64EncodedString()
            let (status2, _, _) = try await command("AUTHENTICATE PLAIN", continuations: [Data(plain.utf8)])
            if status2 == "OK" { return }
        }
        throw IMAPError.loginRejected(text.isEmpty ? "服务器没有说明原因" : text)
    }

    // MARK: - Mailboxes

    func listMailboxes() async throws -> [IMAPMailbox] {
        let (_, _, untagged) = try await command("LIST \"\" \"*\"", expectOK: true)
        var boxes: [IMAPMailbox] = []
        for response in untagged where response.untaggedName == "LIST" {
            // * LIST (\HasNoChildren) "/" "INBOX"
            guard response.items.count >= 4 else { continue }
            let attrs = response.items[1].listValue?.compactMap(\.stringValue) ?? []
            let delimiter = response.items[2].stringValue
            guard let raw = response.items[3].stringValue else { continue }
            if attrs.contains(where: { $0.caseInsensitiveCompare("\\Noselect") == .orderedSame }) { continue }
            boxes.append(IMAPMailbox(rawName: raw, name: IMAPModifiedUTF7.decode(raw), attributes: attrs, delimiter: delimiter))
        }
        return boxes
    }

    func status(mailbox: String) async throws -> (messages: Int, unseen: Int) {
        let (_, _, untagged) = try await command("STATUS \(quoted(mailboxWireName(mailbox))) (MESSAGES UNSEEN)", expectOK: true)
        guard let response = untagged.first(where: { $0.untaggedName == "STATUS" }),
              let list = response.items.last?.listValue else { return (0, 0) }
        var messages = 0, unseen = 0
        var i = 0
        while i + 1 < list.count {
            if case .atom(let key) = list[i], let n = list[i + 1].intValue {
                if key.uppercased() == "MESSAGES" { messages = n }
                if key.uppercased() == "UNSEEN" { unseen = n }
            }
            i += 2
        }
        return (messages, unseen)
    }

    /// 只读打开(EXAMINE),返回邮件总数。
    @discardableResult
    func examine(mailbox: String) async throws -> Int {
        let wire = mailboxWireName(mailbox)
        let (_, _, untagged) = try await command("EXAMINE \(quoted(wire))", expectOK: true)
        examined = wire
        return untagged.first(where: { $0.untaggedName == "EXISTS" })?.untaggedNumber ?? 0
    }

    // MARK: - Search / fetch

    /// UID SEARCH。非 ASCII 条件带 CHARSET UTF-8 并以字面量发送;服务器不吃 UTF-8 时抛 serverBad/serverNo,
    /// 由调用方退回客户端过滤。
    func uidSearch(_ terms: [IMAPSearchTerm]) async throws -> [Int] {
        var parts: [String] = []
        var continuations: [Data] = []
        var needsUTF8 = false
        let dateFormatter = DateFormatter()
        dateFormatter.locale = Locale(identifier: "en_US_POSIX")
        dateFormatter.dateFormat = "d-MMM-yyyy"
        for term in terms {
            switch term {
            case .keyword(let k): parts.append(k)
            case .since(let d): parts.append("SINCE \(dateFormatter.string(from: d))")
            case .field(let name, let value):
                if value.allSatisfy({ $0.isASCII }) && !value.contains(where: { $0 == "\"" || $0 == "\\" || $0 == "\r" || $0 == "\n" }) {
                    parts.append("\(name) \"\(value)\"")
                } else {
                    needsUTF8 = true
                    let bytes = Data(value.utf8)
                    parts.append("\(name) {\(bytes.count)}")
                    continuations.append(bytes)
                }
            }
        }
        if parts.isEmpty { parts = ["ALL"] }
        let criteria = (needsUTF8 ? "CHARSET UTF-8 " : "") + parts.joined(separator: " ")
        let (_, _, untagged) = try await command("UID SEARCH \(criteria)", continuations: continuations, expectOK: true)
        var uids: [Int] = []
        for response in untagged where response.untaggedName == "SEARCH" {
            uids += response.items.dropFirst().compactMap(\.intValue)
        }
        return uids.sorted()
    }

    func fetchSummaries(uids: [Int]) async throws -> [IMAPMessageSummary] {
        guard !uids.isEmpty else { return [] }
        let set = uids.map(String.init).joined(separator: ",")
        let (_, _, untagged) = try await command(
            "UID FETCH \(set) (UID FLAGS INTERNALDATE RFC822.SIZE BODY.PEEK[HEADER.FIELDS (FROM TO CC SUBJECT DATE MESSAGE-ID)])",
            expectOK: true, timeout: 90)
        var out: [IMAPMessageSummary] = []
        for response in untagged {
            guard let record = IMAPFetchRecord(response), let uid = record.uid else { continue }
            let headerText = record.bodySection().map { String(decoding: $0, as: UTF8.self) } ?? ""
            let headers = MIMEMessage.parseHeaders(headerText)
            out.append(IMAPMessageSummary(
                uid: uid,
                flags: record.flags,
                size: record.size ?? 0,
                internalDate: record.internalDate,
                subject: MIMEMessage.decodeEncodedWords(headers["subject"]?.first ?? "").trimmingCharacters(in: .whitespaces),
                from: MIMEMessage.parseAddresses(headers["from"]?.first ?? ""),
                to: MIMEMessage.parseAddresses(headers["to"]?.joined(separator: ", ") ?? ""),
                date: headers["date"]?.first.flatMap(MIMEMessage.parseDate),
                messageId: (headers["message-id"]?.first ?? "").trimmingCharacters(in: .whitespaces)))
        }
        return out
    }

    /// 整封邮件的前 maxBytes 字节(BODY.PEEK 不改已读)。返回 (字节, 是否被截断)。
    func fetchMessage(uid: Int, maxBytes: Int) async throws -> (Data, truncated: Bool) {
        let (_, _, untagged) = try await command(
            "UID FETCH \(uid) (UID RFC822.SIZE BODY.PEEK[]<0.\(maxBytes)>)", expectOK: true, timeout: 120)
        for response in untagged {
            guard let record = IMAPFetchRecord(response), record.uid == uid, let data = record.bodySection() else { continue }
            let size = record.size ?? data.count
            return (data, size > data.count)
        }
        throw IMAPError.protocolError("服务器没有返回 UID \(uid) 的内容(可能已被删除)")
    }

    // MARK: - Command plumbing

    /// 发一条命令,收到本命令的 tagged 响应为止。`continuations` 依次应答服务器的 `+`(字面量续传)。
    @discardableResult
    private func command(_ text: String, continuations: [Data] = [], expectOK: Bool = false,
                         timeout: TimeInterval = IMAPClient.commandTimeout)
        async throws -> (status: String, text: String, untagged: [IMAPResponse]) {
        tagCounter += 1
        let tag = String(format: "A%03d", tagCounter)
        try await write(Data("\(tag) \(text)\r\n".utf8))
        var pending = continuations[...]
        var untagged: [IMAPResponse] = []
        let deadline = Date().addingTimeInterval(timeout)
        while true {
            let remaining = max(1, deadline.timeIntervalSinceNow)
            let response = try await readResponse(timeout: remaining)
            switch response.kind {
            case .continuation:
                guard let next = pending.popFirst() else {
                    throw IMAPError.protocolError("服务器要求续传,但命令没有更多数据:\(response.line.prefix(80))")
                }
                try await write(next + Data("\r\n".utf8))
            case .untagged:
                if response.untaggedName == "BYE" { throw IMAPError.closed }
                untagged.append(response)
            case .tagged(let t):
                guard t == tag else { continue }
                let status = response.status ?? "BAD"
                let verb = text.split(separator: " ").first.map(String.init) ?? text
                if expectOK {
                    if status == "NO" { throw IMAPError.serverNo(command: verb, message: response.statusText) }
                    if status == "BAD" { throw IMAPError.serverBad(command: verb, message: response.statusText) }
                }
                return (status, response.statusText, untagged)
            }
        }
    }

    private func write(_ data: Data) async throws {
        guard let conn = connection else { throw IMAPError.closed }
        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
            conn.send(content: data, completion: .contentProcessed { error in
                if let error { cont.resume(throwing: IMAPError.connectFailed(error.localizedDescription)) }
                else { cont.resume() }
            })
        }
    }

    /// 一条逻辑响应:处理行尾 {N} 字面量(读 N 字节后继续读同一逻辑行)。
    private func readResponse(timeout: TimeInterval) async throws -> IMAPResponse {
        try await withTimeout(timeout, label: "等待响应") {
            var line = try await self.readLine()
            var literals: [Data] = []
            while let n = Self.trailingLiteralLength(line) {
                let literal = try await self.readBytes(n)
                literals.append(literal)
                line += try await self.readLine()
            }
            return IMAPResponse.parse(line: line, literals: literals)
        }
    }

    static func trailingLiteralLength(_ line: String) -> Int? {
        guard line.hasSuffix("}"), let open = line.lastIndex(of: "{") else { return nil }
        let digits = line[line.index(after: open)..<line.index(before: line.endIndex)]
        // {N} 或 {N+}(非同步字面量在服务器响应里不出现,保守处理)
        return Int(digits.replacingOccurrences(of: "+", with: ""))
    }

    private func readLine() async throws -> String {
        while true {
            if let range = buffer.range(of: Data("\r\n".utf8)) {
                let lineData = buffer.subdata(in: buffer.startIndex..<range.lowerBound)
                buffer.removeSubrange(buffer.startIndex..<range.upperBound)
                return String(decoding: lineData, as: UTF8.self)
            }
            try await fill()
        }
    }

    private func readBytes(_ n: Int) async throws -> Data {
        while buffer.count < n { try await fill() }
        let out = buffer.prefix(n)
        buffer.removeSubrange(buffer.startIndex..<buffer.startIndex + n)
        return Data(out)
    }

    private func fill() async throws {
        guard let conn = connection else { throw IMAPError.closed }
        let chunk: Data = try await withCheckedThrowingContinuation { cont in
            conn.receive(minimumIncompleteLength: 1, maximumLength: 256 * 1024) { data, _, isComplete, error in
                if let error { cont.resume(throwing: IMAPError.connectFailed(error.localizedDescription)); return }
                if let data, !data.isEmpty { cont.resume(returning: data); return }
                if isComplete { cont.resume(throwing: IMAPError.closed); return }
                cont.resume(returning: Data())
            }
        }
        if chunk.isEmpty { try await Task.sleep(nanoseconds: 20_000_000) }
        buffer.append(chunk)
    }

    private func parseCapabilities(from response: IMAPResponse) {
        // * OK [CAPABILITY IMAP4rev1 AUTH=PLAIN ID ...] ready
        guard let open = response.line.range(of: "[CAPABILITY "), let close = response.line[open.upperBound...].firstIndex(of: "]") else { return }
        capabilities = Set(response.line[open.upperBound..<close].split(separator: " ").map { $0.uppercased() })
    }

    private func quoted(_ s: String) -> String {
        "\"" + s.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"") + "\""
    }

    private func mailboxWireName(_ name: String) -> String {
        name.caseInsensitiveCompare("inbox") == .orderedSame ? "INBOX" : IMAPModifiedUTF7.encode(name)
    }

    private func withTimeout<T: Sendable>(_ seconds: TimeInterval, label: String,
                                          _ body: @escaping @Sendable () async throws -> T) async throws -> T {
        try await withThrowingTaskGroup(of: T.self) { group in
            group.addTask { try await body() }
            group.addTask {
                try await Task.sleep(nanoseconds: UInt64(max(0.1, seconds) * 1_000_000_000))
                throw IMAPError.timeout(label)
            }
            guard let first = try await group.next() else { throw IMAPError.timeout(label) }
            group.cancelAll()
            return first
        }
    }
}
