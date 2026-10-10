import AVFoundation
import CoreMedia
import Foundation

/// [V-rec] 一块录音文件的写入器:单声道 Float32 PCM → AAC(.m4a)。
///
/// 用 AVAssetWriter 的 movie fragment(每 `fragmentSeconds` 秒落一个片段)而不是 AVAudioFile:
/// AVAudioFile 只在 close 时写文件头,App 被杀或崩溃时整块 10 分钟都读不出来;
/// 分片写法崩溃后最多丢最后几秒,其余照样能播放、能转写(RecordingWriterCrashSafetyTests)。
///
/// 线程:`append`/`finish` 由调用方在同一个串行队列上调用(RecordingSession 的写入队列)。
final class RecordingAudioWriter: @unchecked Sendable {
    enum WriterError: Error, LocalizedError {
        case cannotCreate(String)
        case formatUnsupported

        var errorDescription: String? {
            switch self {
            case .cannotCreate(let detail): return String(localized: "无法创建录音文件:\(detail)")
            case .formatUnsupported: return String(localized: "麦克风格式不受支持")
            }
        }
    }

    static let fragmentSeconds: Double = 5

    let url: URL
    let sampleRate: Double
    private let writer: AVAssetWriter
    private let input: AVAssetWriterInput
    private let pcmFormat: AVAudioFormat
    private var formatDescription: CMAudioFormatDescription?
    private var framesWritten: Int64 = 0
    private var started = false
    private(set) var droppedBuffers = 0

    /// AAC 编码器支持的采样率;输入不在其中时让写入器重采样到最接近的一个。
    static let aacSampleRates: [Double] = [8_000, 11_025, 12_000, 16_000, 22_050, 24_000, 32_000, 44_100, 48_000]

    static func outputSampleRate(for input: Double) -> Double {
        guard input.isFinite, input > 0 else { return 48_000 }
        return aacSampleRates.min { abs($0 - input) < abs($1 - input) } ?? 48_000
    }

