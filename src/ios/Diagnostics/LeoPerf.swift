import Foundation
import MetricKit
import QuartzCore
import UIKit
import os

/// [T-perf-1.39] 性能度量:signpost 区间 + 本机 JSONL 记录。只采集,不改任何行为。
///
/// 记录写在 Library/Application Support/Diagnostics/perf.jsonl,每行一条:
/// `{"t":时间戳,"e":事件,"ms":毫秒,"v":版本,...}`。取回:
///   xcrun devicectl device copy from --device <UDID> --domain-type appDataContainer \
///     --domain-identifier com.leoyuan.leophoneagent \
///     --source "Library/Application Support/Diagnostics/perf.jsonl" --destination perf.jsonl
///
/// 事件:
/// - cold        冷启动:进程启动 → 首帧(firstFrame,display link 真实上屏)→ 会话列表(listLoaded)
///               → 首页列表上屏(homeReady)或输入框出现(inputReady),先到者结束;`end` 字段记是哪一个。
///               `prewarm`:系统预热拉起;`bg`:进程是被后台拉起的(BGTask / 推送 / 静默通知等),
///               过了一阵才被用户点开。两者都不是「用户点图标到首页」,门禁计冷启动预算时一律剔除。
///               老版本记录没有 `bg`,读者按 false 处理。
/// - fg.frame    回前台 → 前台回调跑完后的第一帧
/// - send.firstToken      本机对话:点发送 → 第一个文字增量
/// - mac.ack / mac.firstToken  发给 Mac:点发送 → 中继回执 / 第一个 message.delta
/// - push.arrive 前台收到推送;负载带 sent_at 时记录送达耗时
/// - hang        主线程无响应 ≥250 ms(只计时,不抓栈);`stream`:卡顿开始前 2 s 内刚刷过流式文字
///               (见 `noteStreamingFlush`),门禁据此数「流式期间的卡顿」。老版本记录没有 `stream`,无法归类
/// - scroll.hitch        一次滚动的 hitch ratio(ms/s)
/// - mx.hang     MetricKit 日报里的卡顿直方图(参考)
enum LeoPerf {
    static let signposter = OSSignposter(subsystem: "com.leoyuan.leophoneagent", category: .pointsOfInterest)

    private static let queue = DispatchQueue(label: "com.leoyuan.leophoneagent.LeoPerf", qos: .utility)
    private static let lock = NSLock()
    private static let maxBytes: UInt64 = 1_000_000
    private static let version = (Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String) ?? "?"

