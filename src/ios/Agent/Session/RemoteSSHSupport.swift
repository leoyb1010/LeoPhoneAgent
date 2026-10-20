//
//  RemoteSSHSupport.swift
//  MinisApp
//
//  SSH 执行器 / 交互终端用到的纯逻辑（不依赖 Citadel，App 与逻辑测试都编译这一份）。
//

import CryptoKit
import Foundation

/// 字节流 → 整行文字。按字节缓冲到 \n 再整行解码：0x0A 不会出现在 UTF-8 多字节序列里，
/// 所以一个汉字被 SSH 分包切成两半时不会变成 �（原来每包单独 String(buffer:) 解码）。
struct SSHLineBuffer {
    private var pending: [UInt8] = []

    mutating func append<S: Sequence>(_ bytes: S) -> [String] where S.Element == UInt8 {
        pending.append(contentsOf: bytes)
        var lines: [String] = []
        var start = 0
        while let nl = pending[start...].firstIndex(of: 0x0A) {
            lines.append(String(decoding: pending[start..<nl], as: UTF8.self))
            start = nl + 1
        }
        if start > 0 { pending.removeFirst(start) }
        return lines
    }

    /// 流结束时剩下的半行。
    mutating func flush() -> String? {
        defer { pending.removeAll() }
        return pending.isEmpty ? nil : String(decoding: pending, as: UTF8.self)
    }
}

/// 字节流 → 文字，只在完整的 UTF-8 字符边界处切；结尾不完整的 1~3 字节留到下一包。
struct SSHUTF8Decoder {
    private var carry: [UInt8] = []

    mutating func decode<S: Sequence>(_ bytes: S) -> String where S.Element == UInt8 {
        carry.append(contentsOf: bytes)
        let cut = Self.completePrefixLength(carry)
        let text = String(decoding: carry[..<cut], as: UTF8.self)
        carry.removeFirst(cut)
        return text
    }

    mutating func flush() -> String {
        defer { carry.removeAll() }
        return String(decoding: carry, as: UTF8.self)
    }

    /// 末尾若是一个还没收全的多字节字符，返回它之前的长度；坏字节不扣留（照常解成 �）。
    static func completePrefixLength(_ bytes: [UInt8]) -> Int {
        var i = bytes.count - 1
        var back = 0
        while i >= 0, back < 4, bytes[i] & 0xC0 == 0x80 { i -= 1; back += 1 }
        guard i >= 0 else { return bytes.count }
        let lead = bytes[i]
        let need: Int
        switch lead {
        case 0xF0...0xF7: need = 4
        case 0xE0...0xEF: need = 3
        case 0xC0...0xDF: need = 2
        default: return bytes.count
        }
        return bytes.count - i < need ? i : bytes.count
    }
}

/// 只保留输出的头 4000 + 尾 16000 字符（编译错误、测试失败通常在结尾），中间标注省略了多少。
/// 边收边裁，不把全部输出先读进内存。
struct SSHOutputClip {
    let headLimit: Int
    let tailLimit: Int
    private(set) var head = ""
    private var tail = ""
    private var tailCount = 0
    private(set) var dropped = 0

    init(headLimit: Int = 4000, tailLimit: Int = 16000) {
        self.headLimit = headLimit
        self.tailLimit = tailLimit
    }

    mutating func append(_ text: String) {
        var rest = Substring(text)
        if head.count < headLimit {
            let room = headLimit - head.count
            head += rest.prefix(room)
            rest = rest.dropFirst(room)
        }
        guard !rest.isEmpty else { return }
        tail += rest
        tailCount += rest.count
        // 攒到两倍再裁，避免每包都 O(n) 拷贝。
        if tailCount > tailLimit * 2 { trimTail() }
    }

    private mutating func trimTail() {
        guard tailCount > tailLimit else { return }
        let extra = tailCount - tailLimit
        tail.removeFirst(extra)
        tailCount = tailLimit
        dropped += extra
    }

    var text: String {
        var copy = self
        copy.trimTail()
        guard copy.dropped > 0 else { return copy.head + copy.tail }
        return copy.head + "\n… [省略中间 \(copy.dropped) 字符] …\n" + copy.tail
    }
}

enum RemoteSSHText {
    /// 剥掉 `[leo-exit:N]` 尾巴，返回正文与退出码（没有尾巴时 code 为 nil）。
    static func splitExitTrailer(_ text: String) -> (body: String, code: String?) {
        guard let range = text.range(of: "[leo-exit:", options: .backwards),
              let close = text[range.upperBound...].firstIndex(of: "]") else { return (text, nil) }
        let code = String(text[range.upperBound..<close])
        return (String(text[..<range.lowerBound]).trimmingCharacters(in: .newlines), code)
    }

    /// 网关上的 ssh 成功连上目标、开始跑命令前先打的标记。见 RemoteSSHTrust.relayCommand。
    static let relayStartedMarker = "[leo-relay-started]"

    /// 经网关跑的结果失败时，能不能换下一个网关重试。
    /// 只有「ssh 自己没连上」才换：退出码 255 且目标那边从没打出开始标记。
    /// 命令自己 exit 255（标记已经打出来了）说明命令已经在目标上跑过，换网关会把副作用执行两遍。
    static func relayMayRetry(output: String, exitCode: String?) -> Bool {
        exitCode == "255" && !output.contains(relayStartedMarker)
    }

