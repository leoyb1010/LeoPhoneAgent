import Foundation

/// [WP-46] perf.jsonl 的「这条数据还能不能信」判定,以及回前台分步计时。App 与逻辑测试共用。
///
/// 真机取证:iPhone 记到一条 19.8 分钟的 hang、iPad 一条 133.8 s 的 hang —— 其实都是进程被挂起;
/// 1.74 的 6 条 hang 里 5 条来自后台拉起;一条 908 s 的首字跨过了后台。门禁据此误判。
enum PerfSanity {
    /// 主线程 ping 隔了这么久才回来,不是卡顿,是进程被挂起过(后台 / 锁屏)。
    static let suspensionThresholdMs: Double = 10_000

    static func isSuspensionArtifact(hangMs: Double) -> Bool {
        hangMs > suspensionThresholdMs
    }

    /// 发送到首字之间进过后台(后台次数变了),这条首字耗时要带 `bg: true`,统计时剔除。
    static func spannedBackground(epochAtStart: Int?, epochNow: Int) -> Bool {
        guard let epochAtStart else { return false }
        return epochAtStart != epochNow
    }
}

/// [WP-46] 回前台分步计时。`FgStep` 原来只打 signpost,真机上没法归因 `fg.frame` 的双峰
/// (1.74 的 22 次里 7 次 ≥800 ms)。现在每一步的耗时也记在这里;这一次回前台的 `fg.frame`
/// 超过 `slowFrameMs` 时,把各步耗时作为一条 `fg.steps` 写进 perf.jsonl。
/// 只在主线程使用(调用方保证),所以标成 @unchecked Sendable 以便放进静态常量。
final class FgStepLedger: @unchecked Sendable {
    static let slowFrameMs: Double = 600
    /// 只保留最慢的这么多步,一条记录不要太长。
    static let maxSteps = 12

    private var steps: [String: Double] = [:]
    private var frameMs: Double?
    private var afterFrameDone = false
    private let sink: (_ frameMs: Double, _ steps: [String: Double]) -> Void

    init(sink: @escaping (_ frameMs: Double, _ steps: [String: Double]) -> Void) {
        self.sink = sink
    }

    /// 新一次回前台开始:清掉上一次的残留。
    func beginForeground() {
        steps = [:]
        frameMs = nil
        afterFrameDone = false
    }

    func add(_ name: String, ms: Double) {
        steps[name, default: 0] += ms
    }

    /// `fg.frame` 量到了。
    func frameRecorded(ms: Double) {
        frameMs = ms
        flushIfComplete()
    }

    /// 首帧之后的那一串步骤跑完了。两件事谁先到都行,第二件到时才写。
    func afterFrameFinished() {
        afterFrameDone = true
        flushIfComplete()
    }

    private func flushIfComplete() {
        guard let frame = frameMs, afterFrameDone else { return }
        defer { beginForeground() }
        guard frame > Self.slowFrameMs, !steps.isEmpty else { return }
        let slowest = steps.sorted { $0.value > $1.value }.prefix(Self.maxSteps)
        sink(frame, Dictionary(uniqueKeysWithValues: slowest.map { ($0.key, ($0.value * 10).rounded() / 10) }))
    }
}

/// [up-perf-ios] 回前台这一段的帧时间线,给 `fg.frame` 补三个字段(`ms` 本身的定义不变)。
///
/// 真机日志(1.77.6,10-22 的三次回前台)里,willEnterForeground 里用 `afterNextFrame` 排的回调
/// (`retracted orphaned … caller=foreground`)都打在 `→ Active` 之前:App 的第一帧在 didBecomeActive
/// 之前就已经上屏了。`fg.frame` 量的是 willEnterForeground → didBecomeActive 之后的那一帧,
/// 它把系统转场(解锁 / 切换器动画,App 管不了)和 App 自己占着主线程的时间混在一起;
/// 8 条慢样本的 `fg.steps` 里所有前台步骤加起来都不到 4 ms,光靠它分不出是哪一种。
/// - `first`:willEnterForeground → 第一帧(用户真正看到画面)
/// - `active`:willEnterForeground → didBecomeActive(系统转场 + 主线程排队)
/// - `stall`:这一段里主线程最长的一次空档(开始到第一帧,或两帧之间);主线程空闲时约等于一帧
struct ForegroundFrameTimeline {
    let start: Double
    private(set) var firstFrameAt: Double?
    private(set) var activeAt: Double?
    private(set) var maxGap: Double = 0
    private var lastTick: Double?

    init(start: Double) { self.start = start }

    mutating func tick(_ t: Double) {
        let gap = t - (lastTick ?? start)
        if gap > maxGap { maxGap = gap }
        if firstFrameAt == nil { firstFrameAt = t }
        lastTick = t
    }

    mutating func markActive(_ t: Double) {
        if activeAt == nil { activeAt = t }
    }

    /// 毫秒,保留一位小数;没量到的字段不写。
    var fields: [String: Double] {
        func ms(_ seconds: Double) -> Double { (seconds * 10_000).rounded() / 10 }
        var out: [String: Double] = [:]
        if let firstFrameAt { out["first"] = ms(firstFrameAt - start) }
        if let activeAt { out["active"] = ms(activeAt - start) }
        if lastTick != nil { out["stall"] = ms(maxGap) }
        return out
    }
}
