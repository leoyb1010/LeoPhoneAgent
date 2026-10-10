import AVFoundation
import Foundation

private let logger = AppLogger(category: "Recording")

/// [V-rec] 一个转写单元的两种做法:
/// - 本机(默认):SpeechTranscriber,带时间戳,音频不出设备。
/// - 云端(录音详情里手动打开):按 3 分钟切成 16 kHz WAV,交给你在「语音输入」里配置的服务商,
///   按句子把时间估出来(标为估算)。
enum RecordingTranscriber {
    enum TranscribeError: Error, LocalizedError {
        case noCloudProvider
        case unsupportedOS

        var errorDescription: String? {
            switch self {
            case .noCloudProvider:
                return String(localized: "没有可用的云端语音识别服务。请先在设置 › 语音里配置语音输入服务商,或关闭云端转写改用本机转写。")
            case .unsupportedOS:
                return String(localized: "本机转写需要 iOS 26 或更高版本。")
            }
        }
    }

    static let cloudSliceSeconds: Double = 180

    @MainActor
    static func transcribe(unit: TranscriptionPlan.Unit, fileURL: URL, engine: RecordingTranscriptionEngine,
                           localeIdentifier: String) async throws -> [TranscriptAssembler.LocalSegment] {
        switch engine {
        case .onDevice:
            guard #available(iOS 26.0, *) else { throw TranscribeError.unsupportedOS }
            return try await AppleSpeechAnalyzer.transcribeWindow(url: fileURL, start: unit.localStart,
                                                                  duration: unit.duration,
                                                                  localeIdentifier: localeIdentifier)
        case .cloud:
            return try await transcribeInCloud(unit: unit, fileURL: fileURL, localeIdentifier: localeIdentifier)
        }
    }

    @MainActor
    private static func transcribeInCloud(unit: TranscriptionPlan.Unit, fileURL: URL,
                                          localeIdentifier: String) async throws -> [TranscriptAssembler.LocalSegment] {
        let candidates = VoiceProviderResolver.resolvedInputCandidates()
        guard !candidates.isEmpty else { throw TranscribeError.noCloudProvider }
        var out: [TranscriptAssembler.LocalSegment] = []
        var offset = 0.0
        while offset < unit.duration - 0.05 {
            try Task.checkCancellation()
            let length = min(cloudSliceSeconds, unit.duration - offset)
            let wav = try await RecordingAudioReader.wavData(url: fileURL, start: unit.localStart + offset, duration: length)
            var lastError: Error?
            var text: String?
            for entry in candidates {
                guard let provider = VoiceProviderResolver.inputProvider(for: entry) else { continue }
                do {
                    let response = try await provider.transcribe(VoiceInputRequest(
                        audioData: wav, model: entry.model.id, language: localeIdentifier,
                        resolvedModel: entry.model, onDeviceRecognition: nil))
                    text = response.text
                    break
                } catch {
                    lastError = error
                    logger.warning("[Recording] cloud slice failed on \(entry.model.id): \(error.localizedDescription)")
                }
            }
            guard let text else { throw lastError ?? TranscribeError.noCloudProvider }
            for seg in TranscriptAssembler.approximateSegments(text: text, duration: length) {
                out.append(.init(start: seg.start + offset, end: seg.end + offset, text: seg.text))
            }
            offset += length
        }
        return out
    }
}
