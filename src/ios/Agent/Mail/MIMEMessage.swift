//
//  MIMEMessage.swift
//  MinisApp
//
//  [T-mail] 邮件正文解析:RFC 2822 头(折行、RFC 2047 编码词)、MIME multipart、
//  base64 / quoted-printable、常见字符集(utf-8、gb2312/gbk/gb18030、big5、latin1)。
//  只做「读」需要的那一部分:正文取 text/plain,没有就把 text/html 去标签;
//  附件只列名字、类型、大小,不解码内容。纯函数,MinisTests 里有单测。
//

import Foundation

struct MailAddress: Codable, Equatable {
    var name: String
    var email: String

    var display: String {
        name.isEmpty ? email : (email.isEmpty ? name : "\(name) <\(email)>")
    }
}

struct MailAttachmentInfo: Codable, Equatable {
    var filename: String
    var mimeType: String
    var size: Int
}

/// 解析好的一封邮件(或只有头的摘要)。
struct MIMEMessage: Equatable {
    var subject: String = ""
    var from: [MailAddress] = []
    var to: [MailAddress] = []
    var cc: [MailAddress] = []
    var date: Date?
    var messageId: String = ""
    /// 正文纯文本(text/plain 优先,否则 text/html 去标签)。
    var text: String = ""
    var attachments: [MailAttachmentInfo] = []

    // MARK: - Headers

    /// 把头部原文(到第一个空行为止)解析成 name → [value],折行已合并、名字小写。
    static func parseHeaders(_ raw: String) -> [String: [String]] {
        var result: [String: [String]] = [:]
        var current: (name: String, value: String)?
        func flush() {
            guard let c = current else { return }
            result[c.name, default: []].append(c.value.trimmingCharacters(in: .whitespaces))
            current = nil
        }
        for line in raw.replacingOccurrences(of: "\r\n", with: "\n").split(separator: "\n", omittingEmptySubsequences: false) {
            if line.isEmpty { break }
            if let first = line.first, first == " " || first == "\t" {
                current?.value += " " + line.trimmingCharacters(in: .whitespaces)
                continue
            }
            flush()
            guard let colon = line.firstIndex(of: ":") else { continue }
            let name = line[..<colon].trimmingCharacters(in: .whitespaces).lowercased()
            let value = String(line[line.index(after: colon)...])
            current = (name, value)
        }
        flush()
        return result
    }

    /// RFC 2047 编码词:=?charset?B|Q?text?=,相邻编码词之间的空白按规范丢掉。
    static func decodeEncodedWords(_ input: String) -> String {
        guard input.contains("=?") else { return input }
        var out = ""
        var rest = Substring(input)
        var lastWasEncoded = false
        var pendingSpace = ""
        while let start = rest.range(of: "=?") {
            let before = rest[..<start.lowerBound]
            // 找 charset ? enc ? text ?=
            var scan = rest[start.upperBound...]
            guard let q1 = scan.firstIndex(of: "?") else { break }
            let charset = String(scan[..<q1])
            scan = scan[scan.index(after: q1)...]
            guard let q2 = scan.firstIndex(of: "?") else { break }
            let encoding = String(scan[..<q2]).uppercased()
            scan = scan[scan.index(after: q2)...]
            guard let end = scan.range(of: "?=") else { break }
            let payload = String(scan[..<end.lowerBound])
            let decoded: String?
            switch encoding {
            case "B": decoded = Data(base64Encoded: payload.padding(toLength: ((payload.count + 3) / 4) * 4, withPad: "=", startingAt: 0)).flatMap { decode($0, charset: charset) }
            case "Q": decoded = decode(decodeQuotedPrintable(payload.replacingOccurrences(of: "_", with: " "), header: true), charset: charset)
            default: decoded = nil
            }
            if let decoded {
                if lastWasEncoded, before.allSatisfy({ $0 == " " || $0 == "\t" }) {
                    // 两个编码词之间的空白不算内容
                } else {
                    out += pendingSpace + before
                }
                out += decoded
                lastWasEncoded = true
                pendingSpace = ""
            } else {
                out += before + "=?" + charset + "?" + encoding + "?" + payload + "?="
                lastWasEncoded = false
            }
            rest = scan[end.upperBound...]
        }
        out += rest
        return out
    }

