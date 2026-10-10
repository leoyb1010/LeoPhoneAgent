import AVFoundation
import Foundation

private let logger = AppLogger(category: "Recording")

/// [V-rec] 一次录音的采集管线:AVAudioEngine 麦克风 tap → 单声道 Float32 →
/// RecordingChunkPlanner 决定写哪一块 → RecordingAudioWriter(分片 AAC)。
///
/// 和语音输入(VoiceInputPanel / VoiceActivityDetector)完全独立:自己的引擎、自己的会话意图
/// (`.recording`)、没有 300 秒上限。音频会话由 RecordingController 负责 begin/end。
///
/// 线程:控制方法都在主线程;tap 在音频线程,只做拷贝 / 电平 / 实时字幕送样;
/// 所有文件写入在 `queue` 串行执行,不阻塞采集。
final class RecordingSession: @unchecked Sendable {
    enum SessionError: Error, LocalizedError {
        case microphoneUnavailable
        case engineFailed(String)

        var errorDescription: String? {
            switch self {
            case .microphoneUnavailable:
                return String(localized: "麦克风暂时不可用(可能正在通话或被其他 App 占用),请稍后再试。")
            case .engineFailed(let detail):
                return String(localized: "录音启动失败:\(detail)")
            }
        }
    }

    let recordingId: String
    private let store: RecordingStore

    private var engine = AVAudioEngine()
    private var tapInstalled = false
    private var configObserver: NSObjectProtocol?

    /// 写入队列独占的状态。
    private let queue = DispatchQueue(label: "com.leoyuan.leophoneagent.recording.writer", qos: .userInitiated)
    private var planner: RecordingChunkPlanner
    private var writers: [Int: RecordingAudioWriter] = [:]
    private var buffersSincePublish = 0

    /// 跨线程读的快照。
    private let lock = NSLock()
    private var _elapsed: Double = 0
    private var _liveSamples: ((UnsafeBufferPointer<Float>, Double) -> Void)?
    /// 暂停中:不送实时字幕(没录进去的话不该出现在字幕里)。
    private var _paused = false
    private var levelSum: Float = 0
    private var levelCount = 0
    private var lastLevelPost: TimeInterval = 0

    /// 块列表变化(开新块、关块、每 ~5 秒的帧数更新),主线程回调。用来落 meta.json。
    var onChunksChanged: (([RecordingChunk]) -> Void)?
    /// 电平 0…1,约 10 次/秒,主线程回调。
    var onLevel: ((Float) -> Void)?
    /// 写文件失败(磁盘满等),主线程回调。
    var onWriteFailure: ((String) -> Void)?
    /// 引擎被路由变化停掉且重建失败,主线程回调。
    var onEngineLost: (() -> Void)?

    init(recordingId: String, store: RecordingStore, existingChunks: [RecordingChunk] = []) {
        self.recordingId = recordingId
        self.store = store
        self.planner = RecordingChunkPlanner(existing: existingChunks)
        self._elapsed = planner.elapsed
    }

    deinit {
        if let configObserver { NotificationCenter.default.removeObserver(configObserver) }
    }

    /// 已录时长(不含暂停),任何线程可读。
    var elapsed: Double { lock.withLock { _elapsed } }

    /// 实时字幕的采样出口(音频线程调用)。nil = 不送。
    var liveSamples: ((UnsafeBufferPointer<Float>, Double) -> Void)? {
        get { lock.withLock { _liveSamples } }
        set { lock.withLock { _liveSamples = newValue } }
    }

    var isEngineRunning: Bool { engine.isRunning }

    // MARK: - Control (main thread)

    /// 装 tap、启动引擎、开第一块。调用前音频会话必须已经是 `.record`。
    func start() throws {
        let rate = try startEngine()
        // Serial queue: the first chunk opens before any tap buffer enqueued after it.
        queue.async { [self] in apply(planner.start(sampleRate: rate), buffer: nil) }
        logger.info("[Recording] started rate=\(Int(rate))")
    }

    /// 你按了暂停:块保持打开,采集继续但丢弃(麦克风待命,锁屏后 App 不会被挂起,
    /// 在灵动岛上点继续能立即接上)。
    func pauseByUser() {
        lock.withLock { _paused = true }
        queue.async { [self] in apply(planner.pause(.user), buffer: nil) }
    }

