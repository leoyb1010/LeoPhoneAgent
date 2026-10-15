import Network
import XCTest

/// [T-mail-write][T-mail-send][T-mail-watch][T-mail-always] 1.71 邮件写操作、发信、监控、长期允许。
final class MailWriteTests: XCTestCase {

    // MARK: - MailComposer

    private func draft(to: [String] = ["bob@example.com"], subject: String = "Hello", body: String = "Hi Bob") -> MailDraft {
        MailDraft(from: MailAddress(name: "", email: "leo@example.com"), to: to, subject: subject, body: body)
    }

    private func text(_ mail: ComposedMail) -> String { String(decoding: mail.data, as: UTF8.self) }

    func testComposeProducesCRLFHeadersAndBase64Body() throws {
        let date = Date(timeIntervalSince1970: 1_760_000_000)
        let mail = try MailComposer.compose(draft(), date: date, uniqueId: "ABC")
        let t = text(mail)
        XCTAssertEqual(mail.messageId, "<abc@example.com>")
        XCTAssertTrue(t.contains("From: leo@example.com\r\n"))
        XCTAssertTrue(t.contains("To: bob@example.com\r\n"))
        XCTAssertTrue(t.contains("Subject: Hello\r\n"))
        XCTAssertTrue(t.contains("Message-ID: <abc@example.com>\r\n"))
        XCTAssertTrue(t.contains("Content-Type: text/plain; charset=UTF-8\r\n"))
        XCTAssertTrue(t.contains("Content-Transfer-Encoding: base64\r\n\r\n"))
        let body = try XCTUnwrap(t.components(separatedBy: "\r\n\r\n").last)
        XCTAssertEqual(String(decoding: Data(base64Encoded: body.replacingOccurrences(of: "\r\n", with: ""))!, as: UTF8.self), "Hi Bob")
        XCTAssertFalse(t.replacingOccurrences(of: "\r\n", with: "").contains("\n"), "只用 CRLF")
    }

    func testChineseSubjectIsEncodedAndRoundTrips() throws {
        let subject = "关于下周的会议安排,请查收附件里的议程和材料清单"
        let mail = try MailComposer.compose(draft(subject: subject))
        let t = text(mail)
        let headerBlock = try XCTUnwrap(t.components(separatedBy: "\r\n\r\n").first)
        XCTAssertFalse(headerBlock.contains("会议"), "头部不能有裸 UTF-8")
        XCTAssertTrue(headerBlock.contains("=?UTF-8?B?"))
        // 用现有解析器读回来,应当和原文一致。
        XCTAssertEqual(MIMEMessage.parse(mail.data).subject, subject)
        for line in headerBlock.components(separatedBy: "\r\n") {
            XCTAssertLessThanOrEqual(line.count, 998)
        }
    }

    /// 地址或主题里塞换行 = 注入一个新的头(比如偷加一个 Bcc)。必须拒绝或抹平。
    func testHeaderInjectionIsBlocked() throws {
        XCTAssertThrowsError(try MailComposer.compose(draft(to: ["bob@example.com\r\nBcc: evil@x.com"])))
        let mail = try MailComposer.compose(draft(subject: "hi\r\nBcc: evil@x.com"))
        let headerBlock = try XCTUnwrap(text(mail).components(separatedBy: "\r\n\r\n").first)
        XCTAssertFalse(headerBlock.contains("\r\nBcc:"), "主题里的换行被抹平,不会变成新头")
    }

    func testBccGoesToEnvelopeOnlyAndRecipientsAreDeduplicated() throws {
        var d = draft(to: ["Bob <bob@example.com>, alice@example.com"])
        d.cc = ["BOB@example.com"]
        d.bcc = ["secret@example.com"]
        let mail = try MailComposer.compose(d)
        XCTAssertEqual(mail.envelopeRecipients, ["bob@example.com", "alice@example.com", "secret@example.com"])
        XCTAssertFalse(text(mail).contains("secret@example.com"), "密送不进信头")
    }