    /// "Leo Yuan" <leo@x.com>, bob@y.com → 地址列表。
    static func parseAddresses(_ raw: String) -> [MailAddress] {
        let decoded = decodeEncodedWords(raw)
        var result: [MailAddress] = []
        var buf = ""
        var inQuote = false
        var depth = 0
        var parts: [String] = []
        for ch in decoded {
            if ch == "\"" { inQuote.toggle() }
            if !inQuote {
                if ch == "<" { depth += 1 }
                if ch == ">" { depth = max(0, depth - 1) }
            }
            if ch == "," && !inQuote && depth == 0 {
                parts.append(buf); buf = ""
            } else {
                buf.append(ch)
            }
        }
        parts.append(buf)
        for part in parts {
            let p = part.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !p.isEmpty else { continue }
            if let lt = p.lastIndex(of: "<"), let gt = p[lt...].firstIndex(of: ">") {
                let email = String(p[p.index(after: lt)..<gt]).trimmingCharacters(in: .whitespaces)
                var name = String(p[..<lt]).trimmingCharacters(in: .whitespaces)
                if name.hasPrefix("\""), name.hasSuffix("\""), name.count >= 2 {
                    name = String(name.dropFirst().dropLast()).replacingOccurrences(of: "\\\"", with: "\"")
                }
                result.append(MailAddress(name: name, email: email))
            } else if p.contains("@") {
                result.append(MailAddress(name: "", email: p.trimmingCharacters(in: CharacterSet(charactersIn: "<>"))))
            } else {
                result.append(MailAddress(name: p, email: ""))
            }
        }
        return result
    }

    /// RFC 2822 日期,容忍缺星期、注释和 GMT/UTC 字面量。
    static func parseDate(_ raw: String) -> Date? {
        var s = raw
        if let paren = s.firstIndex(of: "(") { s = String(s[..<paren]) }
        s = s.trimmingCharacters(in: .whitespacesAndNewlines)
        s = s.replacingOccurrences(of: " GMT", with: " +0000").replacingOccurrences(of: " UTC", with: " +0000")
        s = s.replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
        let fmt = DateFormatter()
        fmt.locale = Locale(identifier: "en_US_POSIX")
        for pattern in ["EEE, d MMM yyyy HH:mm:ss Z", "d MMM yyyy HH:mm:ss Z", "EEE, d MMM yyyy HH:mm Z", "d MMM yyyy HH:mm Z", "EEE, d MMM yyyy HH:mm:ss", "yyyy-MM-dd HH:mm:ss Z"] {
            fmt.dateFormat = pattern
            if let d = fmt.date(from: s) { return d }
        }
        return ISO8601DateFormatter().date(from: raw.trimmingCharacters(in: .whitespaces))
    }

    // MARK: - Body

    /// 从一封完整邮件(RFC 822 字节)解析。`truncated` 表示字节被截断过,正文末尾可能不完整。
    static func parse(_ data: Data) -> MIMEMessage {
        var message = MIMEMessage()
        let (headerText, bodyData) = splitHeaders(data)
        let headers = parseHeaders(headerText)
        message.subject = decodeEncodedWords(headers["subject"]?.first ?? "").trimmingCharacters(in: .whitespaces)
        message.from = parseAddresses(headers["from"]?.first ?? "")
        message.to = parseAddresses(headers["to"]?.joined(separator: ", ") ?? "")
        message.cc = parseAddresses(headers["cc"]?.joined(separator: ", ") ?? "")
        message.date = headers["date"]?.first.flatMap(parseDate)
        message.messageId = (headers["message-id"]?.first ?? "").trimmingCharacters(in: .whitespaces)
        var plain: [String] = []
        var html: [String] = []
        walkPart(headers: headers, body: bodyData, depth: 0, plain: &plain, html: &html, attachments: &message.attachments)
        if !plain.isEmpty {
            message.text = plain.joined(separator: "\n\n")
        } else if !html.isEmpty {
            message.text = html.map(htmlToText).joined(separator: "\n\n")
        }
        message.text = normalizeWhitespace(message.text)
        return message
    }