    /// 来电 / Siri:系统已经停了引擎。当前块立即落盘。
    func interruptionBegan() {
        teardownEngine()
        queue.async { [self] in apply(planner.pause(.interruption), buffer: nil) }
        logger.info("[Recording] interrupted — chunk closed")
    }

    /// 继续录。引擎没在跑(打断后)就重建;采样率变了规划器会开新块。
    func resume() throws {
        let rate: Double
        if engine.isRunning, tapInstalled {
            rate = engine.inputNode.inputFormat(forBus: 0).sampleRate
        } else {
            rate = try startEngine()
        }
        queue.async { [self] in apply(planner.resume(sampleRate: rate), buffer: nil) }
        lock.withLock { _paused = false }
        logger.info("[Recording] resumed rate=\(Int(rate))")
    }

    /// 停止:拆 tap、停引擎、关最后一块(在写入队列上写完尾部,不卡主线程)。返回最终的块列表。
    func stop() async -> [RecordingChunk] {
        teardownEngine()
        liveSamples = nil
        return await withCheckedContinuation { continuation in
            queue.async { [self] in
                apply(planner.stop(), buffer: nil)
                // 规划器之外万一还有没关的写入器(写失败的块),一并收尾。
                for (_, writer) in writers { writer.finish() }
                writers.removeAll()
                continuation.resume(returning: planner.chunks)
            }
        }
    }

    // MARK: - Engine

    @discardableResult
    private func startEngine() throws -> Double {
        teardownEngine()
        var input = engine.inputNode
        var format = input.inputFormat(forBus: 0)
        if format.channelCount == 0 || format.sampleRate <= 0 {
            // 旧的输入绑定:换一个引擎再读一次(和语音输入同样的修法)。
            engine = AVAudioEngine()
            input = engine.inputNode
            format = input.inputFormat(forBus: 0)
        }
        guard format.channelCount > 0, format.sampleRate > 0 else {
            throw SessionError.microphoneUnavailable
        }
        let rate = format.sampleRate
        var tapError: String?
        let installed = noff_try_objc {
            input.installTap(onBus: 0, bufferSize: 4_096, format: format) { [weak self] buffer, _ in
                self?.handleTap(buffer)
            }
        }
        if !installed { tapError = "installTap" }
        guard tapError == nil else { throw SessionError.engineFailed(tapError ?? "") }
        tapInstalled = true
        var startError: Error?
        let started = noff_try_objc {
            self.engine.prepare()
            do { try self.engine.start() } catch { startError = error }
        }
        if let startError {
            teardownEngine()
            throw SessionError.engineFailed(startError.localizedDescription)
        }
        guard started else {
            teardownEngine()
            throw SessionError.engineFailed("AVAudioEngine")
        }
        observeConfigurationChanges()
        return rate
    }

    private func teardownEngine() {
        if let configObserver {
            NotificationCenter.default.removeObserver(configObserver)
            self.configObserver = nil
        }
        _ = noff_try_objc { self.engine.stop() }
        if tapInstalled {
            _ = noff_try_objc { self.engine.inputNode.removeTap(onBus: 0) }
            tapInstalled = false
        }
    }

    /// 换耳机 / 蓝牙接入断开时,AVAudioEngine 会停下并发这个通知:按新的输入格式重装 tap 再启动。
    /// 规划器看到新采样率会自己开新块。
    private func observeConfigurationChanges() {
        configObserver = NotificationCenter.default.addObserver(
            forName: .AVAudioEngineConfigurationChange, object: engine, queue: .main
        ) { [weak self] _ in
            guard let self else { return }
            logger.info("[Recording] engine configuration changed — rebuilding tap")
            do {
                try self.startEngine()
            } catch {
                logger.error("[Recording] rebuild after route change failed: \(error.localizedDescription)")
                self.onEngineLost?()
            }
        }
    }

    // MARK: - Tap (audio thread)

