//
//  MailActions.swift
//  MinisApp
//
//  [T-mail-write] 改信、存草稿、发信:mail_update / mail_draft / mail_send。
//
//  三个工具都先过 SensitiveToolGate(mailWrite / mailSend,按邮箱授权,可以「始终允许」)。
//  不做的事:永久删除。「删除」一律是移到废纸篓;移动只用 MOVE 或 UIDPLUS 精确清理,
//  不用会波及别的邮件的全局 EXPUNGE。新邮件触发的自动化回合里这三个工具都不可用
//  (ContextToolPolicy),防止邮件里的文字指挥助手往外发信。
//

import Foundation

enum MailActions {
    private static let logger = AppLogger(category: "MailActions")
    static let maxUIDsPerCall = 50

    // MARK: - Folder names

    static let trashNames = ["Trash", "Deleted Messages", "Deleted Items", "Deleted", "已删除", "已删除邮件", "垃圾箱"]
    static let archiveNames = ["Archive", "Archives", "归档", "All Mail", "所有邮件"]
    static let draftNames = ["Drafts", "Draft", "草稿箱", "草稿"]
    static let sentNames = ["Sent", "Sent Messages", "Sent Items", "Sent Mail", "已发送", "已发送邮件"]

    /// 这些服务商通过 SMTP 发出的信会自动出现在「已发送」里,不用再存一份。
    static let autoSavesSent: Set<String> = ["gmail", "outlook"]

    enum UpdateAction: String, CaseIterable {
        case markRead = "mark_read", markUnread = "mark_unread", flag, unflag, move, trash, archive
    }

    // MARK: - mail_update

    static func executeUpdate(from json: String) async -> (output: String, success: Bool) {
        let args = MailService.jsonDictionary(json)
        guard let action = (args["action"] as? String).flatMap(UpdateAction.init(rawValue:)) else {
            return ("Error: `action` must be one of \(UpdateAction.allCases.map(\.rawValue).joined(separator: ", ")).", false)
        }
        let uids = parseUIDs(args["uids"] ?? args["uid"])
        guard !uids.isEmpty else { return ("Error: pass `uids` (from mail_search).", false) }
        guard uids.count <= maxUIDsPerCall else {
            return ("Error: at most \(maxUIDsPerCall) messages per call; split the work.", false)
        }
        let folder = nonEmpty(args["folder"]) ?? "INBOX"
        let account: MailAccount
        switch await MailService.resolveAccount(args["account"] as? String) {
        case .success(let a): account = a
        case .failure(let message): return (message, false)
        }
        do {
            let client = try await MailService.openClient(for: account)
            defer { Task { await client.close() } }
            try await client.refreshCapabilities()
            var target: String?
            switch action {
            case .move:
                guard let to = nonEmpty(args["to_folder"]) else { return ("Error: action move needs `to_folder`.", false) }
                target = to
            case .trash, .archive:
                let boxes = try await client.listMailboxes()
                let use = action == .trash ? "\\Trash" : "\\Archive"
                let names = action == .trash ? trashNames : archiveNames
                guard let box = IMAPClient.specialMailbox(use, in: boxes, fallbackNames: names) else {
                    return ("Error: \(account.email) 没有找到\(action == .trash ? "废纸篓" : "归档")文件夹。可用文件夹:\(boxes.prefix(20).map(\.name).joined(separator: ", "))", false)
                }
                target = box.name
            default:
                break
            }
            try await client.select(mailbox: folder)
            switch action {
            case .markRead: try await client.uidStore(uids: uids, flags: ["\\Seen"], add: true)
            case .markUnread: try await client.uidStore(uids: uids, flags: ["\\Seen"], add: false)
            case .flag: try await client.uidStore(uids: uids, flags: ["\\Flagged"], add: true)
            case .unflag: try await client.uidStore(uids: uids, flags: ["\\Flagged"], add: false)
            case .move, .trash, .archive: try await client.uidMove(uids: uids, to: target ?? "")
            }
            await MailService.recordSuccess(account)
            let where_ = target.map { " → \($0)" } ?? ""
            return ("Done: \(action.rawValue) \(uids.count) message(s) in \(account.email)/\(folder)\(where_).", true)
        } catch {
            return await MailService.failure(error, account: account)
        }
    }

    // MARK: - mail_draft / mail_send

    static func executeDraft(from json: String) async -> (output: String, success: Bool) {
        await compose(json, send: false)
    }

    static func executeSend(from json: String) async -> (output: String, success: Bool) {
        await compose(json, send: true)
    }

