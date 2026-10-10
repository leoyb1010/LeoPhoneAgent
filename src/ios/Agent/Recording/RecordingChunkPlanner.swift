import Foundation

/// [V-rec] 录音分块的纯状态机:决定每个采集缓冲写进哪一块、什么时候换块。
/// 录音器(RecordingSession)只照着返回的动作执行,所以分块规则可以脱离麦克风单测。
///
/// 规则:
/// - 一块最多 `maxChunkSeconds`(默认 10 分钟)。缓冲会让当前块超过上限时,先关旧块、开新块,
///   整个缓冲写进新块(块长 ≈ 10 分钟 ± 一个缓冲)。
/// - 你按暂停:当前块保持打开,继续时接着写同一块(采样率没变的话)。
/// - 来电 / Siri 打断:系统已经停了引擎,当前块立即关闭;恢复时开新块。
/// - 采样率变了(换耳机、蓝牙):关旧块开新块,一块里永远只有一种格式。
/// - 停止:关最后一块。没写进任何帧的块会被丢掉,不留空文件。
struct RecordingChunkPlanner: Equatable, Sendable {
    static let defaultChunkSeconds: Double = 600

    enum PauseReason: String, Equatable, Sendable {
        case user
        case interruption
    }

    enum State: Equatable, Sendable {
        case idle
        case recording
        case paused(PauseReason)
        case stopped
    }

    enum Action: Equatable, Sendable {
        /// 打开一块新文件。
        case open(RecordingChunk)
        /// 把这个缓冲写进第 `index` 块。
        case write(index: Int, frames: Int)
        /// 关闭第 `index` 块(写完尾部、落盘)。
        case close(index: Int)
        /// 第 `index` 块一帧都没写,关闭后删掉。
        case discard(index: Int)
    }

    let maxChunkSeconds: Double
    private(set) var state: State = .idle
    private(set) var chunks: [RecordingChunk] = []
    /// 当前打开的块在 `chunks` 里的位置。
    private var openPosition: Int?

    init(maxChunkSeconds: Double = RecordingChunkPlanner.defaultChunkSeconds, existing: [RecordingChunk] = []) {
        self.maxChunkSeconds = max(1, maxChunkSeconds)
        // 接着已有的块往后写(导入后继续录、或恢复后续录)时,已有块全部视为关闭。
        self.chunks = existing.map { var c = $0; c.isOpen = false; return c }
    }

    /// 已录总时长(秒,不含暂停)。
    var elapsed: Double { chunks.reduce(0) { $0 + $1.duration } }

    var openChunk: RecordingChunk? { openPosition.map { chunks[$0] } }

    var isCapturing: Bool { state == .recording }

    // MARK: - Events

    mutating func start(sampleRate: Double) -> [Action] {
        guard state == .idle else { return [] }
        state = .recording
        return [openNewChunk(sampleRate: sampleRate)]
    }

    /// 采集线程送来一个缓冲。不在录音状态时丢弃(暂停中、已停)。
    mutating func append(frames: Int, sampleRate: Double) -> [Action] {
        guard state == .recording, frames > 0, sampleRate > 0, sampleRate.isFinite else { return [] }
        var actions: [Action] = []
        if let pos = openPosition {
            let current = chunks[pos]
            let formatChanged = abs(current.sampleRate - sampleRate) > 0.5
            let wouldOverflow = current.frameCount > 0
                && Double(current.frameCount + Int64(frames)) / current.sampleRate > maxChunkSeconds
            if formatChanged || wouldOverflow {
                actions += closeOpenChunk()
                actions.append(openNewChunk(sampleRate: sampleRate))
            }
        } else {
            actions.append(openNewChunk(sampleRate: sampleRate))
        }
        guard let pos = openPosition else { return actions }
        chunks[pos].frameCount += Int64(frames)
        actions.append(.write(index: chunks[pos].index, frames: frames))
        return actions
    }

    mutating func pause(_ reason: PauseReason) -> [Action] {
        switch state {
        case .recording:
            state = .paused(reason)
            // 打断时引擎已经停了,块必须立刻落盘;你自己暂停的块保持打开。
            return reason == .interruption ? closeOpenChunk() : []
        case .paused(.user) where reason == .interruption:
            // 暂停中又来了电话:系统同样会收回会话,把开着的块关掉。
            state = .paused(.interruption)
            return closeOpenChunk()
        default:
            return []
        }
    }

    /// 继续录。`sampleRate` 是引擎重启后的输入采样率。
    mutating func resume(sampleRate: Double) -> [Action] {
        guard case .paused = state else { return [] }
        state = .recording
        if let pos = openPosition, abs(chunks[pos].sampleRate - sampleRate) <= 0.5 {
            return []   // 同一块接着写
        }
        var actions = closeOpenChunk()
        actions.append(openNewChunk(sampleRate: sampleRate))
        return actions
    }

    mutating func stop() -> [Action] {
        guard state != .stopped, state != .idle else { state = .stopped; return [] }
        state = .stopped
        return closeOpenChunk()
    }

    // MARK: - Helpers

    private mutating func openNewChunk(sampleRate: Double) -> Action {
        let index = (chunks.map(\.index).max() ?? -1) + 1
        let chunk = RecordingChunk(index: index,
                                   fileName: RecordingChunk.fileName(forIndex: index),
                                   startOffset: elapsed,
                                   sampleRate: sampleRate,
                                   frameCount: 0,
                                   isOpen: true)
        chunks.append(chunk)
        openPosition = chunks.count - 1
        return .open(chunk)
    }

    private mutating func closeOpenChunk() -> [Action] {
        guard let pos = openPosition else { return [] }
        openPosition = nil
        let chunk = chunks[pos]
        if chunk.frameCount == 0 {
            chunks.remove(at: pos)
            return [.discard(index: chunk.index)]
        }
        chunks[pos].isOpen = false
        return [.close(index: chunk.index)]
    }
}
