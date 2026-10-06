import Foundation

/// Debug-only logging for the voice capture → transcription pipeline.
/// All messages share the `[Voice]` prefix for easy grep. Routed through
/// AppLogger (NSLog-backed, captured by LoggingManager) per project convention;
/// compiled out of release builds.
enum VoiceLog {
    #if DEBUG
    private static let logger = AppLogger(category: "Voice")
    #endif

    static func log(_ message: @autoclosure () -> String) {
        #if DEBUG
        logger.info("[Voice] \(message())")
        #endif
    }

    /// [H4] 语音时延进常开诊断日志(`voice.latency`,Release 也记)。`event` 只放事件名,不放正文。
    static func latency(_ event: String, ms: Double) {
        guard ms.isFinite, ms >= 0 else { return }
        DiagnosticRing.shared.record(.voiceLatency, message: event, durationMs: Int(ms.rounded()))
        log("latency \(event)=\(Int(ms))ms")
    }

    /// [H4] 朗读真正出声时调用:若有刚发出的语音消息在等,记"说完到听到第一个字"。
    static func noteFirstAudio() {
        if let ms = VoiceMetricsStore.shared.noteFirstAudio(at: ProcessInfo.processInfo.systemUptime) {
            latency(VoiceMetricKind.firstAudioLatency.rawValue, ms: ms)
        }
    }

    /// [H4] 记一笔度量:写入最近 20 次的样本,并同步进诊断日志。
    static func metric(_ kind: VoiceMetricKind, ms: Double) {
        VoiceMetricsStore.shared.record(kind, ms)
        latency(kind.rawValue, ms: ms)
    }
}
