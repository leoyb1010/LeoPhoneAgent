//
//  IMAPResponse.swift
//  MinisApp
//
//  [T-mail] IMAP 响应的词法 / 结构解析(RFC 3501)。一条逻辑响应 = 一行文本,其中的
//  字面量 {N} 已由连接层读成字节、按顺序放进 `literals`。解析结果是嵌套的 IMAPValue,
//  FETCH 的键值对由 IMAPFetchRecord 提取。纯函数,MinisTests 里有单测。
//

import Foundation

indirect enum IMAPValue: Equatable {
    case atom(String)          // 包括 NIL、数字以外的裸词,以及 BODY[HEADER.FIELDS (FROM)] 这种带段说明的
    case string(String)        // "quoted"
    case literal(Data)         // {N}
    case number(Int)
    case list([IMAPValue])

    var stringValue: String? {
        switch self {
        case .atom(let s): return s == "NIL" ? nil : s
        case .string(let s): return s
        case .literal(let d): return String(data: d, encoding: .utf8) ?? String(decoding: d, as: UTF8.self)
        case .number(let n): return String(n)
        case .list: return nil
        }
    }

    var dataValue: Data? {
        switch self {
        case .literal(let d): return d
        case .string(let s): return Data(s.utf8)
        default: return nil
        }
    }

    var intValue: Int? {
        switch self {
        case .number(let n): return n
        case .atom(let s), .string(let s): return Int(s)
        default: return nil
        }
    }

    var listValue: [IMAPValue]? {
        if case .list(let items) = self { return items }
        return nil
    }
}

/// 一条完整的服务器响应(untagged `* ...`、tagged `A001 OK ...` 或 continuation `+ ...`)。
struct IMAPResponse: Equatable {
    enum Kind: Equatable { case untagged, tagged(String), continuation }
    var kind: Kind
    /// 解析出来的词,例如 `* 12 FETCH (...)` → [12, FETCH, list]。
    var items: [IMAPValue]
    /// 原始文本(字面量位置以 {N} 保留),给日志和错误信息用。
    var line: String

    /// tagged 响应的状态词:OK / NO / BAD。
    var status: String? {
        guard case .tagged = kind, let first = items.first, case .atom(let s) = first else { return nil }
        return s.uppercased()
    }

    /// OK/NO/BAD 后面的人话(不含 [CODE])。
    var statusText: String {
        var parts = line.split(separator: " ", omittingEmptySubsequences: true).map(String.init)
        if parts.count >= 2 { parts.removeFirst(2) }
        if let first = parts.first, first.hasPrefix("[") {
            if let close = parts.firstIndex(where: { $0.hasSuffix("]") }) { parts.removeFirst(close + 1) }
        }
        return parts.joined(separator: " ")
    }

    /// untagged 响应的名字:`* 3 EXISTS` → EXISTS,`* SEARCH ...` → SEARCH,`* OK [..]` → OK。
    var untaggedName: String? {
        guard case .untagged = kind else { return nil }
        if let first = items.first, case .number = first, items.count > 1, case .atom(let name) = items[1] { return name.uppercased() }
        if let first = items.first, case .atom(let name) = first { return name.uppercased() }
        return nil
    }

    var untaggedNumber: Int? {
        guard case .untagged = kind, let first = items.first, case .number(let n) = first else { return nil }
        return n
    }

    static func parse(line: String, literals: [Data]) -> IMAPResponse {
        var parser = Parser(text: Array(line.utf8), literals: literals)
        let kind: Kind
        if parser.consume(prefix: "* ") { kind = .untagged }
        else if parser.consume(prefix: "+ ") || parser.text == Array("+".utf8) { kind = .continuation }
        else {
            let tag = parser.readWord()
            parser.skipSpaces()
            kind = .tagged(tag)
        }
        var items: [IMAPValue] = []
        while !parser.atEnd {
            parser.skipSpaces()
            if parser.atEnd { break }
            items.append(parser.readValue())
        }
        return IMAPResponse(kind: kind, items: items, line: line)
    }

