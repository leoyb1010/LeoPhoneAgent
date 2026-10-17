import Foundation

// [T-long-reply-collapse] 超长回复的折叠与分页:纯逻辑,只依赖 Foundation(逻辑测试 target 直接编译)。
//
// 依据:真机日志 minis-2026-10-12 19:10:33,一条 68,857 字符的助手回复被渲染成「一个」
// SelectableMarkdownView(UITextView,bounds 360×75629),打开会话时主线程卡死 1.07 s + 1.18 s
// (perf `hang 1275 ms`);UITextView 高于 ~16K pt 还会丢像素。所以已完成的长文本块只渲染开头,
// 后面接一行「展开全文」,全文走分页阅读器(每页都是一个小 UITextView)。
//
// 两个入口共用同一套边界规则:
//   - `split`:折叠用,把全文切成 (head, tail),head 就是行内显示的部分;
//   - `pages`:阅读器用,把全文切成每页约 `readerPageSize` 字符的若干页。
// 不依赖 cmark / 渲染器:只在 UTF-8 字节上扫行,围栏代码块、表格、`$$` 公式块都按行识别。

enum LongTextCollapse {
    /// 已完成的文本块超过这个字符数(`String.count`,与「共 N 字」同一口径)就折叠。
    /// 注意:纯中文约 1.1 pt/字(360 pt 宽),20K 字 ≈ 22K pt,仍高于 UITextView ~16K pt 的丢像素线;
    /// 中文为主的场景想更稳,调小这个常量即可,逻辑不用改。
    static let collapseThreshold = 20_000

    /// 阅读器每页的目标字符数。纯中文 8K 字 ≈ 9K pt,在 UITextView 的安全高度内,首页也出得快;
    /// 最长的一页(含 1.5× 的整块保留上限)12K 字 ≈ 13K pt,仍低于 ~16K pt。
    static let readerPageSize = 8_000

    /// 一整块(围栏/表格/公式)本身就超限时,允许整块保留的上限 = 阈值的 1.5 倍。
    /// 再长就放弃保结构,按行切(围栏在 head 里不闭合,渲染器按文档末尾自动收尾)。
    private static let overshootDivisor = 2

    /// 没有任何换行可切(整段是一行)时,往回找「句末 / 空白」的窗口大小(Character 数)。
    private static let softBreakWindow = 400

    // MARK: - Public

    /// 折叠切分。nil = 无需折叠(≤ 阈值字符,含空串)。
    ///
    /// 切点优先级(都不会切进围栏代码块 / 表格 / `$$` 公式块,也不会紧跟在标题后面——
    /// 否则 head 以孤零零的标题结尾,标题的正文全在 tail 里):
    ///   1. 段落边界(空行之后的第一行)——但若它让 head 不到预算的一半、而更靠后有一个普通行边界,
    ///      就用后者(长列表 / 日志只有开头一个空行时,不至于只露出一句话);
    ///   2. 预算内最后一个安全的行边界;
    ///   3. 预算内全在围栏/表格/公式块里:该块在 1.5× 阈值内结束,则整块留在 head 里;
    ///   4. 否则预算内最近的行边界(此时可能切进围栏,head 的围栏不闭合);
    ///   5. 整段只有一行:预算附近的句末 / 空白,再不行就恰好在阈值个 Character 处切。
    /// 切点只落在 Character 边界(换行之后,或 Character 序列的边界),不会切坏 emoji / 组合字符。
    /// 不变量:`head + tail == markdown`,head 与 tail 都含可见字符。
    /// 超出阈值的只是空白(比如末尾一串换行)时同样返回 nil:展开后什么都看不到,不值得折叠。
    static func split(markdown: String, threshold: Int = collapseThreshold) -> (head: String, tail: String)? {
        // Character 数 ≤ UTF-8 字节数:O(1) 的快速否决,绝大多数消息在这里就返回。
        guard threshold > 0, markdown.utf8.count > threshold else { return nil }
        var text = markdown
        text.makeContiguousUTF8()
        guard let limit = text.index(text.startIndex, offsetBy: threshold, limitedBy: text.endIndex),
              limit < text.endIndex else { return nil }
        let cut = chooseCut(in: text, from: text.startIndex, limit: limit, budget: threshold, fence: nil).index
        guard cut > text.startIndex, cut < text.endIndex,
              text[..<cut].contains(where: { !$0.isWhitespace }),
              text[cut...].contains(where: { !$0.isWhitespace }) else { return nil }
        return (String(text[..<cut]), String(text[cut...]))
    }

