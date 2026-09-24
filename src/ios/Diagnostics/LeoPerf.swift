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
/// - cold        冷启动:进程启动 → 首帧(firstFrame)→ 会话列表(listLoaded)→ 输入框出现(inputReady)
/// - fg.frame    回前台 → 前台回调跑完后的第一帧
/// - send.firstToken      本机对话:点发送 → 第一个文字增量
/// - mac.ack / mac.firstToken  发给 Mac:点发送 → 中继回执 / 第一个 message.delta
/// - push.arrive 前台收到推送;负载带 sent_at 时记录送达耗时
/// - hang        主线程无响应 ≥250 ms(只计时,不抓栈)
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
        HangCounter.shared.start()
        let center = NotificationCenter.default
        center.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { _ in
            LeoPerf.lock.lock(); LeoPerf.wasInBackground = true; LeoPerf.lock.unlock()
        }
        center.addObserver(forName: UIApplication.willEnterForegroundNotification, object: nil, queue: .main) { _ in
            // 只量真正从后台回来的;冷启动时系统也会发这条通知,那段算在 cold 里。
            LeoPerf.lock.lock()
            if LeoPerf.wasInBackground { LeoPerf.foregroundAt = CACurrentMediaTime() }
            LeoPerf.wasInBackground = false
            LeoPerf.lock.unlock()
        }
        center.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { _ in
            HangCounter.shared.setActive(true)
            LeoPerf.lock.lock(); let began = LeoPerf.foregroundAt; LeoPerf.foregroundAt = nil; LeoPerf.lock.unlock()
            guard let began else { return }
            // 等 active 回调都跑完,再等下一帧真正画出来。
            DispatchQueue.main.async {
                FirstFrameProbe.once { LeoPerf.record("fg.frame", ms: (CACurrentMediaTime() - began) * 1000) }
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

    private static var coldSteps: [String: Double] = [:]
    private static var coldDone = false
    private static var foregroundAt: CFTimeInterval?
    private static var wasInBackground = false

    /// firstFrame / listLoaded / inputReady,各记第一次;inputReady 到了就落一条 cold 记录。
    static func coldStep(_ step: String) {
        let ms = Date().timeIntervalSince(processStart) * 1000
        lock.lock()
        guard !coldDone, coldSteps[step] == nil else { lock.unlock(); return }
        coldSteps[step] = ms
        let finished = step == "inputReady"
        if finished { coldDone = true }
        let steps = coldSteps
        lock.unlock()
        signposter.emitEvent("cold", "\(step, privacy: .public) \(ms, format: .fixed(precision: 1), privacy: .public)ms")
        guard finished else { return }
        // 系统预热拉起的进程,启动时刻早于你点图标,单独标出来,算 p50 时剔除。
        // 预热进程不一定带 ActivePrewarm(实测 1.41.2 记到过 12422909 ms = 3.4 小时):首帧晚于进程启动
        // 一分钟以上的,一律按预热算。
        let prewarm = ProcessInfo.processInfo.environment["ActivePrewarm"] == "1"
            || (steps["firstFrame"] ?? 0) > 60_000 || ms > 120_000
        var extra: [String: Any] = ["prewarm": prewarm]
        for (k, v) in steps where k != "inputReady" { extra[k] = (v * 10).rounded() / 10 }
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
        lock.unlock()
        guard let began else { return }
        var extra: [String: Any] = [:]
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

    func start() {
        guard timer == nil else { return }
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
        if ms >= Self.thresholdMs { LeoPerf.record("hang", ms: ms) }
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

// MARK: - 滚动 hitch

/// 手指拖动到减速停下之间,统计超出帧间隔的时间;hitch ratio = hitch 毫秒 / 滚动秒数。
final class ScrollHitchMeter: NSObject {
    static let shared = ScrollHitchMeter()

    private var link: CADisplayLink?
    private var last: CFTimeInterval = 0
    private var began: CFTimeInterval = 0
    private var hitchSeconds: Double = 0
    private var frames = 0

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