    /// 头 / 体分界:第一个空行。
    static func splitHeaders(_ data: Data) -> (String, Data) {
        let crlf = Data("\r\n\r\n".utf8), lf = Data("\n\n".utf8)
        var headerEnd = data.count
        var bodyStart = data.count
        if let r = data.range(of: crlf) { headerEnd = r.lowerBound; bodyStart = r.upperBound }
        else if let r = data.range(of: lf) { headerEnd = r.lowerBound; bodyStart = r.upperBound }
        let headerText = String(decoding: data[data.startIndex..<headerEnd], as: UTF8.self)
        return (headerText, data[bodyStart...])
    }

    private static func walkPart(headers: [String: [String]], body: Data, depth: Int,
                                 plain: inout [String], html: inout [String],
                                 attachments: inout [MailAttachmentInfo]) {
        guard depth < 12 else { return }
        let (mediaType, params) = parseContentType(headers["content-type"]?.first ?? "text/plain")
        let disposition = headers["content-disposition"]?.first ?? ""
        let dispParams = parseContentType(disposition).1
        let filename = decodeEncodedWords(dispParams["filename"] ?? params["name"] ?? "")
        if mediaType.hasPrefix("multipart/") {
            guard let boundary = params["boundary"], !boundary.isEmpty else { return }
            for part in splitMultipart(body, boundary: boundary) {
                let (h, b) = splitHeaders(part)
                walkPart(headers: parseHeaders(h), body: b, depth: depth + 1, plain: &plain, html: &html, attachments: &attachments)
            }
            return
        }
        let isAttachment = disposition.lowercased().hasPrefix("attachment") || (!filename.isEmpty && !mediaType.hasPrefix("text/"))
        if isAttachment || (!mediaType.hasPrefix("text/") && mediaType != "message/rfc822") {
            attachments.append(MailAttachmentInfo(
                filename: filename.isEmpty ? (mediaType.hasPrefix("image/") ? "image" : "attachment") : filename,
                mimeType: mediaType,
                size: decodedSizeEstimate(body, encoding: headers["content-transfer-encoding"]?.first ?? "")))
            return
        }
        if mediaType == "message/rfc822" {
            let inner = parse(body)
            plain.append("[转发的邮件] \(inner.subject)\n\(inner.text)")
            return
        }
        let decoded = decodeBody(body, transferEncoding: headers["content-transfer-encoding"]?.first ?? "", charset: params["charset"] ?? "utf-8")
        if mediaType == "text/html" { html.append(decoded) } else { plain.append(decoded) }
    }

    static func parseContentType(_ raw: String) -> (String, [String: String]) {
        let pieces = raw.split(separator: ";", omittingEmptySubsequences: true).map { $0.trimmingCharacters(in: .whitespaces) }
        guard let first = pieces.first else { return ("text/plain", [:]) }
        var params: [String: String] = [:]
        for piece in pieces.dropFirst() {
            guard let eq = piece.firstIndex(of: "=") else { continue }
            var key = piece[..<eq].trimmingCharacters(in: .whitespaces).lowercased()
            var value = piece[piece.index(after: eq)...].trimmingCharacters(in: .whitespaces)
            if value.hasPrefix("\""), value.hasSuffix("\""), value.count >= 2 { value = String(value.dropFirst().dropLast()) }
            // RFC 2231:filename*=utf-8''%E9%99%84%E4%BB%B6.pdf
            if key.hasSuffix("*") {
                key.removeLast()
                let segs = value.split(separator: "'", maxSplits: 2, omittingEmptySubsequences: false)
                if segs.count == 3 {
                    value = segs[2].removingPercentEncoding ?? String(segs[2])
                }
            }
            params[key] = value
        }
        return (first.lowercased(), params)
    }