    init(url: URL, sampleRate: Double) throws {
        guard sampleRate.isFinite, sampleRate > 0,
              let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: sampleRate,
                                         channels: 1, interleaved: false) else {
            throw WriterError.formatUnsupported
        }
        self.url = url
        self.sampleRate = sampleRate
        self.pcmFormat = format
        try? FileManager.default.removeItem(at: url)
        do {
            writer = try AVAssetWriter(outputURL: url, fileType: .m4a)
        } catch {
            throw WriterError.cannotCreate(error.localizedDescription)
        }
        writer.movieFragmentInterval = CMTime(seconds: Self.fragmentSeconds, preferredTimescale: 600)
        writer.shouldOptimizeForNetworkUse = false
        let outRate = Self.outputSampleRate(for: sampleRate)
        let settings: [String: Any] = [
            AVFormatIDKey: kAudioFormatMPEG4AAC,
            AVSampleRateKey: outRate,
            AVNumberOfChannelsKey: 1,
            AVEncoderBitRateKey: outRate >= 32_000 ? 64_000 : 32_000,
        ]
        var desc: CMAudioFormatDescription?
        var asbd = format.streamDescription.pointee
        CMAudioFormatDescriptionCreate(allocator: kCFAllocatorDefault, asbd: &asbd, layoutSize: 0, layout: nil,
                                       magicCookieSize: 0, magicCookie: nil, extensions: nil,
                                       formatDescriptionOut: &desc)
        formatDescription = desc
        input = AVAssetWriterInput(mediaType: .audio, outputSettings: settings, sourceFormatHint: desc)
        input.expectsMediaDataInRealTime = true
        guard writer.canAdd(input) else { throw WriterError.cannotCreate("input") }
        writer.add(input)
    }

    var duration: Double { Double(framesWritten) / sampleRate }
    var frames: Int64 { framesWritten }

    /// 写一个单声道 Float32 缓冲(采样率必须等于 `sampleRate`)。编码器忙不过来时丢弃并计数,
    /// 不阻塞采集线程。返回是否写入。
    /// `waitUpTo` > 0:编码器忙时最多等这么久(离线写入 / 测试用;实时采集传 0)。
    @discardableResult
    func append(_ buffer: AVAudioPCMBuffer, waitUpTo: TimeInterval = 0) -> Bool {
        guard buffer.frameLength > 0, let desc = formatDescription else { return false }
        if !started {
            guard writer.startWriting() else { return false }
            writer.startSession(atSourceTime: .zero)
            started = true
        }
        guard writer.status == .writing else { return false }
        if waitUpTo > 0, !input.isReadyForMoreMediaData {
            let deadline = Date().addingTimeInterval(waitUpTo)
            while !input.isReadyForMoreMediaData, Date() < deadline { usleep(2_000) }
        }
        guard input.isReadyForMoreMediaData else {
            droppedBuffers += 1
            framesWritten += Int64(buffer.frameLength)   // 保持时间轴连续(这一小段是静音缺口)
            return false
        }
        var timing = CMSampleTimingInfo(duration: CMTime(value: 1, timescale: CMTimeScale(sampleRate)),
                                        presentationTimeStamp: CMTime(value: framesWritten, timescale: CMTimeScale(sampleRate)),
                                        decodeTimeStamp: .invalid)
        var sample: CMSampleBuffer?
        var status = CMSampleBufferCreate(allocator: kCFAllocatorDefault, dataBuffer: nil, dataReady: false,
                                          makeDataReadyCallback: nil, refcon: nil, formatDescription: desc,
                                          sampleCount: CMItemCount(buffer.frameLength), sampleTimingEntryCount: 1,
                                          sampleTimingArray: &timing, sampleSizeEntryCount: 0, sampleSizeArray: nil,
                                          sampleBufferOut: &sample)
        guard status == noErr, let sample else { return false }
        status = CMSampleBufferSetDataBufferFromAudioBufferList(sample, blockBufferAllocator: kCFAllocatorDefault,
                                                                blockBufferMemoryAllocator: kCFAllocatorDefault,
                                                                flags: 0, bufferList: buffer.audioBufferList)
        guard status == noErr else { return false }
        let ok = input.append(sample)
        framesWritten += Int64(buffer.frameLength)
        return ok
    }

    /// 收尾:写完最后的片段并关闭文件。同步等待(最多 `timeout` 秒),调用方在写入队列上。
    func finish(timeout: TimeInterval = 10) {
        guard started else {
            writer.cancelWriting()
            try? FileManager.default.removeItem(at: url)
            return
        }
        guard writer.status == .writing else { return }
        input.markAsFinished()
        writer.endSession(atSourceTime: CMTime(value: framesWritten, timescale: CMTimeScale(sampleRate)))
        let done = DispatchSemaphore(value: 0)
        writer.finishWriting { done.signal() }
        _ = done.wait(timeout: .now() + timeout)
    }

    var failureDescription: String? {
        writer.status == .failed ? (writer.error?.localizedDescription ?? "unknown") : nil
    }
}

/// [V-rec] 把录音文件(包括崩溃留下的分片文件、导入的任意音频)读成 PCM。
/// 转写、云端上传都从这里取数据,不依赖 AVAudioFile 能不能解析文件头。
enum RecordingAudioReader {
    enum ReaderError: Error, LocalizedError {
        case noAudioTrack
        case cannotRead(String)

        var errorDescription: String? {
            switch self {
            case .noAudioTrack: return String(localized: "文件里没有音频")
            case .cannotRead(let detail): return String(localized: "无法读取音频:\(detail)")
            }
        }
    }

    /// 文件里音频的实际时长(秒)。读不出来返回 nil。
    static func duration(of url: URL) async -> Double? {
        let asset = AVURLAsset(url: url)
        guard let tracks = try? await asset.loadTracks(withMediaType: .audio), let track = tracks.first,
              let range = try? await track.load(.timeRange) else { return nil }
        let seconds = range.duration.seconds
        return seconds.isFinite && seconds > 0 ? seconds : nil
    }

