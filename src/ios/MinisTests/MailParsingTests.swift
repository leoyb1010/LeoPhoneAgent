import XCTest

/// [T-mail] 邮件解析与 IMAP 响应解析的纯函数测试。样本照真实服务器(163 / QQ / Gmail)的形状写。
final class MailParsingTests: XCTestCase {
    func testEncodedWordsBase64AndQ() {
        // =?utf-8?B?...?= 是「会议纪要」;两个编码词之间的空白不算内容
        let b = MIMEMessage.decodeEncodedWords("=?utf-8?B?5Lya6K6u57qq6KaB?= =?utf-8?Q?_-_9=E6=9C=88?=")
        XCTAssertEqual(b, "会议纪要 - 9月")
        // gb2312 编码词(国内邮件常见)
        let gb = MIMEMessage.decodeEncodedWords("=?gb2312?B?xOO6ww==?=")
        XCTAssertEqual(gb, "你好")
        XCTAssertEqual(MIMEMessage.decodeEncodedWords("plain subject"), "plain subject")
    }

    func testAddresses() {
        let list = MIMEMessage.parseAddresses("\"Yuan, Leo\" <leo@example.com>, bob@example.org, =?utf-8?B?5byg5LiJ?= <zhang@x.cn>")
        XCTAssertEqual(list.count, 3)
        XCTAssertEqual(list[0], MailAddress(name: "Yuan, Leo", email: "leo@example.com"))
        XCTAssertEqual(list[1], MailAddress(name: "", email: "bob@example.org"))
        XCTAssertEqual(list[2], MailAddress(name: "张三", email: "zhang@x.cn"))
        XCTAssertEqual(list[0].display, "Yuan, Leo <leo@example.com>")
    }

    func testDate() {
        let d = MIMEMessage.parseDate("Sat, 27 Sep 2026 22:47:34 +0800 (CST)")
        XCTAssertNotNil(d)
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(secondsFromGMT: 8 * 3600)!
        XCTAssertEqual(cal.component(.hour, from: d!), 22)
        XCTAssertNotNil(MIMEMessage.parseDate("27 Sep 2026 14:47:34 GMT"))
    }

    func testMultipartPrefersPlainTextAndListsAttachments() {
        let raw = """
        From: =?utf-8?B?5pyN5Yqh?= <svc@example.com>\r
        To: leo@example.com\r
        Subject: =?utf-8?Q?=E8=AE=A2=E5=8D=95=E7=A1=AE=E8=AE=A4?=\r
        Date: Sat, 27 Sep 2026 10:00:00 +0800\r
        Content-Type: multipart/mixed; boundary="outer"\r
        \r
        --outer\r
        Content-Type: multipart/alternative; boundary="inner"\r
        \r
        --inner\r
        Content-Type: text/plain; charset="utf-8"\r
        Content-Transfer-Encoding: base64\r
        \r
        5oiR55qE6K6i5Y2V5bey5o+Q5Lqk44CC\r
        --inner\r
        Content-Type: text/html; charset="utf-8"\r
        \r
        <p>我的订单<b>已提交</b>。</p>\r
        --inner--\r
        --outer\r
        Content-Type: application/pdf; name="invoice.pdf"\r
        Content-Disposition: attachment; filename="invoice.pdf"\r
        Content-Transfer-Encoding: base64\r
        \r
        JVBERi0xLjQK\r
        --outer--\r
        """
        let message = MIMEMessage.parse(Data(raw.utf8))
        XCTAssertEqual(message.subject, "订单确认")
        XCTAssertEqual(message.from.first?.name, "服务")
        XCTAssertEqual(message.text, "我的订单已提交。")
        XCTAssertEqual(message.attachments.map(\.filename), ["invoice.pdf"])
        XCTAssertEqual(message.attachments.first?.mimeType, "application/pdf")
    }

    func testHtmlOnlyBodyBecomesText() {
        let raw = "Subject: hi\r\nContent-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n<div>Hello<br>=E4=BD=A0=E5=A5=BD &amp; bye</div><style>p{}</style>"
        let message = MIMEMessage.parse(Data(raw.utf8))
        XCTAssertEqual(message.text, "Hello\n你好 & bye")
    }

