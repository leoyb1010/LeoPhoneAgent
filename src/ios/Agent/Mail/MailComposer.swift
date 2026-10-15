//
//  MailComposer.swift
//  MinisApp
//
//  [T-mail-write] 组一封纯文本邮件(RFC 5322 + MIME),给存草稿和发信共用。纯逻辑,逻辑测试直接覆盖。
//
//  - 头部的中文用 RFC 2047 编码字(=?UTF-8?B?…?=),正文 UTF-8 + base64,每行 76 字符、CRLF 结尾。
//  - 地址和主题来自模型:任何 CR / LF 都会让一个头变成两个(往信里注入 Bcc),一律拒绝或去掉。
//  - 密送只进投递列表(RCPT TO),不写进信头。
//

import Foundation

enum MailComposeError: LocalizedError, Equatable {
    case noRecipients
    case invalidAddress(String)
    case tooManyRecipients(Int)
    case emptyBody

    var errorDescription: String? {
        switch self {
        case .noRecipients: return "没有收件人"
        case .invalidAddress(let a): return "收件人地址不对:\(a)"
        case .tooManyRecipients(let n): return "收件人太多(\(n) 个),一次最多 \(MailComposer.maxRecipients) 个"
        case .emptyBody: return "正文是空的"
        }
    }
}

struct MailDraft: Equatable {
    var from: MailAddress
    var to: [String]
    var cc: [String] = []
    var bcc: [String] = []
    var subject: String
    var body: String
    /// 回复时:原信的 Message-ID 和 References。
    var inReplyTo: String?
    var references: [String] = []
}

struct ComposedMail: Equatable {
    var data: Data
    var messageId: String
    /// RCPT TO 用的纯地址(收件人 + 抄送 + 密送,去重)。
    var envelopeRecipients: [String]
}

enum MailComposer {
    static let maxRecipients = 50

    static func compose(_ draft: MailDraft, date: Date = Date(), uniqueId: String = UUID().uuidString) throws -> ComposedMail {
        let to = try normalizeList(draft.to)
        let cc = try normalizeList(draft.cc)
        let bcc = try normalizeList(draft.bcc)
        let everyone = dedupe(to + cc + bcc)
        guard !to.isEmpty || !cc.isEmpty || !bcc.isEmpty else { throw MailComposeError.noRecipients }
        guard everyone.count <= maxRecipients else { throw MailComposeError.tooManyRecipients(everyone.count) }
        guard isValidAddress(draft.from.email) else { throw MailComposeError.invalidAddress(draft.from.email) }
        let body = draft.body.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !body.isEmpty else { throw MailComposeError.emptyBody }

        let domain = draft.from.email.split(separator: "@").last.map(String.init) ?? "localhost"
        let messageId = "<\(uniqueId.lowercased())@\(domain)>"
        var headers: [String] = [
            "Date: \(rfc5322Date(date))",
            "From: \(formatAddress(draft.from))",
        ]
        if !to.isEmpty { headers.append("To: \(to.joined(separator: ", "))") }
        if !cc.isEmpty { headers.append("Cc: \(cc.joined(separator: ", "))") }
        headers.append("Subject: \(encodeHeaderText(singleLine(draft.subject)))")
        headers.append("Message-ID: \(messageId)")
        if let reply = draft.inReplyTo.map(singleLine), isMessageId(reply) {
            headers.append("In-Reply-To: \(reply)")
            let chain = (draft.references.map(singleLine).filter(isMessageId) + [reply])
            headers.append("References: \(dedupe(chain).joined(separator: " "))")
        }
        headers += [
            "MIME-Version: 1.0",
            "Content-Type: text/plain; charset=UTF-8",
            "Content-Transfer-Encoding: base64",
        ]
        let normalizedBody = draft.body.replacingOccurrences(of: "\r\n", with: "\n")
            .replacingOccurrences(of: "\n", with: "\r\n")
        let encodedBody = wrap(Data(normalizedBody.utf8).base64EncodedString(), width: 76)
        let text = headers.joined(separator: "\r\n") + "\r\n\r\n" + encodedBody + "\r\n"
        return ComposedMail(data: Data(text.utf8), messageId: messageId, envelopeRecipients: everyone)
    }

    // MARK: - Reply helpers

