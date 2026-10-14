//
//  CodeSyntaxHighlighter.swift
//
//  代码块高亮的调度层：大小阈值、流式节奏、后台串行队列与 LRU 缓存。只依赖 Foundation。
//
//  设计参照 MarkdownView 的 CodeHighlighter.swift（后台队列 + 容量 256 的 LRU + 按内容哈希取结果）：
//    https://github.com/Lakr233/MarkdownView
//    Copyright (c) 2025 Lakr Aream（该文件头另署 ktiays 2025）— MIT License，
//    全文见 CodeSyntaxLexer.swift 头部与仓库根 THIRD_PARTY_LICENSES.md。
//  这里是按本项目需求重写的：去掉了通知广播与 LRUCache / OrderedCollections 依赖，
//  结果按「谁请求谁拿」回调，并加入了超时丢弃、span 总量预算与流式节奏。
//

import Foundation

// MARK: - Limits

/// 超过任一上限就保持纯文本、不着色：再大的块着色既慢又没人逐行读，还会拖长主线程上色的那一下。
enum LeoCodeHighlightLimits {
    static let maxLines = 2000
    /// 以 UTF-16 码元计（与 NSAttributedString 一致）。
    static let maxCharacters = 128_000
    static let maxLineLength = 2000

    /// 单趟扫描、超限即停：最坏也只走 maxCharacters 个码元。
    /// 行数 = 换行数 + 1；`\r\n` 算一个换行。
    static func allowsHighlighting(_ code: String) -> Bool {
        var lines = 1
        var lineLength = 0
        var total = 0
        var previous: UInt16 = 0
        for unit in code.utf16 {
            total += 1
            if total > maxCharacters { return false }
            if LeoSyntaxUnit.isLineBreak(unit) {
                if !(unit == LeoSyntaxUnit.newline && previous == LeoSyntaxUnit.carriageReturn) {
                    lines += 1
                    if lines > maxLines { return false }
                }
                lineLength = 0
            } else {
                lineLength += 1
                if lineLength > maxLineLength { return false }
            }
            previous = unit
        }
        return true
    }
}

// MARK: - Pacing

/// 什么时候该着色：这些都是纯函数（时间由调用方传入），所以节奏规则能在测试里精确验证。
enum LeoCodeHighlightPacing {
    /// 还没闭合的围栏块，两次着色之间至少隔这么久。
    static let streamingInterval: TimeInterval = 0.7
    /// 还没闭合的块只有短于这个长度才在流式中着色；更长的等围栏闭合后再着色一次。
    static let streamingMaxCharacters = 8_000
    /// 请求发出后超过这么久才出结果就作废：不再回填，免得用户滚动时颜色突然冒出来闪一下。
    static let resultTimeout: TimeInterval = 1.0

    enum Decision: Equatable {
        /// 马上请求。
        case now
        /// 等这么久再请求（流式节流的尾沿：停笔后最后一段也能着上色）。
        case wait(TimeInterval)
        /// 现在不请求（流式中的大块，等围栏闭合）。
        case skip
    }

    /// - Parameters:
    ///   - isOpen: 围栏是否还没闭合（仍在流式输出）。已闭合的块只着色一次，随时可以请求。
    ///   - lastRequestAt: 上一次请求的时刻（同一个时钟，如 systemUptime）；从没请求过为 nil。
    static func decide(isOpen: Bool, characterCount: Int, lastRequestAt: TimeInterval?, now: TimeInterval) -> Decision {
        guard isOpen else { return .now }
        guard characterCount < streamingMaxCharacters else { return .skip }
        guard let lastRequestAt else { return .now }
        let remaining = streamingInterval - (now - lastRequestAt)
        return remaining > 0 ? .wait(remaining) : .now
    }

    /// 结果是否还新鲜：从请求算起超过 `timeout` 就不用了。
    static func isFresh(requestedAt: TimeInterval, now: TimeInterval, timeout: TimeInterval = resultTimeout) -> Bool {
        now - requestedAt <= timeout
    }
}

// MARK: - Service

/// 后台串行高亮 + LRU 缓存。线程安全：读写缓存都在锁里，回调一律回到主线程。
final class LeoCodeHighlighter: @unchecked Sendable {
    static let shared = LeoCodeHighlighter()

    /// 缓存键：(语言, 内容哈希, 明/暗主题)。再带上 UTF-16 长度，把哈希碰撞的后果压到几乎为零。
    ///
    /// token 本身与明暗无关（颜色是动态 UIColor、绘制时才解析），键里仍带 isDark，
    /// 是为了让「按外观区分的结果」永远不会串用：将来调色板或分词策略按外观分化时无需改缓存。
    struct Key: Hashable, Sendable {
        let language: String
        let contentHash: Int
        let utf16Length: Int
        let isDark: Bool
    }

    private struct Entry {
        var spans: [LeoSyntaxSpan]
        var lastUsed: UInt64
    }

    private let queue: DispatchQueue
    private let lock = NSLock()
    private var entries: [Key: Entry] = [:]
    private var clock: UInt64 = 0
    private var totalSpans = 0
    private let capacity: Int
    private let spanBudget: Int
    private let now: @Sendable () -> TimeInterval

