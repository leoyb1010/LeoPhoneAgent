import CryptoKit
import Foundation

/// 日志里不许出现助手回复 / 用户消息的原文,只许出现原文的「形状」:字符数、行数、SHA-256 前 4 字节(8 位十六进制)。
///
/// 为什么需要:`StreamingHangLogger` 在 Release 下一旦主线程卡顿 ≥1 s,会把最近 10 次文本赋值的完整 markdown
/// 按 800 字符切片写进当天日志(`assign[i] slice=N │…│`),另有最近 200 次流式刷新各 200 字符的尾巴(`tail=`)。
/// 这份日志可以在「设置 → 日志」里分享出去,等于把对话内容送了出去。
/// 哈希足够判断「两次转储是不是同一段文字」「某条消息有没有变」,又无法还原内容。
struct LogContentDigest: Equatable, Sendable {
    /// 字符数(Character,与此前日志里的 `len=` / `mdLen=` 同口径)。
    let length: Int
    /// 行数:换行符个数,末尾没有换行再补 1;空串为 0。
    let lines: Int
    /// SHA-256 前 4 字节的小写十六进制,恒为 8 位。
    let sha8: String

    init(_ text: String) {
        length = text.count
        var hasher = SHA256()
        var newlines = 0
        var endsWithNewline = false
        var copy = text
        // withUTF8 在原生字符串上零拷贝;桥接字符串会先落成连续存储,仍只多一次拷贝。
        copy.withUTF8 { buffer in
            hasher.update(bufferPointer: UnsafeRawBufferPointer(buffer))
            for byte in buffer where byte == 0x0A { newlines += 1 }
            endsWithNewline = buffer.last == 0x0A
        }
        lines = text.isEmpty ? 0 : newlines + (endsWithNewline ? 0 : 1)
        sha8 = hasher.finalize().prefix(4).map { String(format: "%02x", $0) }.joined()
    }

    /// 固定格式,日志与测试共用:`len=1234 lines=56 sha256=ab12cd34`。
    var fields: String { "len=\(length) lines=\(lines) sha256=\(sha8)" }
}

/// [1.70] 1.69 及以前写下的日志里还有对话片段:SnapshotDiag 的 `tail="…"`、块类型的关联值
/// (`kind=shellTool(command: "…")`,整条命令连 heredoc 正文)、`inputText='…'`、`textPrefix="…"`、
/// HangFix 的 `head="…"`、公式 `'…'`、全自动的命令预览。日志保留 15 天,可在「设置 → 日志」分享出去。
/// 升级后把旧文件清洗一遍:泄露字段从标记处截断,补一个 `[redacted]`;被截断的字符串里若有真换行,
/// 后面没有时间戳的续行一并删掉。时间戳、类别、长度这些诊断信息保留。
enum LegacyLogScrubber {
    static let redaction = "[redacted]"

    /// 从这些标记开始,行的剩余部分都是对话 / 命令内容。
    static let markers = [
        "tail=\"", "inputText='", "textPrefix=\"", " head=\"",
        "(command: \"", "(path: \"", "(action: \"", "(title: \"",
        "parse error for '", "zero size for '",
    ]
    /// 全自动的旧格式:`[FullAuto] 自动批准 <动作> <命令…> 来源=App`,只留动作。
    static let fullAutoMarker = "[FullAuto] 自动批准 "

    /// 每条记录以 `[HH:MM:SS]` 开头;不是的行是上一条记录里字符串的续行。
    static func startsRecord(_ line: Substring) -> Bool {
        let chars = Array(line.prefix(10).utf8)
        guard chars.count == 10, chars[0] == UInt8(ascii: "["), chars[9] == UInt8(ascii: "]"),
              chars[3] == UInt8(ascii: ":"), chars[6] == UInt8(ascii: ":") else { return false }
        return [1, 2, 4, 5, 7, 8].allSatisfy { (UInt8(ascii: "0")...UInt8(ascii: "9")).contains(chars[$0]) }
    }

    /// 返回清洗后的文本和被改动 / 删除的行数。没有泄露时原样返回、计数为 0。
    static func scrub(_ text: String) -> (text: String, changedLines: Int) {
        var out: [Substring] = []
        var changed = 0
        var droppingContinuation = false
        for line in text.split(separator: "\n", omittingEmptySubsequences: false) {
            if droppingContinuation {
                if startsRecord(line) {
                    droppingContinuation = false
                } else {
                    changed += 1
                    continue
                }
            }
            if let cut = redactedPrefix(of: line) {
                out.append(Substring(cut))
                changed += 1
                droppingContinuation = true
            } else {
                out.append(line)
            }
        }
        return changed == 0 ? (text, 0) : (out.joined(separator: "\n"), changed)
    }

    private static func redactedPrefix(of line: Substring) -> String? {
        var earliest: String.Index?
        for marker in markers {
            if let r = line.range(of: marker), earliest.map({ r.lowerBound < $0 }) ?? true {
                earliest = r.lowerBound
            }
        }
        if let r = line.range(of: fullAutoMarker), earliest.map({ r.lowerBound < $0 }) ?? true {
            let rest = line[r.upperBound...]
            let action = rest.split(separator: " ", maxSplits: 1).first.map(String.init) ?? ""
            // 新格式(`… detailLen=N 来源=…`)已经不含命令,不要再动它。
            if rest.contains(" detailLen=") { return earliest.map { String(line[..<$0]) + redaction } }
            return String(line[..<r.upperBound]) + action + " " + redaction
        }
        return earliest.map { String(line[..<$0]) + redaction }
    }
}