    static func splitMultipart(_ body: Data, boundary: String) -> [Data] {
        let marker = Data(("--" + boundary).utf8)
        var parts: [Data] = []
        var searchFrom = body.startIndex
        var partStart: Data.Index?
        while let r = body.range(of: marker, in: searchFrom..<body.endIndex) {
            if let start = partStart {
                var end = r.lowerBound
                // 去掉分界前的 CRLF
                if end > start, body[end - 1] == 0x0A { end -= 1 }
                if end > start, body[end - 1] == 0x0D { end -= 1 }
                parts.append(body[start..<end])
            }
            var after = r.upperBound
            if after + 1 < body.endIndex, body[after] == 0x2D, body[after + 1] == 0x2D { break } // 结束分界 --boundary--
            // 跳过分界行剩余部分到行尾
            while after < body.endIndex, body[after] != 0x0A { after += 1 }
            if after < body.endIndex { after += 1 }
            partStart = after
            searchFrom = after
        }
        return parts
    }

    static func decodeBody(_ body: Data, transferEncoding: String, charset: String) -> String {
        let enc = transferEncoding.trimmingCharacters(in: .whitespaces).lowercased()
        let bytes: Data
        switch enc {
        case "base64":
            let cleaned = String(decoding: body, as: UTF8.self).filter { !$0.isWhitespace }
            bytes = Data(base64Encoded: cleaned.padding(toLength: ((cleaned.count + 3) / 4) * 4, withPad: "=", startingAt: 0)) ?? Data()
        case "quoted-printable":
            bytes = decodeQuotedPrintable(String(decoding: body, as: UTF8.self), header: false)
        default:
            bytes = body
        }
        return decode(bytes, charset: charset) ?? String(decoding: bytes, as: UTF8.self)
    }

    private static func decodedSizeEstimate(_ body: Data, encoding: String) -> Int {
        encoding.lowercased().contains("base64") ? body.count * 3 / 4 : body.count
    }

    /// quoted-printable → 字节。header=true 时是 RFC 2047 的 Q 变体(不处理软换行)。
    static func decodeQuotedPrintable(_ s: String, header: Bool) -> Data {
        var out = Data()
        let scalars = Array(s.utf8)
        var i = 0
        while i < scalars.count {
            let c = scalars[i]
            if c == 0x3D { // '='
                if !header, i + 1 < scalars.count, scalars[i + 1] == 0x0D || scalars[i + 1] == 0x0A {
                    i += 1
                    if i < scalars.count, scalars[i] == 0x0D { i += 1 }
                    if i < scalars.count, scalars[i] == 0x0A { i += 1 }
                    continue // 软换行
                }
                if i + 2 < scalars.count, let hi = hexValue(scalars[i + 1]), let lo = hexValue(scalars[i + 2]) {
                    out.append(UInt8(hi << 4 | lo)); i += 3; continue
                }
            }
            out.append(c); i += 1
        }
        return out
    }

    private static func hexValue(_ c: UInt8) -> Int? {
        switch c {
        case 0x30...0x39: return Int(c - 0x30)
        case 0x41...0x46: return Int(c - 0x41 + 10)
        case 0x61...0x66: return Int(c - 0x61 + 10)
        default: return nil
        }
    }

    /// 按 IANA 字符集名解码;utf-8 失败时按 GB18030 兜底(国内邮件常见标错)。
    static func decode(_ data: Data, charset: String) -> String? {
        let name = charset.trimmingCharacters(in: CharacterSet(charactersIn: "\" ")).lowercased()
        if name.isEmpty || name == "utf-8" || name == "utf8" || name == "us-ascii" || name == "ascii" {
            if let s = String(data: data, encoding: .utf8) { return s }
            return decodeCF(data, ianaName: "gb18030")
        }
        if let s = decodeCF(data, ianaName: name == "gb2312" || name == "gbk" ? "gb18030" : name) { return s }
        return String(data: data, encoding: .utf8) ?? String(data: data, encoding: .isoLatin1)
    }

