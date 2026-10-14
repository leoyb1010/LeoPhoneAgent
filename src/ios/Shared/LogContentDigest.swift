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