    private static let fileURL: URL? = {
        guard let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
        else { return nil }
        let dir = support.appendingPathComponent("Diagnostics", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent("perf.jsonl")
    }()

    // MARK: - 启动

    /// 在 App init 最早处调用一次。
    static func start() {
        _ = processStart
        captureLaunchState()
        // [WP-46] 后台拉起的进程永远收不到 didBecomeActive / willResignActive:初值必须是真实状态,
        // 否则它一直按「前台」计卡顿(1.74 的 6 条 hang 里 5 条来自后台拉起)。
        let launchActive = Thread.isMainThread
            ? MainActor.assumeIsolated { UIApplication.shared.applicationState == .active }
            : true
        HangCounter.shared.start(active: launchActive)
        let center = NotificationCenter.default
        center.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { _ in
            LeoPerf.lock.lock()
            LeoPerf.wasInBackground = true; LeoPerf.backgroundEpoch += 1; LeoPerf.settleAnchor = nil
            LeoPerf.lock.unlock()
            ForegroundFrameMeter.shared.stop()
            // 回前台后没等到 active 就又退回后台时,不会再有 willResignActive 把它关掉。
            HangCounter.shared.setActive(false)
        }
        center.addObserver(forName: UIApplication.willEnterForegroundNotification, object: nil, queue: .main) { _ in
            // 只量真正从后台回来的;冷启动时系统也会发这条通知,那段算在 cold 里。
            let now = CACurrentMediaTime()
            LeoPerf.lock.lock()
            let returning = LeoPerf.wasInBackground
            if returning { LeoPerf.foregroundAt = now; LeoPerf.settleAnchor = now }
            LeoPerf.wasInBackground = false
            LeoPerf.lock.unlock()
            guard returning else { return }
            LeoPerf.fgLedger.beginForeground()
            // [up-perf-ios] 回前台的画面从这一刻起就在屏幕上(系统转场里),主线程卡顿用户看得见;
            // 以前要等 didBecomeActive 才开始计卡顿,这一段里卡多久都记不到。
            HangCounter.shared.setActive(true)
            ForegroundFrameMeter.shared.begin(at: now)
        }
        center.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { _ in
            HangCounter.shared.setActive(true)
            ForegroundFrameMeter.shared.markActive(at: CACurrentMediaTime())
            LeoPerf.lock.lock(); let began = LeoPerf.foregroundAt; LeoPerf.foregroundAt = nil; LeoPerf.lock.unlock()
            guard let began else { return }
            // 等 active 回调都跑完,再等下一帧真正画出来。
            DispatchQueue.main.async {
                FirstFrameProbe.once {
                    let ms = (CACurrentMediaTime() - began) * 1000
                    // `ms` 的定义不变(门禁读它);`first` / `active` / `stall` 拆开系统转场和主线程占用。
                    LeoPerf.record("fg.frame", ms: ms, extra: ForegroundFrameMeter.shared.finish())
                    LeoPerf.fgLedger.frameRecorded(ms: ms)
                }
            }
        }
        center.addObserver(forName: UIApplication.willResignActiveNotification, object: nil, queue: .main) { _ in
            HangCounter.shared.setActive(false)
        }
    }

    // MARK: - 记录

    static func record(_ event: String, ms: Double, extra: [String: Any] = [:]) {
        let now = Date().timeIntervalSince1970
        queue.async {
            guard let url = LeoPerf.fileURL else { return }
            var obj: [String: Any] = ["t": (now * 1000).rounded() / 1000, "e": event,
                                      "ms": (ms * 10).rounded() / 10, "v": LeoPerf.version]
            for (k, v) in extra { obj[k] = v }
            guard let data = try? JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys]) else { return }
            LeoPerf.append(data + Data([0x0A]), to: url)
        }
    }

    private static func append(_ line: Data, to url: URL) {
        if !FileManager.default.fileExists(atPath: url.path) {
            try? line.write(to: url)
            return
        }
        guard let handle = try? FileHandle(forWritingTo: url) else { return }
        let size = (try? handle.seekToEnd()) ?? 0
        if size > maxBytes {
            try? handle.close()
            // 超过上限只留后一半,从下一个完整行开始。
            if let all = try? Data(contentsOf: url) {
                let tail = all.suffix(Int(maxBytes / 2))
                let start = tail.firstIndex(of: 0x0A).map { tail.index(after: $0) } ?? tail.startIndex
                try? (Data(tail[start...]) + line).write(to: url)
            }
            return
        }
        try? handle.write(contentsOf: line)
        try? handle.close()
    }

    // MARK: - 冷启动

    /// 进程真正开始的时间(含 main 之前),取自内核记录的进程启动时刻。
    static let processStart: Date = {
        var info = kinfo_proc()
        var size = MemoryLayout<kinfo_proc>.stride
        var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, getpid()]
        guard sysctl(&mib, 4, &info, &size, nil, 0) == 0 else { return Date() }
        let tv = info.kp_proc.p_un.__p_starttime
        return Date(timeIntervalSince1970: Double(tv.tv_sec) + Double(tv.tv_usec) / 1_000_000)
    }()

    /// [WP-46] 进过几次后台。发送时记下,首字时对比:跨过后台的首字打 `bg: true`。
    private static var backgroundEpoch = 0
    private static var sendEpochs: [String: Int] = [:]

    /// [WP-46] 回前台分步计时(`FgStep` 写入,`fg.frame` 慢时落一条 `fg.steps`)。只在主线程用。
    static let fgLedger = FgStepLedger { frameMs, steps in
        record("fg.steps", ms: frameMs, extra: ["steps": steps])
    }

    private static var coldSteps: [String: Double] = [:]
    private static var coldDone = false
    private static var foregroundAt: CFTimeInterval?
    private static var wasInBackground = false
    /// [up-perf-ios] 这一次回前台(willEnterForeground)的时刻,回后台清掉。`waitForForegroundSettle` 用。
    private static var settleAnchor: CFTimeInterval?

    // MARK: - 回前台之后再跑的非界面工作

    private final class Once {
        private var done = false
        func claim() -> Bool { if done { return false }; done = true; return true }
    }

    /// [up-perf-ios] 回前台的非界面工作:首帧上屏后再等 `ForegroundSettlePolicy.settleDelay`,
    /// 用户在滑就再等一会儿(见 `ForegroundSettlePolicy`)。只推迟不丢:首帧回调没来(首帧之前又回了后台)
    /// 有 `fallbackDelay` 兜底,回到后台则立刻跑。
    static func afterForegroundSettles(_ action: @escaping @MainActor () -> Void) {
        let once = Once()
        let run: @MainActor () -> Void = { if once.claim() { action() } }
        afterNextFrame { pollSettle(anchor: CACurrentMediaTime(), run) }
        DispatchQueue.main.asyncAfter(deadline: .now() + ForegroundSettlePolicy.fallbackDelay) {
            MainActor.assumeIsolated { run() }
        }
    }

    @MainActor private static func pollSettle(anchor: CFTimeInterval, _ run: @escaping @MainActor () -> Void) {
        let decision = ForegroundSettlePolicy.decide(sinceAnchor: CACurrentMediaTime() - anchor,
                                                     scrolling: ScrollHitchMeter.shared.isScrolling,
                                                     inForeground: UIApplication.shared.applicationState != .background)
        switch decision {
        case .run:
            run()
        case .wait(let seconds):
            DispatchQueue.main.asyncAfter(deadline: .now() + seconds) {
                MainActor.assumeIsolated { pollSettle(anchor: anchor, run) }
            }
        }
    }

    /// [up-perf-ios] 给自带定时器的工作用(例如 iCloud 近期拉取定时器:进程从挂起恢复时它立刻补触发,
    /// 正好撞在回前台那一帧上)。不在回前台窗口里、或已经在后台:直接返回。
    /// `resumeGrace`:从挂起恢复时定时器会比 willEnterForeground 先到主线程(真机日志里
    /// `recentFetchTimer fired` 排在 `→ Inactive` 前面),这时还认不出是在回前台;不在 active 就先等这么久再判断。
    @MainActor static func waitForForegroundSettle(resumeGrace: TimeInterval = 0) async {
        if resumeGrace > 0, UIApplication.shared.applicationState != .active {
            try? await Task.sleep(nanoseconds: UInt64(resumeGrace * 1_000_000_000))
        }
        while true {
            lock.lock(); let anchor = settleAnchor; lock.unlock()
            let decision = ForegroundSettlePolicy.decide(sinceAnchor: anchor.map { CACurrentMediaTime() - $0 },
                                                         scrolling: ScrollHitchMeter.shared.isScrolling,
                                                         inForeground: UIApplication.shared.applicationState != .background)
            guard case .wait(let seconds) = decision else { return }
            try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
        }
    }

    // MARK: - 后台拉起判定

    /// 进程启动那一刻系统报告的 applicationState 是不是 `.background`。
    private static var launchStateWasBackground = false
    private static var backgroundLaunchMarked = false

    /// 首帧晚于进程启动这么久才出现,又在启动时处在后台,就判为「被后台拉起、后来才被点开」。
    /// 用户点图标的冷启动首帧在 1–2 s 内;8 s 以上不是在量「点图标到首页」。
    /// 比 `prewarm` 的 60 s 线更早:此前后台唤醒(BGTask / 推送)的进程只要在 60–120 s 内被点开,
    /// 就会被当成一次冷启动记进 p50/p90(审计时 `cold` 记录里没有任何后台拉起标记)。
    static let bgLaunchGraceMs: Double = 8_000

    /// 场景式生命周期下,第一个场景连上之前系统一律报 `.background`,所以这个状态只是线索,
    /// 不能单独定论;定论还要看首帧是不是很晚才出现(`isBackgroundLaunch`)。
    private static func captureLaunchState() {
        guard Thread.isMainThread else { return }
        let background = MainActor.assumeIsolated { UIApplication.shared.applicationState == .background }
        lock.lock(); launchStateWasBackground = background; lock.unlock()
    }

    /// 已知的后台入口(BGTask 处理器、静默推送、`BackgroundKeepAliveManager.setup()` 观察到后台拉起)
    /// 可以显式声明「这个进程是被后台拉起的」,比首帧时刻的推断更准。
    static func markBackgroundLaunch() {
        lock.lock(); backgroundLaunchMarked = true; lock.unlock()
    }

    static func isBackgroundLaunch(marked: Bool, stateWasBackground: Bool, firstFrameMs: Double) -> Bool {
        marked || (stateWasBackground && firstFrameMs > bgLaunchGraceMs)
    }

    // MARK: - 流式标记

    /// 最近一次流式文字刷新的时刻(CACurrentMediaTime)。`hang` 记录据此带上 `stream`:卡顿开始前
    /// `streamFreshSeconds` 内刚刷过流式文字,就算「流式期间」。
    /// 不用 acquire/release 计数:计数一旦漏掉一次 release,之后所有卡顿都会被误标成流式,门禁就会误报。
    private static var lastStreamFlushAt: CFTimeInterval?
    static let streamFreshSeconds: Double = 2

    /// 流式文字每刷新一次调用一次(`StreamingHangLogger.recordStreamingFlush`,主线程):一把锁加一次赋值。
    static func noteStreamingFlush() {
        let now = CACurrentMediaTime()
        lock.lock(); lastStreamFlushAt = now; lock.unlock()
    }

    /// `began`:这次卡顿的起点(主线程被卡住前最后一次 ping 发出的时刻)。
    static func isStreaming(hangBeganAt began: CFTimeInterval) -> Bool {
        lock.lock(); defer { lock.unlock() }
        guard let last = lastStreamFlushAt else { return false }
        return began - last <= streamFreshSeconds
    }

    /// [WP8] 首帧:下一次屏幕刷新(display link)时记 firstFrame,而不是 .task 开始的时刻。
    static func coldFirstFrame() {
        FirstFrameProbe.once { coldStep("firstFrame") }
    }

    /// [WP8] 首页列表已经展示:下一帧真正画出来时记 homeReady,结束 cold。
    /// 首页成为默认落地页后,只等 inputReady 量到的是「你多久才点进聊天」。
    static func coldHomeReady() {
        FirstFrameProbe.once { coldStep("homeReady") }
    }

    static let coldEndSteps: Set<String> = ["homeReady", "inputReady"]

    /// [S4/S5] Run `action` on the main thread right after the next frame is
    /// on screen (display link). The launch and foreground-return paths use it
    /// to keep everything that is not needed for that frame out of it.
    static func afterNextFrame(_ action: @escaping @MainActor () -> Void) {
        let run = { FirstFrameProbe.once { MainActor.assumeIsolated { action() } } }
        if Thread.isMainThread { run() } else { DispatchQueue.main.async(execute: run) }
    }

    /// firstFrame / listLoaded / homeReady / inputReady,各记第一次;homeReady 或 inputReady
    /// 先到的那个落一条 cold 记录。
    static func coldStep(_ step: String) {
        let ms = Date().timeIntervalSince(processStart) * 1000
        lock.lock()
        guard !coldDone, coldSteps[step] == nil else { lock.unlock(); return }
        coldSteps[step] = ms
        let finished = coldEndSteps.contains(step)
        if finished { coldDone = true }
        let steps = coldSteps
        let marked = backgroundLaunchMarked
        let stateWasBackground = launchStateWasBackground
        lock.unlock()
        signposter.emitEvent("cold", "\(step, privacy: .public) \(ms, format: .fixed(precision: 1), privacy: .public)ms")
        guard finished else { return }
        // 系统预热拉起的进程,启动时刻早于你点图标,单独标出来,算 p50 时剔除。
        // 预热进程不一定带 ActivePrewarm(实测 1.41.2 记到过 12422909 ms = 3.4 小时):首帧晚于进程启动
        // 一分钟以上的,一律按预热算。
        let prewarm = ProcessInfo.processInfo.environment["ActivePrewarm"] == "1"
            || (steps["firstFrame"] ?? 0) > 60_000 || ms > 120_000
        // 后台拉起(BGTask / 推送 / 静默通知)后来才被点开:同样不是「点图标到首页」,单独标出来。
        // 旧读者忽略这个新字段,旧记录没有它(读者按 false 处理)。
        let bg = isBackgroundLaunch(marked: marked, stateWasBackground: stateWasBackground,
                                    firstFrameMs: steps["firstFrame"] ?? ms)
        var extra: [String: Any] = ["prewarm": prewarm, "end": step, "bg": bg]
        for (k, v) in steps where k != step { extra[k] = (v * 10).rounded() / 10 }
        record("cold", ms: ms, extra: extra)
    }

    // MARK: - 发送 → 首字

    private static var sendStarts: [String: CFTimeInterval] = [:]
    private static var ackPending: [String: CFTimeInterval] = [:]
    /// 这次发送用的模型、第一次推理增量的时刻:首字慢时分得清是模型在想,还是网络 / 服务端慢。
    private static var sendModels: [String: String] = [:]
    private static var firstThought: [String: CFTimeInterval] = [:]

    static func key(_ object: AnyObject) -> String { "chat-\(ObjectIdentifier(object).hashValue)" }

    static func sendBegan(_ key: String, at time: CFTimeInterval = CACurrentMediaTime(), model: String? = nil) {
        lock.lock()
        sendStarts[key] = time
        sendEpochs[key] = backgroundEpoch
        sendModels[key] = model
        firstThought[key] = nil
        firstEvents[key] = nil
        lock.unlock()
    }

    /// 第一个可见动静(工具卡片、思考、文字,谁先到算谁)。带工具的一轮,文字可能在十几次工具调用之后
    /// 才出来,只看首字会把"很忙"误判成"很卡"(1.41.2 实测 88 s 首字其实是 15 次工具调用)。
    private static var firstEvents: [String: CFTimeInterval] = [:]
    static func firstEvent(_ key: String) {
        lock.lock()
        if sendStarts[key] != nil, firstEvents[key] == nil { firstEvents[key] = CACurrentMediaTime() }
        lock.unlock()
    }

    /// 推理(思考)增量先到:只记第一次。
    static func firstThinking(_ key: String) {
        lock.lock()
        if sendStarts[key] != nil, firstThought[key] == nil { firstThought[key] = CACurrentMediaTime() }
        lock.unlock()
    }

    /// 同一次发送只记第一个增量。
    static func firstToken(_ key: String, event: String = "send.firstToken") {
        lock.lock()
        let began = sendStarts.removeValue(forKey: key)
        let model = sendModels.removeValue(forKey: key)
        let thought = firstThought.removeValue(forKey: key)
        let firstSeen = firstEvents.removeValue(forKey: key)
        let spannedBackground = PerfSanity.spannedBackground(epochAtStart: sendEpochs.removeValue(forKey: key),
                                                             epochNow: backgroundEpoch)
        lock.unlock()
        guard let began else { return }
        var extra: [String: Any] = [:]
        if spannedBackground { extra["bg"] = true }
        if let model { extra["model"] = model }
        if let thought { extra["thinkMs"] = ((thought - began) * 1000).rounded() }
        if let firstSeen { extra["firstEventMs"] = ((firstSeen - began) * 1000).rounded() }
        record(event, ms: (CACurrentMediaTime() - began) * 1000, extra: extra)
    }

    /// 发给 Mac:请求发出前调用。
    static func macSendBegan(_ sessionId: String, at time: CFTimeInterval = CACurrentMediaTime()) {
        lock.lock(); ackPending[sessionId] = time; sendStarts["mac-\(sessionId)"] = time; lock.unlock()
    }

    /// 发给 Mac:中继返回成功时调用。
    static func macAck(_ sessionId: String) {
        lock.lock(); let began = ackPending.removeValue(forKey: sessionId); lock.unlock()
        guard let began else { return }
        record("mac.ack", ms: (CACurrentMediaTime() - began) * 1000)
    }

    static func macDelta(_ sessionId: String) {
        firstToken("mac-\(sessionId)", event: "mac.firstToken")
    }

    // MARK: - 推送

    static func pushArrived(_ userInfo: [AnyHashable: Any]) {
        var extra: [String: Any] = [:]
        if let kind = userInfo["type"] as? String ?? userInfo["event"] as? String { extra["kind"] = kind }
        if let sent = (userInfo["sent_at"] as? Double) ?? (userInfo["sent_at"] as? NSNumber)?.doubleValue {
            record("push.arrive", ms: (Date().timeIntervalSince1970 - sent) * 1000, extra: extra)
        } else {
            record("push.arrive", ms: 0, extra: extra.merging(["noSentAt": true]) { a, _ in a })
        }
    }

    // MARK: - MetricKit(参考)

    static func recordHangHistogram(_ histogram: MXHistogram<UnitDuration>) {
        var buckets: [String: Int] = [:]
        let enumerator = histogram.bucketEnumerator
        while let bucket = enumerator.nextObject() as? MXHistogramBucket<UnitDuration> {
            let lo = Int(bucket.bucketStart.converted(to: .milliseconds).value)
            buckets["\(lo)"] = bucket.bucketCount
        }
        guard !buckets.isEmpty else { return }
        record("mx.hang", ms: 0, extra: ["buckets": buckets])
    }
}