    /// 阅读器分页:每页约 `pageSize` 个 Character,切点规则同 `split`。
    /// 一页结束在围栏里时,本页补一行收尾围栏、下一页开头重开同样的围栏,
    /// 这样每页都能被 markdown 单独解析(否则续页的代码会被当成正文)。
    /// 单次线性扫描:每页只从上一页的切点往后看,总复杂度 O(n)。
    static func pages(markdown: String, pageSize: Int = readerPageSize) -> [String] {
        guard !markdown.isEmpty else { return [] }
        guard pageSize > 0, markdown.utf8.count > pageSize else { return [markdown] }
        var text = markdown
        text.makeContiguousUTF8()
        var result: [String] = []
        var start = text.startIndex
        var carried: Fence?
        while start < text.endIndex {
            guard let limit = text.index(start, offsetBy: pageSize, limitedBy: text.endIndex),
                  limit < text.endIndex else {
                appendLastPage(text[start...], carried: carried, to: &result)
                break
            }
            let cut = chooseCut(in: text, from: start, limit: limit, budget: pageSize, fence: carried)
            result.append(page(text[start..<cut.index], reopening: carried, closing: cut.fence))
            start = cut.index
            carried = cut.fence
        }
        return result
    }

    // MARK: - Cut selection

    /// 围栏代码块的开头信息:收尾与重开都要用。
    private struct Fence {
        let char: UInt8
        let length: Int
        /// 开头那一行(去掉缩进与行尾空白),下一页原样重开。
        let opener: String
    }

    /// 一行的内容范围(字节偏移,不含换行)。`first..<end` 已去掉首尾的空格 / Tab / CR。
    private struct Line {
        let first: Int
        let end: Int
        var isBlank: Bool { end <= first }
    }

    /// 扫描中「上一行结束后」的块状态。
    private struct ScanState {
        var fence: Fence?
        var inMath = false
        var prevBlank = false
        var prevTable = false
        /// [start, 当前行) 里出现过非空白行:没有内容的 head 不是合法切点。
        var hasContent = false
        /// 最近一个非空行是 ATX 标题:此刻切开会让 head 以孤零零的标题结尾,正文留在 tail 里。
        var lastContentIsHeading = false
    }

    /// 在 `[start, limit]`(limit = start 之后 `budget` 个 Character 的位置)里选切点。
    /// 前提:`limit < text.endIndex`,即预算之后还有文本。返回的 index 一定 > start。
    private static func chooseCut(in text: String, from start: String.Index, limit: String.Index,
                                  budget: Int, fence: Fence?) -> (index: String.Index, fence: Fence?) {
        let u8 = text.utf8
        let startOffset = u8.distance(from: u8.startIndex, to: start)
        let limitOffset = u8.distance(from: u8.startIndex, to: limit)
        let hardIndex = text.index(limit, offsetBy: max(1, budget / overshootDivisor), limitedBy: text.endIndex) ?? text.endIndex
        let hardOffset = u8.distance(from: u8.startIndex, to: hardIndex)
        let found: (offset: Int, fence: Fence?)?? = u8.withContiguousStorageIfAvailable { buf in
            findBoundary(buf, start: startOffset, limit: limitOffset, hardLimit: hardOffset, fence: fence)
        }
        if let boundary = found ?? nil {
            return (u8.index(u8.startIndex, offsetBy: boundary.offset), boundary.fence)
        }
        return (softCut(in: text, from: start, limit: limit), fence)
    }