    /// 按 `format`(必须是 PCM)读出 [start, start+duration) 这段,每读到一批回调一次。
    /// `format` 只支持单声道 Float32 或 Int16(interleaved)。
    static func read(url: URL, start: Double, duration: Double, format: AVAudioFormat,
                     handler: (AVAudioPCMBuffer) throws -> Void) async throws {
        let asset = AVURLAsset(url: url)
        let tracks = try await asset.loadTracks(withMediaType: .audio)
        guard let track = tracks.first else { throw ReaderError.noAudioTrack }
        let reader: AVAssetReader
        do { reader = try AVAssetReader(asset: asset) } catch { throw ReaderError.cannotRead(error.localizedDescription) }
        let isFloat = format.commonFormat == .pcmFormatFloat32
        let settings: [String: Any] = [
            AVFormatIDKey: kAudioFormatLinearPCM,
            AVSampleRateKey: format.sampleRate,
            AVNumberOfChannelsKey: 1,
            AVLinearPCMBitDepthKey: isFloat ? 32 : 16,
            AVLinearPCMIsFloatKey: isFloat,
            AVLinearPCMIsBigEndianKey: false,
            AVLinearPCMIsNonInterleaved: false,
        ]
        let output = AVAssetReaderTrackOutput(track: track, outputSettings: settings)
        output.alwaysCopiesSampleData = false
        guard reader.canAdd(output) else { throw ReaderError.cannotRead("output") }
        reader.add(output)
        if start > 0 || duration.isFinite {
            let s = CMTime(seconds: max(0, start), preferredTimescale: 48_000)
            let d = duration.isFinite ? CMTime(seconds: max(0, duration), preferredTimescale: 48_000) : .positiveInfinity
            reader.timeRange = CMTimeRange(start: s, duration: d)
        }
        guard reader.startReading() else {
            throw ReaderError.cannotRead(reader.error?.localizedDescription ?? "start")
        }
        defer { if reader.status == .reading { reader.cancelReading() } }
        let readFormat = AVAudioFormat(commonFormat: format.commonFormat, sampleRate: format.sampleRate,
                                       channels: 1, interleaved: true) ?? format
        while let sample = output.copyNextSampleBuffer() {
            try Task.checkCancellation()
            let frames = AVAudioFrameCount(CMSampleBufferGetNumSamples(sample))
            guard frames > 0, let pcm = AVAudioPCMBuffer(pcmFormat: readFormat, frameCapacity: frames) else { continue }
            pcm.frameLength = frames
            let status = CMSampleBufferCopyPCMDataIntoAudioBufferList(sample, at: 0, frameCount: Int32(frames),
                                                                       into: pcm.mutableAudioBufferList)
            guard status == noErr else { continue }
            try handler(pcm)
        }
        if reader.status == .failed {
            throw ReaderError.cannotRead(reader.error?.localizedDescription ?? "read")
        }
    }

    /// 16 kHz 单声道 16-bit WAV(云端转写服务都收这个格式)。
    static func wavData(url: URL, start: Double, duration: Double) async throws -> Data {
        guard let format = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16_000, channels: 1, interleaved: true) else {
            throw ReaderError.cannotRead("format")
        }
        var pcm = Data()
        try await read(url: url, start: start, duration: duration, format: format) { buffer in
            guard let ch = buffer.int16ChannelData?[0] else { return }
            pcm.append(Data(bytes: ch, count: Int(buffer.frameLength) * 2))
        }
        return wavHeader(pcmBytes: pcm.count, sampleRate: 16_000) + pcm
    }

    static func wavHeader(pcmBytes: Int, sampleRate: Int) -> Data {
        var d = Data()
        func u32(_ v: UInt32) { var x = v.littleEndian; d.append(Data(bytes: &x, count: 4)) }
        func u16(_ v: UInt16) { var x = v.littleEndian; d.append(Data(bytes: &x, count: 2)) }
        d.append(contentsOf: Array("RIFF".utf8)); u32(UInt32(36 + pcmBytes))
        d.append(contentsOf: Array("WAVE".utf8))
        d.append(contentsOf: Array("fmt ".utf8)); u32(16); u16(1); u16(1)
        u32(UInt32(sampleRate)); u32(UInt32(sampleRate * 2)); u16(2); u16(16)
        d.append(contentsOf: Array("data".utf8)); u32(UInt32(pcmBytes))
        return d
    }
}