    func testGBKBodyDecodes() {
        // "你好" in GB2312
        var raw = Data("Subject: x\r\nContent-Type: text/plain; charset=gb2312\r\n\r\n".utf8)
        raw.append(contentsOf: [0xC4, 0xE3, 0xBA, 0xC3])
        XCTAssertEqual(MIMEMessage.parse(raw).text, "你好")
    }

    func testIMAPFetchResponseWithLiteral() {
        let line = "* 12 FETCH (UID 345 FLAGS (\\Seen $Junk) RFC822.SIZE 2048 INTERNALDATE \"27-Sep-2026 10:00:00 +0800\" BODY[HEADER.FIELDS (FROM SUBJECT)] {31})"
        let literal = Data("From: a@b.c\r\nSubject: Hi\r\n\r\n".utf8)
        let response = IMAPResponse.parse(line: line, literals: [literal])
        XCTAssertEqual(response.untaggedName, "FETCH")
        let record = IMAPFetchRecord(response)
        XCTAssertNotNil(record)
        XCTAssertEqual(record?.uid, 345)
        XCTAssertEqual(record?.size, 2048)
        XCTAssertEqual(record?.flags, ["\\Seen", "$Junk"])
        XCTAssertEqual(record?.internalDate, "27-Sep-2026 10:00:00 +0800")
        XCTAssertEqual(record?.bodySection(), literal)
        // 服务器实际的一行到 {31} 就结束,字面量字节后才是 ")":连接层按行尾的 {N} 决定读多少字节。
        XCTAssertEqual(IMAPClient.trailingLiteralLength("* 12 FETCH (UID 345 BODY[HEADER.FIELDS (FROM SUBJECT)] {31}"), 31)
        XCTAssertNil(IMAPClient.trailingLiteralLength(line))
        XCTAssertNil(IMAPClient.trailingLiteralLength("* 3 EXISTS"))
    }

    func testIMAPSearchAndStatusResponses() {
        let search = IMAPResponse.parse(line: "* SEARCH 3 17 4022", literals: [])
        XCTAssertEqual(search.untaggedName, "SEARCH")
        XCTAssertEqual(search.items.dropFirst().compactMap(\.intValue), [3, 17, 4022])
        let no = IMAPResponse.parse(line: "A003 NO [AUTHENTICATIONFAILED] Invalid credentials (Failure)", literals: [])
        XCTAssertEqual(no.kind, .tagged("A003"))
        XCTAssertEqual(no.status, "NO")
        XCTAssertEqual(no.statusText, "Invalid credentials (Failure)")
        let cont = IMAPResponse.parse(line: "+ go ahead", literals: [])
        XCTAssertEqual(cont.kind, .continuation)
        let list = IMAPResponse.parse(line: "* LIST (\\HasNoChildren) \"/\" \"&XfJT0ZAB-\"", literals: [])
        XCTAssertEqual(list.items[3].stringValue, "&XfJT0ZAB-")
    }

    func testModifiedUTF7() {
        XCTAssertEqual(IMAPModifiedUTF7.decode("&XfJT0ZAB-"), "已发送")
        XCTAssertEqual(IMAPModifiedUTF7.decode("INBOX"), "INBOX")
        XCTAssertEqual(IMAPModifiedUTF7.decode("A&-B"), "A&B")
        XCTAssertEqual(IMAPModifiedUTF7.encode("已发送"), "&XfJT0ZAB-")
        XCTAssertEqual(IMAPModifiedUTF7.encode("INBOX"), "INBOX")
    }

    func testSinceParsing() {
        XCTAssertNotNil(MailService.parseSince("2026-09-20"))
        let week = MailService.parseSince("7d")!
        XCTAssertEqual(week.timeIntervalSinceNow, -7 * 86400, accuracy: 5)
        XCTAssertNil(MailService.parseSince("yesterday"))
    }
}