    /// 逐行扫描,找换行之后的切点。nil = 预算内一个换行都没有(第一行就超了预算)。
    private static func findBoundary(_ buf: UnsafeBufferPointer<UInt8>, start: Int, limit: Int, hardLimit: Int,
                                     fence: Fence?) -> (offset: Int, fence: Fence?)? {
        var state = ScanState(fence: fence)
        var blankCut: Int?      // 段落边界:空行之后的第一行
        var safeCut: Int?       // 不在围栏 / 公式 / 表格里的行边界
        var lastLine: (offset: Int, fence: Fence?)?   // 任意行边界(可能在围栏里)
        let count = buf.count
        var lineStart = start
        while lineStart < count {
            var lineEnd = lineStart
            while lineEnd < count, buf[lineEnd] != 0x0A { lineEnd += 1 }
            let line = classify(buf, lineStart, lineEnd)
            if lineStart > start {
                // 标题后面不切:head 不能以一个孤零零的标题结尾(切点退到标题之前)。
                let cuttable = state.hasContent && !state.lastContentIsHeading
                let safe = cuttable && state.fence == nil && !state.inMath
                    && !(state.prevTable && isTableRow(buf, line))
                if lineStart <= limit {
                    if cuttable { lastLine = (lineStart, state.fence) }
                    if safe {
                        safeCut = lineStart
                        if state.prevBlank && !line.isBlank { blankCut = lineStart }
                    }
                } else if safeCut == nil, lastLine != nil {
                    // 预算内全在一个整块里:往后找这个块的结尾,只在 1.5× 阈值内。
                    if lineStart > hardLimit { break }
                    if safe { return (lineStart, nil) }
                } else {
                    break
                }
            }
            consume(line, buf, into: &state)
            if lineEnd >= count { break }
            lineStart = lineEnd + 1
        }
        if let blank = blankCut, let safe = safeCut {
            // 段落边界优先,除非它浪费了一半以上的预算而后面还有普通行边界。
            return ((blank - start) * 2 >= (limit - start) || safe <= blank) ? (blank, nil) : (safe, nil)
        }
        if let safe = safeCut { return (safe, nil) }
        return lastLine
    }

    /// 预算内没有可用的换行切点(整段是一行,或所有换行切点都被块规则否决)时的兜底:
    /// 在 `limit` 所在的这一行里往回找句末 / 空白,最后恰好在 `limit` 处切。
    /// 切点是 Character 序列的边界,emoji / 组合字符不会被拆开。
    private static func softCut(in text: String, from start: String.Index, limit: String.Index) -> String.Index {
        // head 里必须有正文:开头一大串空行时,不能退到「空白之后」得到一个空白 head。
        guard let firstContent = text[start...].firstIndex(where: { !$0.isWhitespace }) else { return limit }
        if firstContent >= limit { return text.index(after: firstContent) }
        var index = limit
        var steps = 0
        while steps < softBreakWindow, index > firstContent {
            let previous = text.index(before: index)
            let c = text[previous]
            // 不越过行首:换行之后的切点已经由 findBoundary 按块规则评判过(标题后、围栏里的都被它否决了),
            // 这里再退回前面的行就会绕过那些规则。
            if c.isNewline { break }
            if isSoftBreak(c) { return index }
            index = previous
            steps += 1
        }
        return limit
    }

    private static func isSoftBreak(_ c: Character) -> Bool {
        if c.isWhitespace { return true }
        switch c {
        case "。", "！", "？", "；", "…": return true
        default: return false
        }
    }

    // MARK: - Line classification (UTF-8 bytes)

    private static func classify(_ buf: UnsafeBufferPointer<UInt8>, _ lineStart: Int, _ lineEnd: Int) -> Line {
        var first = lineStart
        while first < lineEnd, buf[first] == 0x20 || buf[first] == 0x09 { first += 1 }
        var end = lineEnd
        while end > first, buf[end - 1] == 0x20 || buf[end - 1] == 0x09 || buf[end - 1] == 0x0D { end -= 1 }
        return Line(first: first, end: end)
    }

    /// 更新「这一行之后」的状态。围栏规则同 MarkdownFenceTracker(缩进不限、闭合围栏同字符且不短于开头)。
    private static func consume(_ line: Line, _ buf: UnsafeBufferPointer<UInt8>, into state: inout ScanState) {
        defer {
            if !line.isBlank {
                state.hasContent = true
                state.lastContentIsHeading = state.fence == nil && !state.inMath && isHeading(buf, line)
            }
        }
        if let open = state.fence {
            if isFenceCloser(buf, line, open) { state.fence = nil }
            state.prevBlank = false
            state.prevTable = false
        } else if state.inMath {
            if isDoubleDollar(buf, line) { state.inMath = false }
            state.prevBlank = false
            state.prevTable = false
        } else if let open = fenceOpener(buf, line) {
            state.fence = open
            state.prevBlank = false
            state.prevTable = false
        } else if isDoubleDollar(buf, line) {
            state.inMath = true
            state.prevBlank = false
            state.prevTable = false
        } else {
            state.prevBlank = line.isBlank
            state.prevTable = isTableRow(buf, line)
        }
    }

