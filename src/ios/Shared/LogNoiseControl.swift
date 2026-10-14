import Foundation

// 日志降噪的纯逻辑(无 UIKit / 无 AppLogger 依赖),主 App 与逻辑测试 target 共同编译。
// 依据是真机 4 天日志:同一批已删除模型条目的 SKIP 占全部日志 24%(10,716 行),
// SessionFileTracker 的 `all ignored` 994 批(抽样全是 /dev/null),内核启动同秒约 250 行 stderr/NSLog。

// MARK: - 重复日志:首次一行 + 累计汇总

/// 同一条「已处理、不用再看」的日志在每轮同步里被反复带回时:每个 key 本进程只记第一行,
/// 之后只累计;累计满 `summaryEvery` 次,或调用方在一轮结束时 `drain()`,给出一行汇总。
///
/// `mergeProviderModelEntryV3 SKIP (recently deleted locally)` 就是这种:云端那份旧副本每次拉取都会被带回来,
/// 本地墓碑每次都拦下它,第一次之后这一行不再提供任何新信息(最多的一个 id 在 4 天里重复了 5,774 次)。
struct RepeatedLogSummarizer {
    struct Summary: Equatable {
        struct Entry: Equatable {
            let key: String
            let count: Int
        }

        /// 自上次汇总以来被压掉的次数。
        let suppressed: Int
        /// 其中涉及的不同 key 数。
        let distinct: Int
        /// 次数最多的前几个:次数降序,同次数按 key 升序,保证输出稳定。
        let top: [Entry]

        var text: String {
            let shown = top.map { "\($0.key)×\($0.count)" }.joined(separator: ", ")
            return "+\(suppressed) repeats across \(distinct) id(s): \(shown)\(distinct > top.count ? ", …" : "")"
        }
    }

    struct Note: Equatable {
        /// true = 这个 key 本进程第一次出现,调用方照常记一行。
        let isFirst: Bool
        /// 非 nil = 累计已满,调用方该输出一行汇总。
        let summary: Summary?
    }

    private let summaryEvery: Int
    private let maxFirstLines: Int
    private let topCount = 3
    private var seen: Set<String> = []
    private var pending: [String: Int] = [:]
    private var pendingTotal = 0

    /// - Parameters:
    ///   - summaryEvery: 累计压掉多少次就出一行汇总。
    ///   - maxFirstLines: 本进程最多给多少个不同 key 各记「第一行」;
    ///     被删的是一整个服务商时 key 可能有几十上百个,不设上限等于每个进程启动又刷一屏。
    init(summaryEvery: Int = 500, maxFirstLines: Int = 20) {
        self.summaryEvery = max(1, summaryEvery)
        self.maxFirstLines = max(0, maxFirstLines)
    }

    /// 压掉、尚未汇总的次数。
    var pendingCount: Int { pendingTotal }

    mutating func note(_ key: String) -> Note {
        if !seen.contains(key), seen.count < maxFirstLines {
            seen.insert(key)
            return Note(isFirst: true, summary: nil)
        }
        pending[key, default: 0] += 1
        pendingTotal += 1
        return Note(isFirst: false, summary: pendingTotal >= summaryEvery ? drain() : nil)
    }

    /// 一轮同步结束(或定时器到点)时调用:把已压掉的次数一次性交出去并清零。没有就返回 nil。
    mutating func drain() -> Summary? {
        guard pendingTotal > 0 else { return nil }
        let ordered = pending.sorted { $0.value != $1.value ? $0.value > $1.value : $0.key < $1.key }
        let summary = Summary(
            suppressed: pendingTotal,
            distinct: pending.count,
            top: ordered.prefix(topCount).map { Summary.Entry(key: $0.key, count: $0.value) }
        )
        pending.removeAll(keepingCapacity: true)
        pendingTotal = 0
        return summary
    }
}

// MARK: - 捕获的 stderr / NSLog 行:按「行首词」分族限流

/// 进程的 stdout/stderr 被 dup2 进一根管道再由 `LoggingManager` 写盘;内核(`ISHKernel: …`)、各处 `NSLog` 走的就是这条路,
/// 不经过 `LogLinePipeline` 的按类别限流。内核启动同一秒约 250 行,把当天日志的「启动最忙一秒」顶到预算之上。
///
/// 这里复用 `LogRateLimiter`(按类别令牌桶),类别 = 去掉 NSLog 头之后的行首词(`ISHKernel:`、`[DNS]`…)。
/// - 只管写盘:Xcode 控制台那份 tee 不受影响。
/// - 含 error / fail / warn 等字样的行永不限流:真出了问题时一行都不能少。
/// - 默认每族突发 50 行、之后 10 行/秒:正常运行(单条命令的十来行、调速器的定时行)碰不到,只有成片刷屏才会被压。
/// - 族的个数封顶,防止每行都以随机词开头(命令输出)时桶无限增长。
/// - 每行只做字节级扫描(无正则、无整行拷贝):`LoggingManager` 的写盘队列在 shell 输出刷屏时已经出过分配失败,
///   这里不能再给每一行加上与行数成正比的重活。
struct StderrBurstFilter {
    enum Verdict: Equatable {
        /// 写入。`summaryBefore` > 0 表示这一族刚刚被压掉过这么多行,先补一行汇总。
        case write(family: String, summaryBefore: Int)
        case drop
    }

    private var limiter: LogRateLimiter
    private var families: Set<String> = []
    private let maxFamilies: Int
    private var droppedPending = 0

