//
//  MailService.swift
//  MinisApp
//
//  [T-mail] Agent 的邮件工具:mail_accounts / mail_folders / mail_search / mail_read。
//  只读:BODY.PEEK 不改已读,不删不发。邮件内容一律包在 untrusted 标签里回给模型 ——
//  邮件正文是别人写的,可能带着"请忽略以上指令"这类话,永远只是数据。
//  每次调用开一条 IMAP 连接、用完关掉;账户密码只在这里从钥匙串取出、只发给该账户配置的服务器。
//

import Foundation

enum MailService {
    private static let logger = AppLogger(category: "Mail")
    /// 一封邮件最多拉多少字节(超过的部分截掉,正文前面的文字部分通常都在)。
    static let maxMessageBytes = 1_500_000
    /// 服务器不吃 UTF-8 搜索时,退回客户端过滤的最近邮件数。
    static let clientFilterWindow = 200

    // MARK: - Tool entry points

    static func executeAccounts() async -> (output: String, success: Bool) {
        let accounts = await MainActor.run { MailAccountStore.shared.enabledAccounts }
        guard !accounts.isEmpty else {
            return ("没有授权的邮箱账户。请用户到「设置 → 邮箱账户」添加(支持 Gmail、QQ、163、126、iCloud 等 IMAP 邮箱)。", false)
        }
        struct Row: Encodable { let id: String; let label: String; let email: String; let provider: String; let last_verified_at: Date? }
        let rows = accounts.map { Row(id: $0.id, label: $0.displayName, email: $0.email, provider: $0.preset.name, last_verified_at: $0.lastVerifiedAt) }
        return (TreasuryService.renderUntrusted(rows, element: "mail_accounts"), true)
    }

    static func executeFolders(from json: String) async -> (output: String, success: Bool) {
        let args = jsonDictionary(json)
        let account: MailAccount
        switch await resolveAccount(args["account"] as? String) {
        case .success(let a): account = a
        case .failure(let message): return (message, false)
        }
        do {
            let client = try await openClient(for: account)
            defer { Task { await client.close() } }
            let boxes = try await client.listMailboxes()
            struct Row: Encodable { let name: String; let messages: Int?; let unseen: Int? }
            var rows: [Row] = []
            for box in boxes.prefix(40) {
                if rows.count < 12 {
                    let status = try? await client.status(mailbox: box.rawName)
                    rows.append(Row(name: box.name, messages: status?.messages, unseen: status?.unseen))
                } else {
                    rows.append(Row(name: box.name, messages: nil, unseen: nil))
                }
            }
            await recordSuccess(account)
            struct Out: Encodable { let account: String; let folders: [Row] }
            return (TreasuryService.renderUntrusted(Out(account: account.email, folders: rows), element: "mail_folders"), true)
        } catch {
            return await failure(error, account: account)
        }
    }