    /// "Re: 原主题";已经是 Re: / 回复: / 答复: 开头的不再叠加。
    static func replySubject(_ original: String) -> String {
        let trimmed = original.trimmingCharacters(in: .whitespaces)
        let lowered = trimmed.lowercased()
        if lowered.hasPrefix("re:") || lowered.hasPrefix("re：") || trimmed.hasPrefix("回复:") || trimmed.hasPrefix("回复：")
            || trimmed.hasPrefix("答复:") || trimmed.hasPrefix("答复：") {
            return trimmed
        }
        return "Re: " + trimmed
    }

    // MARK: - Addresses

    /// "a@b.com, 张三 <c@d.com>" 或数组 → 纯地址列表。只接受格式正确的地址。
    static func normalizeList(_ raw: [String]) throws -> [String] {
        var out: [String] = []
        for item in raw.flatMap({ $0.split(whereSeparator: { $0 == "," || $0 == ";" || $0 == "，" || $0 == "；" }) }) {
            let piece = item.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !piece.isEmpty else { continue }
            let email: String
            if let open = piece.lastIndex(of: "<"), let close = piece.lastIndex(of: ">"), open < close {
                email = String(piece[piece.index(after: open)..<close]).trimmingCharacters(in: .whitespaces)
            } else {
                email = piece
            }
            guard isValidAddress(email) else { throw MailComposeError.invalidAddress(piece) }
            out.append(email)
        }
        return dedupe(out)
    }

    static func isValidAddress(_ email: String) -> Bool {
        let scalars = email.unicodeScalars
        guard email.count <= 254, !scalars.contains(where: { $0 == "\r" || $0 == "\n" || $0 == "\0" || $0 == " " || $0 == "<" || $0 == ">" || $0 == "," || $0 == ";" || $0 == "\"" }) else { return false }
        let parts = email.split(separator: "@", omittingEmptySubsequences: false)
        guard parts.count == 2, !parts[0].isEmpty, parts[1].contains("."),
              !parts[1].hasPrefix("."), !parts[1].hasSuffix(".") else { return false }
        return true
    }

    static func formatAddress(_ address: MailAddress) -> String {
        let name = singleLine(address.name).replacingOccurrences(of: "\"", with: "")
        guard !name.isEmpty else { return address.email }
        let shown = name.unicodeScalars.allSatisfy({ $0.isASCII }) ? "\"\(name)\"" : encodeHeaderText(name)
        return "\(shown) <\(address.email)>"
    }

    // MARK: - Encoding

    /// 非 ASCII 的头部文字编码成若干个编码字(每个不超过 75 字符,不把一个 UTF-8 字符劈开)。
    static func encodeHeaderText(_ text: String) -> String {
        if text.unicodeScalars.allSatisfy({ $0.isASCII }) { return text }
        var words: [String] = []
        var chunk = ""
        for ch in text {
            if (chunk + String(ch)).utf8.count > 45 {
                words.append(chunk)
                chunk = ""
            }
            chunk.append(ch)
        }
        if !chunk.isEmpty { words.append(chunk) }
        return words.map { "=?UTF-8?B?\(Data($0.utf8).base64EncodedString())?=" }.joined(separator: "\r\n ")
    }

    static func singleLine(_ s: String) -> String {
        String(String.UnicodeScalarView(s.unicodeScalars.map { ($0 == "\r" || $0 == "\n" || $0 == "\0") ? " " : $0 }))
            .trimmingCharacters(in: .whitespaces)
    }

    static func rfc5322Date(_ date: Date) -> String {
        let fmt = DateFormatter()
        fmt.locale = Locale(identifier: "en_US_POSIX")
        fmt.dateFormat = "EEE, dd MMM yyyy HH:mm:ss Z"
        return fmt.string(from: date)
    }

    private static func isMessageId(_ s: String) -> Bool {
        s.hasPrefix("<") && s.hasSuffix(">") && s.count > 2 && !s.contains(" ")
    }

    private static func wrap(_ s: String, width: Int) -> String {
        var lines: [Substring] = []
        var i = s.startIndex
        while i < s.endIndex {
            let j = s.index(i, offsetBy: width, limitedBy: s.endIndex) ?? s.endIndex
            lines.append(s[i..<j])
            i = j
        }
        return lines.joined(separator: "\r\n")
    }

    private static func dedupe(_ items: [String]) -> [String] {
        var seen = Set<String>()
        return items.filter { seen.insert($0.lowercased()).inserted }
    }
}
