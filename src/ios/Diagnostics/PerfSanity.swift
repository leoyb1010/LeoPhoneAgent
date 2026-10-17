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
