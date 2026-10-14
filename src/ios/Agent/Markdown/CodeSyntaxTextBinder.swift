//
//  CodeSyntaxTextBinder.swift
//
//  把词法高亮的结果上到聊天代码块的 UITextView 上：只改前景色，字体 / 字号 / 行高 / 字符都不动，
//  所以着色不会改变测量高度（Mac Catalyst 的 UIKit 上实测：上色前后 sizeThatFits 完全一致），也不会通知外层
//  重新测量 / 布局；选区、滚动位置不受影响；复制出来的仍是原文。TextKit 会把这段文本自己重排一遍，
//  但结果不变——几十行的代码块里多出不到 3ms（M 系列实测），只有逼近上限的巨型块才会多出几十毫秒。
//  词法与缓存在 CodeSyntaxLexer / CodeSyntaxHighlighter（Foundation），这里是 UIKit 一侧的胶水。
//

import UIKit

/// 代码块里承载代码的 UITextView：只多挂一个着色器。
final class CodeSyntaxTextView: UITextView {
    let syntaxBinder = CodeSyntaxBinder()
}

/// 决定什么时候、对哪段文本请求高亮，并把结果上到它绑定的文本视图上。主线程专用
/// （标成 @unchecked Sendable 只是因为后台队列的回调要弱引用它；回调本身回到主线程才碰状态）。
final class CodeSyntaxBinder: @unchecked Sendable {
    private weak var textView: UITextView?
    private let highlighter: LeoCodeHighlighter

    private var theme = SelectableMarkdownTheme()
    private var language: String?
    private var code = ""
    private var isFenceOpen = false

    /// 已知的着色结果与它对应的文本。流式输出时新文本是它的延伸，就先把它原样套上去，
    /// 这样每来一个 token 重建富文本时整块不会闪回单色，等下一次高亮结果再刷新。
    private var spans: [LeoSyntaxSpan] = []
    private var spansCode = ""
    private var spansLanguage = ""

    private var lastRequestAt: TimeInterval?
    private var trailing: DispatchWorkItem?

    init(highlighter: LeoCodeHighlighter = .shared) {
        self.highlighter = highlighter
    }

    deinit {
        trailing?.cancel()
    }

    // MARK: - Entry points

    /// 返回文本视图应显示的富文本：默认色 + 已知的着色（缓存命中，或流式时沿用上一轮的前缀结果）。
    /// 没有着色可用时返回纯文本，并按节奏安排一次后台高亮，结果好了再回填颜色。
    ///
    /// `baseAttributes` 是字体与段落样式——测量高度的那份，原样使用，颜色以外什么都不加。
    func makeAttributedText(
        code newCode: String,
        language: String?,
        theme: SelectableMarkdownTheme,
        isFenceOpen: Bool,
        baseAttributes: [NSAttributedString.Key: Any],
        for textView: UITextView
    ) -> NSAttributedString {
        // 不是上一段文本的延伸，就是另一个块（视图被复用）：节流计时从头算。
        if !newCode.utf8.starts(with: code.utf8) {
            lastRequestAt = nil
            cancelTrailing()
        }
        self.textView = textView
        self.theme = theme
        self.language = language
        self.isFenceOpen = isFenceOpen
        self.code = newCode

        var attributes = baseAttributes
        attributes[.foregroundColor] = theme.codeBlockTextColor
        let text = NSMutableAttributedString(string: newCode, attributes: attributes)

        guard canHighlightCurrentCode else {
            forgetSpans()
            cancelTrailing()
            return text
        }
        if let cached = highlighter.cachedSpans(for: cacheKey(for: newCode)) {
            adopt(cached, for: newCode)
            cancelTrailing()
            colorize(text, with: cached, limit: text.length)
            return text
        }
        if canReuseSpans(for: newCode) {
            colorize(text, with: spans, limit: spansCode.utf16.count)
        } else {
            forgetSpans()
        }
        schedule()
        return text
    }

    /// 围栏刚闭合：按「已闭合」的规则立刻着色一次（内容没变，所以视图不会被重新构建，只能靠这个通知）。
    func fenceDidClose() {
        guard isFenceOpen else { return }
        isFenceOpen = false
        cancelTrailing()
        guard canHighlightCurrentCode else { return }
        request(at: ProcessInfo.processInfo.systemUptime)
    }

    // MARK: - Scheduling