    func testInvalidInputsThrow() {
        XCTAssertThrowsError(try MailComposer.compose(draft(to: []))) { XCTAssertEqual($0 as? MailComposeError, .noRecipients) }
        XCTAssertThrowsError(try MailComposer.compose(draft(to: ["not-an-address"])))
        XCTAssertThrowsError(try MailComposer.compose(draft(body: "   "))) { XCTAssertEqual($0 as? MailComposeError, .emptyBody) }
        let many = (0..<51).map { "u\($0)@example.com" }
        XCTAssertThrowsError(try MailComposer.compose(draft(to: many))) { XCTAssertEqual($0 as? MailComposeError, .tooManyRecipients(51)) }
    }

    func testReplyThreadsWithInReplyToAndReferences() throws {
        var d = draft()
        d.inReplyTo = "<orig@host>"
        d.references = ["<root@host>"]
        let t = text(try MailComposer.compose(d))
        XCTAssertTrue(t.contains("In-Reply-To: <orig@host>\r\n"))
        XCTAssertTrue(t.contains("References: <root@host> <orig@host>\r\n"))
        XCTAssertEqual(MailComposer.replySubject("周报"), "Re: 周报")
        XCTAssertEqual(MailComposer.replySubject("Re: 周报"), "Re: 周报")
        XCTAssertEqual(MailComposer.replySubject("回复：周报"), "回复：周报")
    }

    func testReferencesHeaderIsParsed() {
        let raw = Data("Subject: x\r\nMessage-ID: <b@h>\r\nReferences: <a@h>\r\n <c@h>\r\n\r\nbody".utf8)
        XCTAssertEqual(MIMEMessage.parse(raw).references, ["<a@h>", "<c@h>"])
    }

    // MARK: - SMTP pieces

    func testSMTPReplyParsingHandlesMultiline() {
        var buffer = ["250-smtp.example.com", "250-PIPELINING", "250-AUTH PLAIN LOGIN", "250 STARTTLS", "354 go"]
        let ehlo = SMTPReply.take(from: &buffer)
        XCTAssertEqual(ehlo?.code, 250)
        XCTAssertEqual(ehlo?.extensions, ["PIPELINING", "AUTH PLAIN LOGIN", "STARTTLS"])
        XCTAssertEqual(ehlo?.supportsAuth("PLAIN"), true)
        XCTAssertEqual(ehlo?.supportsAuth("XOAUTH2"), false)
        XCTAssertEqual(SMTPReply.take(from: &buffer)?.code, 354)
        XCTAssertTrue(buffer.isEmpty)
        var partial = ["250-first"]
        XCTAssertNil(SMTPReply.take(from: &partial), "没收齐不交出")
    }

    func testDataSectionDotStuffsAndTerminates() {
        let out = String(decoding: SMTPWire.dataSection(Data("a\r\n.hidden\r\nb\r\n".utf8)), as: UTF8.self)
        XCTAssertEqual(out, "a\r\n..hidden\r\nb\r\n.\r\n")
        XCTAssertEqual(SMTPWire.authPlain(username: "u", password: "p"), Data("\u{0}u\u{0}p".utf8).base64EncodedString())
        XCTAssertThrowsError(try SMTPWire.envelopeAddress("a@b.com>\r\nRCPT TO:<c@d.com"))
    }

