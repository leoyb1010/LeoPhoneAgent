//
//  TreasuryPresentation.swift
//  MinisApp
//
//  [T-treasury-design] 藏宝阁的纯展示逻辑:命中片段高亮、按宽度决定的列数与
//  阅读宽度、入场错峰的上限、资料类型图标。都不碰 UIKit,逻辑测试直接覆盖。
//

import CoreGraphics
import Foundation

// MARK: - Match highlight

/// 资料库检索返回的摘录用 `【…】` 标出命中词。界面上渲染成着色高亮,不显示括号;
/// 手机收藏的全文片段没有标记,按查询词定位高亮。
enum LeoMatchHighlight {
    struct Segment: Equatable {
        var text: String
        var isMatch: Bool
    }

    static let openMarker: Character = "【"
    static let closeMarker: Character = "】"

    /// 解析带 `【…】` 标记的摘录。没有闭合的 `【`、孤立的 `】`、空的 `【】`
    /// 都原样保留为普通文字——宁可显示一个括号,也不吞掉内容。
    static func segments(markedText text: String) -> [Segment] {
        var out: [Segment] = []
        var plain = ""
        var index = text.startIndex
        while index < text.endIndex {
            let ch = text[index]
            if ch == openMarker,
               let close = text[text.index(after: index)...].firstIndex(of: closeMarker) {
                let inner = text[text.index(after: index)..<close]
                if inner.isEmpty || inner.contains(openMarker) {
                    plain.append(ch)
                    index = text.index(after: index)
                    continue
                }
                if !plain.isEmpty { out.append(Segment(text: plain, isMatch: false)); plain = "" }
                out.append(Segment(text: String(inner), isMatch: true))
                index = text.index(after: close)
            } else {
                plain.append(ch)
                index = text.index(after: index)
            }
        }
        if !plain.isEmpty { out.append(Segment(text: plain, isMatch: false)) }
        return out
    }

    /// 按查询词(空白分隔,忽略大小写)标出命中;重叠或相邻的命中合并成一段。
    static func segments(text: String, terms: [String]) -> [Segment] {
        let needles = terms.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
        guard !text.isEmpty, !needles.isEmpty else { return text.isEmpty ? [] : [Segment(text: text, isMatch: false)] }
        var ranges: [Range<String.Index>] = []
        for needle in needles {
            var searchStart = text.startIndex
            while searchStart < text.endIndex,
                  let found = text.range(of: needle, options: [.caseInsensitive, .diacriticInsensitive],
                                         range: searchStart..<text.endIndex) {
                ranges.append(found)
                searchStart = found.upperBound
            }
        }
        guard !ranges.isEmpty else { return [Segment(text: text, isMatch: false)] }
        ranges.sort { $0.lowerBound < $1.lowerBound }
        var merged: [Range<String.Index>] = []
        for range in ranges {
            if let last = merged.last, range.lowerBound <= last.upperBound {
                merged[merged.count - 1] = last.lowerBound..<max(last.upperBound, range.upperBound)
            } else {
                merged.append(range)
            }
        }
        var out: [Segment] = []
        var cursor = text.startIndex
        for range in merged {
            if cursor < range.lowerBound { out.append(Segment(text: String(text[cursor..<range.lowerBound]), isMatch: false)) }
            out.append(Segment(text: String(text[range]), isMatch: true))
            cursor = range.upperBound
        }
        if cursor < text.endIndex { out.append(Segment(text: String(text[cursor...]), isMatch: false)) }
        return out
    }

    /// 查询串拆成高亮词:去掉 `kind:`、`#tag` 这类筛选写法,只留正文词。
    static func terms(fromQuery query: String) -> [String] {
        query.split(whereSeparator: \.isWhitespace)
            .map(String.init)
            .filter { !$0.contains(":") && !$0.hasPrefix("#") }
    }

    /// 命中段标成 `.stronglyEmphasized`;界面再给这些段上色。
    static func attributed(_ segments: [Segment]) -> AttributedString {
        var out = AttributedString()
        for segment in segments {
            var piece = AttributedString(segment.text)
            if segment.isMatch { piece.inlinePresentationIntent = .stronglyEmphasized }
            out += piece
        }
        return out
    }