// MARK: - 主线程卡顿计数(≥250 ms)

/// 后台线程每 50 ms 往主队列丢一个 ping;ping 迟迟得不到执行,就是主线程卡住了。
/// 只计时,不挂起主线程、不抓栈,开销可忽略。抓栈仍由流式期间的 HangDetector(1 s)负责。
final class HangCounter {
    static let shared = HangCounter()

    private let lock = NSLock()
    private let timerQueue = DispatchQueue(label: "com.leoyuan.leophoneagent.HangCounter", qos: .utility)
    private var timer: DispatchSourceTimer?
    private var pingSentAt: CFTimeInterval?
    private var active = true
    static let thresholdMs: Double = 250

    func start(active initial: Bool = true) {
        guard timer == nil else { return }
        lock.lock(); active = initial; lock.unlock()
        let t = DispatchSource.makeTimerSource(queue: timerQueue)
        t.schedule(deadline: .now() + 0.5, repeating: .milliseconds(50), leeway: .milliseconds(10))
        t.setEventHandler { [weak self] in self?.tick() }
        t.resume()
        timer = t
    }

    func setActive(_ value: Bool) {
        lock.lock(); active = value; pingSentAt = nil; lock.unlock()
    }

    private func tick() {
        lock.lock()
        guard active, pingSentAt == nil else { lock.unlock(); return }
        pingSentAt = CACurrentMediaTime()
        lock.unlock()
        DispatchQueue.main.async { [weak self] in self?.pong() }
    }