    static func executeSearch(from json: String) async -> (output: String, success: Bool) {
        let args = jsonDictionary(json)
        let folder = ((args["folder"] as? String)?.trimmingCharacters(in: .whitespaces)).flatMap { $0.isEmpty ? nil : $0 } ?? "INBOX"
        let limit = min(max((args["limit"] as? Int) ?? Int((args["limit"] as? String) ?? "") ?? 20, 1), 50)
        let query = (args["query"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let from = (args["from"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let subject = (args["subject"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let unreadOnly = boolValue(args["unread_only"])
        let since = parseSince(args["since"])

        let accounts: [MailAccount]
        if let wanted = args["account"] as? String, !wanted.trimmingCharacters(in: .whitespaces).isEmpty, wanted.lowercased() != "all" {
            switch await resolveAccount(wanted) {
            case .success(let a): accounts = [a]
            case .failure(let message): return (message, false)
            }
        } else {
            accounts = await MainActor.run { MailAccountStore.shared.enabledAccounts }
            if accounts.isEmpty { return await executeAccounts() }
        }

        struct Row: Encodable {
            let uid: Int; let account: String; let folder: String; let from: String; let to: String
            let subject: String; let date: Date?; let unread: Bool; let size: Int
        }
        var rows: [Row] = []
        var errors: [String] = []
        var perAccountNote: [String] = []
        for account in accounts.prefix(5) {
            do {
                let client = try await openClient(for: account)
                defer { Task { await client.close() } }
                try await client.examine(mailbox: folder)
                var terms: [IMAPSearchTerm] = []
                if unreadOnly { terms.append(.keyword("UNSEEN")) }
                if let since { terms.append(.since(since)) }
                if !from.isEmpty { terms.append(.field("FROM", from)) }
                if !subject.isEmpty { terms.append(.field("SUBJECT", subject)) }
                if !query.isEmpty { terms.append(.field("TEXT", query)) }
                var summaries: [IMAPMessageSummary]
                do {
                    let uids = try await client.uidSearch(terms)
                    summaries = try await client.fetchSummaries(uids: Array(uids.suffix(limit)))
                } catch let error as IMAPError where isSearchRejection(error) && terms.contains(where: { if case .field = $0 { return true }; return false }) {
                    // 服务器不支持 UTF-8 / TEXT 搜索(网易、部分自建):拉最近一批,本地过滤。
                    let base = terms.filter { if case .field = $0 { return false }; return true }
                    let uids = try await client.uidSearch(base)
                    let recent = try await client.fetchSummaries(uids: Array(uids.suffix(clientFilterWindow)))
                    summaries = recent.filter { s in
                        (from.isEmpty || s.from.contains { $0.display.localizedCaseInsensitiveContains(from) })
                        && (subject.isEmpty || s.subject.localizedCaseInsensitiveContains(subject))
                        && (query.isEmpty || s.subject.localizedCaseInsensitiveContains(query)
                            || s.from.contains { $0.display.localizedCaseInsensitiveContains(query) })
                    }
                    summaries = Array(summaries.suffix(limit))
                    perAccountNote.append("\(account.email):服务器不支持全文搜索,已在最近 \(recent.count) 封里按主题 / 发件人匹配。")
                }
                for s in summaries {
                    rows.append(Row(uid: s.uid, account: account.email, folder: folder,
                                    from: s.from.map(\.display).joined(separator: ", "),
                                    to: s.to.prefix(3).map(\.display).joined(separator: ", "),
                                    subject: s.subject, date: s.date ?? s.internalDate.flatMap(parseInternalDate),
                                    unread: s.isUnread, size: s.size))
                }
                await recordSuccess(account)
            } catch {
                await recordFailure(error, account: account)
                errors.append("\(account.email):\(error.localizedDescription)")
            }
        }
        rows.sort { ($0.date ?? .distantPast) > ($1.date ?? .distantPast) }
        if accounts.count > 1 { rows = Array(rows.prefix(limit)) }
        struct Out: Encodable {
            let folder: String; let count: Int; let items: [Row]; let notes: [String]; let errors: [String]
            let hint: String
        }
        let out = Out(folder: folder, count: rows.count, items: rows, notes: perAccountNote, errors: errors,
                      hint: "Bodies are not included. Call mail_read with account + uid to read one message.")
        return (TreasuryService.renderUntrusted(out, element: "mail_search_results"), errors.isEmpty || !rows.isEmpty)
    }

    static func executeRead(from json: String) async -> (output: String, success: Bool) {
        let args = jsonDictionary(json)
        guard let uid = (args["uid"] as? Int) ?? Int((args["uid"] as? String) ?? "") else {
            return ("Error: mail_read requires a numeric `uid` (from mail_search).", false)
        }
        let folder = ((args["folder"] as? String)?.trimmingCharacters(in: .whitespaces)).flatMap { $0.isEmpty ? nil : $0 } ?? "INBOX"
        let maxChars = min(max((args["max_chars"] as? Int) ?? Int((args["max_chars"] as? String) ?? "") ?? 12000, 500), 50000)
        let account: MailAccount
        switch await resolveAccount(args["account"] as? String) {
        case .success(let a): account = a
        case .failure(let message): return (message, false)
        }
        do {
            let client = try await openClient(for: account)
            defer { Task { await client.close() } }
            try await client.examine(mailbox: folder)
            let (data, truncatedBytes) = try await client.fetchMessage(uid: uid, maxBytes: maxMessageBytes)
            let message = MIMEMessage.parse(data)
            var text = message.text
            var truncated = truncatedBytes
            if text.count > maxChars {
                text = String(text.prefix(maxChars))
                truncated = true
            }
            await recordSuccess(account)
            struct Out: Encodable {
                let account: String; let folder: String; let uid: Int; let subject: String
                let from: String; let to: String; let cc: String; let date: Date?; let message_id: String
                let text: String; let text_truncated: Bool; let attachments: [MailAttachmentInfo]
            }
            let out = Out(account: account.email, folder: folder, uid: uid, subject: message.subject,
                          from: message.from.map(\.display).joined(separator: ", "),
                          to: message.to.map(\.display).joined(separator: ", "),
                          cc: message.cc.map(\.display).joined(separator: ", "),
                          date: message.date, message_id: message.messageId,
                          text: text, text_truncated: truncated, attachments: message.attachments)
            return (TreasuryService.renderUntrusted(out, element: "mail_message"), true)
        } catch {
            return await failure(error, account: account)
        }
    }

    // MARK: - Connection test (settings)

    /// 设置页的「测试并保存」:连接、登录、看一眼收件箱。
    static func test(account: MailAccount, password: String) async throws -> (messages: Int, unseen: Int) {
        let client = IMAPClient(host: account.host, port: account.port)
        defer { Task { await client.close() } }
        try await client.connect()
        try await client.login(username: account.username, password: password)
        return try await client.status(mailbox: "INBOX")
    }

    // MARK: - Helpers

    private enum Resolution { case success(MailAccount), failure(String) }

    private static func resolveAccount(_ wanted: String?) async -> Resolution {
        await MainActor.run {
            let store = MailAccountStore.shared
            let enabled = store.enabledAccounts
            guard !enabled.isEmpty else {
                return .failure("没有授权的邮箱账户。请用户到「设置 → 邮箱账户」添加。")
            }
            if let wanted, !wanted.trimmingCharacters(in: .whitespaces).isEmpty {
                if let hit = store.account(matching: wanted) { return .success(hit) }
                let names = enabled.map { "\($0.email)" }.joined(separator: ", ")
                return .failure("Error: no authorized mailbox matches \"\(wanted)\". Available: \(names)")
            }
            if enabled.count == 1 { return .success(enabled[0]) }
            let names = enabled.map { "\($0.email)" }.joined(separator: ", ")
            return .failure("Error: several mailboxes are authorized; pass `account` (email or label). Available: \(names)")
        }
    }

    private static func openClient(for account: MailAccount) async throws -> IMAPClient {
        guard let password = MailKeychain.password(accountId: account.id), !password.isEmpty else {
            throw IMAPError.loginRejected("这台设备的钥匙串里没有 \(account.email) 的授权码,请到「设置 → 邮箱账户」重新填写")
        }
        let client = IMAPClient(host: account.host, port: account.port)
        try await client.connect()
        try await client.login(username: account.username, password: password)
        return client
    }

    private static func isSearchRejection(_ error: IMAPError) -> Bool {
        switch error {
        case .serverBad, .serverNo: return true
        default: return false
        }
    }

    private static func failure(_ error: Error, account: MailAccount) async -> (String, Bool) {
        await recordFailure(error, account: account)
        return ("Error: \(account.email) — \(error.localizedDescription)", false)
    }

    private static func recordSuccess(_ account: MailAccount) async {
        await MainActor.run { MailAccountStore.shared.recordResult(accountId: account.id, error: nil) }
    }

    private static func recordFailure(_ error: Error, account: MailAccount) async {
        logger.warning("[Mail] \(account.preset.id) \(account.email.prefix(3))… failed: \(error.localizedDescription)")
        await MainActor.run { MailAccountStore.shared.recordResult(accountId: account.id, error: error.localizedDescription) }
    }

    private static func jsonDictionary(_ json: String) -> [String: Any] {
        guard let data = json.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return [:] }
        return obj
    }

    private static func boolValue(_ v: Any?) -> Bool {
        if let b = v as? Bool { return b }
        if let s = v as? String { return ["true", "1", "yes"].contains(s.lowercased()) }
        if let n = v as? Int { return n != 0 }
        return false
    }

    /// since:ISO 日期("2026-09-20")、相对时长("7d" / "24h" / "2w")或空。
    static func parseSince(_ v: Any?) -> Date? {
        guard let s = (v as? String)?.trimmingCharacters(in: .whitespaces).lowercased(), !s.isEmpty else { return nil }
        if let d = ISO8601DateFormatter().date(from: s) { return d }
        let fmt = DateFormatter(); fmt.locale = Locale(identifier: "en_US_POSIX"); fmt.dateFormat = "yyyy-MM-dd"
        if let d = fmt.date(from: s) { return d }
        if let unit = s.last, let n = Double(s.dropLast()) {
            let seconds: Double
            switch unit {
            case "h": seconds = n * 3600
            case "d": seconds = n * 86400
            case "w": seconds = n * 7 * 86400
            case "m": seconds = n * 30 * 86400
            default: return nil
            }
            return Date().addingTimeInterval(-seconds)
        }
        return nil
    }

    private static func parseInternalDate(_ s: String) -> Date? {
        let fmt = DateFormatter(); fmt.locale = Locale(identifier: "en_US_POSIX")
        fmt.dateFormat = "d-MMM-yyyy HH:mm:ss Z"
        return fmt.date(from: s)
    }
}