    private static func fenceOpener(_ buf: UnsafeBufferPointer<UInt8>, _ line: Line) -> Fence? {
        guard !line.isBlank else { return nil }
        let c = buf[line.first]
        guard c == 0x60 || c == 0x7E else { return nil }   // ` ~
        var i = line.first
        while i < line.end, buf[i] == c { i += 1 }
        let run = i - line.first
        guard run >= 3 else { return nil }
        if c == 0x60 {
            // 反引号围栏的 info 里不能再有反引号,否则是行内代码。
            var j = i
            while j < line.end {
                if buf[j] == 0x60 { return nil }
                j += 1
            }
        }
        let opener = String(decoding: UnsafeBufferPointer(rebasing: buf[line.first..<line.end]), as: UTF8.self)
        return Fence(char: c, length: run, opener: opener)
    }

    private static func isFenceCloser(_ buf: UnsafeBufferPointer<UInt8>, _ line: Line, _ fence: Fence) -> Bool {
        guard !line.isBlank, buf[line.first] == fence.char else { return false }
        var i = line.first
        while i < line.end, buf[i] == fence.char { i += 1 }
        return i - line.first >= fence.length && i >= line.end
    }

    /// 单独成行的 `$$`:显示公式块的开关。
    private static func isDoubleDollar(_ buf: UnsafeBufferPointer<UInt8>, _ line: Line) -> Bool {
        line.end - line.first == 2 && buf[line.first] == 0x24 && buf[line.first + 1] == 0x24
    }

    /// 表格行:去掉缩进后以 `|` 开头(与 insertBlankLineAfterTable 的判定一致)。
    private static func isTableRow(_ buf: UnsafeBufferPointer<UInt8>, _ line: Line) -> Bool {
        !line.isBlank && buf[line.first] == 0x7C
    }

    /// ATX 标题:缩进后 1–6 个 `#`,其后是空白或行尾(`#话题` 不是标题)。
    private static func isHeading(_ buf: UnsafeBufferPointer<UInt8>, _ line: Line) -> Bool {
        guard !line.isBlank, buf[line.first] == 0x23 else { return false }
        var i = line.first
        while i < line.end, buf[i] == 0x23 { i += 1 }
        guard i - line.first <= 6 else { return false }
        return i >= line.end || buf[i] == 0x20 || buf[i] == 0x09
    }

    // MARK: - Reader pages

    private static func page(_ body: Substring, reopening: Fence?, closing: Fence?) -> String {
        var out = ""
        if let reopening { out += reopening.opener + "\n" }
        out += body
        if let closing {
            if !out.hasSuffix("\n") { out += "\n" }
            out += String(repeating: String(UnicodeScalar(closing.char)), count: closing.length)
        }
        return out
    }

    /// 最后一页。只剩空白行时并进上一页,不单独成页(否则阅读器末尾会多一块空白)。
    private static func appendLastPage(_ body: Substring, carried: Fence?, to result: inout [String]) {
        if !result.isEmpty, body.allSatisfy({ $0.isWhitespace }) {
            result[result.count - 1] += body
        } else {
            result.append(page(body, reopening: carried, closing: nil))
        }
    }
}

// MARK: - [WP-46] 折叠生效日志

extension LongTextCollapse {
    /// 折叠生效时的一行日志:总长度、首屏长度、相当于几屏、拆分耗时。只有数字,不带原文。
    /// (1.69 加入折叠后一直不打日志,真机取证无法确认它触发过没有。)
    static func logLine(totalChars: Int, headChars: Int, ms: Double) -> String {
        let pages = headChars > 0 ? Int((Double(totalChars) / Double(headChars)).rounded(.up)) : 0
        return "[LongTextCollapse] collapsed chars=\(totalChars) head=\(headChars) pages≈\(pages) split=\(String(format: "%.1f", ms))ms"
    }
}