    /// 服务器不提供 STARTTLS 时必须直接失败,而且一个字节的登录信息都不能发出去。
    func testStartTLSRefusesToAuthenticateOverPlaintext() async throws {
        let listener = try NWListener(using: .tcp, on: .any)
        let received = LockedBox()
        listener.newConnectionHandler = { conn in
            conn.start(queue: .global())
            func send(_ s: String) { conn.send(content: Data(s.utf8), completion: .idempotent) }
            send("220 fake ESMTP\r\n")
            func receive() {
                conn.receive(minimumIncompleteLength: 1, maximumLength: 4096) { data, _, done, _ in
                    if let data, !data.isEmpty {
                        let text = String(decoding: data, as: UTF8.self)
                        received.append(text)
                        if text.hasPrefix("EHLO") { send("250-fake\r\n250 AUTH PLAIN LOGIN\r\n") }
                    }
                    if !done { receive() }
                }
            }
            receive()
        }
        let ready = expectation(description: "listening")
        listener.stateUpdateHandler = { if case .ready = $0 { ready.fulfill() } }
        listener.start(queue: .global())
        await fulfillment(of: [ready], timeout: 5)
        let port = Int(try XCTUnwrap(listener.port).rawValue)
        defer { listener.cancel() }

        let client = SMTPClient(server: SMTPServer(host: "127.0.0.1", port: port, security: .startTLS))
        do {
            try await client.send(username: "leo@example.com", password: "SECRET-PW", from: "leo@example.com",
                                  recipients: ["bob@example.com"], message: Data("x".utf8))
            XCTFail("必须失败")
        } catch let error as SMTPError {
            XCTAssertEqual(error, .tlsUnavailable)
        }
        try await Task.sleep(nanoseconds: 200_000_000)
        let wire = received.value
        XCTAssertTrue(wire.contains("EHLO"))
        XCTAssertFalse(wire.contains("AUTH"), "没有 TLS 不能登录")
        XCTAssertFalse(wire.contains(Data("SECRET-PW".utf8).base64EncodedString()))
        XCTAssertFalse(wire.contains("SECRET-PW"))
    }

    // MARK: - IMAP helpers

    func testMailboxStateParsesUIDValidityAndUIDNext() {
        let lines = ["* 172 EXISTS", "* OK [UIDVALIDITY 3857529045] UIDs valid", "* OK [UIDNEXT 4392] Predicted next UID"]
        let state = IMAPClient.mailboxState(from: lines.map { IMAPResponse.parse(line: $0, literals: []) })
        XCTAssertEqual(state, .init(exists: 172, uidValidity: 3857529045, uidNext: 4392))
    }

    func testOnlySystemFlagsAreAllowed() {
        XCTAssertTrue(IMAPClient.isSafeFlag("\\Seen"))
        XCTAssertTrue(IMAPClient.isSafeFlag("\\Flagged"))
        XCTAssertFalse(IMAPClient.isSafeFlag("\\Seen) UID EXPUNGE 1:*"))
        XCTAssertFalse(IMAPClient.isSafeFlag("custom"))
        XCTAssertEqual(IMAPClient.uidSet([3, 0, -1, 7]), "3,7")
    }

    func testSpecialFoldersResolveByAttributeThenName() {
        let boxes = [
            IMAPMailbox(rawName: "INBOX", name: "INBOX", attributes: [], delimiter: "/"),
            IMAPMailbox(rawName: "[Gmail]/Trash", name: "[Gmail]/Trash", attributes: ["\\HasNoChildren", "\\Trash"], delimiter: "/"),
            IMAPMailbox(rawName: "Deleted Messages", name: "Deleted Messages", attributes: [], delimiter: "/"),
            IMAPMailbox(rawName: "&g0l6P3ux-", name: "草稿箱", attributes: [], delimiter: "/"),
        ]
        XCTAssertEqual(IMAPClient.specialMailbox("\\Trash", in: boxes, fallbackNames: MailActions.trashNames)?.name, "[Gmail]/Trash")
        XCTAssertEqual(IMAPClient.specialMailbox("\\Drafts", in: boxes, fallbackNames: MailActions.draftNames)?.name, "草稿箱")
        XCTAssertNil(IMAPClient.specialMailbox("\\Archive", in: boxes, fallbackNames: ["Archive"]))
        let noDelimiter = [IMAPMailbox(rawName: "Sent", name: "Sent", attributes: [], delimiter: "")]
        XCTAssertEqual(IMAPClient.specialMailbox("\\Sent", in: noDelimiter, fallbackNames: ["Sent"])?.name, "Sent", "空分隔符不崩")
    }