    init(ratePerSecond: Double = 10, burst: Double = 50, maxFamilies: Int = 64) {
        limiter = LogRateLimiter(ratePerSecond: ratePerSecond, burst: burst)
        self.maxFamilies = max(1, maxFamilies)
    }

    /// 被压掉、尚未汇总的行数。
    var pendingDrops: Int { droppedPending }

    mutating func verdict(for line: Substring, at now: Date) -> Verdict {
        let scan = Self.scan(line)
        if scan.isAlert { return .write(family: scan.family, summaryBefore: 0) }
        var key = scan.family
        if !families.contains(key) {
            if families.count >= maxFamilies { key = "other" } else { families.insert(key) }
        }
        switch limiter.admit(category: key, at: now) {
        case .suppress:
            droppedPending += 1
            return .drop
        case .emit(let suppressedBefore):
            droppedPending = max(0, droppedPending - suppressedBefore)
            return .write(family: key, summaryBefore: suppressedBefore)
        }
    }

    /// 这一族之后没有新行到来时,由定时器把已压掉的行数交出去(同 `LogLinePipeline.flushSummaries`)。
    mutating func drainSummaries() -> [(family: String, count: Int)] {
        droppedPending = 0
        return limiter.drainSuppressed().map { (family: $0.0, count: $0.1) }
    }

    // MARK: 行首词 / 告警判断(纯函数,便于测试)

    /// 去掉 NSLog 头(`2026-10-14 12:00:00.123456+0800 Proc[pid:tid] `)后的第一个词,最长 40 字节;空行记为 `(blank)`。
    static func family(of line: String) -> String { scan(Substring(line)).family }

    /// 含 error / fail / warn 等字样(不分大小写),或 ⚠ 的行。
    static func isAlert(_ line: String) -> Bool { scan(Substring(line)).isAlert }

    private static let alertWords: [[UInt8]] = ["error", "fail", "fatal", "crash", "warn", "timed out",
                                               "denied", "abort", "assert", "panic"].map { Array($0.utf8) }

    private static func scan(_ line: Substring) -> (family: String, isAlert: Bool) {
        if let result = line.utf8.withContiguousStorageIfAvailable({ scan($0) }) { return result }
        return Array(line.utf8).withUnsafeBufferPointer { scan($0) }
    }

    private static func scan(_ b: UnsafeBufferPointer<UInt8>) -> (family: String, isAlert: Bool) {
        let n = b.count
        var start = headerLength(b)
        while start < n, b[start] == 0x20 || b[start] == 0x09 { start += 1 }
        var end = start
        while end < n, b[end] != 0x20, b[end] != 0x09, end - start < 40 { end += 1 }
        let family = end > start ? String(decoding: UnsafeBufferPointer(rebasing: b[start..<end]), as: UTF8.self) : "(blank)"
        return (family, containsAlert(b))
    }

    /// NSLog 头的字节数(含末尾空格),不是 NSLog 行返回 0。先用固定位置的字符排除绝大多数行再逐段解析:
    /// `YYYY-MM-DD HH:MM:SS.ffffff±ZZZZ Proc[pid:tid] `。
    private static func headerLength(_ b: UnsafeBufferPointer<UInt8>) -> Int {
        let n = b.count
        guard n > 36, b[4] == 0x2D, b[7] == 0x2D, b[10] == 0x20, b[13] == 0x3A, b[16] == 0x3A, b[19] == 0x2E else { return 0 }
        var i = 20
        while i < n, b[i] >= 0x30, b[i] <= 0x39 { i += 1 }                      // 小数秒
        guard i + 5 < n, b[i] == 0x2B || b[i] == 0x2D else { return 0 }          // 时区 ±ZZZZ
        i += 5
        guard i < n, b[i] == 0x20 else { return 0 }
        i += 1
        while i < n, b[i] != 0x5B, b[i] != 0x20 { i += 1 }                       // 进程名
        guard i < n, b[i] == 0x5B else { return 0 }
        while i < n, b[i] != 0x5D { i += 1 }                                     // [pid:tid]
        guard i + 1 < n, b[i + 1] == 0x20 else { return 0 }
        return i + 2
    }

    private static func containsAlert(_ b: UnsafeBufferPointer<UInt8>) -> Bool {
        let n = b.count
        var i = 0
        while i < n {
            let c = b[i]
            if c == 0xE2, i + 2 < n, b[i + 1] == 0x9A, b[i + 2] == 0xA0 { return true }   // ⚠ U+26A0
            let lower = (c >= 0x41 && c <= 0x5A) ? c | 0x20 : c
            for word in alertWords where word[0] == lower && i + word.count <= n {
                var j = 1
                while j < word.count {
                    let d = b[i + j]
                    if ((d >= 0x41 && d <= 0x5A) ? d | 0x20 : d) != word[j] { break }
                    j += 1
                }
                if j == word.count { return true }
            }
            i += 1
        }
        return false
    }
}

// MARK: - 文件事件路径:不可能同步的路径

/// `SessionFileChangeTracker` 收到的 fakefs 事件里,很多路径从设计上就不会变成 SessionFile:
/// 设备节点(`> /dev/null` 每条命令一次)、内核伪文件系统、临时目录。整批都是这类路径时,
/// 「all ignored」那行日志只是噪声(994 批,抽样全是 `/dev/null`)。
enum IgnoredFilePathNoise {
    private static let prefixes = ["/dev/", "/proc/", "/sys/", "/run/", "/tmp/", "/var/tmp/"]

    static func isNoise(_ rawPath: String) -> Bool {
        prefixes.contains { rawPath.hasPrefix($0) }
    }
}