    private func pong() {
        let now = CACurrentMediaTime()
        lock.lock()
        let sent = pingSentAt
        pingSentAt = nil
        let isActive = active
        lock.unlock()
        guard let sent, isActive else { return }
        let ms = (now - sent) * 1000
        // [WP-46] 隔了十几秒甚至几十分钟才回来的 ping 是进程被挂起过,不是卡顿(真机记到过 19.8 分钟)。
        guard !PerfSanity.isSuspensionArtifact(hangMs: ms) else { return }
        // `sent` 之后主线程才被卡住,所以它就是卡顿的起点;`stream` 标明起点前是否刚刷过流式文字。
        if ms >= Self.thresholdMs {
            LeoPerf.record("hang", ms: ms, extra: ["stream": LeoPerf.isStreaming(hangBeganAt: sent)])
        }
    }
}

// MARK: - 首帧探针

/// 下一次屏幕刷新时回调一次。
private final class FirstFrameProbe: NSObject {
    private var link: CADisplayLink?
    private var action: (() -> Void)?

    static func once(_ action: @escaping () -> Void) {
        let probe = FirstFrameProbe()
        probe.action = action
        let link = CADisplayLink(target: probe, selector: #selector(fire))
        probe.link = link
        link.add(to: .main, forMode: .common)
    }

    @objc private func fire() {
        link?.invalidate()
        link = nil
        action?()
        action = nil
    }
}

// MARK: - 回前台帧时间线

/// [up-perf-ios] willEnterForeground 起每帧记一次(见 `ForegroundFrameTimeline`),`fg.frame` 记录时收尾。
/// 只在主线程用;最多跑 10 s,回后台即停,不会留下一个常驻的 display link。
private final class ForegroundFrameMeter: NSObject {
    static let shared = ForegroundFrameMeter()

