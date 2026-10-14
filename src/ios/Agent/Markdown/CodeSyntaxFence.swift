//
//  CodeSyntaxFence.swift
//
//  流式输出里「最后一个代码块的围栏闭合了没有」。cmark 不给这个标志（没闭合的围栏和闭合的解析结果一样），
//  所以把源码按行过一遍 MarkdownFenceTracker（各个预处理共用的 CommonMark 围栏状态机）。
//  只依赖 MarkdownHardening.swift 里的 MarkdownFenceTracker，两个 target 都有它。
//

import Foundation

extension MarkdownFenceTracker {
    /// `source` 的末尾是否仍处在一个还没有闭合围栏的围栏代码块里。
    /// 线性扫描，只在消息还在流式输出时调用。
    ///
    /// 状态机本身不认识引用块：`> ```swift` 这样的行在它眼里不是围栏。所以再用一份
    /// 「剥掉行首 `>` 标记」的视图并行过一遍，两份只要有一份说「还开着」就算开着：
    /// 误报「开着」的代价只是着色被节流，漏报则会让流式中的每次 flush 都触发一次后台高亮。
    static func endsInsideOpenFence(_ source: String) -> Bool {
        var plain = MarkdownFenceTracker()
        var unquoted = MarkdownFenceTracker()
        for line in source.split(separator: "\n", omittingEmptySubsequences: false) {
            _ = plain.consume(line)
            _ = unquoted.consume(strippingBlockquoteMarkers(from: line))
        }
        return plain.isOpen || unquoted.isOpen
    }

    /// 去掉行首（最多 3 个空格缩进之后）连续的 `>` 引用标记及其后的一个空格；没有标记就原样返回。
    private static func strippingBlockquoteMarkers(from line: Substring) -> Substring {
        var rest = line
        var stripped = false
        while true {
            var cursor = rest.startIndex
            var spaces = 0
            while cursor < rest.endIndex, rest[cursor] == " ", spaces < 3 {
                cursor = rest.index(after: cursor)
                spaces += 1
            }
            guard cursor < rest.endIndex, rest[cursor] == ">" else { break }
            cursor = rest.index(after: cursor)
            if cursor < rest.endIndex, rest[cursor] == " " || rest[cursor] == "\t" {
                cursor = rest.index(after: cursor)
            }
            rest = rest[cursor...]
            stripped = true
        }
        return stripped ? rest : line
    }
}