    private struct Parser {
        var text: [UInt8]
        var pos = 0
        var literals: [Data]
        var literalIndex = 0

        init(text: [UInt8], literals: [Data]) { self.text = text; self.literals = literals }

        var atEnd: Bool { pos >= text.count }

        mutating func consume(prefix: String) -> Bool {
            let p = Array(prefix.utf8)
            guard text.count - pos >= p.count, Array(text[pos..<pos + p.count]) == p else { return false }
            pos += p.count
            return true
        }

        mutating func skipSpaces() { while pos < text.count, text[pos] == 0x20 { pos += 1 } }

        mutating func readWord() -> String {
            let start = pos
            while pos < text.count, text[pos] != 0x20 { pos += 1 }
            return String(decoding: text[start..<pos], as: UTF8.self)
        }

        mutating func readValue() -> IMAPValue {
            guard pos < text.count else { return .atom("") }
            let c = text[pos]
            if c == 0x28 { // (
                pos += 1
                var items: [IMAPValue] = []
                while pos < text.count {
                    skipSpaces()
                    if pos < text.count, text[pos] == 0x29 { pos += 1; break }
                    if pos >= text.count { break }
                    items.append(readValue())
                }
                return .list(items)
            }
            if c == 0x22 { // "
                pos += 1
                var bytes: [UInt8] = []
                while pos < text.count, text[pos] != 0x22 {
                    if text[pos] == 0x5C, pos + 1 < text.count { pos += 1 }
                    bytes.append(text[pos]); pos += 1
                }
                pos += 1
                return .string(String(decoding: bytes, as: UTF8.self))
            }
            if c == 0x7B { // {N}
                var end = pos
                while end < text.count, text[end] != 0x7D { end += 1 }
                pos = min(end + 1, text.count)
                if literalIndex < literals.count {
                    let d = literals[literalIndex]; literalIndex += 1
                    return .literal(d)
                }
                return .literal(Data())
            }
            // atom:到空格或右括号为止;[...] 里的内容整段吞掉(BODY[HEADER.FIELDS (FROM TO)])
            let start = pos
            var depth = 0
            while pos < text.count {
                let b = text[pos]
                if b == 0x5B { depth += 1 }
                else if b == 0x5D { depth = max(0, depth - 1) }
                else if depth == 0, b == 0x20 || b == 0x29 || b == 0x28 { break }
                pos += 1
            }
            let word = String(decoding: text[start..<pos], as: UTF8.self)
            if let n = Int(word), !word.isEmpty, word.allSatisfy({ $0.isNumber }) { return .number(n) }
            return .atom(word)
        }
    }
}

/// `* 12 FETCH (UID 345 FLAGS (\Seen) ... BODY[HEADER.FIELDS (...)] {n})` 的键值视图。
struct IMAPFetchRecord {
    var sequence: Int
    var fields: [(key: String, value: IMAPValue)]

    init?(_ response: IMAPResponse) {
        guard response.untaggedName == "FETCH", let seq = response.untaggedNumber,
              response.items.count >= 3, let list = response.items[2].listValue else { return nil }
        sequence = seq
        var fields: [(String, IMAPValue)] = []
        var i = 0
        while i + 1 < list.count {
            guard case .atom(let key) = list[i] else { i += 1; continue }
            fields.append((key.uppercased(), list[i + 1]))
            i += 2
        }
        self.fields = fields
    }

    func value(_ key: String) -> IMAPValue? {
        fields.first { $0.key == key.uppercased() }?.value
    }

    /// BODY[...] 段(任何段说明)对应的字节。
    func bodySection(prefix: String = "BODY[") -> Data? {
        fields.first { $0.key.hasPrefix(prefix.uppercased()) }?.value.dataValue
    }

    var uid: Int? { value("UID")?.intValue }
    var size: Int? { value("RFC822.SIZE")?.intValue }
    var flags: [String] { value("FLAGS")?.listValue?.compactMap(\.stringValue) ?? [] }
    var internalDate: String? { value("INTERNALDATE")?.stringValue }
}