    /// - Parameters:
    ///   - capacity: 最多缓存多少段代码（默认 256，与上游一致）。
    ///   - spanBudget: 全部缓存的 span 总数上限。一段 12 万字符的代码可有数万 span，
    ///     只按条数限制的话 256 条最坏会占上百 MB，所以另设总量预算（30 万 span ≈ 7 MB）。
    ///   - now: 时钟（秒，单调）。测试里换成脚本化的时钟，才能精确验证「超时」而不依赖机器速度。
    init(
        capacity: Int = 256,
        spanBudget: Int = 300_000,
        label: String = "leo.code-highlighter",
        now: @escaping @Sendable () -> TimeInterval = { ProcessInfo.processInfo.systemUptime }
    ) {
        self.capacity = max(1, capacity)
        self.spanBudget = max(1, spanBudget)
        self.now = now
        queue = DispatchQueue(label: label, qos: .userInitiated)
    }

    static func key(code: String, language: String?, isDark: Bool) -> Key {
        var hasher = Hasher()
        // 按 UTF-8 字节哈希：比 String 的 Unicode 等价哈希快，也不会把「规范等价但码元不同」的文本当成同一份。
        let hashed: Void? = code.utf8.withContiguousStorageIfAvailable { hasher.combine(bytes: UnsafeRawBufferPointer($0)) }
        if hashed == nil {
            for byte in code.utf8 { hasher.combine(byte) }
        }
        return Key(
            language: LeoSyntaxHighlighter.normalizedLanguage(language),
            contentHash: hasher.finalize(),
            utf16Length: code.utf16.count,
            isDark: isDark
        )
    }

    /// 同步读缓存（命中时顺便标记为最近使用）。主线程创建视图时先问它，命中就当场上色、不闪。
    func cachedSpans(for key: Key) -> [LeoSyntaxSpan]? {
        lock.lock()
        defer { lock.unlock() }
        guard var entry = entries[key] else { return nil }
        clock += 1
        entry.lastUsed = clock
        entries[key] = entry
        return entry.spans
    }

    /// 同步着色：先看缓存，没有就算并入缓存。超限 / 纯文本语言返回 nil。
    /// 后台队列里的请求和测试都走它；主线程不要对大块代码直接调用。
    func spans(code: String, language: String?, isDark: Bool) -> [LeoSyntaxSpan]? {
        guard LeoSyntaxHighlighter.canHighlight(language: language),
              LeoCodeHighlightLimits.allowsHighlighting(code) else { return nil }
        let key = Self.key(code: code, language: language, isDark: isDark)
        if let cached = cachedSpans(for: key) { return cached }
        let computed = LeoSyntaxHighlighter.highlight(code, language: language)
        store(computed, for: key)
        return computed
    }

    /// 异步着色：在后台串行队列上算，`completion` 在主线程调用，且只调用一次。
    ///
    /// 超过 `timeout`（默认 1 秒）才出的结果不回调——传 nil。结果照样进缓存：
    /// 下次创建同一段代码的视图时能当场命中，那是在第一帧之前上色，不会闪。
    /// 排队就已超时的请求连算都不算。
    func request(
        code: String,
        language: String?,
        isDark: Bool,
        timeout: TimeInterval = LeoCodeHighlightPacing.resultTimeout,
        completion: @escaping @MainActor @Sendable ([LeoSyntaxSpan]?) -> Void
    ) {
        let requestedAt = now()
        guard LeoSyntaxHighlighter.canHighlight(language: language),
              LeoCodeHighlightLimits.allowsHighlighting(code) else {
            Self.deliver(nil, to: completion)
            return
        }
        queue.async { [self] in
            let started = now()
            guard LeoCodeHighlightPacing.isFresh(requestedAt: requestedAt, now: started, timeout: timeout) else {
                Self.deliver(nil, to: completion)
                return
            }
            let result = spans(code: code, language: language, isDark: isDark)
            let finished = now()
            let fresh = LeoCodeHighlightPacing.isFresh(requestedAt: requestedAt, now: finished, timeout: timeout)
            Self.deliver(fresh ? result : nil, to: completion)
        }
    }

    /// 清空缓存（内存告警时可调用）。
    func removeAll() {
        lock.lock()
        defer { lock.unlock() }
        entries.removeAll()
        totalSpans = 0
    }

    var cachedEntryCount: Int {
        lock.lock()
        defer { lock.unlock() }
        return entries.count
    }

    // MARK: Private

    private static func deliver(_ spans: [LeoSyntaxSpan]?, to completion: @escaping @MainActor @Sendable ([LeoSyntaxSpan]?) -> Void) {
        Task { @MainActor in completion(spans) }
    }

    private func store(_ spans: [LeoSyntaxSpan], for key: Key) {
        lock.lock()
        defer { lock.unlock() }
        if let old = entries[key] {
            totalSpans -= old.spans.count
        }
        clock += 1
        entries[key] = Entry(spans: spans, lastUsed: clock)
        totalSpans += spans.count
        // 超出条数或总量就淘汰最久没用的；刚存进去的这条不淘汰（即使它自己就超预算，也让它留着被用一次）。
        while entries.count > capacity || (totalSpans > spanBudget && entries.count > 1) {
            guard let victim = entries.min(by: { $0.value.lastUsed < $1.value.lastUsed }), victim.key != key else { break }
            totalSpans -= victim.value.spans.count
            entries.removeValue(forKey: victim.key)
        }
    }
}