    /// 去掉开始标记那一行，不让它出现在给模型的输出里。
    static func stripRelayMarker(_ text: String) -> String {
        guard let range = text.range(of: relayStartedMarker + "\n") ?? text.range(of: relayStartedMarker) else { return text }
        var copy = text
        copy.removeSubrange(range)
        return copy
    }

    /// `cd` 到工作目录。`~` / `~/x` 不能整个单引号包住（会把 ~ 当字面目录名）：
    /// 换成 "$HOME" 再接引号包住的剩余部分。空或 `~` 返回 nil（登录 shell 本来就在 $HOME）。
    static func cdCommand(workdir raw: String) -> String? {
        let workdir = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if workdir.isEmpty || workdir == "~" || workdir == "~/" { return nil }
        if workdir.hasPrefix("~/") {
            return "cd \"$HOME\"/" + RemoteSSHTrust.singleQuoted(String(workdir.dropFirst(2)))
        }
        return "cd " + RemoteSSHTrust.singleQuoted(workdir)
    }

    /// OpenSSH 风格指纹：SHA256:<base64 无填充>。
    static func fingerprint(publicKeyLine: String) -> String? {
        let fields = publicKeyLine.split(whereSeparator: { $0.isWhitespace })
        guard fields.count >= 2, let blob = Data(base64Encoded: String(fields[1])) else { return nil }
        let digest = Data(SHA256.hash(data: blob)).base64EncodedString()
        return "SHA256:" + digest.replacingOccurrences(of: "=", with: "")
    }
}

/// 交互终端连上后往 shell 里敲的第一行。
enum SSHTerminalBootstrap {
    static let sessionName = "leobot"
    /// 没装 tmux 时用 OSC 标题悄悄告诉 App（终端里看不到），由界面在顶部提示一次。
    static let noTmuxTitle = "leobot:no-tmux"

    /// 开头空格：多数 shell 配置下不进历史。有 tmux 就 attach 到同一个会话（没有就新建），
    /// 断线重连后还是原来的窗口；没有 tmux 清屏后留在普通 shell。
    static func command(autoTmux: Bool) -> String? {
        guard autoTmux else { return nil }
        return " if command -v tmux >/dev/null 2>&1; then tmux new -A -s \(sessionName); "
            + "else clear; printf '\\033]0;\(noTmuxTitle)\\007'; fi\r"
    }
}

/// 粘贴的 OpenSSH 私钥：类型、是否加了口令。只看外壳，不解密。
enum SSHPrivateKeyInfo {
    enum Kind: String, Codable { case ed25519, rsa }

    struct Parsed: Equatable {
        let kind: Kind
        let encrypted: Bool
        /// 私钥文件外壳里明文存着公钥，加了口令也能读到：用来展示和填 authorized_keys。
        let publicKeyLine: String
    }

    enum ParseError: Error, Equatable {
        case notOpenSSH
        case unsupported(String)
    }

    static func parse(_ pem: String) throws -> Parsed {
        let trimmed = pem.trimmingCharacters(in: .whitespacesAndNewlines)
        let begin = "-----BEGIN OPENSSH PRIVATE KEY-----", end = "-----END OPENSSH PRIVATE KEY-----"
        guard trimmed.hasPrefix(begin), trimmed.hasSuffix(end) else { throw ParseError.notOpenSSH }
        let body = trimmed.dropFirst(begin.count).dropLast(end.count)
            .filter { !$0.isWhitespace }
        guard let data = Data(base64Encoded: String(body)) else { throw ParseError.notOpenSSH }
        var reader = Reader(bytes: [UInt8](data))
        guard reader.take(15) == Array("openssh-key-v1\0".utf8),
              let cipher = reader.string(), reader.string() != nil, reader.chunk() != nil,
              reader.uint32() == 1, let blob = reader.chunk() else { throw ParseError.notOpenSSH }
        var publicBlob = Reader(bytes: blob)
        guard let keyType = publicBlob.string() else { throw ParseError.notOpenSSH }
        let kind: Kind
        switch keyType {
        case "ssh-ed25519": kind = .ed25519
        case "ssh-rsa": kind = .rsa
        default: throw ParseError.unsupported(keyType)
        }
        return Parsed(kind: kind, encrypted: cipher != "none",
                      publicKeyLine: keyType + " " + Data(blob).base64EncodedString())
    }

    private struct Reader {
        let bytes: [UInt8]
        var offset = 0

        mutating func take(_ n: Int) -> [UInt8]? {
            guard n >= 0, offset + n <= bytes.count else { return nil }
            defer { offset += n }
            return Array(bytes[offset..<offset + n])
        }

        mutating func uint32() -> Int? {
            guard let b = take(4) else { return nil }
            return b.reduce(0) { $0 << 8 | Int($1) }
        }

        mutating func chunk() -> [UInt8]? {
            guard let n = uint32() else { return nil }
            return take(n)
        }

        mutating func string() -> String? {
            chunk().map { String(decoding: $0, as: UTF8.self) }
        }
    }
}