    private func schedule() {
        let now = ProcessInfo.processInfo.systemUptime
        switch LeoCodeHighlightPacing.decide(
            isOpen: isFenceOpen,
            characterCount: code.utf16.count,
            lastRequestAt: lastRequestAt,
            now: now
        ) {
        case .skip:
            cancelTrailing()
        case .now:
            cancelTrailing()
            request(at: now)
        case let .wait(delay):
            // 已经定好了尾沿：停笔后最后一段文本也能在 700ms 内着上色。
            guard trailing == nil else { return }
            let item = DispatchWorkItem { [weak self] in
                guard let self else { return }
                self.trailing = nil
                self.schedule()
            }
            trailing = item
            DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: item)
        }
    }

    private func request(at now: TimeInterval) {
        lastRequestAt = now
        let requestedCode = code
        let key = cacheKey(for: requestedCode)
        if let cached = highlighter.cachedSpans(for: key) {
            finish(cached, for: requestedCode)
            return
        }
        // 超过 1 秒才出的结果，高亮服务会传 nil：不回填，免得用户滚动时颜色突然冒出来。
        highlighter.request(code: requestedCode, language: language, isDark: key.isDark) { [weak self] result in
            self?.finish(result, for: requestedCode)
        }
    }

    private func cancelTrailing() {
        trailing?.cancel()
        trailing = nil
    }

    // MARK: - Applying

    /// 结果回来了：如果文本视图现在显示的仍是（以 `requestedCode` 开头的）这段代码，就把颜色补上去。
    /// 流式时文本只会变长，结果对前缀依然有效——所以按「前缀」而不是「完全相等」判断，
    /// 否则请求发出后只要又来一个 token，结果就永远对不上、整块永远不着色。
    private func finish(_ result: [LeoSyntaxSpan]?, for requestedCode: String) {
        guard let result, let textView else { return }
        guard code.utf8.starts(with: requestedCode.utf8) else { return }
        adopt(result, for: requestedCode)

        let storage = Self.liveStorage(of: textView)
        let limit = min(storage.length, requestedCode.utf16.count)
        guard limit > 0 else { return }
        // 只动 foregroundColor：在 beginEditing/endEditing 里一次改完，选区与滚动位置都不受影响。
        storage.beginEditing()
        storage.addAttribute(.foregroundColor, value: theme.codeBlockTextColor, range: NSRange(location: 0, length: limit))
        colorize(storage, with: result, limit: limit)
        storage.endEditing()
    }

    /// 文本视图正在用的 NSTextStorage。UITextView() 默认是 TextKit 2：先从 textLayoutManager 取内容存储，
    /// 这样绝不会碰 `layoutManager`——那会让文本视图悄悄退回 TextKit 1，布局度量就和 measureCodeHeight 对不上了。
    /// 已经在 TextKit 1 的视图直接用 textStorage（它没有更多可退的了）。
    private static func liveStorage(of textView: UITextView) -> NSTextStorage {
        if let content = textView.textLayoutManager?.textContentManager as? NSTextContentStorage,
           let storage = content.textStorage {
            return storage
        }
        return textView.textStorage
    }

    /// 给 `target`（可以是一个新建的富文本，也可以是文本视图的 textStorage）上色。范围越界的 span 直接跳过。
    private func colorize(_ target: NSMutableAttributedString, with spans: [LeoSyntaxSpan], limit: Int) {
        let length = min(target.length, limit)
        for span in spans where span.length > 0 && span.location >= 0 && span.end <= length {
            target.addAttribute(.foregroundColor, value: theme.syntaxColor(for: span.token), range: span.range)
        }
    }

    // MARK: - State

    private var canHighlightCurrentCode: Bool {
        !code.isEmpty
            && LeoSyntaxHighlighter.canHighlight(language: language)
            && LeoCodeHighlightLimits.allowsHighlighting(code)
    }

    /// 缓存键里的「明/暗」：优先看文本视图所在窗口，视图还没上屏时退回当前 trait。
    private var isDarkAppearance: Bool {
        let style = textView?.window?.traitCollection.userInterfaceStyle ?? UITraitCollection.current.userInterfaceStyle
        return style == .dark
    }

    private func cacheKey(for code: String) -> LeoCodeHighlighter.Key {
        LeoCodeHighlighter.key(code: code, language: language, isDark: isDarkAppearance)
    }

    private func adopt(_ result: [LeoSyntaxSpan], for code: String) {
        spans = result
        spansCode = code
        spansLanguage = LeoSyntaxHighlighter.normalizedLanguage(language)
    }

    private func forgetSpans() {
        spans = []
        spansCode = ""
        spansLanguage = ""
    }

    private func canReuseSpans(for newCode: String) -> Bool {
        !spans.isEmpty
            && spansLanguage == LeoSyntaxHighlighter.normalizedLanguage(language)
            && newCode.utf8.starts(with: spansCode.utf8)
    }
}