    func testToolArgumentParsing() {
        XCTAssertEqual(MailActions.parseUIDs("12, 13 14"), [12, 13, 14])
        XCTAssertEqual(MailActions.parseUIDs([1, "2"]), [1, 2])
        XCTAssertEqual(MailActions.parseUIDs(9), [9])
        XCTAssertEqual(MailActions.stringList("a@b.com, c@d.com"), ["a@b.com, c@d.com"])
    }

    // MARK: - Accounts

    /// 旧版本存的账户 JSON 没有 SMTP 字段,必须照常解码。
    func testOldAccountJSONStillDecodesAndDerivesSMTP() throws {
        let old = #"{"id":"1","presetId":"qq","label":"","email":"a@qq.com","username":"a@qq.com","host":"imap.qq.com","port":993,"isEnabled":true,"createdAt":0}"#
        let account = try JSONDecoder().decode(MailAccount.self, from: Data(old.utf8))
        XCTAssertNil(account.smtpHost)
        XCTAssertEqual(account.smtpServer, SMTPServer(host: "smtp.qq.com", port: 465, security: .implicitTLS))
        var icloud = account; icloud.presetId = "icloud"
        XCTAssertEqual(icloud.smtpServer?.security, .startTLS)
        var custom = account; custom.presetId = "custom"; custom.host = "imap.corp.example.com"
        XCTAssertEqual(custom.smtpServer, SMTPServer(host: "smtp.corp.example.com", port: 465, security: .implicitTLS))
        custom.smtpHost = "mail.corp.example.com"; custom.smtpPort = 587
        XCTAssertEqual(custom.smtpServer, SMTPServer(host: "mail.corp.example.com", port: 587, security: .startTLS))
    }

    // MARK: - Watch

    func testWatchCursorBaselinesFirstThenReportsOnlyNewMail() {
        XCTAssertEqual(MailWatchLogic.step(validity: 7, uidNext: 101, cursor: nil),
                       .baseline(MailWatchCursor(uidValidity: 7, lastUID: 100)), "第一次只建游标,不提醒旧邮件")
        let cursor = MailWatchCursor(uidValidity: 7, lastUID: 100)
        XCTAssertEqual(MailWatchLogic.step(validity: 7, uidNext: 101, cursor: cursor), .nothingNew)
        XCTAssertEqual(MailWatchLogic.step(validity: 7, uidNext: 104, cursor: cursor), .fetch(after: 100))
        XCTAssertEqual(MailWatchLogic.step(validity: 8, uidNext: 5, cursor: cursor),
                       .baseline(MailWatchCursor(uidValidity: 8, lastUID: 4)), "UIDVALIDITY 变了重建")
        XCTAssertEqual(MailWatchLogic.step(validity: nil, uidNext: 5, cursor: cursor), .nothingNew)
        XCTAssertEqual(MailWatchLogic.newUIDs([100, 101, 103], after: 100), [101, 103], "UID n:* 会带回最后一封旧信")
        XCTAssertEqual(MailWatchLogic.newUIDs(Array(1...100), after: 0).count, MailWatchLogic.maxPerCheck)
    }

    func testRuleMatching() {
        let boss = MailWatchRule(name: "老板", account: "me@corp.com", fromContains: "boss@corp.com, 王总")
        let from = [MailAddress(name: "王总", email: "wang@corp.com")]
        XCTAssertTrue(boss.matches(from: from, subject: "周会"))
        XCTAssertTrue(boss.applies(toAccount: "ME@corp.com"))
        XCTAssertFalse(boss.applies(toAccount: "other@corp.com"))
        XCTAssertFalse(boss.matches(from: [MailAddress(name: "", email: "x@y.com")], subject: "周会"))
        let invoices = MailWatchRule(name: "发票", subjectContains: "发票；invoice")
        XCTAssertTrue(invoices.matches(from: [], subject: "Your INVOICE #12"))
        XCTAssertTrue(MailWatchRule(name: "全部").matches(from: [], subject: ""), "两项都空 = 所有新邮件")
        var paused = boss; paused.isEnabled = false
        XCTAssertNil(MailWatchLogic.firstMatch([paused], account: "me@corp.com", from: from, subject: ""))
        XCTAssertEqual(boss.signalName, "新邮件:老板")
        XCTAssertEqual(MailWatchLogic.signal, ContextSignalName.newMail)
    }