    private static func decodeCF(_ data: Data, ianaName: String) -> String? {
        let cfEnc = CFStringConvertIANACharSetNameToEncoding(ianaName as CFString)
        guard cfEnc != kCFStringEncodingInvalidId else { return nil }
        let nsEnc = CFStringConvertEncodingToNSStringEncoding(cfEnc)
        return String(data: data, encoding: String.Encoding(rawValue: nsEnc))
    }

    /// 去标签:块级标签换行,<br> 换行,忽略 <style>/<script>,还原常见实体。
    static func htmlToText(_ html: String) -> String {
        var s = html
        s = s.replacingOccurrences(of: "(?is)<(style|script|head)[^>]*>.*?</\\1>", with: "", options: .regularExpression)
        s = s.replacingOccurrences(of: "(?i)<br\\s*/?>", with: "\n", options: .regularExpression)
        s = s.replacingOccurrences(of: "(?i)</(p|div|tr|li|h[1-6]|blockquote|table|ul|ol)>", with: "\n", options: .regularExpression)
        s = s.replacingOccurrences(of: "(?i)<li[^>]*>", with: "• ", options: .regularExpression)
        s = s.replacingOccurrences(of: "(?i)</t[dh]>", with: "\t", options: .regularExpression)
        s = s.replacingOccurrences(of: "<[^>]+>", with: "", options: .regularExpression)
        let entities: [(String, String)] = [("&nbsp;", " "), ("&amp;", "&"), ("&lt;", "<"), ("&gt;", ">"), ("&quot;", "\""), ("&#39;", "'"), ("&apos;", "'"), ("&ldquo;", "“"), ("&rdquo;", "”"), ("&hellip;", "…"), ("&mdash;", "—"), ("&copy;", "©")]
        for (k, v) in entities { s = s.replacingOccurrences(of: k, with: v) }
        s = s.replacingOccurrences(of: "&#(\\d+);", with: "$1", options: .regularExpression) // 数字实体保留数字
        return s
    }

    static func normalizeWhitespace(_ s: String) -> String {
        var t = s.replacingOccurrences(of: "\r\n", with: "\n")
        t = t.replacingOccurrences(of: "[ \\t\\u{00A0}]+\\n", with: "\n", options: .regularExpression)
        t = t.replacingOccurrences(of: "\\n{3,}", with: "\n\n", options: .regularExpression)
        return t.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

/// IMAP 邮箱名用的 modified UTF-7(RFC 3501 §5.1.3):&XfJT0ZAB- → 已发送。
enum IMAPModifiedUTF7 {
    static func decode(_ s: String) -> String {
        guard s.contains("&") else { return s }
        var out = ""
        var rest = Substring(s)
        while let amp = rest.firstIndex(of: "&") {
            out += rest[..<amp]
            let after = rest[rest.index(after: amp)...]
            guard let dash = after.firstIndex(of: "-") else { out += rest[amp...]; return out }
            let payload = String(after[..<dash])
            if payload.isEmpty {
                out += "&"
            } else {
                var b64 = payload.replacingOccurrences(of: ",", with: "/")
                b64 = b64.padding(toLength: ((b64.count + 3) / 4) * 4, withPad: "=", startingAt: 0)
                if let data = Data(base64Encoded: b64), let text = String(data: data, encoding: .utf16BigEndian) {
                    out += text
                } else {
                    out += "&" + payload + "-"
                }
            }
            rest = after[after.index(after: dash)...]
        }
        out += rest
        return out
    }

    static func encode(_ s: String) -> String {
        if s.allSatisfy({ $0.isASCII && $0 != "&" }) { return s }
        var out = ""
        var pending = ""
        func flush() {
            guard !pending.isEmpty else { return }
            let data = pending.data(using: .utf16BigEndian) ?? Data()
            var b64 = data.base64EncodedString().replacingOccurrences(of: "=", with: "")
            b64 = b64.replacingOccurrences(of: "/", with: ",")
            out += "&" + b64 + "-"
            pending = ""
        }
        for ch in s {
            if ch == "&" { flush(); out += "&-" }
            else if ch.isASCII { flush(); out.append(ch) }
            else { pending.append(ch) }
        }
        flush()
        return out
    }
}