    private static func compose(_ json: String, send: Bool) async -> (output: String, success: Bool) {
        let args = MailService.jsonDictionary(json)
        let account: MailAccount
        switch await MailService.resolveAccount(args["account"] as? String) {
        case .success(let a): account = a
        case .failure(let message): return (message, false)
        }
        guard let password = MailKeychain.password(accountId: account.id), !password.isEmpty else {
            return ("Error: 这台设备的钥匙串里没有 \(account.email) 的授权码,请到「设置 → 邮箱账户」重新填写。", false)
        }
        var draft = MailDraft(from: MailAddress(name: "", email: account.email),
                              to: stringList(args["to"]), cc: stringList(args["cc"]), bcc: stringList(args["bcc"]),
                              subject: (args["subject"] as? String) ?? "", body: (args["body"] as? String) ?? "")
        let replyUID = parseUIDs(args["reply_to_uid"]).first
        let replyFolder = nonEmpty(args["folder"]) ?? "INBOX"
        do {
            let client = try await MailService.openClient(for: account)
            defer { Task { await client.close() } }
            if let replyUID {
                try await client.examine(mailbox: replyFolder)
                let (data, _) = try await client.fetchMessage(uid: replyUID, maxBytes: 64 * 1024)
                let original = MIMEMessage.parse(data)
                if draft.to.isEmpty { draft.to = original.from.map(\.email).filter { !$0.isEmpty } }
                if draft.subject.trimmingCharacters(in: .whitespaces).isEmpty {
                    draft.subject = MailComposer.replySubject(original.subject)
                }
                if !original.messageId.isEmpty {
                    draft.inReplyTo = original.messageId
                    draft.references = original.references
                }
            }
            let mail = try MailComposer.compose(draft)
            if !send {
                let boxes = try await client.listMailboxes()
                guard let drafts = IMAPClient.specialMailbox("\\Drafts", in: boxes, fallbackNames: draftNames) else {
                    return ("Error: \(account.email) 没有找到草稿箱。", false)
                }
                try await client.append(mailbox: drafts.name, flags: ["\\Draft", "\\Seen"], message: mail.data)
                await MailService.recordSuccess(account)
                return ("Draft saved to \(account.email)/\(drafts.name) (to: \(mail.envelopeRecipients.joined(separator: ", "))). The user can review and send it from their mail app.", true)
            }

            guard let server = account.smtpServer else {
                return ("Error: \(account.email) 没有发信服务器设置,请到「设置 → 邮箱账户」填写 SMTP 服务器。", false)
            }
            try await SMTPClient(server: server).send(username: account.username, password: password,
                                                      from: account.email, recipients: mail.envelopeRecipients,
                                                      message: mail.data)
            logger.info("[Send] \(account.preset.id) sent recipients=\(mail.envelopeRecipients.count)")
            // 发出去之后的收尾都是尽力而为:失败不影响「已发送」这个事实。
            var notes: [String] = []
            if !autoSavesSent.contains(account.presetId) {
                do {
                    let boxes = try await client.listMailboxes()
                    if let sent = IMAPClient.specialMailbox("\\Sent", in: boxes, fallbackNames: sentNames) {
                        try await client.append(mailbox: sent.name, flags: ["\\Seen"], message: mail.data)
                    }
                } catch {
                    notes.append("copy to Sent folder failed: \(error.localizedDescription)")
                }
            }
            if let replyUID {
                do {
                    try await client.select(mailbox: replyFolder)
                    try await client.uidStore(uids: [replyUID], flags: ["\\Answered"], add: true)
                } catch {
                    notes.append("could not mark the original as answered")
                }
            }
            await MailService.recordSuccess(account)
            let extra = notes.isEmpty ? "" : " Note: " + notes.joined(separator: "; ")
            return ("Sent from \(account.email) to \(mail.envelopeRecipients.joined(separator: ", ")).\(extra)", true)
        } catch let error as MailComposeError {
            return ("Error: \(error.localizedDescription)", false)
        } catch {
            return await MailService.failure(error, account: account)
        }
    }

    // MARK: - Gate helper

    /// 确认闸按邮箱授权:把模型传的 account(名字、前缀、空)换成规范的邮箱地址,
    /// 「始终允许」才能稳定命中同一个键。找不到就原样返回(后面执行时会报错)。
    static func canonicalAccount(_ raw: Any?) async -> String? {
        let wanted = (raw as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
        switch await MailService.resolveAccount(wanted) {
        case .success(let account): return account.email.lowercased()
        case .failure: return wanted
        }
    }

    // MARK: - Parsing

    static func parseUIDs(_ raw: Any?) -> [Int] {
        if let n = raw as? Int { return [n] }
        if let list = raw as? [Any] { return list.compactMap { ($0 as? Int) ?? Int(($0 as? String) ?? "") } }
        if let s = raw as? String {
            return s.split(whereSeparator: { $0 == "," || $0 == " " }).compactMap { Int($0) }
        }
        return []
    }

    static func stringList(_ raw: Any?) -> [String] {
        if let s = raw as? String { return [s] }
        if let list = raw as? [Any] { return list.compactMap { $0 as? String } }
        return []
    }

    private static func nonEmpty(_ raw: Any?) -> String? {
        guard let s = (raw as? String)?.trimmingCharacters(in: .whitespacesAndNewlines), !s.isEmpty else { return nil }
        return s
    }
}