    private var link: CADisplayLink?
    private var timeline: ForegroundFrameTimeline?
    private var deadline: CFTimeInterval = 0

    func begin(at start: CFTimeInterval) {
        stop()
        timeline = ForegroundFrameTimeline(start: start)
        deadline = start + 10
        let l = CADisplayLink(target: self, selector: #selector(tick))
        l.add(to: .main, forMode: .common)
        link = l
    }

    func markActive(at t: CFTimeInterval) {
        timeline?.markActive(t)
    }

    /// 取字段并停表;没在量时返回空。
    func finish() -> [String: Any] {
        let fields = timeline?.fields ?? [:]
        stop()
        return fields
    }

    func stop() {
        link?.invalidate()
        link = nil
        timeline = nil
    }

    // 用回调真正跑起来的时刻,而不是 vsync 时刻:要量的是主线程什么时候空出来。
    @objc private func tick() {
        let now = CACurrentMediaTime()
        timeline?.tick(now)
        if now > deadline { stop() }
    }
}

// MARK: - 滚动 hitch

/// 手指拖动到减速停下之间,统计超出帧间隔的时间;hitch ratio = hitch 毫秒 / 滚动秒数。
final class ScrollHitchMeter: NSObject {
    static let shared = ScrollHitchMeter()

    private var link: CADisplayLink?
    private var last: CFTimeInterval = 0
    private var began: CFTimeInterval = 0
    private var hitchSeconds: Double = 0
    private var frames = 0

    /// 手指拖动到减速停下之间为 true(主线程读)。回前台的非界面工作据此让开用户的滑动。
    var isScrolling: Bool { link != nil }

    func begin() {
        guard link == nil else { return }
        last = 0
        hitchSeconds = 0
        frames = 0
        began = CACurrentMediaTime()
        let l = CADisplayLink(target: self, selector: #selector(tick(_:)))
        l.add(to: .main, forMode: .common)
        link = l
    }

    func end() {
        guard let l = link else { return }
        l.invalidate()
        link = nil
        let duration = CACurrentMediaTime() - began
        guard duration >= 0.3, frames > 5 else { return }
        LeoPerf.record("scroll.hitch", ms: hitchSeconds * 1000 / duration,
                       extra: ["dur": (duration * 100).rounded() / 100, "frames": frames])
    }

    @objc private func tick(_ l: CADisplayLink) {
        frames += 1
        let interval = l.targetTimestamp - l.timestamp
        if last > 0, interval > 0 {
            let actual = l.timestamp - last
            let excess = actual - interval
            if excess > interval * 0.5 { hitchSeconds += excess }
        }
        last = l.timestamp
    }
}