    /// 命中段在结果里的文字(测试和无障碍朗读用)。
    static func matchedTexts(in attributed: AttributedString) -> [String] {
        attributed.runs.compactMap { run in
            run.inlinePresentationIntent == .stronglyEmphasized
                ? String(attributed[run.range].characters) : nil
        }
    }

    /// 去掉标记后的纯文字。
    static func plainText(markedText: String) -> String {
        segments(markedText: markedText).map(\.text).joined()
    }
}

// MARK: - Adaptive layout

/// 列表宽度 → 内容边距与列数。手机一列;宽容器(iPad 设置详情、大屏横屏)
/// 内容居中、限宽,资料库结果按宽度排成两列,不再拉成一条长条。
enum TreasuryGridLayout {
    /// 内容(卡片外缘)离容器边的最小距离。
    static let outerInset: CGFloat = 16
    /// 卡片之间的间距(8pt 节奏)。
    static let spacing: CGFloat = 12
    /// 单列最窄宽度:低于它就不再分列。
    static let minColumnWidth: CGFloat = 300
    static let maxColumns = 2
    /// 宽容器里整块内容的最大宽度,居中显示。手机收藏是单列卡片(要左右滑动、
    /// 多选),再宽一行字就太长;资料库结果在这个宽度里排两列。
    static let maxContentWidth: CGFloat = 760

    /// 左右边距:窄屏固定 16,宽屏让内容居中到 maxContentWidth。
    static func horizontalInset(forWidth width: CGFloat) -> CGFloat {
        guard width.isFinite, width > 0 else { return outerInset }
        return max(outerInset, ((width - maxContentWidth) / 2).rounded(.down))
    }

    static func contentWidth(forWidth width: CGFloat) -> CGFloat {
        guard width.isFinite, width > 0 else { return 0 }
        return max(0, width - 2 * horizontalInset(forWidth: width))
    }

    static func columns(forWidth width: CGFloat) -> Int {
        let content = contentWidth(forWidth: width)
        guard content > 0 else { return 1 }
        let fit = Int(((content + spacing) / (minColumnWidth + spacing)).rounded(.down))
        return min(maxColumns, max(1, fit))
    }

    /// 按列数分行;最后一行可以不满。
    static func rows<T>(_ items: [T], columns: Int) -> [[T]] {
        let n = max(1, columns)
        return stride(from: 0, to: items.count, by: n).map { Array(items[$0..<min($0 + n, items.count)]) }
    }
}

// MARK: - Stagger cap

/// 列表入场错峰:只有前 `cap` 条做淡入上浮,其余直接出现——长列表不排队
/// 放动画,滚动进来的行也不会每一条都动一下。
enum LeoStaggerPolicy {
    static let cap = 8
    static let step: Double = 0.04

    static func animates(index: Int) -> Bool { index >= 0 && index < cap }

    static func delay(index: Int) -> Double { animates(index: index) ? Double(index) * step : 0 }

    /// 一组 id 里前 cap 个的序号;其它 id 不在表里(不做入场)。
    static func indices<ID: Hashable>(for ids: [ID]) -> [ID: Int] {
        var out: [ID: Int] = [:]
        for (offset, id) in ids.prefix(cap).enumerated() where out[id] == nil { out[id] = offset }
        return out
    }
}

// MARK: - File type icon

/// 资料库文件按扩展名给一个类型符号,结果行和详情页头部共用。
enum BrainFileKindIcon {
    static func symbol(path: String?, isCard: Bool = false) -> String {
        if isCard { return "rectangle.on.rectangle.angled" }
        let ext = (path.map { ($0 as NSString).pathExtension.lowercased() }) ?? ""
        switch ext {
        case "pdf": return "doc.richtext"
        case "md", "markdown", "txt", "rtf": return "doc.plaintext"
        case "doc", "docx", "pages": return "doc.text"
        case "xls", "xlsx", "csv", "numbers": return "tablecells"
        case "ppt", "pptx", "key": return "rectangle.on.rectangle"
        case "png", "jpg", "jpeg", "heic", "gif", "webp", "tiff": return "photo"
        case "mp3", "m4a", "wav", "aac": return "waveform"
        case "mp4", "mov", "m4v": return "film"
        case "zip", "rar", "7z", "tar", "gz": return "doc.zipper"
        case "swift", "py", "js", "ts", "json", "html", "css", "sh", "go", "rs": return "chevron.left.forwardslash.chevron.right"
        default: return "doc.text"
        }
    }
}