    private func handleTap(_ buffer: AVAudioPCMBuffer) {
        let frames = Int(buffer.frameLength)
        guard frames > 0, let src = buffer.floatChannelData else { return }
        let rate = buffer.format.sampleRate
        let channels = Int(buffer.format.channelCount)
        guard let monoFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: rate, channels: 1, interleaved: false),
              let mono = AVAudioPCMBuffer(pcmFormat: monoFormat, frameCapacity: AVAudioFrameCount(frames)),
              let dst = mono.floatChannelData?[0] else { return }
        mono.frameLength = AVAudioFrameCount(frames)
        if channels <= 1 {
            dst.update(from: src[0], count: frames)
        } else {
            let scale = 1 / Float(channels)
            for i in 0..<frames {
                var sum: Float = 0
                for c in 0..<channels { sum += src[c][i] }
                dst[i] = sum * scale
            }
        }
        // 电平(RMS),约 10 次/秒回主线程。
        var sumSquares: Float = 0
        for i in 0..<frames { sumSquares += dst[i] * dst[i] }
        let rms = (sumSquares / Float(frames)).squareRoot()
        let now = ProcessInfo.processInfo.systemUptime
        var postLevel: Float?
        let feed: ((UnsafeBufferPointer<Float>, Double) -> Void)?
        lock.lock()
        levelSum += rms
        levelCount += 1
        if now - lastLevelPost >= 0.1 {
            postLevel = levelSum / Float(max(1, levelCount))
            levelSum = 0
            levelCount = 0
            lastLevelPost = now
        }
        feed = _paused ? nil : _liveSamples
        lock.unlock()
        if let postLevel {
            // -50 dBFS … 0 dBFS 映射到 0…1。
            let db = 20 * log10(max(postLevel, 1e-6))
            let level = max(0, min(1, (db + 50) / 50))
            DispatchQueue.main.async { [weak self] in self?.onLevel?(level) }
        }
        feed?(UnsafeBufferPointer(start: dst, count: frames), rate)
        queue.async { [weak self] in self?.write(mono, sampleRate: rate) }
    }

    // MARK: - Writer queue

    private func write(_ buffer: AVAudioPCMBuffer, sampleRate: Double) {
        let actions = planner.append(frames: Int(buffer.frameLength), sampleRate: sampleRate)
        guard !actions.isEmpty else { return }
        apply(actions, buffer: buffer)
        buffersSincePublish += 1
        if buffersSincePublish >= 50 {   // ~5 s at 4096 frames / 44.1–48 kHz
            buffersSincePublish = 0
            publishChunks()
        }
    }

    /// 在写入队列上执行规划器的动作。
    private func apply(_ actions: [RecordingChunkPlanner.Action], buffer: AVAudioPCMBuffer?) {
        var structural = false
        for action in actions {
            switch action {
            case .open(let chunk):
                structural = true
                do {
                    let url = try store.audioURL(for: recordingId, fileName: chunk.fileName)
                    writers[chunk.index] = try RecordingAudioWriter(url: url, sampleRate: chunk.sampleRate)
                    LeoPerf.record("rec.chunkOpen", ms: 0, extra: ["index": chunk.index, "rate": Int(chunk.sampleRate)])
                } catch {
                    logger.error("[Recording] open chunk \(chunk.index) failed: \(error.localizedDescription)")
                    let message = error.localizedDescription
                    DispatchQueue.main.async { [weak self] in self?.onWriteFailure?(message) }
                }
            case .write(let index, _):
                if let buffer, let writer = writers[index] {
                    writer.append(buffer)
                    if let failure = writer.failureDescription {
                        writers[index] = nil
                        logger.error("[Recording] chunk \(index) writer failed: \(failure)")
                        DispatchQueue.main.async { [weak self] in self?.onWriteFailure?(failure) }
                    }
                }
            case .close(let index):
                structural = true
                if let writer = writers.removeValue(forKey: index) {
                    let start = Date()
                    writer.finish()
                    LeoPerf.record("rec.chunkClose", ms: Date().timeIntervalSince(start) * 1000,
                                   extra: ["index": index, "sec": Int(writer.duration), "dropped": writer.droppedBuffers])
                }
                store.applyBackupExclusion(id: recordingId)
            case .discard(let index):
                structural = true
                if let writer = writers.removeValue(forKey: index) { writer.finish() }
                store.deleteAudio(id: recordingId, fileName: RecordingChunk.fileName(forIndex: index))
            }
        }
        lock.withLock { _elapsed = planner.elapsed }
        if structural { publishChunks() }
    }

    private func publishChunks() {
        let chunks = planner.chunks
        DispatchQueue.main.async { [weak self] in self?.onChunksChanged?(chunks) }
    }
}
