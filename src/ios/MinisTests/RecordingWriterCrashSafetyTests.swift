import AVFoundation
import XCTest

/// [V-rec] 分片写入的 AAC 文件:正常收尾能读出完整时长;App 中途被杀(文件没收尾)
/// 时已落盘的片段照样能读、能转写。
final class RecordingWriterCrashSafetyTests: XCTestCase {
    private var dir: URL!

    override func setUpWithError() throws {
        try super.setUpWithError()
        dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("rec-writer-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        if let dir { try? FileManager.default.removeItem(at: dir) }
        try super.tearDownWithError()
    }

    private func sine(seconds: Double, rate: Double, startFrame: Int) -> AVAudioPCMBuffer {
        let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: rate, channels: 1, interleaved: false)!
        let n = AVAudioFrameCount(seconds * rate)
        let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: n)!
        buffer.frameLength = n
        let ch = buffer.floatChannelData![0]
        for i in 0..<Int(n) { ch[i] = 0.3 * sinf(Float(startFrame + i) * 2 * .pi * 440 / Float(rate)) }
        return buffer
    }

    func testOutputSampleRateSnapsToAACRates() {
        XCTAssertEqual(RecordingAudioWriter.outputSampleRate(for: 48_000), 48_000)
        XCTAssertEqual(RecordingAudioWriter.outputSampleRate(for: 16_000), 16_000)
        XCTAssertEqual(RecordingAudioWriter.outputSampleRate(for: 96_000), 48_000)
        XCTAssertEqual(RecordingAudioWriter.outputSampleRate(for: 0), 48_000)
    }

    func testFinishedChunkReadsBackFullDuration() async throws {
        let url = dir.appendingPathComponent("chunk-000.m4a")
        let writer = try RecordingAudioWriter(url: url, sampleRate: 48_000)
        for i in 0..<30 { writer.append(sine(seconds: 0.1, rate: 48_000, startFrame: i * 4_800), waitUpTo: 1) }
        writer.finish()
        XCTAssertNil(writer.failureDescription)
        XCTAssertEqual(writer.duration, 3, accuracy: 0.001)
        let duration = await RecordingAudioReader.duration(of: url)
        XCTAssertEqual(duration ?? 0, 3, accuracy: 0.15)

        // The reader hands transcription 16 kHz PCM of the requested window.
        let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 16_000, channels: 1, interleaved: true)!
        var frames = 0
        try await RecordingAudioReader.read(url: url, start: 1, duration: 1, format: format) { frames += Int($0.frameLength) }
        XCTAssertEqual(Double(frames), 16_000, accuracy: 1_600)

        let wav = try await RecordingAudioReader.wavData(url: url, start: 0, duration: .infinity)
        XCTAssertEqual(String(data: wav.prefix(4), encoding: .ascii), "RIFF")
        XCTAssertEqual(Double(wav.count - 44) / 32_000, 3, accuracy: 0.15)
    }

    /// The point of fragmented writing: copy the file while it is still being written
    /// (what a crash leaves on disk) and it must still be readable.
    func testUnfinishedChunkIsStillReadable() async throws {
        let url = dir.appendingPathComponent("chunk-001.m4a")
        let writer = try RecordingAudioWriter(url: url, sampleRate: 16_000)
        // 12 s of audio = at least two 5-second fragments on disk.
        for i in 0..<120 { writer.append(sine(seconds: 0.1, rate: 16_000, startFrame: i * 1_600), waitUpTo: 1) }
        let crashed = dir.appendingPathComponent("crashed.m4a")
        var size = 0
        for _ in 0..<40 {
            size = ((try? FileManager.default.attributesOfItem(atPath: url.path)[.size]) as? Int) ?? 0
            if size > 20_000 { break }
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        try FileManager.default.copyItem(at: url, to: crashed)
        writer.finish()

        let recovered = await RecordingAudioReader.duration(of: crashed)
        XCTAssertNotNil(recovered, "an unfinished chunk (\(size) bytes) must open")
        XCTAssertGreaterThanOrEqual(recovered ?? 0, 4.5, "at least the first fragment survives")
        let format = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16_000, channels: 1, interleaved: true)!
        var frames = 0
        try await RecordingAudioReader.read(url: crashed, start: 0, duration: .infinity, format: format) { frames += Int($0.frameLength) }
        XCTAssertGreaterThan(frames, 16_000 * 4)
    }

    func testEmptyWriterLeavesNoFile() throws {
        let url = dir.appendingPathComponent("chunk-002.m4a")
        let writer = try RecordingAudioWriter(url: url, sampleRate: 48_000)
        writer.finish()
        XCTAssertFalse(FileManager.default.fileExists(atPath: url.path))
    }

    func testWavHeader() {
        let h = RecordingAudioReader.wavHeader(pcmBytes: 32_000, sampleRate: 16_000)
        XCTAssertEqual(h.count, 44)
        XCTAssertEqual(String(data: h.subdata(in: 8..<12), encoding: .ascii), "WAVE")
    }
}