    // MARK: - Gate

    func testMailToolsMapToGateCategories() {
        XCTAssertEqual(SensitiveToolGate.Category.forToolName("mail_update"), .mailWrite)
        XCTAssertEqual(SensitiveToolGate.Category.forToolName("mail_draft"), .mailWrite)
        XCTAssertEqual(SensitiveToolGate.Category.forToolName("mail_send"), .mailSend)
        XCTAssertNil(SensitiveToolGate.Category.forToolName("mail_read"), "读信不用确认")
        XCTAssertNil(SensitiveToolGate.Category.forToolName("mail_watch"))
        XCTAssertFalse(SensitiveToolGate.Category.mailSend.fullAutoMayApprove)
        XCTAssertTrue(SensitiveToolGate.Category.mailWrite.fullAutoMayApprove)
        XCTAssertTrue(SensitiveToolGate.Category.mailSend.supportsAlwaysAllow)
        XCTAssertFalse(SensitiveToolGate.Category.shell.supportsAlwaysAllow, "只有邮件能长期允许")
        let scope = SensitiveToolGate.Category.grantScope(tool: "mail_send", args: ["account": "Leo@Example.com"])
        XCTAssertEqual(scope, "mail|leo@example.com")
        XCTAssertEqual(scope, SensitiveToolGate.Category.grantScope(tool: "mail_update", args: ["account": "leo@example.com"]))
    }

    func testAlwaysAllowIsPerCategoryAndMailboxAndRevocable() throws {
        let defaults = try XCTUnwrap(UserDefaults(suiteName: "MailAlwaysAllowTests-\(UUID().uuidString)"))
        MailAlwaysAllow.grant(category: "mailSend", scope: "mail|leo@example.com", defaults: defaults)
        XCTAssertTrue(MailAlwaysAllow.isGranted(category: "mailSend", scope: "MAIL|Leo@example.com", defaults: defaults))
        XCTAssertFalse(MailAlwaysAllow.isGranted(category: "mailWrite", scope: "mail|leo@example.com", defaults: defaults))
        XCTAssertFalse(MailAlwaysAllow.isGranted(category: "mailSend", scope: "mail|other@example.com", defaults: defaults))
        XCTAssertEqual(MailAlwaysAllow.grantedCategories(account: "leo@example.com", defaults: defaults), ["mailSend"])
        MailAlwaysAllow.revoke(account: "Leo@Example.com", defaults: defaults)
        XCTAssertFalse(MailAlwaysAllow.isGranted(category: "mailSend", scope: "mail|leo@example.com", defaults: defaults))
    }

    /// 新邮件触发的自动化回合(情境回合)里不能发信、改信:邮件里的文字指挥不了助手往外发。
    func testContextTurnsCannotSendOrChangeMail() {
        for tool in ["mail_send", "mail_update", "mail_draft"] {
            XCTAssertTrue(ContextToolPolicy.blockedTools.contains(tool), tool)
        }
        XCTAssertFalse(ContextToolPolicy.blockedTools.contains("mail_read"))
    }
}

private final class LockedBox: @unchecked Sendable {
    private let lock = NSLock()
    private var text = ""
    func append(_ s: String) { lock.lock(); text += s; lock.unlock() }
    var value: String { lock.lock(); defer { lock.unlock() }; return text }
}
